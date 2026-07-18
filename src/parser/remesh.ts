/**
 * MMG remeshing (via the @loumalouomega/mmg-wasm WebAssembly build of MMG
 * v5.8.0): isotropic mesh adaptation and level-set discretization for the
 * Mesh Modification sidebar. Pure module apart from the wasm package itself —
 * no vscode / DOM / vtk.js imports so it stays Node-testable.
 *
 * Module selection mirrors MMG's own split: tetrahedral volumes → mmg3d
 * (triangles/quads/edges become boundary entities, prisms pass through
 * unremeshed), triangulated surfaces → mmgs, planar triangulations (+quads) →
 * mmg2d. Hexes, pyramids, quadratic cells and point clouds cannot be remeshed.
 *
 * Block and SubModelPart survival: MMG carries one integer "ref" per entity
 * through the remesh, so each input cell is tagged with a dense ref encoding
 * its (block, SubModelPart-membership) signature and the output mesh is
 * regrouped from the returned refs. Node ids and entity ids are freshly
 * renumbered (the mesh is entirely new); SubModelPart node lists are rebuilt
 * from the connectivity of their surviving cells, and nodal/elemental field
 * data cannot be carried across (dropped with a warning).
 */

import { EntityBlock, EntityKind, MdpaModel, SubModelPart } from "./types";
import { VtkCellType as C } from "./geometryMap";
import { finalizeModel } from "./modelBuilder";
import { computeMeshSize } from "./meshSize";
import { parseSizeExpr, CompiledExpr } from "./sizeExpr";
import initialize, { Mmg, MmgHandles, SolHandle } from "@loumalouomega/mmg-wasm";

// --- wasm loading -------------------------------------------------------------

let mmgInitOptions: Record<string, unknown> = {};
let mmgPromise: Promise<Mmg> | undefined;

/**
 * Where MMG's stdout/stderr goes while a run is in flight (Emscripten `print`
 * overrides are fixed at initialize time, so they route through this mutable
 * hook). Runs are sequential per thread — the providers guard against
 * concurrent ops and the worker executes one op per instance.
 */
let printListener: ((line: string) => void) | undefined;

/**
 * Injects Emscripten module overrides used on first initialization. The
 * bundled extension host passes `{ wasmBinary }` because the loader's own
 * file lookup breaks once mmg.cjs is bundled away from its package directory;
 * plain Node (tests) needs nothing.
 */
export function configureMmg(options: Record<string, unknown>): void {
  mmgInitOptions = options;
}

function getMmg(): Promise<Mmg> {
  if (!mmgPromise) {
    mmgPromise = initialize({
      print: (line: string) => printListener?.(line),
      printErr: (line: string) => printListener?.(line),
      ...mmgInitOptions,
    });
  }
  return mmgPromise;
}

/** Reports one human-readable progress line (MMG phase output + our stages). */
export type MmgProgress = (message: string) => void;

/** Cleans an MMG log line for the progress UI; returns undefined for noise. */
function progressLine(line: string): string | undefined {
  const t = line.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.startsWith("&") || t.startsWith("git ") || t.includes("MODULE MMG")) return undefined;
  return t.replace(/^--\s*/, "");
}

// --- public op parameter/result shapes -----------------------------------------

export type MmgModuleChoice = "auto" | "mmg3d" | "mmgs" | "mmg2d";

export interface RemeshCommonParams {
  hmin?: number;
  hmax?: number;
  hausd?: number;
  hgrad?: number;
  module?: MmgModuleChoice;
}

/** A per-SubModelPart sizing-expression override (see RemeshParams.sizeParts). */
export interface SizePartOverride {
  /** SubModelPart path (`Parent/Child`); its nodes use `expr` instead of the global one. */
  path: string;
  /** A sizeExpr formula, evaluated per node (same variable scope as the global expr). */
  expr: string;
}

export interface RemeshParams extends RemeshCommonParams {
  /**
   * factor: metric = local edge size × factor; hsiz: uniform target size;
   * optimize: size-preserving quality pass; expr: per-node target size from a
   * user formula of the nodal size `h`, the global NODAL_H statistics
   * (mean/std/min/max/median/q1/q3/iqr) and the coordinates x,y,z.
   */
  mode: "factor" | "hsiz" | "optimize" | "expr";
  factor?: number;
  hsiz?: number;
  /** Global sizing expression (expr mode); evaluated at every node. */
  sizeExpr?: string;
  /** Optional per-SubModelPart expression overrides (expr mode; first match wins). */
  sizeParts?: SizePartOverride[];
  /** Sharp-feature detection threshold in degrees (MMG default 45; 0 disables detection). */
  angleDetection?: number;
  nosurf?: boolean;
  noinsert?: boolean;
  noswap?: boolean;
  nomove?: boolean;
}

export interface LevelsetParams extends RemeshCommonParams {
  /** Nodal FieldData variable holding φ (vector fields use their magnitude). */
  variable: string;
  isovalue?: number;
  /** mmg3d only: split boundary surfaces without splitting the volume domains. */
  isosurf?: boolean;
}

export interface RemeshResult {
  model: MdpaModel;
  noop?: boolean;
  message: string;
}

// --- cell staging ---------------------------------------------------------------

type MmgKind = "mmg3d" | "mmgs" | "mmg2d";
type Cat = "tets" | "tris" | "quads" | "edges" | "prisms";

const CAT_OF_TYPE: Partial<Record<number, Cat>> = {
  [C.TETRA]: "tets",
  [C.TRIANGLE]: "tris",
  [C.QUAD]: "quads",
  [C.LINE]: "edges",
  [C.WEDGE]: "prisms",
};

const CAT_STRIDE: Record<Cat, number> = { tets: 4, tris: 3, quads: 4, edges: 2, prisms: 6 };

const CAT_EDGES: Record<Cat, number[][]> = {
  edges: [[0, 1]],
  tris: [[0, 1], [1, 2], [2, 0]],
  quads: [[0, 1], [1, 2], [2, 3], [3, 0]],
  tets: [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
  prisms: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]],
};

interface RefInfo {
  /** Original block the tagged cells came from (undefined for MMG-created refs). */
  block: EntityBlock;
  smpPaths: string[];
}

interface StagedCat {
  /** 1-based local vertex indices, CAT_STRIDE[cat] per cell. */
  conn: number[];
  refs: number[];
}

interface Staged {
  kind: MmgKind;
  np: number;
  /** xyz per local vertex (model coords are Float32; MMG wants doubles). */
  coords: Float64Array;
  /** local index → original node id (for level-set field lookup). */
  origIds: Int32Array;
  cats: Record<Cat, StagedCat>;
  refInfo: Map<number, RefInfo>;
  maxRef: number;
  /** z of the plane for mmg2d (restored on output). */
  z0: number;
  warnings: string[];
}

/** Depth-first per-kind entity-id → SubModelPart-path membership lookup. */
function smpMembership(parts: SubModelPart[]): Record<EntityKind, Map<number, string[]>> {
  const out: Record<EntityKind, Map<number, string[]>> = {
    Elements: new Map(),
    Conditions: new Map(),
    Geometries: new Map(),
  };
  const add = (map: Map<number, string[]>, ids: Int32Array, path: string) => {
    for (const id of ids) {
      const list = map.get(id);
      if (list) list.push(path);
      else map.set(id, [path]);
    }
  };
  const walk = (part: SubModelPart) => {
    add(out.Elements, part.elementIds, part.path);
    add(out.Conditions, part.conditionIds, part.path);
    add(out.Geometries, part.geometryIds, part.path);
    for (const child of part.children) walk(child);
  };
  for (const p of parts) walk(p);
  return out;
}

const UNSUPPORTED_MSG =
  "MMG remeshes linear tetrahedral, triangular (+quad) and edge meshes only";

/**
 * Classifies the model, picks the MMG module, compacts the node set to the
 * staged cells' vertices and tags every cell with a (block, SubModelPart
 * signature) ref. Returns a string error message when the mesh is ineligible.
 */
function stageModel(model: MdpaModel, choice: MmgModuleChoice, refBase = 1): Staged | string {
  const warnings: string[] = [];
  const staged: { block: EntityBlock; cat: Cat }[] = [];
  for (const block of model.blocks) {
    const cat = block.vtkCellType !== undefined ? CAT_OF_TYPE[block.vtkCellType] : undefined;
    if (cat && block.stride === CAT_STRIDE[cat]) {
      staged.push({ block, cat });
    } else if (block.vtkCellType === C.VERTEX) {
      warnings.push(`Dropped point block "${block.name}" (${block.count} vertex cell(s)).`);
    } else {
      return `${UNSUPPORTED_MSG} — block "${block.name}" is not remeshable.`;
    }
  }
  const catCount = (cat: Cat) =>
    staged.reduce((n, s) => n + (s.cat === cat ? s.block.count : 0), 0);
  const nTets = catCount("tets");
  const nTris = catCount("tris");
  const nQuads = catCount("quads");
  const nPrisms = catCount("prisms");
  if (nTets + nTris === 0) {
    return `${UNSUPPORTED_MSG} — the mesh has no tetrahedra or triangles.`;
  }

  // Compact the node set to the staged cells' vertices (MMG gets no orphans).
  const idToModel = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idToModel.set(model.nodeIds[i], i);
  const localOf = new Map<number, number>(); // node id -> 1-based local index
  const localIds: number[] = [];
  for (const { block } of staged) {
    for (const id of block.connectivity) {
      if (!localOf.has(id)) {
        localOf.set(id, localIds.length + 1);
        localIds.push(id);
      }
    }
  }
  const np = localIds.length;
  const coords = new Float64Array(np * 3);
  let zMin = Infinity, zMax = -Infinity;
  let diag = 0;
  for (let i = 0; i < np; i++) {
    const m = idToModel.get(localIds[i]);
    if (m === undefined) return `Node ${localIds[i]} is referenced by a cell but not defined.`;
    coords[i * 3] = model.coords[m * 3];
    coords[i * 3 + 1] = model.coords[m * 3 + 1];
    coords[i * 3 + 2] = model.coords[m * 3 + 2];
    if (coords[i * 3 + 2] < zMin) zMin = coords[i * 3 + 2];
    if (coords[i * 3 + 2] > zMax) zMax = coords[i * 3 + 2];
  }
  {
    const { min, max } = model.bounds;
    diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }
  const planar = nTets === 0 && nPrisms === 0 && zMax - zMin <= Math.max(diag, 1) * 1e-9;

  let kind: MmgKind;
  if (choice === "auto" || choice === undefined) {
    kind = nTets > 0 ? "mmg3d" : planar ? "mmg2d" : "mmgs";
  } else {
    kind = choice;
  }
  if (kind === "mmg3d" && nTets === 0) {
    return "mmg3d needs a tetrahedral mesh — use the surface (mmgs) or planar (mmg2d) module.";
  }
  if (kind !== "mmg3d" && nTets > 0) {
    return "The mesh contains tetrahedra — only mmg3d can remesh it.";
  }
  if (kind === "mmg2d" && !planar) {
    return "mmg2d needs a planar mesh (all nodes on one z = const plane).";
  }
  if (kind === "mmgs" && nQuads > 0) {
    return "mmgs remeshes triangle-only surfaces — quadrilaterals are not supported off-plane.";
  }

  // Tag cells: one dense ref per (block, SubModelPart membership) signature.
  const membership = smpMembership(model.subModelParts);
  const refInfo = new Map<number, RefInfo>();
  const refOfSig = new Map<string, number>();
  let nextRef = refBase;
  const cats: Record<Cat, StagedCat> = {
    tets: { conn: [], refs: [] },
    tris: { conn: [], refs: [] },
    quads: { conn: [], refs: [] },
    edges: { conn: [], refs: [] },
    prisms: { conn: [], refs: [] },
  };
  for (const { block, cat } of staged) {
    const stride = block.stride;
    const kindMap = membership[block.kind];
    const target = cats[cat];
    for (let c = 0; c < block.count; c++) {
      const entityId = block.entityIds[c];
      const paths = (kindMap.get(entityId) ?? []).slice().sort();
      const sig = `${model.blocks.indexOf(block)} ${paths.join(" ")}`;
      let ref = refOfSig.get(sig);
      if (ref === undefined) {
        ref = nextRef++;
        refOfSig.set(sig, ref);
        refInfo.set(ref, { block, smpPaths: paths });
      }
      for (let k = 0; k < stride; k++) {
        const local = localOf.get(block.connectivity[c * stride + k]);
        target.conn.push(local ?? 0);
      }
      target.refs.push(ref);
    }
  }

  return {
    kind,
    np,
    coords,
    origIds: Int32Array.from(localIds),
    cats,
    refInfo,
    maxRef: nextRef - 1,
    z0: np > 0 ? zMin : 0,
    warnings,
  };
}

// --- metric ---------------------------------------------------------------------

/** Per-vertex current size = mean length of the incident staged-cell edges. */
function localEdgeSizes(s: Staged): Float64Array {
  const sum = new Float64Array(s.np);
  const cnt = new Float64Array(s.np);
  for (const cat of Object.keys(s.cats) as Cat[]) {
    const { conn } = s.cats[cat];
    const stride = CAT_STRIDE[cat];
    const edges = CAT_EDGES[cat];
    for (let c = 0; c < conn.length / stride; c++) {
      for (const [a, b] of edges) {
        const ia = conn[c * stride + a] - 1;
        const ib = conn[c * stride + b] - 1;
        const dx = s.coords[ia * 3] - s.coords[ib * 3];
        const dy = s.coords[ia * 3 + 1] - s.coords[ib * 3 + 1];
        const dz = s.coords[ia * 3 + 2] - s.coords[ib * 3 + 2];
        const len = Math.hypot(dx, dy, dz);
        sum[ia] += len; cnt[ia]++;
        sum[ib] += len; cnt[ib]++;
      }
    }
  }
  const sizes = new Float64Array(s.np);
  for (let i = 0; i < s.np; i++) sizes[i] = cnt[i] > 0 ? sum[i] / cnt[i] : 0;
  // Isolated vertices (none expected after compaction) get the global mean.
  let mean = 0, n = 0;
  for (let i = 0; i < s.np; i++) if (sizes[i] > 0) { mean += sizes[i]; n++; }
  mean = n > 0 ? mean / n : 1;
  for (let i = 0; i < s.np; i++) if (sizes[i] === 0) sizes[i] = mean;
  return sizes;
}

/** Node ids belonging to the SubModelPart at `path` and its whole subtree. */
function partNodeSet(parts: SubModelPart[], path: string): Set<number> | undefined {
  const find = (list: SubModelPart[]): SubModelPart | undefined => {
    for (const p of list) {
      if (p.path === path) return p;
      const c = find(p.children);
      if (c) return c;
    }
    return undefined;
  };
  const root = find(parts);
  if (!root) return undefined;
  const out = new Set<number>();
  const walk = (p: SubModelPart) => {
    for (const id of p.nodeIds) out.add(id);
    for (const c of p.children) walk(c);
  };
  walk(root);
  return out;
}

/**
 * Builds the per-vertex MMG target-size metric for the `expr` mode by evaluating
 * the user's sizing expression at every staged node. The scope exposes the
 * node's nodal size `h` (Kratos NODAL_H), the *global* NODAL_H statistics
 * (mean/std/min/max/median/q1/q3/iqr — always whole-mesh, even inside a per-part
 * override), and the node coordinates x,y,z. Per-SubModelPart overrides swap the
 * expression (not the stats) for nodes of the named part; the first matching
 * override in `sizeParts` wins. A non-finite / non-positive result at a node
 * keeps that node's current size and is counted in a warning.
 *
 * Membership is resolved on the *input* mesh (via `origIds`), because MMG
 * renumbers nodes — there is no way to map an override to the output mesh.
 * Throws (fast, before MMG runs) if any expression fails to parse.
 */
function expressionSizes(
  s: Staged,
  model: MdpaModel,
  params: RemeshParams
): { sizes: Float64Array; warnings: string[] } {
  const warnings: string[] = [];
  const globalExpr = parseSizeExpr(params.sizeExpr && params.sizeExpr.trim() ? params.sizeExpr : "h");

  // Per-node nodal size (NODAL_H), falling back to the local mean-edge size for
  // any staged vertex NODAL_H did not cover (e.g. a lone edge cell).
  const local = localEdgeSizes(s);
  const ms = computeMeshSize(model);
  const hById = new Map<number, number>();
  for (let i = 0; i < ms.nodalH.ids.length; i++) hById.set(ms.nodalH.ids[i], ms.nodalH.values[i]);
  const st = ms.nodalStats;

  // Compile each override once and resolve its node membership on the input mesh.
  const overrides: { nodes: Set<number>; expr: CompiledExpr }[] = [];
  for (const o of params.sizeParts ?? []) {
    const nodes = partNodeSet(model.subModelParts, o.path);
    if (!nodes) {
      warnings.push(`Per-part sizing skipped: SubModelPart "${o.path}" not found.`);
      continue;
    }
    overrides.push({ nodes, expr: parseSizeExpr(o.expr) });
  }

  const sizes = new Float64Array(s.np);
  const scope: Record<string, number> = {
    h: 0, x: 0, y: 0, z: 0,
    mean: st.mean, std: st.std, min: st.min, max: st.max,
    median: st.median, q1: st.q1, q3: st.q3, iqr: st.iqr,
  };
  let fallbacks = 0;
  for (let i = 0; i < s.np; i++) {
    const origId = s.origIds[i];
    const h = hById.get(origId) ?? local[i];
    scope.h = h;
    scope.x = s.coords[i * 3];
    scope.y = s.coords[i * 3 + 1];
    scope.z = s.coords[i * 3 + 2];
    let expr = globalExpr;
    for (const o of overrides) {
      if (o.nodes.has(origId)) { expr = o.expr; break; }
    }
    const v = expr.evaluate(scope);
    if (Number.isFinite(v) && v > 0) {
      sizes[i] = v;
    } else {
      sizes[i] = h;
      fallbacks++;
    }
  }
  if (fallbacks > 0) {
    warnings.push(
      `${fmt(fallbacks)} node(s) evaluated to a non-positive/invalid size and kept their current size.`
    );
  }
  return { sizes, warnings };
}

// --- run + harvest ----------------------------------------------------------------

interface Harvest {
  np: number;
  coords: Float64Array; // xyz per vertex
  cats: Partial<Record<Cat, { conn: Int32Array; refs: Int32Array }>>;
}

/**
 * Describes the staged mesh to the selected MMG module, applies parameters,
 * runs `entry` and harvests the result. Frees the MMG structures in all cases.
 */
async function runMmg(
  s: Staged,
  applyParams: (mmg: Mmg, mod: MmgAny, h: MmgHandles) => void,
  entry: (mod: MmgAny, h: MmgHandles) => number,
  needLevelset: boolean,
  onProgress?: MmgProgress
): Promise<{ harvest: Harvest; lowFailure: boolean }> {
  const mmg = await getMmg();
  const mod = mmg[s.kind] as unknown as MmgAny;
  const h = mod.init(needLevelset ? { levelset: true } : undefined);
  if (onProgress) {
    printListener = (line) => {
      const msg = progressLine(line);
      if (msg) onProgress(msg);
    };
  }
  try {
    const nt = s.cats.tris.refs.length;
    const na = s.cats.edges.refs.length;
    const nquad = s.cats.quads.refs.length;
    if (s.kind === "mmg3d") {
      mod.setMeshSize(h.mesh, s.np, s.cats.tets.refs.length, s.cats.prisms.refs.length, nt, nquad, na);
      mod.setVertices(h.mesh, s.coords, null);
      mod.setTetrahedra(h.mesh, s.cats.tets.conn, s.cats.tets.refs);
      if (s.cats.prisms.refs.length) mod.setPrisms(h.mesh, s.cats.prisms.conn, s.cats.prisms.refs);
      if (nt) mod.setTriangles(h.mesh, s.cats.tris.conn, s.cats.tris.refs);
      if (nquad) mod.setQuadrilaterals(h.mesh, s.cats.quads.conn, s.cats.quads.refs);
      if (na) mod.setEdges(h.mesh, s.cats.edges.conn, s.cats.edges.refs);
    } else if (s.kind === "mmgs") {
      mod.setMeshSize(h.mesh, s.np, nt, na);
      mod.setVertices(h.mesh, s.coords, null);
      mod.setTriangles(h.mesh, s.cats.tris.conn, s.cats.tris.refs);
      if (na) mod.setEdges(h.mesh, s.cats.edges.conn, s.cats.edges.refs);
    } else {
      mod.setMeshSize(h.mesh, s.np, nt, nquad, na);
      const xy = new Float64Array(s.np * 2);
      for (let i = 0; i < s.np; i++) {
        xy[i * 2] = s.coords[i * 3];
        xy[i * 2 + 1] = s.coords[i * 3 + 1];
      }
      mod.setVertices(h.mesh, xy, null);
      if (nt) mod.setTriangles(h.mesh, s.cats.tris.conn, s.cats.tris.refs);
      if (nquad) mod.setQuadrilaterals(h.mesh, s.cats.quads.conn, s.cats.quads.refs);
      if (na) mod.setEdges(h.mesh, s.cats.edges.conn, s.cats.edges.refs);
    }
    // Verbose output feeds the progress UI; silent otherwise.
    mod.setIparameter(h.mesh, h.met, mod.IPARAM_verbose, onProgress ? 3 : -1);
    applyParams(mmg, mod, h);

    onProgress?.(`Running ${s.kind} on ${fmt(s.np)} nodes…`);
    const code = entry(mod, h);
    onProgress?.("Collecting the remeshed model…");
    const lowFailure = code === mmg.MMG5_LOWFAILURE;
    if (code !== mmg.MMG5_SUCCESS && !lowFailure) {
      throw new Error(`MMG could not complete the operation (return code ${code}).`);
    }
    // A failed/aborted MMG run can leave the structure without a usable mesh;
    // harvesting it would surface as cryptic getter errors.
    const checkNp = (np: unknown): number => {
      if (typeof np !== "number" || !Number.isFinite(np) || np <= 0) {
        throw new Error("MMG returned an empty mesh.");
      }
      return np;
    };

    const harvest: Harvest = { np: 0, coords: new Float64Array(0), cats: {} };
    if (s.kind === "mmg3d") {
      const size = mod.getMeshSize(h.mesh) as { np: number; ne: number; nprism: number; nt: number; nquad: number; na: number };
      checkNp(size.np);
      harvest.np = size.np;
      harvest.coords = mod.getVertices(h.mesh, size.np).vertices;
      if (size.ne) harvest.cats.tets = pick(mod.getTetrahedra(h.mesh, size.ne), "tetra");
      if (size.nprism) harvest.cats.prisms = pick(mod.getPrisms(h.mesh, size.nprism), "prisms");
      if (size.nt) harvest.cats.tris = pick(mod.getTriangles(h.mesh, size.nt), "tria");
      if (size.nquad) harvest.cats.quads = pick(mod.getQuadrilaterals(h.mesh, size.nquad), "quads");
      if (size.na) harvest.cats.edges = pick(mod.getEdges(h.mesh, size.na), "edges");
    } else if (s.kind === "mmgs") {
      const size = mod.getMeshSize(h.mesh) as { np: number; nt: number; na: number };
      checkNp(size.np);
      harvest.np = size.np;
      harvest.coords = mod.getVertices(h.mesh, size.np).vertices;
      if (size.nt) harvest.cats.tris = pick(mod.getTriangles(h.mesh, size.nt), "tria");
      if (size.na) harvest.cats.edges = pick(mod.getEdges(h.mesh, size.na), "edges");
    } else {
      const size = mod.getMeshSize(h.mesh) as { np: number; nt: number; nquad: number; na: number };
      checkNp(size.np);
      harvest.np = size.np;
      const xy = mod.getVertices(h.mesh, size.np).vertices;
      const xyz = new Float64Array(size.np * 3);
      for (let i = 0; i < size.np; i++) {
        xyz[i * 3] = xy[i * 2];
        xyz[i * 3 + 1] = xy[i * 2 + 1];
        xyz[i * 3 + 2] = s.z0;
      }
      harvest.coords = xyz;
      if (size.nt) harvest.cats.tris = pick(mod.getTriangles(h.mesh, size.nt), "tria");
      if (size.nquad) harvest.cats.quads = pick(mod.getQuadrilaterals(h.mesh, size.nquad), "quadra");
      if (size.na) harvest.cats.edges = pick(mod.getEdges(h.mesh, size.na), "edges");
    }
    return { harvest, lowFailure };
  } finally {
    printListener = undefined;
    mod.free(h);
  }
}

/**
 * The three module namespaces share the call shapes used here but differ in
 * arity (setMeshSize) and getter result keys, so this file talks to them
 * through one loose signature instead of three near-identical branches.
 */
interface MmgAny {
  init(options?: { levelset?: boolean }): MmgHandles;
  free(h: MmgHandles): void;
  setMeshSize(...args: number[]): void;
  setVertices(mesh: number, v: Float64Array, refs: null): void;
  setTetrahedra(mesh: number, t: number[], refs: number[]): void;
  setPrisms(mesh: number, p: number[], refs: number[]): void;
  setTriangles(mesh: number, t: number[], refs: number[]): void;
  setQuadrilaterals(mesh: number, q: number[], refs: number[]): void;
  setEdges(mesh: number, e: number[], refs: number[]): void;
  setSolSize(mesh: number, sol: number, typEntity: number, np: number, typSol: number): void;
  setScalarSols(sol: number, s: Float64Array): void;
  setIparameter(mesh: number, sol: number, param: number, value: number): void;
  setDparameter(mesh: number, sol: number, param: number, value: number): void;
  remesh(mesh: number, met: number): number;
  levelset(mesh: number, sol: number, met: number): number;
  getMeshSize(mesh: number): Record<string, number>;
  getVertices(mesh: number, np: number): { vertices: Float64Array };
  getTetrahedra(mesh: number, ne: number): { tetra: Int32Array; refs: Int32Array };
  getPrisms(mesh: number, n: number): { prisms: Int32Array; refs: Int32Array };
  getTriangles(mesh: number, nt: number): { tria: Int32Array; refs: Int32Array };
  getQuadrilaterals(mesh: number, n: number): { quads?: Int32Array; quadra?: Int32Array; refs: Int32Array };
  getEdges(mesh: number, na: number): { edges: Int32Array; refs: Int32Array };
  readonly IPARAM_verbose: number;
  readonly IPARAM_optim: number;
  readonly IPARAM_angle: number;
  readonly IPARAM_nosurf: number;
  readonly IPARAM_noinsert: number;
  readonly IPARAM_noswap: number;
  readonly IPARAM_nomove: number;
  readonly IPARAM_iso: number;
  readonly IPARAM_isosurf?: number;
  readonly IPARAM_isoref: number;
  readonly DPARAM_hmin: number;
  readonly DPARAM_hmax: number;
  readonly DPARAM_hausd: number;
  readonly DPARAM_hgrad: number;
  readonly DPARAM_hsiz: number;
  readonly DPARAM_ls: number;
  readonly DPARAM_angleDetection: number;
}

function pick(
  res: Record<string, Int32Array | unknown>,
  key: string
): { conn: Int32Array; refs: Int32Array } {
  return { conn: res[key] as Int32Array, refs: (res.refs as Int32Array) ?? new Int32Array(0) };
}

// --- model rebuild ---------------------------------------------------------------

const CAT_TYPE: Record<Cat, number> = {
  tets: C.TETRA,
  tris: C.TRIANGLE,
  quads: C.QUAD,
  edges: C.LINE,
  prisms: C.WEDGE,
};

/** Kratos-ish family word for MMG-created blocks. */
const CAT_WORD: Record<Cat, string> = {
  tets: "Tetrahedra",
  tris: "Triangle",
  quads: "Quadrilateral",
  edges: "Line",
  prisms: "Prism",
};

/**
 * Regroups the harvested cells into EntityBlocks / SubModelParts using the ref
 * table. Cells with refs MMG created itself (level-set interfaces and domain
 * splits) become new blocks; ref-0 surface/edge cells are MMG's internal
 * boundary representation and are kept only when the input had none of that
 * kind (never for plain remeshing of a volume whose boundary wasn't modelled).
 */
function rebuildModel(
  model: MdpaModel,
  s: Staged,
  harvest: Harvest,
  isoref: number | undefined
): { model: MdpaModel; counts: Record<Cat, number> } {
  const coords = new Float32Array(harvest.np * 3);
  coords.set(harvest.coords.subarray(0, harvest.np * 3));

  interface OutBlock {
    kind: EntityKind;
    name: string;
    vtkCellType: number;
    stride: number;
    entityIds: number[];
    connectivity: number[];
    order: number;
  }
  const byOriginal = new Map<EntityBlock, OutBlock>();
  const byNewRef = new Map<string, OutBlock>();
  const nextId: Record<EntityKind, number> = { Elements: 1, Conditions: 1, Geometries: 1 };
  const pathEntities = new Map<string, Record<EntityKind, number[]>>();
  const pathNodes = new Map<string, Set<number>>();
  const counts: Record<Cat, number> = { tets: 0, tris: 0, quads: 0, edges: 0, prisms: 0 };
  const hasVolume = harvest.cats.tets !== undefined || harvest.cats.prisms !== undefined;

  const catOrder: Cat[] = ["tets", "prisms", "tris", "quads", "edges"];
  let orderCounter = model.blocks.length;
  for (const cat of catOrder) {
    const data = harvest.cats[cat];
    if (!data) continue;
    const stride = CAT_STRIDE[cat];
    const count = data.refs.length;
    for (let c = 0; c < count; c++) {
      const ref = data.refs[c];
      const rawInfo = s.refInfo.get(ref);
      // MMG tags its internally-created boundary faces/edges with the adjacent
      // domain cell's ref, so a tagged ref only identifies an input block when
      // the cell family still matches; ref 0 is always internal boundary.
      const info =
        rawInfo && CAT_TYPE[cat] === rawInfo.block.vtkCellType ? rawInfo : undefined;
      const isDomainCat = cat === "tets" || cat === "prisms";
      let out: OutBlock;
      if (info) {
        let blk = byOriginal.get(info.block);
        if (!blk) {
          blk = {
            kind: info.block.kind,
            name: info.block.name,
            vtkCellType: CAT_TYPE[cat],
            stride,
            entityIds: [],
            connectivity: [],
            order: model.blocks.indexOf(info.block),
          };
          byOriginal.set(info.block, blk);
        }
        out = blk;
      } else {
        if (!isDomainCat && (ref === 0 || rawInfo)) continue; // internal boundary
        const key = `${cat}:${ref}`;
        let blk = byNewRef.get(key);
        if (!blk) {
          let name = `MMG_${CAT_WORD[cat]}_${ref}`;
          if (ref === isoref) {
            // The interface family depends on the module: triangles for
            // mmg3d/mmgs volumes+surfaces, edges for planar mmg2d.
            name = cat === "edges" && s.kind !== "mmg2d" ? "MMG_Interface_Edges" : "MMG_Interface";
          } else if (isoref !== undefined && isDomainCat) {
            name = ref === 2 ? "MMG_Domain_Inside" : ref === 3 ? "MMG_Domain_Outside" : name;
          } else if (isoref !== undefined && (ref === 2 || ref === 3) && !hasVolume) {
            // mmgs/mmg2d level-sets split the surface cells themselves.
            name = ref === 2 ? "MMG_Domain_Inside" : "MMG_Domain_Outside";
          }
          blk = {
            kind: !isDomainCat && hasVolume ? "Conditions" : "Elements",
            name,
            vtkCellType: CAT_TYPE[cat],
            stride,
            entityIds: [],
            connectivity: [],
            order: orderCounter++,
          };
          byNewRef.set(key, blk);
        }
        out = blk;
      }
      const id = nextId[out.kind]++;
      out.entityIds.push(id);
      for (let k = 0; k < stride; k++) out.connectivity.push(data.conn[c * stride + k]);
      counts[cat]++;
      if (info && info.smpPaths.length) {
        for (const p of info.smpPaths) {
          let ents = pathEntities.get(p);
          if (!ents) {
            ents = { Elements: [], Conditions: [], Geometries: [] };
            pathEntities.set(p, ents);
          }
          ents[out.kind].push(id);
          let nodes = pathNodes.get(p);
          if (!nodes) {
            nodes = new Set();
            pathNodes.set(p, nodes);
          }
          for (let k = 0; k < stride; k++) nodes.add(data.conn[c * stride + k]);
        }
      }
    }
  }

  const blocks: EntityBlock[] = [...byOriginal.values(), ...byNewRef.values()]
    .sort((a, b) => a.order - b.order)
    .filter((b) => b.entityIds.length > 0)
    .map((b) => ({
      kind: b.kind,
      name: b.name,
      vtkCellType: b.vtkCellType,
      count: b.entityIds.length,
      stride: b.stride,
      entityIds: Int32Array.from(b.entityIds),
      connectivity: Int32Array.from(b.connectivity),
    }));

  // Rebuild the SubModelPart tree, keeping only parts that still own entities
  // (or have surviving descendants); node lists come from cell connectivity.
  const rebuildParts = (parts: SubModelPart[]): SubModelPart[] => {
    const out: SubModelPart[] = [];
    for (const part of parts) {
      const children = rebuildParts(part.children);
      const ents = pathEntities.get(part.path);
      if (!ents && children.length === 0) continue;
      const nodes = pathNodes.get(part.path);
      out.push({
        name: part.name,
        path: part.path,
        nodeIds: nodes ? Int32Array.from([...nodes].sort((a, b) => a - b)) : new Int32Array(0),
        elementIds: Int32Array.from(ents?.Elements ?? []),
        conditionIds: Int32Array.from(ents?.Conditions ?? []),
        geometryIds: Int32Array.from(ents?.Geometries ?? []),
        constraintIds: new Int32Array(0),
        children,
      });
    }
    return out;
  };

  const survivors = rebuildParts(model.subModelParts);

  // A level-set additionally exposes every region it created (domains +
  // interface) as a top-level SubModelPart, so the split can be addressed like
  // any other model part: exported/deleted from the outline and written to the
  // .mdpa as a real `Begin SubModelPart` block. Names are de-duplicated against
  // surviving parts (a repeated level-set would otherwise recreate a path that
  // an earlier run's part still occupies).
  const mmgParts: SubModelPart[] = [];
  if (isoref !== undefined) {
    const taken = new Set(survivors.map((p) => p.path));
    const byName = new Map<string, SubModelPart>();
    for (const blk of byNewRef.values()) {
      if (blk.entityIds.length === 0) continue;
      let part = byName.get(blk.name);
      if (!part) {
        let path = blk.name;
        for (let n = 2; taken.has(path); n++) path = `${blk.name}_${n}`;
        taken.add(path);
        part = {
          name: path,
          path,
          nodeIds: new Int32Array(0),
          elementIds: new Int32Array(0),
          conditionIds: new Int32Array(0),
          geometryIds: new Int32Array(0),
          constraintIds: new Int32Array(0),
          children: [],
        };
        byName.set(blk.name, part);
        mmgParts.push(part);
      }
      const key = blk.kind === "Conditions" ? "conditionIds" : "elementIds";
      part[key] = Int32Array.from([...part[key], ...blk.entityIds]);
      const nodes = new Set(part.nodeIds);
      for (const n of blk.connectivity) nodes.add(n);
      part.nodeIds = Int32Array.from([...nodes].sort((a, b) => a - b));
    }
  }

  const rebuilt = finalizeModel({
    nodeCount: harvest.np,
    coords,
    blocks,
    fields: [],
    diagnostics: [],
    subModelParts: [...survivors, ...mmgParts],
  });
  return { model: rebuilt, counts };
}

// --- shared parameter application ---------------------------------------------

function applyCommonParams(
  mod: MmgAny,
  h: MmgHandles,
  p: RemeshCommonParams,
  defaultHausd?: number
): void {
  if (p.hmin !== undefined) mod.setDparameter(h.mesh, h.met, mod.DPARAM_hmin, p.hmin);
  if (p.hmax !== undefined) mod.setDparameter(h.mesh, h.met, mod.DPARAM_hmax, p.hmax);
  const hausd = p.hausd ?? defaultHausd;
  if (hausd !== undefined) mod.setDparameter(h.mesh, h.met, mod.DPARAM_hausd, hausd);
  if (p.hgrad !== undefined) mod.setDparameter(h.mesh, h.met, mod.DPARAM_hgrad, p.hgrad);
}

/**
 * MMG's built-in hausd default is ABSOLUTE (0.01): on a domain hundreds of
 * units wide it demands micron-scale interface resolution and the run explodes
 * (the bunny box level-set ran for minutes and then failed). When the user
 * gives no hausd, scale it to the mesh instead: 0.5% of the bounding-box
 * diagonal keeps runs interactive (bunny: 23 s / 3× growth vs 69 s / 10× at
 * 0.1%); tighten hausd in the Advanced form for higher geometric fidelity.
 */
function relativeHausd(model: MdpaModel): number | undefined {
  const { min, max } = model.bounds;
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return diag > 0 ? diag * 0.005 : undefined;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function statsMessage(
  verb: string,
  kind: MmgKind,
  model: MdpaModel,
  before: Record<Cat, number>,
  result: { model: MdpaModel; counts: Record<Cat, number> },
  extra: string[]
): string {
  const parts = [`${fmt(model.nodeCount)} → ${fmt(result.model.nodeCount)} nodes`];
  if (before.tets || result.counts.tets) {
    parts.push(`${fmt(before.tets)} → ${fmt(result.counts.tets)} tetrahedra`);
  }
  if (before.tris || result.counts.tris) {
    parts.push(`${fmt(before.tris)} → ${fmt(result.counts.tris)} triangles`);
  }
  const tail = extra.length ? ` ${extra.join(" ")}` : "";
  return `${verb} (${kind}): ${parts.join(", ")}.${tail}`;
}

function stagedCounts(s: Staged): Record<Cat, number> {
  return {
    tets: s.cats.tets.refs.length,
    tris: s.cats.tris.refs.length,
    quads: s.cats.quads.refs.length,
    edges: s.cats.edges.refs.length,
    prisms: s.cats.prisms.refs.length,
  };
}

function fieldWarning(model: MdpaModel): string[] {
  return model.fields.length > 0
    ? [`${model.fields.length} data field(s) were dropped (values cannot follow a remesh).`]
    : [];
}

// --- entry points ----------------------------------------------------------------

/** Isotropic remesh / optimization of the whole model through MMG. */
export async function remeshModel(
  model: MdpaModel,
  params: RemeshParams,
  onProgress?: MmgProgress
): Promise<RemeshResult> {
  onProgress?.("Preparing the MMG input mesh…");
  const staged = stageModel(model, params.module ?? "auto");
  if (typeof staged === "string") return { model, noop: true, message: staged };

  // Compute the expression-driven metric up front so a bad formula fails fast
  // (before MMG is even set up) rather than surfacing as an opaque MMG error.
  let exprSizes: Float64Array | undefined;
  const exprWarnings: string[] = [];
  if (params.mode === "expr") {
    try {
      const r = expressionSizes(staged, model, params);
      exprSizes = r.sizes;
      exprWarnings.push(...r.warnings);
    } catch (err) {
      return {
        model,
        noop: true,
        message: `Invalid sizing expression: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const apply = (mmg: Mmg, mod: MmgAny, h: MmgHandles) => {
    applyCommonParams(mod, h, params, relativeHausd(model));
    if (params.angleDetection !== undefined) {
      if (params.angleDetection <= 0) {
        mod.setIparameter(h.mesh, h.met, mod.IPARAM_angle, 0);
      } else {
        mod.setDparameter(h.mesh, h.met, mod.DPARAM_angleDetection, params.angleDetection);
      }
    }
    if (params.nosurf) mod.setIparameter(h.mesh, h.met, mod.IPARAM_nosurf, 1);
    if (params.noinsert) mod.setIparameter(h.mesh, h.met, mod.IPARAM_noinsert, 1);
    if (params.noswap) mod.setIparameter(h.mesh, h.met, mod.IPARAM_noswap, 1);
    if (params.nomove) mod.setIparameter(h.mesh, h.met, mod.IPARAM_nomove, 1);
    if (params.mode === "optimize") {
      mod.setIparameter(h.mesh, h.met, mod.IPARAM_optim, 1);
    } else if (params.mode === "hsiz") {
      mod.setDparameter(h.mesh, h.met, mod.DPARAM_hsiz, params.hsiz ?? 1);
    } else if (params.mode === "expr") {
      mod.setSolSize(h.mesh, h.met, mmg.MMG5_Vertex, staged.np, mmg.MMG5_Scalar);
      mod.setScalarSols(h.met, exprSizes ?? localEdgeSizes(staged));
    } else {
      const factor = params.factor ?? 1;
      const sizes = localEdgeSizes(staged);
      for (let i = 0; i < sizes.length; i++) sizes[i] *= factor;
      mod.setSolSize(h.mesh, h.met, mmg.MMG5_Vertex, staged.np, mmg.MMG5_Scalar);
      mod.setScalarSols(h.met, sizes);
    }
  };

  try {
    const { harvest, lowFailure } = await runMmg(
      staged,
      apply,
      (mod, h) => mod.remesh(h.mesh, h.met),
      false,
      onProgress
    );
    const result = rebuildModel(model, staged, harvest, undefined);
    const extra = [...staged.warnings, ...exprWarnings, ...fieldWarning(model)];
    if (lowFailure) extra.push("MMG reported a low failure (result usable but not fully conforming).");
    return {
      model: result.model,
      message: statsMessage("Remeshed", staged.kind, model, stagedCounts(staged), result, extra),
    };
  } catch (err) {
    return {
      model,
      noop: true,
      message: `MMG remesh failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Level-set discretization: remesh so the isovalue of a nodal scalar field
 * becomes an explicit, conforming boundary (mmg3dls / mmgsls / mmg2dls).
 */
export async function levelsetModel(
  model: MdpaModel,
  params: LevelsetParams,
  onProgress?: MmgProgress
): Promise<RemeshResult> {
  onProgress?.("Preparing the MMG input mesh…");
  // Level-set mode rewrites domain-cell refs to MMG's reserved MG_MINUS/MG_PLUS
  // (2/3), so our signature refs start above them to avoid misattribution.
  const staged = stageModel(model, params.module ?? "auto", 100);
  if (typeof staged === "string") return { model, noop: true, message: staged };

  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === params.variable);
  if (!field) {
    return { model, noop: true, message: `No nodal field "${params.variable}" to use as level-set.` };
  }
  const valueOf = new Map<number, number>();
  for (let i = 0; i < field.ids.length; i++) {
    if (field.components === 1) {
      valueOf.set(field.ids[i], field.values[i]);
    } else {
      let sq = 0;
      for (let k = 0; k < field.components; k++) sq += field.values[i * field.components + k] ** 2;
      valueOf.set(field.ids[i], Math.sqrt(sq));
    }
  }
  const phi = new Float64Array(staged.np);
  for (let i = 0; i < staged.np; i++) {
    const v = valueOf.get(staged.origIds[i]);
    if (v === undefined) {
      return {
        model,
        noop: true,
        message: `Field "${params.variable}" has no value at node ${staged.origIds[i]} — the level-set needs full nodal coverage.`,
      };
    }
    phi[i] = v;
  }

  const isoref = staged.maxRef + 1000;
  const apply = (mmg: Mmg, mod: MmgAny, h: MmgHandles) => {
    applyCommonParams(mod, h, params, relativeHausd(model));
    const ls = (h as { ls?: SolHandle }).ls as SolHandle;
    mod.setSolSize(h.mesh, ls as unknown as number, mmg.MMG5_Vertex, staged.np, mmg.MMG5_Scalar);
    mod.setScalarSols(ls as unknown as number, phi);
    // Size-preserving metric: without one, the split re-densifies the whole
    // mesh to MMG's defaults; with the current local edge sizes it only cuts.
    const sizes = localEdgeSizes(staged);
    mod.setSolSize(h.mesh, h.met, mmg.MMG5_Vertex, staged.np, mmg.MMG5_Scalar);
    mod.setScalarSols(h.met, sizes);
    if (params.isosurf && staged.kind === "mmg3d" && mod.IPARAM_isosurf !== undefined) {
      mod.setIparameter(h.mesh, ls as unknown as number, mod.IPARAM_isosurf, 1);
    } else {
      mod.setIparameter(h.mesh, ls as unknown as number, mod.IPARAM_iso, 1);
    }
    mod.setIparameter(h.mesh, ls as unknown as number, mod.IPARAM_isoref, isoref);
    if (params.isovalue !== undefined) {
      mod.setDparameter(h.mesh, ls as unknown as number, mod.DPARAM_ls, params.isovalue);
    }
  };

  try {
    const { harvest, lowFailure } = await runMmg(
      staged,
      apply,
      (mod, h) =>
        mod.levelset(h.mesh, (h as { ls?: SolHandle }).ls as unknown as number, h.met),
      true,
      onProgress
    );
    const result = rebuildModel(model, staged, harvest, isoref);
    const extra = [...staged.warnings, ...fieldWarning(model)];
    if (lowFailure) extra.push("MMG reported a low failure (result usable but not fully conforming).");
    return {
      model: result.model,
      message: statsMessage("Level-set split", staged.kind, model, stagedCounts(staged), result, extra),
    };
  } catch (err) {
    return {
      model,
      noop: true,
      message: `MMG level-set failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
