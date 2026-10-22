/**
 * Pure verdict logic for scripts/bench/large-mesh.mjs (roadmap item 7): kept
 * apart from the runner so the thresholds are unit-tested
 * (src/test/benchLargeMesh.test.ts) even though the timing itself is not.
 */
import { median } from "./heartbeatStats.mjs";

/** Folds repetitions of one case into one row (medians; a single run's max is a scheduler hiccup). */
export function summarizeMeshRuns(runs) {
  return {
    runs: runs.length,
    wallMs: median(runs.map((r) => r.wallMs)),
    maxStallMs: median(runs.map((r) => r.maxStallMs)),
    extra: runs[0]?.extra,
  };
}

/** Default budgets (generous on purpose: they catch regressions, they do not promise Remote-SSH figures). */
export const DEFAULT_BUDGETS = {
  /** Converting the model for the wire may cost at most this many ms per million field rows. */
  wireMsPerMRows: 2500,
  /** The level-of-detail surface for a ~1M-cell block must be ready within this many ms. */
  lodMs: 30000,
  /** Peak RSS may be at most this many times the raw typed-array bytes of the model. */
  rssModelRatio: 20,
  minMeasurableMs: 20,
};

/** One verdict per case: pass | fail | inconclusive (too small to show anything) | unverified (not measured). */
export function judgeMeshCase(name, row, budgets = DEFAULT_BUDGETS) {
  if (!row) return { name, verdict: "unverified", reason: "not measured" };
  const x = row.extra ?? {};
  switch (name) {
    case "wire-eager": {
      const mrows = Math.max(x.fieldRows ?? 0, 1) / 1e6;
      const per = row.wallMs / mrows;
      return per > budgets.wireMsPerMRows
        ? { name, verdict: "fail", reason: `${per.toFixed(0)} ms per million field rows exceeds ${budgets.wireMsPerMRows}` }
        : { name, verdict: "pass", reason: `${per.toFixed(0)} ms per million field rows` };
    }
    case "lod":
      return row.wallMs > budgets.lodMs
        ? { name, verdict: "fail", reason: `LOD took ${row.wallMs.toFixed(0)} ms (budget ${budgets.lodMs} ms)` }
        : { name, verdict: "pass", reason: `LOD in ${row.wallMs.toFixed(0)} ms` };
    case "memory": {
      const ratio = (x.peakRssMb ?? 0) / Math.max(x.modelMb ?? 0, 1e-9);
      return ratio > budgets.rssModelRatio
        ? { name, verdict: "fail", reason: `peak RSS is ${ratio.toFixed(1)}x the model (budget ${budgets.rssModelRatio}x)` }
        : { name, verdict: "pass", reason: `peak RSS ${ratio.toFixed(1)}x the model` };
    }
    default:
      return { name, verdict: "unverified", reason: "no budget defined" };
  }
}

export function largeMeshPasses(verdicts, { strict = false } = {}) {
  return verdicts.every((v) => v.verdict === "pass" || (!strict && (v.verdict === "inconclusive" || v.verdict === "unverified")));
}
