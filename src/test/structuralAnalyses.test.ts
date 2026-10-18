import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { findSubModelPart } from "../parser/subModelPartExtract";
import { generateCase } from "../problemtype/generate";
import { planCaseMesh } from "../problemtype/caseMesh";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import type { CaseState, JsonValue } from "../problemtype/types";

const TET = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

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
End SubModelPart
`;

function stateFor(
  problem: Record<string, JsonValue>,
  loads: CaseState["assignments"] = [],
  lawId = "linear_elastic_3d"
): CaseState {
  const state = defaultCaseState(structural.decl);
  Object.assign(state.values.problem, problem);
  state.assignments = [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }, ...loads];
  state.materials = [{ smpPath: "Parts/Solid", lawId, values: {} }];
  return state;
}

const pointLoad = { conditionId: "pointLoad", smpPath: "Support", values: { modulus: 100, direction: [0, 0, -1] } };
const imaginaryLoad = { conditionId: "imaginaryPointLoad", smpPath: "Support", values: { modulus: 50, direction: [1, 0, 0] } };

test("explicit dynamics switches the integration method and the scheme", async () => {
  const out = await generateCase(
    structural,
    parseMdpa(TET),
    stateFor({ solverType: "dynamic", timeIntegration: "explicit", explicitScheme: "central_differences" }),
    "m"
  );
  const settings = JSON.parse(out.projectParameters).solver_settings;
  assert.equal(settings.solver_type, "Dynamic");
  assert.equal(settings.time_integration_method, "explicit");
  assert.equal(settings.scheme_type, "central_differences");
  const implicit = await generateCase(structural, parseMdpa(TET), stateFor({ solverType: "dynamic" }), "m");
  const implicitSettings = JSON.parse(implicit.projectParameters).solver_settings;
  assert.equal(implicitSettings.time_integration_method, "implicit");
  assert.equal(implicitSettings.scheme_type, "bossak");
});

test("the eigensolver, modal decomposition and mass normalization are configurable", async () => {
  const eigen = { solverType: "eigen_value", eigenSolver: "spectra_sym_g_eigs_shift", eigenModalDecomposition: true, eigenNormalizeEigenvectors: true, eigenCount: 3 };
  const out = await generateCase(structural, parseMdpa(TET), stateFor(eigen), "m");
  const settings = JSON.parse(out.projectParameters).solver_settings;
  assert.equal(settings.solver_type, "eigen_value");
  assert.equal(settings.eigensolver_settings.solver_type, "spectra_sym_g_eigs_shift");
  assert.equal(settings.eigensolver_settings.number_of_eigenvalues, 3);
  assert.equal(settings.compute_modal_decomposition, true);
  assert.equal(settings.normalize_eigenvectors_with_mass_matrix, true);
  assert.ok(out.applications.includes("LinearSolversApplication"));
  assert.ok(out.mainScript.includes("LinearSolversApplication"));
  const plain = await generateCase(structural, parseMdpa(TET), stateFor({ solverType: "static" }), "m");
  assert.ok(!plain.applications.includes("LinearSolversApplication"));
});

test("harmonic modal superposes the eigenmodes for the regular loads", async () => {
  const out = await generateCase(
    structural,
    parseMdpa(TET),
    stateFor({ solverType: "harmonic_analysis", harmonicType: "modal" }, [pointLoad]),
    "m"
  );
  const settings = JSON.parse(out.projectParameters).solver_settings;
  assert.equal(settings.solver_type, "harmonic_analysis");
  assert.equal(settings.harmonic_analysis_type, "modal");
  assert.deepEqual(settings.modal_harmonic_analysis_settings, { use_effective_material_damping: false });
  assert.equal(settings.direct_harmonic_analysis_settings, undefined);
  // The point load still goes through its emitted sibling.
  const loads = JSON.parse(out.projectParameters).processes.loads_process_list;
  assert.equal(loads[0].Parameters.model_part_name, "Structure.SupportPointLoad");
});

test("harmonic direct lists the real and imaginary load parts and needs its solver", async () => {
  const out = await generateCase(
    structural,
    parseMdpa(TET),
    stateFor({ solverType: "harmonic_analysis", harmonicType: "direct" }, [pointLoad, imaginaryLoad]),
    "m"
  );
  const settings = JSON.parse(out.projectParameters).solver_settings;
  assert.equal(settings.harmonic_analysis_type, "direct");
  assert.deepEqual(settings.direct_harmonic_analysis_settings, {
    assemble_damping_matrix: false,
    real_load_sub_model_part_list: ["Structure.SupportPointLoad"],
    imaginary_load_sub_model_part_list: ["Structure.SupportImaginaryPointLoad"],
    complex_linear_solver_settings: { solver_type: "pardiso_lu_complex" },
  });
  assert.ok(out.applications.includes("LinearSolversApplication"));
  await assert.rejects(
    generateCase(structural, parseMdpa(TET), stateFor({ solverType: "harmonic_analysis", harmonicType: "direct" }), "m"),
    /assembles its real load from point loads/
  );
});

test("imaginary point loads emit their own sibling", () => {
  const plan = planCaseMesh(
    structural,
    parseMdpa(TET),
    stateFor({ solverType: "harmonic_analysis", harmonicType: "direct" }, [imaginaryLoad]),
    "m",
    true
  );
  assert.ok(findSubModelPart(plan.caseModel, "SupportImaginaryPointLoad"));
  assert.ok(plan.caseModel.blocks.some((b) => b.name === "ImaginaryPointLoadCondition3D1N" && b.count === 3));
});
