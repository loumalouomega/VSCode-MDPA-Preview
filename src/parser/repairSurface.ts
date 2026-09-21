/**
 * Surface repair: fix inconsistent winding, orient closed components outward,
 * fill bounded holes, weld and split non-manifold vertices — through
 * meshio++'s `repair`, adopted in place (see adoptOp.ts).
 *
 * Pure module (no vscode / DOM). Two things are decided HERE rather than left
 * to the generic adoption, because they are properties of what repair does:
 *
 * - **What a generated face is.** Upstream appends the fill faces as a trailing
 *   `triangle` block and marks them with a `repair:hole` array; the carriers it
 *   cannot know (`kratos:kind`, entity id) come back as 0 — i.e. "Elements".
 *   `patchResult` gives them the kind of the surface they fill (the kind holding
 *   most of the source's surface cells, Conditions on a tie — a skin is nearly
 *   always Conditions), and the finished fill cells are MERGED into the source
 *   block of the same cell type, so they keep a name Kratos can instantiate
 *   (a block called "Repair_Fill" would be an unknown element type at solve
 *   time). They are made findable through a `Repair_Fill` SubModelPart instead.
 * - **What a generated face carries.** Nodal fields reach the hole-centre point
 *   as the mean of the hole boundary (upstream does this; measured), an
 *   Elemental/Conditional field is left undefined on the fill faces — a gap,
 *   never 0 — and a fill face's property id is the most common one of the block
 *   it joins.
 *
 * Caveats stated in the outcome rather than promised away: non-manifold EDGES
 * are counted, never split (only vertices are); and orienting outward does not
 * infer nested cavities.
 */

import { EntityBlock, EntityKind, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { cellCategory } from "./writers/writerCommon";
import { runAdoptingOp, describeFidelity } from "./adoptOp";
import type { MeshioRepairResult, MeshioSurfaceQuality } from "./meshio";
import { surfaceDefects } from "./surfaceDefects";

export interface RepairSurfaceParams {
  /** Make neighbouring faces agree on winding (default true). */
  fixOrientation?: boolean;
  /** Orient each closed component so its normals point out (default true). */
  orientOutward?: boolean;
  /** Triangulate bounded holes (default true). */
  fillHoles?: boolean;
  /** Split vertices where two fans of faces touch at a point (default true). */
  splitNonManifold?: boolean;
  /** Holes with more boundary edges than this are left open (default 10). */
  maxHoleEdges?: number;
  /** Weld points closer than this first (default 0 = off). */
  weldTolerance?: number;
}

export interface RepairSurfaceResult {
  model: MdpaModel;
  /** False when nothing needed repairing (the model is handed back unchanged). */
  changed: boolean;
  message: string;
  before: MeshioSurfaceQuality;
  after: MeshioSurfaceQuality;
  facesAdded: number;
  pointsAdded: number;
}

export const REPAIR_FILL_PART = "Repair_Fill";

const KIND_CODE: Record<EntityKind, number> = { Elements: 0, Conditions: 1, Geometries: 2 };

/** The kind holding most of the source's surface cells; Conditions on a tie, then Elements. */
function dominantSurfaceKind(model: MdpaModel): EntityKind {
  const n: Record<EntityKind, number> = { Elements: 0, Conditions: 0, Geometries: 0 };
  for (const b of model.blocks) if (cellCategory(b.vtkCellType) === "surface") n[b.kind] += b.count;
  let best: EntityKind = "Conditions";
  for (const k of ["Conditions", "Elements", "Geometries"] as EntityKind[]) if (n[k] > n[best]) best = k;
  return best;
}

function setEntry(arr: unknown, i: number, v: number): void {
  const a = arr as { [k: number]: number | bigint };
  a[i] = arr instanceof BigInt64Array || arr instanceof BigUint64Array ? BigInt(v) : v;
}

const fmt = (q: MeshioSurfaceQuality): string =>
  `${q.boundaryEdges} boundary, ${q.nonManifoldEdges} non-manifold, ${q.inconsistentPairs} inconsistent pair(s)`;

function uniqueName(existing: SubModelPart[], base: string): string {
  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Most common non-zero property id of a block (0 when it carries none). */
function dominantProperty(b: EntityBlock): number {
  if (!b.propertyIds) return 0;
  const n = new Map<number, number>();
  let best = 0;
  let bestN = 0;
  for (const p of b.propertyIds) {
    const c = (n.get(p) ?? 0) + 1;
    n.set(p, c);
    if (c > bestN) {
      best = p;
      bestN = c;
    }
  }
  return best;
}

export async function repairSurfaceModel(
  model: MdpaModel,
  params: RepairSurfaceParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<RepairSurfaceResult | { model: MdpaModel; changed: false; message: string }> {
  if (model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume")) {
    return {
      model,
      changed: false,
      message:
        "Repair works on surface meshes; this mesh has volume cells. Use File ▸ Export skin… to get its boundary surface, then repair that.",
    };
  }
  if (!model.blocks.some((b) => cellCategory(b.vtkCellType) === "surface")) {
    return { model, changed: false, message: "No surface (triangle/quad) cells to repair." };
  }
  const kind = dominantSurfaceKind(model);
  const before = surfaceDefects(model);

  const run = await runAdoptingOp<MeshioRepairResult>(
    model,
    diagnostics,
    "repairSurface",
    (m, mesh) =>
      m.repair(
        mesh,
        params.fixOrientation ?? true,
        params.orientOutward ?? true,
        params.fillHoles ?? true,
        params.splitNonManifold ?? true,
        params.maxHoleEdges ?? 10,
        params.weldTolerance ?? 0,
        true
      ),
    {
      recoverBlockNames: true,
      patchResult: (result) => {
        const holes = result.mesh.cell_data?.["repair:hole"];
        const kinds = result.mesh.cell_data?.["kratos:kind"];
        if (!holes || !kinds) return;
        for (let bi = 0; bi < holes.length; bi++) {
          const h = holes[bi] as ArrayLike<number | bigint>;
          for (let i = 0; i < h.length; i++) if (Number(h[i]) >= 0) setEntry(kinds[bi], i, KIND_CODE[kind]);
        }
      },
    }
  );
  if (!run) return { model, changed: false, message: "Nothing to repair." };
  const r: MeshioRepairResult = run.result;

  const changed =
    r.numFacesAdded > 0 ||
    r.numFlipped > 0 ||
    r.numVerticesSplit > 0 ||
    r.pointsWelded > 0 ||
    r.numOrientedOutward > 0;
  if (!changed) {
    const notes: string[] = [];
    if (r.numHolesSkipped > 0) {
      notes.push(`${r.numHolesSkipped} hole(s) exceed ${params.maxHoleEdges ?? 10} boundary edges and were left open`);
    }
    if (r.qualityBefore.nonManifoldEdges > 0) notes.push("non-manifold edges are counted but never split");
    return {
      model,
      changed: false,
      message:
        `Nothing to repair (${fmt(r.qualityBefore)}).` + (notes.length ? ` Note: ${notes.join("; ")}.` : ""),
    };
  }

  // --- generated faces: merge into the source block of the same type, and make findable ---
  const baseNames = new Set(model.blocks.map((b) => b.name));
  let out = run.model;
  const fillBlocks = out.blocks.filter((b) => !baseNames.has(b.name));
  const fillEntities: Record<EntityKind, number[]> = { Elements: [], Conditions: [], Geometries: [] };
  const fillNodes = new Set<number>();
  let blocks = out.blocks;
  const extra: string[] = [];
  for (const fb of fillBlocks) {
    for (let i = 0; i < fb.count; i++) fillEntities[fb.kind].push(fb.entityIds[i]);
    for (const n of fb.connectivity) fillNodes.add(n);
    let target: EntityBlock | undefined;
    for (const b of blocks) {
      if (b === fb || !baseNames.has(b.name)) continue;
      if (b.kind === fb.kind && b.vtkCellType === fb.vtkCellType && b.stride === fb.stride) {
        if (!target || b.count > target.count) target = b;
      }
    }
    if (!target) {
      extra.push(
        `no block of the same cell type to join, so the ${fb.count} fill face(s) form a block named "${fb.name}" — rename it to a real Kratos type before solving`
      );
      continue;
    }
    const prop = dominantProperty(target);
    const merged: EntityBlock = {
      ...target,
      count: target.count + fb.count,
      entityIds: Int32Array.from([...target.entityIds, ...fb.entityIds]),
      connectivity: Int32Array.from([...target.connectivity, ...fb.connectivity]),
      propertyIds: target.propertyIds
        ? Int32Array.from([...target.propertyIds, ...new Array<number>(fb.count).fill(prop)])
        : undefined,
    };
    blocks = blocks.filter((b) => b !== fb).map((b) => (b === target ? merged : b));
  }
  let subModelParts = out.subModelParts;
  const totalFill = fillEntities.Elements.length + fillEntities.Conditions.length + fillEntities.Geometries.length;
  if (totalFill > 0) {
    const name = uniqueName(subModelParts, REPAIR_FILL_PART);
    const part: SubModelPart = {
      name,
      path: name,
      nodeIds: Int32Array.from([...fillNodes].sort((a, b) => a - b)),
      elementIds: Int32Array.from(fillEntities.Elements),
      conditionIds: Int32Array.from(fillEntities.Conditions),
      geometryIds: Int32Array.from(fillEntities.Geometries),
      constraintIds: new Int32Array(0),
      children: [],
    };
    subModelParts = [...subModelParts, part];
  }
  out = { ...out, blocks, subModelParts };

  const after = surfaceDefects(out);
  const parts: string[] = [
    `Repaired: ${fmt(r.qualityBefore)} → ${fmt(r.qualityAfter)}.`,
  ];
  const did: string[] = [];
  if (r.pointsWelded > 0) did.push(`welded ${r.pointsWelded} point(s)`);
  if (r.numFlipped > 0) did.push(`flipped ${r.numFlipped} face(s)`);
  if (r.numOrientedOutward > 0) did.push(`oriented ${r.numOrientedOutward} closed component(s) outward`);
  if (r.numVerticesSplit > 0) did.push(`split ${r.numVerticesSplit} non-manifold ${r.numVerticesSplit === 1 ? "vertex" : "vertices"}`);
  if (r.numHolesFilled > 0) {
    did.push(`filled ${r.numHolesFilled} hole(s) with ${r.numFacesAdded} face(s) (+${r.numPointsAdded} point(s), in SubModelPart ${REPAIR_FILL_PART})`);
  }
  if (did.length) parts.push(did.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".");
  if (r.numHolesSkipped > 0) {
    parts.push(`${r.numHolesSkipped} hole(s) exceed ${params.maxHoleEdges ?? 10} boundary edges and were left open.`);
  }
  if (r.numUnorientable > 0) parts.push(`${r.numUnorientable} component(s) could not be oriented.`);
  if (r.qualityAfter.nonManifoldEdges > 0) {
    parts.push("Non-manifold edges remain: only vertices are split, edges are counted, never repaired.");
  }
  if (r.numOrientedOutward > 0 || (params.orientOutward ?? true)) {
    parts.push("Outward orientation does not infer nested cavities.");
  }
  if (after.boundaryEdges.length !== r.qualityAfter.boundaryEdges) {
    // Our own edge walk disagrees with the kernel's count: say so rather than pick one silently.
    parts.push(`(Own edge walk finds ${after.boundaryEdges.length} boundary edge(s).)`);
  }
  const fid = describeFidelity(run);
  if (fid) parts.push(fid);
  if (extra.length) parts.push(extra.join("; ") + ".");
  return {
    model: out,
    changed: true,
    message: parts.join(" "),
    before: r.qualityBefore,
    after: r.qualityAfter,
    facesAdded: r.numFacesAdded,
    pointsAdded: r.numPointsAdded,
  };
}
