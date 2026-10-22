import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutLabels, occludedPoints, projectPoints } from "../parser/render/labelLayout";

// Orthographic-like identity: clip = (x, y, z, 1).
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const tile = { left: 100, top: 50, width: 200, height: 100 };

test("centre, corners and orientation (y up in NDC = smaller top)", () => {
  const p = projectPoints(ID, new Float32Array([0, 0, 0, -1, 1, 0, 1, -1, 0]), tile);
  assert.deepEqual([p.x[0], p.y[0]], [200, 100]);
  assert.deepEqual([p.x[1], p.y[1]], [100, 50]);
  assert.deepEqual([p.x[2], p.y[2]], [300, 150]);
  assert.deepEqual([...p.inside], [1, 1, 1]);
});
test("outside the frustum or behind the camera is not inside", () => {
  const persp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]; // w = z
  const p = projectPoints(persp, new Float32Array([0, 0, 1, 0, 0, -1, 5, 0, 1]), tile);
  assert.deepEqual([...p.inside], [1, 0, 0]);
});
test("declutter keeps the first point per grid cell and honours the cap", () => {
  const pts = new Float32Array([0, 0, 0, 0.001, 0, 0, 0.5, 0.5, 0, -0.5, -0.5, 0]);
  const p = projectPoints(ID, pts, tile);
  assert.deepEqual(layoutLabels(p, tile, { maxLabels: 10, cell: 10 }), [0, 2, 3]);
  assert.deepEqual(layoutLabels(p, tile, { maxLabels: 2, cell: 10 }), [0, 2]);
});
test("hidden points are skipped", () => {
  const p = projectPoints(ID, new Float32Array([0, 0, 0, 0.5, 0.5, 0]), tile);
  assert.deepEqual(layoutLabels(p, tile, { maxLabels: 5, cell: 5, hidden: Uint8Array.from([1, 0]) }), [1]);
});
test("occlusion compares NDC depth with the snapshot", () => {
  const p = projectPoints(ID, new Float32Array([0, 0, 0.5]), { left: 0, top: 0, width: 4, height: 4 });
  const depth = new Float32Array(16).fill(0.2); // something nearer everywhere
  assert.deepEqual([...occludedPoints(p, depth, 4, 4, 1, 4, 1e-3)], [1]);
  depth.fill(0.9);
  assert.deepEqual([...occludedPoints(p, depth, 4, 4, 1, 4, 1e-3)], [0]);
});
