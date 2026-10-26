/**
 * Surface patch segmentation and its variational refinement, over the real
 * WASM: a cube skin has six patches, the labels come back as one field per id
 * space, a re-run replaces its own output, and the chain runs as ordinary ops.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { segmentModel, refinePatchesModel, SEGMENT_VARIABLE } from "../parser/segmentMesh";
import { generateMesh } from "../parser/kernelMeshes";
import { extractSkinModel } from "../parser/extractSkin";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps } from "../parser/operations";
import { MdpaModel } from "../parser/types";

async function cubeSkin(): Promise<MdpaModel> {
  const box = await generateMesh({ kind: "generate", shape: "box", params: { dims: [3, 3, 3] } });
  return extractSkinModel(box.model).model;
}

test("segment labels the six faces of a cube and can write them as SubModelParts", async () => {
  const skin = await cubeSkin();
  const r = await segmentModel(skin, { createParts: true });
  assert.equal(r.numPatches, 6);
  assert.equal(r.labelled, 54);
  const field = r.model.fields.find((f) => f.variable === SEGMENT_VARIABLE);
  assert.ok(field);
  assert.equal(new Set(field!.values).size, 6);
  const parts = r.model.subModelParts.filter((p) => /^Patch_\d+$/.test(p.name));
  assert.equal(parts.length, 6);
  assert.equal(parts.reduce((s, p) => s + p.elementIds.length + p.conditionIds.length, 0), 54);

  // A re-run replaces its own output rather than stacking it.
  const again = await segmentModel(r.model, { createParts: true });
  assert.equal(again.model.subModelParts.filter((p) => /^Patch_\d+$/.test(p.name)).length, 6);
  assert.equal(again.model.fields.filter((f) => f.variable === SEGMENT_VARIABLE).length, 1);
});

test("segment refuses a volume mesh by name and an unknown part", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2] } })).model;
  await assert.rejects(segmentModel(box, {}), /works on a surface mesh/);
  await assert.rejects(segmentModel(await cubeSkin(), { part: "Nope" }), /no SubModelPart "Nope"/);
});

test("refinePatches needs the labels, then keeps the cube's six primitive patches", async () => {
  const skin = await cubeSkin();
  const none = await refinePatchesModel(skin, {});
  assert.equal(none.labelled, 0);
  assert.match(none.details, /run Segment first/);

  const seg = await segmentModel(skin, {});
  const r = await refinePatchesModel(seg.model, {});
  assert.equal(r.numPatches, 6);
  assert.equal(r.numPrimitive, 6);
  assert.ok(r.explainedAreaFraction > 0.99);
  assert.equal(r.model.blocks, seg.model.blocks, "the mesh itself is untouched");
  await assert.rejects(refinePatchesModel(seg.model, { ransacSeed: -1 }), /ransacSeed/);
});

test("segment and refinePatches run as history ops and survive a recipe round trip", async () => {
  const skin = await cubeSkin();
  const segRec = opRecordFromMessage({ op: "segment", featureAngle: 30, method: "angle", createParts: true });
  assert.ok(segRec);
  const seg = await applyOpAsync(skin, segRec!);
  assert.equal(seg.noop, undefined);
  assert.match(seg.message ?? "", /Segmented 54 surface cell\(s\) into 6 patch/);
  const refRec = opRecordFromMessage({ op: "refinePatches", maxIterations: 3, types: "plane,cylinder" });
  assert.ok(refRec);
  const ref = await applyOpAsync(seg.model, refRec!);
  assert.match(ref.message ?? "", /Refined 54 labelled cell\(s\)/);

  const parsed = parseOpsJson(serializeOps([segRec!, refRec!], "test.mdpa"));
  assert.deepEqual(parsed.operations, [segRec, refRec]);
  assert.equal(opRecordFromMessage({ op: "segment", featureAngle: 400 }), undefined);
  assert.equal(opRecordFromMessage({ op: "refinePatches", types: "blob" }), undefined);

  // On a model that was never segmented the refine is a noop with the reason.
  const lone = await applyOpAsync(skin, refRec!);
  assert.equal(lone.noop, true);
  assert.match(lone.message ?? "", /run Segment first/);
});
