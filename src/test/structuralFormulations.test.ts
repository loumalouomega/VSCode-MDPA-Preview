import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState, resolveMeshNaming } from "../problemtype/api";
import { adaptMeshNames } from "../problemtype/meshAdapt";
import { structural } from "../problemtype/builtins/structural";
import { fsi } from "../problemtype/builtins/fsi";
import type { CaseState, FormulationMeshNaming, VisibleRule } from "../problemtype/types";

// A vertical bar of two line elements (3D, so the beam families name it 3D2N).
const BAR_3D = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 0.0 0.0 1.0
3 0.0 0.0 2.0
End Nodes

Begin Elements Element3D2N
1 0 1 2
2 0 2 3
End Elements

Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    2
    End SubModelPartElements
  End SubModelPart
End SubModelPart

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  End SubModelPartNodes
End SubModelPart
`;

function barState(elementBase: string, lawId: string): CaseState {
  const state = defaultCaseState(structural.decl);
  state.values.problem.elementBase = elementBase;
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  state.materials = [{ smpPath: "Parts/Solid", lawId, values: {} }];
  return state;
}

test("every structural formulation names its blocks, and nothing else does", () => {
  const field = structural.decl.sections.flatMap((s) => s.fields).find((f) => f.id === "elementBase")!;
  const table = (structural.decl.meshNaming!.elements as FormulationMeshNaming).names;
  const options = (field.options ?? []).map((o) => o.value);
  for (const value of options) assert.ok(table[value] !== undefined, `formulation "${value}" has no names entry`);
  // An entry no option can select would be dead data (a removed formulation).
  for (const value of Object.keys(table)) assert.ok(options.includes(value), `names entry "${value}" is not a formulation`);
});

test("structural families map their shapes to the exact Kratos names", () => {
  const shapes = (elementBase: string, dim: 2 | 3) =>
    resolveMeshNaming(structural.decl, { elementBase }, dim).elements?.shapes;
  // Solids keep the full registration list.
  assert.equal(shapes("TotalLagrangianElement", 3)?.["3D27N"], "TotalLagrangianElement3D27N");
  assert.equal(shapes("TotalLagrangianElement", 3)?.["3D2N"], undefined);
  assert.equal(shapes("SmallDisplacementBbarElement", 3)?.["3D8N"], "SmallDisplacementBbarElement3D8N");
  assert.equal(shapes("SmallDisplacementBbarElement", 2)?.["2D3N"], undefined);
  assert.equal(shapes("SolidShellElementSprism", 3)?.["3D6N"], "SolidShellElementSprism3D6N");
  // Axisymmetric elements exist for 2D shapes only.
  assert.equal(shapes("AxisymUpdatedLagrangianElement", 2)?.["2D3N"], "AxisymUpdatedLagrangianElement2D3N");
  assert.equal(shapes("AxisymUpdatedLagrangianElement", 3)?.["3D4N"], undefined);
  // Beams, trusses and cables.
  assert.equal(shapes("CrBeamElement", 3)?.["3D2N"], "CrBeamElement3D2N");
  assert.equal(shapes("CrBeamElement", 2)?.["2D2N"], "CrBeamElement2D2N");
  assert.equal(shapes("LinearTimoshenkoBeamElement", 2)?.["2D3N"], "LinearTimoshenkoBeamElement2D3N");
  assert.equal(shapes("LinearTrussElement", 3)?.["3D3N"], "LinearTrussElement3D3N");
  // The legacy truss and the cable register a single 3D2N element, which Kratos
  // also accepts in a 2D mesh — the exact name is what both dimensions get.
  assert.equal(shapes("TrussElement", 2)?.["2D2N"], "TrussElement3D2N");
  assert.equal(shapes("TrussLinearElement", 3)?.["3D2N"], "TrussLinearElement3D2N");
  assert.equal(shapes("CableElement", 2)?.["2D2N"], "CableElement3D2N");
  // Shells and the membrane.
  assert.equal(shapes("ShellThickElementCorotational", 3)?.["3D4N"], "ShellThickElementCorotational3D4N");
  assert.equal(shapes("MITCThickShellElement", 3)?.["3D4N"], "MITCThickShellElement3D4N");
  assert.equal(shapes("ShellThinElement", 3)?.["3D4N"], undefined);
  assert.equal(shapes("MembraneElement", 2)?.["2D2N"], "MembraneElement2D2N");
  // Discrete elements, whose names are dimension-only or 1N.
  assert.equal(shapes("SpringDamperElement", 3)?.["3D2N"], "SpringDamperElement3D");
  assert.equal(shapes("SpringDamperElement", 3)?.["3D3N"], undefined);
  assert.equal(shapes("BushingElement", 2)?.["2D2N"], undefined);
  assert.equal(shapes("LineMassElement", 3)?.["3D2N"], "LineMassElement3D2N");
  assert.equal(shapes("SurfaceMassElement", 3)?.["3D4N"], "SurfaceMassElement3D4N");
  assert.equal(shapes("NodalConcentratedElement", 3)?.["3D1N"], "NodalConcentratedElement3D1N");
});

test("a beam case renames its line blocks and switches the rotation dofs", async () => {
  const model = parseMdpa(BAR_3D);
  const state = barState("CrBeamElement", "beam_3d");
  const out = await generateCase(structural, model, state, "bar");
  assert.deepEqual(out.warnings, []);
  const settings = JSON.parse(out.projectParameters).solver_settings;
  assert.equal(settings.rotation_dofs, true);
  const adapted = adaptMeshNames(model, resolveMeshNaming(structural.decl, state.values.problem, 3), 3);
  assert.deepEqual(adapted.problems, []);
  assert.deepEqual(adapted.renames, [{ kind: "Elements", from: "Element3D2N", to: "CrBeamElement3D2N" }]);
  // The beam law writes the section properties Kratos reads off the material.
  const props = JSON.parse(out.materials).properties[0].Material;
  assert.equal(props.constitutive_law.name, "BeamConstitutiveLaw");
  assert.equal(props.Variables.CROSS_AREA, 1);
  assert.equal(props.Variables.I33, 1);
});

test("a point-mass formulation lifts the one-node guard for its 1N shape", () => {
  const model = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
End Nodes

Begin Elements PointMass
1 0 1
End Elements
`);
  const naming = resolveMeshNaming(structural.decl, { elementBase: "NodalConcentratedElement" }, 3);
  const out = adaptMeshNames(model, naming, 3);
  assert.deepEqual(out.renames, [{ kind: "Elements", from: "PointMass", to: "NodalConcentratedElement3D1N" }]);
  assert.deepEqual(out.warnings, []);
});

test("a law the setup excludes and a law of the wrong dimension both refuse generate", async () => {
  const model = parseMdpa(BAR_3D);
  // A beam calls a beam law; a solid law would compute something else entirely.
  await assert.rejects(
    generateCase(structural, model, barState("CrBeamElement", "linear_elastic_3d"), "bar"),
    /LinearElastic3DLaw" is not available for the current setup/
  );
  // The 2D beam law means nothing on a 3D mesh.
  await assert.rejects(
    generateCase(structural, model, barState("CrBeamElement", "beam_2d"), "bar"),
    /BeamConstitutiveLaw" is written for a 2D mesh, but this case is 3D/
  );
});

test("coupled structural laws and domains carry the prefixed field rules", () => {
  const law = fsi.decl.materialLaws.find((l) => l.id === "linear_elastic_3d")!;
  assert.deepEqual((law.when as VisibleRule).field, "s_elementBase");
  const naming = fsi.decl.domains!.find((d) => d.id === "structure")!.meshNaming!.elements as FormulationMeshNaming;
  assert.equal(naming.field, "s_elementBase");
  const table = (structural.decl.meshNaming!.elements as FormulationMeshNaming).names;
  assert.deepEqual(naming.names, table);
});
