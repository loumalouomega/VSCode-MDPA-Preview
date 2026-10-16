import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createOptimizationProgressHost, PANEL_ROW_LIMIT } from "../optimizationProgressHost";
import { findOptimizationCase } from "../problemtype/optimization/summaryLogFile";

const FIX = path.join(__dirname, "..", "..", "src", "test", "fixtures", "optimization");

function optimizationCase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-opthost-"));
  fs.writeFileSync(path.join(dir, "case.mdpa"), "");
  fs.writeFileSync(path.join(dir, "optimization_parameters.json"), JSON.stringify({
    algorithm_settings: {
      type: "algorithm_steepest_descent",
      settings: { conv_settings: { max_iter: 11 } },
      controls: ["material_control"],
      objective: { response_expression: "strain_energy", type: "minimization" },
    },
    processes: {
      optimization_data_processes: {
        output_processes: [
          { type: "optimization_problem_ascii_output_process", settings: { output_file_name: "summary.csv" } },
          { type: "optimization_problem_vtu_output_process", settings: { output_path: "Optimization_Results" } },
        ],
      },
    },
  }));
  fs.mkdirSync(path.join(dir, "Optimization_Results", "Structure_0"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Optimization_Results", "Structure_0_3.vtm"), "");
  return dir;
}

function harness(fsPath: string | undefined, status?: string) {
  const posts: Record<string, unknown>[] = [];
  const opened: unknown[] = [];
  const infos: string[] = [];
  const host = createOptimizationProgressHost({
    fsPath: () => fsPath,
    post: (m) => posts.push(m),
    runStatus: () => status,
    openPlot: (recipe, title) => opened.push({ kind: "plot", title, series: recipe.series.length }),
    openDesignFields: (caseDir, folder, excludeNewest) => opened.push({ kind: "fields", caseDir, folder, excludeNewest }),
    exportCad: (caseDir, excludeNewest) => opened.push({ kind: "cad", caseDir, excludeNewest }),
    info: (m) => infos.push(m),
  });
  return { host, posts, opened, infos };
}

test("the case is found from the mesh beside it and from a design-field file below it", () => {
  const dir = optimizationCase();
  assert.equal(findOptimizationCase(path.join(dir, "case.mdpa")), dir);
  assert.equal(findOptimizationCase(path.join(dir, "Optimization_Results", "Structure_0_3.vtm")), dir);
  assert.equal(findOptimizationCase(path.join(dir, "Optimization_Results", "Structure_0")), dir);
  assert.equal(findOptimizationCase(os.tmpdir()), undefined);
});

test("a request posts the summary; only a followed panel is refreshed", () => {
  const dir = optimizationCase();
  const { host, posts } = harness(path.join(dir, "case.mdpa"), "running");
  host.refreshIfWatched();
  assert.equal(posts.length, 0, "nothing posted before the panel asks");
  assert.equal(host.handle({ type: "optimizationProgressRequest" }), true);
  assert.equal(posts[0].available, false);
  assert.match(String(posts[0].reason), /summary\.csv has not been written/);
  assert.match(String(posts[0].formulation), /minimize strain_energy · controls: material_control · steepest descent/);
  fs.writeFileSync(path.join(dir, "summary.csv"), fs.readFileSync(path.join(FIX, "steepest_descent.csv")));
  host.refreshIfWatched();
  const last = posts[posts.length - 1];
  assert.equal(last.available, true);
  assert.equal((last.rows as unknown[]).length, 11);
  assert.equal(last.totalRows, 11);
  assert.equal(last.designFields, true);
  assert.equal((last.summary as { verdict: string }).verdict, "finished");
  host.handle({ type: "optimizationProgressStop" });
  const count = posts.length;
  host.refreshIfWatched();
  assert.equal(posts.length, count, "a closed panel is not refreshed");
  assert.ok(PANEL_ROW_LIMIT >= 50);
});

test("plot and design-field requests open what the case names, and explain when they cannot", () => {
  const dir = optimizationCase();
  const { host, opened, infos } = harness(path.join(dir, "case.mdpa"), "finished");
  host.handle({ type: "optimizationPlot" });
  assert.match(infos[0], /has not been written/);
  fs.writeFileSync(path.join(dir, "summary.csv"), fs.readFileSync(path.join(FIX, "steepest_descent.csv")));
  host.handle({ type: "optimizationPlot" });
  host.handle({ type: "optimizationDesignFields" });
  host.handle({ type: "optimizationExportCad" });
  assert.deepEqual(opened, [
    { kind: "plot", title: `Optimization — ${path.basename(dir)}`, series: 1 },
    { kind: "fields", caseDir: dir, folder: "Optimization_Results", excludeNewest: false },
    { kind: "cad", caseDir: dir, excludeNewest: false },
  ]);
  const outside = harness(path.join(os.tmpdir(), "nope.mdpa"));
  outside.host.handle({ type: "optimizationProgressRequest" });
  assert.match(String(outside.posts[0].reason), /not part of an optimization case/);
  assert.equal(outside.host.handle({ type: "linkPick" }), false, "other messages are left alone");
});
