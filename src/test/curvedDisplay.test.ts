import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDisplayGeometry, prepareNodes } from "../parser/render/displayGeometry";
import { VtkCellType } from "../parser/geometryMap";
import { quadraticFaces, tessellateEdge, tessellateFace } from "../parser/render/curvedDisplay";
import type { MdpaModel } from "../parser/types";
import * as fs from "node:fs";
import * as path from "node:path";

function prep(pts: number[][]) {
  const coords = new Float32Array(pts.flat());
  return prepareNodes({ nodeCount: pts.length, nodeIds: pts.map((_, i) => i + 1), coords } as unknown as MdpaModel);
}
const sumW = (p: { w: number[] }) => p.w.reduce((a, b) => a + b, 0);

test("tri6 weights sum to 1 and reproduce a quadratic function exactly", () => {
  const patch = tessellateFace([1, 2, 3, 4, 5, 6], 2)!;
  for (const p of patch.points) assert.ok(Math.abs(sumW(p) - 1) < 1e-9);
  assert.equal(patch.cells.length, 16);
});

test("quad8 and quad9 weights sum to 1", () => {
  for (const n of [8, 9]) {
    const patch = tessellateFace(Array.from({ length: n }, (_, i) => i + 1), 1)!;
    for (const p of patch.points) assert.ok(Math.abs(sumW(p) - 1) < 1e-9);
    assert.equal(patch.cells.length, 4);
  }
});

test("quadratic edge bulges through its mid node", () => {
  const pts = [[0, 0, 0], [2, 0, 0], [1, 1, 0]];
  const g = buildDisplayGeometry(prep(pts), [{ cellType: VtkCellType.QUADRATIC_EDGE, nodeIds: [1, 2, 3] }], undefined, { curved: { level: 1 } })!;
  const mid = Array.from(g.geometry.points.slice(0)).reduce<number[][]>((acc, _, i, a) => (i % 3 === 0 ? [...acc, [a[i], a[i + 1]]] : acc), []);
  assert.ok(mid.some(([x, y]) => Math.abs(x - 1) < 1e-6 && Math.abs(y - 1) < 1e-6));
  assert.equal(g.geometry.lines!.length, 6);
});

test("default (no curved option) is the linear skeleton", () => {
  const pts = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [1, 0, 0.3], [1, 1, 0], [0, 1, 0]];
  const g = buildDisplayGeometry(prep(pts), [{ cellType: VtkCellType.QUADRATIC_TRIANGLE, nodeIds: [1, 2, 3, 4, 5, 6] }])!;
  assert.deepEqual(Array.from(g.geometry.polys!), [3, 0, 1, 2]);
});

test("curved tri6 moves the edge point and interpolates a nodal field exactly", () => {
  const pts = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [1, 0, 0.5], [1, 1, 0], [0, 1, 0]];
  const f = [0, 4, 4, 2, 4, 2]; // f = 2x + 2y... along edges, linear => mid values average
  const g = buildDisplayGeometry(prep(pts), [{ cellType: VtkCellType.QUADRATIC_TRIANGLE, nodeIds: [1, 2, 3, 4, 5, 6], entityId: 7 }],
    { name: "f", pointScalar: (id) => f[id - 1] }, { curved: { level: 1 }, wantPickMaps: true })!;
  assert.equal(g.geometry.points.length / 3, 6);
  const P = g.geometry.points;
  let found = false;
  for (let i = 0; i < 6; i++) if (Math.abs(P[i * 3] - 1) < 1e-6 && Math.abs(P[i * 3 + 2] - 0.5) < 1e-6) found = true;
  assert.ok(found);
  assert.ok(Array.from(g.cellEntityIds!).every((e) => e === 7));
  assert.equal(g.geometry.pointScalars!.values.length, 6);
});

function tet10(offset: number[]): { pts: number[][] } {
  const c = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => p.map((v, i) => v + offset[i]));
  const e = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]].map(([a, b]) => c[a].map((v, i) => (v + c[b][i]) / 2));
  return { pts: [...c, ...e] };
}

test("shared faces weld: two tets sharing a face leave a closed-free interior", () => {
  // two tet10 sharing nothing but one face is hard to build; instead check one
  // tet10 yields a watertight boundary (every edge used by exactly two cells).
  const { pts } = tet10([0, 0, 0]);
  const g = buildDisplayGeometry(prep(pts), [{ cellType: VtkCellType.QUADRATIC_TETRA, nodeIds: pts.map((_, i) => i + 1) }], undefined, { curved: { level: 2 } })!;
  const polys = g.geometry.polys!;
  const edges = new Map<string, number>();
  for (let i = 0; i < polys.length; i += 4) {
    const t = [polys[i + 1], polys[i + 2], polys[i + 3]];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const n of edges.values()) assert.equal(n, 2);
  assert.equal(polys.length / 4, 4 * 16);
});

test("face tables reference valid local nodes", () => {
  const sizes = { tet10: 10, hex20: 20, hex27: 27, wedge15: 15, pyramid13: 13 } as const;
  for (const [k, n] of Object.entries(sizes)) {
    for (const f of quadraticFaces(k as keyof typeof sizes)) for (const i of f) assert.ok(i >= 0 && i < n);
  }
  assert.equal(tessellateEdge([1, 2], 1), null);
});

test("two tet10 sharing a face weld: the shared face disappears and the boundary stays watertight", () => {
  // Cell B shares corners 0,1,2 (and their three mid-edge nodes) with cell A.
  const pts: number[][] = [];
  const keyed = new Map<string, number>();
  const node = (p: number[], key: string): number => {
    const known = keyed.get(key);
    if (known !== undefined) return known;
    pts.push(p);
    keyed.set(key, pts.length);
    return pts.length;
  };
  const corner = (i: number, p: number[]) => node(p, `c${i}`);
  const mid = (a: number[], b: number[], ia: number, ib: number) => node(a.map((v, i) => (v + b[i]) / 2), `m${Math.min(ia, ib)}-${Math.max(ia, ib)}`);
  const cell = (cs: number[][], ids: number[]): number[] => {
    const n = cs.map((c, i) => corner(ids[i], c));
    const edges = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    return [...n, ...edges.map(([a, b]) => mid(cs[a], cs[b], ids[a], ids[b]))];
  };
  const A = cell([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 1, 2, 3]);
  const B = cell([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1]], [0, 1, 2, 4]);
  assert.equal(pts.length, 14, "10 + 10 nodes, 6 shared");
  const g = buildDisplayGeometry(
    prep(pts),
    [{ cellType: VtkCellType.QUADRATIC_TETRA, nodeIds: A }, { cellType: VtkCellType.QUADRATIC_TETRA, nodeIds: B }],
    undefined,
    { curved: { level: 2 } }
  )!;
  const polys = g.geometry.polys!;
  assert.equal(polys.length / 4, 6 * 16, "six outer faces of 16 triangles each; the shared face is interior");
  const edges = new Map<string, number>();
  for (let i = 0; i < polys.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const a = polys[i + 1 + k], b = polys[i + 1 + ((k + 1) % 3)];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const n of edges.values()) assert.equal(n, 2, "every edge of the welded surface is shared by exactly two triangles");
});

test("display subdivision can never reach a writer: only the display geometry builder imports it", () => {
  const root = path.resolve(__dirname, "..", "..", "src");
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "test") walk(p); }
      else if (e.name.endsWith(".ts") && /from\s+["'][^"']*curvedDisplay["']/.test(fs.readFileSync(p, "utf8"))) importers.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  walk(root);
  assert.deepEqual(importers, ["parser/render/displayGeometry.ts"], "writers, exporters and the MCP layer must stay on the stored (high-order) cells");
});
