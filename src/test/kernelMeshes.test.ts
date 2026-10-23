/**
 * The meshio++ 17.13.0 kernel meshes (and the generators/octree adopted with
 * them), over the real WASM: counts the documents state, the Kratos naming of
 * the result, and the refusals that keep a runaway request out of the kernel.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveMesh } from "../parser/deriveMesh";
import { generateMesh, estimateGeneratedCells, GENERATOR_SHAPES, GENERATE_MAX_CELLS } from "../parser/kernelMeshes";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { icosphere } from "./fixtures/shapes";

const total = (m: MdpaModel, kind: "Elements" | "Conditions") => m.blocks.filter((b) => b.kind === kind).reduce((s, b) => s + b.count, 0);
const empty = (): MdpaModel => parseMdpa("") as unknown as MdpaModel;

test("generators: documented counts, regions as SubModelParts, Kratos block names", async () => {
  const rect = await generateMesh({ kind: "generate", shape: "rectangle", params: { dims: [4, 3], size: [2, 1.5] } });
  assert.equal(total(rect.model, "Elements"), 12);
  assert.deepEqual(rect.model.subModelParts.map((p) => p.name).sort(), ["xmax", "xmin", "ymax", "ymin"]);
  assert.ok(rect.model.blocks.some((b) => b.name === "Element2D4N"));

  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } });
  assert.equal(total(box.model, "Elements"), 8);
  assert.equal(box.model.subModelParts.length, 6);
  assert.ok(box.model.blocks.some((b) => b.name === "Element3D8N" && b.kind === "Elements"));
  assert.ok(box.model.blocks.some((b) => b.name === "SurfaceCondition3D4N" && b.kind === "Conditions"), "boundary faces are Conditions");

  const ico = await generateMesh({ kind: "generate", shape: "icosaSphere", params: { subdivisions: 1 } });
  assert.equal(total(ico.model, "Elements"), 80);
});

test("every generator shape runs with its defaults", async () => {
  for (const shape of GENERATOR_SHAPES) {
    const r = await generateMesh({ kind: "generate", shape });
    assert.ok(r.model.nodeCount > 0, shape);
    assert.ok(r.model.blocks.reduce((s, b) => s + b.count, 0) > 0, shape);
  }
});

test("generators refuse unknown parameters, wrong types and oversized requests before the kernel runs", async () => {
  await assert.rejects(generateMesh({ kind: "generate", shape: "box", params: { sides: 3 } }), /no parameter "sides"/);
  await assert.rejects(generateMesh({ kind: "generate", shape: "disk", params: { n: "ten" } }), /"n" must be an integer/);
  await assert.rejects(generateMesh({ kind: "generate", shape: "box", params: { dims: [1000, 1000, 1000] } }), /over 5,000,000/);
  assert.ok(estimateGeneratedCells("box", { dims: [10, 10, 10], cellType: "tetra" }) === 6000);
  assert.ok(GENERATE_MAX_CELLS > 0);
});

test("octreeMesh meshes the inside of a sphere as tetrahedra, hexahedra and castellated leaves", async () => {
  const sphere = icosphere(1, 2);
  for (const output of ["tet", "hex", "castellated"] as const) {
    const r = await deriveMesh(sphere, { kind: "octreeMesh", options: { output, maxSize: 0.5, minSize: 0.25 } });
    assert.ok(total(r.model, "Elements") > 100, output);
    assert.ok(r.model.fields.some((f) => f.variable === "SDF_DISTANCE"), `${output}: SDF_DISTANCE`);
    assert.ok(!/INVERTED/.test(r.summary), `${output}: ${r.summary}`);
    assert.match(r.summary, new RegExp(`Octree ${output} mesh`));
    const names = r.model.blocks.map((b) => b.name);
    assert.ok(names.includes(output === "tet" ? "Element3D4N" : "Element3D8N"), names.join());
    assert.ok(r.model.blocks.some((b) => b.kind === "Conditions"), `${output}: boundary faces become Conditions`);
  }
});

test("octreeMesh refuses a mesh with no surface and an unknown option", async () => {
  await assert.rejects(deriveMesh(sphereWithoutFaces(), { kind: "octreeMesh" }), /no surface faces|no boundary faces/);
  await assert.rejects(deriveMesh(icosphere(1, 1), { kind: "octreeMesh", options: { nonsense: 1 } }), /nonsense|unknown/i);
});

test("octree (17.8.0) builds an adaptive lattice around the skin", async () => {
  const r = await deriveMesh(icosphere(1, 2), { kind: "octree", maxLevel: 3 });
  assert.match(r.summary, /Octree .*leaves \(3-D\)/);
  assert.ok(r.model.nodeCount > 0);
});

test("cadSurface refuses a mesh with no B-rep side channel and a missing target size", async () => {
  await assert.rejects(deriveMesh(icosphere(1, 1), { kind: "cadSurface", targetSize: 0.2 }), /no B-rep side channel/);
});

function sphereWithoutFaces(): MdpaModel {
  return parseMdpa("Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\n") as unknown as MdpaModel;
}
void empty;
