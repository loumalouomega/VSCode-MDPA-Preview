/**
 * Transforms a linear mesh into a quadratic one by inserting mid-edge nodes
 * ("serendipity" refinement): Triangle2D3 → Triangle2D6, Tetrahedra3D4 →
 * Tetrahedra3D10, Hexahedra3D8 → Hexahedra3D20, Line2 → Line3, etc.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable —
 * mirroring subModelPartExtract.ts / meshQuality.ts.
 *
 * MDPA connectivity is id-based, so corner node ids are preserved verbatim; one
 * new node is created at the midpoint of every unique mesh edge (shared edges
 * are welded so adjacent cells reference the same mid node) and appended to each
 * cell's connectivity in the VTK/Kratos-canonical edge order. Cells whose type
 * has no quadratic counterpart (or that are already quadratic) are copied
 * unchanged and reported in `skippedBlocks`.
 */

import { EntityBlock, FieldData, MdpaModel, SubModelPart } from "./types";
import { VtkCellType } from "./geometryMap";
import { nodeIndexMap } from "./writers/writerCommon";

const C = VtkCellType;

/** Linear VTK cell type → its quadratic (mid-edge-only) counterpart. */
const LINEAR_TO_QUADRATIC: Record<number, number> = {
  [C.LINE]: C.QUADRATIC_EDGE,
  [C.TRIANGLE]: C.QUADRATIC_TRIANGLE,
  [C.QUAD]: C.QUADRATIC_QUAD,
  [C.TETRA]: C.QUADRATIC_TETRA,
  [C.HEXAHEDRON]: C.QUADRATIC_HEXAHEDRON,
  [C.WEDGE]: C.QUADRATIC_WEDGE,
  [C.PYRAMID]: C.QUADRATIC_PYRAMID,
};

// Edge tables (local corner indices). The edge ORDER is the quadratic mid-edge
// node order VTK/Kratos expect, so these are defined fresh here rather than
// reusing planeCut.ts's cut-only (order-agnostic) tables.
const LINE_EDGES = [[0, 1]];
const TRIANGLE_EDGES = [[0, 1], [1, 2], [2, 0]];
const QUAD_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];
const TET_EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
const HEX_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom ring
  [4, 5], [5, 6], [6, 7], [7, 4], // top ring
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
];
const WEDGE_EDGES = [
  [0, 1], [1, 2], [2, 0], // bottom triangle
  [3, 4], [4, 5], [5, 3], // top triangle
  [0, 3], [1, 4], [2, 5], // verticals
];
const PYRAMID_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], // base
  [0, 4], [1, 4], [2, 4], [3, 4], // to apex
];

function edgesFor(linearType: number): number[][] | undefined {
  switch (linearType) {
    case C.LINE:
      return LINE_EDGES;
    case C.TRIANGLE:
      return TRIANGLE_EDGES;
    case C.QUAD:
      return QUAD_EDGES;
    case C.TETRA:
      return TET_EDGES;
    case C.HEXAHEDRON:
      return HEX_EDGES;
    case C.WEDGE:
      return WEDGE_EDGES;
    case C.PYRAMID:
      return PYRAMID_EDGES;
    default:
      return undefined;
  }
}

/** Bump the trailing node-count token: Element2D3N→Element2D6N, Triangle2D3→Triangle2D6. */
function renameToNodeCount(name: string, newCount: number): string {
  return name.replace(/(\d+)(N?)$/, (_m, _n, n) => `${newCount}${n}`);
}

export interface LinearToQuadraticResult {
  /** Fresh model with mid-edge nodes inserted (input is never mutated). */
  model: MdpaModel;
  /** Total cells widened to quadratic. */
  convertedCells: number;
  /** New mid-edge nodes created. */
  addedNodes: number;
  /** Ids of the new mid-edge nodes (for highlighting them in the preview). */
  addedNodeIds: number[];
  /** Names of blocks left unchanged (no quadratic counterpart / already quadratic). */
  skippedBlocks: string[];
}

interface NewNode {
  id: number;
  a: number;
  b: number;
}

export function linearToQuadratic(model: MdpaModel): LinearToQuadraticResult {
  const idx = nodeIndexMap(model);

  // Extendable node arrays, seeded from the source (original ids preserved).
  const nodeIds: number[] = [...model.nodeIds];
  const coords: number[] = [...model.coords];
  let nextId = model.nodeCount > 0 ? Math.max(...nodeIds) + 1 : 1;

  const edgeMid = new Map<string, number>(); // "lo:hi" → mid node id
  const newNodes: NewNode[] = [];

  const midNodeFor = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    const seen = edgeMid.get(key);
    if (seen !== undefined) return seen;
    const id = nextId++;
    edgeMid.set(key, id);
    newNodes.push({ id, a: lo, b: hi });
    // Midpoint of the two endpoints (linear/straight-edge placement).
    const ia = idx.get(a)! * 3;
    const ib = idx.get(b)! * 3;
    nodeIds.push(id);
    for (let k = 0; k < 3; k++) {
      coords.push((model.coords[ia + k] + model.coords[ib + k]) / 2);
    }
    return id;
  };

  let convertedCells = 0;
  const skippedBlocks: string[] = [];

  const blocks: EntityBlock[] = model.blocks.map((block) => {
    const quadType =
      block.vtkCellType !== undefined
        ? LINEAR_TO_QUADRATIC[block.vtkCellType]
        : undefined;
    const edges = quadType !== undefined ? edgesFor(block.vtkCellType!) : undefined;
    if (quadType === undefined || edges === undefined) {
      skippedBlocks.push(block.name);
      return block; // copied by reference; never mutated below
    }

    const corners = block.stride;
    const newStride = corners + edges.length;
    const count = block.count;
    const connectivity = new Int32Array(count * newStride);
    for (let c = 0; c < count; c++) {
      const src = c * corners;
      const dst = c * newStride;
      for (let k = 0; k < corners; k++) {
        connectivity[dst + k] = block.connectivity[src + k];
      }
      for (let e = 0; e < edges.length; e++) {
        const a = block.connectivity[src + edges[e][0]];
        const b = block.connectivity[src + edges[e][1]];
        connectivity[dst + corners + e] = midNodeFor(a, b);
      }
    }
    convertedCells += count;

    return {
      kind: block.kind,
      name: renameToNodeCount(block.name, newStride),
      vtkCellType: quadType,
      count,
      stride: newStride,
      entityIds: block.entityIds,
      propertyIds: block.propertyIds,
      connectivity,
    };
  });

  const nodeIdArr = Int32Array.from(nodeIds);
  const coordArr = Float32Array.from(coords);

  // Nodal fields gain interpolated values at mid nodes whose BOTH parents carry
  // the field; elemental/conditional fields are unchanged (entity ids untouched).
  const fields: FieldData[] = model.fields.map((field) => {
    if (field.kind !== "Nodal") return field;
    const comps = field.components;
    const valueOf = new Map<number, number[]>();
    for (let i = 0; i < field.ids.length; i++) {
      valueOf.set(field.ids[i], [...field.values.subarray(i * comps, i * comps + comps)]);
    }
    const extraIds: number[] = [];
    const extraVals: number[] = [];
    for (const { id, a, b } of newNodes) {
      const va = valueOf.get(a);
      const vb = valueOf.get(b);
      if (!va || !vb) continue;
      extraIds.push(id);
      for (let k = 0; k < comps; k++) extraVals.push((va[k] + vb[k]) / 2);
    }
    if (extraIds.length === 0) return field;

    const ids = new Int32Array(field.ids.length + extraIds.length);
    ids.set(field.ids, 0);
    ids.set(extraIds, field.ids.length);
    const values = new Float64Array(field.values.length + extraVals.length);
    values.set(field.values, 0);
    values.set(extraVals, field.values.length);
    // `fixed` (is_fixed) only applies to originally-listed nodes; mid nodes are free.
    const fixed = field.fixed
      ? (() => {
          const f = new Uint8Array(ids.length);
          f.set(field.fixed, 0);
          return f;
        })()
      : undefined;
    return { kind: field.kind, variable: field.variable, components: comps, ids, values, fixed };
  });

  // Extend SubModelPart node lists with mid nodes of fully-enclosed edges.
  const augmentPart = (part: SubModelPart): SubModelPart => {
    const owned = new Set<number>([...part.nodeIds]);
    const extra: number[] = [];
    for (const { id, a, b } of newNodes) {
      if (owned.has(a) && owned.has(b)) extra.push(id);
    }
    const partNodeIds =
      extra.length === 0
        ? part.nodeIds
        : (() => {
            const arr = new Int32Array(part.nodeIds.length + extra.length);
            arr.set(part.nodeIds, 0);
            arr.set(extra, part.nodeIds.length);
            return arr;
          })();
    return {
      name: part.name,
      nodeIds: partNodeIds,
      elementIds: part.elementIds,
      conditionIds: part.conditionIds,
      geometryIds: part.geometryIds,
      constraintIds: part.constraintIds,
      path: part.path,
      children: part.children.map(augmentPart),
    };
  };

  return {
    model: {
      nodeCount: nodeIdArr.length,
      nodeIds: nodeIdArr,
      coords: coordArr,
      blocks,
      subModelParts: model.subModelParts.map(augmentPart),
      meta: model.meta,
      properties: model.properties,
      fields,
      diagnostics: [],
      is3D: model.is3D,
      bounds: model.bounds, // midpoints lie within the existing extent
    },
    convertedCells,
    addedNodes: newNodes.length,
    addedNodeIds: newNodes.map((n) => n.id),
    skippedBlocks,
  };
}
