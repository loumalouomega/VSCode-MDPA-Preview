import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTableText, parseTableText, rowsToText, tableTextProblem, textToRows } from "../problemtype/materialTables";
import { validateMaterialAssignment } from "../problemtype/materialCatalog";
import { fluid } from "../problemtype/builtins/fluid";

test("table text parses, formats and round-trips", () => {
  assert.deepEqual(parseTableText("293.15,1e-3; 373.15,2.8e-4"), [[293.15, 0.001], [373.15, 0.00028]]);
  assert.equal(formatTableText([[293.15, 0.001], [373.15, 0.00028]]), "293.15,0.001; 373.15,0.00028");
  assert.deepEqual(parseTableText(formatTableText([[0, 1], [2, 3]])), [[0, 1], [2, 3]]);
  assert.equal(tableTextProblem("1,2; 3,4"), undefined);
  assert.match(tableTextProblem("hot")!, /at least two pairs/);
  assert.match(tableTextProblem("1,2; hot")!, /not an "input,output" pair/);
  assert.match(tableTextProblem("")!, /enter one/);
});

test("grid rows keep malformed rows editable with their problem", () => {
  const { rows, problems } = textToRows("293.15,1e-3; hot; 373.15,");
  assert.equal(rows.length, 3);
  assert.equal(problems.length, 2, problems.join("; "));
  assert.equal(rowsToText(rows), "293.15,1e-3; hot,; 373.15,");
  assert.equal(rowsToText([{ input: "", output: "" }]), "");
  const single = textToRows("1,2");
  assert.match(single.problems.join(" "), /at least two pairs/);
});

test("a bad table is refused on the material, naming the table", () => {
  const law = fluid.decl.materialLaws.find((l) => l.id === "temperature_dependent_3d")!;
  assert.deepEqual(
    validateMaterialAssignment(law, { DENSITY: 997, TEMPERATURE_TABLE: "293.15,1e-3; oops" }, undefined).map((i) => i.message),
    ['Table1 table: "oops" is not an "input,output" pair of numbers']
  );
  assert.deepEqual(validateMaterialAssignment(law, { DENSITY: 997, TEMPERATURE_TABLE: "293.15,1e-3; 373.15,2.8e-4" }, undefined), []);
});
