/**
 * Pure statistics for scripts/bench/host-heartbeat.mjs (roadmap item 2): kept
 * apart from the runner so the --check verdict logic is unit-tested
 * (src/test/benchHeartbeat.test.ts) even though the timing itself is not.
 */

/** Median of a non-empty numeric list (mean of the middle pair when even). */
export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Folds the repetitions of one case/mode into one row. The max stall is the
 * MEDIAN of the per-run maxima: one run's max is a single scheduler hiccup, the
 * median of several is what the host would typically see.
 */
export function summarizeRuns(runs) {
  return {
    runs: runs.length,
    wallMs: median(runs.map((r) => r.wallMs)),
    p50Ms: median(runs.map((r) => r.p50Ms)),
    p99Ms: median(runs.map((r) => r.p99Ms)),
    maxStallMs: median(runs.map((r) => r.maxStallMs)),
    rssDeltaMb: median(runs.map((r) => r.rssDeltaMb)),
  };
}

/**
 * Verdict for one case. `baseline` is the in-process row, `worker` the offloaded
 * one (either may be missing: a worker bundle that was never built is
 * "unverified", never a pass).
 */
export function judgeCase(name, baseline, worker, { maxStallMs = 50, minRatio = 3, minBaselineMs = 100 } = {}) {
  if (!worker) return { name, verdict: "unverified", reason: "worker bundle not available" };
  if (!baseline) return { name, verdict: "unverified", reason: "no in-process baseline" };
  if (worker.maxStallMs > maxStallMs) {
    return { name, verdict: "fail", reason: `worker max stall ${worker.maxStallMs.toFixed(1)} ms exceeds ${maxStallMs} ms` };
  }
  if (baseline.maxStallMs < minBaselineMs) {
    // The fixture was too small to show any stall: nothing was proved either way.
    return {
      name,
      verdict: "inconclusive",
      reason: `in-process baseline stalled only ${baseline.maxStallMs.toFixed(1)} ms (< ${minBaselineMs} ms); use a larger fixture`,
    };
  }
  const ratio = baseline.maxStallMs / Math.max(worker.maxStallMs, 1e-9);
  if (ratio < minRatio) {
    return { name, verdict: "fail", reason: `worker only ${ratio.toFixed(1)}x better than in-process (needs ${minRatio}x)` };
  }
  return { name, verdict: "pass", reason: `${ratio.toFixed(0)}x lower max stall than in-process` };
}

/** `--check` succeeds when nothing failed. Inconclusive/unverified are reported but are not a pass. */
export function checkPasses(verdicts, { strict = false } = {}) {
  return verdicts.every((v) => v.verdict === "pass" || (!strict && (v.verdict === "inconclusive" || v.verdict === "unverified")));
}
