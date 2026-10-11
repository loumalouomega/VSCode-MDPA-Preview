/**
 * convergence.ts — the read side of the solver convergence evidence.
 *
 * The generated MainKratos.py (`monitoredMainScript`) appends one JSON record
 * per solve step to `kkss-convergence-v2.jsonl`, plus an `end` record from the
 * script's own `Finalize`. This module turns that stream into something a UI or
 * an agent can state without over-claiming.
 *
 * Pure (no `vscode`, no `fs`), tolerant in the way `runFile.ts` is: it never
 * throws, it returns what it could read plus warnings.
 *
 * The rules are the item's, and each is enforced here rather than left to a
 * caller:
 *  - progress, process completion, per-step convergence and the verdict are
 *    four separate answers;
 *  - an exception in the solve hook is an UNKNOWN outcome, never proof of
 *    numerical divergence;
 *  - a run with no `end` record is never `converged`, however good the last
 *    residual looked;
 *  - a residual the solver did not publish stays absent — never 0, and never
 *    given a unit (the norm is criterion-dependent and its unit undeclared).
 */

import { csvField } from "../parser/dataTable";

/** The file name the generated script writes, relative to the case folder. */
export const CONVERGENCE_FILE = "kkss-convergence-v2.jsonl";

/** The only record version this reader understands. */
export const CONVERGENCE_VERSION = 2;

const ADAPTER = /^kkss\.[a-z-]+-convergence$/;

export interface ConvergenceStep {
  /** Solver STEP counter (ProcessInfo). */
  step: number;
  time: number;
  /** True/false from the solver's own boolean; null when no criterion was evaluated. */
  converged: boolean | null;
  /** What `SolveSolutionStep` returned, when it returned a boolean. */
  solverStepResult: boolean | null;
  analysisType?: string;
  criterion?: string;
  residual?: number;
  convergenceRatio?: number;
  nonlinearIteration?: number;
  /** Why `residual` is absent, as the script worded it. */
  residualUnavailableReason?: string;
  /** Set when the solve hook raised: an unknown outcome. */
  error?: string;
  /** 0-based; increments whenever step or time goes backwards. */
  segment: number;
}

export interface ParsedConvergence {
  steps: ConvergenceStep[];
  /** True when the LAST event in the stream is a completed `end` record. */
  ended: boolean;
  adapter?: string;
  /** Verbatim from the first record that carried it. */
  residualDefinition?: string;
  kratosVersion?: string;
  /** Records carrying a version this reader does not understand, by version. */
  unsupportedVersions: Record<string, number>;
  warnings: string[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function parseConvergenceJsonl(text: string): ParsedConvergence {
  const out: ParsedConvergence = { steps: [], ended: false, unsupportedVersions: {}, warnings: [] };
  const lines = text.split(/\r?\n/);
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) lastNonEmpty = i;

  let segment = 0;
  let prev: { step: number; time: number } | undefined;
  let skipped = 0;
  let unknownEvents = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(raw);
    } catch {
      if (i === lastNonEmpty) out.warnings.push("The last line is incomplete (the run was probably stopped mid-write) and was ignored.");
      else skipped++;
      continue;
    }
    if (!isObject(rec)) {
      skipped++;
      continue;
    }
    if (rec.version !== CONVERGENCE_VERSION) {
      const key = String(rec.version ?? "missing");
      out.unsupportedVersions[key] = (out.unsupportedVersions[key] ?? 0) + 1;
      continue;
    }
    if (typeof rec.adapter !== "string" || !ADAPTER.test(rec.adapter)) {
      skipped++;
      continue;
    }
    out.adapter ??= rec.adapter;

    if (rec.event === "end") {
      out.ended = rec.completed === true;
      continue;
    }
    if (rec.event !== "step") {
      unknownEvents++;
      continue;
    }
    if (!finite(rec.iteration) || !Number.isInteger(rec.iteration) || !finite(rec.time)) {
      skipped++;
      continue;
    }
    // A step after an `end` means the stream continues: the end is no longer last.
    out.ended = false;

    if (prev && (rec.iteration < prev.step || rec.time < prev.time)) segment++;
    prev = { step: rec.iteration, time: rec.time };

    const runtime = isObject(rec.runtime) ? rec.runtime : undefined;
    if (typeof rec.residualDefinition === "string") out.residualDefinition ??= rec.residualDefinition;
    if (typeof runtime?.kratosVersion === "string") out.kratosVersion ??= runtime.kratosVersion;

    const step: ConvergenceStep = {
      step: rec.iteration,
      time: rec.time,
      converged: typeof rec.converged === "boolean" ? rec.converged : null,
      solverStepResult: typeof rec.solverStepResult === "boolean" ? rec.solverStepResult : null,
      segment,
    };
    if (typeof rec.analysisType === "string") step.analysisType = rec.analysisType;
    if (typeof rec.criterion === "string") step.criterion = rec.criterion;
    if (finite(rec.residual)) step.residual = rec.residual;
    if (finite(rec.convergenceRatio)) step.convergenceRatio = rec.convergenceRatio;
    if (finite(rec.nonlinearIteration)) step.nonlinearIteration = rec.nonlinearIteration;
    if (typeof rec.residualUnavailableReason === "string") step.residualUnavailableReason = rec.residualUnavailableReason;
    if (typeof rec.error === "string") step.error = rec.error;
    out.steps.push(step);
  }

  if (skipped) out.warnings.push(`${skipped} malformed record(s) were skipped.`);
  if (unknownEvents) out.warnings.push(`${unknownEvents} record(s) with an unknown event were skipped.`);
  for (const [version, n] of Object.entries(out.unsupportedVersions)) {
    out.warnings.push(`${n} record(s) use unsupported convergence version ${version}; only version ${CONVERGENCE_VERSION} is read.`);
  }
  return out;
}

export type ConvergenceVerdict = "converged" | "not-converged" | "solver-error" | "incomplete" | "unavailable";

export interface ConvergenceSummary {
  verdict: ConvergenceVerdict;
  /** One sentence saying why, including what the verdict does NOT claim. */
  reason: string;
  /** Records read (progress). */
  steps: number;
  segments: number;
  restarts: number;
  lastStep?: number;
  lastTime?: number;
  /** An `end` record closed the stream (process completion, as the script saw it). */
  completed: boolean;
  /** Steps whose criterion reported converged / not converged / was not evaluated. */
  convergedSteps: number;
  notConvergedSteps: number;
  unevaluatedSteps: number;
  errorSteps: number;
  adapter?: string;
  criterion?: string;
  analysisType?: string;
  /** True when at least one step published a residual norm. */
  residualAvailable: boolean;
  last?: ConvergenceStep;
}

/**
 * @param runStatus the reconciled run status, when known. It only sharpens the
 *   wording of an `incomplete` verdict; it can never upgrade a verdict.
 */
export function summarizeConvergence(parsed: ParsedConvergence, runStatus?: string): ConvergenceSummary {
  const steps = parsed.steps;
  const last = steps[steps.length - 1];
  let converged = 0;
  let notConverged = 0;
  let unevaluated = 0;
  let errors = 0;
  let residualAvailable = false;
  for (const s of steps) {
    if (s.error !== undefined) errors++;
    if (s.converged === true) converged++;
    else if (s.converged === false) notConverged++;
    else unevaluated++;
    if (s.residual !== undefined) residualAvailable = true;
  }
  const segments = steps.length ? steps[steps.length - 1].segment + 1 : 0;

  const base: ConvergenceSummary = {
    verdict: "unavailable",
    reason: "",
    steps: steps.length,
    segments,
    restarts: Math.max(0, segments - 1),
    completed: parsed.ended,
    convergedSteps: converged,
    notConvergedSteps: notConverged,
    unevaluatedSteps: unevaluated,
    errorSteps: errors,
    residualAvailable,
    ...(parsed.adapter ? { adapter: parsed.adapter } : {}),
    ...(last
      ? {
          lastStep: last.step,
          lastTime: last.time,
          last,
          ...(last.criterion ? { criterion: last.criterion } : {}),
          ...(last.analysisType ? { analysisType: last.analysisType } : {}),
        }
      : {}),
  };

  if (!steps.length) {
    const unsupported = Object.keys(parsed.unsupportedVersions);
    base.reason = unsupported.length
      ? `No readable records: the file uses unsupported version(s) ${unsupported.join(", ")}.`
      : "No solve-step records have been written.";
    return base;
  }
  if (errors) {
    base.verdict = "solver-error";
    base.reason =
      `The solve hook raised in ${errors} step(s). That is an unknown outcome — it does not show the iteration diverged numerically.`;
    return base;
  }
  if (notConverged) {
    base.verdict = "not-converged";
    base.reason = `${notConverged} of ${steps.length} step(s) did not meet the convergence criterion.`;
    return base;
  }
  if (!parsed.ended) {
    base.verdict = "incomplete";
    const how =
      runStatus === "cancelled" ? "The run was cancelled"
      : runStatus === "failed" ? "The run failed"
      : runStatus === "orphaned" || runStatus === "detached" ? "The run's outcome is not observed"
      : runStatus === "finished" ? "The run finished without writing an end record"
      : "The run has not written an end record";
    base.reason = `${how}; no completion is claimed, so the steps so far are not a convergence verdict.`;
    return base;
  }
  if (converged === 0) {
    base.verdict = "unavailable";
    base.reason = "The run completed, but no step evaluated a convergence criterion (for example a linear strategy).";
    return base;
  }
  base.verdict = "converged";
  base.reason = unevaluated
    ? `Every evaluated step met the criterion; ${unevaluated} step(s) evaluated none.`
    : "Every step met the convergence criterion and the run completed.";
  return base;
}

export interface BoundedSteps {
  rows: ConvergenceStep[];
  total: number;
  /** True when rows were dropped to respect the limit. */
  decimated: boolean;
}

/**
 * At most `limit` rows. The first and last are kept, up to half the budget goes
 * to the rows that matter most (not-converged and errored steps), and the rest
 * is an even stride — so a decimated history still shows where it went wrong.
 */
export function boundSteps(steps: readonly ConvergenceStep[], limit: number): BoundedSteps {
  const total = steps.length;
  const cap = Math.max(2, Math.floor(limit));
  if (total <= cap) return { rows: [...steps], total, decimated: false };
  const keep = new Set<number>([0, total - 1]);
  let budget = Math.floor(cap / 2);
  for (let i = 0; i < total && budget > 0; i++) {
    if (keep.has(i)) continue;
    if (steps[i].error !== undefined || steps[i].converged === false) {
      keep.add(i);
      budget--;
    }
  }
  const stride = total / Math.max(1, cap - keep.size);
  for (let x = 0; keep.size < cap && x < total; x += stride) keep.add(Math.min(total - 1, Math.floor(x)));
  for (let i = 0; keep.size < cap && i < total; i++) keep.add(i);
  return { rows: [...keep].sort((a, b) => a - b).map((i) => steps[i]), total, decimated: true };
}

const num = (v: number | undefined): string => (v === undefined ? "" : String(v));
const tri = (v: boolean | null): string => (v === null ? "" : v ? "true" : "false");

/**
 * Raw numbers, one row per record. A gap is blank, never 0, and the residual
 * header says its unit is undeclared rather than implying one.
 */
export function convergenceToCsv(steps: readonly ConvergenceStep[]): string {
  const header = [
    "segment", "step", "time", "converged", "solverStepResult", "residual [unit undeclared]",
    "convergenceRatio", "nonlinearIteration", "criterion", "analysisType", "note",
  ];
  const lines = [header.join(",")];
  for (const s of steps) {
    lines.push(
      [
        String(s.segment), String(s.step), String(s.time), tri(s.converged), tri(s.solverStepResult),
        num(s.residual), num(s.convergenceRatio), num(s.nonlinearIteration),
        csvField(s.criterion ?? ""), csvField(s.analysisType ?? ""),
        csvField(s.error !== undefined ? `error: ${s.error}` : s.residualUnavailableReason ?? ""),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

const sci = (v: number): string => (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(1) : String(Number(v.toPrecision(3))));

/** The one-line label for the Kratos Runs tree. Decisions live here, not in the view. */
export function convergenceRowText(s: ConvergenceSummary): string {
  if (!s.steps) return "Convergence — no records yet";
  const parts = [`step ${s.lastStep}`];
  if (s.last?.residual !== undefined) parts.push(`res ${sci(s.last.residual)}`);
  if (s.last?.convergenceRatio !== undefined) parts.push(`ratio ${sci(s.last.convergenceRatio)}`);
  parts.push(s.verdict);
  if (s.restarts) parts.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
  return `Convergence — ${parts.join(" · ")}`;
}

/** A VS Code ThemeIcon id for the convergence row. */
export function convergenceIconId(s: ConvergenceSummary): string {
  switch (s.verdict) {
    case "converged": return "pass";
    case "not-converged": return "warning";
    case "solver-error": return "error";
    default: return "pulse";
  }
}
