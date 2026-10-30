/**
 * The meshio++ 17.23.0 derived-mesh kernels (extrude, revolve, mirror,
 * boundaryLayer, tetrahedralize, errorSize, checkConformity) and the new
 * generator controls, over the real WASM.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveMesh, DERIVE_KINDS } from "../parser/deriveMesh";
import { generateMesh, estimateGeneratedCells } from "../parser/kernelMeshes";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

const cells = (m: MdpaModel, kind?: "Elements" | "Conditions") => m.blocks.filter((b) => !kind || b.kind === kind).reduce((s, b) => s + b.count, 0);
const hasBlock = (m: MdpaModel, name: string) => m.blocks.some((b) => b.name === name && b.count > 0);

async function quadGrid(): Promise<MdpaModel> {
  return (await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [4, 4], size: [1, 1], cellType: "quad" } })).model;
}

test("the new kernels are derive kinds", () => {
  for (const k of ["extrude", "revolve", "mirror", "boundaryLayer", "tetrahedralize", "errorSize", "checkConformity"]) assert.ok((DERIVE_KINDS as readonly string[]).includes(k), k);
});

test("extrude sweeps a quad grid into hexahedra", async () => {
  const r = await deriveMesh(await quadGrid(), { kind: "extrude", options: { direction: [0, 0, 1], numLayers: 3 } });
  assert.equal(cells(r.model, "Elements"), 16 * 3);
  assert.ok(hasBlock(r.model, "Element3D8N"));
  assert.match(r.summary, /Extruded/);
});

test("revolve sweeps a quad grid about an axis", async () => {
  const r = await deriveMesh(await quadGrid(), { kind: "revolve", options: { axis: [0, 1, 0], axisPoint: [-1, 0, 0], angle: 90, numLayers: 4 } });
  assert.equal(cells(r.model, "Elements"), 16 * 4);
  assert.match(r.summary, /Revolved/);
});

test("mirror doubles a mesh across a plane and welds the seam", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [3, 3, 3], size: [1, 1, 1] } })).model;
  const r = await deriveMesh(box, { kind: "mirror", options: { normal: [1, 0, 0], origin: [0, 0, 0], keepOriginal: true } });
  assert.equal(cells(r.model, "Elements"), 54);
  assert.match(r.summary, /Mirrored/);
});

test("boundaryLayer grows wedge layers from a closed skin", async () => {
  const r = await deriveMesh(icosphere(1, 2), { kind: "boundaryLayer", options: { firstHeight: 0.02, numLayers: 3, growth: 1.2 } });
  assert.equal(cells(r.model, "Elements"), 320 * 3);
  assert.ok(hasBlock(r.model, "Element3D6N"));
});

test("tetrahedralize fills a closed skin (octree backend where Netgen is absent)", async () => {
  const r = await deriveMesh(icosphere(1, 2), { kind: "tetrahedralize", options: { maxSize: 0.4 } });
  assert.ok(hasBlock(r.model, "Element3D4N"));
  assert.ok(cells(r.model, "Elements") > 100);
  assert.match(r.summary, /Tetrahedralized/);
});

test("checkConformity reports a conforming grid and refuses an unknown option", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } })).model;
  const r = await deriveMesh(box, { kind: "checkConformity" });
  assert.match(r.summary, /conforming/);
  assert.match(r.summary, /0 hanging/);
  await assert.rejects(deriveMesh(box, { kind: "extrude", options: { nonsense: 1 } }), /nonsense|unknown/i);
});

test("generators: 17.23.0 shapes, the complete flag and its type check", async () => {
  const torus = await generateMesh({ kind: "generate", shape: "torus", params: { nu: 12, nv: 6 } });
  assert.equal(cells(torus.model), 72);
  const ball = await generateMesh({ kind: "generate", shape: "ball", params: { n: 3 } });
  assert.ok(hasBlock(ball.model, "Element3D8N"));
  const plain = await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } });
  const full = await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2], complete: true } });
  assert.ok(full.model.subModelParts.length >= plain.model.subModelParts.length);
  await assert.rejects(generateMesh({ kind: "generate", shape: "box", params: { complete: "yes" } }), /"complete" must be true or false/);
  await assert.rejects(generateMesh({ kind: "generate", shape: "spherePoints", params: { complete: true } }), /no parameter "complete"/);
  assert.equal(estimateGeneratedCells("capsule", { ntheta: 10, nz: 2, ncap: 3 }), 10 * 8 * 2);
});
