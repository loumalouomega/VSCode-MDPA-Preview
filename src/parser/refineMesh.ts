/**
 * Uniform subdivision: every cell splits into same-type children, with no
 * hanging nodes (a shared edge midpoint / face centre / body centre is one
 * node, not one per touching cell).
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * Native rather than meshio++'s `refine`, and for the same reason as every
 * other module here: that operation grows both the point and cell count, and
 * adopting its output would round-trip through meshioConvert — which emits no
 * `regions`, so every SubModelPart would be lost, along with the Conditions/
 * Geometries distinction, `propertyIds` and every entity id.
 *
 * It reuses linearToQuadratic.ts's core idea rather than reimplementing it:
 * shared geometry (an edge, a face, a cell body) gets exactly one new node,
 * keyed so every cell that touches it resolves to the same id. The templates
 * differ per cell type:
 *
 *   line          -> 2 line      (1 edge midpoint)
 *   triangle      -> 4 triangle  (3 edge midpoints, the standard 1-to-4 split)
 *   quad          -> 4 quad      (4 edge midpoints + 1 face centre)
 *   tetra         -> 8 tetra     (6 edge midpoints)
 *   hexahedron    -> 8 hexahedron(12 edge midpoints + 6 face centres + 1 body centre)
 *   wedge         -> 8 wedge     (9 edge midpoints + 3 quad-face centres)
 *
 * Pyramid has no same-type uniform refinement (splitting one into pyramids
 * only works via a mixed pyramid+tetra template) and is therefore refused
 * rather than silently passed through, which would leave a hanging node at
 * every refined interface it touches. `levels` applies the template
 * repeatedly; cost is exponential (×4/level for 2D, ×8/level for 3D), so it is
 * capped.
 */

import { EntityBlock, EntityKind, FieldData, MdpaModel, SubModelPart } from "./types";
import { VtkCellType } from "./geometryMap";
import { nodeIndexMap } from "./writers/writerCommon";
import { cellEdges } from "./meshTopology";
import { promoteMask, splitChildren } from "./refineTemplates";
import { RefineSelector, Selection, resolveSelection } from "./refineSelect";

const C = VtkCellType;

/** Refusing rather than silently passing through avoids hanging nodes. */
const MAX_LEVELS = 4;

interface Geom {
  /** Local edges as corner-index pairs. New node: mean of the two endpoints. */
  edges: number[][];
  /** Local faces as corner-index lists (quad faces only — need a centre node). */
  faces?: number[][];
  /** Whether the cell itself needs a body-centre node (hexahedron only). */
  bodyCenter?: boolean;
}

// Only the faces and the body centre live here now; the EDGES come from
// meshTopology.ts, whose order this module's local index layout depends on
// (corners, then one midpoint per edge in that order). Quadratic types are
// deliberately absent from this table even though `cellEdges` knows them —
// this module refines linear cells only, and `cellEdges` is also asked about
// blocks it will never refine (see the hanging-node refusal).
const QUAD_FACES = [[0, 1, 2, 3]];
const HEX_FACES = [
  [0, 1, 2, 3], [4, 5, 6, 7], // bottom, top
  [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], // sides
];
const WEDGE_FACES = [
  [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5], // the 3 quad faces
];

function geomFor(cellType: number): Geom | undefined {
  const edges = cellEdges(cellType);
  switch (cellType) {
    case C.LINE:
    case C.TRIANGLE:
      return { edges: edges as number[][] };
    case C.QUAD:
      return { edges: edges as number[][], faces: QUAD_FACES };
    case C.TETRA:
      return { edges: edges as number[][] };
    case C.HEXAHEDRON:
      return { edges: edges as number[][], faces: HEX_FACES, bodyCenter: true };
    case C.WEDGE:
      return { edges: edges as number[][], faces: WEDGE_FACES };
    default:
      return undefined;
  }
}

/**
 * Child connectivity templates, in terms of a per-cell local index space:
 * indices `0..corners-1` are the original corners, `corners..corners+edges-1`
 * the edge midpoints (in `geomFor`'s edge order), then any face centres (in
 * `faces` order), then the body centre if present.
 */
function childTemplates(cellType: number): number[][] {
  switch (cellType) {
    case C.LINE:
      // corners 0,1; mid 2
      return [
        [0, 2],
        [2, 1],
      ];
    case C.TRIANGLE:
      // corners 0,1,2; mids 3(01) 4(12) 5(20)
      return [
        [0, 3, 5],
        [3, 1, 4],
        [5, 4, 2],
        [3, 4, 5],
      ];
    case C.QUAD: {
      // corners 0,1,2,3; mids 4(01) 5(12) 6(23) 7(30); face centre 8
      return [
        [0, 4, 8, 7],
        [4, 1, 5, 8],
        [8, 5, 2, 6],
        [7, 8, 6, 3],
      ];
    }
    case C.TETRA: {
      // corners 0,1,2,3; mids 4(01) 5(12) 6(20) 7(03) 8(13) 9(23)
      return [
        [0, 4, 6, 7],
        [4, 1, 5, 8],
        [6, 5, 2, 9],
        [7, 8, 9, 3],
        // Central octahedron split into 4 tets on the diagonal 6-8 — the edge
        // every one of the four children shares. (The comment used to say
        // "4-6", which cannot be right: [6,7,8,9] contains no 4. Any of the 3
        // diagonals works, and this one must NOT be changed to the shortest —
        // it would silently alter the output of every stored recipe.)
        [4, 5, 6, 8],
        [4, 6, 7, 8],
        [6, 7, 8, 9],
        [5, 6, 8, 9],
      ];
    }
    case C.HEXAHEDRON: {
      // corners 0..7; edge mids 8..19 (HEX_GEOM.edges order); face centres
      // 20..25 (HEX_GEOM.faces order: bottom,top,front,right,back,left); body 26.
      const [E0, E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11] = [8,9,10,11,12,13,14,15,16,17,18,19];
      const [FBOT, FTOP, FFRONT, FRIGHT, FBACK, FLEFT] = [20, 21, 22, 23, 24, 25];
      const B = 26;
      return [
        [0, E0, FBOT, E3, E8, FFRONT, B, FLEFT],
        [E0, 1, E1, FBOT, FFRONT, E9, FRIGHT, B],
        [FBOT, E1, 2, E2, B, FRIGHT, E10, FBACK],
        [E3, FBOT, E2, 3, FLEFT, B, FBACK, E11],
        [E8, FFRONT, B, FLEFT, 4, E4, FTOP, E7],
        [FFRONT, E9, FRIGHT, B, E4, 5, E5, FTOP],
        [B, FRIGHT, E10, FBACK, FTOP, E5, 6, E6],
        [FLEFT, B, FBACK, E11, E7, FTOP, E6, 7],
      ];
    }
    case C.WEDGE: {
      // corners 0..5; edge mids 6(01) 7(12) 8(20) 9(34) 10(45) 11(53)
      // 12(03) 13(14) 14(25); quad-face centres 15(0143) 16(1254) 17(2035).
      return [
        [0, 6, 8, 12, 15, 17],
        [6, 1, 7, 15, 13, 16],
        [8, 7, 2, 17, 16, 14],
        [6, 7, 8, 15, 16, 17], // central prism (corner-facing-up)
        [12, 15, 17, 3, 9, 11],
        [15, 13, 16, 9, 4, 10],
        [17, 16, 14, 11, 10, 5],
        [15, 16, 17, 9, 10, 11],
      ];
    }
    default:
      return [];
  }
}

/** The kinds this module can split PARTIALLY, i.e. selectively. */
const SIMPLEX_TYPES = new Set<number>([C.LINE, C.TRIANGLE, C.TETRA]);

/** The field a green (transitional) cell is flagged with, per entity kind. */
export const REFINE_GREEN_VARIABLE = "REFINE_GREEN";

export interface RefineParams {
  levels?: number;
  /** Absent = uniform, exactly as before. */
  select?: RefineSelector;
}

export interface RefineResult {
  model: MdpaModel;
  /** Cells the selector picked (0 when there is none). */
  selectedCells: number;
  /** Fully split cells — includes greens promoted to red by the closure. */
  redCells: number;
  /** Transitional cells: split by an admissible PARTIAL mask. */
  greenCells: number;
  /** red + green — cells refined (parents, not children). */
  refinedCells: number;
  /** Total children produced from those cells. */
  producedCells: number;
  addedNodes: number;
  /** Fixed-point passes the closure needed. 1 for a pure-2D mesh. */
  closurePasses: number;
  /** Blocks passed through untouched — and provably disjoint from the refined region. */
  skippedBlocks: string[];
  /** The closure grew a strict selection to every refinable cell. */
  degeneratedToUniform: boolean;
  /** Field ids naming no cell of the selector's kind (see refineSelect.ts). */
  unresolvedSelectionIds: number;
  /** Why nothing happened. A reason, not an error — see refineSelect.ts. */
  problem?: string;
}

/** What one level returns internally: the result plus its parent->children maps. */
interface LevelResult extends RefineResult {
  children: Record<EntityKind, Map<number, number[]>>;
}

function emptyResult(model: MdpaModel): RefineResult {
  return {
    model,
    selectedCells: 0,
    redCells: 0,
    greenCells: 0,
    refinedCells: 0,
    producedCells: 0,
    addedNodes: 0,
    closurePasses: 0,
    skippedBlocks: [],
    degeneratedToUniform: false,
    unresolvedSelectionIds: 0,
  };
}

/**
 * Refine a mesh, uniformly or over a selection.
 *
 * The second argument accepts a bare level count for the original uniform call
 * shape, which every existing recipe and test uses.
 */
export function refineModel(
  model: MdpaModel,
  levelsOrParams: number | RefineParams = 1
): RefineResult {
  const params: RefineParams =
    typeof levelsOrParams === "number" ? { levels: levelsOrParams } : levelsOrParams;
  const noop = emptyResult(model);
  const n = Math.floor(params.levels ?? 1);
  if (n <= 0) return noop;
  if (n > MAX_LEVELS) {
    throw new Error(
      params.select
        ? `refine: ${n} levels of a selective refine is capped at ${MAX_LEVELS} ` +
          `(each level re-splits the previous level's children).`
        : `refine: ${n} levels would multiply the cell count by up to 8^${n} ` +
          `(capped at ${MAX_LEVELS} to avoid exhausting memory).`
    );
  }

  // Resolved ONCE, against the level-0 model. Re-resolving per level would be
  // wrong for `by:"ids"` — child 0 keeps the parent id while its siblings get
  // fresh ones, so level 2 would refine a fraction of the intended region —
  // and it would be wrong SILENTLY, since `by:"field"` and `by:"part"` would
  // accidentally survive (fields and part membership replicate to children).
  let selection: Selection | undefined;
  if (params.select) {
    selection = resolveSelection(model, params.select);
    if (selection.problem) {
      return { ...noop, unresolvedSelectionIds: selection.unresolved, problem: selection.problem };
    }
  }

  let current = model;
  let totalRed = 0;
  let totalGreen = 0;
  let totalProduced = 0;
  let totalAdded = 0;
  let maxPasses = 0;
  let degenerated = false;
  let skippedBlocks: string[] = [];

  let carried = selection;
  for (let level = 0; level < n; level++) {
    const r = refineOnce(current, carried);
    carried = carryForward(carried, r.children);
    current = r.model;
    totalRed += r.redCells;
    totalGreen += r.greenCells;
    totalProduced += r.producedCells;
    totalAdded += r.addedNodes;
    maxPasses = Math.max(maxPasses, r.closurePasses);
    degenerated = degenerated || r.degeneratedToUniform;
    skippedBlocks = r.skippedBlocks; // last level's skip list is the final one
    if (r.refinedCells === 0) break; // nothing refinable — later levels repeat the noop
  }

  const refined = totalRed + totalGreen;
  if (refined === 0) {
    return { ...noop, skippedBlocks, unresolvedSelectionIds: selection?.unresolved ?? 0 };
  }
  return {
    model: current,
    selectedCells: selection?.count ?? 0,
    redCells: totalRed,
    greenCells: totalGreen,
    refinedCells: refined,
    producedCells: totalProduced,
    addedNodes: totalAdded,
    closurePasses: maxPasses,
    skippedBlocks,
    degeneratedToUniform: degenerated,
    unresolvedSelectionIds: selection?.unresolved ?? 0,
  };
}

/**
 * The level-0 selection, re-expressed against the children it produced.
 *
 * A second level must refine the CHILDREN of the cells the user picked, not the
 * original ids — child 0 keeps the parent's id, so without this only an eighth
 * of the region would grow.
 */
function carryForward(
  sel: Selection | undefined,
  children: Record<EntityKind, Map<number, number[]>>
): Selection | undefined {
  if (!sel) return undefined;
  const cells = {
    Elements: new Set<number>(),
    Conditions: new Set<number>(),
    Geometries: new Set<number>(),
  };
  for (const kind of ["Elements", "Conditions", "Geometries"] as EntityKind[]) {
    for (const id of sel.cells[kind]) {
      const kids = children[kind].get(id);
      if (kids) for (const k of kids) cells[kind].add(k);
      else cells[kind].add(id);
    }
  }
  const count = cells.Elements.size + cells.Conditions.size + cells.Geometries.size;
  return { cells, count, unresolved: sel.unresolved };
}

function refineOnce(model: MdpaModel, selection?: Selection): LevelResult {
  const idx = nodeIndexMap(model);
  const nodeIds: number[] = [...model.nodeIds];
  const coords: number[] = [...model.coords];
  let nextId = model.nodeCount > 0 ? Math.max(...nodeIds) + 1 : 1;

  // Shared-geometry dedup: an edge/face is keyed by its SORTED corner node ids
  // (order-independent, so two cells sharing an edge/face resolve to the same
  // new node regardless of which cell visits it first).
  const sharedNode = new Map<string, number>();
  /** For interpolating Nodal fields: the parent node ids of each new node. */
  const parentsOf = new Map<number, number[]>();

  const centroidKey = (ids: number[]): string => [...ids].sort((a, b) => a - b).join(",");

  /** node id -> its row in `coords`, so a diagonal can be measured. */
  const posOf = new Map(idx);

  const nodeFor = (parentNodeIds: number[]): number => {
    const key = centroidKey(parentNodeIds);
    const seen = sharedNode.get(key);
    if (seen !== undefined) return seen;
    const id = nextId++;
    sharedNode.set(key, id);
    parentsOf.set(id, parentNodeIds);
    const acc = [0, 0, 0];
    for (const p of parentNodeIds) {
      const i = idx.get(p)! * 3;
      acc[0] += model.coords[i];
      acc[1] += model.coords[i + 1];
      acc[2] += model.coords[i + 2];
    }
    nodeIds.push(id);
    posOf.set(id, nodeIds.length - 1);
    for (let k = 0; k < 3; k++) coords.push(acc[k] / parentNodeIds.length);
    return id;
  };

  const dist2 = (p: number, q: number): number => {
    const i = posOf.get(p)! * 3;
    const j = posOf.get(q)! * 3;
    const dx = coords[i] - coords[j];
    const dy = coords[i + 1] - coords[j + 1];
    const dz = coords[i + 2] - coords[j + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  /**
   * Which diagonal a triangle's two-edge case should take: the shorter one,
   * ties by the smaller node id so the answer is deterministic.
   *
   * Per-cell QUALITY, deliberately NOT a rule needing neighbour agreement — the
   * diagonal is interior to the cell, so no neighbour can see it. Do not "fix"
   * this into a global rule; refineTemplates.ts explains why none exists.
   */
  const preferDiagonal =
    (local: number[]) =>
    (a: number, b: number, c: number, d: number): boolean => {
      const ab = dist2(local[a], local[b]);
      const cd = dist2(local[c], local[d]);
      if (ab !== cd) return ab < cd;
      return Math.min(local[a], local[b]) <= Math.min(local[c], local[d]);
    };

  let refinedCells = 0;
  let producedCells = 0;
  const skippedBlocks: string[] = [];
  /**
   * Parent entity id -> its children's ids, PER KIND.
   *
   * One map keyed by bare id would be wrong, not merely imprecise: Elements,
   * Conditions and Geometries each have their own id space, so `Element 1` and
   * `Condition 1` coexist in every ordinary Kratos mesh and the last block
   * visited would silently overwrite the others — handing an Elemental field
   * and a SubModelPart's `elementIds` the CONDITION's children. Same per-kind
   * shape as renumberMesh's `entityMaps` and cropMesh's keep sets.
   */
  const childrenOf: Record<EntityKind, Map<number, number[]>> = {
    Elements: new Map(),
    Conditions: new Map(),
    Geometries: new Map(),
  };
  // Deliberately ONE counter across all three spaces: it leaves gaps in each
  // (elements 1,9..15 beside conditions 1,16..18) but can never collide, since
  // ids are only ever compared within a kind. Per-kind counters would be
  // tidier and would churn every condition and geometry child id for no
  // correctness gain.
  let nextEntityId = maxEntityId(model) + 1;

  // ---- 1. Which edges get a midpoint, and therefore which cells split how ----
  //
  // The closure is a fixed point over ONE global set of refined edges — not an
  // adjacency map, which is the instinct and is not needed: with the admissible
  // mask set in refineTemplates.ts a face's split is a pure function of the
  // edges on it, so the loop only ever asks "which of MY edges are refined",
  // never "who else touches this edge".
  const edgeKeyOf = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const refinedEdges = new Set<string>();
  const refinable = model.blocks.map((b) =>
    b.vtkCellType !== undefined ? geomFor(b.vtkCellType) : undefined
  );

  /** Cells that were transitional last time: never green again, always red. */
  const wasGreen: Record<EntityKind, Set<number>> = {
    Elements: greenIdsFrom(model, "Elemental"),
    Conditions: greenIdsFrom(model, "Conditional"),
    Geometries: new Set(),
  };

  const fullMask = (edges: number): number => (edges >= 31 ? -1 >>> 0 : (1 << edges) - 1);
  const cellEdgeNodes = (block: EntityBlock, geom: Geom, c: number): [number, number][] => {
    const base = c * block.stride;
    return geom.edges.map(([a, b]) => [
      block.connectivity[base + a],
      block.connectivity[base + b],
    ]) as [number, number][];
  };

  let closurePasses = 0;
  const selected = selection?.cells;

  if (!selected) {
    // Uniform: every refinable cell splits fully, so every one of its edges
    // gets a midpoint. Recorded even though no closure runs, because the
    // hanging-node check below needs to know which edges moved — that check is
    // what catches a block this module CANNOT refine sitting against one it
    // just did, which was silently producing hanging nodes before.
    for (let b = 0; b < model.blocks.length; b++) {
      const block = model.blocks[b];
      const geom = refinable[b];
      if (!geom) continue;
      for (let c = 0; c < block.count; c++) {
        for (const [u, v] of cellEdgeNodes(block, geom, c)) refinedEdges.add(edgeKeyOf(u, v));
      }
    }
  }

  if (selected) {
    // Seed: every edge of every selected cell. A selected cell that cannot be
    // split partially is refused by name rather than silently ignored — the
    // whole point of the selection is that it is the user's.
    const badSelection = new Map<string, number>();
    for (let b = 0; b < model.blocks.length; b++) {
      const block = model.blocks[b];
      const geom = refinable[b];
      for (let c = 0; c < block.count; c++) {
        if (!selected[block.kind].has(block.entityIds[c])) continue;
        if (!geom || !SIMPLEX_TYPES.has(block.vtkCellType!)) {
          badSelection.set(block.name, (badSelection.get(block.name) ?? 0) + 1);
          continue;
        }
        for (const [u, v] of cellEdgeNodes(block, geom, c)) refinedEdges.add(edgeKeyOf(u, v));
      }
    }
    if (badSelection.size > 0) {
      const named = [...badSelection]
        .map(([name, n]) => `${n} in "${name}"`)
        .join(", ");
      throw new Error(
        `refine: selective refinement splits triangles and tetrahedra only, and ` +
          `the selection includes cells that are neither (${named}). Run ` +
          `Simplexify first, or narrow the selection.`
      );
    }

    // Fixed point. The edge set only ever grows and is bounded by the mesh's
    // edge count, so this terminates; a pure-2D mesh exits after one pass,
    // since no triangle mask is ever promoted.
    for (;;) {
      closurePasses++;
      let changed = false;
      for (let b = 0; b < model.blocks.length; b++) {
        const block = model.blocks[b];
        const geom = refinable[b];
        if (!geom || !SIMPLEX_TYPES.has(block.vtkCellType!)) continue;
        for (let c = 0; c < block.count; c++) {
          const en = cellEdgeNodes(block, geom, c);
          let raw = 0;
          for (let e = 0; e < en.length; e++) {
            if (refinedEdges.has(edgeKeyOf(en[e][0], en[e][1]))) raw |= 1 << e;
          }
          if (raw === 0) continue;
          // A cell that was green last time is promoted straight to red: a
          // green split of a green is what degrades element quality, and a red
          // split of a green keeps its shape class.
          const up = wasGreen[block.kind].has(block.entityIds[c])
            ? fullMask(en.length)
            : promoteMask(block.vtkCellType!, raw);
          for (let e = 0; e < en.length; e++) {
            if (up & (1 << e)) {
              const k = edgeKeyOf(en[e][0], en[e][1]);
              if (!refinedEdges.has(k)) {
                refinedEdges.add(k);
                changed = true;
              }
            }
          }
        }
      }
      if (!changed) break;
    }
  }

  // ---- 2. Build the children -------------------------------------------------
  let redCells = 0;
  let greenCells = 0;
  /** Every cell the module could split at all — the yardstick for "uniform". */
  let refinableCells = 0;
  for (let b = 0; b < model.blocks.length; b++) {
    if (refinable[b]) refinableCells += model.blocks[b].count;
  }
  const newGreen: Record<EntityKind, number[]> = { Elements: [], Conditions: [], Geometries: [] };
  /** Cells of an unrefinable block that sit on a refined edge — see below. */
  const stranded = new Map<string, number>();

  const blocks: EntityBlock[] = model.blocks.map((block, b) => {
    const geom = refinable[b];
    // Under a selection only simplices split, so a refinable-but-non-simplex
    // block (quad/hex/wedge) is passed through exactly like an unrefinable one
    // — and must face the same hanging-node check, or it would be the silent
    // case all over again one cell type further along.
    const passesThrough =
      !geom || (selected !== undefined && !SIMPLEX_TYPES.has(block.vtkCellType!));
    if (passesThrough) {
      skippedBlocks.push(block.name);
      // A skipped cell sharing only a VERTEX with a refined cell is harmless;
      // one containing both endpoints of a refined edge now has a node sitting
      // inside that edge — a hanging node. Counted here and refused below.
      const edges = block.vtkCellType !== undefined ? cellEdges(block.vtkCellType) : undefined;
      if (edges && refinedEdges.size > 0) {
        for (let c = 0; c < block.count; c++) {
          const base = c * block.stride;
          for (const [a, bb] of edges) {
            const k = edgeKeyOf(block.connectivity[base + a], block.connectivity[base + bb]);
            if (refinedEdges.has(k)) {
              stranded.set(block.name, (stranded.get(block.name) ?? 0) + 1);
              break;
            }
          }
        }
      }
      return block; // copied by reference; never mutated
    }

    const corners = block.stride;
    const full = fullMask(geom.edges.length);
    const red = childTemplates(block.vtkCellType!);

    const entityIds: number[] = [];
    const propertyIds: number[] | undefined = block.propertyIds ? [] : undefined;
    const connectivity: number[] = [];

    for (let c = 0; c < block.count; c++) {
      const base = c * corners;
      const cellNodes = Array.from(block.connectivity.subarray(base, base + corners));
      const parentId = block.entityIds[c];

      // Uniform: every refinable cell splits fully, exactly as before.
      let mask = full;
      if (selected) {
        let raw = 0;
        for (let e = 0; e < geom.edges.length; e++) {
          const [a, bb] = geom.edges[e];
          if (refinedEdges.has(edgeKeyOf(cellNodes[a], cellNodes[bb]))) raw |= 1 << e;
        }
        mask = raw === 0 ? 0 : SIMPLEX_TYPES.has(block.vtkCellType!)
          ? (wasGreen[block.kind].has(parentId) ? full : promoteMask(block.vtkCellType!, raw))
          : 0;
      }

      if (mask === 0) {
        // Untouched: emitted verbatim, keeping its own id.
        entityIds.push(parentId);
        if (propertyIds) propertyIds.push(block.propertyIds![c]);
        for (const n of cellNodes) connectivity.push(n);
        continue;
      }

      // Local index -> global node id. A midpoint is created only for an edge
      // the mask actually splits; the rest are never referenced by the
      // template, so -1 can never reach the output.
      const local: number[] = [...cellNodes];
      for (let e = 0; e < geom.edges.length; e++) {
        const [a, bb] = geom.edges[e];
        local.push(mask & (1 << e) ? nodeFor([cellNodes[a], cellNodes[bb]]) : -1);
      }
      for (const face of geom.faces ?? []) {
        local.push(mask === full ? nodeFor(face.map((li) => cellNodes[li])) : -1);
      }
      if (geom.bodyCenter) local.push(mask === full ? nodeFor(cellNodes) : -1);

      const templates =
        mask === full ? red : splitChildren(block.vtkCellType!, mask, preferDiagonal(local))!;
      if (mask === full) redCells++;
      else {
        greenCells++;
        newGreen[block.kind].push(parentId);
      }

      const kids: number[] = [];
      for (let sIdx = 0; sIdx < templates.length; sIdx++) {
        const childId = sIdx === 0 ? parentId : nextEntityId++;
        kids.push(childId);
        entityIds.push(childId);
        if (propertyIds) propertyIds.push(block.propertyIds![c]);
        for (const li of templates[sIdx]) connectivity.push(local[li]);
      }
      childrenOf[block.kind].set(parentId, kids);
      refinedCells++;
      producedCells += templates.length;
    }

    return {
      kind: block.kind,
      name: block.name, // same type, same node count per cell -> name is unchanged
      vtkCellType: block.vtkCellType,
      count: entityIds.length,
      stride: corners,
      entityIds: Int32Array.from(entityIds),
      propertyIds: propertyIds ? Int32Array.from(propertyIds) : undefined,
      connectivity: Int32Array.from(connectivity),
    };
  });

  if (stranded.size > 0) {
    const named = [...stranded].map(([name, n]) => `${n} cell(s) of "${name}"`).join(", ");
    throw new Error(
      `refine: ${named} cannot be split into same-type children, yet share a ` +
        `refined edge — refining would leave a hanging node inside them. Run ` +
        `Simplexify first, or narrow the selection.`
    );
  }

  if (refinedCells === 0) {
    return {
      ...emptyResult(model),
      skippedBlocks,
      closurePasses,
      children: childrenOf,
    };
  }

  const nodeIdArr = Int32Array.from(nodeIds);
  const coordArr = Float32Array.from(coords);

  const fields: FieldData[] = model.fields.map((field) => {
    if (field.kind === "Nodal") return interpolateNodal(field, parentsOf);
    // Elemental/Conditional: replicate the parent's row to every child.
    const comps = field.components;
    // Nodal returned above, so this is total.
    const map = field.kind === "Elemental" ? childrenOf.Elements : childrenOf.Conditions;
    const ids: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < field.ids.length; i++) {
      const kids = map.get(field.ids[i]) ?? [field.ids[i]];
      for (const kid of kids) {
        ids.push(kid);
        for (let k = 0; k < comps; k++) values.push(field.values[i * comps + k]);
      }
    }
    return {
      kind: field.kind,
      variable: field.variable,
      components: comps,
      ids: Int32Array.from(ids),
      values: Float64Array.from(values),
    };
  });

  // A green cell is transitional, and must never be green-refined again — a
  // green split of a green is what degrades element quality, whereas a red
  // split of one keeps its shape class. Within a single call the closure reads
  // `wasGreen` directly; ACROSS op records (estimate -> refine -> estimate ->
  // refine, which is the workflow this feature exists for) the flag has to
  // survive on the model, so it rides as an ordinary per-cell field — the same
  // pattern PARTITION_INDEX and ERROR_MARKED already use.
  //
  // One field per KIND rather than one spanning all three: a FieldData names a
  // single id space, and a single "Elemental" field whose ids also cover
  // Conditions is exactly the ambiguity that made ERROR_MARKED hard to read.
  // Geometries greens are tracked in-call but not persisted, because
  // FieldBlockKind has no geometric member.
  for (const [kind, location] of [
    ["Elements", "Elemental"],
    ["Conditions", "Conditional"],
  ] as [EntityKind, "Elemental" | "Conditional"][]) {
    const carried: number[] = [];
    for (const id of wasGreen[kind]) {
      for (const k of childrenOf[kind].get(id) ?? [id]) carried.push(k);
    }
    const ids = [...new Set([...carried, ...newGreen[kind]])].sort((a, b) => a - b);
    const idx2 = fields.findIndex(
      (f) => f.kind === location && f.variable === REFINE_GREEN_VARIABLE
    );
    if (idx2 >= 0) fields.splice(idx2, 1);
    if (ids.length === 0) continue;
    fields.push({
      kind: location,
      variable: REFINE_GREEN_VARIABLE,
      components: 1,
      ids: Int32Array.from(ids),
      values: Float64Array.from(ids.map(() => 1)),
    });
  }

  const augmentPart = (part: SubModelPart): SubModelPart => {
    const owned = new Set(part.nodeIds);
    const extraNodes: number[] = [];
    for (const [id, parents] of parentsOf) {
      if (parents.every((p) => owned.has(p))) extraNodes.push(id);
    }
    return {
      ...part,
      nodeIds:
        extraNodes.length === 0
          ? part.nodeIds
          : Int32Array.from([...part.nodeIds, ...extraNodes]),
      elementIds: replicateIds(part.elementIds, childrenOf.Elements),
      conditionIds: replicateIds(part.conditionIds, childrenOf.Conditions),
      geometryIds: replicateIds(part.geometryIds, childrenOf.Geometries),
      // constraintIds ride the spread: refinement only ADDS nodes, so every
      // constraint's master/slave columns still resolve.
      children: part.children.map(augmentPart),
    };
  };

  return {
    model: {
      ...model,
      nodeCount: nodeIdArr.length,
      nodeIds: nodeIdArr,
      coords: coordArr,
      blocks,
      subModelParts: model.subModelParts.map(augmentPart),
      fields,
    },
    selectedCells: selection?.count ?? 0,
    redCells,
    greenCells,
    refinedCells,
    producedCells,
    addedNodes: nodeIds.length - model.nodeCount,
    closurePasses,
    skippedBlocks,
    // A strict selection that ended up splitting every refinable cell is
    // uniform refinement wearing a selector — worth saying rather than
    // silently returning an 8x mesh.
    degeneratedToUniform:
      selection !== undefined &&
      selection.count > 0 &&
      selection.count < refinableCells &&
      refinedCells === refinableCells,
    unresolvedSelectionIds: selection?.unresolved ?? 0,
    children: childrenOf,
  };
}

/** Ids flagged REFINE_GREEN on input — cells a previous closure left transitional. */
function greenIdsFrom(model: MdpaModel, kind: "Elemental" | "Conditional"): Set<number> {
  const f = model.fields.find((x) => x.kind === kind && x.variable === REFINE_GREEN_VARIABLE);
  const out = new Set<number>();
  if (!f) return out;
  for (let i = 0; i < f.ids.length; i++) if (f.values[i * f.components] > 0.5) out.add(f.ids[i]);
  return out;
}

function maxEntityId(model: MdpaModel): number {
  let max = 0;
  for (const b of model.blocks) for (const id of b.entityIds) if (id > max) max = id;
  return max;
}

function replicateIds(ids: Int32Array, childrenOf: Map<number, number[]>): Int32Array {
  const out: number[] = [];
  for (const id of ids) out.push(...(childrenOf.get(id) ?? [id]));
  return Int32Array.from(out);
}

/** A new node's value is the mean of its generating parents' — exact for a linear field. */
function interpolateNodal(field: FieldData, parentsOf: Map<number, number[]>): FieldData {
  const comps = field.components;
  const valueOf = new Map<number, number[]>();
  for (let i = 0; i < field.ids.length; i++) {
    valueOf.set(field.ids[i], [...field.values.subarray(i * comps, i * comps + comps)]);
  }
  const extraIds: number[] = [];
  const extraVals: number[] = [];
  for (const [id, parents] of parentsOf) {
    const vs = parents.map((p) => valueOf.get(p));
    if (vs.some((v) => !v)) continue; // not every generating parent carries the field
    extraIds.push(id);
    for (let k = 0; k < comps; k++) {
      extraVals.push(vs.reduce((sum, v) => sum + v![k], 0) / vs.length);
    }
  }
  if (extraIds.length === 0) return field;
  const ids = Int32Array.from([...field.ids, ...extraIds]);
  const values = Float64Array.from([...field.values, ...extraVals]);
  return { kind: field.kind, variable: field.variable, components: comps, ids, values };
}
