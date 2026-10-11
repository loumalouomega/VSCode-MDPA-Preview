/**
 * Built-in Structural Mechanics problemtype. Output shapes mirror what
 * GiDInterface's Structural app writes (apps/Structural/write/writeProjectParameters.tcl):
 * solution types Static / Dynamic / eigen_value, the Newmark and Bossak
 * schemes, the nonlinear-iteration parameters of apps/Structural/xml/Strategies.xml
 * and the nodal conditions / loads of NodalConditions.xml and Conditions.xml.
 *
 * Keys that equal Kratos' own default are only written when they matter (the
 * nonlinear parameters only for a non-linear analysis, the linear solver only
 * when one is chosen), so a plain linear case still produces the same lean
 * document it always did.
 */

import { defineProblemtype, asNum, asStr, asBool } from "../api";
import { STRUCTURAL_MAIN_KRATOS_PY } from "../mainKratosTemplate";
import { JsonObject, JsonValue } from "../types";
import {
  INITIAL,
  broadcastConstrained,
  linearSolverFields,
  linearSolverSettings,
  scalarConstraint,
  scalarOnConditions,
  vectorByDirection,
  vectorConstraint,
  vectorLoadOnConditions,
} from "./common";

/**
 * Element formulations whose Kratos block name is `${base}${dim}D${nodes}N`
 * (GiD's Elements.xml KratosName table), which is what `meshNaming` can express,
 * with the DOF flags each one switches on in `solver_settings`. Shells, the
 * membrane and the cable are not offered: their Kratos names differ between
 * triangles and quadrilaterals (or ignore the dimension), which one base name
 * cannot describe.
 */
const FORMULATIONS: { value: string; label: string; rotation?: boolean; strain?: boolean; volumetricStrain?: boolean }[] = [
  { value: "SmallDisplacementElement", label: "Solid small displacements" },
  { value: "SmallDisplacementBbarElement", label: "Solid small displacements B-bar" },
  { value: "SmallDisplacementMixedVolumetricStrainElement", label: "Solid small displacements mixed u-εvol", volumetricStrain: true },
  { value: "SmallDisplacementMixedStrainElement", label: "Solid small displacements mixed u-ε", strain: true },
  { value: "TotalLagrangianElement", label: "Solid total Lagrangian" },
  { value: "UpdatedLagrangianElement", label: "Solid updated Lagrangian" },
  { value: "LinearTimoshenkoBeamElement", label: "Beam small displacements", rotation: true },
  { value: "CrBeamElement", label: "Beam large displacements (corotational)", rotation: true },
  { value: "LinearTrussElement", label: "Truss small displacements" },
  { value: "TotalLagrangianTrussElement", label: "Truss large displacements" },
];

const NONLINEAR = { field: "analysisType", equals: "non_linear" };
const DYNAMIC = { field: "solverType", equals: "dynamic" };
const EIGEN = { field: "solverType", equals: "eigen_value" };
const NOT_EIGEN = { field: "solverType", oneOf: ["static", "dynamic"] as JsonValue[] };
const RESIDUAL = { field: "convergenceCriterion", oneOf: ["residual_criterion", "and_criterion", "or_criterion"] as JsonValue[] };
const DISPLACEMENT = { field: "convergenceCriterion", oneOf: ["displacement_criterion", "and_criterion", "or_criterion"] as JsonValue[] };

const ELASTIC = [
  { id: "DENSITY", label: "Density [kg/m³]", type: "number" as const, default: 7850, unit: "kg/m³" },
  { id: "YOUNG_MODULUS", label: "Young modulus [Pa]", type: "number" as const, default: 2.1e11, unit: "Pa" },
  { id: "POISSON_RATIO", label: "Poisson ratio", type: "number" as const, default: 0.29 },
];
const THICKNESS = { id: "THICKNESS", label: "Thickness [m]", type: "number" as const, default: 1.0, unit: "m" };

export const structural = defineProblemtype(
  {
    id: "structural",
    name: "Structural Mechanics",
    description: "Static / dynamic / eigenvalue solid, beam and truss mechanics (StructuralMechanicsApplication)",
    icon: "ptStructural",
    family: "solid",
    analysisStage:
      "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis",
    modelPartName: "Structure",
    materialsFileName: "StructuralMaterials.json",
    domainSizes: [2, 3],
    sections: [
      {
        id: "problem",
        label: "Problem data",
        groups: [
          { id: "analysis", label: "Analysis", icon: "ptSolver" },
          { id: "time", label: "Time", icon: "ptTime" },
          { id: "nonlinear", label: "Non-linear iteration", icon: "ptSolver" },
          { id: "dynamic", label: "Dynamic damping", icon: "ptTime" },
          { id: "eigen", label: "Eigenvalue solver", icon: "ptSolver" },
          { id: "linear", label: "Linear solver", icon: "ptSolver", collapsed: true },
        ],
        fields: [
          {
            id: "solverType",
            label: "Analysis",
            type: "enum",
            default: "static",
            group: "analysis",
            options: [
              { value: "static", label: "Static" },
              { value: "dynamic", label: "Dynamic" },
              { value: "eigen_value", label: "Eigenvalues" },
            ],
          },
          {
            id: "analysisType",
            label: "Linearity",
            type: "enum",
            default: "linear",
            group: "analysis",
            visibleWhen: NOT_EIGEN,
            options: [
              { value: "linear", label: "Linear" },
              { value: "non_linear", label: "Non-linear" },
            ],
          },
          {
            // Feeds meshNaming: the mdpa elements are renamed to this base
            // (structural has no solver-side element replacement).
            id: "elementBase",
            label: "Element formulation",
            type: "enum",
            default: "SmallDisplacementElement",
            group: "analysis",
            options: FORMULATIONS.map(({ value, label }) => ({ value, label })),
          },
          {
            id: "schemeType",
            label: "Scheme",
            type: "enum",
            default: "bossak",
            group: "analysis",
            visibleWhen: DYNAMIC,
            options: [
              { value: "newmark", label: "Newmark" },
              { value: "bossak", label: "Bossak" },
            ],
            help: "Bossak damps high-frequency accelerations; Newmark does not.",
          },
          { id: "startTime", label: "Start time", type: "number", default: 0, group: "time", unit: "s" },
          { id: "timeStep", label: "Time step", type: "number", default: 0.1, group: "time", min: 0, unit: "s" },
          { id: "endTime", label: "End time", type: "number", default: 1.0, group: "time", unit: "s" },
          {
            id: "convergenceCriterion",
            label: "Convergence criterion",
            type: "enum",
            default: "residual_criterion",
            group: "nonlinear",
            visibleWhen: [NONLINEAR, NOT_EIGEN],
            options: [
              { value: "residual_criterion", label: "Residual" },
              { value: "displacement_criterion", label: "Displacement" },
              { value: "and_criterion", label: "Residual and displacement" },
              { value: "or_criterion", label: "Residual or displacement" },
            ],
          },
          { id: "residualRelTol", label: "Residual rel. tol.", type: "number", default: 1e-4, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, RESIDUAL] },
          { id: "residualAbsTol", label: "Residual abs. tol.", type: "number", default: 1e-9, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, RESIDUAL] },
          { id: "displacementRelTol", label: "Displacement rel. tol.", type: "number", default: 1e-4, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, DISPLACEMENT] },
          { id: "displacementAbsTol", label: "Displacement abs. tol.", type: "number", default: 1e-9, min: 0, group: "nonlinear", visibleWhen: [NONLINEAR, DISPLACEMENT] },
          { id: "maxIteration", label: "Max iterations", type: "int", default: 10, min: 1, group: "nonlinear", visibleWhen: NONLINEAR },
          { id: "lineSearch", label: "Line search", type: "bool", default: false, group: "nonlinear", visibleWhen: NONLINEAR },
          { id: "useOldStiffness", label: "Use old stiffness in first iteration", type: "bool", default: false, group: "nonlinear", visibleWhen: NONLINEAR },
          { id: "rayleighAlpha", label: "Rayleigh α (mass)", type: "number", default: 0, min: 0, group: "dynamic", visibleWhen: DYNAMIC },
          { id: "rayleighBeta", label: "Rayleigh β (stiffness)", type: "number", default: 0, min: 0, group: "dynamic", visibleWhen: DYNAMIC },
          { id: "eigenCount", label: "Number of eigenvalues", type: "int", default: 5, min: 1, group: "eigen", visibleWhen: EIGEN },
          { id: "eigenMaxIteration", label: "Max iterations", type: "int", default: 1000, min: 1, group: "eigen", visibleWhen: EIGEN },
          { id: "eigenTolerance", label: "Tolerance", type: "number", default: 1e-6, min: 0, group: "eigen", visibleWhen: EIGEN },
          ...linearSolverFields("linear").map((f) => ({ ...f, visibleWhen: f.visibleWhen ? [NOT_EIGEN, f.visibleWhen as never] : NOT_EIGEN })),
          { id: "echoLevel", label: "Echo level", type: "int", default: 1, min: 0, max: 3, advanced: true },
        ],
      },
    ],
    partsCondition: "parts",
    meshNaming: {
      elements: "$field:elementBase",
      conditions: { 2: "LineLoadCondition", 3: "SurfaceLoadCondition" },
    },
    conditions: [
      {
        id: "parts",
        label: "Body / Parts",
        list: "list_other_processes",
        target: "volume",
        fields: [],
        processTemplate: {},
        help: "Marks a SubModelPart as computing domain; assign a material to it.",
      },
      vectorConstraint("DISPLACEMENT", { id: "displacement", label: "Displacement", unit: "m", icon: "ptConstraint" }),
      vectorConstraint("ROTATION", {
        id: "rotation",
        label: "Rotation",
        unit: "rad",
        icon: "ptConstraint",
        help: "Rotational DOFs: beam elements.",
      }),
      scalarConstraint("PRESSURE", {
        id: "pressure",
        label: "Pressure",
        unit: "Pa",
        icon: "ptConstraint",
        help: "Nodal pressure for mixed (u-p) formulations.",
      }),
      scalarConstraint("VOLUMETRIC_STRAIN", {
        id: "volumetricStrain",
        label: "Volumetric strain",
        icon: "ptConstraint",
        help: "For the mixed u-εvol formulation.",
      }),
      vectorConstraint("VELOCITY", {
        id: "initialVelocity",
        label: "Initial velocity",
        unit: "m/s",
        category: "initial",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
        help: "Dynamic analysis: velocity at the first step only.",
      }),
      vectorConstraint("ACCELERATION", {
        id: "initialAcceleration",
        label: "Initial acceleration",
        unit: "m/s²",
        category: "initial",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
        help: "Dynamic analysis: acceleration at the first step only.",
      }),
      vectorConstraint("ANGULAR_VELOCITY", {
        id: "angularVelocity",
        label: "Angular velocity",
        unit: "rad/s",
        category: "initial",
        icon: "ptInitial",
        interval: INITIAL,
        fixed: false,
      }),
      vectorByDirection("VOLUME_ACCELERATION", {
        id: "selfWeight",
        label: "Self weight",
        unit: "m/s²",
        dflt: 9.81,
        icon: "ptGravity",
      }),
      vectorLoadOnConditions("POINT_LOAD", {
        id: "pointLoad",
        label: "Point load",
        unit: "N",
        target: "nodes",
        icon: "ptLoad",
      }),
      vectorLoadOnConditions("POINT_MOMENT", {
        id: "pointMoment",
        label: "Point moment",
        unit: "N·m",
        target: "nodes",
        icon: "ptLoad",
        help: "3D only.",
      }),
      vectorLoadOnConditions("LINE_LOAD", {
        id: "lineLoad",
        label: "Line load",
        unit: "N/m",
        target: "surface",
        icon: "ptLoad",
      }),
      vectorLoadOnConditions("SURFACE_LOAD", {
        id: "surfaceLoad",
        label: "Surface load",
        unit: "N/m²",
        target: "surface",
        icon: "ptLoad",
        help: "3D only.",
      }),
      scalarOnConditions("POSITIVE_FACE_PRESSURE", {
        id: "surfacePressure",
        label: "Surface pressure",
        unit: "Pa",
        icon: "ptLoad",
        help: "Pressure on boundary faces (3D) or lines (2D).",
      }),
    ],
    materialLaws: [
      { id: "linear_elastic_3d", name: "LinearElastic3DLaw", domainSize: 3, variables: ELASTIC },
      {
        id: "linear_elastic_plane_strain",
        name: "LinearElasticPlaneStrain2DLaw",
        domainSize: 2,
        variables: [...ELASTIC, THICKNESS],
      },
      {
        id: "linear_elastic_plane_stress",
        name: "LinearElasticPlaneStress2DLaw",
        domainSize: 2,
        variables: [...ELASTIC, THICKNESS],
      },
    ],
    output: { nodalDefaults: ["DISPLACEMENT", "REACTION"], gaussDefaults: ["VON_MISES_STRESS"] },
  },
  {
    mainScript: () => STRUCTURAL_MAIN_KRATOS_PY,
    solverSettings: (v, ctx) => {
      const type = asStr(v.solverType, "static");
      const dynamic = type === "dynamic";
      const eigen = type === "eigen_value";
      const form = FORMULATIONS.find((f) => f.value === v.elementBase);
      const settings: JsonObject = {
        solver_type: eigen ? "eigen_value" : dynamic ? "Dynamic" : "Static",
        model_part_name: ctx.modelPartName,
        domain_size: ctx.domainSize,
        echo_level: asNum(v.echoLevel, 1),
        model_import_settings: { input_type: "mdpa", input_filename: ctx.mdpaStem },
        material_import_settings: { materials_filename: ctx.materialsFileName },
        time_stepping: { time_step: asNum(v.timeStep, 0.1) },
        rotation_dofs: form?.rotation === true,
      };
      if (form?.strain) settings.strain_dofs = true;
      if (form?.volumetricStrain) settings.volumetric_strain_dofs = true;
      if (eigen) {
        settings.eigensolver_settings = {
          solver_type: "eigen_eigensystem",
          max_iteration: asNum(v.eigenMaxIteration, 1000),
          tolerance: asNum(v.eigenTolerance, 1e-6),
          number_of_eigenvalues: asNum(v.eigenCount, 5),
          echo_level: 1,
        };
        settings.builder_and_solver_settings = { use_block_builder: false };
        return settings;
      }
      const nonLinear = asStr(v.analysisType, "linear") === "non_linear";
      settings.analysis_type = nonLinear ? "non_linear" : "linear";
      if (dynamic) {
        settings.time_integration_method = "implicit";
        settings.scheme_type = asStr(v.schemeType, "bossak");
        settings.rayleigh_alpha = asNum(v.rayleighAlpha, 0);
        settings.rayleigh_beta = asNum(v.rayleighBeta, 0);
      }
      if (nonLinear) {
        const criterion = asStr(v.convergenceCriterion, "residual_criterion");
        settings.convergence_criterion = criterion;
        if (criterion !== "displacement_criterion") {
          settings.residual_relative_tolerance = asNum(v.residualRelTol, 1e-4);
          settings.residual_absolute_tolerance = asNum(v.residualAbsTol, 1e-9);
        }
        if (criterion !== "residual_criterion") {
          settings.displacement_relative_tolerance = asNum(v.displacementRelTol, 1e-4);
          settings.displacement_absolute_tolerance = asNum(v.displacementAbsTol, 1e-9);
        }
        settings.max_iteration = asNum(v.maxIteration, 10);
        settings.line_search = asBool(v.lineSearch, false);
        settings.use_old_stiffness_in_first_iteration = asBool(v.useOldStiffness, false);
      }
      const linear = linearSolverSettings(v);
      if (linear) settings.linear_solver_settings = linear;
      return settings;
    },
    postProcess: (pp, ctx) => {
      if (ctx.values.solverType !== "eigen_value") return pp;
      // GiD drops the regular output for an eigenvalue run and instead
      // post-processes the modes (the .post.res frequencies are what it plots).
      delete pp.output_processes;
      const processes = pp.processes as JsonObject;
      (processes.list_other_processes as JsonValue[]).push({
        python_module: "postprocess_eigenvalues_process",
        kratos_module: "KratosMultiphysics.StructuralMechanicsApplication",
        help: "This process postprocces the eigen values for GiD",
        process_name: "PostProcessEigenvaluesProcess",
        Parameters: {
          result_file_name: ctx.mdpaStem,
          animation_steps: 20,
          file_format: "gid",
          label_type: "frequency",
        },
      });
      return pp;
    },
    // Every Assign*VariableProcess on nodes needs the per-component broadcast
    // of its single "Fixed" checkbox; everything else uses its template.
    buildProcess: (cond, a, ctx) => broadcastConstrained(cond, a, ctx),
  }
);
