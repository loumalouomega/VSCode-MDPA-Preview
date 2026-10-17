import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { generateCase } from "../problemtype/generate";
import { defaultCaseState } from "../problemtype/api";
import { loadPyProblemtypes } from "../problemtype/pyRuntime";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { Assignment, MaterialAssignment, ProblemtypeRuntime } from "../problemtype/types";

let pyodideAvailable = true;
try {
  require.resolve("pyodide");
} catch {
  pyodideAvailable = false;
}

// out/test/ → repo root.
const EXAMPLES_DIR = path.join(__dirname, "..", "..", "example", "problemtypes");

const MDPA = `Begin Nodes
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

Begin SubModelPart Loaded
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart
`;

// Two 2-node beam elements sharing node 2: the mesh a beam formulation can
// actually be adapted to (a tetrahedron mesh would be refused for it).
const BEAM_MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 2.0 0.0 0.0
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

Begin SubModelPart Loaded
  Begin SubModelPartNodes
  3
  End SubModelPartNodes
End SubModelPart
`;

// Two tetrahedra (fluid above, solid below) sharing the interface triangle,
// one interface face per side, an inlet node and a second pair for two-pair cases.
const COUPLED_MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
5 0.0 0.0 0.0
6 1.0 0.0 0.0
7 0.0 1.0 0.0
8 0.0 0.0 -1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
2 0 5 6 7 8
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
2 0 5 6 7
End Conditions
${["Fluid:1,2,3,4:1:", "Solid:5,6,7,8:2:", "FluidWall:1,2,3::1", "SolidWall:5,6,7::2", "FluidWall2:1,2,3::1", "SolidWall2:5,6,7::2", "Inlet:4::"]
  .map((spec) => {
    const [name, nodes, elements, conditions] = spec.split(":");
    const list = (kind: string, ids: string) =>
      ids ? `  Begin SubModelPart${kind}\n${ids.split(",").map((i) => `  ${i}`).join("\n")}\n  End SubModelPart${kind}\n` : "";
    return `\nBegin SubModelPart ${name}\n${list("Nodes", nodes)}${list("Elements", elements)}${list("Conditions", conditions)}End SubModelPart\n`;
  })
  .join("")}`;

const COUPLED_ASSIGNMENTS: Assignment[] = [
  { conditionId: "f_parts", smpPath: "Fluid", values: {} },
  { conditionId: "f_inlet", smpPath: "Inlet", values: { modulus: 2, direction: "x" } },
  { conditionId: "f_noSlip", smpPath: "FluidWall", values: {} },
  { conditionId: "fluidInterface", smpPath: "FluidWall", values: {} },
  { conditionId: "s_parts", smpPath: "Solid", values: {} },
  { conditionId: "s_displacement", smpPath: "SolidWall", values: { value: [0, 0, 0], constrained: true } },
  { conditionId: "structureInterface", smpPath: "SolidWall", values: {} },
];
const COUPLED_MATERIALS: MaterialAssignment[] = [
  { smpPath: "Fluid", lawId: "newtonian_3d", values: {} },
  { smpPath: "Solid", lawId: "linear_elastic_3d", values: {} },
];

interface ExampleCase {
  /** Distinguishes several cases that exercise different hook paths of one port. */
  label?: string;
  /** The mesh the case is generated on (the single-tetrahedron one when absent). */
  mdpa?: string;
  file: string;
  builtinId: string;
  assignments: Assignment[];
  materials: MaterialAssignment[];
  /** Extra per-section value overrides to exercise hooks (e.g. dynamic scheme). */
  values?: Record<string, Record<string, unknown>>;
}

// Assignments deliberately exercise each port's hook paths: structural's
// build_process broadcast, fluid's volume/skin derivation.
const CASES: ExampleCase[] = [
  {
    file: "structural.py",
    builtinId: "structural",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0.001], constrained: true } },
      { conditionId: "selfWeight", smpPath: "Parts/Solid", values: {} },
      { conditionId: "surfacePressure", smpPath: "Loaded", values: { value: 1000 } },
      { conditionId: "pointLoad", smpPath: "Support", values: { modulus: 100, direction: [0, 0, -1] } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} }],
    values: { problem: { solverType: "dynamic" } },
  },
  {
    label: "non-linear dynamic, newmark, cg solver, nodal vector conditions",
    file: "structural.py",
    builtinId: "structural",
    mdpa: BEAM_MDPA,
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "rotation", smpPath: "Support", values: { value: [0, 0, 0.1], constrained: true } },
      { conditionId: "initialVelocity", smpPath: "Loaded", values: { value: [1, 0, 0], constrained: false } },
      { conditionId: "lineLoad", smpPath: "Support", values: { modulus: 5, direction: [0, 1, 0] } },
      { conditionId: "movingLoad", smpPath: "Parts/Solid", values: { modulus: 5, direction: [0, 1, 0], velocity: 2, motionDirection: [1, 0, 0] } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "beam_2d", values: {} }],
    values: {
      problem: {
        solverType: "dynamic",
        schemeType: "newmark",
        analysisType: "non_linear",
        convergenceCriterion: "and_criterion",
        linearSolver: "cg",
        elementBase: "CrBeamElement",
      },
    },
  },
  {
    label: "eigenvalues",
    file: "structural.py",
    builtinId: "structural",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "displacement", smpPath: "Support", values: {} },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} }],
    values: { problem: { solverType: "eigen_value", elementBase: "SmallDisplacementMixedStrainElement" } },
  },
  {
    label: "static, isotropic plasticity factory law",
    file: "structural.py",
    builtinId: "structural",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
      { conditionId: "surfacePressure", smpPath: "Loaded", values: { value: 1000 } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "plasticity_iso_3d", values: { YIELD_STRESS: 2.5e8 } }],
  },
  {
    label: "explicit dynamic, central differences",
    file: "structural.py",
    builtinId: "structural",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "initialVelocity", smpPath: "Parts/Solid", values: { value: [1, 0, 0] } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} }],
    values: { problem: { solverType: "dynamic", timeIntegration: "explicit", explicitScheme: "central_differences" } },
  },
  {
    label: "harmonic modal, point load",
    file: "structural.py",
    builtinId: "structural",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
      { conditionId: "pointLoad", smpPath: "Support", values: { modulus: 100, direction: [0, 0, -1] } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: {} }],
    values: { problem: { solverType: "harmonic_analysis", harmonicType: "modal" } },
  },
  {
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "inlet", smpPath: "Loaded", values: { modulus: 2.5 } },
      { conditionId: "outlet", smpPath: "Support", values: {} },
      { conditionId: "noSlip", smpPath: "Support", values: {} },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
  },
  {
    label: "fractional step, wall law, custom constraints, gravity",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "initialVelocity", smpPath: "Parts/Solid", values: { value: [1, 0, 0] } },
      { conditionId: "inlet", smpPath: "Loaded", values: { modulus: 2.5, direction: "y" } },
      { conditionId: "outlet", smpPath: "Support", values: { hydrostatic: true, hTop: 1.5 } },
      { conditionId: "wallLaw", smpPath: "Support", values: { wallModel: "linear_log" } },
      { conditionId: "velocityConstraints", smpPath: "Loaded", values: { value: [0, 1, 0], constrained: true } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
    values: {
      problem: { strategy: "fractional_step", predictorCorrector: true, gravityValue: 9.81, linearSolver: "cg" },
    },
  },
  {
    label: "monolithic FIC with adaptive time step",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
    values: { problem: { elementType: "fic", timeScheme: "bossak", timeStepMode: "adaptive", oss: true } },
  },
  {
    label: "integration-point statistics and temperature-dependent viscosity",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "initialTemperature", smpPath: "Parts/Solid", values: { value: 350 } },
      { conditionId: "integrationStats", smpPath: "Parts/Solid", values: { statisticType: "average", variable: "VELOCITY" } },
      { conditionId: "integrationStats", smpPath: "Parts/Solid", values: { statisticType: "variance", variable: "PRESSURE" } },
      { conditionId: "integrationStats", smpPath: "Parts/Solid", values: { statisticType: "average", variable: "PRESSURE" } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "temperature_dependent_3d", values: { DENSITY: 997, TEMPERATURE_TABLE: "293.15,1e-3; 373.15,2.8e-4" } }],
  },
  {
    label: "two-phase inlet: symbolic modulus up to 10 s, then a steady inlet",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "inlet", smpPath: "Loaded", values: { modulusExpression: "0.5*(1-cos(0.1*pi*t))", intervalEnd: "10" } },
      { conditionId: "inlet", smpPath: "Support", values: { modulus: 2, intervalStart: 10, direction: "y" } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
  },
  {
    label: "weakly compressible with bossak, periodic pair, force and coefficient monitors, Bingham fluid",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "noSlip", smpPath: "Support", values: {} },
      { conditionId: "flowForces", smpPath: "Support", values: { referencePoint: [1, 0, 0], printToScreen: true } },
      { conditionId: "aerodynamicCoefficients", smpPath: "Support", values: { referenceArea: 2.5, referenceChord: 1.2, dynamicPressure: 600 } },
      { conditionId: "pressureCoefficient", smpPath: "Support", values: { freestreamDensity: 1.2, freestreamVelocity: 30 } },
      { conditionId: "yPlus", smpPath: "Support", values: {} },
      { conditionId: "periodic", smpPath: "Loaded", values: { master: "Support", translation: [0, 1, 0], magnitude: 2 } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "bingham_3d", values: {} }],
    values: { problem: { elementType: "weakly_compressible", soundVelocity: 340, timeScheme: "bossak", bossakAlpha: -0.2, considerPeriodic: true } },
  },
  {
    label: "legacy VMS non-Newtonian, FIC beta, time-integrated QSVMS options",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
    values: { problem: { elementType: "vms", nonNewtonian: true, powerLawK: 0.01, powerLawN: 0.8, yieldStress: 2, regularization: 50, timeScheme: "bossak" } },
  },
  {
    label: "Stokes monolithic steady, axisymmetric-style 2D keys, fractional step options",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
    values: { problem: { strategy: "stokes", forceSteadyState: true } },
  },
  {
    label: "fractional step with first-order time and no slip conditions",
    file: "fluid.py",
    builtinId: "fluid",
    assignments: [{ conditionId: "parts", smpPath: "Parts/Solid", values: {} }],
    materials: [{ smpPath: "Parts/Solid", lawId: "newtonian_3d", values: {} }],
    values: { problem: { strategy: "fractional_step", timeOrder: 1, useSlipConditions: false } },
  },
  {
    file: "convection_diffusion.py",
    builtinId: "convectionDiffusion",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "temperature", smpPath: "Support", values: { value: 350 } },
      { conditionId: "faceHeatFlux", smpPath: "Loaded", values: { value: 42 } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "thermal", values: {} }],
  },
  {
    label: "non-linear stationary with thermal face and initial temperature",
    file: "convection_diffusion.py",
    builtinId: "convectionDiffusion",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "initialTemperature", smpPath: "Parts/Solid", values: { value: 300 } },
      { conditionId: "thermalFace", smpPath: "Loaded", values: { addConvection: true, convectionCoefficient: 10 } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "thermal", values: {} }],
    values: {
      problem: { solverType: "stationary", analysisType: "non_linear", convergenceCriterion: "or_criterion", linearSolver: "bicgstab" },
    },
  },
  {
    file: "potential_flow.py",
    builtinId: "potentialFlow",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "farField", smpPath: "Loaded", values: { machInfinity: 0.5 } },
      { conditionId: "body2d", smpPath: "Support", values: {} },
    ],
    materials: [],
  },
  {
    file: "shallow_water.py",
    builtinId: "shallowWater",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "imposedFreeSurface", smpPath: "Support", values: { value: 2.0 } },
      { conditionId: "initialWaterLevel", smpPath: "Parts/Solid", values: { value: 1.0 } },
      { conditionId: "topography", smpPath: "Parts/Solid", values: { value: "0.05*x" } },
      { conditionId: "slip", smpPath: "Loaded", values: {} },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "manning", values: {} }],
  },
  {
    label: "boussinesq, adams-moulton, automatic time step, initial perturbation",
    file: "shallow_water.py",
    builtinId: "shallowWater",
    assignments: [
      { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
      { conditionId: "initialPerturbation", smpPath: "Parts/Solid", values: { maximumPerturbation: 0.5 } },
      { conditionId: "imposedVelocity", smpPath: "Support", values: { value: [1, 0, 0] } },
      { conditionId: "initialWaterLevel", smpPath: "Parts/Solid", values: { setMinimumHeight: true } },
    ],
    materials: [{ smpPath: "Parts/Solid", lawId: "manning", values: {} }],
    values: {
      problem: { solver: "boussinesq_solver", scheme: "Adams-Moulton", timeIntegrationOrder: 4, adaptiveStep: true, linearSolver: "cg" },
    },
  },
  {
    file: "coupled.py",
    builtinId: "fsi",
    mdpa: COUPLED_MDPA,
    assignments: [...COUPLED_ASSIGNMENTS, { conditionId: "aleMeshBC", smpPath: "Inlet", values: { constrained: true } }],
    materials: COUPLED_MATERIALS,
  },
  {
    label: "MVQN recursive, fractional step fluid, gravity, two interface pairs",
    file: "coupled.py",
    builtinId: "fsi",
    mdpa: COUPLED_MDPA,
    assignments: [
      ...COUPLED_ASSIGNMENTS,
      { conditionId: "fluidInterface", smpPath: "FluidWall2", values: { mapperFace: "positive" } },
      { conditionId: "structureInterface", smpPath: "SolidWall2", values: {} },
    ],
    materials: COUPLED_MATERIALS,
    values: {
      problem: { couplingStrategy: "MVQN_recursive", bufferSize: 5, meshSolver: "laplacian" },
      fluid: { f_strategy: "fractional_step", f_gravityValue: 9.81 },
      structure: { s_solverType: "dynamic", s_analysisType: "non_linear" },
    },
  },
  {
    file: "coupled.py",
    builtinId: "cosim",
    mdpa: COUPLED_MDPA,
    assignments: COUPLED_ASSIGNMENTS,
    materials: COUPLED_MATERIALS,
  },
  {
    label: "strong, Aitken, linear predictor, barycentric, ALE, two pairs",
    file: "coupled.py",
    builtinId: "cosim",
    mdpa: COUPLED_MDPA,
    assignments: [
      ...COUPLED_ASSIGNMENTS,
      { conditionId: "fluidInterface", smpPath: "FluidWall2", values: {} },
      { conditionId: "structureInterface", smpPath: "SolidWall2", values: {} },
      { conditionId: "aleMeshBC", smpPath: "Inlet", values: {} },
      { conditionId: "f_initialVelocity", smpPath: "Fluid", values: { value: [1, 0, 0] } },
      { conditionId: "s_selfWeight", smpPath: "Solid", values: {} },
    ],
    materials: COUPLED_MATERIALS,
    values: {
      coupling: {
        couplingType: "strong",
        accelerator: "aitken",
        aitkenInitAlpha: 0.2,
        predictor: "linear_derivative_based",
        mapperType: "barycentric",
        aleMesh: true,
        meshSolver: "laplacian",
      },
      fluid: { f_gravityValue: 9.81 },
    },
  },
];

/** JSON round-trip (normalizes prototypes + drops undefined optionals). */
const j = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

function stateFor(runtime: ProblemtypeRuntime, c: ExampleCase) {
  const state = defaultCaseState(runtime.decl);
  state.assignments = c.assignments as Assignment[];
  state.materials = c.materials;
  for (const [sectionId, overrides] of Object.entries(c.values ?? {})) {
    Object.assign(state.values[sectionId], overrides);
  }
  return state;
}

for (const c of CASES) {
  test(`example ${c.file}${c.label ? ` [${c.label}]` : ""} ≡ built-in ${c.builtinId}`, { skip: !pyodideAvailable }, async () => {
    const code = fs.readFileSync(path.join(EXAMPLES_DIR, c.file), "utf8");
    const runtimes = await loadPyProblemtypes(code, c.file);
    // A file may define several problemtypes (coupled.py defines fsi_py and cosim_py).
    const pyRt = runtimes.find((r) => r.decl.id === `${c.builtinId}_py`) ?? runtimes[0];
    const tsRt = BUILTIN_PROBLEMTYPES.find((b) => b.decl.id === c.builtinId);
    assert.ok(tsRt, `built-in ${c.builtinId} exists`);

    // Declarations match except for the identity fields.
    const normalized = {
      ...(j(pyRt.decl) as Record<string, unknown>),
      id: tsRt!.decl.id,
      name: tsRt!.decl.name,
    };
    assert.deepEqual(normalized, j(tsRt!.decl));

    // Generated case files are byte-identical.
    const model = parseMdpa(c.mdpa ?? MDPA);
    const pyOut = await generateCase(pyRt, model, stateFor(pyRt, c), "case");
    const tsOut = await generateCase(tsRt!, model, stateFor(tsRt!, c), "case");
    // Warnings must match too (e.g. shallow water's domain-size clamp on 3D);
    // they may embed the problemtype id, which legitimately differs (_py).
    assert.deepEqual(
      pyOut.warnings.map((w) => w.split(pyRt.decl.id).join(tsRt!.decl.id)),
      tsOut.warnings
    );
    assert.equal(pyOut.projectParameters, tsOut.projectParameters);
    assert.equal(pyOut.materials, tsOut.materials);
    assert.equal(pyOut.mainScript, tsOut.mainScript);
    assert.deepEqual(pyOut.applications, tsOut.applications);
    // Extra files too (the CoSimulation participant documents, the per-domain materials).
    assert.deepEqual(pyOut.extraFiles.map((f) => f.name), tsOut.extraFiles.map((f) => f.name));
    for (const [i, f] of tsOut.extraFiles.entries()) assert.equal(pyOut.extraFiles[i].content, f.content, f.name);
  });
}
