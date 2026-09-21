/**
 * Surface simplification (quadric-error-metric edge collapse) through meshio++'s
 * `decimate`, as a derived COPY of the surface (see deriveMesh.ts) — never an
 * in-place edit, because decimation is lossy by intent.
 *
 * Pure module (no vscode / DOM). meshio++ is an ORACLE for the geometry and
 * the survivor bookkeeping (`returnMaps: true`), and the result is rebuilt
 * NATIVELY from those maps rather than adopted, so what survives keeps the
 * source's identity:
 *
 * - **cells** — a collapse removes one or two faces and leaves every other face
 *   in place with one corner redirected, so a surviving face IS the source face:
 *   it keeps its entity id, kind, block name and property id, and every
 *   Elemental/Conditional field value it had (never averaged — there is nothing
 *   to average, the cell is the same cell);
 * - **nodes** — `pointMap` sends every SOURCE point to the output point it was
 *   merged into (measured: it is many-to-one and never −1), so an output point
 *   takes the id of the LOWEST source node merged into it, at upstream's placed
 *   position; Nodal fields at a collapsed vertex are upstream's blend of the
 *   endpoints (an approximation for `optimal` placement, exact for
 *   `midpoint`/`endpoint` — upstream's own statement);
 * - **SubModelParts** — element/condition ids narrowed to survivors, node lists
 *   mapped through `pointMap` (deduplicated); constraints are dropped with a
 *   stated warning (the topology changed, like MMG).
 *
 * Scope is upstream's, enforced by name before the wasm runs: a mesh made ONLY
 * of triangles. Volume cells point at Export skin, quads at Simplexify (upstream
 * would triangulate them first, giving no 1:1 cell identity), higher-order at
 * Quadratic → Linear, and lines/points cannot be mixed in (their nodes would
 * dangle after a collapse).
 */

import { EntityBlock, EntityKind, FieldData, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { modelToMeshio, meshioBlockOrder, sanitizeVariable } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { expectCount } from "./meshioAdapter";
import { VtkCellType } from "./geometryMap";
import { cellCategory } from "./writers/writerCommon";
import { findSubModelPart, sliceField } from "./subModelPartExtract";

export type DecimatePlacement = "optimal" | "midpoint" | "endpoint";
export const DECIMATE_PLACEMENTS: readonly DecimatePlacement[] = ["optimal", "midpoint", "endpoint"];

export interface DecimateParams {
  /** Fraction of the faces to KEEP, in (0, 1]. Exactly one of ratio / targetFaces / maxError. */
  ratio?: number;
  /** Absolute face count to stop at. */
  targetFaces?: number;
  /** Collapse only while the cheapest candidate's quadric error is at most this (squared mesh units). */
  maxError?: number;
  placement?: DecimatePlacement;
  /** Pin boundary vertices (default true): an open patch keeps its outline exactly. */
  preserveBoundary?: boolean;
  /** Pin vertices on creases (default true). */
  preserveFeatures?: boolean;
  /** Dihedral angle in degrees above which a vertex is a feature (default 30). */
  featureAngle?: number;
  /** The nodes of this SubModelPart (and its subtree) are never moved or removed. */
  frozenPart?: string;
}

export interface DecimateResult {
  model: MdpaModel;
  facesBefore: number;
  facesAfter: number;
  pointsBefore: number;
  pointsAfter: number;
  /** Fraction of the faces removed. */
  reduction: number;
  /** Largest quadric error of any collapse applied, in squared mesh units; sqrt is a length. */
  maxErrorApplied: number;
  /** As a fraction of the bounding-box diagonal (a scale-free reading of the same length). */
  relativeError: number;
  collapsesRejected: number;
  droppedConstraints: number;
  warnings: string[];
}

/** Refuses anything upstream cannot decimate, by name, before the wasm runs. */
function scopeProblem(model: MdpaModel): string | undefined {
  if (model.blocks.length === 0) return "The mesh has no cells to decimate.";
  const volume = model.blocks.filter((b) => cellCategory(b.vtkCellType) === "volume");
  if (volume.length > 0) {
    return "Decimation works on a triangle surface; this mesh has volume cells. Use File ▸ Export skin… to get its boundary surface, Simplexify quads if it has any, then decimate that.";
  }
  const bad = model.blocks.filter((b) => b.vtkCellType !== VtkCellType.TRIANGLE);
  if (bad.length === 0) return undefined;
  const lower = bad.filter((b) => cellCategory(b.vtkCellType) === "line" || cellCategory(b.vtkCellType) === "point");
  if (lower.length > 0) return `Decimation cannot keep line or point cells (${lower.map((b) => b.name).join(", ")}): their nodes would dangle after a collapse. Remove them first.`;
  const quad = bad.filter((b) => b.vtkCellType === VtkCellType.QUAD);
  if (quad.length > 0) return `Decimation needs triangles; ${quad.map((b) => b.name).join(", ")} is quadrilateral. Run Simplexify first.`;
  return `Decimation needs linear triangles; ${bad.map((b) => b.name).join(", ")} is not (higher-order cells: run Quadratic → Linear first).`;
}

function partNodes(part: SubModelPart, into = new Set<number>()): Set<number> {
  for (const id of part.nodeIds) into.add(id);
  for (const c of part.children) partNodes(c, into);
  return into;
}

export async function decimateModel(
  model: MdpaModel,
  params: DecimateParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<DecimateResult> {
  const given = [params.ratio, params.targetFaces, params.maxError].filter((v) => v !== undefined);
  if (given.length !== 1) throw new Error("Give exactly one of ratio, targetFaces or maxError.");
  if (params.ratio !== undefined && !(params.ratio > 0 && params.ratio <= 1)) throw new Error("ratio (the fraction of faces to KEEP) must be in (0, 1].");
  if (params.targetFaces !== undefined && !(Number.isInteger(params.targetFaces) && params.targetFaces >= 1)) throw new Error("targetFaces must be a positive integer.");
  if (params.maxError !== undefined && !(params.maxError > 0 && Number.isFinite(params.maxError))) throw new Error("maxError must be positive.");
  const problem = scopeProblem(model);
  if (problem) throw new Error(problem);

  let frozen: number[] | null = null;
  if (params.frozenPart) {
    const part = findSubModelPart(model, params.frozenPart);
    if (!part) throw new Error(`SubModelPart "${params.frozenPart}" (the nodes to freeze) was not found.`);
    const ids = partNodes(part);
    const index = new Map<number, number>();
    for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);
    frozen = [...ids].map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  }

  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  const order = meshioBlockOrder(model);
  if (order.length !== mesh.cells.length) throw new Error("decimate: block correspondence failed; the result was discarded.");
  const m = await loadMeshio();
  const r = m.decimate(
    mesh,
    params.ratio ?? -1,
    params.targetFaces ?? -1,
    params.maxError ?? -1,
    params.placement ?? "optimal",
    params.preserveBoundary ?? true,
    params.preserveFeatures ?? true,
    params.featureAngle ?? 30,
    frozen,
    true
  );
  if (!r.pointMap || !r.cellMaps) throw new Error("decimate returned no survivor maps; the result was discarded.");
  const pointMap: Int32Array = r.pointMap;
  const cellMaps: Int32Array[] = r.cellMaps;
  const out = r.mesh;
  expectCount("decimate", "node", pointMap.length, model.nodeCount);
  if (cellMaps.length !== order.length || out.cells.length !== order.length) {
    throw new Error("decimate changed the block structure; the result was discarded.");
  }

  // Output point j takes the id of the LOWEST source node merged into it.
  const outPoints = out.points.length / 3;
  const repIndex = new Int32Array(outPoints).fill(-1);
  for (let i = 0; i < pointMap.length; i++) {
    const j = pointMap[i];
    if (j >= 0 && (repIndex[j] === -1 || model.nodeIds[i] < model.nodeIds[repIndex[j]])) repIndex[j] = i;
  }
  if (repIndex.some((v) => v === -1)) throw new Error("An output point has no source node; the result was discarded.");
  const nodeIds = Int32Array.from(repIndex, (i) => model.nodeIds[i]);
  const coords = new Float32Array(outPoints * 3);
  for (let i = 0; i < coords.length; i++) coords[i] = out.points[i];

  // Blocks: survivors in OUTPUT order, original entity ids / property ids / names kept.
  const keep: Record<EntityKind, Set<number>> = { Elements: new Set(), Conditions: new Set(), Geometries: new Set() };
  const blocks: EntityBlock[] = [];
  let facesBefore = 0;
  let facesAfter = 0;
  for (let bi = 0; bi < order.length; bi++) {
    const src = order[bi];
    facesBefore += src.count;
    const cellMap = cellMaps[bi];
    const outCells = out.cells[bi] as { data: Int32Array; nodesPerCell: number };
    const n = outCells.nodesPerCell > 0 ? Math.floor(outCells.data.length / outCells.nodesPerCell) : 0;
    const entityIds = new Int32Array(n);
    const propertyIds = src.propertyIds ? new Int32Array(n) : undefined;
    const filled = new Uint8Array(n);
    for (let c = 0; c < src.count; c++) {
      const j = cellMap[c];
      if (j < 0) continue;
      entityIds[j] = src.entityIds[c];
      if (propertyIds && src.propertyIds) propertyIds[j] = src.propertyIds[c];
      filled[j] = 1;
      keep[src.kind].add(src.entityIds[c]);
    }
    if (filled.some((v) => v === 0)) throw new Error("A surviving face has no source face; the result was discarded.");
    const connectivity = new Int32Array(n * src.stride);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < src.stride; k++) connectivity[j * src.stride + k] = nodeIds[outCells.data[j * outCells.nodesPerCell + k]];
    }
    facesAfter += n;
    if (n > 0) blocks.push({ ...src, count: n, entityIds, propertyIds, connectivity });
  }

  // Fields. Nodal: upstream's values at the output points (blended at collapsed vertices).
  const fields: FieldData[] = [];
  const dropped: string[] = [];
  for (const f of model.fields) {
    if (f.kind === "Nodal") {
      const raw = out.point_data?.[sanitizeVariable(f.variable)];
      const comps = out.point_data_components?.[sanitizeVariable(f.variable)] ?? 1;
      if (!raw || (raw as ArrayLike<number>).length !== outPoints * comps) {
        dropped.push(`Nodal:${f.variable}`);
        continue;
      }
      const values = Float64Array.from(raw as ArrayLike<number | bigint>, Number);
      fields.push({ kind: "Nodal", variable: f.variable, components: comps, ids: Int32Array.from(nodeIds), values });
    } else {
      const sliced = sliceField(f, keep[f.kind === "Conditional" ? "Conditions" : "Elements"]);
      if (sliced) fields.push(sliced);
    }
  }

  // SubModelParts: node lists follow the merge, entity lists narrow to survivors.
  const repOfSourceNode = new Map<number, number>();
  for (let i = 0; i < pointMap.length; i++) repOfSourceNode.set(model.nodeIds[i], nodeIds[pointMap[i]]);
  const mapPart = (p: SubModelPart): SubModelPart => ({
    ...p,
    nodeIds: Int32Array.from(new Set([...p.nodeIds].map((id) => repOfSourceNode.get(id)).filter((v): v is number => v !== undefined))).sort(),
    elementIds: p.elementIds.filter((id) => keep.Elements.has(id)),
    conditionIds: p.conditionIds.filter((id) => keep.Conditions.has(id)),
    geometryIds: p.geometryIds.filter((id) => keep.Geometries.has(id)),
    constraintIds: new Int32Array(0),
    children: p.children.map(mapPart),
  });

  const droppedConstraints = (model.constraints ?? []).reduce((s, b) => s + b.rows.length, 0);
  const warnings: string[] = [];
  if (droppedConstraints > 0) warnings.push(`${droppedConstraints} constraint row(s) were dropped: decimation changes the topology, so there is nothing to maintain them against.`);
  if (dropped.length > 0) warnings.push(`Dropped field(s) upstream did not return: ${dropped.join(", ")}.`);
  if (facesAfter > (params.targetFaces ?? 0) + 2 && params.targetFaces !== undefined) {
    warnings.push(`Stopped at ${facesAfter} faces, above the target ${params.targetFaces}: pinned boundary and feature vertices left no collapsible edge.`);
  }
  if (r.collapsesRejected > 0) warnings.push(`${r.collapsesRejected} collapse(s) were rejected by the validity guards (link condition, normal flip).`);

  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const bounds = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
  for (let i = 0; i < outPoints; i++) for (let k = 0; k < 3; k++) {
    const v = coords[i * 3 + k];
    if (v < bounds.min[k]) bounds.min[k] = v;
    if (v > bounds.max[k]) bounds.max[k] = v;
  }
  const result: MdpaModel = {
    ...model,
    nodeCount: outPoints,
    nodeIds,
    coords,
    bounds,
    blocks,
    fields,
    subModelParts: model.subModelParts.map(mapPart),
    constraints: undefined,
  };
  const err = Math.sqrt(Math.max(0, r.maxErrorApplied));
  return {
    model: result,
    facesBefore,
    facesAfter,
    pointsBefore: model.nodeCount,
    pointsAfter: outPoints,
    reduction: facesBefore > 0 ? 1 - facesAfter / facesBefore : 0,
    maxErrorApplied: r.maxErrorApplied,
    relativeError: diag > 0 ? err / diag : 0,
    collapsesRejected: r.collapsesRejected,
    droppedConstraints,
    warnings,
  };
}
