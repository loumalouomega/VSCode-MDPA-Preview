/** The convergence history as a plot recipe (roadmap item 8): honest gaps, restarts, a recipe the plot library accepts and draws. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseConvergenceJsonl } from "../problemtype/convergence";
import { CONVERGENCE_MAX_SEGMENTS, convergencePlotRecipe, convergenceTable } from "../problemtype/convergencePlot";
import { collectPlot } from "../parser/plot/sources";
import { validatePlotRecipe } from "../parser/plot/recipe";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "convergence");
const load = (name: string) => parseConvergenceJsonl(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

test("the table keeps a missing residual as a gap, never zero, and declares no unit", () => {
  const parsed = load("linear.jsonl");
  const table = convergenceTable(parsed.steps);
  assert.equal(table.rows.length, parsed.steps.length);
  const residual = table.columns.findIndex((c) => c.id === "residual");
  assert.ok(table.rows.every((r, i) => r[residual] === (parsed.steps[i].residual ?? null)));
  assert.ok(parsed.steps.some((s) => s.residual === undefined), "fixture has a step without a residual");
  assert.ok(table.columns.every((c) => c.unit === undefined && c.domain === undefined), "no unit or time domain is claimed");
});

test("the recipe validates and the plot library draws one residual series on a log axis", async () => {
  const parsed = load("converged.jsonl");
  const { recipe, notes } = convergencePlotRecipe(parsed.steps, "Convergence — case");
  assert.deepEqual(notes, []);
  assert.equal(recipe.presentation.yScale, "log");
  assert.match(recipe.presentation.yLabel ?? "", /unit undeclared/);
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  assert.equal(dataset.series.length, 1);
  const finiteResiduals = parsed.steps.filter((s) => s.residual !== undefined).length;
  assert.equal(dataset.series[0].points.filter((p) => p.y !== null).length, finiteResiduals);
});

test("a restarted run is one series per segment, never one line through the restart", async () => {
  const parsed = load("restarted.jsonl");
  const segments = new Set(parsed.steps.map((s) => s.segment));
  assert.ok(segments.size > 1, "fixture restarts");
  const { recipe } = convergencePlotRecipe(parsed.steps, "t");
  assert.equal(recipe.series.length, segments.size);
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  const total = dataset.series.reduce((n, s) => n + s.points.length, 0);
  assert.equal(total, parsed.steps.length, "every record lands in exactly one series");
});

test("a run with no published residual says so instead of drawing nothing silently", () => {
  const steps = load("converged.jsonl").steps.map((s) => ({ ...s, residual: undefined }));
  const { notes } = convergencePlotRecipe(steps, "t");
  assert.ok(notes.some((n) => /no residual/.test(n)));
});

test("more segments than the cap are noted, not silently dropped", () => {
  const steps = Array.from({ length: CONVERGENCE_MAX_SEGMENTS + 3 }, (_, i) => ({
    step: 1, time: i, converged: true, solverStepResult: true, residual: 1e-3, segment: i,
  }));
  const { recipe, notes } = convergencePlotRecipe(steps, "t");
  assert.equal(recipe.series.length, CONVERGENCE_MAX_SEGMENTS);
  assert.ok(notes.some((n) => /only the first/.test(n)));
});
