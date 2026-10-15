import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { caseGenerate, caseOptimization, caseRom, caseStatus, caseValidate, caseWriteState, problemtypeList } from "../mcp/tools";
import { defaultCaseState } from "../problemtype/api";
import { newEntry } from "../problemtype/collections";
import { optimization, OPTIMIZATION_COLLECTIONS } from "../problemtype/builtins/optimization";
import { ROM_PARAMETERS, romStructural } from "../problemtype/builtins/rom";
import { encodeNpy } from "../parser/npyReader";
import type { CaseState } from "../problemtype/types";

const MDPA = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 2 3 4
End Conditions

Begin SubModelPart Solid
  Begin SubModelPartNodes
  1
  2
  3
  4
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Load
  Begin SubModelPartNodes
  2
  3
  4
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

const FIX = path.join(__dirname, "..", "..", "src", "test", "fixtures", "optimization");

function meshIn(dir: string): string {
  const file = path.join(dir, "bracket.mdpa");
  fs.writeFileSync(file, MDPA);
  return file;
}

function primal(state: CaseState): CaseState {
  state.assignments = [
    { conditionId: "parts", smpPath: "Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: {} },
    { conditionId: "surfacePressure", smpPath: "Load", values: { value: 1000 } },
  ];
  state.materials = [{ smpPath: "Solid", lawId: "linear_elastic_3d", values: {} }];
  return state;
}

function optimizationState(): CaseState {
  const state = primal(defaultCaseState(optimization.decl));
  const control = newEntry(OPTIMIZATION_COLLECTIONS.find((c) => c.id === "controls")!, "material", "stiffness");
  control.parts = ["Solid"];
  state.collections!.controls = [control];
  return state;
}

test("problemtype_list reports the reduced and optimization families", async () => {
  const res = (await problemtypeList({})) as { problemtypes: { id: string; family?: string }[] };
  const family = (id: string) => res.problemtypes.find((p) => p.id === id)?.family;
  assert.equal(family("optimization"), "optimization");
  for (const id of ["romStructural", "romThermal", "romFluid", "romPotentialFlow"]) assert.equal(family(id), "reduced", id);
});

test("case_validate names a collection problem; case_write_state keeps collections", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-opt-"));
  const mesh = meshIn(dir);
  const incomplete = primal(defaultCaseState(optimization.decl));
  const res = (await caseValidate({ meshPath: mesh, state: incomplete, quality: false })) as { ok: boolean; issues: string[]; findings: { code: string }[] };
  assert.equal(res.ok, false);
  assert.ok(res.findings.some((f) => f.code === "collection-count"), JSON.stringify(res.findings));
  const ok = (await caseValidate({ meshPath: mesh, state: optimizationState(), quality: false })) as { ok: boolean; issues: string[] };
  assert.deepEqual(ok.issues, []);
  const written = (await caseWriteState({ meshPath: mesh, state: optimizationState() })) as { casePath: string };
  const back = JSON.parse(fs.readFileSync(written.casePath, "utf8"));
  assert.equal(back.collections.controls[0].name, "stiffness");
});

test("case_generate writes the optimization documents, driver and stop module", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-opt-gen-"));
  const mesh = meshIn(dir);
  const res = (await caseGenerate({ meshPath: mesh, state: optimizationState() })) as { written: string[]; primaryDocument: string; driverScript: string };
  const names = res.written.map((f) => path.basename(f));
  for (const n of ["optimization_parameters.json", "primal_parameters.json", "StructuralMaterials.json", "MainKratosOpt.py", "kkss_optimization_stop.py"]) {
    assert.ok(names.includes(n), `${n} in ${names}`);
  }
  assert.equal(path.basename(res.primaryDocument), "optimization_parameters.json");
  assert.equal(path.basename(res.driverScript), "MainKratosOpt.py");
});

test("case_optimization reads the summary the case names; case_status gives the short form", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-opt-sum-"));
  const mesh = meshIn(dir);
  await caseGenerate({ meshPath: mesh, state: optimizationState() });
  const before = (await caseOptimization({ meshPath: mesh })) as { available: boolean; reason: string; formulation: string };
  assert.equal(before.available, false);
  assert.match(before.reason, /summary\.csv has not been written/);
  assert.match(before.formulation, /minimize strain_energy · controls: stiffness/);
  fs.copyFileSync(path.join(FIX, "steepest_descent.csv"), path.join(dir, "summary.csv"));
  const csv = path.join(dir, "out.csv");
  const res = (await caseOptimization({ meshPath: mesh, limit: 5, outputPath: csv })) as {
    available: boolean; summary: { verdict: string; iterations: number; objective: { changePercent: number } };
    rows: unknown[][]; rowsTotal: number; decimated: boolean; columns: string[];
  };
  assert.equal(res.available, true);
  assert.equal(res.summary.verdict, "finished");
  assert.equal(res.summary.iterations, 11);
  assert.equal(res.rows.length, 5);
  assert.equal(res.rowsTotal, 11);
  assert.equal(res.decimated, true);
  assert.equal(res.columns[0], "STEP");
  assert.equal(fs.readFileSync(csv, "utf8").trim().split("\n").length, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
  const status = (await caseStatus({ meshPath: mesh })) as { status: string; optimization: { verdict: string; iterations: number } };
  assert.equal(status.status, "none");
  assert.equal(status.optimization.iterations, 11);
  await assert.rejects(caseOptimization({ meshPath: mesh, outputPath: path.join(dir, "x.txt") }), /\.csv/);
});

test("case_generate writes a ROM case; case_rom reports its results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rom-"));
  const mesh = meshIn(dir);
  const state = primal(defaultCaseState(romStructural.decl));
  const p = newEntry(ROM_PARAMETERS, "range", "load");
  Object.assign(p.values, { target: "assignment:surfacePressure@Load/value", min: -50, max: 50 });
  state.collections!.parameters = [p];
  const res = (await caseGenerate({ meshPath: mesh, state })) as { written: string[] };
  const names = res.written.map((f) => path.basename(f));
  for (const n of ["ProjectParameters.json", "RomManagerParameters.json", "RomSamples.json", "MainKratosROM.py"]) assert.ok(names.includes(n), `${n} in ${names}`);
  let rom = (await caseRom({ meshPath: mesh })) as { available: boolean; rom: { modes?: number; runsFinished: number }; samples: { train: number } };
  assert.equal(rom.available, true);
  assert.equal(rom.rom.modes, undefined);
  assert.equal(rom.samples.train, 6);
  fs.mkdirSync(path.join(dir, "rom_data"));
  fs.writeFileSync(path.join(dir, "rom_data", "RomParameters.json"), JSON.stringify({ rom_settings: { number_of_rom_dofs: 3 } }));
  fs.writeFileSync(path.join(dir, "rom_data", "SingularValuesVector.npy"), encodeNpy([5, 0.5, 0.05]));
  fs.writeFileSync(path.join(dir, "rom_data", "HROM_ElementIds.npy"), encodeNpy([1], "<i8"));
  rom = (await caseRom({ meshPath: mesh })) as typeof rom & { singularValues: number[]; hromElementIds: number[] };
  assert.equal(rom.rom.modes, 3);
  assert.deepEqual((rom as unknown as { singularValues: number[] }).singularValues, [5, 0.5, 0.05]);
  assert.deepEqual((rom as unknown as { hromElementIds: number[] }).hromElementIds, [1]);
  const status = (await caseStatus({ meshPath: mesh })) as { rom: { modes: number } };
  assert.equal(status.rom.modes, 3);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rom-none-"));
  assert.equal(((await caseRom({ meshPath: meshIn(other) })) as { available: boolean }).available, false);
});
