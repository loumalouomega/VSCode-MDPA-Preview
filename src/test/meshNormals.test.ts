/**
 * Face normals + the inverted-element check (Advanced ▸ Normals).
 *
 * Pure — no wasm. The property that matters is the one the feature exists for:
 * a cell wound the wrong way must be *detectable*, not merely drawn.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeMeshNormals } from "../parser/meshNormals";
import { EntityBlock, MdpaModel } from "../parser/types";

function mesh(coords: number[], blocks: EntityBlock[]): MdpaModel {
  const n = Math.floor(coords.length / 3);
  return {
    nodeCount: n,
    nodeIds: Int32Array.from({ length: n }, (_, i) => i + 1),
    coords: Float32Array.from(coords),
    blocks,
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

function tris(conn: number[], ids: number[]): EntityBlock {
  return {
    kind: "Elements",
    name: "triangle",
    vtkCellType: 5,
    count: ids.length,
    stride: 3,
    entityIds: Int32Array.from(ids),
    connectivity: Int32Array.from(conn),
  };
}

/** Two triangles of the unit square in the z = 0 plane, both counter-clockwise. */
const SQUARE = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];

test("a flat CCW triangle's normal is +Z and unit length", () => {
  const m = mesh(SQUARE, [tris([1, 2, 3], [1])]);
  const r = computeMeshNormals(m);
  assert.equal(r.count, 1);
  assert.deepEqual(Array.from(r.normals), [0, 0, 1]);
  // Centroid of (0,0,0), (1,0,0), (1,1,0).
  assert.ok(Math.abs(r.centroids[0] - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.centroids[1] - 1 / 3) < 1e-9);
});

test("reversing the winding flips the normal", () => {
  const r = computeMeshNormals(mesh(SQUARE, [tris([3, 2, 1], [1])]));
  assert.deepEqual(Array.from(r.normals), [-0, -0, -1].map((v) => v + 0));
});

test("a consistently wound pair reports no inconsistency", () => {
  // 1-2-3 and 1-3-4 traverse the shared edge 1-3 in opposite directions.
  const m = mesh(SQUARE, [tris([1, 2, 3, 1, 3, 4], [1, 2])]);
  const r = computeMeshNormals(m);
  assert.equal(r.count, 2);
  assert.equal(r.inconsistent, 0);
  assert.deepEqual(r.inconsistentIds, []);
});

test("an INVERTED element is detected and named", () => {
  // The whole point of the feature: triangle 2 is wound the wrong way, so both
  // faces traverse the shared edge 1->3 in the SAME direction.
  const m = mesh(SQUARE, [tris([1, 2, 3, 1, 4, 3], [1, 2])]);
  const r = computeMeshNormals(m);
  assert.equal(r.count, 2);
  assert.equal(r.inconsistent, 2, "both sides of the bad edge are reported");
  assert.deepEqual(r.inconsistentIds.sort(), [1, 2]);
  // And it is visible: the two normals point opposite ways.
  assert.ok(r.normals[2] * r.normals[5] < 0);
});

test("a degenerate (zero-area) face is skipped, not emitted as NaN", () => {
  const m = mesh([0, 0, 0, 1, 0, 0, 2, 0, 0], [tris([1, 2, 3], [1])]); // collinear
  const r = computeMeshNormals(m);
  assert.equal(r.count, 0);
  assert.equal(r.degenerate, 1);
  assert.equal(r.normals.length, 0);
});

test("a volume cell contributes its BOUNDARY faces only", () => {
  // One tetra: four faces, all boundary. Interior faces would double-count.
  const m = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [
    {
      kind: "Elements",
      name: "tetra",
      vtkCellType: 10,
      count: 1,
      stride: 4,
      entityIds: Int32Array.from([1]),
      connectivity: Int32Array.from([1, 2, 3, 4]),
    },
  ]);
  const r = computeMeshNormals(m);
  assert.equal(r.count, 4);
  // Every normal is a unit vector.
  for (let i = 0; i < r.count; i++) {
    const len = Math.hypot(r.normals[i * 3], r.normals[i * 3 + 1], r.normals[i * 3 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-9, `normal ${i} is not unit length`);
  }
  // The face tables are self-consistent, so a well-formed tetra reports none.
  assert.equal(r.inconsistent, 0);
});

test("two tetras sharing a face emit only the skin", () => {
  const m = mesh(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1],
    [
      {
        kind: "Elements",
        name: "tetra",
        vtkCellType: 10,
        count: 2,
        stride: 4,
        entityIds: Int32Array.from([1, 2]),
        connectivity: Int32Array.from([1, 2, 3, 4, 2, 3, 4, 5]),
      },
    ]
  );
  // 8 faces total, one shared pair dropped -> 6 on the skin.
  assert.equal(computeMeshNormals(m).count, 6);
});

test("line and point cells contribute no normals", () => {
  const m = mesh([0, 0, 0, 1, 0, 0], [
    {
      kind: "Elements",
      name: "line",
      vtkCellType: 3,
      count: 1,
      stride: 2,
      entityIds: Int32Array.from([1]),
      connectivity: Int32Array.from([1, 2]),
    },
  ]);
  assert.equal(computeMeshNormals(m).count, 0);
});
