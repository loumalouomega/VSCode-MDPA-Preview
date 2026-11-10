import { test } from "node:test";
import assert from "node:assert";
import { computeSolverMetrics, SolverMetricKey } from "../parser/elementMetrics";
import { MdpaModel } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

function makeModel(nodes: number[][], vtkCellType: number, connectivity: number[]): MdpaModel {
  const coords = new Float32Array(nodes.length * 3);
  const nodeIds = new Int32Array(nodes.length);
  nodes.forEach((p, i) => {
    nodeIds[i] = i + 1;
    coords.set([p[0], p[1], p[2] ?? 0], i * 3);
  });
  return {
    nodeCount: nodes.length, nodeIds, coords,
    blocks: [{
      kind: "Elements", name: "E", vtkCellType, count: 1, stride: connectivity.length,
      entityIds: new Int32Array([7]), propertyIds: new Int32Array([0]),
      connectivity: new Int32Array(connectivity),
    }],
    subModelParts: [], meta: [], fields: [], diagnostics: [], is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}
const get = (m: MdpaModel, k: SolverMetricKey) => computeSolverMetrics(m, [k]).find((r) => r.key === k);
const close = (a: number, b: number, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

const CUBE = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const HEXCONN = [1,2,3,4,5,6,7,8];

test("unit cube reads scaled Jacobian 1, no skew, no warpage, no taper", () => {
  const m = makeModel(CUBE, VtkCellType.HEXAHEDRON, HEXCONN);
  close(get(m, "scaledJacobian")!.min, 1);
  close(get(m, "skewness")!.max, 0);
  close(get(m, "warpage")!.max, 0);
  close(get(m, "taper")!.max, 0);
});

test("a hexahedron with one corner pushed through reads a negative scaled Jacobian and is listed", () => {
  const nodes = CUBE.map((p) => p.slice());
  nodes[6] = [0.1, 0.1, 0.1]; // node 7 inside the cube
  const m = makeModel(nodes, VtkCellType.HEXAHEDRON, HEXCONN);
  const r = get(m, "scaledJacobian")!;
  assert.ok(r.min < 0);
  assert.deepStrictEqual(r.badEntityIds, [7]);
});

test("regular tetrahedron: scaled Jacobian 1 and radius ratio 1", () => {
  const s = Math.sqrt(2) / 2;
  const nodes = [[1, 0, -s], [-1, 0, -s], [0, 1, s], [0, -1, s]];
  // orient positively
  let m = makeModel(nodes, VtkCellType.TETRA, [1, 2, 3, 4]);
  let sj = get(m, "scaledJacobian")!;
  if (sj.min < 0) { m = makeModel(nodes, VtkCellType.TETRA, [1, 2, 4, 3]); sj = get(m, "scaledJacobian")!; }
  close(sj.min, 1, 1e-3);
  close(get(m, "radiusRatio")!.min, 1, 1e-3);
});

test("unit tetrahedron and wedge corners are positively oriented", () => {
  const tet = makeModel([[0,0,0],[1,0,0],[0,1,0],[0,0,1]], VtkCellType.TETRA, [1,2,3,4]);
  assert.ok(get(tet, "scaledJacobian")!.min > 0);
  const h = Math.sqrt(3) / 2;
  const wedge = makeModel([[0,0,0],[0.5,h,0],[1,0,0],[0,0,1],[0.5,h,1],[1,0,1]], VtkCellType.WEDGE, [1,2,3,4,5,6]);
  close(get(wedge, "scaledJacobian")!.min, 1, 1e-4);
});

test("quadratic tetrahedron: an inverted mid-side node is caught while its corners are valid", () => {
  const corners = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
  const mid = (a: number, b: number) => corners[a].map((v, i) => (v + corners[b][i]) / 2);
  const mids = [mid(0,1), mid(1,2), mid(2,0), mid(0,3), mid(1,3), mid(2,3)];
  const good = makeModel([...corners, ...mids], VtkCellType.QUADRATIC_TETRA, [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(get(good, "scaledJacobian")!.min > 0.5);
  const bent = mids.map((p) => p.slice());
  bent[0] = [-0.6, 0, 0]; // mid of edge 0-1 pushed behind corner 0
  const bad = makeModel([...corners, ...bent], VtkCellType.QUADRATIC_TETRA, [1,2,3,4,5,6,7,8,9,10]);
  assert.ok(get(bad, "scaledJacobian")!.min < 0);
});

test("quadrilateral: planar square is ideal, a bowtie is negative, a warped quad has warpage, a trapezoid has taper", () => {
  const sq = makeModel([[0,0,0],[1,0,0],[1,1,0],[0,1,0]], VtkCellType.QUAD, [1,2,3,4]);
  close(get(sq, "scaledJacobian")!.min, 1);
  close(get(sq, "warpage")!.max, 0);
  const warped = makeModel([[0,0,0],[1,0,0],[1,1,0.5],[0,1,0]], VtkCellType.QUAD, [1,2,3,4]);
  assert.ok(get(warped, "warpage")!.max > 20);
  const trap = makeModel([[0,0,0],[1,0,0],[0.75,1,0],[0.25,1,0]], VtkCellType.QUAD, [1,2,3,4]);
  close(get(trap, "taper")!.max, 0.5);
  const concave = makeModel([[0,0,0],[1,0,0],[0.2,0.2,0],[0,1,0]], VtkCellType.QUAD, [1,2,3,4]);
  assert.ok(get(concave, "scaledJacobian")!.min < 0);
});

test("equilateral triangle reads scaled Jacobian 1 and skewness 0", () => {
  const m = makeModel([[0,0,0],[1,0,0],[0.5,Math.sqrt(3)/2,0]], VtkCellType.TRIANGLE, [1,2,3]);
  close(get(m, "scaledJacobian")!.min, 1);
  close(get(m, "skewness")!.max, 0);
});

test("size versus block median flags the outlier", () => {
  const nodes = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[10,0,0],[0,10,0],[0,0,10]];
  const m = makeModel(nodes, VtkCellType.TETRA, [1,2,3,4]);
  const b = m.blocks[0];
  m.blocks[0] = { ...b, count: 3, stride: 4,
    entityIds: new Int32Array([1, 2, 3]), propertyIds: new Int32Array(3),
    connectivity: new Int32Array([1,2,3,4, 1,2,3,4, 1,5,6,7]) };
  const r = get(m, "volumeRatio")!;
  assert.deepStrictEqual(r.badEntityIds, [3]);
});

test("unrequested metrics are not computed", () => {
  const m = makeModel(CUBE, VtkCellType.HEXAHEDRON, HEXCONN);
  assert.deepStrictEqual(computeSolverMetrics(m, ["taper"]).map((r) => r.key), ["taper"]);
});
