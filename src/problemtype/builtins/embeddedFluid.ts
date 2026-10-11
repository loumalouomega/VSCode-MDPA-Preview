/**
 * Built-in Embedded Fluid problemtype: the monolithic Navier-Stokes solver on a
 * non-conforming mesh, where the body is described by a nodal DISTANCE function
 * (FluidDynamicsApplication, `embedded_navier_stokes`). Mirrors GiDInterface's
 * EmbeddedFluid app (apps/EmbeddedFluid/write/writeProjectParameters.tcl).
 *
 * Derived from the Fluid built-in, not copied: its fields, conditions, laws and
 * hooks are reused, so a fix to the Fluid problemtype reaches this one. What it
 * adds is GiD's embedded formulation settings, the distance-reading settings,
 * the distance-modification and drag processes, and optional mesh adaptivity.
 *
 * Left out on purpose: GiD's import wizard that builds the distance field from
 * an imported STL. Here the DISTANCE field comes from the mesh itself — compute
 * it with the Variables panel (signed distance to a surface) or the
 * `sdfDistance` operation, save the mesh, and pick "from mdpa".
 *
 * Not solver-verified in this repository: the shape follows GiDInterface's writer.
 */

import { defineProblemtype, asBool, asNum, asStr } from "../api";
import type { JsonObject, ProblemtypeDeclaration } from "../types";
import { fluid } from "./fluid";
import { withoutRulesOn } from "./common";
import { monitoredMainScript } from "../mainKratosTemplate";

const BASE = fluid.decl;
const BASE_SECTION = BASE.sections[0];
const DROPPED = ["strategy", "elementType", "timeScheme", "oss", "predictorCorrector", "pressureTolerance",
  "maxPressureIterations", "velocityTolerance", "maxVelocityIterations"];
const MESH_ADAPTIVITY = { field: "meshAdaptivity", equals: true };
const DISTANCE_FILE = { field: "distanceMode", equals: "from_GiD_file" };
const DRAG = { field: "computeDrag", equals: true };

const decl: ProblemtypeDeclaration = {
  ...BASE,
  id: "embeddedFluid",
  name: "Embedded Fluid",
  description: "Monolithic Navier-Stokes on a non-conforming mesh with an embedded body given by a distance field (FluidDynamicsApplication)",
  icon: "ptEmbedded",
  family: "fluid",
  domainSizes: [3],
  sections: [
    {
      id: "problem",
      label: "Problem data",
      groups: [
        ...(BASE_SECTION.groups ?? []).filter((g) => g.id !== "gravity"),
        { id: "embedded", label: "Embedded body", icon: "ptEmbedded" },
        { id: "adaptivity", label: "Mesh adaptivity", icon: "ptSolver", collapsed: true },
      ],
      fields: [
        ...withoutRulesOn(
          BASE_SECTION.fields.filter((f) => !DROPPED.includes(f.id) && f.group !== "gravity" && !f.id.startsWith("gravity")),
          DROPPED
        ),
        { id: "timeOrder", label: "Time order", type: "int", default: 2, min: 1, max: 2, group: "formulation" },
        { id: "isSlip", label: "Slip embedded boundary", type: "bool", default: false, group: "embedded" },
        { id: "penaltyCoefficient", label: "Penalty coefficient", type: "number", default: 10.0, min: 0, group: "embedded", visibleWhen: { field: "isSlip", equals: true } },
        { id: "slipLength", label: "Slip length [m]", type: "number", default: 0.001, min: 0, group: "embedded", visibleWhen: { field: "isSlip", equals: true } },
        {
          id: "distanceMode",
          label: "Distance field",
          type: "enum",
          default: "from_mdpa",
          group: "embedded",
          options: [
            { value: "from_mdpa", label: "From the mesh (DISTANCE nodal field)" },
            { value: "from_GiD_file", label: "From a .post.res file" },
          ],
        },
        { id: "distanceFile", label: "Distance file", type: "string", default: "", group: "embedded", visibleWhen: DISTANCE_FILE },
        { id: "correctDistance", label: "Correct distance at each step", type: "bool", default: false, group: "embedded" },
        { id: "computeDrag", label: "Compute embedded drag", type: "bool", default: false, group: "embedded" },
        { id: "writeDragFile", label: "Write drag file", type: "bool", default: true, group: "embedded", visibleWhen: DRAG },
        { id: "printDrag", label: "Print drag to screen", type: "bool", default: false, group: "embedded", visibleWhen: DRAG },
        { id: "meshAdaptivity", label: "Mesh adaptivity", type: "bool", default: false, group: "adaptivity" },
        { id: "adaptInitialStep", label: "First remeshing step", type: "int", default: 1, min: 0, group: "adaptivity", visibleWhen: MESH_ADAPTIVITY },
        { id: "adaptStepFrequency", label: "Remeshing step frequency", type: "int", default: 0, min: 0, group: "adaptivity", visibleWhen: MESH_ADAPTIVITY, help: "0 remeshes once." },
        { id: "adaptInitialRemeshing", label: "Initial remeshing", type: "bool", default: false, group: "adaptivity", visibleWhen: MESH_ADAPTIVITY },
        { id: "anisotropicRatio", label: "Anisotropic ratio", type: "number", default: 0.01, min: 0, max: 1, group: "adaptivity", visibleWhen: MESH_ADAPTIVITY },
        { id: "boundaryLayerRatio", label: "BL minimum size ratio", type: "number", default: 2.0, min: 0, group: "adaptivity", visibleWhen: MESH_ADAPTIVITY },
      ],
    },
  ],
  // The embedded element comes from formulation.element_type; the mdpa carries generic names.
  conditions: BASE.conditions,
  output: { nodalDefaults: ["VELOCITY", "PRESSURE", "DISTANCE"] },
};

// The fluid defaults that GiD overrides for the embedded strategy.
for (const f of decl.sections[0].fields) {
  if (f.id === "dynamicTau") f.default = 0.01;
}

export const embeddedFluid = defineProblemtype(decl, {
  mainScript: () => monitoredMainScript("embeddedFluid"),
  buildProcess: (cond, a, ctx) => fluid.buildProcess(cond, a, ctx),
  solverSettings: async (v, ctx) => {
    // The Fluid hook reads the monolithic ids; the embedded declaration drops
    // the formulation choice, so feed it the one GiD fixes.
    const base = (await fluid.solverSettings(
      { ...v, strategy: "monolithic", elementType: "qsvms", timeScheme: "bdf2", oss: false, gravityValue: 0 },
      ctx
    )) as JsonObject;
    const settings: JsonObject = { ...base };
    settings.time_order = asNum(v.timeOrder, 2);
    if (asBool(v.computeDrag, false)) settings.compute_reactions = true;
    const formulation: JsonObject = {
      element_type: "embedded_navier_stokes",
      dynamic_tau: asNum(v.dynamicTau, 0.01),
      is_slip: asBool(v.isSlip, false),
      penalty_coefficient: asNum(v.penaltyCoefficient, 10),
    };
    if (formulation.is_slip) formulation.slip_length = asNum(v.slipLength, 0.001);
    settings.formulation = formulation;
    const reading: JsonObject = { import_mode: asStr(v.distanceMode, "from_mdpa") };
    if (reading.import_mode !== "from_mdpa") reading.distance_file_name = asStr(v.distanceFile, "");
    settings.distance_reading_settings = reading;
    return settings;
  },
  postProcess: (pp, ctx) => {
    const v = ctx.values;
    const part = ctx.partsModelParts[0] ?? ctx.modelPartName;
    const problemData = pp.problem_data as JsonObject;
    problemData.mesh_adaptivity = asBool(v.meshAdaptivity, false);
    const processes = pp.processes as JsonObject;
    processes.mesh_adaptivity_process_list = asBool(v.meshAdaptivity, false)
      ? [
          {
            python_module: "mmg_process",
            kratos_module: "KratosMultiphysics.MeshingApplication",
            process_name: "MmgProcess",
            Parameters: {
              model_part_name: ctx.modelPartName,
              initial_step: asNum(v.adaptInitialStep, 1),
              step_frequency: asNum(v.adaptStepFrequency, 0),
              initial_remeshing: asBool(v.adaptInitialRemeshing, false),
              anisotropy_parameters: {
                hmin_over_hmax_anisotropic_ratio: asNum(v.anisotropicRatio, 0.01),
                boundary_layer_min_size_ratio: asNum(v.boundaryLayerRatio, 2),
              },
              echo_level: asNum(v.echoLevel, 0),
            },
          },
        ]
      : [];
    const auxiliar: JsonObject[] = [
      {
        python_module: "apply_distance_modification_process",
        kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
        process_name: "ApplyDistanceModificationProcess",
        Parameters: { model_part_name: part, check_at_each_time_step: asBool(v.correctDistance, false) },
      },
    ];
    if (asBool(v.computeDrag, false)) {
      auxiliar.push({
        python_module: "compute_embedded_drag_process",
        kratos_module: "KratosMultiphysics.FluidDynamicsApplication",
        process_name: "ComputeEmbeddedDragProcess",
        Parameters: {
          model_part_name: part,
          write_drag_output_file: asBool(v.writeDragFile, true),
          print_drag_to_screen: asBool(v.printDrag, false),
          interval: [0.0, "End"],
        },
      });
    }
    processes.auxiliar_process_list = auxiliar;
    return pp;
  },
});
