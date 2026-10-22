/**
 * runCompare.ts — comparing two saved runs by what each one recorded.
 *
 * The contract under test is the acceptance criterion of former roadmap item 6, delivered 2026-10-19: two
 * runs of cases sharing a source folder must be comparable without their files
 * colliding, and a legacy receipt must never be upgraded by hashing today's
 * bytes. So every fixture here is a run DIRECTORY with its own receipt and
 * manifest, and the comparison only ever reads what those files say.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { compareRuns, diffSettings, readRunEvidence } from "../problemtype/runCompare";
import type { ExecutionReceipt } from "../problemtype/runReceipt";
import type { PreparationReport } from "../problemtype/preparation";
import { createHash } from "node:crypto";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-compare-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const receipt = (dir: string, over: Partial<ExecutionReceipt> = {}): ExecutionReceipt => ({
  version: 1,
  requestId: "request-a",
  ownerId: "study-a",
  jobId: "job-a",
  state: "succeeded",
  runDirectory: dir,
  meshPath: path.join(dir, "beam.mdpa"),
  createdAt: 1,
  updatedAt: 2,
  artifacts: [],
  ...over,
});

const preparation = (over: Partial<PreparationReport> = {}): PreparationReport => {
  // `parsePreparationReport` re-derives the settings revision, so the fixture has
  // to be a report the real reader accepts, not a loose object.
  const settings = (over.settings as { problemtypeId: string } | undefined) ?? { problemtypeId: "structural", values: {} };
  return {
    version: 1,
    producer: { name: "vscode-mdpa.case-generator", source: "builtin", scriptRevision: hash("main") },
    problemtype: settings.problemtypeId,
    sourceMesh: { name: "beam.mdpa", revision: "1".repeat(64) },
    solverMesh: { name: "beam.mdpa", revision: "1".repeat(64) },
    primaryDocument: "ProjectParameters.json",
    driverScript: "MainKratos.py",
    settings: settings as never,
    settingsRevision: hash(JSON.stringify(settings)),
    effectiveParameters: {},
    units: { state: "undeclared", reason: "none" },
    findings: [],
    inputs: [
      { name: "ProjectParameters.json", revision: hash("parameters") },
      { name: "MainKratos.py", revision: hash("main") },
    ],
    ...over,
  };
};

function run(t: { after: (fn: () => void) => void }, over: { receipt?: Partial<ExecutionReceipt>; preparation?: PreparationReport | null } = {}): string {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "beam.mdpa"), "Begin Nodes\nEnd Nodes\n");
  fs.writeFileSync(path.join(dir, ".kkss-execution.json"), JSON.stringify(receipt(dir, over.receipt), null, 2));
  if (over.preparation !== null) {
    fs.writeFileSync(path.join(dir, "kkss-preparation-v1.json"), JSON.stringify(over.preparation ?? preparation(), null, 2));
  }
  return dir;
}

test("two terminal runs of the same case compare by identity, settings and outputs", (t) => {
  const left = run(t, {
    receipt: {
      artifacts: [
        { role: "mesh", path: "beam.mdpa", revision: "1".repeat(64) },
        { role: "result", path: "vtk_output/result_0.vtk", revision: "c".repeat(64) },
        { role: "result", path: "vtk_output/result_1.vtk", revision: "d".repeat(64) },
      ],
    },
  });
  // Artifact paths are stored absolute in a real receipt; use them as such.
  const leftReceipt = readRunEvidence(left).receipt!;
  leftReceipt.artifacts = [
    { role: "mesh", path: path.join(left, "beam.mdpa"), revision: "1".repeat(64) },
    { role: "result", path: path.join(left, "vtk_output", "result_0.vtk"), revision: "c".repeat(64) },
    { role: "result", path: path.join(left, "vtk_output", "result_1.vtk"), revision: "d".repeat(64) },
  ];
  fs.writeFileSync(path.join(left, ".kkss-execution.json"), JSON.stringify(leftReceipt, null, 2));

  const right = run(t, {
    receipt: { requestId: "request-b", jobId: "job-b" },
  });
  const rightReceipt = readRunEvidence(right).receipt!;
  rightReceipt.artifacts = [
    { role: "mesh", path: path.join(right, "beam.mdpa"), revision: "1".repeat(64) },
    { role: "result", path: path.join(right, "vtk_output", "result_0.vtk"), revision: "e".repeat(64) },
    { role: "result", path: path.join(right, "vtk_output", "result_1.vtk"), revision: "d".repeat(64) },
    { role: "log", path: path.join(right, "beam.kratosrun.log"), revision: "f".repeat(64) },
  ];
  fs.writeFileSync(path.join(right, ".kkss-execution.json"), JSON.stringify(rightReceipt, null, 2));

  const comparison = compareRuns(left, right);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.problems, []);
  assert.equal(comparison.left.requestId, "request-a");
  assert.equal(comparison.right.requestId, "request-b");
  assert.deepEqual(comparison.same, { sourceMesh: true, problemtype: true, settings: true });
  // Same names, so they pair up; one pair changed bytes, one did not.
  assert.deepEqual(comparison.counts, { paired: 3, onlyLeft: 0, onlyRight: 1, changed: 1, unverified: 0 });
  assert.deepEqual(comparison.changed.map((a) => a.path), ["vtk_output/result_0.vtk"]);
  assert.deepEqual(comparison.onlyRight, [`log:${path.join("beam.kratosrun.log")}`]);
  assert.deepEqual(comparison.onlyLeft, []);
});

test("changed settings are reported leaf by leaf, with both values", () => {
  const changes = diffSettings(
    { problemtypeId: "structural", values: { materials: { E: 210e9, nu: 0.3 } }, notes: "" },
    { problemtypeId: "structural", values: { materials: { E: 70e9, nu: 0.3 } }, notes: "" }
  );
  assert.deepEqual(changes, [{ path: "values.materials.E", left: 210e9, right: 70e9 }]);
});

test("arrays compare whole, and an absent key is a change with one side missing", () => {
  const changes = diffSettings({ ids: [1, 2], gone: 1 }, { ids: [1, 2], added: 2 });
  assert.deepEqual(changes, [
    { path: "added", right: 2 },
    { path: "gone", left: 1 },
  ]);
});

test("a different source revision or problemtype is named, not silently compared", (t) => {
  const left = run(t, {});
  const right = run(t, {
    preparation: preparation({
      problemtype: "fluid",
      settings: { problemtypeId: "fluid", values: {} } as never,
      sourceMesh: { name: "beam.mdpa", revision: "9".repeat(64) },
    }),
  });
  const comparison = compareRuns(left, right);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.same.sourceMesh, false);
  assert.equal(comparison.same.problemtype, false);
  assert.equal(comparison.same.settings, false);
});

test("a live run is not comparable: its outputs are still changing", (t) => {
  const left = run(t, {});
  const right = run(t, { receipt: { state: "running" } });
  const comparison = compareRuns(left, right);
  assert.equal(comparison.comparable, false);
  assert.match(comparison.problems.join(" "), /is running, so its outputs are still changing/);
  // It still names both identities, so an agent can report which side was live.
  assert.equal(comparison.right.state, "running");
});

test("a missing receipt is a stated problem, never an inferred ownership", (t) => {
  const left = run(t, {});
  const right = tmp(t);
  fs.writeFileSync(path.join(right, "beam.mdpa"), "Begin Nodes\nEnd Nodes\n");
  const comparison = compareRuns(left, right);
  assert.equal(comparison.comparable, false);
  assert.match(comparison.problems.join(" "), /No execution receipt/);
});

test("comparing a run with itself is refused rather than reported as identical", (t) => {
  const left = run(t, {});
  const comparison = compareRuns(left, left);
  assert.equal(comparison.comparable, false);
  assert.match(comparison.problems.join(" "), /same run directory/);
});

test("a receipt written before preparation manifests existed still compares artifacts", (t) => {
  const left = run(t, { preparation: null });
  const right = run(t, { preparation: null });
  const comparison = compareRuns(left, right);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.same, {}, "nothing to claim about settings or source");
  assert.deepEqual(comparison.settings, []);
});

test("the recorded revisions are what compare, never today's bytes", (t) => {
  const left = run(t, {});
  const right = run(t, {});
  const receiptLeft = readRunEvidence(left).receipt!;
  receiptLeft.artifacts = [{ role: "result", path: path.join(left, "vtk_output", "r.vtk"), revision: hash("old") }];
  fs.writeFileSync(path.join(left, ".kkss-execution.json"), JSON.stringify(receiptLeft));
  const receiptRight = readRunEvidence(right).receipt!;
  receiptRight.artifacts = [{ role: "result", path: path.join(right, "vtk_output", "r.vtk"), revision: hash("old") }];
  fs.writeFileSync(path.join(right, ".kkss-execution.json"), JSON.stringify(receiptRight));
  // The files on disk now hold different bytes; the receipts still agree.
  fs.mkdirSync(path.join(left, "vtk_output"));
  fs.mkdirSync(path.join(right, "vtk_output"));
  fs.writeFileSync(path.join(left, "vtk_output", "r.vtk"), "rewritten left");
  fs.writeFileSync(path.join(right, "vtk_output", "r.vtk"), "rewritten right");
  assert.deepEqual(compareRuns(left, right).changed, []);
});

test("an artifact neither receipt pinned is unverified, never 'unchanged'", (t) => {
  const left = run(t, {});
  const right = run(t, {});
  for (const [dir, revision] of [[left, "a".repeat(64)], [right, undefined]] as const) {
    const evidence = readRunEvidence(dir).receipt!;
    evidence.artifacts = [{ role: "result", path: path.join(dir, "vtk_output", "r.vtk"), ...(revision ? { revision } : {}) }];
    fs.writeFileSync(path.join(dir, ".kkss-execution.json"), JSON.stringify(evidence));
  }
  const comparison = compareRuns(left, right);
  assert.equal(comparison.counts.unverified, 1);
  assert.deepEqual(comparison.changed, [], "nothing was proven different");
  assert.equal(comparison.unverified[0].unverified, true);
  assert.equal(comparison.unverified[0].right, undefined);
});

test("the CAD export identity is compared when both runs record one", (t) => {
  const handoff = { source: "bracket.step", sourceRevision: "7".repeat(64), replay: "8".repeat(64) };
  const left = run(t, { preparation: preparation({ handoff }) });
  const same = run(t, { preparation: preparation({ handoff }) });
  assert.equal(compareRuns(left, same).same.cadSource, true);
  const other = run(t, { preparation: preparation({ handoff: { ...handoff, sourceRevision: "9".repeat(64) } }) });
  assert.equal(compareRuns(left, other).same.cadSource, false);
  // A run without a handoff makes no claim at all.
  const plain = run(t, {});
  assert.equal(compareRuns(left, plain).same.cadSource, undefined);
});
