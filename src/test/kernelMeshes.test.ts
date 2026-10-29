/**
 * The meshio++ 17.13.0 kernel meshes (and the generators/octree adopted with
 * them), over the real WASM: counts the documents state, the Kratos naming of
 * the result, and the refusals that keep a runaway request out of the kernel.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveMesh } from "../parser/deriveMesh";
import { generateMesh, estimateGeneratedCells, GENERATOR_SHAPES, GENERATE_MAX_CELLS, validateCadSurfaceSpec, cadSurfaceOptionsFrom, describeCadSurface, CadSurfaceReport } from "../parser/kernelMeshes";
import { recordedDeriveParameters } from "../parser/deriveMesh";
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

test("cadSurface options: order 3 is refused by name, malformed controls are named before the kernel runs", () => {
  const spec = (o: object) => ({ kind: "cadSurface" as const, targetSize: 0.5, ...o });
  assert.equal(validateCadSurfaceSpec(spec({})), undefined);
  assert.equal(validateCadSurfaceSpec(spec({ order: 2, minAngle: 25, faceSizes: { 0: 0.1 }, edgeSizes: { 3: 0.05 } })), undefined);
  assert.match(validateCadSurfaceSpec(spec({ order: 3 })) ?? "", /triangle10 \/ line4/);
  assert.match(validateCadSurfaceSpec(spec({ order: 4 })) ?? "", /order must be 1 or 2/);
  assert.match(validateCadSurfaceSpec(spec({ minAngle: 60 })) ?? "", /minAngle/);
  assert.match(validateCadSurfaceSpec(spec({ poleRings: 9 })) ?? "", /poleRings/);
  assert.match(validateCadSurfaceSpec(spec({ smoothIterations: 1.5 })) ?? "", /integer/);
  assert.match(validateCadSurfaceSpec(spec({ smoothMethod: "gauss" })) ?? "", /smoothMethod/);
  assert.match(validateCadSurfaceSpec(spec({ reparamConditionNumber: 1 })) ?? "", /above 1/);
  assert.match(validateCadSurfaceSpec(spec({ reparamConditionNumber: 5, order: 2 })) ?? "", /order 1 only/);
  assert.match(validateCadSurfaceSpec(spec({ faceSizes: { a: 0.1 } })) ?? "", /not a 0-based index/);
  assert.match(validateCadSurfaceSpec(spec({ edgeSizes: { 1: 0 } })) ?? "", /positive/);
  assert.match(validateCadSurfaceSpec(spec({ backgroundArray: "h" })) ?? "", /background mesh/);
  assert.match(validateCadSurfaceSpec({ kind: "cadSurface", targetSize: 0 }) ?? "", /targetSize/);
});

test("cadSurface options: an unknown key is rejected with the known list, undefined values are dropped", () => {
  assert.deepEqual(cadSurfaceOptionsFrom(undefined), {});
  assert.deepEqual(cadSurfaceOptionsFrom({ minAngle: 25, strict: undefined }), { minAngle: 25 });
  assert.throws(() => cadSurfaceOptionsFrom({ minAngel: 25 }), /Unknown CAD meshing option\(s\): minAngel\. Known: .*minAngle/);
  assert.throws(() => cadSurfaceOptionsFrom([1]), /must be an object/);
});

test("cadSurface: a background mesh is replaced by its label in the recorded recipe", () => {
  const spec = { kind: "cadSurface" as const, targetSize: 0.3, backgroundModel: empty(), backgroundLabel: "size.vtu", backgroundArray: "h" };
  const rec = recordedDeriveParameters(spec);
  assert.equal("backgroundModel" in rec, false);
  assert.equal(rec.backgroundLabel, "size.vtu");
  assert.equal(JSON.stringify(rec).includes("coords"), false);
});

test("cadSurface summary states what each option did", () => {
  const base: CadSurfaceReport = {
    faces: 2, triangles: 100, points: 60, failedFaces: [],
    edges: { total: 3, open: 0, nonManifold: 0, misoriented: 0, maxGap: 0 },
    edgeLength: { min: 0.1, max: 0.4 }, angleDeg: { min: 9.2, max: 120 }, angleHistogram: [],
    refinementPoints: 30, smoothed: 4, curvedStraightened: 2,
    angleBound: { requested: 30, minInputAngleDeg: 180, belowBound: true, boundDeg: 31, facesBelowBound: 1 },
    corners: [], cornersCount: 2, limitedByEdges: [4, 7], limitedByEdgesCount: 2, virtualEdges: [], virtualEdgesCount: 1,
    reparametrised: [{ taken: true }, { taken: false }], mergedFaces: [{ merged: true }], toleranceUses: [{}],
    loppedCorners: [{ guaranteed: true }, { guaranteed: false }], warnings: ["w"],
  };
  const text = describeCadSurface(base, { minAngle: 30, order: 2 });
  assert.match(text, /Quadratic output.*2 element\(s\).*straight-sided/);
  assert.match(text, /Angle bound 30°: 30 refinement point\(s\), 4 smoothed; 2 corner\/pole\(s\) on 1 face\(s\) force triangles under it, every other triangle is at least 31°/);
  assert.match(text, /Edge sizes limit the mesh at 2 edge\(s\): 4, 7\./);
  assert.match(text, /1 virtual edge chain/);
  assert.match(text, /2 face\(s\) over the reparametrisation condition number, 1 flattened/);
  assert.match(text, /1 sliver face\(s\) found, 1 meshed with a neighbour/);
  assert.match(text, /Declared tolerances accepted 1 gap/);
  assert.match(text, /2 corner\(s\) lopped, 1 without the guarantee/);
  assert.match(describeCadSurface({ ...base, angleBound: { ...base.angleBound!, belowBound: false }, loppedCorners: [] }, { minAngle: 30 }), /met \(smallest angle 31°\)/);
  assert.match(describeCadSurface({ ...base, angleBound: undefined, loppedCorners: [] }, { lopCorners: true }), /lopCorners has no effect without minAngle/);
});

test("cadSurface validates the 17.23.0 quad and metric-background controls before the kernel runs", () => {
  const ok = { kind: "cadSurface" as const, targetSize: 0.1 };
  assert.equal(validateCadSurfaceSpec({ ...ok, quads: "dominant", quadPairs: "greedy", untangle: true, order: 2 }), undefined);
  assert.match(validateCadSurfaceSpec({ ...ok, quads: "some" as never }) ?? "", /quads must be/);
  assert.match(validateCadSurfaceSpec({ ...ok, quadPairs: "x" as never }) ?? "", /quadPairs must be/);
  assert.match(validateCadSurfaceSpec({ ...ok, metricArray: "h" }) ?? "", /need a metric background/);
  assert.match(validateCadSurfaceSpec({ ...ok, metricBackgroundModel: icosphere(1, 1) }) ?? "", /needs metricArray/);
  assert.match(validateCadSurfaceSpec({ ...ok, metricBackgroundModel: icosphere(1, 1), metricArray: "h" }) ?? "", /metricError/);
  assert.deepEqual(cadSurfaceOptionsFrom({ quads: "all", metricBackgroundPath: "m.vtu" }), { quads: "all", metricBackgroundPath: "m.vtu" });
});
