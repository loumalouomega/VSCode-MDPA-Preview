/** Unit tests for pure formula and caption name completion (roadmap item 85). */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFormulaCompletion,
  buildExprCompletions,
  matchCaptionCompletions,
  matchExprCompletions,
} from "../parser/formulaComplete";
import { scopeVariables } from "../parser/fieldCalc";
import { validateFormula } from "../parser/formulaSelect";
import { remeshSizeExprVars, validateSizeExpr } from "../parser/sizeExpr";
import type { FieldData, MdpaModel } from "../parser/types";

const sampleFields: FieldData[] = [
  {
    variable: "TEMPERATURE",
    kind: "Nodal",
    components: 1,
    ids: new Int32Array([1, 2, 3]),
    values: new Float64Array([300, 310, 320]),
    dimensions: { exponents: [0, 0, 0, 1, 0, 0, 0] }, // K
  },
  {
    variable: "VELOCITY",
    kind: "Nodal",
    components: 3,
    ids: new Int32Array([1, 2, 3]),
    values: new Float64Array([1, 0, 0, 2, 0, 0, 3, 0, 0]),
    dimensions: { exponents: [0, 1, -1, 0, 0, 0, 0] }, // m/s
  },
  {
    variable: "DENSITY",
    kind: "Elemental",
    components: 1,
    ids: new Int32Array([10]),
    values: new Float64Array([1.225]),
  },
];

const sampleModel: MdpaModel = {
  nodeCount: 3,
  nodeIds: new Int32Array([1, 2, 3]),
  coords: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  blocks: [
    {
      kind: "Elements",
      name: "Element2D3N",
      count: 1,
      stride: 3,
      entityIds: new Int32Array([10]),
      connectivity: new Int32Array([1, 2, 3]),
      propertyIds: new Int32Array([1]),
    },
  ],
  subModelParts: [],
  fields: sampleFields,
  globals: { max_temp: { variable: "TEMPERATURE", kind: "Nodal", reduction: "max" } },
  diagnostics: [],
  meta: [],
  is3D: false,
  bounds: { min: [0, 0, 0], max: [1, 1, 0] },
};

test("buildExprCompletions for fieldCalc offers only names that validate at that location", () => {
  const nodalItems = buildExprCompletions({
    mode: "fieldCalc",
    location: "Nodal",
    fields: sampleFields,
    globals: ["max_temp"],
  });
  const scope = scopeVariables(
    sampleFields.filter((f) => f.kind === "Nodal"),
    true,
    ["max_temp"]
  );

  for (const item of nodalItems) {
    if (item.kind === "function") continue;
    assert.equal(validateSizeExpr(item.insert, scope), undefined, `Expected ${item.insert} to validate`);
  }

  const temp = nodalItems.find((i) => i.insert === "temperature");
  assert.ok(temp);
  assert.equal(temp.detail, "nodal field");
  assert.equal(temp.unit, "K");

  const vx = nodalItems.find((i) => i.insert === "velocity_x");
  assert.ok(vx);
  assert.equal(vx.detail, "nodal field");
  assert.equal(vx.unit, "m/s");

  // Elemental field must not appear in Nodal scope
  assert.equal(nodalItems.find((i) => i.insert === "density"), undefined);

  const g = nodalItems.find((i) => i.insert === "max_temp");
  assert.ok(g);
  assert.equal(g.detail, "global");

  const clampFn = nodalItems.find((i) => i.insert === "clamp(");
  assert.ok(clampFn);
  assert.equal(clampFn.detail, "fn(3)");
});

test("buildExprCompletions for remesh matches remeshSizeExprVars", () => {
  const items = buildExprCompletions({
    mode: "remesh",
    fields: sampleFields,
    globals: ["max_temp"],
    hasDistanceSurface: true,
  });
  const scope = remeshSizeExprVars(
    true,
    scopeVariables(sampleFields.filter((f) => f.kind === "Nodal"), false, []),
    ["max_temp"]
  );
  for (const item of items) {
    if (item.kind === "function") continue;
    assert.equal(validateSizeExpr(item.insert, scope), undefined, `Expected ${item.insert} to validate in remesh`);
  }
  assert.equal(items.find((i) => i.insert === "d")?.detail, "distance");
  assert.equal(items.find((i) => i.insert === "h")?.detail, "nodal size");
  assert.equal(items.find((i) => i.insert === "mean")?.detail, "size stat");
});

test("buildExprCompletions for formulaSelect validates with validateFormula", () => {
  const items = buildExprCompletions({
    mode: "formulaSelect",
    fields: sampleFields,
    globals: ["max_temp"],
  });
  for (const item of items) {
    if (item.kind === "function") continue;
    assert.equal(validateFormula(sampleModel, `${item.insert} > 0`), undefined, `Expected ${item.insert} to validate`);
  }
});

test("matchExprCompletions opens at 2+ letters or on force (Ctrl+Space)", () => {
  const items = buildExprCompletions({ mode: "fieldCalc", location: "Nodal", fields: sampleFields });
  assert.equal(matchExprCompletions("t", 1, items), null);
  const forced = matchExprCompletions("", 0, items, { force: true });
  assert.ok(forced && forced.items.length > 0);

  const m = matchExprCompletions("2 * te", 6, items);
  assert.ok(m);
  assert.equal(m.prefix, "te");
  assert.equal(m.items[0].insert, "temperature");

  const applied = applyFormulaCompletion("2 * te + 1", m.start, m.end, m.items[0]);
  assert.equal(applied.text, "2 * temperature + 1");
  assert.equal(applied.cursor, 15);
});

test("matchCaptionCompletions completes tokens, parts, fields with units, and display units", () => {
  const ctx = { fields: sampleFields, parts: ["Inlet", "Wall"] };

  const tok = matchCaptionCompletions("{ma", 3, ctx);
  assert.ok(tok);
  assert.equal(tok.items[0].insert, "{max(");

  const fld = matchCaptionCompletions("{max(te", 7, ctx);
  assert.ok(fld);
  assert.equal(fld.items[0].insert, "TEMPERATURE");
  assert.equal(fld.items[0].unit, "K");

  const part = matchCaptionCompletions("{avg(In", 7, ctx);
  assert.ok(part);
  assert.equal(part.items[0].insert, "Inlet");
  assert.equal(part.items[0].detail, "part");

  const unit = matchCaptionCompletions("{max(VELOCITY, ", 15, ctx, { force: true });
  assert.ok(unit && unit.items.some((i) => i.insert === "m/s"));
});
