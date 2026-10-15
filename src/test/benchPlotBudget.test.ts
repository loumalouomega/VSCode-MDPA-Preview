/** The verdict logic behind scripts/bench/plot-budget.mjs --check (the timing itself is not a unit test: it is flaky on shared CI). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Row { runs?: number; wallMs: number; maxStallMs: number; peakRssMb: number; extra?: { fileMb?: number } }
interface Verdict { name: string; verdict: string; reason: string }
interface Stats {
  summarizePlotRuns(runs: Row[]): Row;
  judgePlotCase(name: string, row: Row | undefined): Verdict;
  judgeStatShortcut(hashed: Row | undefined, stat: Row | undefined): Verdict;
  plotBudgetPasses(v: Verdict[], o?: { strict?: boolean }): boolean;
}
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<Stats>;
const load = (): Promise<Stats> => importEsm(pathToFileURL(path.resolve(__dirname, "..", "..", "scripts", "bench", "plotBudgetStats.mjs")).href);
const row = (o: Partial<Row>): Row => ({ wallMs: 1, maxStallMs: 1, peakRssMb: 1, ...o });

test("runs fold to medians", async () => {
  const { summarizePlotRuns } = await load();
  const s = summarizePlotRuns([row({ wallMs: 10 }), row({ wallMs: 30 }), row({ wallMs: 20 })]);
  assert.equal(s.wallMs, 20);
  assert.equal(s.runs, 3);
});

test("worker stall, memory ratio and cancellation latency are judged against their budgets", async () => {
  const { judgePlotCase } = await load();
  assert.equal(judgePlotCase("table-worker", row({ maxStallMs: 10 })).verdict, "pass");
  assert.equal(judgePlotCase("table-worker", row({ maxStallMs: 3000 })).verdict, "fail");
  assert.equal(judgePlotCase("table-memory", row({ peakRssMb: 600, extra: { fileMb: 68 } })).verdict, "pass");
  assert.equal(judgePlotCase("table-memory", row({ peakRssMb: 1500, extra: { fileMb: 68 } })).verdict, "fail");
  assert.equal(judgePlotCase("cancel", row({ wallMs: 5 })).verdict, "pass");
  assert.equal(judgePlotCase("cancel", row({ wallMs: 900 })).verdict, "fail");
  assert.equal(judgePlotCase("table-worker", undefined).verdict, "unverified");
});

test("the stat shortcut is inconclusive on a tiny fixture and fails when it is not faster", async () => {
  const { judgeStatShortcut } = await load();
  assert.equal(judgeStatShortcut(row({ wallMs: 5 }), row({ wallMs: 1 })).verdict, "inconclusive");
  assert.equal(judgeStatShortcut(row({ wallMs: 100 }), row({ wallMs: 90 })).verdict, "fail");
  assert.equal(judgeStatShortcut(row({ wallMs: 100 }), row({ wallMs: 2 })).verdict, "pass");
  assert.equal(judgeStatShortcut(undefined, row({})).verdict, "unverified");
});

test("--check passes only without failures; strict also refuses inconclusive", async () => {
  const { plotBudgetPasses } = await load();
  const v = (verdict: string): Verdict => ({ name: "x", verdict, reason: "" });
  assert.equal(plotBudgetPasses([v("pass"), v("inconclusive")]), true);
  assert.equal(plotBudgetPasses([v("pass"), v("inconclusive")], { strict: true }), false);
  assert.equal(plotBudgetPasses([v("pass"), v("fail")]), false);
});
