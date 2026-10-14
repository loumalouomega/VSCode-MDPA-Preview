import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encodeNpy } from "../parser/npyReader";
import { parseRomProgress, romRowText, romSingularValuesRecipe, romStatus } from "../problemtype/rom/romResults";
import { isRomCase, readRomResults } from "../problemtype/rom/romResultsFile";
import { validatePlotRecipe } from "../parser/plot/recipe";
import { collectPlot } from "../parser/plot/sources";

function romCase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-romres-"));
  fs.writeFileSync(path.join(dir, "RomSamples.json"), JSON.stringify({ mu_names: ["load"], mu_train: [[1], [2], [3]], mu_test: [[1.5]] }));
  return dir;
}

test("progress lines: starts, ends and a malformed line counted apart", () => {
  const parsed = parseRomProgress([
    JSON.stringify({ event: "start", index: 1, label: "FOM_Fit0", mu: [1] }),
    JSON.stringify({ event: "end", index: 1, label: "FOM_Fit0", elapsed: 2.5 }),
    "not json",
    JSON.stringify({ event: "start", index: 2, label: "FOM_Fit1", mu: [2] }),
    JSON.stringify({ something: "else" }),
  ].join("\n"));
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.malformed, 2);
});

test("a fresh case reads as no basis yet; a finished one reports modes, HROM and runs", () => {
  const dir = romCase();
  assert.ok(isRomCase(dir));
  assert.ok(!isRomCase(os.tmpdir()));
  let status = romStatus(readRomResults(dir));
  assert.equal(romRowText(status), "Reduced model — ROM basis not written yet · 0 runs done");
  fs.appendFileSync(path.join(dir, "kkss-rom-progress.jsonl"), JSON.stringify({ event: "start", index: 1, label: "FOM_Fit0" }) + "\n");
  status = romStatus(readRomResults(dir));
  assert.equal(status.current, "FOM_Fit0");
  assert.match(romRowText(status), /running FOM_Fit0/);

  fs.mkdirSync(path.join(dir, "rom_data"));
  fs.writeFileSync(path.join(dir, "rom_data", "RomParameters.json"), JSON.stringify({ projection_strategy: "galerkin", rom_settings: { number_of_rom_dofs: 4 } }));
  fs.writeFileSync(path.join(dir, "rom_data", "SingularValuesVector.npy"), encodeNpy([10, 1, 0.1, 0.01, 1e-6]));
  fs.writeFileSync(path.join(dir, "rom_data", "HROM_ElementIds.npy"), encodeNpy([3, 17, 42], "<i8"));
  fs.writeFileSync(path.join(dir, "rom_data", "HROM_ConditionIds.npy"), encodeNpy([5], "<i8"));
  fs.appendFileSync(path.join(dir, "kkss-rom-progress.jsonl"), JSON.stringify({ event: "end", index: 1, label: "FOM_Fit0" }) + "\n");
  fs.writeFileSync(path.join(dir, "kkss-rom-summary-v1.json"), JSON.stringify({ version: 1, stopped: false, runs: 9 }));
  const results = readRomResults(dir);
  assert.equal(results.modes, 4);
  assert.deepEqual(results.hromElements, [3, 17, 42]);
  assert.deepEqual(results.samples, { names: ["load"], train: 3, test: 1 });
  status = romStatus(results);
  assert.equal(romRowText(status), "Reduced model — ROM 4 modes · HROM 3 el / 1 cond · 1 run done · finished");
  fs.writeFileSync(path.join(dir, "kkss-rom-summary-v1.json"), JSON.stringify({ version: 1, stopped: true }));
  assert.match(romRowText(romStatus(readRomResults(dir))), /stopped \(database partial\)/);
});

test("a corrupt npy file is a warning, not a failure", () => {
  const dir = romCase();
  fs.mkdirSync(path.join(dir, "rom_data"));
  fs.writeFileSync(path.join(dir, "rom_data", "HROM_ElementIds.npy"), "garbage");
  const results = readRomResults(dir);
  assert.equal(results.hromElements, undefined);
  assert.match(results.warnings.join(" "), /HROM_ElementIds\.npy: Not a \.npy file/);
});

test("the singular-value recipe normalizes by the first value and marks the kept modes", async () => {
  const { recipe, notes } = romSingularValuesRecipe([10, 1, 0.1, 0.01], 2, "sv");
  assert.deepEqual(notes, []);
  assert.equal(recipe.presentation.yScale, "log");
  const dataset = await collectPlot(validatePlotRecipe(recipe));
  assert.deepEqual(dataset.series[0].points.map((p) => p.y), [1, 0.1, 0.01, 0.001]);
  assert.equal(dataset.series[1].points.length, 2);
  assert.match(romSingularValuesRecipe([0, 0], undefined, "x").notes[0], /all zero/);
});
