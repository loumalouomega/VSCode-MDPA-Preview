/**
 * Length / area / volume of the whole model and of every SubModelPart.
 *
 * Pure module (no vscode / DOM / wasm), bundled into both runtimes: the webview
 * shows the numbers in the Information section and the outline's (i) menu, MCP
 * `mesh_info` reports them, and the sidecar caches them (`measureKey` is the
 * staleness fingerprint) so a large mesh is measured once, not on every open.
 *
 * One pass over the blocks builds an id -> measure map per entity kind (the three
 * id spaces are independent), then each part sums the union of its subtree's ids.
 * A part's dimension is the highest dimension among its cells, so a boundary part
 * of Conditions reports an AREA and a volume part a VOLUME; only cells of that
 * dimension are summed. Higher-order cells are measured by their corner nodes
 * (the same convention as `elementMeasures`). Units are whatever the mesh uses.
 */

import { EntityKind, MdpaModel, SubModelPart } from "./types";
import { decompositionFor } from "./cellDecomposition";
import { cellCategory } from "./writers/writerCommon";
import { collectIds, IdSets } from "./subModelPartExtract";

export type MeasureDim = 1 | 2 | 3;

export interface Measure {
  value: number;
  /** Dimension of the measured cells: 1 length, 2 area, 3 volume. */
  dimension: MeasureDim;
}

export interface PartMeasures {
  /** Top-dimension measure of the Elements (null when there are none). */
  total: Measure | null;
  /** Area of the surface Conditions of a volume mesh (the boundary), when present. */
  boundary?: Measure;
  /** Keyed by SubModelPart path; null for a part with no measurable cells. */
  parts: Record<string, Measure | null>;
}

const KINDS: EntityKind[] = ["Elements", "Conditions", "Geometries"];

function dimOf(vtkCellType: number | undefined): 0 | MeasureDim {
  const cat = cellCategory(vtkCellType);
  return cat === "volume" ? 3 : cat === "surface" ? 2 : cat === "line" ? 1 : 0;
}

/** Measure label for a dimension. */
export function measureName(dimension: MeasureDim): string {
  return dimension === 3 ? "Volume" : dimension === 2 ? "Area" : "Length";
}

/** Compact human text, e.g. "12.5 (units³)". */
export function formatMeasure(m: Measure): string {
  const v = Math.abs(m.value) >= 1e5 || (m.value !== 0 && Math.abs(m.value) < 1e-3)
    ? m.value.toExponential(4)
    : String(Number(m.value.toPrecision(6)));
  return `${v} (units${m.dimension === 3 ? "³" : m.dimension === 2 ? "²" : ""})`;
}

export function computePartMeasures(model: MdpaModel): PartMeasures {
  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);
  const coords = model.coords;
  const p = (id: number): [number, number, number] => {
    const i = idx.get(id)!;
    return [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]];
  };
  const tetVolume = (a: number[], b: number[], c: number[], d: number[]): number => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    return Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
  };
  const triArea = (a: number[], b: number[], c: number[]): number => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  };

  const byKind: Record<EntityKind, Map<number, { m: number; d: MeasureDim }>> = {
    Elements: new Map(),
    Conditions: new Map(),
    Geometries: new Map(),
  };
  for (const b of model.blocks) {
    const d = dimOf(b.vtkCellType);
    if (d === 0) continue;
    const dec = decompositionFor(b.vtkCellType);
    const corners = dec.corners || b.stride;
    const target = byKind[b.kind];
    for (let c = 0; c < b.count; c++) {
      const ids: number[] = [];
      let ok = true;
      for (let k = 0; k < corners && ok; k++) {
        const id = b.connectivity[c * b.stride + k];
        if (!idx.has(id)) ok = false;
        ids.push(id);
      }
      if (!ok) continue;
      let m = 0;
      if (d === 3 && dec.tets) {
        for (const t of dec.tets) m += tetVolume(p(ids[t[0]]), p(ids[t[1]]), p(ids[t[2]]), p(ids[t[3]]));
      } else if (d === 2 && dec.tris) {
        for (const t of dec.tris) m += triArea(p(ids[t[0]]), p(ids[t[1]]), p(ids[t[2]]));
      } else if (d === 1) {
        const a = p(ids[0]);
        const e = p(ids[1]);
        m = Math.hypot(e[0] - a[0], e[1] - a[1], e[2] - a[2]);
      } else continue;
      target.set(b.entityIds[c], { m, d });
    }
  }

  // Whole model: the Elements' top dimension.
  let topDim = 0 as 0 | MeasureDim;
  for (const v of byKind.Elements.values()) if (v.d > topDim) topDim = v.d;
  let total: Measure | null = null;
  if (topDim) {
    let sum = 0;
    for (const v of byKind.Elements.values()) if (v.d === topDim) sum += v.m;
    total = { value: sum, dimension: topDim };
  }
  let boundary: Measure | undefined;
  if (topDim === 3) {
    let sum = 0;
    let any = false;
    for (const v of byKind.Conditions.values()) if (v.d === 2) { sum += v.m; any = true; }
    if (any) boundary = { value: sum, dimension: 2 };
  }

  const parts: Record<string, Measure | null> = {};
  const walk = (list: SubModelPart[]): void => {
    for (const part of list) {
      const sets: IdSets = { elements: new Set(), conditions: new Set(), geometries: new Set(), nodes: new Set() };
      collectIds(part, sets);
      const per: Record<EntityKind, Set<number>> = {
        Elements: sets.elements,
        Conditions: sets.conditions,
        Geometries: sets.geometries,
      };
      let dim = 0 as 0 | MeasureDim;
      for (const kind of KINDS) {
        for (const id of per[kind]) {
          const v = byKind[kind].get(id);
          if (v && v.d > dim) dim = v.d;
        }
      }
      if (!dim) {
        parts[part.path] = null;
      } else {
        let sum = 0;
        for (const kind of KINDS) {
          for (const id of per[kind]) {
            const v = byKind[kind].get(id);
            if (v && v.d === dim) sum += v.m;
          }
        }
        parts[part.path] = { value: sum, dimension: dim };
      }
      walk(part.children);
    }
  };
  walk(model.subModelParts);
  return boundary ? { total, boundary, parts } : { total, parts };
}

/**
 * Cheap structural fingerprint of the model's geometry: changes whenever a count,
 * the bounds or the part tree changes (an edit, a re-read, a different timeline
 * frame), so a cached `PartMeasures` is only trusted for the mesh it was made from.
 */
export function measureKey(model: MdpaModel): string {
  const r = (v: number): string => (Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : "x");
  const blocks = model.blocks.map((b) => `${b.kind[0]}${b.vtkCellType}:${b.count}`).join(",");
  let parts = 0;
  const walk = (l: SubModelPart[]): void => {
    for (const q of l) {
      parts += 1 + q.elementIds.length + q.conditionIds.length + q.geometryIds.length;
      walk(q.children);
    }
  };
  walk(model.subModelParts);
  const { min, max } = model.bounds;
  return `${model.nodeCount}|${blocks}|${parts}|${min.map(r).join(",")}|${max.map(r).join(",")}`;
}

/** The sidecar's `measures` key: a `PartMeasures` plus the key of the mesh it describes. */
export interface MeasuresCache extends PartMeasures {
  key: string;
}

function validMeasure(raw: unknown): Measure | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.value !== "number" || !Number.isFinite(r.value)) return undefined;
  if (r.dimension !== 1 && r.dimension !== 2 && r.dimension !== 3) return undefined;
  return { value: r.value, dimension: r.dimension };
}

/**
 * Tolerant read of the sidecar's `measures` key: an entry that does not
 * validate is dropped (it will simply be recomputed), a malformed whole is
 * ignored. Never throws.
 */
export function validateMeasuresCache(raw: unknown): MeasuresCache | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || r.key.length === 0) return undefined;
  const total = r.total === undefined ? null : validMeasure(r.total);
  if (total === undefined) return undefined;
  const parts: Record<string, Measure | null> = Object.create(null);
  if (typeof r.parts === "object" && r.parts !== null && !Array.isArray(r.parts)) {
    for (const [path, v] of Object.entries(r.parts as Record<string, unknown>)) {
      const m = validMeasure(v);
      if (m !== undefined) parts[path] = m;
    }
  }
  const out: MeasuresCache = { key: r.key, total, parts: { ...parts } };
  if (r.boundary !== undefined) {
    const b = validMeasure(r.boundary);
    if (b) out.boundary = b;
  }
  return out;
}
