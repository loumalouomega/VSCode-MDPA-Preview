/**
 * Boundary flux field recovered from nodal reactions (roadmap item 45).
 *
 * Kratos reports reactions (`REACTION`, `REACTION_FLUX`) as nodal LOADS: they can
 * be summed but not seen as a per-area field. This recovers a nodal traction /
 * flux `t` on the faces of a SubModelPart by the consistent boundary-mass
 * projection  M t = F  (M the consistent mass matrix of the part's faces, F the
 * nodal reactions), solved per component by Jacobi-preconditioned CG. Dividing a
 * nodal load by a lumped area instead would show spots on a quadratic face,
 * where the corner loads of a uniform traction are zero.
 *
 * Because the shape functions are a partition of unity, the field's integral
 * over the WHOLE part, Σ t_i ∫N_i dA = 1ᵀ M t = 1ᵀ F, equals the reaction sum
 * exactly (to the CG tolerance). Over a subset of the faces it is the integral
 * of the recovered field, which equals that subset's own reactions only when the
 * cut does not split a node's load between the two sides.
 *
 * Faces: 3-node and 6-node triangles (consistent, straight-sided: the area is
 * taken from the corner nodes), 8-node (serendipity) and 9-node (Lagrange)
 * quadrilaterals (consistent, 3x3 Gauss on the bilinear map of the corner
 * nodes) and 4-node quadrilaterals (lumped: area/4 per node, an approximation
 * for non-parallelogram faces). Any other face is
 * refused by name. The result is a derived field, never written into the source
 * data, and is labelled as recovered.
 */
import type { FieldData, MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";
import { collectIds, findSubModelPart } from "./subModelPartExtract";

export interface RecoverFluxParams {
  /** SubModelPart (path) whose Conditions are the faces. */
  part: string;
  /** Nodal field of nodal loads (scalar or vector), e.g. REACTION or REACTION_FLUX. */
  variable: string;
  /** Output variable name (default `<variable>_RECOVERED`). */
  output?: string;
  /**
   * Refuse when a Nodal field named `output` already exists instead of replacing it. The viewer
   * sets it: its recovered field is display-only and must never shadow a real field.
   */
  refuseExisting?: boolean;
}

export interface RecoverFluxResult {
  model: MdpaModel;
  output: string;
  /** Faces used and nodes of the part. */
  faces: number;
  nodes: number;
  area: number;
  /** Σ of the supplied nodal loads, per component. */
  reactionSum: number[];
  /** Integral of the recovered field over the part, per component (equals `reactionSum`). */
  integral: number[];
  /** Largest relative difference between the two above, as a check. */
  integralError: number;
  iterations: number;
  residual: number;
  /** Min / max of the recovered value per component. */
  range: { min: number; max: number }[];
  /** Nodes of the part with no load value (counted as zero load, reported). */
  nodesWithoutLoad: number;
  message: string;
}

/** What the viewer needs: the report and the recovered field, never the model copy. */
export type RecoveredFlux = Omit<RecoverFluxResult, "model"> & { field: FieldData };

/** `recoverBoundaryFlux` for the viewer: refuses to shadow a field and drops the model copy. */
export function recoverBoundaryFluxField(model: MdpaModel, params: RecoverFluxParams): RecoveredFlux {
  const { model: out, ...report } = recoverBoundaryFlux(model, { ...params, refuseExisting: true });
  const field = out.fields.find((f) => f.kind === "Nodal" && f.variable === report.output)!;
  return { ...report, field };
}

// Radon 7-point rule, exact to degree 5 on a triangle (barycentric weights sum to 1).
const R = Math.sqrt(15);
const GAUSS: [number, number, number, number][] = [
  [1 / 3, 1 / 3, 1 / 3, 9 / 40],
  [(6 + R) / 21, (6 + R) / 21, (9 - 2 * R) / 21, (155 + R) / 1200],
  [(6 + R) / 21, (9 - 2 * R) / 21, (6 + R) / 21, (155 + R) / 1200],
  [(9 - 2 * R) / 21, (6 + R) / 21, (6 + R) / 21, (155 + R) / 1200],
  [(6 - R) / 21, (6 - R) / 21, (9 + 2 * R) / 21, (155 - R) / 1200],
  [(6 - R) / 21, (9 + 2 * R) / 21, (6 - R) / 21, (155 - R) / 1200],
  [(9 + 2 * R) / 21, (6 - R) / 21, (6 - R) / 21, (155 - R) / 1200],
];

/** Shape functions at barycentric (l1,l2,l3): P1 (3) or P2 (6; mids 3:(0,1) 4:(1,2) 5:(2,0)). */
function shapes(n: 3 | 6, l: number[]): number[] {
  if (n === 3) return [l[0], l[1], l[2]];
  return [l[0] * (2 * l[0] - 1), l[1] * (2 * l[1] - 1), l[2] * (2 * l[2] - 1), 4 * l[0] * l[1], 4 * l[1] * l[2], 4 * l[2] * l[0]];
}

// 3x3 Gauss rule on [-1,1]^2 and the quadrilateral shape functions (VTK order: corners, then mids
// 4:(0,-1) 5:(1,0) 6:(0,1) 7:(-1,0), then the centre 8).
const G1 = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)];
const GW = [5 / 9, 8 / 9, 5 / 9];
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
function quadShapes(n: 8 | 9, xi: number, eta: number): number[] {
  const L = (k: -1 | 0 | 1, t: number): number => (k === -1 ? (t * (t - 1)) / 2 : k === 0 ? 1 - t * t : (t * (t + 1)) / 2);
  if (n === 9) {
    const ks: [number, number][] = [...CORNERS, [0, -1], [1, 0], [0, 1], [-1, 0], [0, 0]];
    return ks.map(([a, b]) => L(a as -1 | 0 | 1, xi) * L(b as -1 | 0 | 1, eta));
  }
  const out: number[] = CORNERS.map(([a, b]) => 0.25 * (1 + xi * a) * (1 + eta * b) * (xi * a + eta * b - 1));
  out.push(0.5 * (1 - xi * xi) * (1 - eta), 0.5 * (1 + xi) * (1 - eta * eta), 0.5 * (1 - xi * xi) * (1 + eta), 0.5 * (1 - xi) * (1 - eta * eta));
  return out;
}

const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function recoverBoundaryFlux(model: MdpaModel, params: RecoverFluxParams): RecoverFluxResult {
  const part = findSubModelPart(model, params.part);
  if (!part) throw new Error(`No SubModelPart "${params.part}".`);
  const load = model.fields.find((f) => f.kind === "Nodal" && f.variable === params.variable);
  if (!load) throw new Error(`No Nodal field "${params.variable}" (the nodal reactions to recover a flux from).`);
  const wanted = params.output ?? `${params.variable}_RECOVERED`;
  if (params.refuseExisting && model.fields.some((f) => f.kind === "Nodal" && f.variable === wanted)) {
    throw new Error(`A Nodal field named "${wanted}" already exists; choose another output name.`);
  }
  const comps = load.components;
  const loadRow = new Map<number, number>();
  for (let i = 0; i < load.ids.length; i++) loadRow.set(load.ids[i], i);

  const sets = { elements: new Set<number>(), conditions: new Set<number>(), geometries: new Set<number>(), nodes: new Set<number>() };
  collectIds(part, sets);
  const coordIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) coordIndex.set(model.nodeIds[i], i);
  const xyz = (id: number): number[] => {
    const i = coordIndex.get(id)!;
    return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
  };

  interface Face { nodes: number[]; area: number; kind: "tri3" | "tri6" | "quad4" | "quad8" | "quad9"; corners?: number[][] }
  const faces: Face[] = [];
  const refused = new Set<string>();
  for (const b of model.blocks) {
    if (b.kind !== "Conditions") continue;
    const type = b.vtkCellType;
    const supported = type === VtkCellType.TRIANGLE || type === VtkCellType.QUADRATIC_TRIANGLE || type === VtkCellType.QUAD || type === VtkCellType.QUADRATIC_QUAD || type === VtkCellType.BIQUADRATIC_QUAD;
    for (let c = 0; c < b.count; c++) {
      if (!sets.conditions.has(b.entityIds[c])) continue;
      if (!supported) {
        refused.add(b.name);
        continue;
      }
      const ids = Array.from(b.connectivity.subarray(c * b.stride, (c + 1) * b.stride));
      if (ids.some((n) => !coordIndex.has(n))) continue;
      if (type === VtkCellType.QUADRATIC_QUAD || type === VtkCellType.BIQUADRATIC_QUAD) {
        const p = ids.slice(0, 4).map(xyz);
        const d1 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]], d2 = [p[3][0] - p[1][0], p[3][1] - p[1][1], p[3][2] - p[1][2]];
        const cr = cross(d1, d2);
        const need = type === VtkCellType.QUADRATIC_QUAD ? 8 : 9;
        if (ids.length < need) { refused.add(b.name); continue; }
        faces.push({ nodes: ids.slice(0, need), area: 0.5 * Math.hypot(cr[0], cr[1], cr[2]), kind: need === 8 ? "quad8" : "quad9", corners: p });
      } else if (type === VtkCellType.QUAD) {
        const p = ids.slice(0, 4).map(xyz);
        const d1 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]], d2 = [p[3][0] - p[1][0], p[3][1] - p[1][1], p[3][2] - p[1][2]];
        const cr = cross(d1, d2);
        faces.push({ nodes: ids.slice(0, 4), area: 0.5 * Math.hypot(cr[0], cr[1], cr[2]), kind: "quad4" });
      } else {
        const p = ids.slice(0, 3).map(xyz);
        const cr = cross([p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]]);
        faces.push({ nodes: ids, area: 0.5 * Math.hypot(cr[0], cr[1], cr[2]), kind: type === VtkCellType.TRIANGLE ? "tri3" : "tri6" });
      }
    }
  }
  if (refused.size > 0) throw new Error(`Boundary flux recovery handles 3/6-node triangles and 4/8/9-node quadrilaterals; "${[...refused].join('", "')}" in this part is another face type.`);
  if (faces.length === 0) throw new Error(`SubModelPart "${params.part}" has no surface Conditions to recover a flux on.`);

  // Local numbering of the part's nodes and the sparse consistent mass matrix.
  const local = new Map<number, number>();
  const order: number[] = [];
  for (const f of faces) for (const n of f.nodes) if (!local.has(n)) { local.set(n, order.length); order.push(n); }
  const N = order.length;
  const rows: Map<number, number>[] = Array.from({ length: N }, () => new Map());
  const weight = new Float64Array(N); // ∫N_i dA : row sums of M
  let totalArea = 0;
  for (const f of faces) {
    totalArea += f.area;
    const idx = f.nodes.map((n) => local.get(n)!);
    const add = (a: number, b: number, v: number): void => { rows[a].set(b, (rows[a].get(b) ?? 0) + v); };
    if (f.kind === "quad4") {
      for (const i of idx) { add(i, i, f.area / 4); weight[i] += f.area / 4; }
      continue;
    }
    if (f.kind === "quad8" || f.kind === "quad9") {
      const n = f.kind === "quad8" ? 8 : 9;
      const P = f.corners!;
      let area = 0;
      for (let gi = 0; gi < 3; gi++)
        for (let gj = 0; gj < 3; gj++) {
          const xi = G1[gi], eta = G1[gj];
          // Bilinear map of the corner nodes: tangent vectors and the area element |t_xi x t_eta|.
          const txi = [0, 1, 2].map((d) => 0.25 * CORNERS.reduce((a, [cx, cy], k) => a + cx * (1 + eta * cy) * P[k][d], 0));
          const teta = [0, 1, 2].map((d) => 0.25 * CORNERS.reduce((a, [cx, cy], k) => a + cy * (1 + xi * cx) * P[k][d], 0));
          const cr = cross(txi, teta);
          const dA = Math.hypot(cr[0], cr[1], cr[2]) * GW[gi] * GW[gj];
          area += dA;
          const s = quadShapes(n, xi, eta);
          for (let a = 0; a < n; a++) {
            weight[idx[a]] += dA * s[a];
            for (let b2 = 0; b2 < n; b2++) add(idx[a], idx[b2], dA * s[a] * s[b2]);
          }
        }
      totalArea += area - f.area; // the exact (bilinear) area replaces the diagonal estimate
      continue;
    }
    const n = f.kind === "tri3" ? 3 : 6;
    for (const [l1, l2, l3, w] of GAUSS) {
      const s = shapes(n, [l1, l2, l3]);
      for (let a = 0; a < n; a++) {
        weight[idx[a]] += f.area * w * s[a];
        for (let b = 0; b < n; b++) add(idx[a], idx[b], f.area * w * s[a] * s[b]);
      }
    }
  }
  // Jacobi-preconditioned CG per component.
  const diag = new Float64Array(N);
  for (let i = 0; i < N; i++) diag[i] = rows[i].get(i) ?? 0;
  const mul = (x: Float64Array, y: Float64Array): void => {
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const [j, v] of rows[i]) s += v * x[j];
      y[i] = s;
    }
  };
  let nodesWithoutLoad = 0;
  for (const n of order) if (!loadRow.has(n)) nodesWithoutLoad++;
  const sol: Float64Array[] = [];
  const reactionSum = new Array(comps).fill(0);
  let worstRes = 0, iterations = 0;
  for (let k = 0; k < comps; k++) {
    const b = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const r = loadRow.get(order[i]);
      b[i] = r === undefined ? 0 : load.values[r * comps + k];
      reactionSum[k] += b[i];
    }
    const x = new Float64Array(N), r = Float64Array.from(b), z = new Float64Array(N), p = new Float64Array(N), Ap = new Float64Array(N);
    const bnorm = Math.hypot(...b) || 1;
    for (let i = 0; i < N; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : 0; p[i] = z[i]; }
    let rz = 0;
    for (let i = 0; i < N; i++) rz += r[i] * z[i];
    let it = 0;
    for (; it < 5 * N + 50; it++) {
      if (Math.hypot(...r) / bnorm < 1e-14) break;
      mul(p, Ap);
      let pAp = 0;
      for (let i = 0; i < N; i++) pAp += p[i] * Ap[i];
      if (!(pAp > 0)) break;
      const alpha = rz / pAp;
      for (let i = 0; i < N; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
      let rzNew = 0;
      for (let i = 0; i < N; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : 0; rzNew += r[i] * z[i]; }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < N; i++) p[i] = z[i] + beta * p[i];
    }
    iterations = Math.max(iterations, it);
    worstRes = Math.max(worstRes, Math.hypot(...r) / bnorm);
    sol.push(x);
  }
  const integral = sol.map((x) => { let s = 0; for (let i = 0; i < N; i++) s += x[i] * weight[i]; return s; });
  let integralError = 0;
  for (let k = 0; k < comps; k++) integralError = Math.max(integralError, Math.abs(integral[k] - reactionSum[k]) / (Math.abs(reactionSum[k]) || 1));
  const output = params.output ?? `${params.variable}_RECOVERED`;
  const values = new Float64Array(N * comps);
  for (let i = 0; i < N; i++) for (let k = 0; k < comps; k++) values[i * comps + k] = sol[k][i];
  const field: FieldData = { kind: "Nodal", variable: output, components: comps, ids: Int32Array.from(order), values };
  const out: MdpaModel = { ...model, fields: [...model.fields.filter((f) => !(f.kind === "Nodal" && f.variable === output)), field] };
  const range = sol.map((x) => ({ min: Math.min(...x), max: Math.max(...x) }));
  return {
    model: out,
    output,
    faces: faces.length,
    nodes: N,
    area: totalArea,
    reactionSum,
    integral,
    integralError,
    iterations,
    residual: worstRes,
    range,
    nodesWithoutLoad,
    message:
      `Recovered ${output} on ${faces.length} face(s) of "${params.part}" (consistent boundary-mass projection of ${params.variable}; a derived field, labelled as recovered). ` +
      `Integral over the part equals the reaction sum to ${integralError.toExponential(1)} relative (${iterations} CG iterations).` +
      (nodesWithoutLoad > 0 ? ` ${nodesWithoutLoad} node(s) had no ${params.variable} value and carry zero load.` : ""),
  };
}
