/**
 * Pure verdict logic for scripts/bench/plot-budget.mjs (roadmap item 9): kept
 * apart from the runner so the thresholds are unit-tested
 * (src/test/benchPlotBudget.test.ts) even though the timing itself is not.
 */
import { median } from "./heartbeatStats.mjs";

/** Folds repetitions of one case into one row (medians; a single run's max is a scheduler hiccup). */
export function summarizePlotRuns(runs) {
  return {
    runs: runs.length,
    wallMs: median(runs.map((r) => r.wallMs)),
    maxStallMs: median(runs.map((r) => r.maxStallMs)),
    peakRssMb: median(runs.map((r) => r.peakRssMb)),
    extra: runs[0]?.extra,
  };
}

/** Default budgets (generous on purpose: they catch regressions, they do not promise Remote-SSH figures). */
export const DEFAULT_BUDGETS = {
  workerMaxStallMs: 50,
  /** Peak RSS may be at most this many times the table file size (buffer + string + rows). */
  tableRssFileRatio: 12,
  cancelMs: 500,
  /** A stat-shortcut lookup must be at least this many times faster than a hashed one, when the hashed one is measurable. */
  statSpeedup: 1.5,
  minMeasurableMs: 20,
};

/** One verdict per case: pass | fail | inconclusive (too small to show anything) | unverified (not measured). */
export function judgePlotCase(name, row, budgets = DEFAULT_BUDGETS) {
  if (!row) return { name, verdict: "unverified", reason: "not measured" };
  switch (name) {
    case "table-worker":
      return row.maxStallMs > budgets.workerMaxStallMs
        ? { name, verdict: "fail", reason: `worker max stall ${row.maxStallMs.toFixed(1)} ms exceeds ${budgets.workerMaxStallMs} ms` }
        : { name, verdict: "pass", reason: `worker max stall ${row.maxStallMs.toFixed(1)} ms` };
    case "table-memory": {
      const ratio = row.peakRssMb / Math.max(row.extra?.fileMb ?? 0, 1e-9);
      return ratio > budgets.tableRssFileRatio
        ? { name, verdict: "fail", reason: `peak RSS is ${ratio.toFixed(1)}x the file (budget ${budgets.tableRssFileRatio}x)` }
        : { name, verdict: "pass", reason: `peak RSS ${ratio.toFixed(1)}x the file` };
    }
    case "cancel":
      return row.wallMs > budgets.cancelMs
        ? { name, verdict: "fail", reason: `cancellation took ${row.wallMs.toFixed(0)} ms (budget ${budgets.cancelMs} ms)` }
        : { name, verdict: "pass", reason: `cancelled in ${row.wallMs.toFixed(0)} ms` };
    default:
      return { name, verdict: "unverified", reason: "no budget defined" };
  }
}

/** Cold vs hashed-cache-hit vs stat-shortcut-hit lookups. */
export function judgeStatShortcut(hashedHit, statHit, budgets = DEFAULT_BUDGETS) {
  const name = "history-stat-shortcut";
  if (!hashedHit || !statHit) return { name, verdict: "unverified", reason: "not measured" };
  if (hashedHit.wallMs < budgets.minMeasurableMs) {
    return { name, verdict: "inconclusive", reason: `hashed hit took only ${hashedHit.wallMs.toFixed(1)} ms (< ${budgets.minMeasurableMs} ms); use a larger fixture` };
  }
  const ratio = hashedHit.wallMs / Math.max(statHit.wallMs, 1e-9);
  return ratio < budgets.statSpeedup
    ? { name, verdict: "fail", reason: `stat shortcut only ${ratio.toFixed(1)}x faster (needs ${budgets.statSpeedup}x)` }
    : { name, verdict: "pass", reason: `${ratio.toFixed(1)}x faster than a hashed hit` };
}

export function plotBudgetPasses(verdicts, { strict = false } = {}) {
  return verdicts.every((v) => v.verdict === "pass" || (!strict && (v.verdict === "inconclusive" || v.verdict === "unverified")));
}
