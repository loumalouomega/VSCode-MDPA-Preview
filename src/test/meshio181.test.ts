/**
 * meshio++ 18.1.0 over the real WASM: the new point/surface derive kinds and
 * the facts the integration rests on (all measured, not read from the typings).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveMesh } from "../parser/deriveMesh";
import { generateMesh } from "../parser/kernelMeshes";
import { loadMeshio, meshioPackageVersion } from "../parser/meshio";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

const cellCount = (m: MdpaModel) => m.blocks.reduce((a, b) => a + b.count, 0);
const fieldNames = (m: MdpaModel) => m.fields.map((f) => f.variable);

test("the installed kernel is 18.1.0 and exposes the fourteen new functions", async () => {
  assert.equal(meshioPackageVersion(), "18.1.0");
  const m = (await loadMeshio()) as unknown as Record<string, unknown>;
  for (const fn of ["adjacency", "convertCoordinates", "convexHull", "delaunay2d", "estimateNormals", "geodesicDistance", "laplacianEigenmodes", "morph", "parameterize", "prepareMetric", "reconstructSurface", "registerRigid", "untangle", "writeGraph"]) {
    assert.equal(typeof m[fn], "function", fn);
  }
});

test("convexHull of a cube is its 12 facets, area 6, volume 1, and keeps the input index of each vertex", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2], size: [1, 1, 1] } })).model;
  const r = await deriveMesh(box, { kind: "convexHull" });
  assert.equal(r.model.nodeCount, 8);
  assert.equal(cellCount(r.model), 12);
  assert.match(r.summary, /area 6, volume 1/);
  assert.ok(fieldNames(r.model).includes("SOURCE_NODE_INDEX"));
});

test("delaunay2d triangulates a unit square into two triangles", async () => {
  const sq = (await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [1, 1], size: [1, 1] } })).model;
  const r = await deriveMesh(sq, { kind: "delaunay2d" });
  assert.equal(r.model.nodeCount, 4);
  assert.equal(cellCount(r.model), 2);
});

test("estimateNormals and reconstructSurface turn a sampled sphere into a surface", async () => {
  const pts = icosphere(1, 2);
  // A cloud: the vertices only, no cells.
  const cloud: MdpaModel = { ...pts, blocks: [], fields: [], subModelParts: [] };
  const normals = await deriveMesh(cloud, { kind: "estimateNormals", options: { k: 8 } });
  assert.ok(fieldNames(normals.model).some((v) => /normals/i.test(v)), fieldNames(normals.model).join(","));
  const surf = await deriveMesh(cloud, { kind: "reconstructSurface", options: { resolution: 24 } });
  assert.ok(cellCount(surf.model) > 100, `triangles ${cellCount(surf.model)}`);
  assert.match(surf.summary, /normals estimated/);
});
