/**
 * Turning MMG's level-set split into a mesh a solver can read: name the fluid
 * and the wall, drop the body interior, give the blocks Kratos type names, make
 * every tetrahedron positively oriented and remove boundary conditions that no
 * longer lie on the fluid.
 *
 * The level set labels its two sides by the sign of the field, not by meaning,
 * so which side is the fluid is decided here from geometry — the fluid is the
 * side that touches the inlet — never from the labels MMG chose.
 *
 * Pure: no vscode, no wasm.
 */

import type { EntityBlock, MdpaModel, SubModelPart } from "../../parser/types";
import { deleteSubModelPart } from "../../parser/deleteSubModelPart";
import { renameSubModelPart } from "../../parser/renameSubModelPart";
import { deleteEntities } from "../../parser/selectCells";
import { computeMeshQuality } from "../../parser/meshQuality";
import { VtkCellType } from "../../parser/geometryMap";

export interface FinishNames {
  fluid: string;
  body: string;
  inlet: string;
}

export const DEFAULT_FINISH_NAMES: FinishNames = { fluid: "Fluid", body: "Body", inlet: "Inlet" };

export interface FinishResult {
  model: MdpaModel;
  /** Tetrahedra removed with the body interior. */
  removedTetrahedra: number;
  /** Boundary conditions that sat on the body interior, not on the fluid. */
  removedConditions: number;
  /** Tetrahedra whose orientation was reversed. */
  reoriented: number;
  messages: string[];
}

const touches = (a: SubModelPart, nodes: Set<number>): boolean => {
  for (const n of a.nodeIds) if (nodes.has(n)) return true;
  return false;
};

function tetVolume6(model: MdpaModel, idx: Map<number, number>, c: Int32Array, o: number): number {
  const p = [0, 1, 2, 3].map((k) => idx.get(c[o + k])! * 3);
  const u = [1, 2, 3].map((k) => [0, 1, 2].map((a) => model.coords[p[k] + a] - model.coords[p[0] + a]));
  return u[0][0] * (u[1][1] * u[2][2] - u[1][2] * u[2][1]) - u[0][1] * (u[1][0] * u[2][2] - u[1][2] * u[2][0]) + u[0][2] * (u[1][0] * u[2][1] - u[1][1] * u[2][0]);
}

/** Flips every inverted tetrahedron so all volumes are positive; returns the new model and how many it changed. */
export function orientTetrahedra(model: MdpaModel): { model: MdpaModel; flipped: number; degenerate: number } {
  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);
  let flipped = 0;
  let degenerate = 0;
  const blocks = model.blocks.map((b): EntityBlock => {
    if (b.stride !== 4 || b.vtkCellType !== VtkCellType.TETRA) return b;
    const conn = Int32Array.from(b.connectivity);
    for (let c = 0; c < b.count; c++) {
      const v = tetVolume6(model, idx, conn, c * 4);
      if (v < 0) {
        const t = conn[c * 4 + 1];
        conn[c * 4 + 1] = conn[c * 4 + 2];
        conn[c * 4 + 2] = t;
        flipped++;
      } else if (v === 0) degenerate++;
    }
    return { ...b, connectivity: conn };
  });
  return { model: flipped > 0 ? { ...model, blocks } : model, flipped, degenerate };
}

export function finishCarvedMesh(input: MdpaModel, names: FinishNames = DEFAULT_FINISH_NAMES): FinishResult {
  const messages: string[] = [];
  let model = input;
  const inlet = model.subModelParts.find((p) => p.name === names.inlet);
  if (!inlet) throw new Error(`The carved mesh has no "${names.inlet}" part to tell the fluid side from the body side.`);
  const inletNodes = new Set(inlet.nodeIds);
  const domains = model.subModelParts.filter((p) => p.name.startsWith("MMG_Domain_"));
  if (domains.length === 0) throw new Error("The level-set split produced no domain parts.");
  const fluid = domains.filter((p) => touches(p, inletNodes));
  if (fluid.length !== 1) {
    throw new Error(`Expected exactly one side of the split to touch the inlet, found ${fluid.length}. The body may be open or the distance field may be wrong.`);
  }
  let removedTetrahedra = 0;
  for (const p of domains) {
    if (p === fluid[0]) continue;
    const before = model.blocks.reduce((s, b) => s + (b.stride === 4 ? b.count : 0), 0);
    model = deleteSubModelPart(model, p.path).model;
    removedTetrahedra += before - model.blocks.reduce((s, b) => s + (b.stride === 4 ? b.count : 0), 0);
  }
  // The remesh now keeps SubModelParts that own no entities, so the lattice's
  // empty placeholders ("Fluid", "Body") survive the carve and would block the
  // rename below with a sibling-name collision.
  const isEmptyPart = (p: SubModelPart): boolean =>
    p.nodeIds.length + p.elementIds.length + p.conditionIds.length === 0 && (p.children ?? []).length === 0;
  const dropEmptyNamed = (name: string): void => {
    const empty = model.subModelParts.find((p) => p.name === name && isEmptyPart(p));
    if (empty) model = { ...model, subModelParts: model.subModelParts.filter((p) => p !== empty) };
  };
  dropEmptyNamed(names.fluid);
  dropEmptyNamed(names.body);
  const rename = (from: string, to: string): void => {
    if (!model.subModelParts.some((p) => p.path === from)) return;
    const r = renameSubModelPart(model, from, to);
    if (!r.renamed) throw new Error(`Could not rename "${from}" to "${to}": a part with that name already exists.`);
    model = r.model;
  };
  rename(fluid[0].path, names.fluid);
  rename("MMG_Interface", names.body);
  // What is left of MMG's own labels (the edges where the wall meets a symmetry plane) has no meaning to a solver.
  for (const p of [...model.subModelParts]) {
    if (p.name.startsWith("MMG_")) model = deleteSubModelPart(model, p.path).model;
  }

  // Boundary conditions must be faces of a remaining tetrahedron.
  const faceKey = (a: number, b: number, c: number): string => [a, b, c].sort((x, y) => x - y).join("_");
  const tetFaces = new Set<string>();
  for (const b of model.blocks) {
    if (b.stride !== 4) continue;
    for (let c = 0; c < b.count; c++) {
      const n = [0, 1, 2, 3].map((k) => b.connectivity[c * 4 + k]);
      for (const f of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) tetFaces.add(faceKey(n[f[0]], n[f[1]], n[f[2]]));
    }
  }
  const dangling: number[] = [];
  for (const b of model.blocks) {
    if (b.kind !== "Conditions" || b.stride !== 3) continue;
    for (let c = 0; c < b.count; c++) {
      if (!tetFaces.has(faceKey(b.connectivity[c * 3], b.connectivity[c * 3 + 1], b.connectivity[c * 3 + 2]))) dangling.push(b.entityIds[c]);
    }
  }
  if (dangling.length > 0) {
    model = deleteEntities(model, { Conditions: dangling }).model;
    messages.push(`Removed ${dangling.length} boundary face(s) that lay on the body interior.`);
  }

  // Kratos type names; same-typed blocks keep their separate ids.
  model = {
    ...model,
    blocks: model.blocks.map((b) => {
      if (b.kind === "Elements" && b.stride === 4) return { ...b, name: "Element3D4N" };
      if (b.kind === "Conditions" && b.stride === 3) return { ...b, name: "SurfaceCondition3D3N" };
      return b;
    }),
  };
  const oriented = orientTetrahedra(model);
  model = oriented.model;
  if (oriented.flipped > 0) messages.push(`Reversed ${oriented.flipped} inverted tetrahedra.`);
  return { model, removedTetrahedra, removedConditions: dangling.length, reoriented: oriented.flipped, messages };
}

export interface MeshCheck {
  tetrahedra: number;
  nodes: number;
  inverted: number;
  degenerate: number;
  minVolume: number;
  minAngle: number | undefined;
  maxEdgeRatio: number | undefined;
  maxAspect: number | undefined;
  /** Faces of the boundary that no part of the model names (a gap in the boundary conditions). */
  unnamedBoundaryFaces: number;
  problems: string[];
}

/** Hard checks a solver would trip on, plus the quality numbers worth showing. */
export function checkFluidMesh(model: MdpaModel): MeshCheck {
  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);
  let tets = 0;
  let inverted = 0;
  let degenerate = 0;
  let minVol = Infinity;
  const faceCount = new Map<string, number>();
  const faceKey = (a: number, b: number, c: number): string => [a, b, c].sort((x, y) => x - y).join("_");
  for (const b of model.blocks) {
    if (b.stride !== 4 || b.kind !== "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      tets++;
      const v = tetVolume6(model, idx, b.connectivity, c * 4) / 6;
      if (v < 0) inverted++;
      else if (v === 0) degenerate++;
      if (v < minVol) minVol = v;
      const n = [0, 1, 2, 3].map((k) => b.connectivity[c * 4 + k]);
      for (const f of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
        const key = faceKey(n[f[0]], n[f[1]], n[f[2]]);
        faceCount.set(key, (faceCount.get(key) ?? 0) + 1);
      }
    }
  }
  const named = new Set<string>();
  for (const b of model.blocks) {
    if (b.kind !== "Conditions" || b.stride !== 3) continue;
    for (let c = 0; c < b.count; c++) named.add(faceKey(b.connectivity[c * 3], b.connectivity[c * 3 + 1], b.connectivity[c * 3 + 2]));
  }
  let unnamed = 0;
  for (const [k, n] of faceCount) if (n === 1 && !named.has(k)) unnamed++;
  const problems: string[] = [];
  if (inverted > 0) problems.push(`${inverted} inverted tetrahedra`);
  if (degenerate > 0) problems.push(`${degenerate} zero-volume tetrahedra`);
  if (unnamed > 0) problems.push(`${unnamed} boundary face(s) belong to no boundary condition cell`);
  let minAngle: number | undefined;
  let edgeRatio: number | undefined;
  try {
    const q = computeMeshQuality(model);
    minAngle = q.metrics.find((m) => m.key === "minAngle")?.min;
    edgeRatio = q.metrics.find((m) => m.key === "edgeRatio")?.max;
  } catch {
    // quality is informative; the hard checks above are what gate
  }
  return {
    tetrahedra: tets,
    nodes: model.nodeCount,
    inverted,
    degenerate,
    minVolume: Number.isFinite(minVol) ? minVol : 0,
    minAngle,
    maxEdgeRatio: edgeRatio,
    maxAspect: edgeRatio,
    unnamedBoundaryFaces: unnamed,
    problems,
  };
}
