import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCaption, hasCaptionTokens } from "../parser/captionTokens";
import { PRESSURE } from "../parser/fieldDimensions";
import type { MdpaModel, FieldData } from "../parser/types";

function model(fields: FieldData[], parts: unknown[] = []): MdpaModel {
  return {
    nodeIds: Int32Array.from([1, 2, 3]),
    blocks: [],
    fields,
    subModelParts: parts,
  } as unknown as MdpaModel;
}
const p: FieldData = {
  kind: "Nodal", variable: "P", components: 1, ids: Int32Array.from([1, 2, 3]),
  values: Float64Array.from([1000, 3000, 5000]), dimensions: { exponents: [...PRESSURE] },
};
const v: FieldData = {
  kind: "Nodal", variable: "V", components: 3, ids: Int32Array.from([1, 2]),
  values: Float64Array.from([3, 4, 0, 0, 0, 1]),
};
const part = { name: "A", path: "A", nodeIds: [1, 2], elementIds: [], conditionIds: [], geometryIds: [], constraintIds: [], children: [] };

test("max/min/avg over a whole field and a SubModelPart", () => {
  const m = model([p], [part]);
  assert.equal(evaluateCaption("{max(P)}", { model: m }).text, "5000");
  assert.equal(evaluateCaption("{min(P)}", { model: m }).text, "1000");
  assert.equal(evaluateCaption("{avg(A, P)}", { model: m }).text, "2000");
});

test("vector fields reduce over magnitude", () => {
  assert.equal(evaluateCaption("{max(V)}", { model: model([v]) }).text, "5");
});

test("display units convert; an unknown unit prints ? with a diagnostic", () => {
  const m = model([p]);
  assert.equal(evaluateCaption("{max(P, kPa)}", { model: m }).text, "5 kPa");
  const bad = evaluateCaption("{max(P, furlong)}", { model: m });
  assert.equal(bad.text, "?");
  assert.equal(bad.diagnostics.length, 1);
  assert.equal(evaluateCaption("{max(V, kPa)}", { model: model([v]) }).text, "?");
});

test("unknown field/part never throw", () => {
  const m = model([p]);
  assert.equal(evaluateCaption("{max(Nope)}", { model: m }).text, "?");
  assert.equal(evaluateCaption("{avg(Missing, P)}", { model: m }).text, "?");
  assert.equal(evaluateCaption("{max(P)}", {}).text, "?");
});

test("time, step, plain text and unknown tokens", () => {
  assert.equal(evaluateCaption("t={time} s{step}", { time: 0.5, step: "7" }).text, "t=0.5 s7");
  assert.equal(evaluateCaption("{time}", {}).text, "?");
  assert.equal(evaluateCaption("no tokens", {}).text, "no tokens");
  assert.equal(evaluateCaption("{bogus}", {}).text, "{bogus}");
  assert.ok(hasCaptionTokens("a {step}"));
  assert.ok(!hasCaptionTokens("a b"));
});
