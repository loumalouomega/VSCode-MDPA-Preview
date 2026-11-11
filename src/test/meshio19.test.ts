/**
 * meshio++ 19.0.0 over the real WASM: `checkTetrahedra`, the octree volume-fix counters and the
 * cadSurface default shim.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkTetrahedraReport, describeTetrahedraCheck } from "../parser/analysisOps";
import { generateMesh, volumeFixSentence } from "../parser/kernelMeshes";
import { loadMeshio, meshioPackageVersion } from "../parser/meshio";
import { applyOpAsync, opRecordFromMessage } from "../parser/operations";
import { MdpaModel } from "../parser/types";

async function tetBox(): Promise<MdpaModel> {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [2, 2, 2], size: [1, 1, 1] } })).model;
  return (await applyOpAsync(box, opRecordFromMessage({ op: "simplexify" })!)).model;
}

test("the installed kernel is 19.0.0 or later and exposes checkTetrahedra", async () => {
  assert.match(meshioPackageVersion()!, /^(19|20)\./);
  assert.equal(typeof (await loadMeshio()).checkTetrahedra, "function");
});

test("checkTetrahedra passes a valid mesh, counts a flipped tetrahedron, and refuses a mesh without tetrahedra", async () => {
  const model = await tetBox();
  const ok = await checkTetrahedraReport(model);
  assert.equal(ok.valid, true);
  assert.ok(ok.numTetrahedra > 0);
  assert.match(describeTetrahedraCheck(ok), /all valid/);

  const block = model.blocks.find((b) => b.stride === 4)!;
  const conn = Int32Array.from(block.connectivity as ArrayLike<number>);
  [conn[0], conn[1]] = [conn[1], conn[0]];
  const bad = { ...model, blocks: model.blocks.map((b) => (b === block ? { ...b, connectivity: conn } : b)) } as MdpaModel;
  const r = await checkTetrahedraReport(bad);
  assert.equal(r.valid, false);
  assert.ok(r.numInverted >= 1);

  const hex = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [1, 1, 1], size: [1, 1, 1] } })).model;
  await assert.rejects(checkTetrahedraReport(hex), /no tetrahedra/);
  await assert.rejects(checkTetrahedraReport(model, { zeroVolumeFactor: -1 }), /nonnegative/);
});

test("volumeFixSentence names only what happened", () => {
  assert.equal(volumeFixSentence({ numGapsFilled: 0, numOverlaps: 0 }), "");
  assert.equal(volumeFixSentence({ numGapsFilled: 12, numCollapsed: 3, numOverlaps: 1 }), "Volume fix: 12 gap(s) filled, 3 degenerate tetrahedra collapsed, 1 overlapping pair(s) remain.");
});
