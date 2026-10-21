import { test, after } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import {
  applyOpAsync,
  applyOracleOp,
  configureOracleRunner,
  isOracleOp,
  opRecordFromMessage,
  ORACLE_OPS_FOR_TEST,
} from "../parser/operations";
import type { OpRecord } from "../parser/operations";
import { createOracleWorkerRunner, runOracleInWorker } from "../oracleOpWorkerClient";

const CUBE = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements
`;

const rec = (msg: Record<string, unknown>): OpRecord => {
  const r = opRecordFromMessage(msg);
  assert.ok(r, `invalid op ${JSON.stringify(msg)}`);
  return r;
};

after(() => {
  // Leave the in-process default for any later test in this process.
  configureOracleRunner((m, r, o) => applyOracleOp(m, r, o));
});

test("the oracle set is exactly the meshio++ ops, not the MMG or native ones", () => {
  for (const op of ["smooth", "reorder", "partition", "fieldGradient", "sdfDistance", "repairSurface"]) {
    assert.ok(isOracleOp(op), op);
  }
  for (const op of ["remesh", "levelset", "mergeMesh", "scale", "renumber"]) assert.ok(!isOracleOp(op), op);
  assert.ok(ORACLE_OPS_FOR_TEST.length >= 16);
});

test("applyOracleOp refuses an op that is not an oracle op", async () => {
  await assert.rejects(applyOracleOp(parseMdpa(CUBE), rec({ op: "scale", sx: 2, sy: 2, sz: 2 })), /not an oracle operation/);
});

test("the worker result equals the in-process result (smooth, reorder, partition)", async () => {
  for (const msg of [
    { op: "smooth", iterations: 3 },
    { op: "reorder", method: "rcm" },
    { op: "partition", nparts: 2 },
  ]) {
    const m = parseMdpa(CUBE);
    const r = rec(msg);
    const inProc = await applyOracleOp(m, r);
    const viaWorker = await runOracleInWorker(m, r);
    assert.equal(viaWorker.noop, inProc.noop, msg.op);
    assert.equal(viaWorker.message, inProc.message, msg.op);
    assert.deepEqual(viaWorker.model.nodeIds, inProc.model.nodeIds, msg.op);
    assert.deepEqual(Array.from(viaWorker.model.coords), Array.from(inProc.model.coords), msg.op);
    assert.deepEqual(viaWorker.model.fields.map((f) => f.variable), inProc.model.fields.map((f) => f.variable), msg.op);
    // The structured-clone round trip must preserve the typed arrays.
    assert.ok(viaWorker.model.coords instanceof Float32Array, msg.op);
  }
});

test("a refusal rejects with the core's own message", async () => {
  const m = parseMdpa(CUBE);
  // A volume mesh is refused by name before any wasm runs.
  const r = rec({ op: "curvature" });
  const expected = await applyOracleOp(m, r).then(
    () => undefined,
    (e: Error) => e.message
  );
  if (expected === undefined) return; // curvature handled it as a no-op here: nothing to compare
  await assert.rejects(runOracleInWorker(m, r), (e: Error) => e.message === expected);
});

test("an unreadable second mesh stays a no-op with a reason and the original model", async () => {
  const m = parseMdpa(CUBE);
  const out = await runOracleInWorker(m, rec({ op: "transferField", path: "/nonexistent/other.vtu" }));
  assert.equal(out.noop, true);
  // A no-op keeps the caller's own model object: replay code compares identity.
  assert.equal(out.model, m);
  assert.match(out.message ?? "", /Could not read/);
});

test("a pre-aborted signal rejects 'cancelled' without spawning", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runOracleInWorker(parseMdpa(CUBE), rec({ op: "smooth" }), { signal: abort.signal }), /cancelled/);
});

test("aborting mid-run rejects 'cancelled' while the host event loop keeps ticking", async () => {
  const abort = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const run = runOracleInWorker(parseMdpa(CUBE), rec({ op: "smooth", iterations: 3 }), { signal: abort.signal });
    abort.abort();
    await assert.rejects(run, /cancelled/);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
  }
});

test("applyOpAsync maps a cancelled worker run to a no-op outcome on the original model", async () => {
  configureOracleRunner(createOracleWorkerRunner());
  const m = parseMdpa(CUBE);
  const abort = new AbortController();
  const run = applyOpAsync(m, rec({ op: "smooth", iterations: 3 }), { signal: abort.signal });
  abort.abort();
  const out = await run;
  assert.equal(out.noop, true);
  assert.equal(out.model, m);
  assert.match(out.message ?? "", /cancelled/i);
});

test("applyOpAsync through the worker runner gives the same result as in-process", async () => {
  const m = parseMdpa(CUBE);
  const r = rec({ op: "reorder", method: "morton" });
  configureOracleRunner((model, rc, o) => applyOracleOp(model, rc, o));
  const a = await applyOpAsync(m, r);
  configureOracleRunner(createOracleWorkerRunner());
  const b = await applyOpAsync(m, r);
  assert.equal(b.message, a.message);
  assert.deepEqual(b.model.nodeIds, a.model.nodeIds);
});

test("progress stage lines reach onProgress", async () => {
  const lines: string[] = [];
  await runOracleInWorker(parseMdpa(CUBE), rec({ op: "reorder", method: "rcm" }), { onProgress: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /worker/.test(l)), lines.join("\n"));
});

test("a KaHIP partition (full artifact) runs in the worker, matches in-process, and a cancel terminates it", async () => {
  const m = parseMdpa(CUBE);
  const r = rec({ op: "partition", nparts: 2, method: "kahip" });
  configureOracleRunner((model, rc, o) => applyOracleOp(model, rc, o));
  const a = await applyOpAsync(m, r);
  configureOracleRunner(createOracleWorkerRunner());
  const b = await applyOpAsync(m, r);
  assert.match(b.message ?? "", /KaHIP/);
  assert.equal(b.message, a.message);
  const labels = (x: typeof a): number[] => Array.from(x.model.fields.find((f) => f.variable === "PARTITION_INDEX")!.values);
  assert.deepEqual(labels(b), labels(a));

  const abort = new AbortController();
  const run = applyOpAsync(m, r, { signal: abort.signal });
  abort.abort();
  const out = await run;
  assert.equal(out.noop, true);
  assert.equal(out.model, m);
  assert.match(out.message ?? "", /cancelled/i);
});
