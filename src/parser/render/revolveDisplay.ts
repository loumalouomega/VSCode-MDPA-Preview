/**
 * View-only revolve expansion (roadmap item 24, second increment).
 *
 * `revolveExpand(model, spec)` turns a 2D axisymmetric (planar, z ~ 0) mesh into the
 * 3D solid of revolution about the x or y axis, as a NEW display-only `MdpaModel`.
 * Like `mirrorDisplay.ts` nothing is written, the operation history never sees it, and
 * the webview keeps the host's model as the source of truth for edits and exports.
 *
 * Rules:
 *  - the radius is the coordinate perpendicular to the axis (x for axis y, y for axis x)
 *    and must be >= 0; a non-planar mesh or a node at negative radius is refused by name;
 *  - nodes on the axis are SHARED by every ring (one node, not `rings` of them);
 *  - a triangle becomes a wedge, a quad a hex; cells touching the axis degenerate
 *    cleanly (quad with an edge on the axis -> wedge, triangle with an edge on the axis
 *    -> tetrahedron, triangle with one vertex on the axis -> pyramid). Anything else
 *    (a quad with only a vertex on the axis, quadratic, line and point cells) is skipped
 *    and named in the diagnostics;
 *  - every cell is oriented to a positive volume (the sign convention of
 *    `cellDecomposition.ts`, which `cellInversion.ts` also uses);
 *  - vectors and 3x3 tensors are rotated about the axis with the ring, scalars copied,
 *    other widths copied and reported.
 *
 * Pure: no vscode/DOM/wasm, bundled by the webview.
 */
import { VtkCellType } from "../geometryMap";
import { decompositionFor } from "../cellDecomposition";
import type { EntityBlock, FieldData, MdpaModel } from "../types";
import { carryFieldMeta } from "../fieldDimensions";

export interface RevolveSpec {
  axis: "x" | "y";
  /** Angle of the first ring, degrees. */
  startDeg: number;
  /** Total sweep, degrees; 360 closes the solid (the last ring wraps onto the first). */
  sweepDeg: number;
  /** Number of slabs (angular steps). */
  layers: number;
}

export interface RevolveResult {
  model: MdpaModel;
  nodeStride: number;
  entityStride: number;
  /** Maps any node id of the expanded model back to the source node id. */
  sourceNodeId(id: number): number;
  /** Maps any entity id of the expanded model back to the source entity id. */
  sourceEntityId(id: number): number;
  /** Nodes on the axis (shared by all rings). */
  axisNodes: number;
  diagnostics: string[];
}

export const REVOLVE_MAX_CELLS = 2_000_000;
export const REVOLVE_MAX_LAYERS = 720;

type Shape = { type: number; make: (p: number[], q: number[]) => number[] } | undefined;

const SUFFIX: Record<number, string> = {
  [VtkCellType.HEXAHEDRON]: "_revolve",
  [VtkCellType.WEDGE]: "_revolve_wedge",
  [VtkCellType.TETRA]: "_revolve_tet",
  [VtkCellType.PYRAMID]: "_revolve_pyr",
};

/**
 * Classify a planar source cell by which of its nodes lie on the axis and return the
 * solid cell between ring `p` and ring `q` (arrays of the source nodes' ids on each ring,
 * in source order). Axis nodes have the same id on both rings.
 */
function shapeOf(cellType: number | undefined, onAxis: boolean[]): Shape {
  const n = onAxis.length;
  const idx = onAxis.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  if (cellType === VtkCellType.QUAD && n === 4) {
    if (idx.length === 0) return { type: VtkCellType.HEXAHEDRON, make: (p, q) => [...p, ...q] };
    if (idx.length === 2 && (idx[1] - idx[0] === 1 || (idx[0] === 0 && idx[1] === 3))) {
      // Rotate so the axis edge is (a, b) = positions (0, 1) and the rest follow cyclically.
      const s = idx[0] === 0 && idx[1] === 3 ? 3 : idx[0];
      const order = [0, 1, 2, 3].map((i) => (i + s) % 4);
      return {
        type: VtkCellType.WEDGE,
        make: (p, q) => {
          const [a, b, c, d] = order.map((i) => i);
          return [p[a], p[d], q[d], p[b], p[c], q[c]];
        },
      };
    }
    return undefined;
  }
  if (cellType === VtkCellType.TRIANGLE && n === 3) {
    if (idx.length === 0) return { type: VtkCellType.WEDGE, make: (p, q) => [...p, ...q] };
    if (idx.length === 2) {
      const c = [0, 1, 2].find((i) => !onAxis[i])!;
      const [a, b] = idx;
      return { type: VtkCellType.TETRA, make: (p, q) => [p[a], p[b], p[c], q[c]] };
    }
    if (idx.length === 1) {
      const a = idx[0];
      const [b, c] = [0, 1, 2].filter((i) => i !== a);
      return { type: VtkCellType.PYRAMID, make: (p, q) => [p[b], p[c], q[c], q[b], p[a]] };
    }
  }
  return undefined;
}

function det3(a: number[], b: number[], c: number[]): number {
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

export function revolveExpand(model: MdpaModel, spec: RevolveSpec): RevolveResult {
  const diagnostics: string[] = [];
  const layers = Math.floor(spec.layers);
  if (!(layers >= 1) || layers > REVOLVE_MAX_LAYERS)
    throw new Error(`Revolve: layers must be between 1 and ${REVOLVE_MAX_LAYERS}.`);
  if (!Number.isFinite(spec.sweepDeg) || spec.sweepDeg === 0 || Math.abs(spec.sweepDeg) > 360)
    throw new Error("Revolve: the sweep must be a non-zero angle of at most 360 degrees.");
  if (spec.axis !== "x" && spec.axis !== "y") throw new Error('Revolve: the axis must be "x" or "y".');
  const closed = Math.abs(spec.sweepDeg) >= 360 - 1e-9;
  if (closed && layers < 3) throw new Error("Revolve: a closed (360 degree) solid needs at least 3 layers.");
  const rings = closed ? layers : layers + 1;
  const ri = spec.axis === "y" ? 0 : 1; // radial coordinate index
  const ai = spec.axis === "y" ? 1 : 0; // axial coordinate index

  const n = model.nodeCount;
  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const tol = Math.max(diag, 1) * 1e-9;
  if (n === 0) throw new Error("Revolve: the mesh has no nodes.");
  for (let i = 0; i < n; i++) {
    if (Math.abs(model.coords[3 * i + 2]) > tol)
      throw new Error("Revolve: the mesh is not planar (z is not zero); revolve needs a 2D axisymmetric result in the xy plane.");
    if (model.coords[3 * i + ri] < -tol)
      throw new Error(`Revolve: node ${model.nodeIds[i]} has a negative ${spec.axis === "y" ? "x" : "y"} coordinate; the axisymmetric half-plane must have r >= 0.`);
  }

  const nodeStride = model.nodeIds.reduce((m, id) => Math.max(m, id), 0);
  let entityStride = 0;
  for (const bl of model.blocks) for (const id of bl.entityIds) entityStride = Math.max(entityStride, id);

  const idToIndex = new Map<number, number>();
  const onAxis = new Uint8Array(n);
  let axisNodes = 0;
  for (let i = 0; i < n; i++) {
    idToIndex.set(model.nodeIds[i], i);
    if (Math.abs(model.coords[3 * i + ri]) <= tol) {
      onAxis[i] = 1;
      axisNodes++;
    }
  }
  const ringId = (id: number, k: number): number => {
    const i = idToIndex.get(id);
    return i === undefined || onAxis[i] || k === 0 ? id : id + k * nodeStride;
  };

  // Estimate and guard before allocating.
  let srcCells = 0;
  for (const bl of model.blocks) srcCells += bl.count;
  if (srcCells * layers > REVOLVE_MAX_CELLS)
    throw new Error(`Revolve: ${srcCells} cells x ${layers} layers = ${srcCells * layers} cells exceeds the view limit of ${REVOLVE_MAX_CELLS}; use fewer layers.`);

  const angle = (k: number): number => ((spec.startDeg + (spec.sweepDeg * k) / layers) * Math.PI) / 180;

  // Nodes: every ring, axis nodes once.
  const total = n + (rings - 1) * (n - axisNodes);
  const nodeIds = new Int32Array(total);
  const coords = new Float32Array(3 * total);
  let w = 0;
  for (let k = 0; k < rings; k++) {
    const th = angle(k);
    const c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < n; i++) {
      if (k > 0 && onAxis[i]) continue;
      const r = model.coords[3 * i + ri];
      const a = model.coords[3 * i + ai];
      nodeIds[w] = ringId(model.nodeIds[i], k);
      coords[3 * w + ri] = r * c;
      coords[3 * w + ai] = a;
      coords[3 * w + 2] = r * s;
      w++;
    }
  }
  // Coordinates of an expanded node by id, for the orientation test.
  const pos = new Map<number, number>();
  for (let i = 0; i < total; i++) pos.set(nodeIds[i], i);
  const P = (id: number): number[] => {
    const i = pos.get(id)!;
    return [coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]];
  };
  const signedVolume = (type: number, ids: number[]): number => {
    const dec = decompositionFor(type);
    let v = 0;
    for (const t of dec.tets ?? []) {
      const p0 = P(ids[t[0]]), p1 = P(ids[t[1]]), p2 = P(ids[t[2]]), p3 = P(ids[t[3]]);
      v += det3(
        [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
        [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]],
        [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]]
      );
    }
    return v;
  };

  const strideOf: Record<number, number> = {
    [VtkCellType.HEXAHEDRON]: 8,
    [VtkCellType.WEDGE]: 6,
    [VtkCellType.TETRA]: 4,
    [VtkCellType.PYRAMID]: 5,
  };

  const blocks: EntityBlock[] = [];
  const keptSource = new Set<string>();
  const skipped = new Map<string, number>();
  for (const bl of model.blocks) {
    const buckets = new Map<number, { ids: number[]; conn: number[]; props: number[] }>();
    for (let c = 0; c < bl.count; c++) {
      const src = Array.from(bl.connectivity.subarray(c * bl.stride, (c + 1) * bl.stride));
      const flags = src.map((id) => {
        const i = idToIndex.get(id);
        return i !== undefined && onAxis[i] === 1;
      });
      const shape = shapeOf(bl.vtkCellType, flags);
      if (!shape) {
        const key = `${bl.name} (cell type ${bl.vtkCellType ?? "?"})`;
        skipped.set(key, (skipped.get(key) ?? 0) + 1);
        continue;
      }
      let bucket = buckets.get(shape.type);
      if (!bucket) buckets.set(shape.type, (bucket = { ids: [], conn: [], props: [] }));
      // Orientation is rotation-invariant: decide it once from slab 0.
      const p0 = src.map((id) => ringId(id, 0));
      const q0 = src.map((id) => ringId(id, 1 % rings));
      let flip = false;
      if (rings > 1) {
        const probe = shape.make(p0, q0);
        flip = signedVolume(shape.type, probe) < 0;
      }
      for (let k = 0; k < layers; k++) {
        const p = src.map((id) => ringId(id, k));
        const q = src.map((id) => ringId(id, (k + 1) % rings));
        const conn = flip ? shape.make(q, p) : shape.make(p, q);
        bucket.ids.push(bl.entityIds[c] + k * entityStride);
        for (const id of conn) bucket.conn.push(id);
        bucket.props.push(bl.propertyIds ? bl.propertyIds[c] : 0);
      }
      keptSource.add(`${bl.kind}:${bl.entityIds[c]}`);
    }
    for (const [type, bk] of buckets) {
      blocks.push({
        kind: bl.kind,
        name: `${bl.name}${SUFFIX[type]}`,
        vtkCellType: type,
        count: bk.ids.length,
        stride: strideOf[type],
        entityIds: Int32Array.from(bk.ids),
        connectivity: Int32Array.from(bk.conn),
        propertyIds: bl.propertyIds ? Int32Array.from(bk.props) : undefined,
      });
    }
  }
  for (const [what, count] of skipped)
    diagnostics.push(`Revolve: skipped ${count} cell(s) of ${what} (only triangles and quads revolve; a quad with just a vertex on the axis cannot).`);

  // Fields.
  const fields: FieldData[] = model.fields.map((f) =>
    revolveField(f, { onAxis, idToIndex, nodeStride, entityStride, rings, layers, angle, axis: spec.axis, diagnostics })
  );

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i++)
    for (let a = 0; a < 3; a++) {
      const v = coords[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }

  const out: MdpaModel = {
    ...model,
    nodeCount: total,
    nodeIds,
    coords,
    blocks,
    fields,
    bounds: { min, max },
    is3D: true,
    derived: undefined,
  };
  return {
    model: out,
    nodeStride,
    entityStride,
    axisNodes,
    sourceNodeId: (id) => (id > nodeStride && nodeStride > 0 ? ((id - 1) % nodeStride) + 1 : id),
    sourceEntityId: (id) => (id > entityStride && entityStride > 0 ? ((id - 1) % entityStride) + 1 : id),
    diagnostics,
  };
}

interface FieldCtx {
  onAxis: Uint8Array;
  idToIndex: Map<number, number>;
  nodeStride: number;
  entityStride: number;
  rings: number;
  layers: number;
  angle(k: number): number;
  axis: "x" | "y";
  diagnostics: string[];
}

/** Rotation about the revolve axis by `th`: radial index rotates into z. */
function rotation(axis: "x" | "y", th: number): number[] {
  const c = Math.cos(th), s = Math.sin(th);
  const ri = axis === "y" ? 0 : 1;
  const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  R[3 * ri + ri] = c;
  R[3 * ri + 2] = -s;
  R[3 * 2 + ri] = s;
  R[3 * 2 + 2] = c;
  return R;
}

function revolveField(f: FieldData, ctx: FieldCtx): FieldData {
  const w = f.components;
  const nodal = f.kind === "Nodal";
  const rows = f.ids.length;
  const copies = nodal ? ctx.rings : ctx.layers;
  // Rows kept per copy: a nodal row on the axis exists once.
  const perCopy: number[][] = [];
  for (let k = 0; k < copies; k++) {
    const keep: number[] = [];
    for (let r = 0; r < rows; r++) {
      if (nodal && k > 0) {
        const i = ctx.idToIndex.get(f.ids[r]);
        if (i === undefined || ctx.onAxis[i]) continue;
      }
      keep.push(r);
    }
    perCopy.push(keep);
  }
  const total = perCopy.reduce((s, a) => s + a.length, 0);
  const outW = w === 2 ? 3 : w;
  const ids = new Int32Array(total);
  const values = new Float64Array(total * outW);
  const fixed = f.fixed ? new Uint8Array(total) : undefined;
  let warned = false;
  let o = 0;
  for (let k = 0; k < copies; k++) {
    // Nodal rows sit on ring k; elemental rows in slab k, evaluated at its mid angle.
    const th = nodal ? ctx.angle(k) : (ctx.angle(k) + ctx.angle(k + 1)) / 2;
    const R = rotation(ctx.axis, th);
    for (const r of perCopy[k]) {
      const stride = nodal ? ctx.nodeStride : ctx.entityStride;
      const i = nodal ? ctx.idToIndex.get(f.ids[r]) : undefined;
      ids[o] = nodal && i !== undefined && ctx.onAxis[i] ? f.ids[r] : f.ids[r] + k * stride;
      const so = r * w, d = o * outW;
      if (w === 1) values[d] = f.values[so];
      else if (w === 2 || w === 3) {
        const v = [f.values[so], f.values[so + 1], w === 3 ? f.values[so + 2] : 0];
        for (let a = 0; a < 3; a++) values[d + a] = R[3 * a] * v[0] + R[3 * a + 1] * v[1] + R[3 * a + 2] * v[2];
      } else if (w === 9) {
        const T = Array.from(f.values.subarray(so, so + 9));
        const RT = new Array<number>(9).fill(0);
        for (let a = 0; a < 3; a++)
          for (let c = 0; c < 3; c++) for (let m = 0; m < 3; m++) RT[3 * a + c] += R[3 * a + m] * T[3 * m + c];
        for (let a = 0; a < 3; a++)
          for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let m = 0; m < 3; m++) s += RT[3 * a + m] * R[3 * c + m]; // times R^T
            values[d + 3 * a + c] = s;
          }
      } else {
        for (let c = 0; c < w; c++) values[d + c] = f.values[so + c];
        if (!warned) {
          warned = true;
          ctx.diagnostics.push(`Revolve: field ${f.variable} has ${w} components; its copies are not rotated (only 2/3-vectors and 3x3 tensors are).`);
        }
      }
      if (fixed && f.fixed) fixed[o] = f.fixed[r];
      o++;
    }
  }
  const out: FieldData = { ...f, components: outW, ids, values };
  if (fixed) out.fixed = fixed;
  else delete out.fixed;
  return carryFieldMeta(f, out);
}
