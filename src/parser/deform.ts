/**
 * Coordinate-only deformation through meshio++: `shrinkwrap` (project onto a
 * target surface) and `sobolevDeform` (a smoothed, optionally pinned
 * displacement field). Pure module (no vscode / DOM / wasm imports of its own).
 *
 * Both are ORACLES in the smoothMesh.ts sense — they move points, never renumber
 * — so the result is applied onto our own model as new coordinates and
 * meshio++'s returned mesh is otherwise ignored: SubModelParts, kinds, property
 * ids, entity ids and every field survive untouched. Neither has a cell-inversion
 * guard upstream, so each reports (via `cellInversion.ts`) what the move did to
 * the cells.
 *
 * `shrinkwrap` is the purest shape of all: it "moves every point whatever cells
 * it carries", so only the POINTS (plus a weights array) cross the boundary and
 * our cells never do — measured against the live wasm, a mesh with no cells at
 * all is a valid source. `sobolevDeform` genuinely needs the top-dimensional
 * cells (its operators are assembled on them), so those cross, with nothing
 * else attached.
 */

import { MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { modelToMeshio, MeshioMesh } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { expectCount, requireTriangulatedSurface } from "./meshioAdapter";
import { findSubModelPart } from "./subModelPartExtract";
import { cellCategory } from "./writers/writerCommon";
import { VtkCellType } from "./geometryMap";
import { invertedCells, describeInverted, InvertedCells } from "./cellInversion";

export const SHRINKWRAP_DISTANCE_VARIABLE = "SHRINKWRAP_DISTANCE";

function boundsOf(coords: Float32Array, n: number): MdpaModel["bounds"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = coords[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return n === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}

/** Node ids of a SubModelPart and its whole subtree. */
function partNodeIds(part: SubModelPart, into = new Set<number>()): Set<number> {
  for (const id of part.nodeIds) into.add(id);
  for (const c of part.children) partNodeIds(c, into);
  return into;
}

function movedModel(model: MdpaModel, points: ArrayLike<number>): MdpaModel {
  const coords = new Float32Array(model.coords);
  for (let i = 0; i < model.nodeCount * 3; i++) coords[i] = points[i];
  return { ...model, coords, bounds: boundsOf(coords, model.nodeCount) };
}

// --- shrinkwrap ----------------------------------------------------------------

export interface ShrinkwrapParams {
  /** Distance along the target's (feature) normal to stand off from it; negative goes the other way. */
  offset?: number;
  /** Nodes farther than this from the target are left where they are (0/unset = unlimited). */
  maxDistance?: number;
  /**
   * Blend factor: `x' = x + blend * (projection − x)`. Applied unclamped, as upstream does, so a value above 1
   * overshoots and one below 0 pulls away — default 1 (land on the target).
   */
  blend?: number;
  /** Only the nodes of this SubModelPart (and its subtree) may move. */
  movePart?: string;
  /** The nodes of this SubModelPart (and its subtree) are held in place. */
  pinPart?: string;
  /** How a vertex hit's offset direction is weighted: "angle" (default) or "area". */
  normalWeight?: "angle" | "area";
  /** Also write the pre-move distance to the target as `SHRINKWRAP_DISTANCE` (undefined where not queried). */
  recordDistance?: boolean;
}

export interface ShrinkwrapResult {
  model: MdpaModel;
  numProjected: number;
  numMissed: number;
  numSkipped: number;
  maxDisplacement: number;
  inverted: InvertedCells;
  /** Whether the target was closed; an offset near a defective target can land on different sides. */
  targetWatertight: boolean;
  message?: string;
}

export async function shrinkwrapModel(
  model: MdpaModel,
  target: MdpaModel,
  params: ShrinkwrapParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<ShrinkwrapResult> {
  const none = (message: string): ShrinkwrapResult => ({
    model,
    numProjected: 0,
    numMissed: 0,
    numSkipped: 0,
    maxDisplacement: 0,
    inverted: { volume: 0, surface: 0, cells: [] },
    targetWatertight: false,
    message,
  });
  if (model.nodeCount === 0) return none("The mesh has no nodes.");
  const targetMesh = modelToMeshio(target, diagnostics, { dim: 3 });
  if (targetMesh.cells.length === 0) return none("The target has no cells, so there is nothing to project onto.");
  requireTriangulatedSurface(targetMesh.cells, "shrinkwrap target");

  // Which nodes may move, and by how much: weight = blend * (allowed ? 1 : 0).
  const blend = params.blend ?? 1;
  const weights = new Float64Array(model.nodeCount).fill(blend);
  if (params.movePart) {
    const part = findSubModelPart(model, params.movePart);
    if (!part) return none(`SubModelPart "${params.movePart}" (the nodes to move) was not found.`);
    const keep = partNodeIds(part);
    for (let i = 0; i < model.nodeCount; i++) if (!keep.has(model.nodeIds[i])) weights[i] = 0;
  }
  if (params.pinPart) {
    const part = findSubModelPart(model, params.pinPart);
    if (!part) return none(`SubModelPart "${params.pinPart}" (the nodes to hold fixed) was not found.`);
    const pinned = partNodeIds(part);
    for (let i = 0; i < model.nodeCount; i++) if (pinned.has(model.nodeIds[i])) weights[i] = 0;
  }

  const points = new Float64Array(model.nodeCount * 3);
  for (let i = 0; i < points.length; i++) points[i] = model.coords[i];
  // Only points cross: a cell-less mesh is a valid shrinkwrap source (measured).
  const source = {
    dim: 3,
    points,
    cells: [],
    point_data: { shrinkwrap_weight: weights },
    cell_data: {},
    field_data: {},
  } as unknown as MeshioMesh;

  const m = await loadMeshio();
  const r = m.shrinkwrap(
    source,
    targetMesh,
    params.offset ?? 0,
    params.maxDistance && params.maxDistance > 0 ? params.maxDistance : 0,
    "shrinkwrap_weight",
    "",
    params.normalWeight ?? "angle",
    params.recordDistance ?? false,
    false
  );
  expectCount("shrinkwrap", "node", Math.floor(r.mesh.points.length / 3), model.nodeCount);

  let next = movedModel(model, r.mesh.points);
  if (params.recordDistance) {
    const raw = r.mesh.point_data?.["shrinkwrap:distance"];
    if (raw) {
      const ids: number[] = [];
      const vals: number[] = [];
      for (let i = 0; i < model.nodeCount; i++) {
        const v = Number((raw as ArrayLike<number | bigint>)[i]);
        if (Number.isFinite(v)) {
          ids.push(model.nodeIds[i]);
          vals.push(v);
        }
      }
      if (ids.length > 0) {
        next = {
          ...next,
          fields: [
            ...next.fields.filter((f) => !(f.kind === "Nodal" && f.variable === SHRINKWRAP_DISTANCE_VARIABLE)),
            {
              kind: "Nodal",
              variable: SHRINKWRAP_DISTANCE_VARIABLE,
              components: 1,
              ids: Int32Array.from(ids),
              values: Float64Array.from(vals),
            },
          ],
        };
      }
    }
  }
  return {
    model: next,
    numProjected: r.numProjected,
    numMissed: r.numMissed,
    numSkipped: r.numSkipped,
    maxDisplacement: r.maxDisplacement,
    inverted: invertedCells(model, next),
    targetWatertight: r.quality.watertight,
  };
}

// --- Sobolev deformation ---------------------------------------------------------

export interface SobolevParams {
  /** A Nodal field carrying the raw displacement (2 or 3 components). */
  variable: string;
  /** Cutoff wavelength of the smoothing filter; 0 applies the displacement unfiltered. */
  lengthScale: number;
  /** The nodes of this SubModelPart (and its subtree) are pinned. */
  fixedPart?: string;
  /** Pin every node on a boundary facet of the top-dimensional cells. */
  fixBoundary?: boolean;
  maxIterations?: number;
  tolerance?: number;
}

export interface SobolevResult {
  model: MdpaModel;
  numIterations: number;
  residual: number;
  converged: boolean;
  numFixed: number;
  numIsolated: number;
  maxDisplacement: number;
  /** Nodes the displacement field did not cover (they received 0). */
  numUncovered: number;
  inverted: InvertedCells;
  message?: string;
}

/** The mesh's top topological dimension must be linear line/triangle/tetra cells. */
function checkSobolevScope(model: MdpaModel): string | undefined {
  const cats = new Set(model.blocks.map((b) => cellCategory(b.vtkCellType)));
  const top = cats.has("volume") ? "volume" : cats.has("surface") ? "surface" : cats.has("line") ? "line" : undefined;
  if (!top) return "The mesh has no cells; a Sobolev deformation is defined on its lines, triangles or tetrahedra.";
  const bad = model.blocks.filter((b) => cellCategory(b.vtkCellType) === top && !isLinearSimplex(b.vtkCellType, top));
  if (bad.length === 0) return undefined;
  const names = bad.map((b) => b.name).join(", ");
  return (
    `Sobolev deformation needs linear ${top === "volume" ? "tetrahedra" : top === "surface" ? "triangles" : "lines"} ` +
    `at the top dimension; "${names}" is not. Run Simplexify (or Quadratic → Linear for higher-order cells) first.`
  );
}

function isLinearSimplex(type: number | undefined, top: "volume" | "surface" | "line"): boolean {
  return (
    (top === "volume" && type === VtkCellType.TETRA) ||
    (top === "surface" && type === VtkCellType.TRIANGLE) ||
    (top === "line" && type === VtkCellType.LINE)
  );
}

export async function sobolevDeformModel(
  model: MdpaModel,
  params: SobolevParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<SobolevResult> {
  const none = (message: string): SobolevResult => ({
    model,
    numIterations: 0,
    residual: 0,
    converged: false,
    numFixed: 0,
    numIsolated: 0,
    maxDisplacement: 0,
    numUncovered: 0,
    inverted: { volume: 0, surface: 0, cells: [] },
    message,
  });
  if (model.nodeCount === 0) return none("The mesh has no nodes.");
  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === params.variable);
  if (!field) return none(`No nodal field named "${params.variable}".`);
  if (field.components < 2 || field.components > 3) {
    return none(`"${params.variable}" has ${field.components} component(s); a displacement needs 2 or 3.`);
  }
  const scope = checkSobolevScope(model);
  if (scope) return none(scope);

  // The displacement, one 3-vector per node in nodeIds order; a node the field
  // does not cover moves by 0 (reported), a 2-component field has z = 0.
  const index = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);
  const d = new Float64Array(model.nodeCount * 3);
  const covered = new Uint8Array(model.nodeCount);
  for (let r = 0; r < field.ids.length; r++) {
    const i = index.get(field.ids[r]);
    if (i === undefined) continue;
    covered[i] = 1;
    for (let k = 0; k < field.components; k++) d[i * 3 + k] = field.values[r * field.components + k];
  }
  const numUncovered = covered.reduce((n, v) => n + (v ? 0 : 1), 0);

  const fixed = new BigInt64Array(model.nodeCount);
  let usingFixed = false;
  if (params.fixedPart) {
    const part = findSubModelPart(model, params.fixedPart);
    if (!part) return none(`SubModelPart "${params.fixedPart}" (the nodes to pin) was not found.`);
    const pinned = partNodeIds(part);
    for (let i = 0; i < model.nodeCount; i++) if (pinned.has(model.nodeIds[i])) fixed[i] = 1n;
    usingFixed = true;
  }

  // Cells cross (the operators are assembled on them); no fields, no regions.
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return none("Nothing to deform.");
  mesh.point_data = { sobolev_d: d, ...(usingFixed ? { sobolev_fixed: fixed } : {}) } as unknown as MeshioMesh["point_data"];
  mesh.point_data_components = { sobolev_d: 3 };
  mesh.cell_data = {};
  mesh.cell_data_components = {};
  mesh.regions = [];

  const m = await loadMeshio();
  const r = m.sobolevDeform(
    mesh,
    "sobolev_d",
    params.lengthScale,
    usingFixed ? "sobolev_fixed" : "",
    params.fixBoundary ?? false,
    false,
    params.maxIterations ?? 128,
    params.tolerance ?? 1e-10
  );
  expectCount("sobolevDeform", "node", Math.floor(r.mesh.points.length / 3), model.nodeCount);
  const next = movedModel(model, r.mesh.points);
  return {
    model: next,
    numIterations: r.numIterations,
    residual: r.residual,
    converged: r.converged,
    numFixed: r.numFixed,
    numIsolated: r.numIsolated,
    maxDisplacement: r.maxDisplacement,
    numUncovered,
    inverted: invertedCells(model, next),
  };
}

export { describeInverted };
