/**
 * The problemtype data model: a JSON-able declaration (rendered as sidebar
 * forms by the webview) plus host-only imperative hooks, normalized into a
 * ProblemtypeRuntime that the case generator consumes regardless of whether
 * the problemtype was authored in TypeScript (built-ins), workspace JS, or
 * Python (pyodide).
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export type FieldType = "number" | "int" | "string" | "bool" | "enum" | "vector3";

export interface FieldSpec {
  id: string;
  label: string;
  type: FieldType;
  default?: JsonValue;
  /** Choices when type is "enum". */
  options?: { value: string; label?: string }[];
  /** Show this field only when another field of the same form has a value. */
  visibleWhen?: { field: string; equals: JsonValue };
  help?: string;
}

export interface SectionSpec {
  id: string;
  label: string;
  fields: FieldSpec[];
}

/**
 * Which ProjectParameters `processes` list an assignment lands in. The three
 * GiD-standard lists are always emitted (possibly empty); a problemtype may
 * also target custom lists (e.g. ShallowWater's boundary_conditions_process_list).
 */
export type ProcessList =
  | "constraints_process_list"
  | "loads_process_list"
  | "list_other_processes"
  | (string & {});

/**
 * Expected mdpa block naming for the solver: per-kind target base name; the
 * final block name is `${base}${domainSize}D${nodesPerCell}N`. A plain string
 * applies to both domain sizes; the object form differs per size. Strings may
 * be "$field:<id>" (resolved against the flattened form values), letting e.g.
 * the structural formulation pick SmallDisplacementElement vs
 * TotalLagrangianElement.
 */
export interface MeshNamingSpec {
  elements?: string | { 2?: string; 3?: string };
  conditions?: string | { 2?: string; 3?: string };
}

/** Hint for the SubModelPart picker; purely advisory in v1. */
export type ConditionTarget = "nodes" | "surface" | "volume" | "any";

export interface ConditionSpec {
  id: string;
  label: string;
  list: ProcessList;
  target: ConditionTarget;
  fields: FieldSpec[];
  /**
   * Declarative process entry `{ python_module, kratos_module, process_name, Parameters }`.
   * String leaves equal to "$path" (dotted model-part name of the assigned
   * SubModelPart), "$root" (the root model-part name) or "$field:<id>" (the
   * assignment's value for that field, any JSON type) are resolved by the core.
   * Imperative override: hooks.buildProcess.
   */
  processTemplate: JsonObject;
  help?: string;
}

export interface MaterialLawSpec {
  id: string;
  /** Kratos constitutive-law name; empty string omits the constitutive_law block. */
  name: string;
  variables: FieldSpec[];
  /** Restrict the law to one domain size (e.g. plane-strain laws). */
  domainSize?: 2 | 3;
}

export interface OutputSpec {
  /** Default nodal_solution_step_data_variables for vtk_output. */
  nodalDefaults: string[];
  /** Default gauss_point_variables_extrapolated_to_nodes. */
  gaussDefaults?: string[];
}

export interface ProblemtypeDeclaration {
  id: string;
  name: string;
  description?: string;
  /**
   * Optional logo: the id of a toolbar icon (src/toolbarIcons.ts) shown on the
   * problemtype's forms — e.g. "ptStructural". Unknown ids fall back to the
   * generic "problemtype" glyph, so user problemtypes may name any built-in icon.
   */
  icon?: string;
  /** e.g. "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis" */
  analysisStage: string;
  /** Root model part, e.g. "Structure" | "FluidModelPart" | "ThermalModelPart". */
  modelPartName: string;
  /** e.g. "StructuralMaterials.json" */
  materialsFileName: string;
  domainSizes: (2 | 3)[];
  /** Problem-data + solver-settings forms. Field ids must be unique across sections. */
  sections: SectionSpec[];
  conditions: ConditionSpec[];
  materialLaws: MaterialLawSpec[];
  /**
   * Id of the "Parts / body" pseudo-condition: its assignments name the domain
   * SubModelParts (drives materials and e.g. the fluid volume_model_part_name)
   * and emit no process entry.
   */
  partsCondition?: string;
  /**
   * The element/condition block names this solver expects in the mdpa. When
   * set, Generate writes an adapted `<stem>_case.mdpa` copy whenever the
   * mesh's names differ and points input_filename at it.
   */
  meshNaming?: MeshNamingSpec;
  output: OutputSpec;
}

/** One condition applied to one SubModelPart with its parameter values. */
export interface Assignment {
  conditionId: string;
  /** Slash-separated SubModelPart path as used by the outline tree. */
  smpPath: string;
  values: Record<string, JsonValue>;
}

export interface MaterialAssignment {
  smpPath: string;
  lawId: string;
  values: Record<string, JsonValue>;
}

export interface OutputState {
  format: "ascii" | "binary";
  controlType: "step" | "time";
  interval: number;
  nodalVariables: string[];
}

/** The user's whole case setup — persisted as `<stem>.kratoscase.json`. */
export interface CaseState {
  version: 1;
  problemtypeId: string;
  /** sectionId → fieldId → value. */
  values: Record<string, Record<string, JsonValue>>;
  assignments: Assignment[];
  materials: MaterialAssignment[];
  output: OutputState;
}

/**
 * Plain-data context handed to every hook. Deliberately JSON-able (no model,
 * no functions) so the exact same object can cross into a node:vm sandbox or a
 * pyodide interpreter.
 */
export interface GenContext {
  /** mdpa file name without extension — model_import_settings.input_filename. */
  mdpaStem: string;
  domainSize: 2 | 3;
  modelPartName: string;
  materialsFileName: string;
  /** All section field values flattened (defaults merged in). */
  values: Record<string, JsonValue>;
  assignments: Assignment[];
  materials: MaterialAssignment[];
  /** Dotted model-part names of the Parts pseudo-condition assignments. */
  partsModelParts: string[];
  /** Dotted model-part names of every non-Parts assignment. */
  skinModelParts: string[];
  /** Slash-separated SubModelPart paths available in the mesh. */
  subModelParts: string[];
}

/** Host-only imperative hooks; never serialized, may be async (pyodide). */
export interface ProblemtypeHooks {
  /** Builds solver_settings (model_import/material_import blocks included). */
  solverSettings(values: Record<string, JsonValue>, ctx: GenContext): JsonObject | Promise<JsonObject>;
  /**
   * Overrides the default template resolution for a single assignment.
   * Return undefined/null to fall back to the declarative processTemplate.
   */
  buildProcess?(
    cond: ConditionSpec,
    a: Assignment,
    ctx: GenContext
  ): JsonObject | undefined | null | Promise<JsonObject | undefined | null>;
  /** Last-chance mutation of the assembled ProjectParameters document. */
  postProcess?(projectParameters: JsonObject, ctx: GenContext): JsonObject | Promise<JsonObject>;
  /** Replaces the default MainKratos.py text. */
  mainScript?(ctx: GenContext): string | Promise<string>;
}

export type ProblemtypeSource = "builtin" | "js" | "py";

/** What the generator consumes, whatever the authoring language. */
export interface ProblemtypeRuntime {
  decl: ProblemtypeDeclaration;
  source: ProblemtypeSource;
  solverSettings(values: Record<string, JsonValue>, ctx: GenContext): Promise<JsonObject>;
  buildProcess(cond: ConditionSpec, a: Assignment, ctx: GenContext): Promise<JsonObject>;
  postProcess(projectParameters: JsonObject, ctx: GenContext): Promise<JsonObject>;
  mainScript(ctx: GenContext): Promise<string>;
}

export interface GeneratedCase {
  /** Pretty-printed ProjectParameters.json text. */
  projectParameters: string;
  /** Pretty-printed materials file text. */
  materials: string;
  /** The materials file name (decl.materialsFileName). */
  materialsFileName: string;
  /** MainKratos.py text. */
  mainScript: string;
  warnings: string[];
}
