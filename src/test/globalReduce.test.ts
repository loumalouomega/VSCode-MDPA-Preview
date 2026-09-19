import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import {
  GLOBAL_REDUCTIONS,
  GlobalReduction,
  reduceValues,
  computeGlobal,
  globalValueCount,
  defaultGlobalName,
} from "../parser/globalReduce";
import { applyOp, opRecordFromMessage } from "../parser/operations";
import { MdpaModel } from "../parser/types";

const MESH = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements

Begin NodalData TEMP
1 0 300
2 0 310
3 0 320
4 0 330
End NodalData

Begin ElementalData E
1 2.0
2 4.0
End ElementalData
`;

const mesh = (): MdpaModel => parseMdpa(MESH);

test("GLOBAL_REDUCTIONS is the box-stats set plus abs extremes", () => {
  assert.deepEqual([...GLOBAL_REDUCTIONS], [
    "min", "max", "minAbs", "maxAbs", "mean", "std", "median", "sum", "count", "q1", "q3", "iqr",
  ]);
});

test("reduceValues covers every reduction, skipping non-finite input", () => {
  const v = [1, 2, 3, 4];
  const cases: [GlobalReduction, number][] = [
    ["min", 1], ["max", 4], ["mean", 2.5], ["median", 2.5],
    ["sum", 10], ["count", 4], ["q1", 1.75], ["q3", 3.25], ["iqr", 1.5],
    ["minAbs", 1], ["maxAbs", 4],
  ];
  for (const [r, want] of cases) assert.equal(reduceValues(v, r), want, r);
  assert.equal(reduceValues(v, "std"), Math.sqrt(1.25));
  // Abs extremes read through the sign: largest excursion either side.
  assert.equal(reduceValues([-5, 2, -1], "maxAbs"), 5);
  assert.equal(reduceValues([-5, 2, -1], "minAbs"), 1);
  assert.equal(reduceValues([-5, 2, -1], "max"), 2);
  assert.equal(reduceValues([-5, 2, -1], "min"), -5);
  // NaN/Infinity are skipped, not propagated.
  assert.equal(reduceValues([1, NaN, 3, Infinity], "max"), 3);
  assert.equal(reduceValues([1, NaN, 3, Infinity], "count"), 2);
  assert.equal(reduceValues([1, NaN, 3, Infinity], "sum"), 4);
  // Empty / all-skipped input yields NaN ("could not be computed").
  assert.ok(Number.isNaN(reduceValues([], "mean")));
  assert.ok(Number.isNaN(reduceValues([NaN], "max")));
  assert.equal(reduceValues([], "count"), 0);
});

test("defaultGlobalName spells max_h / mean_TEMP", () => {
  assert.equal(defaultGlobalName("h", "max"), "max_h");
  assert.equal(defaultGlobalName("TEMP", "mean"), "mean_TEMP");
});

test("computeGlobal reads Nodal and Elemental sources", () => {
  const m = mesh();
  assert.equal(computeGlobal(m, { variable: "TEMP", kind: "Nodal", reduction: "max" }), 330);
  assert.equal(computeGlobal(m, { variable: "TEMP", kind: "Nodal", reduction: "mean" }), 315);
  assert.equal(computeGlobal(m, { variable: "E", kind: "Elemental", reduction: "sum" }), 6);
  // Missing source resolves NaN (the name then drops out of every scope).
  assert.ok(Number.isNaN(computeGlobal(m, { variable: "NOPE", kind: "Nodal", reduction: "max" })));
  assert.equal(globalValueCount(m, { variable: "TEMP", kind: "Nodal", reduction: "max" }), 4);
  assert.equal(globalValueCount(m, { variable: "NOPE", kind: "Nodal", reduction: "max" }), 0);
});

test("computeGlobal reduces vector fields over magnitude", () => {
  const m = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
End Nodes

Begin NodalData VEL
1 2 (3, 4, 0)
2 2 (0, 0, 0)
End NodalData
`);
  // Magnitudes 5 and 0.
  assert.equal(computeGlobal(m, { variable: "VEL", kind: "Nodal", reduction: "max" }), 5);
  assert.equal(computeGlobal(m, { variable: "VEL", kind: "Nodal", reduction: "mean" }), 2.5);
});

test("reduceField op: builds, validates, applies, reports", () => {
  const rec = opRecordFromMessage({ op: "reduceField", variable: "TEMP", reduction: "max" });
  assert.deepEqual(rec, {
    op: "reduceField",
    variable: "TEMP",
    kind: "Nodal",
    reduction: "max",
    output: "max_TEMP",
  });
  const out = applyOp(mesh(), rec!);
  assert.ok(!out.noop, out.message ?? "reduceField unexpectedly noop");
  assert.match(out.message ?? "", /max_TEMP = 330/);
  assert.match(out.message ?? "", /n=4/);
  assert.deepEqual(out.model.globals, {
    max_TEMP: { variable: "TEMP", kind: "Nodal", reduction: "max" },
  });
  // Re-running replaces the spec rather than stacking a duplicate.
  const again = applyOp(out.model, rec!);
  assert.deepEqual(Object.keys(again.model.globals ?? {}), ["max_TEMP"]);
});

test("reduceField op: explicit kind/output, invalid reduction rejected", () => {
  const rec = opRecordFromMessage({
    op: "reduceField",
    variable: "E",
    kind: "Elemental",
    reduction: "mean",
    output: "avg_e",
  });
  assert.deepEqual(rec, {
    op: "reduceField",
    variable: "E",
    kind: "Elemental",
    reduction: "mean",
    output: "avg_e",
  });
  const out = applyOp(mesh(), rec!);
  assert.match(out.message ?? "", /avg_e = 3/);
  assert.equal(opRecordFromMessage({ op: "reduceField", variable: "TEMP", reduction: "bogus" }), undefined);
  assert.equal(opRecordFromMessage({ op: "reduceField", variable: "", reduction: "max" }), undefined);
  // Missing source field is a noop, never a throw.
  const missing = applyOp(
    mesh(),
    opRecordFromMessage({ op: "reduceField", variable: "GHOST", reduction: "max" })!
  );
  assert.ok(missing.noop);
  assert.match(missing.message ?? "", /No usable/);
});

test("reduceField op: reserved-collision output warns but still records", () => {
  const rec = opRecordFromMessage({ op: "reduceField", variable: "TEMP", reduction: "mean", output: "mean" });
  assert.ok(rec, "creation itself is not refused");
  const out = applyOp(mesh(), rec!);
  assert.match(out.message ?? "", /not usable in formulas/);
  assert.ok(out.model.globals?.["mean"], "spec still recorded");
});

test("globalScopeValues feeds formula scopes keyed lowercase", async () => {
  const { globalScopeValues } = await import("../parser/globalReduce");
  const m = mesh();
  const withGlobal = applyOp(
    m,
    opRecordFromMessage({ op: "reduceField", variable: "TEMP", reduction: "max" })!
  ).model;
  const scope = globalScopeValues(withGlobal);
  assert.equal(scope.get("max_temp"), 330);
});

test("globals are usable in fieldCalc formulas at any location", async () => {
  const { fieldCalcModel } = await import("../parser/fieldCalc");
  const m = mesh();
  const withGlobal = applyOp(
    m,
    opRecordFromMessage({ op: "reduceField", variable: "TEMP", reduction: "max" })!
  ).model;
  // Nodal: normalize by the global max.
  const nodal = fieldCalcModel(withGlobal, {
    expr: "temp / max_temp",
    location: "Nodal",
    output: "TNORM",
  });
  assert.ok(nodal.computed > 0);
  const tnorm = nodal.model.fields.find((f) => f.variable === "TNORM")!;
  assert.deepEqual([...tnorm.values].map((v) => Math.round(v * 1000) / 1000), [0.909, 0.939, 0.97, 1]);
  // Elemental: globals are location-independent constants.
  const elem = fieldCalcModel(withGlobal, {
    expr: "e / max_temp",
    location: "Elemental",
    output: "ENORM",
  });
  assert.ok(elem.computed > 0);
  // A global colliding with a field name resolves to the FIELD.
  const shadow = fieldCalcModel(
    {
      ...withGlobal,
      globals: { temp: { variable: "E", kind: "Elemental", reduction: "sum" } },
    },
    { expr: "temp * 2", location: "Nodal", output: "T2" }
  );
  const t2 = shadow.model.fields.find((f) => f.variable === "T2")!;
  assert.deepEqual([...t2.values], [600, 620, 640, 660]);
});

test("globals are usable in remesh expr validation with a model", () => {
  const m = mesh();
  const withGlobal = applyOp(
    m,
    opRecordFromMessage({ op: "reduceField", variable: "TEMP", reduction: "mean" })!
  ).model;
  // Without the model the name is unknown; with it, the record builds.
  assert.equal(
    opRecordFromMessage({ op: "remesh", mode: "expr", sizeExpr: "h * mean_temp / 315" }),
    undefined
  );
  const rec = opRecordFromMessage(
    { op: "remesh", mode: "expr", sizeExpr: "h * mean_temp / 315" },
    withGlobal
  );
  assert.deepEqual(rec, { op: "remesh", mode: "expr", sizeExpr: "h * mean_temp / 315" });
});
