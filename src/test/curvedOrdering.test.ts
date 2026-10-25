/**
 * Node-ordering audit for the curved display: a straight-sided quadratic cell
 * (every mid node exactly on its edge) must tessellate onto its own linear
 * surface. A mid-node index that disagrees with the VTK numbering moves a
 * point off that surface, so this fails on a wrong table row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDisplayGeometry, prepareNodes } from "../parser/render/displayGeometry";
import { VtkCellType as C } from "../parser/geometryMap";
import type { MdpaModel } from "../parser/types";

type P = number[];
const mid = (a: P, b: P): P => a.map((v, i) => (v + b[i]) / 2);
const avg = (ps: P[]): P => ps[0].map((_, i) => ps.reduce((s, p) => s + p[i], 0) / ps.length);

function build(pts: P[], cellType: number) {
  const prep = prepareNodes({ nodeCount: pts.length, nodeIds: pts.map((_, i) => i + 1), coords: new Float32Array(pts.flat()) } as unknown as MdpaModel);
  const g = buildDisplayGeometry(prep, [{ cellType, nodeIds: pts.map((_, i) => i + 1) }], undefined, { curved: { level: 2 } })!;
  const out: P[] = [];
  for (let i = 0; i < g.geometry.points.length; i += 3) out.push([g.geometry.points[i], g.geometry.points[i + 1], g.geometry.points[i + 2]]);
  return { out, polys: g.geometry.polys! };
}
const withMids = (corners: P[], edges: number[][]): P[] => [...corners, ...edges.map(([a, b]) => mid(corners[a], corners[b]))];
const near = (v: number, t: number) => Math.abs(v - t) < 1e-5;

test("tet10 stays on its four planes", () => {
  const pts = withMids([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]]);
  const { out } = build(pts, C.QUADRATIC_TETRA);
  for (const [x, y, z] of out) assert.ok(near(x, 0) || near(y, 0) || near(z, 0) || near(x + y + z, 1), `${x},${y},${z}`);
});

const cube: P[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const hexEdges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

test("hex20 and hex27 stay on the cube surface", () => {
  const h20 = withMids(cube, hexEdges);
  const faces = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
  const h27 = [...h20, ...faces.map((f) => avg(f.map((i) => cube[i]))), avg(cube)];
  for (const [pts, type] of [[h20, C.QUADRATIC_HEXAHEDRON], [h27, C.TRIQUADRATIC_HEXAHEDRON]] as const) {
    const { out } = build(pts as P[], type);
    for (const p of out) assert.ok(p.some((v) => near(v, 0) || near(v, 1)), String(p));
  }
});

test("wedge15 stays on the prism surface", () => {
  const c: P[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1]];
  const { out } = build(withMids(c, [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]]), C.QUADRATIC_WEDGE);
  for (const [x, y, z] of out) assert.ok(near(z, 0) || near(z, 1) || near(x, 0) || near(y, 0) || near(x + y, 1), `${x},${y},${z}`);
});

test("pyramid13 stays on the pyramid surface", () => {
  const c: P[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]];
  const { out } = build(withMids(c, [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]]), C.QUADRATIC_PYRAMID);
  for (const [x, y, z] of out) {
    assert.ok(near(z, 0) || near(y, z / 2) || near(x, 1 - z / 2) || near(y, 1 - z / 2) || near(x, z / 2), `${x},${y},${z}`);
  }
});

test("quad8, quad9 and tri6 stay in their plane and inside the cell", () => {
  const sq: P[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const q8 = withMids(sq, [[0, 1], [1, 2], [2, 3], [3, 0]]);
  for (const [pts, type] of [[q8, C.QUADRATIC_QUAD], [[...q8, [0.5, 0.5, 0]], C.BIQUADRATIC_QUAD]] as const) {
    const { out } = build(pts as P[], type);
    for (const [x, y, z] of out) assert.ok(near(z, 0) && x > -1e-6 && x < 1 + 1e-6 && y > -1e-6 && y < 1 + 1e-6);
  }
  const tri = withMids([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1], [1, 2], [2, 0]]);
  for (const [x, y, z] of build(tri, C.QUADRATIC_TRIANGLE).out) assert.ok(near(z, 0) && x >= -1e-6 && y >= -1e-6 && x + y <= 1 + 1e-6);
});

test("a cell with too few nodes falls back to its linear skeleton", () => {
  const prep = prepareNodes({ nodeCount: 4, nodeIds: [1, 2, 3, 4], coords: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]) } as unknown as MdpaModel);
  const g = buildDisplayGeometry(prep, [{ cellType: C.QUADRATIC_TETRA, nodeIds: [1, 2, 3, 4] }], undefined, { curved: { level: 2 } })!;
  assert.equal(g.geometry.polys!.length, 16);
});
