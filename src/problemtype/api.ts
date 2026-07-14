/**
 * The problemtype authoring API: defineProblemtype() validates a declaration,
 * fills in the default hook behaviour (template resolution, the shared
 * MainKratos.py) and returns the ProblemtypeRuntime the generator consumes.
 * Also home to the pure helpers shared by the generator and the loaders.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import {
  Assignment,
  CaseState,
  ConditionSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProblemtypeDeclaration,
  ProblemtypeHooks,
  ProblemtypeRuntime,
  ProblemtypeSource,
} from "./types";
import { MAIN_KRATOS_PY } from "./mainKratosTemplate";

const FIELD_TYPES = new Set(["number", "int", "string", "bool", "enum", "vector3"]);
const TARGETS = new Set(["nodes", "surface", "volume", "any"]);

/** The GiD-standard process lists, always present in the generated document. */
export const STANDARD_PROCESS_LISTS = [
  "constraints_process_list",
  "loads_process_list",
  "list_other_processes",
] as const;

/** Validates a declaration; returns a list of human-readable problems (empty = ok). */
export function validateDeclaration(decl: ProblemtypeDeclaration): string[] {
  const errors: string[] = [];
  const req = (v: unknown, what: string): void => {
    if (typeof v !== "string" || v.length === 0) errors.push(`missing ${what}`);
  };
  req(decl.id, "id");
  req(decl.name, "name");
  req(decl.analysisStage, "analysisStage");
  req(decl.modelPartName, "modelPartName");
  req(decl.materialsFileName, "materialsFileName");
  if (!Array.isArray(decl.domainSizes) || decl.domainSizes.length === 0 ||
    !decl.domainSizes.every((d) => d === 2 || d === 3)) {
    errors.push("domainSizes must be a non-empty array of 2 | 3");
  }
  const fieldIds = new Set<string>();
  const checkFields = (fields: FieldSpec[], where: string, globalUnique: boolean): void => {
    const local = new Set<string>();
    for (const f of Array.isArray(fields) ? fields : []) {
      if (!f || typeof f.id !== "string" || f.id.length === 0) {
        errors.push(`${where}: field without id`);
        continue;
      }
      if (!FIELD_TYPES.has(f.type)) errors.push(`${where}: field "${f.id}" has unknown type "${f.type}"`);
      if (f.type === "enum" && (!Array.isArray(f.options) || f.options.length === 0)) {
        errors.push(`${where}: enum field "${f.id}" needs options`);
      }
      const seen = globalUnique ? fieldIds : local;
      if (seen.has(f.id)) errors.push(`${where}: duplicate field id "${f.id}"`);
      seen.add(f.id);
    }
  };
  for (const s of Array.isArray(decl.sections) ? decl.sections : []) {
    // Section fields must be globally unique: the generator flattens them.
    checkFields(s.fields, `section "${s.id}"`, true);
  }
  const condIds = new Set<string>();
  for (const c of Array.isArray(decl.conditions) ? decl.conditions : []) {
    if (!c || typeof c.id !== "string" || c.id.length === 0) {
      errors.push("condition without id");
      continue;
    }
    if (condIds.has(c.id)) errors.push(`duplicate condition id "${c.id}"`);
    condIds.add(c.id);
    // Custom list names are allowed (e.g. boundary_conditions_process_list).
    if (typeof c.list !== "string" || c.list.length === 0) {
      errors.push(`condition "${c.id}": missing process list`);
    }
    if (!TARGETS.has(c.target)) errors.push(`condition "${c.id}": unknown target "${c.target}"`);
    if (!c.processTemplate || typeof c.processTemplate !== "object") {
      errors.push(`condition "${c.id}": missing processTemplate`);
    }
    checkFields(c.fields, `condition "${c.id}"`, false);
  }
  const lawIds = new Set<string>();
  for (const l of Array.isArray(decl.materialLaws) ? decl.materialLaws : []) {
    if (!l || typeof l.id !== "string" || l.id.length === 0) {
      errors.push("material law without id");
      continue;
    }
    if (lawIds.has(l.id)) errors.push(`duplicate material law id "${l.id}"`);
    lawIds.add(l.id);
    checkFields(l.variables, `material law "${l.id}"`, false);
  }
  if (decl.partsCondition !== undefined && !condIds.has(decl.partsCondition)) {
    errors.push(`partsCondition "${decl.partsCondition}" is not a condition id`);
  }
  if (!decl.output || !Array.isArray(decl.output.nodalDefaults)) {
    errors.push("output.nodalDefaults must be an array");
  }
  if (decl.view !== undefined && decl.view !== "flowgraph") {
    errors.push(`unknown view "${decl.view}" (only "flowgraph" is supported)`);
  }
  if (decl.meshNaming !== undefined) {
    if (typeof decl.meshNaming !== "object" || decl.meshNaming === null) {
      errors.push("meshNaming must be an object");
    } else {
      for (const kind of ["elements", "conditions"] as const) {
        const value = decl.meshNaming[kind];
        if (value === undefined) continue;
        const bases = typeof value === "string" ? [value] : [value[2], value[3]];
        if (typeof value !== "string" && typeof value !== "object") {
          errors.push(`meshNaming.${kind} must be a string or a {2,3} object`);
        } else if (!bases.some((b) => typeof b === "string" && b.length > 0)) {
          errors.push(`meshNaming.${kind}: no base name given`);
        } else if (bases.some((b) => b !== undefined && (typeof b !== "string" || b.length === 0))) {
          errors.push(`meshNaming.${kind}: base names must be non-empty strings`);
        }
      }
    }
  }
  return errors;
}

/**
 * Resolves the declaration's meshNaming for one case: picks the per-size
 * variant and substitutes "$field:<id>" from the flattened values.
 */
export function resolveMeshNaming(
  decl: ProblemtypeDeclaration,
  values: Record<string, JsonValue>,
  domainSize: 2 | 3
): { elements?: string; conditions?: string } {
  const out: { elements?: string; conditions?: string } = {};
  if (!decl.meshNaming) return out;
  for (const kind of ["elements", "conditions"] as const) {
    const spec = decl.meshNaming[kind];
    if (spec === undefined) continue;
    let base = typeof spec === "string" ? spec : spec[domainSize];
    if (base === undefined) continue;
    if (base.startsWith("$field:")) {
      const v = values[base.slice("$field:".length)];
      base = typeof v === "string" && v.length > 0 ? v : undefined;
    }
    if (base) out[kind] = base;
  }
  return out;
}

/** Kratos dotted model-part name for a slash-separated SubModelPart path. */
export function dottedModelPart(root: string, smpPath: string): string {
  return `${root}.${smpPath.split("/").join(".")}`;
}

/** The default value for a field spec (type-appropriate zero when unset). */
export function fieldDefault(f: FieldSpec): JsonValue {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case "number":
    case "int":
      return 0;
    case "bool":
      return false;
    case "vector3":
      return [0, 0, 0];
    case "enum":
      return f.options && f.options.length > 0 ? f.options[0].value : "";
    default:
      return "";
  }
}

/** Merges the declaration's field defaults with the case's per-section values. */
export function flattenValues(
  decl: ProblemtypeDeclaration,
  state: CaseState
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const s of decl.sections) {
    const section = state.values[s.id] ?? {};
    for (const f of s.fields) {
      out[f.id] = section[f.id] !== undefined ? section[f.id] : fieldDefault(f);
    }
  }
  return out;
}

/** A fresh CaseState with every field at its declared default. */
export function defaultCaseState(decl: ProblemtypeDeclaration): CaseState {
  const values: Record<string, Record<string, JsonValue>> = {};
  for (const s of decl.sections) {
    values[s.id] = {};
    for (const f of s.fields) values[s.id][f.id] = fieldDefault(f);
  }
  return {
    version: 1,
    problemtypeId: decl.id,
    values,
    assignments: [],
    materials: [],
    output: {
      format: "ascii",
      controlType: "step",
      interval: 1,
      nodalVariables: [...decl.output.nodalDefaults],
    },
  };
}

/**
 * Resolves a condition's processTemplate for one assignment: deep-clones the
 * template, replacing string leaves that are exactly "$path", "$root" or
 * "$field:<id>" ($field falls back to the field's declared default).
 */
export function resolveProcessTemplate(
  cond: ConditionSpec,
  a: Assignment,
  ctx: GenContext
): JsonObject {
  const fieldValue = (id: string): JsonValue => {
    if (a.values[id] !== undefined) return a.values[id];
    const spec = cond.fields.find((f) => f.id === id);
    return spec ? fieldDefault(spec) : null;
  };
  const resolve = (v: JsonValue): JsonValue => {
    if (typeof v === "string") {
      if (v === "$path") return dottedModelPart(ctx.modelPartName, a.smpPath);
      if (v === "$root") return ctx.modelPartName;
      if (v.startsWith("$field:")) return fieldValue(v.slice("$field:".length));
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") {
      const out: JsonObject = {};
      for (const [k, val] of Object.entries(v)) out[k] = resolve(val);
      return out;
    }
    return v;
  };
  return resolve(cond.processTemplate) as JsonObject;
}

/**
 * The authoring entry point: validates the declaration (throws on problems so
 * a broken problemtype fails at load, not at generate time) and normalizes the
 * hooks into the async ProblemtypeRuntime shape.
 */
export function defineProblemtype(
  decl: ProblemtypeDeclaration,
  hooks: ProblemtypeHooks,
  source: ProblemtypeSource = "builtin"
): ProblemtypeRuntime {
  const errors = validateDeclaration(decl);
  if (errors.length > 0) {
    throw new Error(`Invalid problemtype "${decl?.id ?? "?"}": ${errors.join("; ")}`);
  }
  if (typeof hooks?.solverSettings !== "function") {
    throw new Error(`Invalid problemtype "${decl.id}": hooks.solverSettings is required`);
  }
  return {
    decl,
    source,
    solverSettings: async (values, ctx) => hooks.solverSettings(values, ctx),
    buildProcess: async (cond, a, ctx) => {
      const custom = hooks.buildProcess ? await hooks.buildProcess(cond, a, ctx) : undefined;
      return custom ?? resolveProcessTemplate(cond, a, ctx);
    },
    postProcess: async (pp, ctx) => (hooks.postProcess ? hooks.postProcess(pp, ctx) : pp),
    mainScript: async (ctx) => (hooks.mainScript ? hooks.mainScript(ctx) : MAIN_KRATOS_PY),
  };
}

/** Coercion helpers for hook authors reading flattened values. */
export function asNum(v: JsonValue | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
export function asStr(v: JsonValue | undefined, dflt: string): string {
  return typeof v === "string" && v.length > 0 ? v : dflt;
}
export function asBool(v: JsonValue | undefined, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}
