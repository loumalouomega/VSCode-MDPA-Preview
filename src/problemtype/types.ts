/**
 * The problemtype data model: a JSON-able declaration (rendered as sidebar
 * forms by the webview) plus host-only imperative hooks, normalized into a
 * ProblemtypeRuntime that the case generator consumes regardless of whether
 * the problemtype was authored in TypeScript (built-ins), workspace JS, or
 * Python (pyodide).
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

// Type-only, and `materialCatalog.ts` imports this file the same way: the
// snapshot shape is a data contract the catalog and the case file both speak.
import type { MaterialPresetSnapshot } from "./materialCatalog";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/**
 * Field kinds. The first six are scalar form inputs. The rest exist for
 * collections (see `CollectionSpec`) and the setups built on them:
 * - `ref`: the name of an entry of the collection `refCollection` (an
 *   objective naming a response). Stored as the entry's name string.
 * - `smp` / `smpList`: one / several SubModelPart paths (slash-separated, as the
 *   outline names them). Stored as a string / string array.
 * - `numberList` / `stringList`: a free-length list, typed as comma-separated text.
 * - `caseValue`: the ADDRESS of one numeric value elsewhere in the case (a
 *   section field, an assignment field, a material variable; see `caseAddress.ts`).
 *   Stored as the address string. Only valid inside a collection entry type.
 */
export type FieldType =
  | "number"
  | "int"
  | "string"
  | "bool"
  | "enum"
  | "vector3"
  | "ref"
  | "smp"
  | "smpList"
  | "numberList"
  | "stringList"
  | "caseValue";

/** One `visibleWhen` condition on another field of the same form. */
export interface VisibleRule {
  field: string;
  equals?: JsonValue;
  oneOf?: JsonValue[];
}

/**
 * A mesh field a declaration expects the OPEN MESH to carry (a nodal `DISTANCE`
 * for an embedded solver, say). Advisory by design: preflight reports it as a
 * warning and Generate neither writes nor refuses on it, because the field may
 * legitimately arrive another way (a file named in the form, a restart).
 */
export interface FieldRequirement {
  variable: string;
  /** 1 = scalar, 3 = vector. Any width when absent. */
  components?: 1 | 3;
  /** Association the field must live on. Any when absent. */
  kind?: import("../parser/types").FieldBlockKind;
  /** Overrides the default sentence in the finding. */
  message?: string;
}

/** A requirement that only applies while its form values satisfy `when` (all rules). */
export interface SectionFieldRequirement extends FieldRequirement {
  when?: VisibleRule | VisibleRule[];
}

export interface FieldSpec {
  id: string;
  label: string;
  type: FieldType;
  default?: JsonValue;
  /** Choices when type is "enum". */
  options?: { value: string; label?: string }[];
  /**
   * Show this field only when another field of the same form has a value:
   * `equals` for one value, `oneOf` for any of several (`equals` wins when both
   * are given). An array of rules means all of them must hold.
   */
  visibleWhen?: VisibleRule | VisibleRule[];
  /**
   * The unit this field's value is entered in, e.g. `"kg/m³"` or `"Pa·s"`.
   * Material presets convert into it (`materialCatalog.ts`); when it is absent
   * the unit is read from the label's brackets, then from a well-known Kratos
   * variable id, and a value whose unit cannot be established is never
   * converted — it is either an exact match or a refusal.
   */
  unit?: string;
  help?: string;
  /**
   * Id of one of the owning section's `groups`: the field is drawn inside that
   * collapsible sub-group instead of loose at the top of the section. Purely
   * presentational — the saved value stays at `values[section][field]`, so
   * regrouping a field never invalidates an existing case file.
   */
  group?: string;
  /** Advisory bounds for number/int inputs (the form clamps nothing it cannot explain). */
  min?: number;
  max?: number;
  step?: number;
  /** Draw the field under the section's collapsed "Advanced" group. */
  advanced?: boolean;
  /** For `type: "ref"`: the id of the collection whose entry names are the choices. */
  refCollection?: string;
}

/** A presentational sub-group of a section's fields (GiD's nested containers). */
export interface FieldGroupSpec {
  id: string;
  label: string;
  /** A toolbar icon id (`src/toolbarIcons.ts`); unknown ids draw no icon. */
  icon?: string;
  /** Start collapsed (default: expanded). */
  collapsed?: boolean;
}

export interface SectionSpec {
  id: string;
  label: string;
  fields: FieldSpec[];
  /** Optional collapsible sub-groups, in display order. */
  groups?: FieldGroupSpec[];
  /** A toolbar icon id drawn on the section header (default: the problemtype logo). */
  icon?: string;
  /** Mesh fields the section's current values need; see `FieldRequirement`. */
  requiresFields?: SectionFieldRequirement[];
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
 * One formulation's block names, for `FormulationMeshNaming.names`:
 * - a string with `{dim}` / `{nodes}` is a template ("SpringDamperElement{dim}D",
 *   "Membrane{dim}D{nodes}N"); without them it is that exact name at every
 *   shape ("CableElement3D2N");
 * - an object lists the exact name per domain size → nodes per cell
 *   ({3: {3: "ShellThinElementCorotational3D3N", 4: "…"}}). A shape the table
 *   does not list is one the formulation has no element for, so adapting such
 *   a block is refused — renaming it would invent a type Kratos lacks.
 */
export type MeshNamingEntry = string | { [dim: number]: { [nodes: number]: string } };

/**
 * Mesh names picked by a form field: the value of `field` (an enum of element
 * formulations, say) selects the entry under `names`. A value without an entry
 * keeps the legacy meaning — the value itself is a base name.
 */
export interface FormulationMeshNaming {
  field: string;
  names: { [value: string]: MeshNamingEntry };
}

/**
 * Expected mdpa block naming for the solver: per-kind target base name; the
 * final block name is `${base}${domainSize}D${nodesPerCell}N`. A plain string
 * applies to both domain sizes; the object form differs per size. Strings may
 * be "$field:<id>" (resolved against the flattened form values), letting e.g.
 * the structural formulation pick SmallDisplacementElement vs
 * TotalLagrangianElement. The `FormulationMeshNaming` form adds a per-value
 * table for formulations whose names no single base can describe.
 */
export interface MeshNamingSpec {
  elements?: string | { 2?: string; 3?: string } | FormulationMeshNaming;
  conditions?: string | { 2?: string; 3?: string } | FormulationMeshNaming;
}

/**
 * One block kind's resolved naming for a case (see `resolveMeshNaming`).
 * Exactly one of the three name sources is set:
 * - `base`: every shape is named `${base}${dim}D${nodes}N`;
 * - `template`: `{dim}`/`{nodes}` substituted per shape (verbatim without them);
 * - `shapes`: the only names the formulation has, keyed "3D4N" (the GiD
 *   convention) — a shape missing from the map has no name at all.
 * `source` is the field value (or base) the names came from, for messages.
 */
export interface ResolvedMeshKind {
  base?: string;
  template?: string;
  shapes?: { [shape: string]: string };
  source?: string;
}

/** The resolved meshNaming of a case, one entry per block kind (see `resolveMeshNaming`). */
export interface ResolvedMeshNaming {
  elements?: ResolvedMeshKind;
  conditions?: ResolvedMeshKind;
}

/** Hint for the SubModelPart picker; purely advisory in v1. */
export type ConditionTarget = "nodes" | "surface" | "volume" | "any";

/**
 * Which GiD-style tree branch a condition is listed under: the Conditions card
 * groups its picker and its applied rows by this. When a condition does not
 * say, `conditionCategory()` (layout.ts) derives it from the process list.
 */
export type ConditionCategory = "initial" | "constraints" | "loads" | "other";

/** The catalog's grouping of problemtypes in the dropdown. */
export type ProblemtypeFamily =
  | "solid"
  | "fluid"
  | "thermal"
  | "coupled"
  | "particles"
  | "reduced"
  | "optimization"
  | "workflow";

/**
 * One kind of entry a collection accepts: an optimization response may be a
 * mass or a strain energy, each with its own settings.
 */
export interface CollectionEntryTypeSpec {
  id: string;
  label: string;
  /** A toolbar icon id; unknown ids draw no icon. */
  icon?: string;
  help?: string;
  /** The entry's own settings. Ids are unique within the entry type. */
  fields: FieldSpec[];
  /**
   * The entry applies to SubModelParts (a control's design region). Absent
   * means the entry takes no parts. `min` defaults to 0, `max` to unlimited.
   */
  parts?: { label: string; target: ConditionTarget; min?: number; max?: number };
}

/** A default entry seeded into a fresh case (parts are never seeded: a default cannot know the mesh). */
export interface CollectionDefault {
  name: string;
  type: string;
  values?: Record<string, JsonValue>;
}

/**
 * A repeatable list of NAMED entries, each of one of several types. This is the
 * shape optimization setups (responses, controls, constraints) and ROM
 * parameter spaces have, and that sections and conditions cannot express: the
 * entries are referred to by name from elsewhere (`FieldSpec.refCollection`).
 */
export interface CollectionSpec {
  id: string;
  label: string;
  icon?: string;
  help?: string;
  entryTypes: CollectionEntryTypeSpec[];
  /** Fewest / most entries Generate accepts. */
  min?: number;
  max?: number;
  defaults?: CollectionDefault[];
}

/** One entry of a collection as the case stores it. */
export interface CollectionEntry {
  /** Unique within the collection; a valid identifier (`isValidEntryName`). */
  name: string;
  /** One of the collection's `entryTypes` ids. */
  type: string;
  /** Slash-separated SubModelPart paths. */
  parts: string[];
  values: Record<string, JsonValue>;
}

/** A collection entry as hooks see it: defaults merged in, parts also dotted. */
export interface ResolvedCollectionEntry extends CollectionEntry {
  /** `parts` as Kratos dotted model-part names under the root model part. */
  modelParts: string[];
}

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
  /** Tree branch (see `ConditionCategory`); derived from `list` when absent. */
  category?: ConditionCategory;
  /** A toolbar icon id drawn on the condition's rows; unknown ids draw none. */
  icon?: string;
  /**
   * The assignment only MARKS a SubModelPart (an FSI interface, say) for the
   * solver settings the problemtype's hooks derive: it is listed and validated
   * like any condition but emits no process entry.
   */
  noProcess?: boolean;
  /** Mesh fields every assignment of this condition expects; see `FieldRequirement`. */
  requiresFields?: FieldRequirement[];
}

/**
 * One physics domain of a coupled problemtype (GiD's FSI / CHT apps write one
 * mesh and one materials file per physics, plus ONE ProjectParameters). Each
 * domain owns some conditions and some material laws; Generate slices the
 * source mesh by the SubModelParts assigned in the domain and writes
 * `<stem>_<mdpaSuffix>.mdpa` for it.
 */
export interface DomainSpec {
  id: string;
  label: string;
  /** Root model part of this domain's mesh, e.g. "FluidModelPart". */
  modelPartName: string;
  /** The domain's mesh file is `<stem>_<mdpaSuffix>.mdpa`. */
  mdpaSuffix: string;
  /** Materials file of this domain; omit for a domain without materials. */
  materialsFileName?: string;
  /** The Parts-style condition whose assignments name this domain's computing parts. */
  partsCondition: string;
  /** Every condition this domain owns (its parts condition included). */
  conditionIds: string[];
  /** Conditions that need at least one assignment; Generate refuses without. */
  required?: { conditionId: string; message: string }[];
  /** Mesh block naming expected by this domain's solver. */
  meshNaming?: MeshNamingSpec;
  /**
   * Load interface of a coupled problemtype (only CoSimulation, today): the
   * assigned SubModelPart of `conditionId` stays the coupling destination,
   * while one 1-node point condition per interface node is emitted into a
   * sibling SubModelPart, so a transferred POINT_LOAD is assembled (the
   * interface face itself carries a surface condition reading PRESSURE /
   * SURFACE_LOAD). See `interfacePointLoad.ts` for why the sibling must not be
   * the interface part itself.
   */
  pointLoadInterface?: { conditionId: string };
}

export interface MaterialLawSpec {
  id: string;
  /** Kratos constitutive-law name; empty string omits the constitutive_law block. */
  name: string;
  variables: FieldSpec[];
  /** Restrict the law to one domain size (e.g. plane-strain laws). */
  domainSize?: 2 | 3;
  /** The `DomainSpec` this law belongs to (coupled problemtypes only). */
  domain?: string;
  /**
   * Kratos application the law's name (or the factory it configures) comes
   * from — `ConstitutiveLawsApplication` for the CLApp factories. A materials
   * file carries no module path, so the document scan cannot see it: Generate
   * requires the application of every law an assignment actually uses.
   */
  application?: string;
  /**
   * Materials-form heading the law is listed under (the picker's `<optgroup>`).
   * Laws without one are listed first, in declaration order.
   */
  group?: string;
  /**
   * Extra keys of the generated `constitutive_law` block, written as they are:
   * the ConstitutiveLawsApplication factories' settings (`law_type`,
   * `yield_surface`, `plastic_potential`). `name` stays the law's own name.
   */
  parameters?: JsonObject;
  /**
   * Offer the law only while the case values satisfy these rules (an element
   * formulation or solver whose constitutive law set this law belongs to). The
   * form hides it; Generate refuses an assignment that still names it, so the
   * laws never silently change meaning when the setup does.
   */
  when?: VisibleRule | VisibleRule[];
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
  /** Catalog grouping (`<optgroup>`); absent entries are listed under "Other". */
  family?: ProblemtypeFamily;
  /**
   * Optional alternate editor for this problemtype. The default (undefined)
   * renders the declarative sidebar forms. `"flowgraph"` instead embeds the
   * Kratos Flowgraph node editor in a split pane (the sidebar forms are hidden);
   * see webview/flowgraphPane.ts + src/flowgraphController.ts.
   */
  view?: "flowgraph";
  /** e.g. "KratosMultiphysics.StructuralMechanicsApplication.structural_mechanics_analysis" */
  analysisStage: string;
  /** Root model part, e.g. "Structure" | "FluidModelPart" | "ThermalModelPart". */
  modelPartName: string;
  /** e.g. "StructuralMaterials.json" */
  materialsFileName: string;
  /**
   * The solver's primary document, written next to the mesh. Absent means
   * "ProjectParameters.json", which every single-physics problemtype uses; a
   * problemtype whose primary document has another shape (a CoSimulation config)
   * names its own.
   */
  primaryDocumentName?: string;
  /** The driver script the run launches. Absent means "MainKratos.py". */
  driverScriptName?: string;
  /**
   * Which shipped driver a problemtype without a `mainScript` hook gets:
   * `"standard"` (MainKratos.py with the cooperative stop, the default), `"fsi"`
   * (FsiAnalysis, recording coupling iterations) or `"cosim"`
   * (CoSimulationAnalysis reading `primaryDocumentName`, recording coupling
   * iterations). Plain data, so a Python or JS problemtype can name the same
   * driver text the built-in uses.
   */
  driverTemplate?: DriverTemplate;
  /**
   * Kratos applications the case needs beyond what the generator can see: the
   * analysis stage's application and every application named in the generated
   * documents (`kratos_module`, `"LinearSolversApplication.sparse_lu"`…) are
   * found automatically. An entry may carry a `when` rule over the section
   * values (MeshMovingApplication only when ALE is on). The driver checks the
   * union before running and the run path probes it before launching.
   */
  applications?: RequiredApplication[];
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
   * Physics domains of a coupled problemtype. When present, every domain has its
   * own parts condition, mesh file and materials file, and the generator builds
   * each condition's process against its domain's model part (`$path` resolves
   * to the domain's `modelPartName`). `partsCondition` is then only the first
   * domain's, kept for callers that know one domain.
   */
  domains?: DomainSpec[];
  /**
   * Coupling interfaces of a coupled problemtype: pairs of `noProcess`
   * conditions, one per domain (fluid side, structure side). Generate pairs
   * their assignments by order and refuses a count mismatch, a side without
   * boundary cells of the right dimension, or a pair that does not overlap.
   */
  couplingInterfaces?: CouplingInterfaceSpec[];
  /** Repeatable named-entry lists (see `CollectionSpec`), drawn as the "Setup" stage. */
  collections?: CollectionSpec[];
  /**
   * The element/condition block names this solver expects in the mdpa. When
   * set, Generate writes an adapted `<stem>_case.mdpa` copy whenever the
   * mesh's names differ and points input_filename at it.
   */
  meshNaming?: MeshNamingSpec;
  output: OutputSpec;
}

/** One coupling interface: the label refusals use and its two side conditions. */
export interface CouplingInterfaceSpec {
  label: string;
  sides: [string, string];
}

/** A required Kratos application, optionally only when a rule over the values holds. */
/** The shipped drivers a declaration can name (see `ProblemtypeDeclaration.driverTemplate`). */
export type DriverTemplate = "standard" | "fsi" | "cosim";

export type RequiredApplication = string | { application: string; when?: VisibleRule | VisibleRule[] };

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
  /**
   * The catalog row this material was filled from, snapshotted: `values` are
   * the RESOLVED numbers (units converted, kinematic viscosity derived), so a
   * case keeps working — and keeps saying where it got them — after the library
   * entry is edited or deleted. Absent on a material typed by hand, and on
   * every case written before the catalog existed.
   */
  preset?: MaterialPresetSnapshot;
}

export interface OutputState {
  format: "ascii" | "binary";
  controlType: "step" | "time";
  interval: number;
  nodalVariables: string[];
  /**
   * Extensions (`".xdmf"`, `".exo"`, …) the finished run's `vtk_output` frames are
   * also converted to through meshio++. Absent or empty means no conversion.
   */
  exportFormats?: string[];
  /** Folder for the converted files, relative to the case folder (default `converted`). */
  exportFolder?: string;
}

/** The user's whole case setup — persisted as `<stem>.kratoscase.json`. */
export interface CaseState {
  /** Optional explicit Kratos output-process settings, preserved by headless workflows. */
  outputProcesses?: JsonObject;
  version: 1;
  problemtypeId: string;
  /** sectionId → fieldId → value. */
  values: Record<string, Record<string, JsonValue>>;
  assignments: Assignment[];
  materials: MaterialAssignment[];
  output: OutputState;
  /** collectionId → entries, for a problemtype that declares `collections`. */
  collections?: Record<string, CollectionEntry[]>;
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
  /**
   * The case's output settings (format, control, nodal variables). A composed
   * problemtype that writes its own participant documents passes them on, so each
   * document keeps the case's output choice. Absent on a context built by hand.
   */
  output?: CaseState["output"];
  /**
   * Per-domain contexts of a coupled problemtype, keyed by `DomainSpec.id`: the
   * domain's own model part, mesh stem, materials file and assignment lists.
   * Absent for a single-physics problemtype.
   */
  domains?: Record<string, DomainContext>;
  /** collectionId → entries with defaults merged in; `{}` when none are declared. */
  collections?: Record<string, ResolvedCollectionEntry[]>;
}

/** A `GenContext` narrowed to one physics domain (no nesting). */
export type DomainContext = Omit<GenContext, "domains">;

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
  /**
   * Extra files written next to the case (e.g. a second materials file). The
   * already-built materials document is passed so a file can be derived from it.
   */
  extraFiles?(
    ctx: GenContext,
    materials: JsonObject
  ): { name: string; content: string }[] | Promise<{ name: string; content: string }[]>;
  /**
   * Problems that make the case ungeneratable (a coupling interface with no
   * counterpart…), returned as messages naming what to fix. Generate refuses on
   * any; `case_validate` lists them. Return an empty array when the case is fine.
   */
  validate?(ctx: GenContext): string[] | Promise<string[]>;
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
  extraFiles(ctx: GenContext, materials: JsonObject): Promise<{ name: string; content: string }[]>;
  validate(ctx: GenContext): Promise<string[]>;
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
  /** Further files to write beside the case: other domains' materials, hook-provided files. */
  extraFiles: { name: string; content: string }[];
  warnings: string[];
  /** The file name `projectParameters` is written under (the declaration's, else ProjectParameters.json). */
  primaryDocumentName: string;
  /** The file name `mainScript` is written under and the run launches (else MainKratos.py). */
  driverScriptName: string;
  /** The Kratos applications the case needs (sorted); the driver checks them first. */
  applications: string[];
}
