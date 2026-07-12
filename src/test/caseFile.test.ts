import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeCase, parseCaseJson } from "../problemtype/caseFile";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";

test("case state round-trips through serialize/parse", () => {
  const state = defaultCaseState(structural.decl);
  state.assignments.push({
    conditionId: "displacement",
    smpPath: "Support",
    values: { value: [0, 0, 0], constrained: true },
  });
  state.materials.push({ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} });
  state.output.format = "binary";
  state.output.interval = 5;
  const { state: back, warnings } = parseCaseJson(serializeCase(state));
  assert.deepEqual(warnings, []);
  assert.deepEqual(back, state);
});

test("parseCaseJson rejects non-JSON and missing problemtypeId", () => {
  assert.equal(parseCaseJson("not json").state, undefined);
  assert.equal(parseCaseJson("[]").state, undefined);
  assert.equal(parseCaseJson("{}").state, undefined);
});

test("parseCaseJson degrades malformed pieces to defaults with warnings", () => {
  const { state, warnings } = parseCaseJson(
    JSON.stringify({
      version: 99,
      problemtypeId: "structural",
      values: { problem: { endTime: 3 }, junk: 5 },
      assignments: [{ conditionId: "displacement", smpPath: "S" }, { bad: true }],
      materials: "nope",
      output: { format: "weird", interval: -2 },
    })
  );
  assert.ok(state);
  assert.equal(state.problemtypeId, "structural");
  assert.equal(state.values.problem.endTime, 3);
  assert.equal(state.values.junk, undefined); // non-object section dropped
  assert.equal(state.assignments.length, 1);
  assert.deepEqual(state.assignments[0].values, {});
  assert.deepEqual(state.materials, []);
  assert.equal(state.output.format, "ascii");
  assert.equal(state.output.interval, 1);
  assert.ok(warnings.some((w) => w.includes("version 99")));
  assert.ok(warnings.some((w) => w.includes("malformed entry")));
  assert.ok(warnings.some((w) => w.includes('"materials" is not an array')));
});
