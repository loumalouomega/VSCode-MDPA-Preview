import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { potentialFlow } from "../problemtype/builtins/potentialFlow";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import { applyRestart, restartRefusals, restartSaveProcess, supportsRestart } from "../problemtype/restart";
import { findRestartFiles, resolveRestartSource } from "../problemtype/restartFile";
import { writeExecution } from "../problemtype/runReceiptWriter";
import { writePreparedCase } from "../problemtype/preparation";
import type { CaseState, JsonObject } from "../problemtype/types";

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
Begin SubModelPart Parts
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
End SubModelPart
Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
End SubModelPart
`;

function state(): CaseState {
  const s = defaultCaseState(structural.decl);
  s.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  s.materials = [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } }];
  return s;
}

test("save adds one save_restart_process and leaves the import settings alone", async () => {
  const s = state();
  s.restart = { save: { frequency: 5, controlType: "step", keep: 3 } };
  const out = await generateCase(structural, parseMdpa(MDPA), s, "beam");
  const pp = JSON.parse(out.projectParameters);
  const list = pp.output_processes.restart_output;
  assert.equal(list.length, 1);
  assert.equal(list[0].python_module, "save_restart_process");
  assert.equal(list[0].Parameters.restart_save_frequency, 5);
  assert.equal(list[0].Parameters.restart_control_type, "step");
  assert.equal(list[0].Parameters.max_files_to_keep, 3);
  assert.equal(list[0].Parameters.model_part_name, "Structure");
  assert.deepEqual(pp.solver_settings.model_import_settings, { input_type: "mdpa", input_filename: "beam" });
  assert.ok(pp.output_processes.vtk_output.length === 1);
});

test("no restart options: the document is byte-identical to before", async () => {
  const a = await generateCase(structural, parseMdpa(MDPA), state(), "beam");
  const s = state();
  s.restart = {};
  const b = await generateCase(structural, parseMdpa(MDPA), s, "beam");
  assert.equal(a.projectParameters, b.projectParameters);
});

test("from switches model_import_settings to a restart load", async () => {
  const s = state();
  s.restart = { from: { runDirectory: "runs/a", label: 12, inputFilename: "runs/a/beam" } };
  const out = await generateCase(structural, parseMdpa(MDPA), s, "beam");
  assert.deepEqual(JSON.parse(out.projectParameters).solver_settings.model_import_settings, {
    input_type: "rest",
    input_filename: "runs/a/beam",
    restart_load_file_label: "12",
  });
});

test("an unresolved source and an unsupported problemtype are refused by name", async () => {
  const s = state();
  s.restart = { from: { runDirectory: "runs/a", label: 1 } };
  await assert.rejects(generateCase(structural, parseMdpa(MDPA), s, "beam"), /not resolved/);
  assert.match(restartRefusals("potentialFlow", { save: { frequency: 1, controlType: "step" } })[0], /not available/);
  assert.equal(supportsRestart("structural"), true);
  assert.equal(supportsRestart("potentialFlow"), false);
  assert.equal(potentialFlow.decl.id, "potentialFlow");
});

test("applyRestart keeps an existing restart_output list", () => {
  const doc: JsonObject = { solver_settings: {}, output_processes: { restart_output: [{ python_module: "x" }] } };
  const out = applyRestart(doc, { ...state(), restart: { save: { frequency: 1, controlType: "time" } } }, "Structure");
  assert.equal(((out.output_processes as JsonObject).restart_output as unknown[]).length, 2);
  assert.equal((restartSaveProcess("M", { frequency: 1, controlType: "time" }).Parameters as JsonObject).max_files_to_keep, -1);
});

test("the case file round-trips restart and drops malformed parts with warnings", () => {
  const s = state();
  s.restart = {
    save: { frequency: 2, controlType: "time" },
    from: { runDirectory: "r", label: 3, inputFilename: "r/beam" },
  };
  const back = parseCaseJson(serializeCase(s));
  assert.deepEqual(back.state?.restart, s.restart);
  const bad = parseCaseJson(
    JSON.stringify({ ...JSON.parse(serializeCase(s)), restart: { save: { frequency: -1 }, from: { runDirectory: "r", label: 1.5 } } })
  );
  assert.equal(bad.state?.restart, undefined);
  assert.equal(bad.warnings.length >= 2, true);
});

async function sourceRun(root: string, opts: { state?: string; meshText: string; label: number }): Promise<string> {
  const dir = path.join(root, "runs", "a");
  const rest = path.join(dir, "beam__restart_files");
  fs.mkdirSync(rest, { recursive: true });
  fs.writeFileSync(path.join(rest, `beam_${opts.label}.rest`), "x");
  const meshFile = path.join(dir, "beam.mdpa");
  fs.writeFileSync(meshFile, opts.meshText);
  const st = state();
  const generated = await generateCase(structural, parseMdpa(opts.meshText), st, "beam");
  writePreparedCase({ directory: dir, sourcePath: meshFile, solverMeshPath: meshFile, runtime: structural, state: st, generated, warnings: [] });
  writeExecution({
    version: 1, requestId: "r", ownerId: "o", state: (opts.state ?? "succeeded") as "succeeded",
    runDirectory: dir, meshPath: path.join(dir, "beam.mdpa"), createdAt: 1, updatedAt: 2, artifacts: [],
  });
  return dir;
}

test("resolveRestartSource accepts a terminal run on the same mesh", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restart-"));
  try {
    await sourceRun(root, { meshText: MDPA, label: 7 });
    const mesh = path.join(root, "beam.mdpa");
    fs.writeFileSync(mesh, MDPA);
    assert.equal(findRestartFiles(path.join(root, "runs", "a"), 7).length, 1);
    const from = resolveRestartSource(root, { runDirectory: "runs/a", label: 7 }, mesh);
    assert.equal(from.inputFilename, "runs/a/beam");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRestartSource names every refusal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restart-"));
  try {
    await sourceRun(root, { meshText: MDPA, label: 7, state: "running" });
    const mesh = path.join(root, "beam.mdpa");
    fs.writeFileSync(mesh, MDPA + "\n");
    assert.throws(
      () => resolveRestartSource(root, { runDirectory: "runs/a", label: 9 }, mesh),
      (e: Error) => /is running/.test(e.message) && /differs/.test(e.message) && /label 9/.test(e.message)
    );
    assert.throws(() => resolveRestartSource(root, { runDirectory: "nope", label: 1 }, mesh), /no run receipt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
