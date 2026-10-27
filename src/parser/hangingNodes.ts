/**
 * Hanging nodes and the multi-point constraints that tie them (former roadmap
 * item 23). Pure: no `vscode`/DOM/wasm.
 *
 * A non-conforming mesh — an octree, or any hexahedral mesh with a refined
 * patch — has nodes that sit on the middle of a coarse neighbour's edge or face
 * without being one of its corners. A solver needs each tied to its parents, and
 * the parents are not reported by the kernel (`octreeMesh` returns a count only),
 * so they are recovered from the geometry: a node lying on a cell's edge is the
 * `(1-t, t)` mix of its two end nodes, a node on a quadrilateral face the
 * bilinear mix of its four corners. A linear field is therefore reproduced
 * exactly at every hanging node, which is what the unit test asserts.
 *
 * Chains (a parent that is itself hanging) are resolved to their end masters by
 * composing the weights; a cycle is refused by name rather than written.
 */
import { VtkCellType } from "./geometryMap";
import { cellEdges } from "./meshTopology";
import { volumeFaces } from "./writers/writerCommon";
import {
  ConstraintBlock,
  LinearConstraint,
  definedConstraintIds,
  filterConstraintsById,
  maxDefinedConstraintId,
  pruneSubModelPartConstraints,
  constraintHeaderVariables,
} from "./constraintsParser";
import type { MdpaModel, SubModelPart } from "./types";

/** The SubModelPart that owns the generated constraints, so a re-run replaces them. */
export const HANGING_PART = "HangingNodes";

export interface HangingNode {
  /** The hanging node's id. */
  node: number;
  /** Master node ids, ascending, duplicates merged. */
  masters: number[];
  /** One weight per master; they sum to 1. */
  weights: number[];
  /** `edge` (two masters) or `face` (four) before chain resolution. */
  on: "edge" | "face";
}

export interface HangingResult {
  nodes: HangingNode[];
  /** Hexahedra / quadrilaterals examined. */
  cellsChecked: number;
  /** Nodes that were hanging only through another hanging node. */
  chained: number;
}

const QUAD_FACE = [[0, 1, 2, 3]];

/** Faces of a cell whose corners can hold a bilinear parametrisation. */
function facesOf(type: number): readonly (readonly number[])[] {
  if (type === VtkCellType.QUAD) return QUAD_FACE;
  return volumeFaces(type) ?? [];
}

interface Grid {
  size: number;
  cells: Map<string, number[]>;
}

function gridKey(i: number, j: number, k: number): string {
  return `${i},${j},${k}`;
}

function buildGrid(coords: ArrayLike<number>, count: number, size: number): Grid {
  const cells = new Map<string, number[]>();
  for (let n = 0; n < count; n++) {
    const key = gridKey(
      Math.floor(coords[n * 3] / size),
      Math.floor(coords[n * 3 + 1] / size),
      Math.floor(coords[n * 3 + 2] / size)
    );
    const list = cells.get(key);
    if (list) list.push(n);
    else cells.set(key, [n]);
  }
  return { size, cells };
}

/** Point-to-segment: distance and the parameter along it. */
function onSegment(p: number[], a: number[], b: number[]): { dist: number; t: number } {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (len2 === 0) return { dist: Infinity, t: 0 };
  const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2;
  const q = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  return { dist: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), t };
}

/**
 * Bilinear coordinates of `p` on the quadrilateral `c` (corners in order), or
 * undefined when it is off the face by more than `tol` or outside it.
 */
function onQuad(p: number[], c: number[][], tol: number): { u: number; v: number } | undefined {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Newton on  x(u,v) = (1-u)(1-v)c0 + u(1-v)c1 + uv c2 + (1-u)v c3  from the centre.
  let u = 0.5;
  let v = 0.5;
  for (let it = 0; it < 30; it++) {
    const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
    const x = [0, 1, 2].map((d) => w[0] * c[0][d] + w[1] * c[1][d] + w[2] * c[2][d] + w[3] * c[3][d]);
    const r = sub(x, p);
    const xu = [0, 1, 2].map((d) => (1 - v) * (c[1][d] - c[0][d]) + v * (c[2][d] - c[3][d]));
    const xv = [0, 1, 2].map((d) => (1 - u) * (c[3][d] - c[0][d]) + u * (c[2][d] - c[1][d]));
    // Least-squares 2x2 normal equations (the face is a surface in 3-space).
    const a11 = dot(xu, xu);
    const a12 = dot(xu, xv);
    const a22 = dot(xv, xv);
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-300) return undefined;
    const b1 = -dot(xu, r);
    const b2 = -dot(xv, r);
    const du = (b1 * a22 - b2 * a12) / det;
    const dv = (a11 * b2 - a12 * b1) / det;
    u += du;
    v += dv;
    if (Math.abs(du) + Math.abs(dv) < 1e-13) break;
  }
  const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
  const x = [0, 1, 2].map((d) => w[0] * c[0][d] + w[1] * c[1][d] + w[2] * c[2][d] + w[3] * c[3][d]);
  if (Math.hypot(x[0] - p[0], x[1] - p[1], x[2] - p[2]) > tol) return undefined;
  const eps = 1e-9;
  if (u < eps || u > 1 - eps || v < eps || v > 1 - eps) return undefined;
  return { u, v };
}

/**
 * Finds every node that lies in the interior of an edge or face of a hexahedron
 * (or quadrilateral) without being one of its corners.
 */
export function findHangingNodes(model: MdpaModel): HangingResult {
  const index = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);
  const coords = model.coords;
  const P = (id: number): number[] => {
    const i = index.get(id)!;
    return [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]];
  };

  const cells: { type: number; ids: number[] }[] = [];
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    if (b.vtkCellType !== VtkCellType.HEXAHEDRON && b.vtkCellType !== VtkCellType.QUAD) continue;
    for (let c = 0; c < b.count; c++) {
      const ids = Array.from(b.connectivity.subarray(c * b.stride, c * b.stride + b.stride));
      if (ids.length === (b.vtkCellType === VtkCellType.HEXAHEDRON ? 8 : 4) && ids.every((n) => index.has(n))) {
        cells.push({ type: b.vtkCellType, ids });
      }
    }
  }
  if (cells.length === 0 || model.nodeCount === 0) return { nodes: [], cellsChecked: 0, chained: 0 };

  // Grid cell size: the mean shortest edge, so a cell's box touches few grid cells.
  let sum = 0;
  let n = 0;
  for (const cell of cells) {
    for (const [a, b] of cellEdges(cell.type) ?? []) {
      const pa = P(cell.ids[a]);
      const pb = P(cell.ids[b]);
      sum += Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      n++;
    }
  }
  const size = Math.max(sum / Math.max(n, 1), 1e-12);
  const grid = buildGrid(coords, model.nodeCount, size);

  const found = new Map<number, HangingNode>();
  for (const cell of cells) {
    const corners = cell.ids.map(P);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of corners) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); }
    let shortest = Infinity;
    const edges = cellEdges(cell.type) ?? [];
    for (const [a, b] of edges) shortest = Math.min(shortest, Math.hypot(corners[a][0] - corners[b][0], corners[a][1] - corners[b][1], corners[a][2] - corners[b][2]));
    const tol = Math.max(shortest * 1e-6, 1e-12);
    const cornerSet = new Set(cell.ids);
    const i0 = lo.map((v) => Math.floor((v - tol) / size));
    const i1 = hi.map((v) => Math.floor((v + tol) / size));
    for (let i = i0[0]; i <= i1[0]; i++) for (let j = i0[1]; j <= i1[1]; j++) for (let k = i0[2]; k <= i1[2]; k++) {
      for (const ni of grid.cells.get(gridKey(i, j, k)) ?? []) {
        const id = model.nodeIds[ni];
        if (cornerSet.has(id)) continue;
        const p = [coords[ni * 3], coords[ni * 3 + 1], coords[ni * 3 + 2]];
        if (p.some((v, d) => v < lo[d] - tol || v > hi[d] + tol)) continue;
        // Edges first: the tighter relation wins over a face that happens to contain it.
        let hit: HangingNode | undefined;
        for (const [a, b] of edges) {
          const { dist, t } = onSegment(p, corners[a], corners[b]);
          if (dist <= tol && t > 1e-9 && t < 1 - 1e-9) {
            hit = { node: id, masters: [cell.ids[a], cell.ids[b]], weights: [1 - t, t], on: "edge" };
            break;
          }
        }
        if (!hit) {
          for (const face of facesOf(cell.type)) {
            const uv = onQuad(p, face.map((c) => corners[c]), tol);
            if (uv) {
              const { u, v } = uv;
              hit = { node: id, masters: face.map((c) => cell.ids[c]), weights: [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v], on: "face" };
              break;
            }
          }
        }
        if (!hit) continue;
        const prev = found.get(id);
        if (!prev || (prev.on === "face" && hit.on === "edge")) found.set(id, hit);
      }
    }
  }

  // Resolve chains: a master that is itself hanging is replaced by its own masters.
  const resolved = new Map<number, { masters: number[]; weights: number[] }>();
  let chained = 0;
  const resolve = (id: number, stack: Set<number>): { masters: number[]; weights: number[] } => {
    const done = resolved.get(id);
    if (done) return done;
    const h = found.get(id)!;
    if (stack.has(id)) throw new Error(`Hanging nodes form a cycle through node ${id}; cannot tie them to end masters.`);
    stack.add(id);
    const acc = new Map<number, number>();
    let viaChain = false;
    h.masters.forEach((m, i) => {
      if (found.has(m)) {
        viaChain = true;
        const r = resolve(m, stack);
        r.masters.forEach((mm, j) => acc.set(mm, (acc.get(mm) ?? 0) + h.weights[i] * r.weights[j]));
      } else acc.set(m, (acc.get(m) ?? 0) + h.weights[i]);
    });
    stack.delete(id);
    if (viaChain) chained++;
    const masters = [...acc.keys()].sort((a, b) => a - b);
    const out = { masters, weights: masters.map((m) => acc.get(m)!) };
    resolved.set(id, out);
    return out;
  };
  const nodes: HangingNode[] = [];
  for (const id of [...found.keys()].sort((a, b) => a - b)) {
    const r = resolve(id, new Set());
    nodes.push({ node: id, masters: r.masters, weights: r.weights, on: found.get(id)!.on });
  }
  return { nodes, cellsChecked: cells.length, chained };
}

export interface HangingConstraintParams {
  /** Variables to tie; default the three displacement components. */
  variables?: string[];
}

export interface HangingConstraintResult {
  model: MdpaModel;
  hanging: number;
  constraints: number;
  chained: number;
  /** Constraints of an earlier run that were replaced. */
  replaced: number;
}

export const DEFAULT_HANGING_VARIABLES = ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"];

/**
 * Adds one `LinearMasterSlaveConstraint` per hanging node and variable, listed in
 * a top-level `HangingNodes` SubModelPart. A re-run replaces its own earlier
 * output instead of stacking a second set.
 */
export function addHangingNodeConstraints(model: MdpaModel, params: HangingConstraintParams = {}): HangingConstraintResult {
  const variables = (params.variables?.length ? params.variables : DEFAULT_HANGING_VARIABLES).map((v) => v.trim()).filter(Boolean);
  if (variables.length === 0) throw new Error("Name at least one variable to tie.");
  const { nodes, chained } = findHangingNodes(model);

  // Drop the previous generation (the ids the HangingNodes part lists).
  const previous = model.subModelParts.find((p) => p.path === HANGING_PART);
  const drop = new Set(previous ? Array.from(previous.constraintIds) : []);
  let constraints: ConstraintBlock[] = model.constraints ?? [];
  let parts: SubModelPart[] = model.subModelParts.filter((p) => p !== previous);
  if (drop.size > 0) {
    constraints = filterConstraintsById(constraints, (id) => !drop.has(id)) ?? [];
    parts = pruneSubModelPartConstraints(parts, new Set(definedConstraintIds(constraints))).parts;
  }
  if (nodes.length === 0) {
    return { model: { ...model, constraints: constraints.length ? constraints : undefined, subModelParts: parts }, hanging: 0, constraints: 0, chained, replaced: drop.size };
  }

  let next = maxDefinedConstraintId(constraints);
  const listed = (p: SubModelPart): number[] => [...Array.from(p.constraintIds), ...p.children.flatMap(listed)];
  for (const id of parts.flatMap(listed)) if (id > next) next = id;
  const ids: number[] = [];
  // Kratos reads the number of master dofs from the block header and every row
  // must match it: one block per variable and per master count (edge 2, face 4),
  // the variable repeated once for the slave and once per master.
  const blocks: ConstraintBlock[] = [];
  const counts = [...new Set(nodes.map((h) => h.masters.length))].sort((a, b) => a - b);
  for (const variable of variables) {
    for (const count of counts) {
      const rows = nodes
        .filter((h) => h.masters.length === count)
        .map((h): LinearConstraint => {
          const id = ++next;
          ids.push(id);
          return { kind: "linear", id, constant: 0, weights: h.weights, slaveIds: [h.node], masterIds: h.masters };
        });
      blocks.push({ name: "LinearMasterSlaveConstraint", variables: constraintHeaderVariables(variable, count), rows });
    }
  }
  const owner: SubModelPart = {
    name: HANGING_PART,
    path: HANGING_PART,
    nodeIds: new Int32Array(0),
    elementIds: new Int32Array(0),
    conditionIds: new Int32Array(0),
    geometryIds: new Int32Array(0),
    constraintIds: Int32Array.from(ids),
    children: [],
  };
  return {
    model: { ...model, constraints: [...constraints, ...blocks], subModelParts: [...parts, owner] },
    hanging: nodes.length,
    constraints: ids.length,
    chained,
    replaced: drop.size,
  };
}
