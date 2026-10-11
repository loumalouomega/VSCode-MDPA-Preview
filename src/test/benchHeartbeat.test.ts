/** The verdict logic behind scripts/bench/host-heartbeat.mjs --check (the timing itself is not a unit test: it is flaky on shared CI). */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Row { runs: number; wallMs: number; p50Ms: number; p99Ms: number; maxStallMs: number; rssDeltaMb: number }
interface Verdict { name: string; verdict: string; reason: string }
interface Stats {
  median(v: number[]): number;
  summarizeRuns(runs: Omit<Row, "runs">[]): Row;
  judgeCase(name: string, base: Row | undefined, worker: Row | undefined, o?: { maxStallMs?: number; minRatio?: number; minBaselineMs?: number }): Verdict;
  checkPasses(v: Verdict[], o?: { strict?: boolean }): boolean;
}

// A real dynamic import (tsc would otherwise downlevel it to require(), which cannot load .mjs everywhere).
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<Stats>;
const load = (): Promise<Stats> =>
  importEsm(pathToFileURL(path.resolve(__dirname, "..", "..", "scripts", "bench", "heartbeatStats.mjs")).href);

const row = (maxStallMs: number): Row => ({ runs: 3, wallMs: 1, p50Ms: 1, p99Ms: 1, maxStallMs, rssDeltaMb: 0 });

test("median handles odd, even and empty input", async () => {
  const { median } = await load();
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("the max stall of a case is the median of its runs' maxima, not the worst single run", async () => {
  const { summarizeRuns } = await load();
  const r = summarizeRuns([5, 900, 6].map((m) => ({ wallMs: 10, p50Ms: 1, p99Ms: 2, maxStallMs: m, rssDeltaMb: 0 })));
  assert.equal(r.maxStallMs, 6);
});

test("a worker that stalls the host is a failure, whatever the baseline did", async () => {
  const { judgeCase } = await load();
  assert.equal(judgeCase("x", row(500), row(80)).verdict, "fail");
});

test("a small fixture is inconclusive, never a pass", async () => {
  const { judgeCase } = await load();
  const v = judgeCase("x", row(20), row(2));
  assert.equal(v.verdict, "inconclusive");
  assert.match(v.reason, /larger fixture/);
});

test("the worker must beat the baseline by the required ratio", async () => {
  const { judgeCase } = await load();
  const loose = { maxStallMs: 200 }; // so the ratio, not the absolute ceiling, decides
  const slow = judgeCase("x", row(300), row(150), loose);
  assert.equal(slow.verdict, "fail");
  assert.match(slow.reason, /better than in-process/);
  assert.equal(judgeCase("x", row(300), row(40), loose).verdict, "pass");
});

test("a missing worker or baseline is unverified", async () => {
  const { judgeCase } = await load();
  assert.equal(judgeCase("x", row(300), undefined).verdict, "unverified");
  assert.equal(judgeCase("x", undefined, row(1)).verdict, "unverified");
});

test("--check passes on pass/inconclusive/unverified, fails on a failure, and --strict demands passes", async () => {
  const { checkPasses } = await load();
  const v = (verdict: string): Verdict => ({ name: "x", verdict, reason: "" });
  assert.equal(checkPasses([v("pass"), v("inconclusive"), v("unverified")]), true);
  assert.equal(checkPasses([v("pass"), v("fail")]), false);
  assert.equal(checkPasses([v("pass"), v("inconclusive")], { strict: true }), false);
});
