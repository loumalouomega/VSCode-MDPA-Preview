import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  appendEvaluationRow,
  buildEvaluationRow,
  EVALUATION_MAX_ROWS,
  evaluationGrid,
  evaluationToCsv,
  evaluationToTsv,
} from "../parser/evaluationTable";

const a = buildEvaluationRow({
  frame: "2",
  kind: "Element",
  id: 7,
  nodeId: 3,
  coords: [1, 2, 3],
  fields: [
    { variable: "PRESSURE", value: 2000, unit: "kPa", scale: 1000 },
    { variable: "VELOCITY", value: [1, 2, 3] },
  ],
});

test("values are divided by the display scale", () => {
  assert.deepEqual(a.values[0].values, [2]);
  assert.equal(a.values[0].unit, "kPa");
  assert.deepEqual(a.values[1].values, [1, 2, 3]);
});

test("grid: header and cells", () => {
  const g = evaluationGrid([a]);
  assert.deepEqual(g[0], ["frame", "kind", "id", "node", "x", "y", "z", "PRESSURE [kPa]", "VELOCITY_X", "VELOCITY_Y", "VELOCITY_Z"]);
  assert.deepEqual(g[1], ["2", "Element", "7", "3", "1", "2", "3", "2", "1", "2", "3"]);
});

test("rows keep their own frame; missing fields are blank", () => {
  const b = buildEvaluationRow({ frame: "4", kind: "Node", id: 3, coords: [1, 2, 3], fields: [{ variable: "TEMP", value: 5 }] });
  const g = evaluationGrid(appendEvaluationRow([a], b));
  assert.equal(g[1][0], "2");
  assert.equal(g[2][0], "4");
  assert.equal(g[1][g[0].indexOf("TEMP")], "");
  assert.equal(g[2][g[0].indexOf("PRESSURE [kPa]")], "");
  assert.equal(g[2][g[0].indexOf("TEMP")], "5");
});

test("same variable in two units gets two columns", () => {
  const c = buildEvaluationRow({ frame: "1", kind: "Node", id: 1, fields: [{ variable: "P", value: 1000, unit: "Pa" }] });
  const d = buildEvaluationRow({ frame: "2", kind: "Node", id: 1, fields: [{ variable: "P", value: 1000, unit: "kPa", scale: 1000 }] });
  assert.deepEqual(evaluationGrid([c, d])[0].slice(7), ["P [Pa]", "P [kPa]"]);
});

test("csv quotes and keeps raw precision; tsv uses tabs", () => {
  const r = buildEvaluationRow({ frame: "a,b", kind: "Node", id: 1, fields: [{ variable: "T", value: 0.1 + 0.2 }] });
  const csv = evaluationToCsv([r]);
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes("0.30000000000000004"));
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(evaluationToTsv([r]).split("\n")[0].split("\t").length, 8);
});

test("the cap drops the oldest rows", () => {
  let rows: ReturnType<typeof appendEvaluationRow> = [];
  for (let i = 0; i < EVALUATION_MAX_ROWS + 3; i++) rows = appendEvaluationRow(rows, buildEvaluationRow({ kind: "Node", id: i, fields: [] }));
  assert.equal(rows.length, EVALUATION_MAX_ROWS);
  assert.equal(rows[0].id, 3);
});
