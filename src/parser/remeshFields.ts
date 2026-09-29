/**
 * Carry data fields across an MMG remesh / level-set split.
 *
 * MMG renumbers every node and every entity, so the harvested model comes back
 * with `fields: []` (see `rebuildModel` in remesh.ts). This module maps the
 * pre-remesh model's fields onto the new discretization NATIVELY — a uniform-
 * grid locator over the source cells, barycentric interpolation for Nodal
 * values, containing/nearest-cell lookup for Elemental/Conditional values —
 * and attaches the results with the existing `attachNodalField` /
 * `attachCellField` helpers.
 *
 * ## Why native, not meshio++'s `conservativeInterpolate`
 *
 * That engine was the first choice (it is what `transferField.ts` uses), but
 * MEASURED against the live wasm it corrupts exactly the data a remesh must
 * carry: a constant Nodal field on a tet mesh with one coplanar boundary
 * triangle comes back at quarter strength on every boundary node (the
 * zero-volume face reports "no source overlap", is filled with 0, and poisons
 * the point→cell→point composition), and cell data on 1D boundary cells
 * (edges) or coplanar faces collapses to 0 the same way. Nearly every real
 * Kratos mesh has boundary Conditions coplanar with its volume faces, so the
 * conservative path is wrong here by construction — and it additionally
 * SMOOTHES every varying Nodal field, while barycentric resampling is exact
 * for P1-on-simplex fields (and exact bit-for-bit on an identical mesh, which
 * the tests pin). Conservation of totals is the one property the native path
 * does NOT guarantee; containing-cell P0 lookup preserves them approximately,
 * and that trade is stated rather than hidden.
 *
 * ## Locator design
 *
 * One uniform grid over the source domain's simplex decomposition (the
 * `cellDecomposition.ts` tables — tet/tri direct, quad→2 tris, wedge/pyramid/
 * hex→tets; lines and points have no interior and are skipped, with a
 * fallback count to prove it). Two indexes share the grid machinery:
 * - the VOLUME index (every decomposable cell of any kind) serves Nodal
 *   (barycentric weights, all components) and Elemental (containing cell's
 *   value, all components);
 * - the SURFACE index (Conditions-kind cells only: tri containment, quad as
 *   two tris, edge as segment-distance) serves Conditional (P0 copy).
 * A query point coinciding with a locator vertex takes weight 1 there
 * (exact, and the fast path). A point in no simplex falls back to the nearest
 * locator (clamped weights for Nodal, nearest value for P0), counted in the
 * result — MMG only drifts the surface by epsilon, so a surprising count is
 * the first sign of a bad mesh. Ties (shared faces) resolve by insertion
 * order: deterministic for a given input, like everything else here.
 *
 * Elemental attaches across ALL blocks (the `transferField.ts` convention —
 * partition's PARTITION_INDEX does the same), so a condition cell inherits
 * its containing volume value rather than a fabricated 0. Conditional slices
 * exactly its own blocks. Sparse source fields (ids not covering a cell)
 * resolve through the nearest COVERED source cell; a field covering nothing
 * is dropped with its reason. Nodal `fixed` (is_fixed) flags are NOT carried
 * (new nodes have no fixity), named in the result when dropped. `derived`
 * (NODAL_H/ELEMENT_H keyed by dead ids) is not a field and is left alone.
 *
 * Pure module: no vscode / DOM / vtk.js / wasm imports — no Emscripten heap,
 * no worker restrictions, plain-Node testable. Called from `operations.ts`'
 * `applyOpAsync` remesh/levelset branches after `mmgRunner` succeeds, so a
 * mapping failure degrades to the legacy drop message and can never fail (or
 * noop) a good remesh.
 */

import { decompositionFor } from "./cellDecomposition";
import { VtkCellType as C } from "./geometryMap";
import { EntityBlock, FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import { nodeIdsOf, attachNodalField, attachCellField } from "./meshioAdapter";
import {
  Vec3,
  LocatorSimplex,
  Locator,
  sub,
  dot,
  tetWeights,
  triWeights,
  buildLocator,
  candidates,
  contains,
} from "./cellLocator";

export interface RemappedField {
  /** Display name, e.g. "Nodal:d" / "Elemental:TEMP" / "Conditional:PRESSURE". */
  name: string;
}

export interface DroppedField {
  name: string;
  reason: string;
}

export interface RemapFieldsResult {
  model: MdpaModel;
  transferred: RemappedField[];
  dropped: DroppedField[];
  /** True when a mapped Nodal source carried fixity flags (not carried). */
  fixedDropped: boolean;
  /** Queries that found no containing simplex and took the nearest instead. */
  nearestFallbacks: number;
}


/** One enumerated source cell: geometry + owning block/entity. */
interface SourceCell {
  block: EntityBlock;
  /** Ordinal within the block. */
  ordinal: number;
  entityId: number;
  /** Corner node ids (stride entries). */
  corners: number[];
  centroid: Vec3;
}



function coordOf(model: MdpaModel, indexById: Map<number, number>, id: number): Vec3 {
  const i = indexById.get(id);
  if (i === undefined) return [NaN, NaN, NaN];
  return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
}


function centroidOf(s: LocatorSimplex): Vec3 {
  const n = s.ids.length;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += s.p[i * 3];
    y += s.p[i * 3 + 1];
    z += s.p[i * 3 + 2];
  }
  return [x / n, y / n, z / n];
}

function dist2(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Maps `source`'s fields onto `target` (normally the freshly remeshed model).
 * A field-less source passes through untouched; unmappable fields land in
 * `dropped` with their reason instead of corrupting the output.
 */
export async function remapFieldsOntoRemesh(
  target: MdpaModel,
  source: MdpaModel,
  diagnostics: MdpaDiagnostic[] = []
): Promise<RemapFieldsResult> {
  const empty: RemapFieldsResult = {
    model: target,
    transferred: [],
    dropped: [],
    fixedDropped: false,
    nearestFallbacks: 0,
  };
  if (source.fields.length === 0) return empty;

  const indexById = new Map<number, number>();
  for (let i = 0; i < source.nodeCount; i++) indexById.set(source.nodeIds[i], i);
  const diag = Math.hypot(
    source.bounds.max[0] - source.bounds.min[0],
    source.bounds.max[1] - source.bounds.min[1],
    source.bounds.max[2] - source.bounds.min[2]
  );
  const snap2 = diag > 0 ? (1e-12 * diag) * (1e-12 * diag) : 0;

  // Enumerate source cells in model.blocks order; each becomes locator
  // entries. Volume index: every decomposable cell (tets/tris/quads/…).
  // Surface index: Conditions-kind cells (tri/quad/edge) for Conditional P0.
  const sourceCells: SourceCell[] = [];
  for (const block of source.blocks) {
    for (let c = 0; c < block.count; c++) {
      const corners: number[] = [];
      for (let k = 0; k < block.stride; k++) corners.push(block.connectivity[c * block.stride + k]);
      const pts = corners.map((id) => coordOf(source, indexById, id));
      const centroid: Vec3 = [0, 0, 0];
      for (const p of pts) {
        centroid[0] += p[0];
        centroid[1] += p[1];
        centroid[2] += p[2];
      }
      const n = Math.max(pts.length, 1);
      sourceCells.push({
        block,
        ordinal: c,
        entityId: block.entityIds[c],
        corners,
        centroid: [centroid[0] / n, centroid[1] / n, centroid[2] / n],
      });
    }
  }

  const pushSimplex = (
    list: LocatorSimplex[],
    coords: Vec3[],
    ids: number[],
    cell: number
  ): void => {
    const flat = new Float64Array(coords.length * 3);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    coords.forEach((p, i) => {
      flat[i * 3] = p[0];
      flat[i * 3 + 1] = p[1];
      flat[i * 3 + 2] = p[2];
      for (let a = 0; a < 3; a++) {
        if (!(p[a] >= min[a])) min[a] = p[a];
        if (!(p[a] <= max[a])) max[a] = p[a];
      }
    });
    const d2 =
      (max[0] - min[0]) * (max[0] - min[0]) +
      (max[1] - min[1]) * (max[1] - min[1]) +
      (max[2] - min[2]) * (max[2] - min[2]);
    list.push({ p: flat, ids, cell, min, max, diag2: d2 });
  };

  const volumeSimplices: LocatorSimplex[] = [];
  const surfaceSimplices: LocatorSimplex[] = [];
  sourceCells.forEach((cell, ci) => {
    const decomp = decompositionFor(cell.block.vtkCellType);
    const pts = cell.corners.map((id) => coordOf(source, indexById, id));
    if (pts.some((p) => !Number.isFinite(p[0]))) return; // dangling reference
    if (decomp.tets) {
      for (const t of decomp.tets) {
        pushSimplex(
          volumeSimplices,
          t.map((k) => pts[k]),
          t.map((k) => cell.corners[k]),
          ci
        );
      }
    } else if (decomp.tris) {
      for (const t of decomp.tris) {
        const coords = t.map((k) => pts[k]);
        const ids = t.map((k) => cell.corners[k]);
        pushSimplex(volumeSimplices, coords, ids, ci);
        if (cell.block.kind === "Conditions") pushSimplex(surfaceSimplices, coords, ids, ci);
      }
    } else if (
      cell.block.kind === "Conditions" &&
      (cell.block.vtkCellType === C.LINE || cell.block.vtkCellType === undefined) &&
      pts.length === 2
    ) {
      // 1D boundary edge: no interior, but segment-distance containment lets
      // a 2D wall part receive its Conditional back (sampleDistance itself
      // refuses triangle-less surfaces — this is the path that keeps 2D
      // boundary layers working).
      pushSimplex(surfaceSimplices, pts, cell.corners, ci);
    }
  });

  const toBounds = (list: LocatorSimplex[]): { min: Vec3; max: Vec3 } => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const s of list) {
      for (let a = 0; a < 3; a++) {
        if (s.min[a] < min[a]) min[a] = s.min[a];
        if (s.max[a] > max[a]) max[a] = s.max[a];
      }
    }
    return { min, max };
  };
  const volumeLoc =
    volumeSimplices.length > 0 ? buildLocator(volumeSimplices, toBounds(volumeSimplices)) : null;
  const surfaceLoc =
    surfaceSimplices.length > 0 ? buildLocator(surfaceSimplices, toBounds(surfaceSimplices)) : null;

  const transferred: RemappedField[] = [];
  const dropped: DroppedField[] = [];
  let model = target;
  let fixedDropped = false;
  let nearestFallbacks = 0;

  // Per-field source value maps: Nodal by node id, cell kinds by entity id.
  const nodalMaps = new Map<string, Map<number, number[]>>();
  const cellMaps = new Map<string, Map<number, number[]>>();
  for (const f of source.fields) {
    const m = new Map<number, number[]>();
    for (let i = 0; i < f.ids.length; i++) {
      const row: number[] = [];
      for (let k = 0; k < f.components; k++) row.push(f.values[i * f.components + k]);
      m.set(f.ids[i], row);
    }
    (f.kind === "Nodal" ? nodalMaps : cellMaps).set(`${f.kind}:${f.variable}`, m);
  }
  // Covered source cells per cell-field (for the nearest-covered fallback).
  const coveredByField = new Map<string, number[]>();
  for (const f of source.fields) {
    if (f.kind === "Nodal") continue;
    const key = `${f.kind}:${f.variable}`;
    const list: number[] = [];
    sourceCells.forEach((cell, ci) => {
      if (cellMaps.get(key)?.has(cell.entityId)) list.push(ci);
    });
    coveredByField.set(key, list);
  }

  /** Locate p in the volume index: weights + source cell, or nearest-take. */
  const locateVolume = (
    p: Vec3
  ): { weights: number[]; ids: number[]; cell: number; nearest: boolean } | null => {
    if (!volumeLoc) return null;
    // Exact vertex snap first: bit-exact on identical meshes, and the fast path.
    for (const si of candidates(volumeLoc, p)) {
      const s = volumeLoc.simplices[si];
      for (let i = 0; i < s.ids.length; i++) {
        const dx = p[0] - s.p[i * 3];
        const dy = p[1] - s.p[i * 3 + 1];
        const dz = p[2] - s.p[i * 3 + 2];
        if (dx * dx + dy * dy + dz * dz <= snap2) {
          const weights = s.ids.map((_, j) => (j === i ? 1 : 0));
          return { weights, ids: s.ids, cell: s.cell, nearest: false };
        }
      }
    }
    for (const si of candidates(volumeLoc, p)) {
      const s = volumeLoc.simplices[si];
      const w = contains(s, p);
      if (w) return { weights: w, ids: s.ids, cell: s.cell, nearest: false };
    }
    // Outside every simplex: nearest centroid, clamped weights.
    let best = -1;
    let bestD = Infinity;
    volumeLoc.simplices.forEach((s, si) => {
      const d2 = dist2(p, centroidOf(s));
      if (d2 < bestD) {
        bestD = d2;
        best = si;
      }
    });
    if (best < 0) return null;
    const s = volumeLoc.simplices[best];
    const raw =
      contains(s, p) ??
      s.ids.map(() => 1 / s.ids.length);
    const clamped = raw.map((x) => Math.max(0, x));
    const sum = clamped.reduce((a, b) => a + b, 0) || 1;
    return { weights: clamped.map((x) => x / sum), ids: s.ids, cell: s.cell, nearest: true };
  };

  /** Locate p on the surface index: source cell, or nearest. */
  const locateSurface = (p: Vec3): { cell: number; nearest: boolean } | null => {
    if (!surfaceLoc) return null;
    for (const si of candidates(surfaceLoc, p)) {
      const s = surfaceLoc.simplices[si];
      if (s.ids.length === 2) {
        // Segment-distance containment for 1D boundary edges.
        const a: Vec3 = [s.p[0], s.p[1], s.p[2]];
        const b: Vec3 = [s.p[3], s.p[4], s.p[5]];
        const ab = sub(b, a);
        const len2 = dot(ab, ab);
        if (len2 > 0) {
          const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
          const proj: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
          if (dist2(p, proj) <= Math.max(snap2, 1e-18 * Math.max(surfaceLoc.diag * surfaceLoc.diag, 0))) {
            return { cell: s.cell, nearest: false };
          }
        } else if (dist2(p, a) <= snap2) {
          return { cell: s.cell, nearest: false };
        }
        continue;
      }
      if (contains(s, p)) return { cell: s.cell, nearest: false };
    }
    let best = -1;
    let bestD = Infinity;
    surfaceLoc.simplices.forEach((s, si) => {
      const d2 = dist2(p, centroidOf(s));
      if (d2 < bestD) {
        bestD = d2;
        best = si;
      }
    });
    if (best < 0) return null;
    return { cell: surfaceLoc.simplices[best].cell, nearest: true };
  };

  const targetIndexById = new Map<number, number>();
  for (let i = 0; i < target.nodeCount; i++) targetIndexById.set(target.nodeIds[i], i);
  const targetCoord = (id: number): Vec3 => coordOf(target, targetIndexById, id);

  for (const f of source.fields) {
    const display = `${f.kind}:${f.variable}`;
    if (f.kind !== "Nodal" && f.kind !== "Elemental" && f.kind !== "Conditional") {
      dropped.push({ name: display, reason: `kind "${f.kind}" has no mapping` });
      continue;
    }
    if (f.kind === "Nodal") {
      if (!volumeLoc) {
        dropped.push({ name: display, reason: "the source has no mappable domain cells" });
        continue;
      }
      const src = nodalMaps.get(display)!;
      const ids = nodeIdsOf(target);
      const values = new Float64Array(ids.length * f.components);
      for (let i = 0; i < ids.length; i++) {
        const hit = locateVolume(targetCoord(ids[i]));
        if (!hit) {
          for (let k = 0; k < f.components; k++) values[i * f.components + k] = NaN;
          continue;
        }
        if (hit.nearest) nearestFallbacks++;
        for (let k = 0; k < f.components; k++) {
          let v = 0;
          hit.weights.forEach((w, j) => {
            v += w * (src.get(hit.ids[j])?.[k] ?? NaN);
          });
          values[i * f.components + k] = v;
        }
      }
      if ([...values].some((v) => Number.isNaN(v))) {
        dropped.push({ name: display, reason: "some nodes reference data the source does not cover" });
        continue;
      }
      const attached = attachNodalField(model, {
        variable: f.variable,
        components: f.components,
        ids,
        values,
      });
      model = attached.model;
      transferred.push({ name: display });
      // An all-zero fixity column means nothing was fixed: only a real 1
      // counts, since every parsed Nodal record carries the flag slot.
      if (f.fixed && f.fixed.some((v) => v !== 0)) fixedDropped = true;
      continue;
    }
    // Elemental / Conditional P0 via the containing (or nearest covered) cell.
    const src = cellMaps.get(display)!;
    const isConditional = f.kind === "Conditional";
    const loc = isConditional ? surfaceLoc : volumeLoc;
    if (!loc) {
      dropped.push({
        name: display,
        reason: isConditional
          ? "the source has no mappable Conditions"
          : "the source has no mappable domain cells",
      });
      continue;
    }
    // Target cells this kind attaches to (model.blocks order — the attach
    // arrays below follow this exact walk, so ids and values stay aligned).
    const targetCells: { entityId: number; centroid: Vec3 }[] = [];
    for (const block of target.blocks) {
      if (isConditional ? block.kind !== "Conditions" : false) continue;
      for (let c = 0; c < block.count; c++) {
        const centroid: Vec3 = [0, 0, 0];
        let n = 0;
        for (let k = 0; k < block.stride; k++) {
          const p = targetCoord(block.connectivity[c * block.stride + k]);
          if (!Number.isFinite(p[0])) continue;
          centroid[0] += p[0];
          centroid[1] += p[1];
          centroid[2] += p[2];
          n++;
        }
        if (n === 0) continue;
        targetCells.push({
          entityId: block.entityIds[c],
          centroid: [centroid[0] / n, centroid[1] / n, centroid[2] / n],
        });
      }
    }
    if (targetCells.length === 0) {
      dropped.push({
        name: display,
        reason: isConditional
          ? "the remeshed mesh has no Conditions to receive it"
          : "the remeshed mesh has no cells to receive it",
      });
      continue;
    }
    const key = display;
    const covered = coveredByField.get(key) ?? [];
    if (covered.length === 0) {
      dropped.push({ name: display, reason: "the source covers no cell with this field" });
      continue;
    }
    const ids: number[] = [];
    const values: number[] = [];
    for (const t of targetCells) {
      let ci = -1;
      let nearest = false;
      if (isConditional) {
        const hit = locateSurface(t.centroid);
        if (hit) {
          ci = hit.cell;
          nearest = hit.nearest;
        }
      } else {
        const hit = locateVolume(t.centroid);
        if (hit) {
          ci = hit.cell;
          nearest = hit.nearest;
        }
      }
      // The containing cell may not carry this field (sparse source): fall
      // back to the nearest COVERED source cell rather than a fabricated 0.
      let ref = ci >= 0 ? sourceCells[ci].entityId : -1;
      if (ci < 0 || !src.has(ref)) {
        let best = -1;
        let bestD = Infinity;
        for (const cj of covered) {
          const d2 = dist2(t.centroid, sourceCells[cj].centroid);
          if (d2 < bestD) {
            bestD = d2;
            best = cj;
          }
        }
        if (best < 0) continue;
        ci = best;
        ref = sourceCells[best].entityId;
        nearest = true;
      }
      if (nearest) nearestFallbacks++;
      const row = src.get(ref)!;
      ids.push(t.entityId);
      for (let k = 0; k < f.components; k++) values.push(row[k]);
    }
    if (ids.length === 0) {
      dropped.push({ name: display, reason: "no target cell resolved to a covered source cell" });
      continue;
    }
    const attached = attachCellField(model, {
      kind: f.kind as "Elemental" | "Conditional",
      variable: f.variable,
      components: f.components,
      ids: Int32Array.from(ids),
      values,
    });
    model = attached.model;
    transferred.push({ name: display });
  }

  for (const d of dropped) {
    diagnostics.push({ line: 0, message: `Field "${d.name}" was not carried across the remesh: ${d.reason}.` });
  }
  return { model, transferred, dropped, fixedDropped, nearestFallbacks };
}
