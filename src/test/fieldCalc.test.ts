/**
 * fieldCalc.ts — field calculator + nodal<->elemental averaging. Pure, no wasm.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { fieldCalcModel, averageField } from "../parser/fieldCalc";
import { parseMdpa } from "../parser/mdpaParser";

const SRC = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements

Begin NodalData TEMP
1 10.0
2 20.0
3 30.0
End NodalData

Begin NodalData VELOCITY
1 (1.0, 0.0, 0.0)
2 (2.0, 0.0, 0.0)
3 (3.0, 0.0, 0.0)
End NodalData

Begin ElementalData MAT
1 5.0
End ElementalData
`;

test("field calculator derives a scalar from an expression over an existing field", () => {
  const model = parseMdpa(SRC);
  const r = fieldCalcModel(model, { expr: "TEMP * 2", location: "Nodal", output: "TEMP2" });
  assert.equal(r.computed, 3);
  const f = r.model.fields.find((x) => x.variable === "TEMP2")!;
  assert.deepEqual(Array.from(f.ids), [1, 2, 3]);
  assert.deepEqual(Array.from(f.values), [20, 40, 60]);
});

test("a vector field's components are addressable as name_X/_Y/_Z", () => {
  const model = parseMdpa(SRC);
  const r = fieldCalcModel(model, {
    expr: "sqrt(VELOCITY_X^2 + VELOCITY_Y^2)",
    location: "Nodal",
    output: "SPEED",
  });
  const f = r.model.fields.find((x) => x.variable === "SPEED")!;
  assert.deepEqual(Array.from(f.values), [1, 2, 3]);
});

test("x/y/z are available, and are the cell centroid at an Elemental location", () => {
  const model = parseMdpa(SRC);
  const r = fieldCalcModel(model, { expr: "x + y", location: "Elemental", output: "SUM_XY" });
  const f = r.model.fields.find((x) => x.variable === "SUM_XY")!;
  // Centroid of (0,0),(1,0),(1,1) = (2/3, 1/3).
  assert.ok(Math.abs(f.values[0] - 1) < 1e-9);
});

test("referencing a field only defined elsewhere yields NaN and the row is dropped", () => {
  const model = parseMdpa(SRC);
  // MAT is Elemental; asking for it at a Nodal location is simply not in scope,
  // so the expression must fail to compile rather than silently reading zero.
  assert.throws(() => fieldCalcModel(model, { expr: "MAT + 1", location: "Nodal", output: "X" }));
});

test("division by zero yields Infinity and is KEPT, not treated as an error", () => {
  const model = parseMdpa(SRC);
  const r = fieldCalcModel(model, { expr: "1 / (TEMP - 10)", location: "Nodal", output: "R" });
  const f = r.model.fields.find((x) => x.variable === "R")!;
  // Node 1 has TEMP=10 -> 1/0 = Infinity, which must survive, not be dropped.
  assert.equal(f.ids.length, 3);
  assert.equal(f.values[0], Infinity);
});

test("a syntactically bad expression is rejected before anything is applied", () => {
  const model = parseMdpa(SRC);
  assert.throws(() => fieldCalcModel(model, { expr: "TEMP +* 2", location: "Nodal", output: "X" }));
  // Nothing should have been added on the failed attempt.
  assert.equal(model.fields.length, 3);
});

test("re-running the calculator replaces rather than duplicates the field", () => {
  let model = parseMdpa(SRC);
  model = fieldCalcModel(model, { expr: "TEMP * 2", location: "Nodal", output: "TEMP2" }).model;
  model = fieldCalcModel(model, { expr: "TEMP * 3", location: "Nodal", output: "TEMP2" }).model;
  const matches = model.fields.filter((f) => f.variable === "TEMP2");
  assert.equal(matches.length, 1);
  assert.deepEqual(Array.from(matches[0].values), [30, 60, 90]);
});

test("never mutates the input model", () => {
  const model = parseMdpa(SRC);
  const before = model.fields.length;
  fieldCalcModel(model, { expr: "TEMP * 2", location: "Nodal", output: "TEMP2" });
  assert.equal(model.fields.length, before);
});

// --- averaging ---------------------------------------------------------

test("nodalToElemental averages a Nodal field over each cell's own nodes", () => {
  const model = parseMdpa(SRC);
  const r = averageField(model, { variable: "TEMP", direction: "nodalToElemental" });
  assert.equal(r.computed, 1);
  const f = r.model.fields.find((x) => x.kind === "Elemental" && x.variable === "TEMP")!;
  assert.equal(f.values[0], 20); // mean(10,20,30)
});

test("elementalToNodal averages incident cells onto each node", () => {
  const model = parseMdpa(SRC);
  // Only one element touches every node here, so each node just gets MAT's value.
  const r = averageField(model, { variable: "MAT", direction: "elementalToNodal" });
  assert.equal(r.computed, 3);
  const f = r.model.fields.find((x) => x.kind === "Nodal" && x.variable === "MAT")!;
  assert.ok([1, 2, 3].every((id) => Array.from(f.ids).includes(id)));
  assert.ok(Array.from(f.values).every((v) => v === 5));
});

test("elementalToNodal averages a shared node over ALL its incident cells", () => {
  const src = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements

Begin ElementalData MAT
1 10.0
2 30.0
End ElementalData
`;
  const model = parseMdpa(src);
  const r = averageField(model, { variable: "MAT", direction: "elementalToNodal" });
  const f = r.model.fields.find((x) => x.kind === "Nodal" && x.variable === "MAT")!;
  const valueOf = (id: number): number => f.values[Array.from(f.ids).indexOf(id)];
  assert.equal(valueOf(2), 10); // only in element 1
  assert.equal(valueOf(4), 30); // only in element 2
  assert.equal(valueOf(1), 20); // shared: mean(10,30)
  assert.equal(valueOf(3), 20); // shared: mean(10,30)
});

test("averaging with no matching source field is a noop", () => {
  const model = parseMdpa(SRC);
  const r = averageField(model, { variable: "NOPE", direction: "nodalToElemental" });
  assert.equal(r.computed, 0);
  assert.equal(r.model, model);
});
