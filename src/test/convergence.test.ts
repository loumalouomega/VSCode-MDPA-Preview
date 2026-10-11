/**
 * convergence.ts — the verdict table. The rules under test are the ones that
 * stop a status line over-claiming: an exception is not divergence, a missing
 * end record is never "converged", and a missing residual is never 0.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  CONVERGENCE_FILE,
  ConvergenceStep,
  boundSteps,
  convergenceIconId,
  convergenceRowText,
  convergenceToCsv,
  parseConvergenceJsonl,
  summarizeConvergence,
} from "../problemtype/convergence";
import { readConvergence } from "../problemtype/convergenceFile";
import { STRUCTURAL_MAIN_KRATOS_PY } from "../problemtype/mainKratosTemplate";

const FIXTURES = path.resolve(__dirname, "../../src/test/fixtures/convergence");
const load = (name: string) => parseConvergenceJsonl(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

test("a completed run whose every step met the criterion is converged", () => {
  const s = summarizeConvergence(load("converged.jsonl"), "finished");
  assert.equal(s.verdict, "converged");
  assert.equal(s.steps, 3);
  assert.equal(s.completed, true);
  assert.equal(s.lastStep, 3);
  assert.equal(s.residualAvailable, true);
  assert.equal(s.restarts, 0);
});

test("non-converged steps are reported as such, with the count", () => {
  const s = summarizeConvergence(load("not_converged.jsonl"), "finished");
  assert.equal(s.verdict, "not-converged");
  assert.equal(s.notConvergedSteps, 2);
  assert.match(s.reason, /2 of 3/);
});

test("a solve-hook exception is an unknown outcome, never divergence", () => {
  const s = summarizeConvergence(load("solver_error.jsonl"), "failed");
  assert.equal(s.verdict, "solver-error");
  assert.match(s.reason, /unknown outcome/);
  assert.match(s.reason, /does not show/);
  assert.equal(s.errorSteps, 1);
});

test("a killed run: the cut last line is a warning, and no end record means incomplete", () => {
  const parsed = load("killed.jsonl");
  assert.equal(parsed.steps.length, 2);
  assert.ok(parsed.warnings.some((w) => /incomplete/.test(w)));
  const cancelled = summarizeConvergence(parsed, "cancelled");
  assert.equal(cancelled.verdict, "incomplete");
  assert.match(cancelled.reason, /cancelled/);
  // Perfect residuals do not buy a "converged" without a completed run.
  assert.equal(summarizeConvergence(parsed, "orphaned").verdict, "incomplete");
  assert.equal(summarizeConvergence(parsed).verdict, "incomplete");
});

test("a step counter that goes backwards starts a new segment", () => {
  const s = summarizeConvergence(load("restarted.jsonl"), "finished");
  assert.equal(s.segments, 2);
  assert.equal(s.restarts, 1);
  assert.equal(s.steps, 4);
  assert.match(convergenceRowText(s), /1 restart\b/);
});

test("a linear run completes with no criterion evaluated: unavailable, not converged", () => {
  const s = summarizeConvergence(load("linear.jsonl"), "finished");
  assert.equal(s.verdict, "unavailable");
  assert.equal(s.residualAvailable, false);
  assert.equal(s.unevaluatedSteps, 1);
});

test("records of an unsupported version are reported, not guessed at", () => {
  const parsed = load("v1.jsonl");
  assert.equal(parsed.steps.length, 0);
  assert.deepEqual(parsed.unsupportedVersions, { "1": 1 });
  const s = summarizeConvergence(parsed);
  assert.equal(s.verdict, "unavailable");
  assert.match(s.reason, /unsupported/);
});

test("an empty stream is unavailable and nothing throws on junk", () => {
  assert.equal(summarizeConvergence(parseConvergenceJsonl("")).verdict, "unavailable");
  const junk = parseConvergenceJsonl("not json\n[1,2]\n{\"version\":2}\n");
  assert.equal(junk.steps.length, 0);
  assert.ok(junk.warnings.length > 0);
});

test("a non-finite residual is absent, never zero", () => {
  const line = JSON.stringify({
    adapter: "kkss.structural-convergence", version: 2, event: "step", iteration: 1, time: 0.1,
    converged: true, residual: null, convergenceRatio: "nan",
  });
  const step = parseConvergenceJsonl(line + "\n").steps[0];
  assert.equal(step.residual, undefined);
  assert.equal(step.convergenceRatio, undefined);
});

test("CSV: gaps are blank, the unit is declared undeclared, and errors are noted", () => {
  const csv = convergenceToCsv(load("solver_error.jsonl").steps);
  const [header, first, second] = csv.trim().split("\n");
  assert.match(header, /residual \[unit undeclared\]/);
  assert.equal(Number(first.split(",")[5]), 1e-5);
  const cells = second.split(",");
  assert.equal(cells[5], ""); // residual
  assert.equal(cells[3], ""); // converged is null, not false
  assert.match(second, /error: Singular matrix/);
});

test("row text names the step, residual and verdict", () => {
  const s = summarizeConvergence(load("converged.jsonl"), "finished");
  assert.equal(convergenceRowText(s), "Convergence — step 3 · res 3.2e-9 · ratio 1.0e-6 · converged");
  assert.equal(convergenceIconId(s), "pass");
  assert.equal(convergenceRowText(summarizeConvergence(parseConvergenceJsonl(""))), "Convergence — no records yet");
});

test("boundSteps keeps the ends and the bad steps when it decimates", () => {
  const steps: ConvergenceStep[] = Array.from({ length: 1000 }, (_, i) => ({
    step: i + 1, time: i, converged: i === 500 ? false : true, solverStepResult: null, segment: 0,
  }));
  const bounded = boundSteps(steps, 50);
  assert.equal(bounded.decimated, true);
  assert.equal(bounded.total, 1000);
  assert.ok(bounded.rows.length <= 50);
  assert.equal(bounded.rows[0].step, 1);
  assert.equal(bounded.rows[bounded.rows.length - 1].step, 1000);
  assert.ok(bounded.rows.some((r) => r.converged === false));
  assert.equal(boundSteps(steps.slice(0, 10), 50).decimated, false);
});

test("readConvergence: missing file is unavailable with a reason; a huge file is read from its tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kconv-"));
  try {
    const missing = readConvergence(dir);
    assert.equal(missing.available, false);
    assert.match(missing.reason ?? "", /No convergence file/);

    const text = fs.readFileSync(path.join(FIXTURES, "converged.jsonl"), "utf8");
    fs.writeFileSync(path.join(dir, CONVERGENCE_FILE), text);
    const full = readConvergence(dir);
    assert.equal(full.parsed?.steps.length, 3);

    const tail = readConvergence(dir, { maxBytes: text.length - 100 });
    assert.equal(tail.tailOnly, true);
    assert.ok((tail.parsed?.steps.length ?? 3) < 3);
    assert.ok(tail.parsed?.warnings.some((w) => /Only the last/.test(w)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("drift guard: the generated script still writes every field the parser reads", () => {
  for (const key of ["iteration", "time", "converged", "solverStepResult", "analysisType", "criterion",
    "residualUnavailableReason", "error", "event", "completed", "adapter", "version"]) {
    assert.ok(STRUCTURAL_MAIN_KRATOS_PY.includes(`"${key}"`), `template no longer writes "${key}"`);
  }
  assert.ok(STRUCTURAL_MAIN_KRATOS_PY.includes(CONVERGENCE_FILE));
  assert.ok(STRUCTURAL_MAIN_KRATOS_PY.includes('"residual"') && STRUCTURAL_MAIN_KRATOS_PY.includes('"convergenceRatio"'));
});
