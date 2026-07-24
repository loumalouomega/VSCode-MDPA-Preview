/**
 * Exodus II support (meshio++ >= 8.6.0; see issue #56).
 *
 * The fixture `fixtures/exodus/seacas.exo` is a hand-authored SEACAS/Cubit-
 * shaped file (written against the Exodus II spec's variable conventions,
 * the same recipe meshio++'s own `tests/python/exodus_fixture.py` uses) —
 * NOT one meshio++'s own writer could produce: it emits no `qa_records`, no
 * `eb_names` and no side sets, so a round-trip test through that writer could
 * never have caught the defect this fixture exists for (the reader used to
 * throw on `qa_records`, which every real SEACAS/Cubit/Sierra file carries).
 *
 * Geometry: two unit hexahedra side by side along x — block "steel"
 * (x in [0,1]) and block "aluminium" (x in [1,2]), both HEX8. Node sets
 * "left"/"right" are the x=0 and x=2 faces; side set "loadface" is one face
 * of the "aluminium" block. Three time steps of a "temperature" nodal field,
 * offset by 10 per step (step 0: 0/1/2, step 1: 10/11/12, step 2: 20/21/22 —
 * repeated per node layer), so a wrong step is visible in the values.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { readMeshioModel } from "../parser/meshio";
import { parseMeshFile, readMeshTimeSteps } from "../parser/meshFileParser";
import { MdpaModel, SubModelPart } from "../parser/types";

const FIXTURE = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");

function readFixture(timeStep?: number): Promise<MdpaModel> {
  const data = fs.readFileSync(FIXTURE);
  return readMeshioModel("seacas.exo", [{ name: "seacas.exo", data }], ".exo", undefined, timeStep);
}

function part(model: MdpaModel, name: string): SubModelPart {
  const p = model.subModelParts.find((s) => s.path === name);
  assert.ok(p, `SubModelPart "${name}" exists (have: ${model.subModelParts.map((s) => s.path)})`);
  return p;
}

test("a real SEACAS-shaped file with qa_records opens without throwing", async () => {
  // The regression #56 was blocked on: qa_records made every real Exodus
  // file unreadable in wasm (no Python fallback there). This alone is the
  // fix that matters most.
  const model = await readFixture();
  assert.equal(model.nodeCount, 12); // 3x2x2 lattice
});

test("two element blocks of the SAME cell type stay distinguishable", async () => {
  const model = await readFixture();
  const steel = part(model, "steel");
  const aluminium = part(model, "aluminium");
  assert.equal(steel.elementIds.length, 1);
  assert.equal(aluminium.elementIds.length, 1);
  assert.notDeepEqual(Array.from(steel.elementIds), Array.from(aluminium.elementIds));
  // Both blocks are HEX8 -> both drawn as one "hexahedron" block, not merged
  // into one SubModelPart.
  assert.equal(model.blocks.filter((b) => b.name === "hexahedron").length, 1);
});

test("node sets become SubModelPart nodeIds", async () => {
  const model = await readFixture();
  const left = part(model, "left");
  const right = part(model, "right");
  assert.equal(left.nodeIds.length, 4);
  assert.equal(right.nodeIds.length, 4);
});

test("the side set materializes as a Conditions block and a SubModelPart", async () => {
  const model = await readFixture();
  const loadface = part(model, "loadface");
  assert.ok(loadface.conditionIds.length > 0, "loadface carries condition ids");
  const conditionBlock = model.blocks.find((b) => b.kind === "Conditions");
  assert.ok(conditionBlock, "a Conditions block was materialized");
});

test("time steps select different nodal values (meshio++ >= 8.6.0)", async () => {
  const step0 = await readFixture(0);
  const step1 = await readFixture(1);
  const step2 = await readFixture(2);
  const temp = (m: MdpaModel) => m.fields.find((f) => f.variable === "temperature");

  const t0 = temp(step0);
  const t1 = temp(step1);
  const t2 = temp(step2);
  assert.ok(t0 && t1 && t2, "temperature field present at every step");
  assert.notDeepEqual(Array.from(t0!.values), Array.from(t1!.values));
  assert.notDeepEqual(Array.from(t1!.values), Array.from(t2!.values));
  // The fixture offsets each step by 10 — step 2's minimum is step 0's + 20.
  const min = (v: Float64Array) => Math.min(...v);
  assert.equal(min(t2!.values), min(t0!.values) + 20);
});

test("an out-of-range time step throws naming the available count", async () => {
  await assert.rejects(readFixture(99), /out of range|3 steps|time step/i);
});

test("readMeshTimeSteps reports the fixture's 3 time values", async () => {
  const values = await readMeshTimeSteps(FIXTURE);
  assert.equal(values.length, 3);
  assert.deepEqual(values, [...values].sort((a, b) => a - b)); // ascending
});

test("parseMeshFile threads timeStep through — the exact call vtkEditorProvider makes", async () => {
  // vtkEditorProvider.ts's postInFileFrame calls parseMeshFile(fsPath,
  // onProgress, { timeStep }), not readMeshioModel directly — this is the
  // one path that actually drives the in-file timeline.
  const step0 = await parseMeshFile(FIXTURE, undefined, { timeStep: 0 });
  const step2 = await parseMeshFile(FIXTURE, undefined, { timeStep: 2 });
  const temp = (m: MdpaModel) => m.fields.find((f) => f.variable === "temperature")!;
  assert.notDeepEqual(Array.from(temp(step0).values), Array.from(temp(step2).values));
});
