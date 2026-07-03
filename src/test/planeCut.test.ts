import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlaneCut } from "../parser/planeCut";
import { MdpaModel } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

function model(
  nodes: [number, number, number, number][], // id, x, y, z
  vtkCellType: number,
  connectivity: number[][] // one entry per cell (corner node ids)
): MdpaModel {
  const nodeIds = new Int32Array(nodes.map((n) => n[0]));
  const coords = new Float32Array(nodes.length * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nodes.length; i++) {
    for (let k = 0; k < 3; k++) {
      const c = nodes[i][k + 1];
      coords[i * 3 + k] = c;
      if (c < min[k]) min[k] = c;
      if (c > max[k]) max[k] = c;
    }
  }
  const stride = connectivity[0].length;
  const flat: number[] = [];
  const entityIds: number[] = [];
  connectivity.forEach((c, i) => {
    entityIds.push(i + 1);
    flat.push(...c);
  });
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
    fields: [],
    diagnostics: [],
    is3D: vtkCellType >= VtkCellType.TETRA,
    bounds: { min, max },
  };
}

function approx(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

// Unit tet: nodes 1-4 at origin/x/y/z.
const TET_NODES: [number, number, number, number][] = [
  [1, 0, 0, 0],
  [2, 1, 0, 0],
  [3, 0, 1, 0],
  [4, 0, 0, 1],
];

test("single tet, 1-3 split: one triangle at edge midpoints", () => {
  const m = model(TET_NODES, VtkCellType.TETRA, [[1, 2, 3, 4]]);
  const r = computePlaneCut(m, [0, 0, 0.5], [0, 0, 1]);
  assert.equal(r.polyCount, 1);
  assert.equal(r.polys[0], 3, "triangle polygon");
  assert.equal(r.points.length, 9, "three welded points");
  assert.deepEqual([...r.cellIds], [1]);
  // The plane z=0.5 crosses the three edges to node 4 at their midpoints.
  for (let k = 0; k < 3; k++) {
    assert.equal(r.edgeNodeB[k], 4);
    assert.ok(approx(r.edgeT[k], 0.5), `edgeT ~ 0.5, got ${r.edgeT[k]}`);
  }
  const pts = new Set<string>();
  for (let i = 0; i < 3; i++) {
    pts.add(`${r.points[i * 3].toFixed(3)},${r.points[i * 3 + 1].toFixed(3)},${r.points[i * 3 + 2].toFixed(3)}`);
  }
  assert.ok(pts.has("0.000,0.000,0.500"));
  assert.ok(pts.has("0.500,0.000,0.500"));
  assert.ok(pts.has("0.000,0.500,0.500"));
});

test("single tet, 2-2 split: one quad polygon, not two triangles", () => {
  const m = model(TET_NODES, VtkCellType.TETRA, [[1, 2, 3, 4]]);
  // Plane x + z = 0.5 puts nodes {2, 4} on one side and {1, 3} on the other,
  // crossing four edges → a single quad.
  const invSqrt2 = 1 / Math.SQRT2;
  const r = computePlaneCut(m, [0.5, 0, 0], [invSqrt2, 0, invSqrt2]);
  assert.equal(r.polyCount, 1);
  assert.equal(r.polys[0], 4, "quad polygon");
  assert.equal(r.points.length, 12, "four crossing points");
});

test("two adjacent tets: crossing points weld on the shared face edges", () => {
  // Tets 1-2-3-4 and 2-3-4-5 share face 2-3-4.
  const nodes: [number, number, number, number][] = [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 0, 1, 0],
    [4, 0, 0, 1],
    [5, 1, 1, 1],
  ];
  const m = model(nodes, VtkCellType.TETRA, [
    [1, 2, 3, 4],
    [2, 3, 4, 5],
  ]);
  const r = computePlaneCut(m, [0, 0, 0.5], [0, 0, 1]);
  assert.equal(r.polyCount, 2);
  // Tet 1 cuts edges 1-4, 2-4, 3-4 (3 pts); tet 2 cuts 2-4, 3-4 (shared) and
  // 2-5, 3-5 (new) → 5 distinct welded points, not 3 + 4.
  assert.equal(r.points.length / 3, 5);
});

test("unit hex cut at z=0.5: one quad with area 1, CCW around +normal", () => {
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
  const m = model(nodes, VtkCellType.HEXAHEDRON, [[1, 2, 3, 4, 5, 6, 7, 8]]);
  const r = computePlaneCut(m, [0, 0, 0.5], [0, 0, 1]);
  assert.equal(r.polyCount, 1);
  assert.equal(r.polys[0], 4, "single 4-gon (no fan triangles)");
  // All points at z = 0.5, and shoelace area in the xy-plane is +1 (CCW).
  let area2 = 0;
  for (let e = 0; e < 4; e++) {
    const a = r.polys[1 + e] * 3;
    const b = r.polys[1 + ((e + 1) % 4)] * 3;
    assert.ok(approx(r.points[a + 2], 0.5));
    area2 += r.points[a] * r.points[b + 1] - r.points[b] * r.points[a + 1];
  }
  assert.ok(approx(area2 / 2, 1), `area = 1, got ${area2 / 2}`);
});

test("plane coincident with a tet face: no polygon, no crash", () => {
  const m = model(TET_NODES, VtkCellType.TETRA, [[1, 2, 3, 4]]);
  const r = computePlaneCut(m, [0, 0, 0], [0, 0, 1]);
  assert.equal(r.polyCount, 0);
  assert.equal(r.polys.length, 0);
});

test("plane missing the mesh: empty result", () => {
  const m = model(TET_NODES, VtkCellType.TETRA, [[1, 2, 3, 4]]);
  const r = computePlaneCut(m, [0, 0, 2], [0, 0, 1]);
  assert.equal(r.polyCount, 0);
  assert.equal(r.points.length, 0);
  assert.equal(r.cellIds.length, 0);
});

test("surface-only mesh: empty result (GPU clip is enough for 2D)", () => {
  const m = model(
    [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
    ],
    VtkCellType.TRIANGLE,
    [[1, 2, 3]]
  );
  const r = computePlaneCut(m, [0.5, 0, 0], [1, 0, 0]);
  assert.equal(r.polyCount, 0);
});

test("point edge data reconstructs the crossing coordinates", () => {
  const nodes: [number, number, number, number][] = [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 0, 1, 0],
    [4, 0, 0, 1],
    [5, 1, 1, 1],
  ];
  const m = model(nodes, VtkCellType.TETRA, [
    [1, 2, 3, 4],
    [2, 3, 4, 5],
  ]);
  const r = computePlaneCut(m, [0, 0, 0.37], [0, 0, 1]);
  const coordOf = new Map(nodes.map((n) => [n[0], [n[1], n[2], n[3]]]));
  for (let k = 0; k < r.points.length / 3; k++) {
    const a = coordOf.get(r.edgeNodeA[k])!;
    const b = coordOf.get(r.edgeNodeB[k])!;
    const t = r.edgeT[k];
    for (let c = 0; c < 3; c++) {
      assert.ok(approx(a[c] + t * (b[c] - a[c]), r.points[k * 3 + c]));
    }
  }
});
