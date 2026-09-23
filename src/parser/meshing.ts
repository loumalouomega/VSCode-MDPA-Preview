/**
 * meshio++ surface and volume MESHING as in-place, undoable operations —
 * surface remeshing (ACVD), volume generation from a closed surface or volume,
 * and tetrahedral optimization — beside MMG, not replacing it.
 *
 * Pure module (no vscode / DOM). All three ADOPT meshio++'s result through
 * `runAdoptingOp` and then give the produced cells an explicit identity through
 * `inheritCellIdentity` (block, property, parts, cell-field values; exact node-set
 * matches keep their entity ids). What each one is, in the words that distinguish
 * them from MMG and from each other:
 *
 * - **`surfaceRemesh`** — surface REDISTRIBUTION (ACVD clustering): a new
 *   triangulation of the same surface with a chosen vertex count. Every node and
 *   face is new; nothing corresponds.
 * - **`volumeMesh`** — RE-TETRAHEDRALIZATION: a tetrahedral mesh of the volume
 *   enclosed by a closed surface (or of an existing volume), on a lattice with
 *   boundary warping. Not a guaranteed-quality mesher — boundary defects are
 *   reported, not hidden.
 * - **`optimizeVolume`** — FIXED-POINT-SET optimization: 2-3 / 3-2 flips and
 *   vertex relocation on an existing tetrahedral mesh. The node set is
 *   unchanged, so every unchanged tet keeps its identity.
 *
 * Each outcome reports what changed in the terms a solver cares about: element
 * counts, quality, manifoldness, the boundary's deviation from the input, and
 * what identity was carried and how.
 */

import { EntityBlock, MdpaDiagnostic, MdpaModel } from "./types";
import { modelToMeshio } from "./meshioConvert";
import { loadMeshio, MeshioModule } from "./meshio";
import { runAdoptingOp, describeFidelity } from "./adoptOp";
import { inheritCellIdentity } from "./cellInheritance";
import { remapFieldsOntoRemesh } from "./remeshFields";
import { VtkCellType } from "./geometryMap";
import { cellCategory } from "./writers/writerCommon";
import { computeMeshQuality } from "./meshQuality";
import { surfaceDefects } from "./surfaceDefects";
import { extractSkinModel } from "./extractSkin";
import { requireTriangulatedSurface } from "./meshioAdapter";

export type MeshingOutcome =
  | { model: MdpaModel; changed: true; message: string }
  | { model: MdpaModel; changed: false; message: string };

const cells = (m: MdpaModel): number => m.blocks.reduce((s, b) => s + b.count, 0);

function minAngle(m: MdpaModel): number | undefined {
  try {
    const r = computeMeshQuality(m).metrics.find((x) => x.key === "minAngle");
    return r && Number.isFinite(r.min) ? r.min : undefined;
  } catch {
    return undefined;
  }
}

/** Unsigned distance from the new nodes to the OLD surface: the geometric price of the operation. */
async function boundaryDeviation(
  m: MeshioModule,
  oldSurface: MdpaModel,
  newNodes: MdpaModel
): Promise<{ max: number; mean: number; relativeMax: number } | undefined> {
  const mesh = modelToMeshio(oldSurface, [], { dim: 3 });
  try {
    requireTriangulatedSurface(mesh.cells, "reference surface");
  } catch {
    return undefined;
  }
  const pts: number[] = [];
  for (let i = 0; i < newNodes.nodeCount * 3; i++) pts.push(newNodes.coords[i]);
  const d = m.sampleDistance(mesh, pts, "unsigned", 0, "warn");
  let max = 0;
  let sum = 0;
  for (const v of d) {
    const a = Math.abs(v);
    if (a > max) max = a;
    sum += a;
  }
  const b = oldSurface.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  return { max, mean: d.length ? sum / d.length : 0, relativeMax: diag > 0 ? max / diag : 0 };
}

const pct = (x: number): string => `${(100 * x).toPrecision(3)}%`;

function surfaceScopeProblem(model: MdpaModel, op: string): string | undefined {
  if (model.blocks.length === 0) return "The mesh has no cells.";
  if (model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume")) {
    return `${op} works on a triangle surface; this mesh has volume cells. Use File ▸ Export skin… for its boundary, or the volume-meshing operations for a solid.`;
  }
  const bad = model.blocks.filter((b) => b.vtkCellType !== VtkCellType.TRIANGLE);
  if (bad.length === 0) return undefined;
  if (bad.some((b) => b.vtkCellType === VtkCellType.QUAD)) return `${op} needs triangles; ${bad.map((b) => b.name).join(", ")} is not. Run Simplexify first.`;
  return `${op} needs a mesh of linear triangles only; ${bad.map((b) => b.name).join(", ")} is not (lines and points cannot be mixed in).`;
}

// --- surface remeshing --------------------------------------------------------------

export interface SurfaceRemeshParams {
  /** Target number of vertices (default: half the current node count, at least 4). */
  numClusters?: number;
  /** "isotropic" (default), "quadric" (curvature-aware) or "anisotropic". */
  metric?: "isotropic" | "quadric" | "anisotropic";
  /** Size gradation between clusters (0 = uniform). */
  gradation?: number;
  /** Pin the boundary of an open surface (default true). */
  preserveBoundary?: boolean;
  /** Anisotropic metric only: the largest stretch ratio (default 4). */
  maxAnisotropy?: number;
}

export const SURFACE_REMESH_METRICS = ["isotropic", "quadric", "anisotropic"] as const;

export async function surfaceRemeshModel(model: MdpaModel, params: SurfaceRemeshParams = {}, diagnostics: MdpaDiagnostic[] = []): Promise<MeshingOutcome> {
  const problem = surfaceScopeProblem(model, "Surface remeshing");
  if (problem) return { model, changed: false, message: problem };
  const target = Math.floor(params.numClusters ?? Math.max(4, Math.round(model.nodeCount / 2)));
  if (!(target >= 4)) return { model, changed: false, message: "The target vertex count must be at least 4." };
  const metric = params.metric ?? "isotropic";
  if (params.maxAnisotropy !== undefined && metric !== "anisotropic") {
    return { model, changed: false, message: "maxAnisotropy applies to the anisotropic metric only." };
  }
  const before = surfaceDefects(model);
  const beforeAngle = minAngle(model);

  const run = await runAdoptingOp(
    model,
    diagnostics,
    "surfaceRemesh",
    (m, mesh) => m.remesh(mesh, target, -1, 10, 4, 100, 10, metric, params.gradation ?? 0, params.preserveBoundary ?? true, params.maxAnisotropy ?? 4),
    {}
  );
  if (!run) return { model, changed: false, message: "Nothing to remesh." };

  // No correspondence: every cell inherits its context from the nearest source face.
  const inh = inheritCellIdentity(model, run.model, { category: "surface", matchByNodes: false });
  // Nodal fields cross by containing-triangle lookup on the OLD surface; cell fields were inherited above.
  const nodalOnly: MdpaModel = { ...model, fields: model.fields.filter((f) => f.kind === "Nodal") };
  const remapped = await remapFieldsOntoRemesh({ ...inh.model, fields: [] }, nodalOnly, diagnostics);
  const out: MdpaModel = { ...remapped.model, fields: [...remapped.model.fields, ...inh.model.fields.filter((f) => f.kind !== "Nodal")] };

  const m = await loadMeshio();
  const dev = await boundaryDeviation(m, model, out);
  const after = surfaceDefects(out);
  const afterAngle = minAngle(out);
  const parts: string[] = [
    `Remeshed the surface (${metric}): ${cells(model)} → ${cells(out)} faces, ${model.nodeCount} → ${out.nodeCount} nodes.`,
  ];
  if (dev) parts.push(`Deviation from the original surface: max ${dev.max.toPrecision(3)} (${pct(dev.relativeMax)} of the bounding-box diagonal), mean ${dev.mean.toPrecision(3)}.`);
  parts.push(
    `Manifoldness: ${before.boundaryEdges.length} → ${after.boundaryEdges.length} boundary edge(s), ${before.nonManifoldEdges.length} → ${after.nonManifoldEdges.length} non-manifold, ${before.inconsistentFaces.length} → ${after.inconsistentFaces.length} flipped face(s).`
  );
  if (beforeAngle !== undefined && afterAngle !== undefined) parts.push(`Smallest angle ${beforeAngle.toFixed(1)}° → ${afterAngle.toFixed(1)}°.`);
  parts.push(
    `Every face and node is new: ${inh.inherited} face(s) inherited block, property, SubModelPart membership and cell-field values from the NEAREST original face` +
      (inh.orphaned ? ` (${inh.orphaned} had none to inherit from)` : "") +
      `, so a part boundary is resolved at the new resolution.`
  );
  if (remapped.transferred.length) parts.push(`Nodal field(s) mapped by containing-face lookup: ${remapped.transferred.map((t) => t.name).join(", ")}.`);
  for (const d of remapped.dropped) parts.push(`Dropped ${d.name} (${d.reason}).`);
  const fid = describeFidelity({ report: run.report, remap: undefined, sparsened: [] });
  if (fid) parts.push(fid);
  if (model.constraints?.length) parts.push("Constraints were dropped: every node is new, so there is nothing to maintain them against.");
  return { model: out, changed: true, message: parts.join(" ") };
}

// --- volume meshing --------------------------------------------------------------------

export interface VolumeMeshParams {
  /** Lattice cell size in mesh units (exactly one of cellSize / resolution). */
  cellSize?: number;
  /** Lattice cells along x, y, z. */
  resolution?: [number, number, number];
  /** Padding of the lattice around the shape, relative to its size (default 0.1). */
  paddingRelative?: number;
  /** Fraction of a cell the boundary lattice vertices may be warped onto the surface (default 0.35; 0 = exactly watertight, lower quality). */
  warpFraction?: number;
  /** Cap on the generated tetrahedra (default 2 000 000; upstream's own is 20 000 000). */
  maxTets?: number;
  /** Also write the volume's boundary faces as Conditions inheriting the input surface's parts (default true). */
  keepSurface?: boolean;
}

const DEFAULT_MAX_TETS = 2_000_000;

/** A cheap upper estimate of the lattice cells, so a huge request is refused before any wasm runs. */
export function estimateLatticeCells(model: MdpaModel, params: Pick<VolumeMeshParams, "cellSize" | "resolution" | "paddingRelative">): number {
  const b = model.bounds;
  const pad = 1 + 2 * (params.paddingRelative ?? 0.1);
  const ext = [0, 1, 2].map((k) => Math.max(b.max[k] - b.min[k], 1e-12) * pad);
  if (params.resolution) return params.resolution[0] * params.resolution[1] * params.resolution[2];
  const h = params.cellSize ?? 0;
  return h > 0 ? ext.reduce((p, e) => p * Math.max(1, Math.ceil(e / h)), 1) : 0;
}

export async function volumeMeshModel(model: MdpaModel, params: VolumeMeshParams, diagnostics: MdpaDiagnostic[] = []): Promise<MeshingOutcome> {
  if ((params.cellSize === undefined) === (params.resolution === undefined)) {
    return { model, changed: false, message: "Give exactly one of cellSize or resolution." };
  }
  if (params.cellSize !== undefined && !(params.cellSize > 0)) return { model, changed: false, message: "cellSize must be positive." };
  if (params.resolution && !params.resolution.every((n) => Number.isInteger(n) && n >= 1)) return { model, changed: false, message: "resolution must be three positive integers." };
  const hasVolume = model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume");
  if (!hasVolume) {
    const problem = surfaceScopeProblem(model, "Volume meshing");
    if (problem) return { model, changed: false, message: problem };
  }
  const maxTets = params.maxTets ?? DEFAULT_MAX_TETS;
  const estimate = estimateLatticeCells(model, params);
  if (estimate > 20_000_000) {
    return { model, changed: false, message: `The lattice would have about ${estimate.toExponential(2)} cells (over 2e7). Use a larger cellSize.` };
  }

  const srcSurface = hasVolume ? undefined : model;
  const run = await runAdoptingOp(
    model,
    diagnostics,
    "volumeMesh",
    (m, mesh) =>
      m.remeshVolume(mesh, params.resolution ?? null, params.cellSize ?? 0, null, 0, params.paddingRelative ?? 0.1, 2e7, maxTets, params.warpFraction ?? 0.35, "pseudonormal", "warn"),
    {}
  );
  if (!run) return { model, changed: false, message: "Nothing to mesh." };
  const r = run.result;
  if (r.numTets === 0) return { model, changed: false, message: "No tetrahedra were generated: the shape may not enclose a volume at this lattice size." };

  // Tets inherit from the nearest source VOLUME cell when there is one; from a bare surface they get one new block.
  let out: MdpaModel;
  let inheritedNote = "";
  if (hasVolume) {
    const inh = inheritCellIdentity(model, run.model, { category: "volume", matchByNodes: false });
    out = inh.model;
    inheritedNote = `${inh.inherited} tetrahedra inherited block, property, SubModelPart membership and element-field values from the nearest original volume cell.`;
  } else {
    const dominant = dominantProperty(model.blocks);
    const tetBlocks = run.model.blocks.filter((b) => cellCategory(b.vtkCellType) === "volume");
    const merged = mergeBlocks(tetBlocks, "Element3D4N", "Elements", dominant);
    out = { ...run.model, blocks: merged ? [merged] : [], fields: run.model.fields.filter((f) => f.kind === "Nodal"), subModelParts: [] };
    inheritedNote = `The ${r.numTets} tetrahedra form one new "Element3D4N" block (property ${dominant}).`;
  }

  // The volume's boundary: Conditions inheriting block-free identity, property and PARTS from the nearest source SURFACE face.
  let boundaryNote = "";
  if ((params.keepSurface ?? true) && hasVolume === false) {
    const skin = extractSkinModel(out);
    if (skin.faces > 0) {
      const inh = inheritCellIdentity(model, skin.model, { category: "surface", matchByNodes: false, targetKind: "Conditions" });
      const condBlocks = inh.model.blocks.filter((b) => b.kind === "Conditions");
      // Re-key the skin faces past everything already in `out`, and carry their parts across.
      out = attachBoundary(out, condBlocks, inh.model.subModelParts, model.subModelParts);
      boundaryNote = `${inh.inherited} boundary face(s) written as Conditions inheriting property and SubModelPart membership from the nearest input face.`;
    }
  }

  const m = await loadMeshio();
  const skinNow = extractSkinModel(out);
  const dev = srcSurface && skinNow.faces > 0 ? await boundaryDeviation(m, srcSurface, skinNow.model) : undefined;
  const parts: string[] = [
    `Generated ${r.numTets} tetrahedra on ${out.nodeCount} nodes (retetrahedralization, lattice ${params.cellSize !== undefined ? `cell ${params.cellSize}` : params.resolution!.join("×")}).`,
  ];
  if (dev) parts.push(`Boundary deviation from the input surface: max ${dev.max.toPrecision(3)} (${pct(dev.relativeMax)} of the diagonal), mean ${dev.mean.toPrecision(3)}.`);
  const angle = minAngle(out);
  if (angle !== undefined) parts.push(`Smallest dihedral/face angle ${angle.toFixed(1)}°.`);
  parts.push(`${r.numVerticesWarped} boundary vertex(es) warped onto the surface, ${r.numTetsRejected} candidate tetrahedra rejected${r.numNonManifoldEdges > 0 ? `, ${r.numNonManifoldEdges} non-manifold edge(s) in the result` : ""}.`);
  if (r.numNonManifoldEdges > 0 || (params.warpFraction ?? 0.35) > 0) {
    parts.push("Lattice-based generation makes no boundary-quality guarantee: inspect the boundary before solving (warpFraction 0 gives an exactly watertight boundary of lower quality).");
  }
  if (inheritedNote) parts.push(inheritedNote);
  if (boundaryNote) parts.push(boundaryNote);
  if (model.constraints?.length) parts.push("Constraints were dropped: every node is new.");
  return { model: out, changed: true, message: parts.join(" ") };
}

function dominantProperty(blocks: EntityBlock[]): number {
  const n = new Map<number, number>();
  let best = 0;
  let bestN = 0;
  for (const b of blocks) for (const p of b.propertyIds ?? []) {
    const c = (n.get(p) ?? 0) + 1;
    n.set(p, c);
    if (c > bestN) {
      best = p;
      bestN = c;
    }
  }
  return best;
}

function mergeBlocks(blocks: EntityBlock[], name: string, kind: EntityBlock["kind"], property: number): EntityBlock | undefined {
  if (blocks.length === 0) return undefined;
  const ids: number[] = [];
  const conn: number[] = [];
  for (const b of blocks) {
    ids.push(...b.entityIds);
    conn.push(...b.connectivity);
  }
  return {
    kind,
    name,
    vtkCellType: blocks[0].vtkCellType,
    count: ids.length,
    stride: blocks[0].stride,
    entityIds: Int32Array.from(ids),
    propertyIds: property !== 0 ? Int32Array.from({ length: ids.length }, () => property) : undefined,
    connectivity: Int32Array.from(conn),
  };
}

/** Appends the boundary Conditions to `out` (ids past everything present) and builds the parts they inherit. */
function attachBoundary(out: MdpaModel, condBlocks: EntityBlock[], skinParts: MdpaModel["subModelParts"], sourceParts: MdpaModel["subModelParts"]): MdpaModel {
  let next = 0;
  for (const b of out.blocks) if (b.kind === "Conditions") for (const id of b.entityIds) next = Math.max(next, id);
  next++;
  const remap = new Map<number, number>();
  const blocks = condBlocks.map((b) => {
    const ids = Int32Array.from(b.entityIds, (id) => {
      const fresh = next++;
      remap.set(id, fresh);
      return fresh;
    });
    return { ...b, entityIds: ids };
  });
  // Parts: the input's tree, holding the boundary conditions that inherited each one, and the nodes they use.
  const byPath = new Map<string, MdpaModel["subModelParts"][number]>();
  const walk = (ps: MdpaModel["subModelParts"]): void => ps.forEach((p) => { byPath.set(p.path, p); walk(p.children); });
  walk(skinParts);
  const present = new Set<number>(out.nodeIds);
  const build = (p: MdpaModel["subModelParts"][number]): MdpaModel["subModelParts"][number] => {
    const inherited = byPath.get(p.path);
    const cond = inherited ? [...inherited.conditionIds].map((id) => remap.get(id)).filter((v): v is number => v !== undefined) : [];
    const nodeSet = new Set<number>(inherited ? inherited.nodeIds : []);
    return {
      ...p,
      nodeIds: Int32Array.from([...nodeSet].filter((id) => present.has(id)).sort((a, b) => a - b)),
      elementIds: new Int32Array(0),
      conditionIds: Int32Array.from(cond.sort((a, b) => a - b)),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      children: p.children.map(build),
    };
  };
  return { ...out, blocks: [...out.blocks, ...blocks], subModelParts: sourceParts.map(build) };
}

// --- tetrahedral optimization -------------------------------------------------------------

export interface OptimizeVolumeParams {
  maxIterations?: number;
  /** Relocate interior vertices (default true). */
  relocate?: boolean;
  /** Apply 2-3 / 3-2 face flips (default true). */
  flip?: boolean;
  /** Pin the boundary (default true). */
  preserveBoundary?: boolean;
  /** Stop when an iteration improves the worst quality by less than this (default 1e-6). */
  minImprovement?: number;
}

export async function optimizeVolumeModel(model: MdpaModel, params: OptimizeVolumeParams = {}, diagnostics: MdpaDiagnostic[] = []): Promise<MeshingOutcome> {
  const elementBlocks = model.blocks.filter((b) => b.kind === "Elements");
  if (elementBlocks.length === 0) return { model, changed: false, message: "The mesh has no Elements to optimize." };
  const notTet = elementBlocks.filter((b) => b.vtkCellType !== VtkCellType.TETRA);
  if (notTet.length > 0) {
    return {
      model,
      changed: false,
      message: `Tetrahedral optimization needs a mesh whose Elements are all linear tetrahedra; ${notTet.map((b) => b.name).join(", ")} is not. Run Simplexify (or Quadratic → Linear) first.`,
    };
  }
  const tets = elementBlocks;
  const aside = model.blocks.filter((b) => b.kind !== "Elements");
  // Upstream is fed ONLY the tetrahedra: boundary conditions ride aside and are re-attached — the node
  // set does not change, so they stay valid.
  const tetModel: MdpaModel = { ...model, blocks: tets, subModelParts: [], constraints: undefined, fields: model.fields.filter((f) => f.kind === "Nodal") };
  const beforeAngle = minAngle(model);
  const run = await runAdoptingOp(
    tetModel,
    diagnostics,
    "optimizeVolume",
    (m, mesh) => m.optimizeVolume(mesh, params.maxIterations ?? 10, params.relocate ?? true, params.flip ?? true, params.preserveBoundary ?? true, params.minImprovement ?? 1e-6),
    {}
  );
  if (!run) return { model, changed: false, message: "Nothing to optimize." };
  const r = run.result;
  if (r.numFlips === 0 && r.numVerticesMoved === 0) {
    return { model, changed: false, message: `Nothing to improve (worst tetrahedron quality ${r.minQualityBefore.toPrecision(3)}).` };
  }
  // Points are unchanged (a flip or a relocation never adds or removes one), so node ids came back through
  // the carriers and every UNCHANGED tetrahedron is recognised by its node set.
  const inh = inheritCellIdentity({ ...model, blocks: tets }, { ...run.model, constraints: model.constraints }, { category: "volume", matchByNodes: true });
  const out: MdpaModel = {
    ...inh.model,
    blocks: [...inh.model.blocks, ...aside],
    // Fields the boundary conditions carried, and everything else about the untouched scope, come back unchanged.
    fields: [...inh.model.fields.filter((f) => f.kind !== "Conditional"), ...model.fields.filter((f) => f.kind === "Conditional")],
    constraints: model.constraints,
    subModelParts: inh.model.subModelParts.map((p) => p),
  };
  const afterAngle = minAngle(out);
  const parts: string[] = [
    `Optimized ${r.numTets} tetrahedra: ${r.numFlips} flip(s) (${r.num23Flips} 2-3, ${r.num32Flips} 3-2), ${r.numVerticesMoved} vertex(es) relocated. ` +
      `Worst tetrahedron quality ${r.minQualityBefore.toPrecision(3)} → ${r.minQualityAfter.toPrecision(3)}.`,
  ];
  if (beforeAngle !== undefined && afterAngle !== undefined) parts.push(`Smallest angle ${beforeAngle.toFixed(1)}° → ${afterAngle.toFixed(1)}°.`);
  parts.push(
    `The node set is unchanged, so ${inh.matched} of ${r.numTets} tetrahedra kept their id, block, property, parts and element-field values; ${inh.inherited} changed by a flip took a new id and inherited context from the nearest original tetrahedron.` +
      (params.preserveBoundary ?? true ? " The boundary is pinned." : "")
  );
  return { model: out, changed: true, message: parts.join(" ") };
}

