import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  optimizationCaseInfo,
  optimizationPlotRecipe,
  optimizationRowText,
  parseOptimizationSummary,
  summarizeOptimization,
} from "../problemtype/optimization/summaryLog";
import { readOptimization, readOptimizationSummary } from "../problemtype/optimization/summaryLogFile";
import { validatePlotRecipe } from "../parser/plot/recipe";
import { collectPlot } from "../parser/plot/sources";

const FIX = path.join(__dirname, "..", "..", "src", "test", "fixtures", "optimization");
const read = (name: string) => fs.readFileSync(path.join(FIX, name), "utf8");

const STEEPEST_INFO = optimizationCaseInfo({
  algorithm_settings: {
    type: "algorithm_steepest_descent",
    settings: { conv_settings: { max_iter: 11 } },
    controls: ["material_control"],
    objective: { response_expression: "strain_energy", type: "minimization" },
  },
  processes: {
    optimization_data_processes: {
      output_processes: [
        { type: "optimization_problem_ascii_output_process", settings: { output_file_name: "summary" } },
        { type: "optimization_problem_vtu_output_process", settings: { output_path: "Optimization_Results" } },
      ],
    },
  },
});

const GP_INFO = optimizationCaseInfo({
  algorithm_settings: {
    type: "algorithm_gradient_projection",
    settings: { conv_settings: { max_iter: 10 } },
    objective: { response_expression: "mass", type: "minimization" },
    constraints: [{ response_expression: "strain_energy", type: "<=" }],
  },
});

test("the case facts come from optimization_parameters.json", () => {
  assert.equal(STEEPEST_INFO.objective, "strain_energy");
  assert.equal(STEEPEST_INFO.maxIter, 11);
  assert.equal(STEEPEST_INFO.summaryFile, "summary.csv", ".csv is appended like the process does");
  assert.equal(STEEPEST_INFO.designFieldsFolder, "Optimization_Results");
  assert.deepEqual(STEEPEST_INFO.controls, ["material_control"]);
  assert.deepEqual(GP_INFO.constraints, [{ response: "strain_energy", type: "<=" }]);
  // Older documents still name `response_name`; nothing is invented when keys are missing.
  assert.equal(optimizationCaseInfo({ algorithm_settings: { objective: { response_name: "m" } } }).objective, "m");
  assert.deepEqual(optimizationCaseInfo("junk"), { constraints: [], controls: [], summaryFile: "summary.csv" });
});

test("a finished steepest-descent summary: header, initial values, rows and the end marker", () => {
  const parsed = parseOptimizationSummary(read("steepest_descent.csv"));
  assert.equal(parsed.kratosVersion, "10.4.3");
  assert.equal(parsed.ended, true);
  assert.deepEqual(parsed.columns, ["algorithm:std_obj_value", "algorithm:rel_obj[%]", "algorithm:abs_obj[%]", "strain_energy:value"]);
  assert.equal(parsed.rows.length, 11);
  assert.equal(parsed.initialValues.strain_energy.initial_value, 2.045937642e-2);
  assert.deepEqual(parsed.warnings, []);
  const s = summarizeOptimization(parsed, STEEPEST_INFO, "finished");
  assert.equal(s.verdict, "finished");
  assert.equal(s.iterations, 11);
  assert.equal(s.reachedMaxIter, true);
  assert.equal(s.objective?.current, 1.826147325e-2);
  assert.ok(Math.abs(s.objective!.changePercent! - -10.742767) < 1e-4, String(s.objective?.changePercent));
  assert.equal(optimizationRowText(s), "Optimization — iter 11/11 · objective −10.7% · finished");
  assert.equal(summarizeOptimization(parsed, STEEPEST_INFO, "cancelled").verdict, "stopped");
});

test("a killed constrained run: the cut row is dropped, constraints are judged by std_value", () => {
  const parsed = parseOptimizationSummary(read("gradient_projection_cut.csv"));
  assert.equal(parsed.ended, false);
  assert.equal(parsed.rows.length, 3);
  assert.match(parsed.warnings.join(" "), /last row was cut short/);
  const s = summarizeOptimization(parsed, GP_INFO, "failed");
  assert.equal(s.verdict, "incomplete");
  assert.deepEqual(s.constraints, [{ response: "strain_energy", type: "<=", value: 5.01e6, stdValue: -1e-3, satisfied: true }]);
  assert.equal(s.objective?.initial, 5887.5);
  assert.equal(summarizeOptimization(parsed, GP_INFO, "running").verdict, "running");
  assert.match(optimizationRowText(s), /iter 3\/10 · objective −3\.4% · 1\/1 constraints met · incomplete/);
});

test("an unknown constraint column is reported as unknown, never as met", () => {
  const parsed = parseOptimizationSummary("# Headers:\n#  STEP, mass:value\n 0, 1.0\n");
  const s = summarizeOptimization(parsed, GP_INFO);
  assert.equal(s.constraints[0].satisfied, undefined);
  assert.match(optimizationRowText(s), /1 constraints \(status unknown\)/);
  assert.match(s.warnings.join(" "), /^$|no "mass:value"/);
});

test("the plot recipe validates: objective in one panel, constraint std_value in the other", async () => {
  const parsed = parseOptimizationSummary(read("gradient_projection_cut.csv"));
  const { recipe, notes } = optimizationPlotRecipe(parsed, GP_INFO, "case");
  assert.deepEqual(notes, []);
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  assert.equal(dataset.series.length, 2);
  assert.equal(dataset.series[0].points.length, 3);
  assert.equal(recipe.presentation.panels, 2);
  assert.deepEqual(recipe.series.map((s) => [s.id, s.y, s.panel]), [["objective", "c0", 0], ["constraint-strain_energy", "c2", 1]]);
  const steep = optimizationPlotRecipe(parseOptimizationSummary(read("steepest_descent.csv")), STEEPEST_INFO, "case");
  assert.equal(steep.recipe.presentation.panels, 1);
  assert.equal(steep.recipe.series[0].y, "c3");
});

test("the file reader finds the summary the case names, and says why when it cannot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-optsum-"));
  assert.match(readOptimization(dir).reason!, /No optimization_parameters\.json/);
  fs.writeFileSync(path.join(dir, "optimization_parameters.json"), JSON.stringify({
    algorithm_settings: { objective: { response_expression: "strain_energy" } },
    processes: { optimization_data_processes: { output_processes: [{ type: "optimization_problem_ascii_output_process", settings: { output_file_name: "progress.csv" } }] } },
  }));
  assert.match(readOptimization(dir).reason!, /progress\.csv has not been written/);
  fs.writeFileSync(path.join(dir, "progress.csv"), read("steepest_descent.csv"));
  assert.equal(readOptimizationSummary(dir)?.iterations, 11);
  const tail = readOptimization(dir, { maxBytes: 300 });
  assert.match(tail.parsed!.warnings.join(" "), /Only the last 300 bytes/);
});
