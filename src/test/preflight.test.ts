import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { structural } from "../problemtype/builtins/structural";
import { fluid } from "../problemtype/builtins/fluid";
import { fsi } from "../problemtype/builtins/fsi";
import { preflightCase, Finding } from "../problemtype/preflight";
import { CaseState } from "../problemtype/types";

// One tetrahedron: a volume part, a boundary part with a condition, a nodes-only
// part, an empty part and a part nothing will use. Element 1 names Properties 7
// (undefined); Properties 3 is defined and used by nobody.
const MDPA = `Begin Properties 0
End Properties

Begin Properties 3
  DENSITY 1.0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 7 1 2 3 4
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
End Conditions

Begin SubModelPart Parts
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
End SubModelPart

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart Loaded
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart Hollow
End SubModelPart

Begin SubModelPart Unused
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart
`;

function goodState(): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } }];
  return state;
}

const codes = (findings: Finding[], code: string): Finding[] => findings.filter((f) => f.code === code);

test("a complete case has no errors and generates", async () => {
  const model = parseMdpa(MDPA);
  const report = await preflightCase(structural, model, goodState(), "beam");
  assert.equal(report.ok, true);
  assert.equal(report.counts.error, 0);
  await generateCase(structural, model, goodState(), "beam"); // does not throw
});

test("a SubModelPart missing from the mesh and an undeclared condition are errors", async () => {
  const model = parseMdpa(MDPA);
  const state = goodState();
  state.assignments.push({ conditionId: "displacement", smpPath: "Nope", values: {} });
  state.assignments.push({ conditionId: "unknownCond", smpPath: "Support", values: {} });
  state.materials.push({ smpPath: "Ghost", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 1e9 } });
  const report = await preflightCase(structural, model, state, "beam");
  assert.equal(report.ok, false);
  const missing = codes(report.findings, "smp-missing");
  assert.deepEqual(missing.map((f) => f.target?.smpPath).sort(), ["Ghost", "Nope"]);
  assert.equal(codes(report.findings, "condition-undeclared")[0].target?.conditionId, "unknownCond");
  // Errors sort first.
  assert.equal(report.findings[0].severity, "error");
});

test("what Generate refuses surfaces as an error finding", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(fluid.decl);
  state.assignments = [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }];
  state.materials = [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: { DENSITY: 0, DYNAMIC_VISCOSITY: 1e-3 } }];
  const report = await preflightCase(fluid, model, state, "cavity");
  assert.equal(report.ok, false);
  const refused = codes(report.findings, "generate-refused");
  assert.ok(refused.length > 0);
  assert.ok(refused.some((f) => /density/i.test(f.message)));
  await assert.rejects(generateCase(fluid, model, state, "cavity"));
});

test("a warning-severity material problem stays a warning (Generate still succeeds)", async () => {
  const model = parseMdpa(MDPA);
  const state = goodState();
  state.materials = [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2e11, POISSON_RATIO: 0.9 } }];
  const report = await preflightCase(structural, model, state, "beam");
  assert.equal(report.ok, true);
  assert.ok(report.findings.some((f) => f.severity === "warning" && f.code === "generate-warning" && /poisson/i.test(f.message)));
});

test("a computing part with no material, and a material off the computing parts, warn", async () => {
  const model = parseMdpa(MDPA);
  const state = goodState();
  state.materials = [];
  let report = await preflightCase(structural, model, state, "beam");
  assert.equal(codes(report.findings, "part-no-material")[0].target?.smpPath, "Parts/Solid");

  // A material on the parent covers the child part.
  state.materials = [{ smpPath: "Parts", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2e11 } }];
  report = await preflightCase(structural, model, state, "beam");
  assert.equal(codes(report.findings, "part-no-material").length, 0);

  state.materials = [
    { smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2e11 } },
    { smpPath: "Support", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2e11 } },
  ];
  report = await preflightCase(structural, model, state, "beam");
  assert.equal(codes(report.findings, "material-outside-parts")[0].target?.smpPath, "Support");
});

test("empty, wrong-kind and unused parts", async () => {
  const model = parseMdpa(MDPA);
  const state = goodState();
  state.assignments.push({ conditionId: "displacement", smpPath: "Hollow", values: { value: [0, 0, 0], constrained: true } });
  const report = await preflightCase(structural, model, state, "beam");
  assert.equal(codes(report.findings, "part-empty").filter((f) => f.severity === "warning")[0].target?.smpPath, "Hollow");
  const unused = codes(report.findings, "part-unused")[0];
  assert.equal(unused.severity, "info");
  assert.match(unused.message, /"Loaded"/);
  assert.match(unused.message, /"Unused"/);

  // A surface load on a part that only has nodes would have nothing to act on.
  const surface = structural.decl.conditions.find((c) => c.target === "surface");
  assert.ok(surface, "structural declares a surface-target condition");
  const s2 = goodState();
  s2.assignments.push({ conditionId: surface.id, smpPath: "Loaded", values: {} });
  const r2 = await preflightCase(structural, model, s2, "beam");
  assert.equal(codes(r2.findings, "part-wrong-kind")[0].target?.smpPath, "Loaded");
});

test("dangling and unused Properties ids", async () => {
  const model = parseMdpa(MDPA);
  const report = await preflightCase(structural, model, goodState(), "beam");
  const dangling = codes(report.findings, "property-undefined");
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].target?.propertyId, 7);
  assert.equal(dangling[0].severity, "warning");
  assert.match(codes(report.findings, "property-unused")[0].message, /\b3\b/);
});

test("mesh quality can be skipped or capped", async () => {
  const model = parseMdpa(MDPA);
  const off = await preflightCase(structural, model, goodState(), "beam", { quality: false });
  assert.equal(off.findings.some((f) => f.code === "isolated-nodes" || f.code === "quality-metric"), false);
  const capped = await preflightCase(structural, model, goodState(), "beam", { qualityMaxElements: 1 });
  assert.equal(codes(capped.findings, "quality-skipped").length, 1);
});

test("a sliver tetrahedron is reported as a mesh-wide quality warning", async () => {
  const sliver = MDPA.replace("4 0.0 0.0 1.0", "4 0.5 0.5 0.0001");
  const report = await preflightCase(structural, parseMdpa(sliver), goodState(), "beam");
  assert.ok(report.findings.some((f) => f.code === "quality-metric" && f.severity === "warning"));
});

test("a coupled problemtype with no interface is refused, naming the domain", async () => {
  const model = parseMdpa(MDPA);
  const state = defaultCaseState(fsi.decl);
  const report = await preflightCase(fsi, model, state, "wall");
  assert.equal(report.ok, false);
  assert.ok(codes(report.findings, "generate-refused").some((f) => /Domain/.test(f.message)));
});

test("ok is exactly 'Generate resolves' for every built-in's default state", async () => {
  const model = parseMdpa(MDPA);
  for (const runtime of BUILTIN_PROBLEMTYPES) {
    const state = defaultCaseState(runtime.decl);
    const report = await preflightCase(runtime, model, state, "case");
    let generated = true;
    try {
      await generateCase(runtime, model, state, "case");
    } catch {
      generated = false;
    }
    assert.equal(report.ok, generated, `${runtime.decl.id}: preflight ok must match Generate`);
  }
});
