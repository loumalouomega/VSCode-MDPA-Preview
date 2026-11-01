/** Regional scalars in formulas (roadmap item 34): avg/int/max/min(PART, F). Pure, no wasm. */
import assert from "node:assert/strict";
import test from "node:test";

import { fieldCalcModel } from "../parser/fieldCalc";
import { formulaCells, validateFormula } from "../parser/formulaSelect";
import { expandRegionalScalars } from "../parser/regionalScalars";
import { parseMdpa } from "../parser/mdpaParser";

// Two unit-ish triangles: Body = element 1 (area 0.5) + element 2 (area 2), Other = element 2.
const SRC = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 2.0 0.0 0.0
5 0.0 2.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 4 5
End Elements

Begin NodalData TEMP
1 10.0
2 20.0
3 30.0
4 40.0
5 50.0
End NodalData

Begin ElementalData MAT
1 4.0
2 8.0
End ElementalData

Begin SubModelPart Body
  Begin SubModelPartNodes
  1
  2
  3
  4
  5
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  2
  End SubModelPartElements
End SubModelPart

Begin SubModelPart Other
  Begin SubModelPartNodes
  1
  4
  5
  End SubModelPartNodes
  Begin SubModelPartElements
  2
  End SubModelPartElements
End SubModelPart
`;

test("nodal avg/max/min substitute literals", () => {
  const model = parseMdpa(SRC);
  assert.equal(expandRegionalScalars(model, "avg(Body, TEMP)").expr, "(30)");
  assert.equal(expandRegionalScalars(model, "max(Body, TEMP) - min(Other, TEMP)").expr, "(50) - (10)");
});

test("elemental avg is measure-weighted and int is the measure integral", () => {
  const model = parseMdpa(SRC);
  // areas 0.5 and 2.0 → (4*0.5 + 8*2) / 2.5 = 7.2 ; integral = 18
  assert.ok(Math.abs(Number(/\(([^)]+)\)/.exec(expandRegionalScalars(model, "avg(Body, MAT)").expr)![1]) - 7.2) < 1e-9);
  assert.ok(Math.abs(Number(/\(([^)]+)\)/.exec(expandRegionalScalars(model, "int(Body, MAT)").expr)![1]) - 18) < 1e-9);
});

test("two-argument max/min keep their meaning when the first argument is not a part", () => {
  const model = parseMdpa(SRC);
  assert.equal(expandRegionalScalars(model, "max(temp, 25)").expr, "max(temp, 25)");
});

test("unknown part, unknown field and nodal int are rejected before anything applies", () => {
  const model = parseMdpa(SRC);
  assert.throws(() => expandRegionalScalars(model, "avg(Nope, TEMP)"), /no SubModelPart/);
  assert.throws(() => expandRegionalScalars(model, "avg(Body, NOPE)"), /no field/);
  assert.throws(() => expandRegionalScalars(model, "int(Body, TEMP)"), /Elemental/);
  assert.throws(() => fieldCalcModel(model, { expr: "TEMP / avg(Nope, TEMP)", location: "Nodal", output: "R" }), /no SubModelPart/);
});

test("T / avg(Body, T) has mean 1 over Body", () => {
  const model = parseMdpa(SRC);
  const r = fieldCalcModel(model, { expr: "TEMP / avg(Body, TEMP)", location: "Nodal", output: "TN" });
  const f = r.model.fields.find((x) => x.variable === "TN")!;
  const mean = Array.from(f.values).reduce((a, b) => a + b, 0) / f.values.length;
  assert.ok(Math.abs(mean - 1) < 1e-12);
});

test("a formula seed with max(PART, F) selects what the literal threshold selects, and replays identically", () => {
  const model = parseMdpa(SRC);
  const a = formulaCells(model, "temp > 0.7 * max(Body, TEMP)", "all");
  const b = formulaCells(model, "temp > 35", "all");
  assert.deepEqual([...a.nodes].sort(), [...b.nodes].sort());
  assert.deepEqual([...a.kinds.Elements].sort(), [...b.kinds.Elements].sort());
  assert.equal(validateFormula(model, "temp > max(Nope, TEMP)") !== undefined, true);
  assert.equal(validateFormula(model, "temp > max(Body, TEMP)"), undefined);
});
