import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIsoSurface, quadraticDecomposition } from "../parser/isoSurface";
import { FieldData, MdpaModel } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

function model(
  nodes: [number, number, number, number][], // id, x, y, z
  vtkCellType: number,
  connectivity: number[][], // one entry per cell (corner node ids)
  values: Map<number, number>
): MdpaModel {
  const nodeIds = new Int32Array(nodes.map((n) => n[0]));
  const coords = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    coords[i * 3] = nodes[i][1];
    coords[i * 3 + 1] = nodes[i][2];
    coords[i * 3 + 2] = nodes[i][3];
  }
  const stride = connectivity[0].length;
  const flat: number[] = [];
  const entityIds: number[] = [];
  connectivity.forEach((c, i) => {
    entityIds.push(i + 1);
    flat.push(...c);
  });
  const field: FieldData = {
    kind: "Nodal",
    variable: "F",
    components: 1,
    ids: new Int32Array([...values.keys()]),
    values: new Float64Array([...values.values()]),
  };
  return {
    nodeCount: nodes.length,
    nodeIds,
    coords,
    blocks: [
      {
        kind: "Elements",
        name: "E",
        vtkCellType,
        count: connectivity.length,
        stride,
        entityIds: new Int32Array(entityIds),
        propertyIds: new Int32Array(connectivity.length),
        connectivity: new Int32Array(flat),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [field],
    diagnostics: [],
    is3D: vtkCellType >= VtkCellType.TETRA,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

function approx(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

test("single tetra: one triangle at the edge midpoints", () => {
  const m = model(
    [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
      [4, 0, 0, 1],
    ],
    VtkCellType.TETRA,
    [[1, 2, 3, 4]],
    new Map([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
    ])
  );
  const r = computeIsoSurface(m, m.fields[0], 0.5);
  assert.equal(r.is2D, false);
  assert.equal(r.triangles.length, 3, "one triangle");
  assert.equal(r.points.length, 9, "three welded points");
  // Each crossing point sits at the midpoint of an edge to node 4.
  const pts = new Set<string>();
  for (let i = 0; i < 3; i++) {
    pts.add(`${r.points[i * 3].toFixed(3)},${r.points[i * 3 + 1].toFixed(3)},${r.points[i * 3 + 2].toFixed(3)}`);
  }
  assert.ok(pts.has("0.000,0.000,0.500"));
  assert.ok(pts.has("0.500,0.000,0.500"));
  assert.ok(pts.has("0.000,0.500,0.500"));
});

test("hexahedron with a linear ramp: planar isosurface at x = 0.5", () => {
  const nodes: [number, number, number, number][] = [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 1, 1, 0],
    [4, 0, 1, 0],
    [5, 0, 0, 1],
    [6, 1, 0, 1],
    [7, 1, 1, 1],
    [8, 0, 1, 1],
  ];
  const values = new Map<number, number>();
  for (const n of nodes) values.set(n[0], n[1]); // ramp = x
  const m = model(nodes, VtkCellType.HEXAHEDRON, [[1, 2, 3, 4, 5, 6, 7, 8]], values);
  const r = computeIsoSurface(m, m.fields[0], 0.5);
  assert.equal(r.is2D, false);
  assert.ok(r.triangles.length > 0, "produces triangles");
  for (let i = 0; i < r.points.length; i += 3) {
    assert.ok(approx(r.points[i], 0.5), `point x ${r.points[i]} should equal 0.5`);
  }
});

test("2D triangle: one iso-line segment", () => {
  const m = model(
    [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
    ],
    VtkCellType.TRIANGLE,
    [[1, 2, 3]],
    new Map([
      [1, 0],
      [2, 1],
      [3, 0],
    ])
  );
  const r = computeIsoSurface(m, m.fields[0], 0.5);
  assert.equal(r.is2D, true);
  assert.equal(r.lines.length, 2, "one segment");
  assert.equal(r.triangles.length, 0);
  assert.equal(r.points.length, 6, "two crossing points");
});

test("iso value outside the data range yields nothing", () => {
  const m = model(
    [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
      [4, 0, 0, 1],
    ],
    VtkCellType.TETRA,
    [[1, 2, 3, 4]],
    new Map([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
    ])
  );
  const r = computeIsoSurface(m, m.fields[0], 99);
  assert.equal(r.triangles.length, 0);
  assert.equal(r.points.length, 0);
});

// --- quadratic cells (roadmap item 38) -------------------------------------------

const TET10_NODES: [number, number, number, number][] = [
  [1, 0, 0, 0], [2, 1, 0, 0], [3, 0, 1, 0], [4, 0, 0, 1],
  [5, 0.5, 0, 0], [6, 0.5, 0.5, 0], [7, 0, 0.5, 0], [8, 0, 0, 0.5], [9, 0.5, 0, 0.5], [10, 0, 0.5, 0.5],
];

test("tet10 with a field quadratic in x: the isosurface lies on the analytic plane, the corner-only one does not", () => {
  const values = new Map<number, number>();
  for (const [id, x] of TET10_NODES) values.set(id, x * x);
  const quad = model(TET10_NODES, VtkCellType.QUADRATIC_TETRA, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], values);
  const r = computeIsoSurface(quad, quad.fields[0], 0.25);
  assert.ok(r.triangles.length >= 3);
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 0.5, 5e-3), `x=${r.points[i]}`);

  // The same cell treated as linear (corner nodes only) puts the plane at x = 0.25.
  const linear = model(TET10_NODES.slice(0, 4), VtkCellType.TETRA, [[1, 2, 3, 4]], new Map([[1, 0], [2, 1], [3, 0], [4, 0]]));
  const corner = computeIsoSurface(linear, linear.fields[0], 0.25);
  for (let i = 0; i < corner.points.length; i += 3) assert.ok(Math.abs(corner.points[i] - 0.5) > 0.2);
});

test("tri6 iso-lines follow the mid-side values", () => {
  const nodes: [number, number, number, number][] = [
    [1, 0, 0, 0], [2, 1, 0, 0], [3, 0, 1, 0], [4, 0.5, 0, 0], [5, 0.5, 0.5, 0], [6, 0, 0.5, 0],
  ];
  const values = new Map<number, number>(nodes.map(([id, x]) => [id, x * x]));
  const m = model(nodes, VtkCellType.QUADRATIC_TRIANGLE, [[1, 2, 3, 4, 5, 6]], values);
  const r = computeIsoSurface(m, m.fields[0], 0.25);
  assert.equal(r.is2D, true);
  assert.ok(r.lines.length >= 2);
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 0.5, 5e-3));
});

test("quad9 and hex27: iso-lines / isosurface follow a field quadratic in x", () => {
  // Biquadratic quad on [0,2]x[0,2]: nodes in VTK order.
  const q: [number, number, number, number][] = [
    [1, 0, 0, 0], [2, 2, 0, 0], [3, 2, 2, 0], [4, 0, 2, 0],
    [5, 1, 0, 0], [6, 2, 1, 0], [7, 1, 2, 0], [8, 0, 1, 0], [9, 1, 1, 0],
  ];
  const vals = new Map<number, number>(q.map(([id, x]) => [id, x * x]));
  const m = model(q, VtkCellType.BIQUADRATIC_QUAD, [[1, 2, 3, 4, 5, 6, 7, 8, 9]], vals);
  const r = computeIsoSurface(m, m.fields[0], 1); // x^2 = 1 -> x = 1
  assert.equal(r.is2D, true);
  assert.ok(r.lines.length >= 2);
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 1, 1e-4), `x=${r.points[i]}`);

  // Triquadratic hexahedron on [0,2]^3 built from the same parametric table.
  const P = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 0, 2], [2, 0, 2], [2, 2, 2], [0, 2, 2]];
  const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const F = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
  const avg = (ids: number[]): number[] => [0, 1, 2].map((d) => ids.reduce((a, c) => a + P[c][d], 0) / ids.length);
  const pts = [...P, ...E.map((e) => avg(e)), ...F.map((f) => avg(f)), [1, 1, 1]];
  const nodes = pts.map((p, i) => [i + 1, p[0], p[1], p[2]] as [number, number, number, number]);
  const hv = new Map<number, number>(nodes.map(([id, x]) => [id, x * x]));
  const h = model(nodes, VtkCellType.TRIQUADRATIC_HEXAHEDRON, [nodes.map((n) => n[0])], hv);
  const s = computeIsoSurface(h, h.fields[0], 1);
  assert.equal(s.is2D, false);
  assert.ok(s.triangles.length >= 3);
  for (let i = 0; i < s.points.length; i += 3) assert.ok(approx(s.points[i], 1, 1e-4), `x=${s.points[i]}`);
});

// --- 20-node hexahedra, 8-node quads, 15-node wedges (virtual centres) ---------------

type N4 = [number, number, number, number];
const avgOf = (P: number[][], ids: number[]): number[] => [0, 1, 2].map((d) => ids.reduce((a, c) => a + P[c][d], 0) / ids.length);
const withIds = (pts: number[][]): N4[] => pts.map((p, i) => [i + 1, p[0], p[1], p[2]] as N4);
const ids = (nodes: N4[]): number[] => nodes.map((n) => n[0]);
const xSquared = (nodes: N4[]): Map<number, number> => new Map(nodes.map(([id, x]) => [id, x * x]));

const HEX_P = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 0, 2], [2, 0, 2], [2, 2, 2], [0, 2, 2]];
const HEX_E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const HEX20 = withIds([...HEX_P, ...HEX_E.map((e) => avgOf(HEX_P, e))]);

test("hex20: the isosurface follows a field quadratic in x; the corner-only one does not", () => {
  const h = model(HEX20, VtkCellType.QUADRATIC_HEXAHEDRON, [ids(HEX20)], xSquared(HEX20));
  const r = computeIsoSurface(h, h.fields[0], 1);
  assert.equal(r.is2D, false);
  assert.ok(r.triangles.length >= 3);
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 1, 1e-4), `x=${r.points[i]}`);

  const corners = HEX20.slice(0, 8);
  const lin = model(corners, VtkCellType.HEXAHEDRON, [ids(corners)], xSquared(corners));
  const c = computeIsoSurface(lin, lin.fields[0], 1);
  assert.ok(Math.abs(c.points[0] - 1) > 0.2);
});

test("quad8: iso-lines follow a field quadratic in x", () => {
  const Q = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  const nodes = withIds([...Q, ...[[0, 1], [1, 2], [2, 3], [3, 0]].map((e) => avgOf(Q, e))]);
  const m = model(nodes, VtkCellType.QUADRATIC_QUAD, [ids(nodes)], xSquared(nodes));
  const r = computeIsoSurface(m, m.fields[0], 1);
  assert.equal(r.is2D, true);
  assert.ok(r.lines.length >= 2);
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 1, 1e-4), `x=${r.points[i]}`);
});

test("wedge15: the isosurface follows a field quadratic in x", () => {
  const W = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2], [2, 0, 2], [0, 2, 2]];
  const mids = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]].map((e) => avgOf(W, e));
  const nodes = withIds([...W, ...mids]);
  const m = model(nodes, VtkCellType.QUADRATIC_WEDGE, [ids(nodes)], xSquared(nodes));
  const r = computeIsoSurface(m, m.fields[0], 1);
  assert.equal(r.is2D, false);
  assert.ok(r.triangles.length >= 3);
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 1, 1e-4), `x=${r.points[i]}`);
});

test("virtual centres: weights sum to 1, and linear types have no quadratic decomposition", () => {
  for (const [type, stride] of [
    [VtkCellType.QUADRATIC_HEXAHEDRON, 20], [VtkCellType.QUADRATIC_QUAD, 8], [VtkCellType.QUADRATIC_WEDGE, 15],
  ] as [number, number][]) {
    const d = quadraticDecomposition(type, stride)!;
    assert.ok(d.virtuals && d.virtuals.length > 0);
    for (const v of d.virtuals) assert.ok(approx(v.weights.reduce((a, b) => a + b, 0), 1, 1e-12));
  }
  assert.equal(quadraticDecomposition(VtkCellType.HEXAHEDRON, 8), undefined);
  assert.equal(quadraticDecomposition(VtkCellType.WEDGE, 6), undefined);
  assert.equal(quadraticDecomposition(VtkCellType.QUAD, 4), undefined);
});

test("two hex20 cells sharing a face weld their shared centre: no duplicated points", () => {
  const key = (p: number[]): string => p.map((v) => v.toFixed(6)).join(",");
  const upper = HEX_P.map((p) => [p[0], p[1], p[2] + 2]);
  const upperAll = [...upper, ...HEX_E.map((e) => avgOf(upper, e))];
  const pts: number[][] = [];
  const index = new Map<string, number>();
  const conn = (all: number[][]): number[] =>
    all.map((p) => {
      const k = key(p);
      if (!index.has(k)) {
        index.set(k, pts.length + 1);
        pts.push(p);
      }
      return index.get(k)!;
    });
  const c1 = conn([...HEX_P, ...HEX_E.map((e) => avgOf(HEX_P, e))]);
  const c2 = conn(upperAll);
  const nodes = withIds(pts);
  const m = model(nodes, VtkCellType.QUADRATIC_HEXAHEDRON, [c1, c2], xSquared(nodes));
  const r = computeIsoSurface(m, m.fields[0], 2); // no node sits on the level, so equal coordinates can only mean a missed weld
  assert.ok(r.triangles.length >= 6);
  const seen = new Set<string>();
  for (let i = 0; i < r.points.length; i += 3) seen.add(key([r.points[i], r.points[i + 1], r.points[i + 2]]));
  assert.equal(seen.size, r.points.length / 3, "every crossing point is unique");
});

test("pyramid13 with a field quadratic in x: the isosurface lies on the analytic plane and the sub-cells tile the pyramid", () => {
  // Unit-square base at z = 0, apex above its centre; VTK node order (corners, base mids, apex mids).
  const P: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]];
  const mids = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]].map(([a, b]) => P[a].map((v, d) => (v + P[b][d]) / 2) as [number, number, number]);
  const all = [...P, ...mids];
  const nodes = all.map(([x, y, z], i) => [i + 1, x, y, z] as [number, number, number, number]);
  const values = new Map<number, number>(nodes.map(([id, x]) => [id, x * x]));
  const m = model(nodes, VtkCellType.QUADRATIC_PYRAMID, [nodes.map((n) => n[0])], values);
  const r = computeIsoSurface(m, m.fields[0], 0.25);
  assert.ok(r.triangles.length >= 3);
  // Level-1 subdivision is approximate where a sub-cell edge has no node at the crossing (an apex-level
  // edge here): within 0.07 of the plane, against 0.25 off for the corner-only surface.
  for (let i = 0; i < r.points.length; i += 3) assert.ok(approx(r.points[i], 0.5, 0.07), `x=${r.points[i]}`);
  // Volume of the sub-cells = the pyramid volume (1/3): sum the unsigned tet volumes of the decomposition.
  const dec = quadraticDecomposition(VtkCellType.QUADRATIC_PYRAMID, 13)!;
  const pos = [...all, [0.5, 0.5, 0]];
  const vol = (t: number[]): number => {
    const [a, b, c, d] = t.map((k) => pos[k]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    return Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
  };
  const total = dec.tets!.reduce((s, t) => s + vol(t), 0);
  assert.ok(approx(total, 1 / 3, 1e-9), `sub-cell volume ${total}`);
});
