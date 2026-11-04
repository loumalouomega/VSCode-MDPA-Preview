/** Units and case parameters in problemtype forms (roadmap item 27). Pure, no wasm. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateParameters, parseNumericText, previewParameters, resolveFieldExpression } from "../problemtype/caseExpressions";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { parseMdpa } from "../parser/mdpaParser";
import { preflightCase } from "../problemtype/preflight";

const none = new Map();

test("unit literals convert into the field's unit; temperature scales are affine (item 27)", () => {
  assert.ok(Math.abs(resolveFieldExpression("20[degC]", "K", none).value - 293.15) < 1e-12);
  assert.ok(Math.abs(resolveFieldExpression("293.15[K]", "degC", none).value - 20) < 1e-9);
  assert.ok(Math.abs(resolveFieldExpression("10[mm]", "m", none).value - 0.01) < 1e-15);
  assert.ok(Math.abs(resolveFieldExpression("2[bar]", "Pa", none).value - 2e5) < 1e-6);
  assert.equal(resolveFieldExpression("7", "Pa", none).value, 7);
  assert.throws(() => resolveFieldExpression("2*20[degC]", "K", none), /offset/);
  assert.throws(() => resolveFieldExpression("1[m] + 1[s]", "m", none), /combines/);
  assert.throws(() => resolveFieldExpression("3[furlong]", "m", none), /unknown unit/);
  assert.throws(() => resolveFieldExpression("3[1,5 m]", "m", none), /comma/);
});

test("a dimension mismatch warns and keeps the number unconverted", () => {
  const r = resolveFieldExpression("5[s]", "m", none);
  assert.equal(r.value, 5);
  assert.match(r.warning!, /^unit-mismatch:/);
});

test("parameters are evaluated in order and used by name", () => {
  const p = evaluateParameters([{ name: "L", expr: "2[m]" }, { name: "H", expr: "L/2" }]);
  assert.ok(Math.abs(resolveFieldExpression("H + 50[cm]", "m", p).value - 1.5) < 1e-12);
  assert.throws(() => evaluateParameters([{ name: "L", expr: "1" }, { name: "l", expr: "2" }]), /twice/);
  assert.throws(() => evaluateParameters([{ name: "min", expr: "1" }]), /usable name/);
  assert.throws(() => evaluateParameters([{ name: "A", expr: "B" }]), /Parameter "A"/);
});

const MDPA = `Begin Properties 0
End Properties
Begin Nodes
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 4
End Elements
Begin SubModelPart Solid
  Begin SubModelPartNodes
  1
  2
  3
  4
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

function state(young: string | number, params?: { name: string; expr: string }[]) {
  const s = defaultCaseState(structural.decl);
  s.assignments = [{ conditionId: "parts", smpPath: "Solid", values: {} }];
  s.materials = [{ smpPath: "Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: young as never } }];
  if (params) s.parameters = params;
  return s;
}
const youngOf = (text: string): number => JSON.parse(text).properties[0].Material.Variables.YOUNG_MODULUS;

test("generation writes resolved numbers: E = 2 [bar]-style input and a parameter change regenerates both fields", async () => {
  const model = parseMdpa(MDPA);
  assert.equal(youngOf((await generateCase(structural, model, state("200[GPa]"), "m")).materials), 2e11);
  const withParam = (L: string) => generateCase(structural, model, state("L * 1[GPa]", [{ name: "L", expr: L }]), "m");
  assert.equal(youngOf((await withParam("100")).materials), 1e11);
  assert.equal(youngOf((await withParam("150")).materials), 1.5e11);
});

test("a mismatch is reported by generation as a unit-mismatch warning; a bad expression refuses", async () => {
  const model = parseMdpa(MDPA);
  const out = await generateCase(structural, model, state("5[s]"), "m");
  assert.ok(out.warnings.some((w) => /unit-mismatch/.test(w)));
  await assert.rejects(generateCase(structural, model, state("3[furlong]"), "m"), /expression problems/);
});

test("parameters persist in the case file, and a case without them opens unchanged", () => {
  const s = state(1, [{ name: "L", expr: "2[m]" }]);
  assert.deepEqual(parseCaseJson(serializeCase(s)).state!.parameters, [{ name: "L", expr: "2[m]" }]);
  assert.equal(parseCaseJson(serializeCase(state(1))).state!.parameters, undefined);
});

test("vector3 components accept expressions and units, one component at a time", async () => {
  const model = parseMdpa(MDPA);
  const s = state(1);
  const load = structural.decl.conditions.find((c) => (c.fields ?? []).some((f) => f.type === "vector3"));
  assert.ok(load, "the structural declaration has a vector3 condition field");
  const field = load!.fields!.find((f) => f.type === "vector3")!;
  s.parameters = [{ name: "F", expr: "4" }];
  s.assignments = [
    { conditionId: "parts", smpPath: "Solid", values: {} },
    { conditionId: load!.id, smpPath: "Solid", values: { [field.id]: ["F * 2", 0, "1[m]"] as never } },
  ];
  const out = await generateCase(structural, model, s, "m");
  assert.equal(out.warnings.some((w) => /expression problems/.test(w)), false);
  assert.ok(out.projectParameters.includes("8"), "the first component resolved to 8");
  s.assignments[1].values[field.id] = ["nonsense(", 0, 0] as never;
  await assert.rejects(generateCase(structural, model, s, "m"), /\[x\]/);
});

test("preflight reports a dimension mismatch under its own unit-mismatch code", async () => {
  const report = await preflightCase(structural, parseMdpa(MDPA), state("5[s]"), "m");
  const f = report.findings.find((x) => x.code === "unit-mismatch");
  assert.ok(f, "a unit-mismatch finding");
  assert.equal(f!.severity, "warning");
  assert.ok(!report.findings.some((x) => x.code === "generate-warning" && /unit-mismatch/.test(x.message)));
});

test("numeric form text: plain numbers stay numbers, anything else is kept as an expression, blank is 0", () => {
  assert.equal(parseNumericText("12.5"), 12.5);
  assert.equal(parseNumericText(" -3e2 "), -300);
  assert.equal(parseNumericText(""), 0);
  assert.equal(parseNumericText("10[mm]"), "10[mm]");
  assert.equal(parseNumericText("L/2"), "L/2");
});

test("the parameters table previews each line and names the one that does not evaluate", () => {
  const rows = previewParameters([{ name: "L", expr: "2[m]" }, { name: "H", expr: "L * 3" }, { name: "bad", expr: "nope(" }, { name: "T", expr: "20[degC]" }]);
  assert.equal(rows[0].error, false);
  assert.match(rows[0].text, /^= 2 \(length/);
  assert.equal(rows[1].error, false);
  assert.match(rows[1].text, /^= 6/);
  assert.equal(rows[2].error, true);
  assert.equal(rows[3].error, false, "a bad line does not break the ones after it");
});
