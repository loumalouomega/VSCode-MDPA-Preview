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

// Local corner ordering shared with linearToQuadratic.ts / meshBuilder.ts.
const LINE_GEOM: Geom = { edges: [[0, 1]] };
const TRIANGLE_GEOM: Geom = { edges: [[0, 1], [1, 2], [2, 0]] };
const QUAD_GEOM: Geom = { edges: [[0, 1], [1, 2], [2, 3], [3, 0]], faces: [[0, 1, 2, 3]] };
const TET_GEOM: Geom = { edges: [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]] };
const HEX_GEOM: Geom = {
  edges: [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ],
  faces: [
    [0, 1, 2, 3], [4, 5, 6, 7], // bottom, top
    [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], // sides
  ],
  bodyCenter: true,
};
const WEDGE_GEOM: Geom = {
  edges: [
    [0, 1], [1, 2], [2, 0],
    [3, 4], [4, 5], [5, 3],
    [0, 3], [1, 4], [2, 5],
  ],
  faces: [
    [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5], // the 3 quad faces
  ],
};

function geomFor(cellType: number): Geom | undefined {
  switch (cellType) {
    case C.LINE:
      return LINE_GEOM;
    case C.TRIANGLE:
      return TRIANGLE_GEOM;
    case C.QUAD:
      return QUAD_GEOM;
    case C.TETRA:
      return TET_GEOM;
    case C.HEXAHEDRON:
      return HEX_GEOM;
    case C.WEDGE:
      return WEDGE_GEOM;
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
        // Central octahedron split into 4 tets (a fixed, order-independent
        // choice — any of the 3 diagonals works; 4-6 is used here).
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

export interface RefineResult {
  model: MdpaModel;
  /** Cells refined (parents, not children — the original count). */
  refinedCells: number;
  /** Total children produced from those cells. */
  producedCells: number;
  addedNodes: number;
  skippedBlocks: string[];
}

export function refineModel(model: MdpaModel, levels = 1): RefineResult {
  const noop: RefineResult = {
    model,
    refinedCells: 0,
    producedCells: 0,
    addedNodes: 0,
    skippedBlocks: [],
  };
  const n = Math.floor(levels);
  if (n <= 0) return noop;
  if (n > MAX_LEVELS) {
    throw new Error(
      `refine: ${n} levels would multiply the cell count by up to 8^${n} ` +
        `(capped at ${MAX_LEVELS} to avoid exhausting memory).`
    );
  }

  let current = model;
  let totalRefined = 0;
  let totalProduced = 0;
  let totalAdded = 0;
  let skippedBlocks: string[] = [];

  for (let level = 0; level < n; level++) {
    const r = refineOnce(current);
    current = r.model;
    totalRefined += r.refinedCells;
    totalProduced += r.producedCells;
    totalAdded += r.addedNodes;
    skippedBlocks = r.skippedBlocks; // last level's skip list is the final one
    if (r.refinedCells === 0) break; // nothing refinable — further levels would repeat the noop
  }

  if (totalRefined === 0) return { ...noop, skippedBlocks };
  return {
    model: current,
    refinedCells: totalRefined,
    producedCells: totalProduced,
    addedNodes: totalAdded,
    skippedBlocks,
  };
}

function refineOnce(model: MdpaModel): RefineResult {
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
    for (let k = 0; k < 3; k++) coords.push(acc[k] / parentNodeIds.length);
    return id;
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

  const blocks: EntityBlock[] = model.blocks.map((block) => {
    const geom = block.vtkCellType !== undefined ? geomFor(block.vtkCellType) : undefined;
    if (!geom) {
      skippedBlocks.push(block.name);
      return block; // copied by reference; never mutated
    }
    const templates = childTemplates(block.vtkCellType!);
    const corners = block.stride;
    const perCell = templates.length;
    const childStride = corners; // every template here is same-type, same corner count

    const entityIds = new Int32Array(block.count * perCell);
    const propertyIds = block.propertyIds ? new Int32Array(block.count * perCell) : undefined;
    const connectivity = new Int32Array(block.count * perCell * childStride);

    for (let c = 0; c < block.count; c++) {
      const base = c * corners;
      const cellNodes = Array.from(block.connectivity.subarray(base, base + corners));

      // Build the local index -> global node id table: corners, then edge
      // midpoints, then face centres, then (for hex) the body centre.
      const local: number[] = [...cellNodes];
      for (const [a, b] of geom.edges) local.push(nodeFor([cellNodes[a], cellNodes[b]]));
      for (const face of geom.faces ?? []) local.push(nodeFor(face.map((li) => cellNodes[li])));
      if (geom.bodyCenter) local.push(nodeFor(cellNodes));

      const parentId = block.entityIds[c];
      const kids: number[] = [];
      for (let s = 0; s < perCell; s++) {
        const childId = s === 0 ? parentId : nextEntityId++;
        kids.push(childId);
        const out = c * perCell + s;
        entityIds[out] = childId;
        if (propertyIds) propertyIds[out] = block.propertyIds![c];
        for (let k = 0; k < childStride; k++) {
          connectivity[out * childStride + k] = local[templates[s][k]];
        }
      }
      childrenOf[block.kind].set(parentId, kids);
      refinedCells++;
      producedCells += perCell;
    }

    return {
      kind: block.kind,
      name: block.name, // same type, same node count per cell -> name is unchanged
      vtkCellType: block.vtkCellType,
      count: block.count * perCell,
      stride: childStride,
      entityIds,
      propertyIds,
      connectivity,
    };
  });

  if (refinedCells === 0) {
    return { model, refinedCells: 0, producedCells: 0, addedNodes: 0, skippedBlocks };
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
    refinedCells,
    producedCells,
    addedNodes: nodeIds.length - model.nodeCount,
    skippedBlocks,
  };
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
