/**
 * runCore.ts — the run manager's pure core.
 *
 * `latestResultFile` carries the most weight here: it replaces a hand-rolled
 * `names.sort()[0]` that was wrong three separate ways, and each of those ways
 * gets its own assertion below so a regression names itself.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  RunRecord,
  caseKeyFor,
  displayCommand,
  formatDuration,
  isDone,
  isLive,
  latestResultFile,
  quoteArg,
  runContextValue,
  runRowDescription,
  runRowIconId,
} from "../problemtype/runCore";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    caseKey: "/w/beam.mdpa",
    meshFsPath: "/w/beam.mdpa",
    caseDir: "/w",
    stem: "beam",
    argv: ["python3", "MainKratos.py"],
    launchMode: "output",
    startedAt: 1_000_000,
    status: "running",
    ...over,
  };
}

test("latestResultFile orders steps NUMERICALLY, not lexicographically", () => {
  // The original bug: "Main_0_10" sorts before "Main_0_2" as a string.
  const r = latestResultFile(["Main_0_2.vtu", "Main_0_10.vtu", "Main_0_4.vtu"]);
  assert.equal(r?.step, "10");
  assert.equal(r?.fileName, "Main_0_10.vtu");
  // ...and it takes the LAST step, where the old code took names[0].
  assert.equal(r?.frameIndex, 2);
});

test("latestResultFile sees the extensions the old regex missed", () => {
  // The previous filter was /\.(vtk|vtu|vtp|vtm)$/i — these three were dropped.
  for (const ext of [".vti", ".vts", ".vtr"]) {
    const r = latestResultFile([`Main_0_1${ext}`, `Main_0_2${ext}`]);
    assert.equal(r?.step, "2", `${ext} should be found`);
    assert.equal(r?.fileName, `Main_0_2${ext}`);
  }
});

test("excludeNewest drops the possibly-truncated final step", () => {
  const names = ["Main_0_1.vtu", "Main_0_2.vtu", "Main_0_3.vtu"];
  assert.equal(latestResultFile(names)?.step, "3");
  assert.equal(latestResultFile(names, { excludeNewest: true })?.step, "2");
  // With a single step there is nothing safe to fall back to, so it is kept
  // rather than returning nothing at all.
  assert.equal(latestResultFile(["Main_0_1.vtu"], { excludeNewest: true })?.step, "1");
});

test("latestResultFile returns undefined rather than guessing", () => {
  assert.equal(latestResultFile([]), undefined);
  assert.equal(latestResultFile(["notes.txt", "ProjectParameters.json"]), undefined);
});

test("latestResultFile picks the root series, not a subpart, deterministically", () => {
  // A real Kratos output directory: the root plus two subpart series.
  const names = [
    "Main_0_2.vtk", "Main_0_4.vtk", "Main_0_6.vtk",
    "Main_MovingNodes_0_2.vtk", "Main_MovingNodes_0_4.vtk", "Main_MovingNodes_0_6.vtk",
  ];
  const r = latestResultFile(names);
  assert.equal(r?.step, "6");
  assert.ok(r?.fileName.startsWith("Main_0_"), `picked ${r?.fileName}`);
  // Same answer whatever order readdir happened to return.
  const shuffled = latestResultFile([...names].reverse());
  assert.equal(shuffled?.fileName, r?.fileName);
});

test("row description reads differently for each state", () => {
  const now = 1_000_000 + 72_000; // 1m 12s in
  assert.equal(
    runRowDescription(record({ progress: { stepLabel: "34" } }), now),
    "running · 1m 12s · step 34"
  );
  assert.equal(
    runRowDescription(record({ status: "failed", endedAt: 1_004_000, exitCode: 1 }), now),
    "failed · 0m 04s · exit 1"
  );
  assert.equal(
    runRowDescription(record({ status: "detached", launchMode: "terminal" }), now),
    "detached · 1m 12s · terminal"
  );
  // A finished run stops counting at its end, not at "now".
  assert.equal(
    runRowDescription(record({ status: "finished", endedAt: 1_060_000 }), now),
    "finished · 1m 00s"
  );
});

test("icons and context values follow the status", () => {
  assert.equal(runRowIconId(record({ status: "running" })), "sync~spin");
  assert.equal(runRowIconId(record({ status: "finished" })), "pass");
  assert.equal(runRowIconId(record({ status: "failed" })), "error");
  assert.equal(runRowIconId(record({ status: "cancelled" })), "circle-slash");
  assert.equal(runRowIconId(record({ status: "detached" })), "question");
  assert.equal(runRowIconId(record({ status: "orphaned" })), "warning");
  assert.equal(runContextValue(record({ status: "failed" })), "kratosRun.failed");
});

test("a detached run counts as live; a cancelled one does not", () => {
  // detached is the honest "may still be running without us" state, so it must
  // still offer Stop — which is what isLive gates.
  assert.ok(isLive(record({ status: "detached" })));
  assert.ok(isLive(record({ status: "starting" })));
  assert.ok(!isLive(record({ status: "cancelled" })));
  assert.ok(isDone(record({ status: "orphaned" })));
});

test("quoting is for display, and is platform-correct", () => {
  assert.equal(quoteArg("linux", "python3"), "python3");
  assert.equal(quoteArg("linux", "/opt/my kratos/python3"), "'/opt/my kratos/python3'");
  assert.equal(quoteArg("win32", "C:\\Program Files\\python.exe"), '"C:\\Program Files\\python.exe"');
  assert.equal(
    displayCommand(["/opt/my kratos/python3", "MainKratos.py"], "linux"),
    "'/opt/my kratos/python3' MainKratos.py"
  );
});

test("formatDuration switches to hours and pads seconds", () => {
  assert.equal(formatDuration(0), "0m 00s");
  assert.equal(formatDuration(4_000), "0m 04s");
  assert.equal(formatDuration(72_000), "1m 12s");
  assert.equal(formatDuration(3_700_000), "1h 1m");
  assert.equal(formatDuration(-1), "");
});

test("caseKey is case-insensitive only where the filesystem is", () => {
  assert.equal(caseKeyFor("/W/Beam.mdpa", "linux"), "/W/Beam.mdpa");
  assert.equal(caseKeyFor("C:\\W\\Beam.mdpa", "win32"), "c:\\w\\beam.mdpa");
});
