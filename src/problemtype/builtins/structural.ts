/**
 * Built-in Structural Mechanics problemtype. Output shapes mirror what
 * GiDInterface's Structural app writes (apps/Structural/write/writeProjectParameters.tcl):
 * solution types Static / Dynamic / eigen_value, the Newmark and Bossak
 * schemes, the nonlinear-iteration parameters of apps/Structural/xml/Strategies.xml
 * and the nodal conditions / loads of NodalConditions.xml and Conditions.xml.
 * The element set is a superset of GiD's: it adds the app's newer and
 * specialist families (mixed and Q1P0 solids, MITC and CS-DSG3 shells, curved
 * beams, the legacy trusses, the membrane, and the discrete point/line/surface
 * mass, spring and bushing elements).
 *
 * Keys that equal Kratos' own default are only written when they matter (the
 * nonlinear parameters only for a non-linear analysis, the linear solver only
 * when one is chosen), so a plain linear case still produces the same lean
 * document it always did.
 */

import { defineProblemtype, asNum, asStr, asBool, dottedModelPart, resolveProcessTemplate } from "../api";
import { STRUCTURAL_MAIN_KRATOS_PY } from "../mainKratosTemplate";
import { Assignment, ConditionSpec, FieldSpec, GenContext, JsonObject, JsonValue, MeshNamingEntry, VisibleRule } from "../types";
import { siblingPathFor } from "../emitLoadConditions";
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
 * The element formulations a case can choose: the families the app registers
 * (GiD's Elements.xml names the same ones) with the DOF flags each switches on
 * in `solver_settings`. One formulation is chosen per case — `meshNaming`
 * renames every element block to that family's name for its shape, and a shape
 * the family does not register is refused rather than renamed into a type
 * Kratos never defined.
 */
type FormulationKind = "solid" | "axisym" | "shell" | "membrane" | "beam" | "truss" | "discrete";

interface FormulationSpec {
  value: string;
  label: string;
  kind: FormulationKind;
  rotation?: boolean;
  strain?: boolean;
  volumetricStrain?: boolean;
}

const FORMULATIONS: FormulationSpec[] = [
  { value: "SmallDisplacementElement", label: "Solid small displacements", kind: "solid" },
  { value: "SmallDisplacementBbarElement", label: "Solid small displacements B-bar", kind: "solid" },
  { value: "SmallDisplacementMixedVolumetricStrainElement", label: "Solid small displacements mixed u-εvol", kind: "solid", volumetricStrain: true },
  { value: "SmallDisplacementMixedVolumetricStrainOssElement", label: "Solid small displacements mixed u-εvol (OSS)", kind: "solid", volumetricStrain: true },
  { value: "SmallDisplacementMixedVolumetricStrainOssNonLinearElement", label: "Solid small displacements mixed u-εvol (OSS, non-linear)", kind: "solid", volumetricStrain: true },
  { value: "SmallDisplacementMixedStrainElement", label: "Solid small displacements mixed u-ε", kind: "solid", strain: true },
  { value: "TotalLagrangianElement", label: "Solid total Lagrangian", kind: "solid" },
  { value: "UpdatedLagrangianElement", label: "Solid updated Lagrangian", kind: "solid" },
  { value: "TotalLagrangianMixedVolumetricStrainElement", label: "Solid total Lagrangian mixed u-εvol", kind: "solid", volumetricStrain: true },
  { value: "TotalLagrangianQ1P0MixedElement", label: "Solid total Lagrangian Q1P0", kind: "solid" },
  { value: "AxisymSmallDisplacementElement", label: "Axisymmetric small displacements", kind: "axisym" },
  { value: "AxisymTotalLagrangianElement", label: "Axisymmetric total Lagrangian", kind: "axisym" },
  { value: "AxisymUpdatedLagrangianElement", label: "Axisymmetric updated Lagrangian", kind: "axisym" },
  { value: "SolidShellElementSprism", label: "Solid-shell (SPRISM 3D6N)", kind: "solid" },
  { value: "LinearTimoshenkoBeamElement", label: "Beam small displacements (Timoshenko)", kind: "beam", rotation: true },
  { value: "LinearTimoshenkoCurvedBeamElement", label: "Beam small displacements (curved Timoshenko)", kind: "beam", rotation: true },
  { value: "CrBeamElement", label: "Beam large displacements (corotational)", kind: "beam", rotation: true },
  { value: "CrLinearBeamElement", label: "Beam small displacements (corotational)", kind: "beam", rotation: true },
  { value: "LinearTrussElement", label: "Truss small displacements", kind: "truss" },
  { value: "TotalLagrangianTrussElement", label: "Truss large displacements", kind: "truss" },
  { value: "TrussElement", label: "Truss large displacements (legacy)", kind: "truss" },
  { value: "TrussLinearElement", label: "Truss small displacements (legacy)", kind: "truss" },
  { value: "CableElement", label: "Cable", kind: "truss" },
  { value: "ShellThinElementCorotational", label: "Shell thin corotational", kind: "shell", rotation: true },
  { value: "ShellThickElementCorotational", label: "Shell thick corotational", kind: "shell", rotation: true },
  { value: "ShellThinElement", label: "Shell thin", kind: "shell", rotation: true },
  { value: "MITCThickShellElement", label: "Shell thick (MITC)", kind: "shell", rotation: true },
  { value: "MITCThickShellCorotationalElement", label: "Shell thick corotational (MITC)", kind: "shell", rotation: true },
  { value: "CSDSG3ThickShellLinearElement", label: "Shell thick CS-DSG3", kind: "shell", rotation: true },
  { value: "CSDSG3ThickShellCorotationalElement", label: "Shell thick corotational CS-DSG3", kind: "shell", rotation: true },
  { value: "MembraneElement", label: "Membrane", kind: "membrane" },
  { value: "NodalConcentratedElement", label: "Point mass", kind: "discrete" },
  { value: "NodalConcentratedDampedElement", label: "Point mass (damped)", kind: "discrete" },
  { value: "LineMassElement", label: "Line mass", kind: "discrete" },
  { value: "SurfaceMassElement", label: "Surface mass", kind: "discrete" },
  { value: "BushingElement", label: "Bushing", kind: "discrete", rotation: true },
  { value: "SpringDamperElement", label: "Spring / damper", kind: "discrete", rotation: true },
];

/** The values of the given kinds — the pairing rules of the material laws. */
const ofKind = (...kinds: FormulationKind[]): string[] =>
  FORMULATIONS.filter((f) => kinds.includes(f.kind)).map((f) => f.value);

/** A `when` rule offering a law only while the chosen formulation is one of `values`. */
const forFormulations = (...values: string[]): VisibleRule => ({ field: "elementBase", oneOf: values });

/** An exact-name `{dim: {nodes: name}}` table for a family whose names are `<value>{dim}D{nodes}N`. */
const shapesOf = (value: string, dim2: number[], dim3: number[]): MeshNamingEntry => {
  const table: { [dim: number]: { [nodes: number]: string } } = {};
  for (const [dim, nodes] of [[2, dim2], [3, dim3]] as [number, number[]][]) {
    if (nodes.length === 0) continue;
    table[dim] = {};
    for (const n of nodes) table[dim][n] = `${value}${dim}D${n}N`;
  }
  return table;
};

// The shapes each family registers as elements (SolidMechanicsApplication's
// registration list). The legacy truss and the cable are the exception: each
// registers one 3D2N element, which Kratos also accepts in a 2D mesh (the
// solver adds the Z dofs either way), so both dimensions map to that name.
// Exported so the coupled types name their structural domain's blocks the same
// way (their `elementBase` field carries the `s_` prefix).
const SOLID_2D = [3, 4, 6, 8, 9, 10, 15];
const SOLID_3D = [4, 5, 6, 8, 10, 13, 15, 20, 27];
const AXISYM_2D = [3, 4, 6, 8, 9];
export const STRUCTURAL_ELEMENT_NAMES: { [value: string]: MeshNamingEntry } = {
  SmallDisplacementElement: shapesOf("SmallDisplacementElement", SOLID_2D, SOLID_3D),
  SmallDisplacementBbarElement: shapesOf("SmallDisplacementBbarElement", [4], [8]),
  SmallDisplacementMixedVolumetricStrainElement: shapesOf("SmallDisplacementMixedVolumetricStrainElement", [3, 4], [4, 8]),
  SmallDisplacementMixedVolumetricStrainOssElement: shapesOf("SmallDisplacementMixedVolumetricStrainOssElement", [3, 4], [4, 8]),
  SmallDisplacementMixedVolumetricStrainOssNonLinearElement: shapesOf("SmallDisplacementMixedVolumetricStrainOssNonLinearElement", [3, 4], [4, 8]),
  SmallDisplacementMixedStrainElement: shapesOf("SmallDisplacementMixedStrainElement", [3, 4], [4, 8]),
  TotalLagrangianElement: shapesOf("TotalLagrangianElement", SOLID_2D, SOLID_3D),
  UpdatedLagrangianElement: shapesOf("UpdatedLagrangianElement", SOLID_2D, SOLID_3D),
  TotalLagrangianMixedVolumetricStrainElement: shapesOf("TotalLagrangianMixedVolumetricStrainElement", [3], [4]),
  TotalLagrangianQ1P0MixedElement: shapesOf("TotalLagrangianQ1P0MixedElement", [3, 4], [4, 8, 10, 20]),
  AxisymSmallDisplacementElement: shapesOf("AxisymSmallDisplacementElement", AXISYM_2D, []),
  AxisymTotalLagrangianElement: shapesOf("AxisymTotalLagrangianElement", AXISYM_2D, []),
  AxisymUpdatedLagrangianElement: shapesOf("AxisymUpdatedLagrangianElement", AXISYM_2D, []),
  SolidShellElementSprism: shapesOf("SolidShellElementSprism", [], [6]),
  LinearTimoshenkoBeamElement: shapesOf("LinearTimoshenkoBeamElement", [2, 3], [2]),
  LinearTimoshenkoCurvedBeamElement: shapesOf("LinearTimoshenkoCurvedBeamElement", [3], [3]),
  CrBeamElement: shapesOf("CrBeamElement", [2], [2]),
  CrLinearBeamElement: shapesOf("CrLinearBeamElement", [2], [2]),
  LinearTrussElement: shapesOf("LinearTrussElement", [2, 3], [2, 3]),
  TotalLagrangianTrussElement: shapesOf("TotalLagrangianTrussElement", [2], [2]),
  TrussElement: { 2: { 2: "TrussElement3D2N" }, 3: { 2: "TrussElement3D2N" } },
  TrussLinearElement: { 2: { 2: "TrussLinearElement3D2N" }, 3: { 2: "TrussLinearElement3D2N" } },
  CableElement: { 2: { 2: "CableElement3D2N" }, 3: { 2: "CableElement3D2N" } },
  ShellThinElementCorotational: shapesOf("ShellThinElementCorotational", [], [3, 4]),
  ShellThickElementCorotational: shapesOf("ShellThickElementCorotational", [], [3, 4]),
  ShellThinElement: shapesOf("ShellThinElement", [], [3]),
  MITCThickShellElement: shapesOf("MITCThickShellElement", [], [4]),
  MITCThickShellCorotationalElement: shapesOf("MITCThickShellCorotationalElement", [], [4]),
  CSDSG3ThickShellLinearElement: shapesOf("CSDSG3ThickShellLinearElement", [], [3]),
  CSDSG3ThickShellCorotationalElement: shapesOf("CSDSG3ThickShellCorotationalElement", [], [3]),
  MembraneElement: shapesOf("MembraneElement", [2], [3, 4]),
  NodalConcentratedElement: shapesOf("NodalConcentratedElement", [1], [1]),
  NodalConcentratedDampedElement: shapesOf("NodalConcentratedDampedElement", [1], [1]),
  LineMassElement: shapesOf("LineMassElement", [], [2]),
  SurfaceMassElement: shapesOf("SurfaceMassElement", [], [3, 4]),
  BushingElement: shapesOf("BushingElement", [], [2]),
  SpringDamperElement: { 2: { 2: "SpringDamperElement2D" }, 3: { 2: "SpringDamperElement3D" } },
};

const NONLINEAR = { field: "analysisType", equals: "non_linear" };
const DYNAMIC = { field: "solverType", equals: "dynamic" };
const EIGEN = { field: "solverType", equals: "eigen_value" };
const NOT_EIGEN = { field: "solverType", oneOf: ["static", "dynamic"] as JsonValue[] };
const RESIDUAL = { field: "convergenceCriterion", oneOf: ["residual_criterion", "and_criterion", "or_criterion"] as JsonValue[] };
const DISPLACEMENT = { field: "convergenceCriterion", oneOf: ["displacement_criterion", "and_criterion", "or_criterion"] as JsonValue[] };

const DENSITY = { id: "DENSITY", label: "Density [kg/m³]", type: "number" as const, default: 7850, unit: "kg/m³" };
const YOUNG = { id: "YOUNG_MODULUS", label: "Young modulus [Pa]", type: "number" as const, default: 2.1e11, unit: "Pa" };
const POISSON = { id: "POISSON_RATIO", label: "Poisson ratio", type: "number" as const, default: 0.29 };
const ELASTIC = [DENSITY, YOUNG, POISSON];
const THICKNESS = { id: "THICKNESS", label: "Thickness [m]", type: "number" as const, default: 1.0, unit: "m" };
const CROSS_AREA = { id: "CROSS_AREA", label: "Cross area [m²]", type: "number" as const, default: 1.0, unit: "m²" };
const I22 = { id: "I22", label: "Bending inertia I22 [m⁴]", type: "number" as const, default: 1.0, unit: "m⁴" };
const I33 = { id: "I33", label: "Bending inertia I33 [m⁴]", type: "number" as const, default: 1.0, unit: "m⁴" };
const TORSIONAL_INERTIA = { id: "TORSIONAL_INERTIA", label: "Torsional inertia [m⁴]", type: "number" as const, default: 1.0, unit: "m⁴" };
const PRESTRESS = { id: "TRUSS_PRESTRESS_PK2", label: "Prestress [Pa]", type: "number" as const, default: 0, unit: "Pa" };
const NODAL_MASS = { id: "NODAL_MASS", label: "Point mass [kg]", type: "number" as const, default: 1.0, unit: "kg" };
/** A nodal stiffness/damping constant, one value per spatial direction (and moment). */
const nodalConstant = (id: string, label: string, unit?: string): FieldSpec => ({ id, label, type: "vector3", unit });

// Nonlinear solid response (ConstitutiveLawsApplication): GiD's curated set —
// the hyperelastic laws, the small/finite-strain plasticity and damage
// factories with their VonMises yield surface and plastic potential, the J2,
// plastic-damage and viscous laws.
const YIELD_STRESS = { id: "YIELD_STRESS", label: "Yield stress [Pa]", type: "number" as const, default: 1.0e6, unit: "Pa" };
const FRACTURE_ENERGY = { id: "FRACTURE_ENERGY", label: "Fracture energy [J/m²]", type: "number" as const, default: 100, unit: "J/m²" };
const HARDENING_CURVE = { id: "HARDENING_CURVE", label: "Hardening curve", type: "int" as const, default: 0 };
const MAXIMUM_STRESS_POSITION = { id: "MAXIMUM_STRESS_POSITION", label: "Peak stress position", type: "number" as const, default: 0.3 };
const MAXIMUM_STRESS = { id: "MAXIMUM_STRESS", label: "Peak stress [Pa]", type: "number" as const, default: 2.0e6, unit: "Pa" };
const KINEMATIC_HARDENING_TYPE = { id: "KINEMATIC_HARDENING_TYPE", label: "Kinematic hardening type", type: "int" as const, default: 0 };
const KINEMATIC_PLASTICITY_PARAMETERS = {
  id: "KINEMATIC_PLASTICITY_PARAMETERS", label: "Kinematic hardening parameters",
  type: "vector3" as const, default: [1.0e9, 0.0, 0.0],
};
const SOFTENING_TYPE = { id: "SOFTENING_TYPE", label: "Softening type", type: "int" as const, default: 0 };
const REFERENCE_HARDENING_MODULUS = { id: "REFERENCE_HARDENING_MODULUS", label: "Reference hardening modulus", type: "number" as const, default: 1.0 };
const ISOTROPIC_HARDENING_MODULUS = { id: "ISOTROPIC_HARDENING_MODULUS", label: "Isotropic hardening modulus", type: "number" as const, default: 0.12924 };
const INFINITY_HARDENING_MODULUS = { id: "INFINITY_HARDENING_MODULUS", label: "Saturation hardening modulus", type: "number" as const, default: 0.0 };
const HARDENING_EXPONENT = { id: "HARDENING_EXPONENT", label: "Hardening exponent", type: "number" as const, default: 1.0 };
const VISCOUS_PARAMETER = { id: "VISCOUS_PARAMETER", label: "Viscous parameter", type: "number" as const, default: 0.15 };
const DELAY_TIME = { id: "DELAY_TIME", label: "Delay time [s]", type: "number" as const, default: 100, unit: "s" };
const PLASTIC = [DENSITY, YOUNG, POISSON, YIELD_STRESS, FRACTURE_ENERGY, HARDENING_CURVE, MAXIMUM_STRESS_POSITION, MAXIMUM_STRESS];
const KINEMATIC = [...PLASTIC, KINEMATIC_HARDENING_TYPE, KINEMATIC_PLASTICITY_PARAMETERS];
const DAMAGE = [DENSITY, YOUNG, POISSON, YIELD_STRESS, FRACTURE_ENERGY, SOFTENING_TYPE];
const J2 = [DENSITY, YOUNG, POISSON, { ...YIELD_STRESS, default: 5.5e6 }, REFERENCE_HARDENING_MODULUS, ISOTROPIC_HARDENING_MODULUS, INFINITY_HARDENING_MODULUS, HARDENING_EXPONENT];
/** A factory row's fixed block keys: the VonMises yield surface and plastic potential GiD curates. */
const vonMises = (law_type: string) => ({ law_type, yield_surface: "VonMises", plastic_potential: "VonMises" });

const asVec3 = (v: JsonValue | undefined, dflt = [0, 0, 0]): number[] =>
  Array.isArray(v) && v.length === 3 ? (v as number[]) : dflt;

const norm3 = (v: number[]): number => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);

/** Fields of the moving-load condition, shared with the generate-time direction check. */
const MOVING_LOAD_FIELDS: FieldSpec[] = [
  { id: "modulus", label: "Modulus [N]", type: "number", default: 0 },
  { id: "direction", label: "Direction", type: "vector3", default: [0, 0, -1] },
  { id: "velocity", label: "Velocity [m/s]", type: "number", default: 1 },
  { id: "motionDirection", label: "Motion direction", type: "vector3", default: [1, 0, 0] },
  { id: "origin", label: "Origin [m]", type: "vector3", default: [0, 0, 0] },
  {
    id: "motionType",
    label: "Motion type",
    type: "enum",
    default: "base",
    options: [{ value: "base", label: "Base" }, { value: "total", label: "Total" }],
  },
];

/** A moving-load field value with the field default merged (assignments need not carry it). */
const movingValue = (a: Assignment, id: string): JsonValue =>
  a.values[id] ?? MOVING_LOAD_FIELDS.find((f) => f.id === id)?.default ?? null;

/**
 * The `SetMovingLoadProcess` entry for one moving-load assignment: the load is
 * the modulus along the normalized load direction (Kratos normalizes the
 * direction the same way), travelling along the motion direction from the
 * origin at the given velocity. It addresses the emitted sibling part, which
 * holds the `MovingLoadCondition` entities.
 */
function movingLoadProcess(cond: ConditionSpec, a: Assignment, ctx: GenContext): JsonObject {
  const modulus = asNum(movingValue(a, "modulus"), 0);
  const direction = asVec3(movingValue(a, "direction"), [0, 0, -1]);
  const n = norm3(direction);
  const unit = n < 1e-12 ? [0, 0, 0] : direction.map((x) => (x ?? 0) / n);
  return {
    python_module: "set_moving_load_process",
    kratos_module: "KratosMultiphysics.StructuralMechanicsApplication",
    process_name: "SetMovingLoadProcess",
    Parameters: {
      model_part_name: dottedModelPart(ctx.modelPartName, siblingPathFor(a.smpPath, cond.emit!.sibling)),
      variable_name: "POINT_LOAD",
      load: unit.map((x) => modulus * x),
      direction: asVec3(movingValue(a, "motionDirection"), [1, 0, 0]),
      velocity: asNum(movingValue(a, "velocity"), 1),
      origin: asVec3(movingValue(a, "origin")),
      motion_type: asStr(movingValue(a, "motionType"), "base"),
    },
  };
}

export const structural = defineProblemtype(
  {
    id: "structural",
    name: "Structural Mechanics",
    description: "Static / dynamic / eigenvalue solid, beam, truss, shell, membrane and mass/spring mechanics (StructuralMechanicsApplication)",
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
      elements: { field: "elementBase", names: STRUCTURAL_ELEMENT_NAMES },
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
      vectorConstraint("ANGULAR_ACCELERATION", {
        id: "angularAcceleration",
        label: "Angular acceleration",
        unit: "rad/s²",
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
        emit: {
          sibling: "PointLoad",
          source: "nodes",
          family: "point",
          formulationField: "elementBase",
          axisymmetricPoint: "AxisymPointLoadCondition2D1N",
        },
      }),
      vectorLoadOnConditions("POINT_MOMENT", {
        id: "pointMoment",
        label: "Point moment",
        unit: "N·m",
        target: "nodes",
        icon: "ptLoad",
        help: "3D only.",
        emit: { sibling: "PointMoment", source: "nodes", family: "moment" },
      }),
      {
        id: "movingLoad",
        label: "Moving load",
        list: "loads_process_list",
        target: "surface",
        category: "loads",
        icon: "ptLoad",
        help: "A load travelling along the part's line entities (bridge traffic): the lines are re-emitted as MovingLoadCondition blocks in a sibling part.",
        fields: MOVING_LOAD_FIELDS,
        processTemplate: {
          python_module: "set_moving_load_process",
          kratos_module: "KratosMultiphysics.StructuralMechanicsApplication",
          process_name: "SetMovingLoadProcess",
          Parameters: { model_part_name: "$path", variable_name: "POINT_LOAD" },
        },
        emit: { sibling: "MovingLoad", source: "lines", family: "moving" },
      },
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
      // The constitutive law must fit the element family that reads it: a beam
      // calls a beam law with beam kinematics, a truss a 1D law, a shell and a
      // membrane their own plane response. `when` offers a law only for the
      // formulations it fits, and Generate refuses an assignment left on one of
      // another family, so a section force is never computed from a law that
      // means something else.
      { id: "linear_elastic_3d", name: "LinearElastic3DLaw", domainSize: 3, group: "Elastic",
        when: forFormulations(...ofKind("solid", "shell")), variables: ELASTIC },
      { id: "linear_elastic_plane_strain", name: "LinearElasticPlaneStrain2DLaw", domainSize: 2, group: "Elastic",
        when: forFormulations(...ofKind("solid")), variables: [...ELASTIC, THICKNESS] },
      { id: "linear_elastic_plane_stress", name: "LinearElasticPlaneStress2DLaw", domainSize: 2, group: "Elastic",
        when: forFormulations(...ofKind("solid")), variables: [...ELASTIC, THICKNESS] },
      { id: "linear_elastic_axisym", name: "LinearElasticAxisym2DLaw", domainSize: 2, group: "Elastic",
        when: forFormulations(...ofKind("axisym")), variables: ELASTIC },
      { id: "beam_2d", name: "BeamConstitutiveLaw", domainSize: 2, group: "Beam",
        when: forFormulations(...ofKind("beam")), variables: [...ELASTIC, CROSS_AREA, I33] },
      { id: "beam_3d", name: "BeamConstitutiveLaw", domainSize: 3, group: "Beam",
        when: forFormulations(...ofKind("beam")), variables: [...ELASTIC, CROSS_AREA, TORSIONAL_INERTIA, I22, I33] },
      { id: "truss", name: "TrussConstitutiveLaw", group: "Truss & cable",
        when: forFormulations(...ofKind("truss")), variables: [DENSITY, YOUNG, CROSS_AREA, PRESTRESS] },
      { id: "shell", name: "ReissnerMindlinShellElasticConstitutiveLaw", domainSize: 3, group: "Shell",
        when: forFormulations(...ofKind("shell")), variables: [...ELASTIC, THICKNESS] },
      { id: "membrane", name: "LinearElasticPlaneStress2DLaw", group: "Membrane",
        when: forFormulations(...ofKind("membrane")), variables: [...ELASTIC, THICKNESS] },
      { id: "hyperelastic_3d", name: "HyperElastic3DLaw", domainSize: 3, group: "Hyperelastic",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")), variables: ELASTIC },
      { id: "hyperelastic_plane_strain", name: "HyperElasticPlaneStrain2DLaw", domainSize: 2, group: "Hyperelastic",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid")), variables: ELASTIC },
      { id: "kirchhoff_3d", name: "KirchhoffSaintVenant3DLaw", domainSize: 3, group: "Hyperelastic",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")), variables: ELASTIC },
      { id: "kirchhoff_plane_strain", name: "KirchhoffSaintVenantPlaneStrain2DLaw", domainSize: 2, group: "Hyperelastic",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid")), variables: ELASTIC },
      { id: "kirchhoff_plane_stress", name: "KirchhoffSaintVenantPlaneStress2DLaw", domainSize: 2, group: "Hyperelastic",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid")), variables: [...ELASTIC, THICKNESS] },
      { id: "plasticity_iso_3d", name: "SmallStrainIsotropicPlasticityFactory", domainSize: 3, group: "Plasticity",
        application: "ConstitutiveLawsApplication", parameters: vonMises("3D"),
        when: forFormulations(...ofKind("solid", "shell")), variables: PLASTIC },
      { id: "plasticity_iso_plane_strain", name: "SmallStrainIsotropicPlasticityFactory", domainSize: 2, group: "Plasticity",
        application: "ConstitutiveLawsApplication", parameters: vonMises("PlaneStrain"),
        when: forFormulations(...ofKind("solid")), variables: PLASTIC },
      { id: "plasticity_iso_plane_stress", name: "SmallStrainIsotropicPlasticityFactory", domainSize: 2, group: "Plasticity",
        application: "ConstitutiveLawsApplication", parameters: vonMises("PlaneStress"),
        when: forFormulations(...ofKind("solid")), variables: [...PLASTIC, THICKNESS] },
      { id: "plasticity_kin_3d", name: "SmallStrainKinematicPlasticityFactory", domainSize: 3, group: "Plasticity",
        application: "ConstitutiveLawsApplication", parameters: vonMises("3D"),
        when: forFormulations(...ofKind("solid", "shell")), variables: KINEMATIC },
      { id: "plasticity_kin_plane_stress", name: "SmallStrainKinematicPlasticityFactory", domainSize: 2, group: "Plasticity",
        application: "ConstitutiveLawsApplication", parameters: vonMises("PlaneStress"),
        when: forFormulations(...ofKind("solid")), variables: [...KINEMATIC, THICKNESS] },
      { id: "plasticity_finite_iso_3d", name: "FiniteStrainIsotropicPlasticity3DVonMisesVonMises", domainSize: 3, group: "Plasticity",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")), variables: PLASTIC },
      { id: "plasticity_finite_iso_plane_stress", name: "FiniteStrainIsotropicPlasticityPlaneStressVonMisesVonMises", domainSize: 2, group: "Plasticity",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid")), variables: [...PLASTIC, THICKNESS] },
      { id: "plasticity_finite_kin_3d", name: "FiniteStrainKinematicPlasticity3DVonMisesVonMises", domainSize: 3, group: "Plasticity",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")), variables: KINEMATIC },
      { id: "plasticity_finite_kin_plane_stress", name: "FiniteStrainKinematicPlasticityPlaneStressVonMisesVonMises", domainSize: 2, group: "Plasticity",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid")), variables: [...KINEMATIC, THICKNESS] },
      { id: "plasticity_j2_3d", name: "SmallStrainJ2Plasticity3DLaw", domainSize: 3, group: "Plasticity",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")), variables: J2 },
      { id: "plasticity_j2_plane_strain", name: "SmallStrainJ2PlasticityPlaneStrain2DLaw", domainSize: 2, group: "Plasticity",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid")), variables: J2 },
      { id: "damage_iso_3d", name: "SmallStrainIsotropicDamageFactory", domainSize: 3, group: "Damage",
        application: "ConstitutiveLawsApplication", parameters: vonMises("3D"),
        when: forFormulations(...ofKind("solid", "shell")), variables: DAMAGE },
      { id: "damage_iso_plane_strain", name: "SmallStrainIsotropicDamageFactory", domainSize: 2, group: "Damage",
        application: "ConstitutiveLawsApplication", parameters: vonMises("PlaneStrain"),
        when: forFormulations(...ofKind("solid")), variables: DAMAGE },
      { id: "damage_iso_plane_stress", name: "SmallStrainIsotropicDamageFactory", domainSize: 2, group: "Damage",
        application: "ConstitutiveLawsApplication", parameters: vonMises("PlaneStress"),
        when: forFormulations(...ofKind("solid")), variables: [...DAMAGE, THICKNESS] },
      { id: "damage_plastic_3d", name: "AssociativePlasticDamageModel3DVonMises", domainSize: 3, group: "Damage",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")),
        variables: [DENSITY, YOUNG, POISSON, YIELD_STRESS, FRACTURE_ENERGY, HARDENING_CURVE] },
      { id: "viscous_maxwell_3d", name: "ViscousGeneralizedMaxwell3D", domainSize: 3, group: "Viscous",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")),
        variables: [DENSITY, YOUNG, POISSON, VISCOUS_PARAMETER, DELAY_TIME] },
      { id: "viscous_kelvin_3d", name: "ViscousGeneralizedKelvin3D", domainSize: 3, group: "Viscous",
        application: "ConstitutiveLawsApplication", when: forFormulations(...ofKind("solid", "shell")),
        variables: [DENSITY, YOUNG, POISSON, { ...DELAY_TIME, default: 1.0 }] },
      // Discrete elements carry no constitutive response: these laws are their
      // properties (Kratos reads them off the material), so `name` stays empty.
      { id: "point_mass", name: "", group: "Discrete",
        when: forFormulations("NodalConcentratedElement", "NodalConcentratedDampedElement"),
        variables: [
          NODAL_MASS,
          nodalConstant("NODAL_INERTIA", "Rotational inertia [kg·m²]", "kg·m²"),
          nodalConstant("NODAL_DISPLACEMENT_STIFFNESS", "Spring stiffness [N/m]", "N/m"),
          nodalConstant("NODAL_DAMPING_RATIO", "Damper coefficient [N·s/m]", "N·s/m"),
        ] },
      { id: "spring", name: "", group: "Discrete",
        when: forFormulations("SpringDamperElement"),
        variables: [
          nodalConstant("NODAL_DISPLACEMENT_STIFFNESS", "Translational stiffness [N/m]", "N/m"),
          nodalConstant("NODAL_ROTATIONAL_STIFFNESS", "Rotational stiffness [N·m/rad]", "N·m/rad"),
          nodalConstant("NODAL_DAMPING_RATIO", "Translational damper [N·s/m]", "N·s/m"),
          nodalConstant("NODAL_ROTATIONAL_DAMPING_RATIO", "Rotational damper [N·m·s/rad]", "N·m·s/rad"),
        ] },
      { id: "bushing", name: "", group: "Discrete", domainSize: 3,
        when: forFormulations("BushingElement"),
        variables: [
          nodalConstant("NODAL_DISPLACEMENT_STIFFNESS", "Translational stiffness [N/m]", "N/m"),
          nodalConstant("NODAL_ROTATIONAL_STIFFNESS", "Rotational stiffness [N·m/rad]", "N·m/rad"),
        ] },
      { id: "line_mass", name: "", group: "Discrete", domainSize: 3,
        when: forFormulations("LineMassElement"), variables: [DENSITY, CROSS_AREA] },
      { id: "surface_mass", name: "", group: "Discrete", domainSize: 3,
        when: forFormulations("SurfaceMassElement"), variables: [DENSITY, THICKNESS] },
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
    // of its single "Fixed" checkbox; emitted loads address their sibling part;
    // everything else uses its template.
    buildProcess: (cond, a, ctx) => {
      if (cond.id === "movingLoad") return movingLoadProcess(cond, a, ctx);
      if (cond.emit !== undefined) {
        const resolved = resolveProcessTemplate(cond, a, ctx) as { Parameters: JsonObject };
        resolved.Parameters.model_part_name = dottedModelPart(
          ctx.modelPartName,
          siblingPathFor(a.smpPath, cond.emit.sibling)
        );
        return resolved;
      }
      return broadcastConstrained(cond, a, ctx);
    },
    // A moving load with no direction to point or move along would reach
    // Kratos as a zero vector (or NaN); refuse it at generate time instead.
    validate: (ctx) => {
      const problems: string[] = [];
      for (const a of ctx.assignments) {
        if (a.conditionId !== "movingLoad") continue;
        for (const [id, what] of [["direction", "load direction"], ["motionDirection", "motion direction"]] as const) {
          if (norm3(asVec3(movingValue(a, id))) < 1e-12) {
            problems.push(`Moving load on "${a.smpPath}": the ${what} is zero — give it a direction.`);
          }
        }
      }
      return problems;
    },
  }
);
