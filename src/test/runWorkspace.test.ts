/**
 * runWorkspace.ts — where an isolated run lives and what it snapshots.
 *
 * Both producers (the sidebar's Run and MCP `case_run`) go through these
 * functions, so the contract under test is the one users get from either side:
 * a deterministic workspace name, a folder setting that cannot escape the case
 * folder, and a snapshot that refuses to overwrite anything.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_RUNS_FOLDER,
  planRunWorkspace,
  runWorkspaceFolder,
  snapshotRunInputs,
} from "../problemtype/runWorkspace";

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-workspace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a run workspace is <case>/runs/<stem>-<runId>", () => {
  assert.equal(planRunWorkspace({ caseDir: "/w/case", stem: "beam", runId: "r1" }), path.join("/w/case", "runs", "beam-r1"));
  assert.equal(
    planRunWorkspace({ caseDir: "/w/case", stem: "beam", runId: "r1", runsFolder: "isolated/runs" }),
    path.join("/w/case", "isolated", "runs", "beam-r1")
  );
});

test("the same request plans the same directory, so a retry finds its own receipt", () => {
  const options = { caseDir: "/w/case", stem: "beam", runId: "request-a" };
  assert.equal(planRunWorkspace(options), planRunWorkspace(options));
});

test("the runs folder can never escape the case folder", () => {
  assert.equal(runWorkspaceFolder(undefined), DEFAULT_RUNS_FOLDER);
  assert.equal(runWorkspaceFolder(""), DEFAULT_RUNS_FOLDER);
  assert.equal(runWorkspaceFolder("   "), DEFAULT_RUNS_FOLDER);
  // Absolute paths and parent traversal fall back rather than resolving out.
  assert.equal(runWorkspaceFolder("/tmp/elsewhere"), DEFAULT_RUNS_FOLDER);
  assert.equal(runWorkspaceFolder("C:\\runs"), DEFAULT_RUNS_FOLDER);
  assert.equal(runWorkspaceFolder("../runs"), DEFAULT_RUNS_FOLDER);
  assert.equal(runWorkspaceFolder("runs/../../escape"), DEFAULT_RUNS_FOLDER);
  assert.equal(runWorkspaceFolder("./runs"), DEFAULT_RUNS_FOLDER);
  // A nested folder stays inside the case folder.
  assert.equal(runWorkspaceFolder("work/runs"), path.join("work", "runs"));
  assert.equal(runWorkspaceFolder("work//runs"), path.join("work", "runs"));
});

test("a run id that is not an identity is refused by name", () => {
  // A path component on Windows cannot carry a colon, and a trailing dot or
  // space names a different file there than it reads as.
  for (const runId of ["", "../escape", "a/b", "a\\b", "x".repeat(129), "p:1", "r1.", "r1 "]) {
    assert.throws(() => planRunWorkspace({ caseDir: "/w", stem: "beam", runId }), /not a usable run id/);
  }
});

test("the snapshot copies the mesh byte-for-byte and the case under the run's own name", (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "beam.mdpa"), "Begin Nodes\n1 0 0 0\nEnd Nodes\n");
  // A caller-named state file must still land where this workspace's tools look.
  fs.writeFileSync(path.join(source, "handed-over.json"), '{"problemtypeId":"solid"}');
  fs.writeFileSync(path.join(source, "custom_driver.py"), "print('run')\n");
  const runDirectory = path.join(dir, "case", "runs", "beam-r1");

  const snapshot = snapshotRunInputs({
    sourceMesh: path.join(source, "beam.mdpa"),
    runDirectory,
    casePath: path.join(source, "handed-over.json"),
    scriptName: "custom_driver.py",
  });

  assert.equal(snapshot.meshPath, path.join(runDirectory, "beam.mdpa"));
  assert.deepEqual(fs.readFileSync(snapshot.meshPath), fs.readFileSync(path.join(source, "beam.mdpa")));
  assert.equal(snapshot.casePath, path.join(runDirectory, "beam.kratoscase.json"));
  assert.equal(fs.readFileSync(snapshot.casePath!, "utf8"), '{"problemtypeId":"solid"}');
  assert.equal(snapshot.scriptPath, path.join(runDirectory, "custom_driver.py"));
});

test("a missing case file or driver is simply not snapshotted", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "beam.mdpa"), "Begin Nodes\nEnd Nodes\n");
  const snapshot = snapshotRunInputs({
    sourceMesh: path.join(dir, "beam.mdpa"),
    runDirectory: path.join(dir, "runs", "beam-r1"),
    casePath: path.join(dir, "beam.kratoscase.json"),
    scriptName: "MainKratos.py",
  });
  assert.equal(snapshot.casePath, undefined);
  assert.equal(snapshot.scriptPath, undefined);
  assert.ok(fs.existsSync(snapshot.meshPath));
});

test("the snapshot never overwrites an existing file", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "beam.mdpa"), "new bytes\n");
  const runDirectory = path.join(dir, "runs", "beam-r1");
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(path.join(runDirectory, "beam.mdpa"), "old bytes\n");

  assert.throws(() =>
    snapshotRunInputs({ sourceMesh: path.join(dir, "beam.mdpa"), runDirectory })
  );
  // The existing copy is untouched — that is the whole point of COPYFILE_EXCL.
  assert.equal(fs.readFileSync(path.join(runDirectory, "beam.mdpa"), "utf8"), "old bytes\n");
});
