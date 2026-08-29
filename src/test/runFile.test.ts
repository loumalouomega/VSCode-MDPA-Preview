/**
 * runFile.ts — the `<stem>.kratosrun.json` sidecar.
 *
 * Mirrors caseFile.test.ts: the contract is that a corrupt or foreign file
 * degrades to warnings and never throws, because this file is read on startup
 * and a crash there would take the whole run view with it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RunRecord } from "../problemtype/runCore";
import { parseRunJson, reconcileStatus, serializeRun, sidecarFromRecord } from "../problemtype/runFile";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "abc-1",
    caseKey: "/w/beam.mdpa",
    meshFsPath: "/w/beam.mdpa",
    caseDir: "/w",
    stem: "beam",
    argv: ["python3", "MainKratos.py"],
    launchMode: "output",
    startedAt: 1700,
    status: "running",
    pid: 4242,
    ...over,
  };
}

test("a record round-trips through the sidecar", () => {
  const text = serializeRun(sidecarFromRecord(record(), "extension"));
  const { sidecar, warnings } = parseRunJson(text);
  assert.deepEqual(warnings, []);
  assert.equal(sidecar?.runId, "abc-1");
  assert.equal(sidecar?.status, "running");
  assert.equal(sidecar?.pid, 4242);
  assert.deepEqual(sidecar?.argv, ["python3", "MainKratos.py"]);
  assert.equal(sidecar?.launchedBy, "extension");
  assert.equal(sidecar?.version, 1);
});

test("finished runs carry their exit code, including zero", () => {
  const text = serializeRun(
    sidecarFromRecord(record({ status: "finished", endedAt: 9000, exitCode: 0 }), "extension")
  );
  const { sidecar } = parseRunJson(text);
  assert.equal(sidecar?.status, "finished");
  // 0 must survive: a falsy-check bug here would report "no exit code".
  assert.equal(sidecar?.exitCode, 0);
  assert.equal(sidecar?.endedAt, 9000);
});

test("garbage never throws", () => {
  for (const bad of ["", "{", "null", "[]", '"a string"', "12"]) {
    const r = parseRunJson(bad);
    assert.equal(r.sidecar, undefined, `${JSON.stringify(bad)} should yield no record`);
    assert.ok(r.warnings.length > 0);
  }
});

test("a newer version is reported, not refused", () => {
  const { sidecar, warnings } = parseRunJson(
    JSON.stringify({ version: 99, runId: "x", status: "finished" })
  );
  assert.ok(sidecar, "a future file is still read as best it can be");
  assert.ok(warnings.some((w) => w.includes("99")));
});

test("an unreadable status degrades to orphaned, never to running", () => {
  const { sidecar, warnings } = parseRunJson(
    JSON.stringify({ runId: "x", status: "sprinting", pid: 1 })
  );
  assert.equal(sidecar?.status, "orphaned");
  assert.ok(warnings.some((w) => w.includes("sprinting")));
});

test("missing optional fields are tolerated", () => {
  const { sidecar, warnings } = parseRunJson(JSON.stringify({ runId: "x", status: "running" }));
  assert.deepEqual(warnings, []);
  assert.equal(sidecar?.pid, undefined);
  assert.equal(sidecar?.exitCode, undefined);
  assert.deepEqual(sidecar?.argv, []);
  assert.equal(sidecar?.startedAt, 0);
});

test("reconcile never promotes a stale record back to running", () => {
  const base = parseRunJson(
    serializeRun(sidecarFromRecord(record({ status: "running" }), "extension"))
  ).sidecar!;

  // A live pid is only a maybe — pids get reused.
  const live = reconcileStatus(base, true);
  assert.equal(live.status, "detached");
  assert.match(live.message ?? "", /may still be running/);

  const dead = reconcileStatus(base, false);
  assert.equal(dead.status, "orphaned");
  assert.match(dead.message ?? "", /no exit code/);

  // No pid at all cannot be checked either way.
  const noPid = reconcileStatus({ ...base, pid: undefined }, undefined);
  assert.equal(noPid.status, "orphaned");
  assert.match(noPid.message ?? "", /No pid/);
});

test("reconcile leaves settled runs alone", () => {
  const finished = parseRunJson(
    serializeRun(
      sidecarFromRecord(record({ status: "finished", exitCode: 0, endedAt: 5 }), "extension")
    )
  ).sidecar!;
  // Even told the pid is alive (it was reused), a finished run stays finished.
  assert.equal(reconcileStatus(finished, true).status, "finished");
});

test("stopRequested round-trips, so a stop can cross a process boundary", () => {
  // The in-memory latch cannot reach the process that will write the terminal
  // record. This is what makes an MCP-issued stop of an extension-owned run
  // read `cancelled` instead of `failed`.
  const text = serializeRun(sidecarFromRecord(record({ stopRequested: true }), "mcp"));
  const { sidecar } = parseRunJson(text);
  assert.equal(sidecar!.stopRequested, true);
  assert.equal(sidecar!.launchedBy, "mcp");
});

test("stopRequested is absent, not false, when no stop was asked for", () => {
  const text = serializeRun(sidecarFromRecord(record({}), "extension"));
  assert.equal(JSON.parse(text).stopRequested, undefined);
  assert.equal(parseRunJson(text).sidecar!.stopRequested, undefined);
});

test("a non-boolean stopRequested never claims a stop", () => {
  for (const bogus of ['"yes"', "1", "null", "{}"]) {
    const text = `{"version":1,"runId":"r","stem":"s","meshFile":"m","status":"running",` +
      `"launchMode":"output","argv":["python"],"startedAt":1,"launchedBy":"mcp","stopRequested":${bogus}}`;
    const { sidecar } = parseRunJson(text);
    assert.equal(sidecar!.stopRequested, undefined, `stopRequested:${bogus} must not latch`);
  }
});

test("a sidecar written before stopRequested existed still parses", () => {
  const text = `{"version":1,"runId":"r","stem":"s","meshFile":"m","status":"running",` +
    `"launchMode":"output","argv":["python"],"startedAt":1,"launchedBy":"extension"}`;
  const { sidecar, warnings } = parseRunJson(text);
  assert.ok(sidecar);
  assert.equal(sidecar!.stopRequested, undefined);
  assert.deepEqual(warnings, []);
});

test("a detached run records its log file", () => {
  const text = serializeRun(sidecarFromRecord(record({}), "mcp", "/tmp/beam.kratosrun.log"));
  assert.equal(parseRunJson(text).sidecar!.logFile, "/tmp/beam.kratosrun.log");
});
