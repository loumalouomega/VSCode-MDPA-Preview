/** Segmentation report with fitted primitives (roadmap item 31), over the real WASM. */
import assert from "node:assert/strict";
import test from "node:test";

import { fitPrimitivesReport, FIT_VARIABLE } from "../parser/primitiveReport";
import { segmentModel } from "../parser/segmentMesh";
import { generateMesh } from "../parser/kernelMeshes";
import { extractSkinModel } from "../parser/extractSkin";
import { icosphere } from "./fixtures/shapes";

test("a cube skin reports six planes; the optional field round-trips the codes", async () => {
  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [3, 3, 3] } });
  const skin = extractSkinModel(box.model).model;
  const seg = await segmentModel(skin, {});
  const r = await fitPrimitivesReport(seg.model, { writeField: true });
  assert.equal(r.patches.length, 6);
  assert.equal(r.counts.plane, 6);
  for (const p of r.patches) {
    assert.equal(p.type, "plane");
    assert.ok(p.rms < 1e-6 && p.fraction > 0.99);
    assert.ok(p.axis && Math.abs(Math.hypot(...p.axis) - 1) < 1e-6);
  }
  const f = r.model.fields.find((x) => x.variable === FIT_VARIABLE)!;
  assert.ok(f);
  assert.ok(Array.from(f.values).every((v) => v === 1));
  // Without writeField the mesh object is returned untouched.
  assert.equal((await fitPrimitivesReport(seg.model)).model, seg.model);
});

test("a sphere reports its radius; a cylinder side reports its radius and axis", async () => {
  const sphere = await segmentModel(icosphere(2, 2), {});
  const s = await fitPrimitivesReport(sphere.model);
  assert.equal(s.patches[0].type, "sphere");
  assert.ok(Math.abs(s.patches[0].radius! - 2) < 1e-4);

  const cyl = await generateMesh({ kind: "generate", shape: "cylinder", params: { radius: 5, height: 4, nxy: 24, nz: 3 } });
  const skin = extractSkinModel(cyl.model).model;
  const seg = await segmentModel(skin, { featureAngle: 60 });
  const r = await fitPrimitivesReport(seg.model);
  const side = r.patches.find((p) => p.type === "cylinder");
  assert.ok(side, JSON.stringify(r.counts));
  assert.ok(Math.abs(side!.radius! - 5) < 0.2, `radius ${side!.radius}`);
  assert.ok(Math.abs(Math.abs(side!.axis![2]) - 1) < 1e-3);
  assert.ok(r.patches.filter((p) => p.type === "plane").length >= 2);
});

test("without SEGMENT_PATCH the report says to run Segment first", async () => {
  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } });
  const r = await fitPrimitivesReport(extractSkinModel(box.model).model);
  assert.equal(r.patches.length, 0);
  assert.match(r.message, /run Segment first/);
});
