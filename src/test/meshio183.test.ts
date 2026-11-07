/**
 * meshio++ 18.3.0 over the real WASM: CutCells (full artifact only), the STEP/IGES `cadRead`
 * controls, and the calls that are present but cannot run in WebAssembly.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { deriveMesh } from "../parser/deriveMesh";
import { generateMesh } from "../parser/kernelMeshes";
import { describeCadHeal, loadMeshio, loadMeshioFull, meshioFullInstalled, meshioPackageVersion, readMeshioModel } from "../parser/meshio";
import { applyOpAsync, opRecordFromMessage } from "../parser/operations";
import { MdpaModel } from "../parser/types";

const cellCount = (m: MdpaModel) => m.blocks.reduce((a, b) => a + b.count, 0);
const full = meshioFullInstalled();

async function phiBox(): Promise<MdpaModel> {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [3, 3, 3], size: [1, 1, 1] } })).model;
  const rec = opRecordFromMessage({ op: "fieldCalc", expr: "x - 0.5", location: "Nodal", output: "phi" })!;
  return (await applyOpAsync(box, rec)).model;
}

test("the installed kernel family has CutCells is linked into the full artifact only", async () => {
  assert.ok(meshioPackageVersion());
  const lean = await loadMeshio();
  assert.equal(lean.hasCutcells(), false);
  for (const fn of ["cutLevelSet", "cutQuadrature", "remeshQuads"] as const) assert.equal(typeof lean[fn], "function", fn);
  if (full) assert.equal((await loadMeshioFull()).hasCutcells(), true);
});

test("cutLevelSet keeps the half a level set selects and cutQuadrature integrates it", { skip: !full }, async () => {
  const model = await phiBox();
  const cut = await deriveMesh(model, { kind: "cutLevelSet", options: { levelSets: ["phi"], selection: "phi < 0" } });
  assert.ok(cellCount(cut.model) > 0);
  assert.match(cut.summary, /Level-set cut \(phi < 0/);
  // Half of the unit-cube measure: the cut is exact, not a cell-by-cell approximation.
  const measure = Number(/measure (\d+(?:\.\d+)?)/.exec(cut.summary)?.[1]);
  assert.ok(Math.abs(measure - 0.5) < 1e-6, cut.summary);

  const quad = await deriveMesh(model, { kind: "cutQuadrature", options: { levelSets: ["phi"], selection: "phi < 0", order: 2 } });
  const vars = quad.model.fields.map((f) => f.variable);
  assert.ok(vars.includes("QUADRATURE_WEIGHT"), vars.join(","));
  const w = quad.model.fields.find((f) => f.variable === "QUADRATURE_WEIGHT")!;
  const sum = Array.from(w.values as ArrayLike<number>).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 0.5) < 1e-6, `weights sum ${sum}`);
});

test("cutLevelSet names the missing library on the lean artifact", async () => {
  const lean = await loadMeshio();
  assert.throws(() => lean.cutLevelSet({ points: new Float64Array(0), dim: 3, cells: [] } as never, {}), /CutCells/);
});

test("cadRead is accepted for STEP and the heal report becomes one diagnostic", { skip: !full }, async () => {
  const file = path.join(__dirname, "..", "..", "src", "test", "fixtures", "cad", "box.step");
  const bytes = fs.readFileSync(file);
  const read = (cadRead?: object) => readMeshioModel("box.step", [{ name: "box.step", data: bytes }], ".step", "step", undefined, undefined, { cadRead });
  const plain = await read();
  const healed = await read({ heal: true, deflection: 0.1, sewTolerance: 1e-4 });
  assert.equal(healed.nodeIds.length, plain.nodeIds.length);
  assert.ok(healed.diagnostics.some((d) => /CAD read: shape healed/.test(d.message)), JSON.stringify(healed.diagnostics));
  assert.ok(!plain.diagnostics.some((d) => /CAD read/.test(d.message)));
});

test("describeCadHeal is tolerant of anything the kernel might send", () => {
  assert.equal(describeCadHeal(undefined), undefined);
  assert.equal(describeCadHeal({ extra: "not json" }), undefined);
  assert.equal(describeCadHeal({ extra: '{"version_number":1}' }), undefined);
  assert.equal(
    describeCadHeal({ extra: '{"heal":{"healed":true,"fixed":true,"sew_tolerance":0.0001,"free_edges_before":4,"free_edges_after":0,"multiple_edges":0,"degenerated":2}}' }),
    "CAD read: shape healed, fixes applied, sewn at 0.0001, free edges 4 → 0, 2 degenerated."
  );
});

test("a slice restricted to SubModelParts cuts only those parts", async () => {
  const box = (await generateMesh({ kind: "generate", shape: "box", params: { dims: [4, 4, 4], size: [1, 1, 1] } })).model;
  const ids = box.blocks.filter((b) => b.kind === "Elements").flatMap((b) => Array.from(b.entityIds).filter((_, i) => i < b.count / 2));
  const half: MdpaModel = {
    ...box,
    subModelParts: [{ name: "Half", path: "Half", nodeIds: [], elementIds: ids, conditionIds: [], geometryIds: [], constraintIds: [], children: [] } as never],
  };
  const plane = { origin: [0.4, 0.5, 0.5] as [number, number, number], normal: [1, 0, 0] as [number, number, number] };
  const whole = await deriveMesh(half, { kind: "slice", ...plane });
  const part = await deriveMesh(half, { kind: "slice", ...plane, parts: ["Half"] });
  assert.ok(cellCount(part.model) > 0);
  assert.ok(cellCount(part.model) < cellCount(whole.model), `${cellCount(part.model)} vs ${cellCount(whole.model)}`);
  await assert.rejects(deriveMesh(half, { kind: "slice", ...plane, parts: ["Nope"] }), /None of the requested SubModelParts/);
});
