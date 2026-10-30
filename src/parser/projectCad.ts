/**
 * Project a CAD-tagged surface mesh back onto its B-rep (meshio++ 17.23.0
 * `projectToCad`). A coordinate-only ORACLE in `deform.ts`'s sense: the kernel
 * moves points and nothing else, so the result is applied onto our OWN model as
 * new coordinates — ids, blocks, SubModelParts, Properties and fields keep
 * their identity, and the point count is checked (`expectCount`).
 *
 * The kernel finds each node's CAD face through a per-cell `cad:face` array (and
 * `cad:edge` for lines) that `meshCadSurface` writes. Our `cadSurface` derive
 * keeps them as the `CAD_FACE` / `CAD_EDGE` fields, so the tag is read from the
 * model's own fields and handed to the kernel under the kernel's names. A mesh
 * with no such field is refused by name: there is nothing to say which face a
 * node belongs to.
 *
 * Pure module (no vscode / DOM); the B-rep is the `info` of a parsed
 * `.cad.json` (or STEP/IGES) — the caller reads the file.
 */

import { MdpaDiagnostic, MdpaModel, FieldData } from "./types";
import { modelToMeshio, meshioBlockOrder, MeshioMesh } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { expectCount } from "./meshioAdapter";
import { findSubModelPart } from "./subModelPartExtract";
import { invertedCells, describeInverted, InvertedCells } from "./cellInversion";
import { movedModel, partNodeIds } from "./deform";

export const CAD_FACE_VARIABLE = "CAD_FACE";
export const CAD_EDGE_VARIABLE = "CAD_EDGE";

export interface ProjectToCadParams {
  /** The Elemental/Conditional field naming each surface cell's CAD face (default `CAD_FACE`). */
  faceField?: string;
  /** The same for lines and their CAD edge (default `CAD_EDGE`; optional). */
  edgeField?: string;
  /** A node farther than this from the CAD stays where it is (0/unset = no limit). */
  maxDistance?: number;
  /** Samples per knot span when testing a face's trims (kernel default 16). */
  trimSamples?: number;
  /** Only the nodes of this SubModelPart (and its subtree) may move. */
  movePart?: string;
  /** The nodes of this SubModelPart (and its subtree) are held in place. */
  pinPart?: string;
}

export interface ProjectToCadResult {
  model: MdpaModel;
  numProjected: number;
  numOnEdges: number;
  numCorners: number;
  numAmbiguous: number;
  numTooFar: number;
  numFailed: number;
  numOutsideTrim: number;
  /** Nodes left in place because a `movePart`/`pinPart` excluded them. */
  numHeld: number;
  maxMove: number;
  /** Ids of the nodes projected outside their face's trims (capped). */
  outsideTrimIds: number[];
  inverted: InvertedCells;
  warnings: string[];
  message?: string;
}

const OUTSIDE_TRIM_ID_LIMIT = 20;

/** Per-block tag arrays in `meshioBlockOrder`, read from the model's own field (−1 where a cell has no tag). */
function tagArrays(model: MdpaModel, variable: string): { arrays: BigInt64Array[]; tagged: number } | undefined {
  const byKind = new Map<string, Map<number, number>>();
  for (const f of model.fields as FieldData[]) {
    if (f.variable !== variable || f.components !== 1) continue;
    if (f.kind !== "Elemental" && f.kind !== "Conditional") continue;
    const m = byKind.get(f.kind) ?? new Map<number, number>();
    for (let i = 0; i < f.ids.length; i++) m.set(f.ids[i], f.values[i]);
    byKind.set(f.kind, m);
  }
  if (byKind.size === 0) return undefined;
  let tagged = 0;
  const arrays = meshioBlockOrder(model).map((b) => {
    const lookup = byKind.get(b.kind === "Conditions" ? "Conditional" : b.kind === "Elements" ? "Elemental" : "");
    const out = new BigInt64Array(b.count).fill(-1n);
    if (lookup) {
      for (let c = 0; c < b.count; c++) {
        const v = lookup.get(b.entityIds[c]);
        if (v !== undefined && Number.isFinite(v)) {
          out[c] = BigInt(Math.round(v));
          tagged++;
        }
      }
    }
    return out;
  });
  return { arrays, tagged };
}

export async function projectToCadModel(
  model: MdpaModel,
  brep: { info: object },
  params: ProjectToCadParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<ProjectToCadResult> {
  const none = (message: string): ProjectToCadResult => ({
    model,
    numProjected: 0,
    numOnEdges: 0,
    numCorners: 0,
    numAmbiguous: 0,
    numTooFar: 0,
    numFailed: 0,
    numOutsideTrim: 0,
    numHeld: 0,
    maxMove: 0,
    outsideTrimIds: [],
    inverted: { volume: 0, surface: 0, cells: [] },
    warnings: [],
    message,
  });
  if (model.nodeCount === 0) return none("The mesh has no nodes.");

  const faceName = params.faceField ?? CAD_FACE_VARIABLE;
  const edgeName = params.edgeField ?? CAD_EDGE_VARIABLE;
  const face = tagArrays(model, faceName);
  if (!face || face.tagged === 0) {
    return none(
      `The mesh has no ${faceName} field naming each cell's CAD face, so there is nothing to project by. ` +
        `Make the mesh with Mesh CAD faces… (it writes ${CAD_FACE_VARIABLE}) or add a one-component Elemental/Conditional field with the CAD face index of each surface cell.`
    );
  }
  const edge = tagArrays(model, edgeName);

  // Which nodes may move: pin/move-part become "hold in place" after the call (the kernel takes no weights).
  const hold = new Uint8Array(model.nodeCount);
  if (params.movePart) {
    const part = findSubModelPart(model, params.movePart);
    if (!part) return none(`SubModelPart "${params.movePart}" (the nodes to move) was not found.`);
    const keep = partNodeIds(part);
    for (let i = 0; i < model.nodeCount; i++) if (!keep.has(model.nodeIds[i])) hold[i] = 1;
  }
  if (params.pinPart) {
    const part = findSubModelPart(model, params.pinPart);
    if (!part) return none(`SubModelPart "${params.pinPart}" (the nodes to hold fixed) was not found.`);
    const pinned = partNodeIds(part);
    for (let i = 0; i < model.nodeCount; i++) if (pinned.has(model.nodeIds[i])) hold[i] = 1;
  }

  // Only the geometry and the two tag arrays cross: the kernel reads nothing else.
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return none("The mesh has no cells.");
  const blocks = meshioBlockOrder(model);
  if (mesh.cells.length !== blocks.length) {
    throw new Error(`projectToCad saw ${mesh.cells.length} meshio block(s) for ${blocks.length} mesh block(s); the result was discarded.`);
  }
  const source = {
    ...mesh,
    point_data: {},
    point_data_components: undefined,
    cell_data: { "cad:face": face.arrays, ...(edge ? { "cad:edge": edge.arrays } : {}) },
    cell_data_components: undefined,
    field_data: {},
  } as unknown as MeshioMesh;

  const options: Record<string, unknown> = {};
  if (params.maxDistance !== undefined && params.maxDistance > 0) options.maxDistance = params.maxDistance;
  if (params.trimSamples !== undefined) options.trimSamples = params.trimSamples;

  const m = await loadMeshio();
  const r = m.projectToCad(source, brep.info, options);
  expectCount("projectToCad", "node", Math.floor(r.mesh.points.length / 3), model.nodeCount);

  const points = Float64Array.from(r.mesh.points);
  let numHeld = 0;
  for (let i = 0; i < model.nodeCount; i++) {
    if (!hold[i]) continue;
    numHeld++;
    for (let k = 0; k < 3; k++) points[i * 3 + k] = model.coords[i * 3 + k];
  }
  const next = movedModel(model, points);
  return {
    model: next,
    numProjected: r.numProjected,
    numOnEdges: r.numOnEdges,
    numCorners: r.numCorners,
    numAmbiguous: r.numAmbiguous,
    numTooFar: r.numTooFar,
    numFailed: r.numFailed,
    numOutsideTrim: r.numOutsideTrim,
    numHeld,
    maxMove: r.maxMove,
    outsideTrimIds: r.outsideTrim.slice(0, OUTSIDE_TRIM_ID_LIMIT).map((i) => model.nodeIds[i]),
    inverted: invertedCells(model, next),
    warnings: r.warnings,
  };
}

/** The one-paragraph outcome message of a projection. */
export function describeProjectToCad(r: ProjectToCadResult, from: string): string {
  const parts = [
    `Projected ${r.numProjected} node(s) onto the CAD of ${from} (${r.numOnEdges} on edges, ${r.numCorners} at corners); max move ${Number(r.maxMove.toPrecision(4))}.`,
  ];
  const left: string[] = [];
  if (r.numTooFar > 0) left.push(`${r.numTooFar} beyond the maximum distance`);
  if (r.numFailed > 0) left.push(`${r.numFailed} failed`);
  if (r.numAmbiguous > 0) left.push(`${r.numAmbiguous} ambiguous`);
  if (r.numHeld > 0) left.push(`${r.numHeld} not selected to move`);
  if (left.length) parts.push(`Left in place: ${left.join(", ")}.`);
  if (r.numOutsideTrim > 0) {
    parts.push(`${r.numOutsideTrim} node(s) landed outside their face's trim loops (first ids: ${r.outsideTrimIds.join(", ")}).`);
  }
  const inv = describeInverted(r.inverted);
  if (inv) parts.push(inv);
  if (r.warnings.length) parts.push(r.warnings.join(" "));
  return parts.join(" ");
}
