import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIsoSurface } from "../parser/isoSurface";
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
