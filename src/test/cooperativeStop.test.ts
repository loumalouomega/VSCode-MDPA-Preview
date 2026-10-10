/**
 * The cooperative stop, end to end through the REAL generated `MainKratos.py`.
 *
 * No Kratos: a stub `KratosMultiphysics` package and a fake analysis stage give
 * the template something to wrap, and a real python child runs it. What is
 * proved is the contract roadmap item 14 asks for — a stop writes the sentinel,
 * the script leaves its loop through the stage's normal `Finalize`, the last
 * result file is complete, and the exit is clean — on every platform, because
 * nothing here is a signal. Skipped (reported, not passed) when no python is
 * installed, the `pyRuntime.test.ts` precedent.
 */

import assert from "node:assert/strict";
import { SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  CONVERGENCE_ADAPTERS,
  MAIN_KRATOS_PY,
  STOP_SENTINEL_MARKER,
  monitoredMainScript,
  scriptHonoursStopSentinel,
} from "../problemtype/mainKratosTemplate";
import { STOP_FILE_ENV, RUN_ID_ENV, prepareStopSentinel } from "../problemtype/stopSentinel";
import { stopFilePath } from "../problemtype/caseFile";
import { isPidAlive, spawnRun } from "../problemtype/runProcess";

function findPython(): string | undefined {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "print(40+2)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return cmd;
  }
  return undefined;
}
const PYTHON = findPython();

/** The step the fake solve has reached (it writes this file whole each step). */
function stepReached(dir: string): number {
  try {
    return Number(fs.readFileSync(path.join(dir, "progress"), "utf8")) || 0;
  } catch {
    return 0;
  }
}

async function until(fn: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

/** A case folder holding the real template and just enough fake Kratos to run it. */
function caseFolder(script: string): { dir: string; mesh: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-stop-"));
  fs.writeFileSync(path.join(dir, "MainKratos.py"), script);
  fs.writeFileSync(path.join(dir, "ProjectParameters.json"), JSON.stringify({ analysis_stage: "fake_analysis" }));
  fs.mkdirSync(path.join(dir, "KratosMultiphysics"));
  fs.writeFileSync(
    path.join(dir, "KratosMultiphysics", "__init__.py"),
    [
      "import json",
      "class _Value:",
      "    def __init__(self, v): self.v = v",
      "    def GetString(self): return self.v",
      "class Parameters:",
      "    def __init__(self, text): self.data = json.loads(text)",
      "    def __getitem__(self, key): return _Value(self.data[key])",
      "class Model: pass",
      "",
    ].join("\n")
  );
  // Mirrors Kratos' AnalysisStage.Run(): the loop asks KeepAdvancingSolutionLoop
  // before every step and Finalize always runs afterwards. Each step writes a
  // result line WITHOUT flushing — only Finalize's close makes the file whole,
  // which is exactly what a truncating kill would lose.
  fs.writeFileSync(
    path.join(dir, "fake_analysis.py"),
    [
      "import time",
      "class FakeAnalysis:",
      "    parallel_type = 'OpenMP'",
      "    def __init__(self, model, parameters):",
      "        self.step = 0",
      "    def Initialize(self):",
      "        self.results = open('results.txt', 'w')",
      "    def KeepAdvancingSolutionLoop(self):",
      "        return self.step < 100000",
      "    def FinalizeSolutionStep(self):",
      "        self.results.write('step %d\\n' % self.step)",
      "        open('progress', 'w').write(str(self.step))",
      "    def Finalize(self):",
      "        self.results.write('END\\n')",
      "        self.results.close()",
      "        open('finalized', 'w').write('yes')",
      "    def Run(self):",
      "        self.Initialize()",
      "        while self.KeepAdvancingSolutionLoop():",
      "            self.step += 1",
      "            self.FinalizeSolutionStep()",
      "            time.sleep(0.02)",
      "        self.Finalize()",
      "",
    ].join("\n")
  );
  return { dir, mesh: path.join(dir, "case.mdpa") };
}

test("every generated main script carries the sentinel contract, and a script without it does not", () => {
  assert.ok(MAIN_KRATOS_PY.includes(STOP_SENTINEL_MARKER));
  for (const id of [...Object.keys(CONVERGENCE_ADAPTERS), "embeddedFluid", "buoyancy"]) {
    const text = monitoredMainScript(id);
    assert.ok(scriptHonoursStopSentinel(text), `${id}: wired`);
    assert.match(text, /def KeepAdvancingSolutionLoop/, `${id}: hooks the loop`);
  }
  // A script generated before the contract existed must be recognised as such,
  // so a stop does not wait out a grace period it cannot answer.
  assert.equal(scriptHonoursStopSentinel("import KratosMultiphysics\nsimulation.Run()\n"), false);
});

test("the derived scripts are still valid python", (t) => {
  if (!PYTHON) return t.skip("python is not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-syntax-"));
  for (const id of [...Object.keys(CONVERGENCE_ADAPTERS), "embeddedFluid"]) {
    const file = path.join(dir, `${id}.py`);
    fs.writeFileSync(file, monitoredMainScript(id));
    const r: SpawnSyncReturns<string> = spawnSync(PYTHON, ["-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `${id}: ${r.stderr}`);
  }
});

test("prepareStopSentinel wires only a script that honours it, and clears a stale file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-prep-"));
  const mesh = path.join(dir, "case.mdpa");
  const args = { meshFsPath: mesh, caseDir: dir, scriptName: "MainKratos.py", runId: "r1" };

  assert.equal(prepareStopSentinel(args), undefined, "no script at all");
  fs.writeFileSync(path.join(dir, "MainKratos.py"), "print('old generated script')\n");
  assert.equal(prepareStopSentinel(args), undefined, "a script without the marker");

  fs.writeFileSync(path.join(dir, "MainKratos.py"), MAIN_KRATOS_PY);
  fs.writeFileSync(stopFilePath(mesh), "leftover-from-an-earlier-run");
  const prepared = prepareStopSentinel(args)!;
  assert.ok(prepared);
  assert.equal(fs.existsSync(stopFilePath(mesh)), false, "a stale sentinel is removed up front");
  assert.equal(prepared.file, stopFilePath(mesh));
  assert.deepEqual(prepared.env, { [STOP_FILE_ENV]: stopFilePath(mesh), [RUN_ID_ENV]: "r1" });
  prepared.sentinel.write();
  assert.equal(fs.readFileSync(stopFilePath(mesh), "utf8"), "r1", "the content is the run id");
  prepared.remove();
  assert.equal(fs.existsSync(stopFilePath(mesh)), false);
});

test("a real python run stops at a step boundary, finalizes and closes its last result file", async (t) => {
  if (!PYTHON) return t.skip("python is not installed");
  const { dir, mesh } = caseFolder(MAIN_KRATOS_PY);
  const prepared = prepareStopSentinel({ meshFsPath: mesh, caseDir: dir, scriptName: "MainKratos.py", runId: "run-1" })!;
  assert.ok(prepared);
  let out = "";
  const handle = spawnRun({
    argv: [PYTHON, "MainKratos.py"],
    cwd: dir,
    envDelta: { PYTHONPATH: dir, PYTHONUNBUFFERED: "1", ...prepared.env },
    stopSentinel: prepared.sentinel,
    onStdout: (c) => void (out += c),
  });
  const pid = handle.pid!;
  const results = path.join(dir, "results.txt");
  const underway = await until(() => stepReached(dir) >= 3);
  handle.stop();
  const exit = await handle.exited;
  assert.ok(underway, `the solve is under way (${out})`);

  assert.equal(exit.exitCode, 0, `clean exit (${out})`);
  assert.equal(exit.signal, null);
  assert.equal(handle.stopRung, "sentinel");
  assert.equal(isPidAlive(pid), false);
  assert.equal(fs.readFileSync(path.join(dir, "finalized"), "utf8"), "yes", "Finalize ran");
  const lines = fs.readFileSync(results, "utf8").trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], "END", "the last result file was closed whole, not truncated");
  assert.match(out, /stop requested/);
});

test("a stop file naming a different run is ignored by the script", async (t) => {
  if (!PYTHON) return t.skip("python is not installed");
  const { dir, mesh } = caseFolder(MAIN_KRATOS_PY);
  const prepared = prepareStopSentinel({ meshFsPath: mesh, caseDir: dir, scriptName: "MainKratos.py", runId: "run-2" })!;
  // Planted AFTER prepare (which clears stale files): e.g. a racing writer.
  fs.writeFileSync(prepared.file, "run-1");
  const handle = spawnRun({
    argv: [PYTHON, "MainKratos.py"],
    cwd: dir,
    envDelta: { PYTHONPATH: dir, ...prepared.env },
    stopSentinel: { ...prepared.sentinel, graceMs: 20000 },
  });
  const reached = await until(() => stepReached(dir) >= 10);
  const aliveBefore = isPidAlive(handle.pid!);
  handle.stop(); // overwrites the file with THIS run's id
  const exit = await handle.exited;
  assert.ok(reached, "the solve got past the foreign stop file");
  assert.equal(aliveBefore, true, "someone else's stop file did not stop this run");
  assert.equal(exit.exitCode, 0);
  assert.equal(handle.stopRung, "sentinel");
});

test("a launch with no sentinel environment is untouched by the check", async (t) => {
  if (!PYTHON) return t.skip("python is not installed");
  const { dir } = caseFolder(MAIN_KRATOS_PY);
  // A stop file exists beside the case but the launcher did not name it.
  fs.writeFileSync(path.join(dir, "case.kratosstop"), "run-1");
  const handle = spawnRun({ argv: [PYTHON, "MainKratos.py"], cwd: dir, envDelta: { PYTHONPATH: dir } });
  const reached = await until(() => stepReached(dir) >= 10);
  const aliveAfter = isPidAlive(handle.pid!);
  handle.kill();
  await handle.exited;
  assert.ok(reached, "the solve kept advancing");
  assert.equal(aliveAfter, true, "a standalone run only stops when told to");
});
