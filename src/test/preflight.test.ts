import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { structural } from "../problemtype/builtins/structural";
import { fluid } from "../problemtype/builtins/fluid";
import { fsi } from "../problemtype/builtins/fsi";
import { embeddedFluid } from "../problemtype/builtins/embeddedFluid";
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

test("a block the selected formulation has no shape for is a generate-refused error", async () => {
  const decl = {
    ...structural.decl,
    meshNaming: {
      elements: {
        field: "elementBase",
        names: { ShellThinElementCorotational: { 3: { 3: "ShellThinElementCorotational3D3N", 4: "ShellThinElementCorotational3D4N" } } },
      },
    },
  };
  const runtime = { ...structural, decl };
  const state = goodState();
  state.values.problem.elementBase = "ShellThinElementCorotational";
  // A hexahedron has no thin-shell variant: adapting it would invent a name.
  const model = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
5 1.0 1.0 1.0
6 0.0 1.0 1.0
7 0.0 0.0 1.0
8 1.0 0.0 1.0
End Nodes

Begin Elements Element3D8N
1 0 1 2 3 4 5 6 7 8
End Elements
`);
  const report = await preflightCase(runtime, model, state, "beam", { quality: false });
  assert.equal(report.ok, false);
  const refused = codes(report.findings, "generate-refused");
  assert.equal(refused.length, 1);
  assert.match(refused[0].message, /Element3D8N/);
  assert.match(refused[0].message, /ShellThinElementCorotational/);
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

// --- Layer 7: mesh fields a declaration expects (advisory). ---
const withDistance = (components = 1): string =>
  MDPA + `Begin NodalData DISTANCE\n${[1, 2, 3, 4].map((i) => (components === 1 ? `${i} 0 0.5` : `${i} 0 [3] (0.5,0,0)`)).join("\n")}\nEnd NodalData\n`;

test("an embedded problemtype warns when the mesh lacks the DISTANCE field it reads", async () => {
  const state = defaultCaseState(embeddedFluid.decl); // distanceMode defaults to from_mdpa
  const missing = codes((await preflightCase(embeddedFluid, parseMdpa(MDPA), state, "e", { quality: false })).findings, "field-missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, "warning");
  assert.match(missing[0].message, /DISTANCE/);
  const ok = await preflightCase(embeddedFluid, parseMdpa(withDistance()), state, "e", { quality: false });
  assert.equal(codes(ok.findings, "field-missing").length + codes(ok.findings, "field-shape").length, 0);
});

test("a field requirement only applies while its form values ask for it", async () => {
  const state = defaultCaseState(embeddedFluid.decl);
  state.values.problem.distanceMode = "from_GiD_file";
  const report = await preflightCase(embeddedFluid, parseMdpa(MDPA), state, "e", { quality: false });
  assert.equal(codes(report.findings, "field-missing").length, 0);
});

test("a field of the wrong width is reported as field-shape and never makes ok false by itself", async () => {
  const state = defaultCaseState(embeddedFluid.decl);
  const model = parseMdpa(withDistance(3));
  const withReq = await preflightCase(embeddedFluid, model, state, "e", { quality: false });
  assert.equal(codes(withReq.findings, "field-shape").length, 1);
  assert.match(codes(withReq.findings, "field-shape")[0].message, /3-component/);
  // The requirement is advisory: removing it must not change `ok`.
  const bare = await preflightCase(embeddedFluid, parseMdpa(MDPA), state, "e", { quality: false });
  let generated = true;
  try { await generateCase(embeddedFluid, parseMdpa(MDPA), state, "e"); } catch { generated = false; }
  assert.equal(bare.ok, generated);
});

test("a condition-level requirement is reported once per part and targets it", async () => {
  const runtime = { ...structural, decl: { ...structural.decl, conditions: structural.decl.conditions.map((c) => c.id === "displacement" ? { ...c, requiresFields: [{ variable: "TEMPERATURE", components: 1 as const, kind: "Nodal" as const }] } : c) } };
  const state = goodState();
  state.assignments.push({ conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } });
  const found = codes((await preflightCase(runtime, parseMdpa(MDPA), state, "beam", { quality: false })).findings, "field-missing");
  assert.equal(found.length, 1, "duplicate assignments on one part are reported once");
  assert.equal(found[0].target?.smpPath, "Support");
  assert.equal(found[0].target?.conditionId, "displacement");
});

test("constraints: a node no cell uses and a fixed slave are findings", async () => {
  const model = parseMdpa(MDPA + `
Begin Nodes
99 5.0 5.0 5.0
End Nodes
`);
  const withConstraints = {
    ...model,
    constraints: [
      {
        name: "LinearMasterSlaveConstraint",
        variables: ["DISPLACEMENT_X"],
        rows: [
          { kind: "linear" as const, id: 1, constant: 0, weights: [1], slaveIds: [1], masterIds: [4] },
          { kind: "linear" as const, id: 2, constant: 0, weights: [1], slaveIds: [4], masterIds: [99] },
        ],
      },
    ],
  };
  const report = await preflightCase(structural, withConstraints, goodState(), "beam");
  assert.deepEqual(codes(report.findings, "constraint-unused-node")[0]?.target?.entityIds, [99]);
  const fixed = codes(report.findings, "constraint-slave-fixed")[0];
  assert.equal(fixed?.target?.smpPath, "Support");
  assert.deepEqual(fixed?.target?.entityIds, [1]);
  const clean = await preflightCase(structural, parseMdpa(MDPA), goodState(), "beam");
  assert.equal(codes(clean.findings, "constraint-slave-fixed").length, 0);
});
