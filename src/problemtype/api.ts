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
  FormulationMeshNaming,
  GenContext,
  JsonObject,
  JsonValue,
  MeshNamingEntry,
  ProblemtypeDeclaration,
  ProblemtypeHooks,
  ProblemtypeRuntime,
  ProblemtypeSource,
  ResolvedMeshNaming,
} from "./types";
import { meshShapeKey } from "./meshNaming";
import { DRIVER_TEMPLATES, driverTemplateScript } from "./mainKratosTemplate";
import { APPLICATION_NAME, applicationDeclarationProblems } from "./applications";
import { couplingInterfaceDeclarationProblems } from "./interfaceCheck";

const FIELD_TYPES = new Set([
  "number", "int", "string", "bool", "enum", "vector3",
  "ref", "smp", "smpList", "numberList", "stringList", "caseValue",
]);
const TARGETS = new Set(["nodes", "surface", "volume", "any"]);
const CATEGORIES = new Set(["initial", "constraints", "loads", "other"]);
const FAMILIES = new Set(["solid", "fluid", "thermal", "coupled", "particles", "reduced", "optimization", "workflow"]);

/** The GiD-standard process lists, always present in the generated document. */
export const STANDARD_PROCESS_LISTS = [
  "constraints_process_list",
  "loads_process_list",
  "list_other_processes",
] as const;

/**
 * Validates one `MeshNamingEntry`: a template/verbatim name, or a shape table
 * of exact names (no placeholders in there — a table lists Kratos types).
 */
function checkMeshNames(entry: unknown, where: string, errors: string[]): void {
  if (typeof entry === "string") {
    if (entry.length === 0) errors.push(`${where}: empty name`);
    else if (entry.replace(/\{dim\}|\{nodes\}/g, "").includes("{")) {
      errors.push(`${where}: only {dim} and {nodes} placeholders are allowed ("${entry}")`);
    }
    return;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    errors.push(`${where}: must be a name or a {dim: {nodes: name}} table`);
    return;
  }
  const dims = Object.entries(entry as Record<string, unknown>);
  if (dims.length === 0) errors.push(`${where}: the shape table is empty`);
  for (const [dim, byNodes] of dims) {
    if (dim !== "2" && dim !== "3") {
      errors.push(`${where}: domain-size keys must be 2 or 3 (got "${dim}")`);
      continue;
    }
    if (typeof byNodes !== "object" || byNodes === null || Array.isArray(byNodes)) {
      errors.push(`${where}.${dim}: must map node counts to names`);
      continue;
    }
    const counts = Object.entries(byNodes as Record<string, unknown>);
    if (counts.length === 0) errors.push(`${where}.${dim}: no shapes given`);
    for (const [nodes, name] of counts) {
      if (!/^[1-9][0-9]*$/.test(nodes)) {
        errors.push(`${where}.${dim}: node counts must be positive integers (got "${nodes}")`);
      }
      if (typeof name !== "string" || name.length === 0) {
        errors.push(`${where}.${dim}: the name for "${nodes}" node(s) must be a non-empty string`);
      } else if (name.includes("{")) {
        errors.push(`${where}.${dim}: a shape table holds exact names, not templates ("${name}")`);
      }
    }
  }
}

/** Validates a `FormulationMeshNaming` against the declaration's enum fields. */
function checkFormulationMeshNaming(
  spec: FormulationMeshNaming,
  where: string,
  errors: string[],
  fields: Map<string, FieldSpec>
): void {
  const field = fields.get(spec.field);
  if (!field) errors.push(`${where}: field "${spec.field}" is not a section field`);
  else if (field.type !== "enum" || !field.options || field.options.length === 0) {
    errors.push(`${where}: field "${spec.field}" must be an enum of the formulations to table`);
  }
  if (typeof spec.names !== "object" || spec.names === null || Array.isArray(spec.names) || Object.keys(spec.names).length === 0) {
    errors.push(`${where}: "names" must map field values to names`);
    return;
  }
  const options = new Set((field?.options ?? []).map((o) => o.value));
  for (const [value, entry] of Object.entries(spec.names)) {
    if (field && !options.has(value)) errors.push(`${where}: "${value}" is not an option of "${spec.field}"`);
    checkMeshNames(entry, `${where}.${value}`, errors);
  }
}

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
  for (const [key, extension] of [["primaryDocumentName", ".json"], ["driverScriptName", ".py"]] as const) {
    const name = decl[key];
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name) || !name.endsWith(extension))) {
      errors.push(`${key} must be a plain file name ending in ${extension}`);
    }
  }
  if (decl.driverTemplate !== undefined && !(DRIVER_TEMPLATES as readonly string[]).includes(decl.driverTemplate)) {
    errors.push(`driverTemplate must be one of ${DRIVER_TEMPLATES.join(", ")}`);
  }
  if (!Array.isArray(decl.domainSizes) || decl.domainSizes.length === 0 ||
    !decl.domainSizes.every((d) => d === 2 || d === 3)) {
    errors.push("domainSizes must be a non-empty array of 2 | 3");
  }
  const fieldIds = new Set<string>();
  // Section fields by id: meshNaming formulation tables resolve through them.
  const fieldSpecs = new Map<string, FieldSpec>();
  const collectionIds = new Set(
    (Array.isArray(decl.collections) ? decl.collections : []).map((c) => c?.id).filter((id): id is string => typeof id === "string")
  );
  const checkFields = (fields: FieldSpec[], where: string, globalUnique: boolean, inCollection = false): void => {
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
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
        errors.push(`${where}: field "${f.id}" has min above max`);
      }
      if (f.type === "ref" && (typeof f.refCollection !== "string" || !collectionIds.has(f.refCollection))) {
        errors.push(`${where}: ref field "${f.id}" names unknown collection "${String(f.refCollection)}"`);
      }
      if (f.type === "caseValue" && !inCollection) {
        errors.push(`${where}: caseValue field "${f.id}" is only valid inside a collection entry type`);
      }
      const seen = globalUnique ? fieldIds : local;
      if (seen.has(f.id)) errors.push(`${where}: duplicate field id "${f.id}"`);
      seen.add(f.id);
      if (globalUnique) fieldSpecs.set(f.id, f);
    }
  };
  const checkRequirements = (reqs: unknown, where: string, sectionFields?: FieldSpec[]): void => {
    if (reqs === undefined) return;
    if (!Array.isArray(reqs)) { errors.push(`${where}: requiresFields must be an array`); return; }
    for (const r of reqs as Record<string, unknown>[]) {
      if (!r || typeof r.variable !== "string" || r.variable.length === 0) { errors.push(`${where}: field requirement without variable`); continue; }
      if (r.components !== undefined && r.components !== 1 && r.components !== 3) errors.push(`${where}: requirement "${r.variable}" components must be 1 or 3`);
      if (r.kind !== undefined && !["Nodal", "Elemental", "Conditional"].includes(r.kind as string)) errors.push(`${where}: requirement "${r.variable}" has unknown kind "${String(r.kind)}"`);
      if (r.message !== undefined && typeof r.message !== "string") errors.push(`${where}: requirement "${r.variable}" message must be a string`);
      if (r.when !== undefined) {
        if (!sectionFields) { errors.push(`${where}: requirement "${r.variable}": "when" is only valid on a section`); continue; }
        for (const rule of Array.isArray(r.when) ? r.when : [r.when]) {
          const field = (rule as { field?: unknown })?.field;
          if (typeof field !== "string" || !sectionFields.some((f) => f.id === field)) errors.push(`${where}: requirement "${r.variable}" "when" names unknown field "${String(field)}"`);
        }
      }
    }
  };
  for (const s of Array.isArray(decl.sections) ? decl.sections : []) {
    // Section fields must be globally unique: the generator flattens them.
    checkFields(s.fields, `section "${s.id}"`, true);
    checkRequirements(s.requiresFields, `section "${s.id}"`, Array.isArray(s.fields) ? s.fields : []);
    // Groups are presentational, but a field naming one that does not exist
    // would silently drop out of the form — refuse it by name instead.
    const groupIds = new Set<string>();
    for (const g of Array.isArray(s.groups) ? s.groups : []) {
      if (!g || typeof g.id !== "string" || g.id.length === 0) {
        errors.push(`section "${s.id}": group without id`);
        continue;
      }
      if (groupIds.has(g.id)) errors.push(`section "${s.id}": duplicate group id "${g.id}"`);
      groupIds.add(g.id);
    }
    for (const f of Array.isArray(s.fields) ? s.fields : []) {
      if (f && f.group !== undefined && !groupIds.has(f.group)) {
        errors.push(`section "${s.id}": field "${f.id}" names unknown group "${f.group}"`);
      }
    }
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
    if (c.category !== undefined && !CATEGORIES.has(c.category)) {
      errors.push(`condition "${c.id}": unknown category "${c.category}"`);
    }
    if (c.emit !== undefined) {
      const e = c.emit;
      if (!e || typeof e.sibling !== "string" || e.sibling.length === 0) {
        errors.push(`condition "${c.id}": emit needs a non-empty sibling suffix`);
      }
      if (e.source !== "nodes" && e.source !== "lines") {
        errors.push(`condition "${c.id}": emit source must be "nodes" or "lines"`);
      }
      if (e.family !== "point" && e.family !== "moment" && e.family !== "moving") {
        errors.push(`condition "${c.id}": emit family must be "point", "moment" or "moving"`);
      }
      if (e.formulationField !== undefined && (typeof e.formulationField !== "string" || e.formulationField.length === 0)) {
        errors.push(`condition "${c.id}": emit formulationField must be a field id`);
      }
      if (e.axisymmetricPoint !== undefined && (typeof e.axisymmetricPoint !== "string" || e.axisymmetricPoint.length === 0)) {
        errors.push(`condition "${c.id}": emit axisymmetricPoint must be a condition name`);
      }
      if (e.pointName !== undefined && (typeof e.pointName !== "string" || e.pointName.length === 0)) {
        errors.push(`condition "${c.id}": emit pointName must be a condition base name`);
      }
    }
    checkFields(c.fields, `condition "${c.id}"`, false);
    checkRequirements(c.requiresFields, `condition "${c.id}"`);
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
    if (l.application !== undefined && (typeof l.application !== "string" || !APPLICATION_NAME.test(l.application))) {
      errors.push(
        `material law "${l.id}": application must be a Kratos application name such as "ConstitutiveLawsApplication"`
      );
    }
    if (l.group !== undefined && (typeof l.group !== "string" || l.group.length === 0)) {
      errors.push(`material law "${l.id}": group must be a non-empty name`);
    }
    if (l.parameters !== undefined) {
      if (!l.parameters || typeof l.parameters !== "object" || Array.isArray(l.parameters)) {
        errors.push(`material law "${l.id}": parameters must be an object`);
      } else if ("name" in l.parameters) {
        errors.push(`material law "${l.id}": parameters may not set "name" (the law's name is its own)`);
      }
    }
    if (l.when !== undefined) {
      for (const rule of Array.isArray(l.when) ? l.when : [l.when]) {
        const field = (rule as { field?: unknown } | null)?.field;
        if (typeof field !== "string" || !fieldSpecs.has(field)) {
          errors.push(`material law "${l.id}": "when" names unknown field "${String(field)}"`);
        }
      }
    }
  }
  if (decl.domains !== undefined) {
    if (!Array.isArray(decl.domains) || decl.domains.length === 0) {
      errors.push("domains must be a non-empty array");
    } else {
      const domainIds = new Set<string>();
      const suffixes = new Set<string>();
      const files = new Set<string>();
      const owner = new Map<string, string>();
      for (const d of decl.domains) {
        if (!d || typeof d.id !== "string" || d.id.length === 0) {
          errors.push("domain without id");
          continue;
        }
        if (domainIds.has(d.id)) errors.push(`duplicate domain id "${d.id}"`);
        domainIds.add(d.id);
        for (const key of ["label", "modelPartName", "mdpaSuffix", "partsCondition"] as const) {
          if (typeof d[key] !== "string" || d[key].length === 0) errors.push(`domain "${d.id}": missing ${key}`);
        }
        if (suffixes.has(d.mdpaSuffix)) errors.push(`domain "${d.id}": mdpaSuffix "${d.mdpaSuffix}" is used twice`);
        suffixes.add(d.mdpaSuffix);
        if (d.materialsFileName !== undefined) {
          if (files.has(d.materialsFileName)) errors.push(`domain "${d.id}": materials file "${d.materialsFileName}" is used twice`);
          files.add(d.materialsFileName);
        }
        const owned = Array.isArray(d.conditionIds) ? d.conditionIds : [];
        if (!owned.includes(d.partsCondition)) errors.push(`domain "${d.id}": partsCondition is not among its conditionIds`);
        for (const cid of owned) {
          if (!condIds.has(cid)) errors.push(`domain "${d.id}": unknown condition "${cid}"`);
          else if (owner.has(cid)) errors.push(`condition "${cid}" belongs to both domain "${owner.get(cid)}" and "${d.id}"`);
          else owner.set(cid, d.id);
        }
        for (const r of d.required ?? []) {
          if (!owned.includes(r.conditionId)) errors.push(`domain "${d.id}": required condition "${r.conditionId}" is not one of its conditions`);
        }
      }
      for (const l of decl.materialLaws) {
        if (l.domain !== undefined && !domainIds.has(l.domain)) errors.push(`material law "${l.id}": unknown domain "${l.domain}"`);
      }
    }
  }
  errors.push(...applicationDeclarationProblems(decl.applications));
  errors.push(...couplingInterfaceDeclarationProblems(decl));
  if (decl.collections !== undefined) {
    if (!Array.isArray(decl.collections)) {
      errors.push("collections must be an array");
    } else {
      const seenCollections = new Set<string>();
      for (const c of decl.collections) {
        if (!c || typeof c.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.id)) {
          errors.push(`collection id "${String(c?.id)}" must be an identifier`);
          continue;
        }
        if (seenCollections.has(c.id)) errors.push(`duplicate collection id "${c.id}"`);
        seenCollections.add(c.id);
        if (typeof c.label !== "string" || c.label.length === 0) errors.push(`collection "${c.id}": missing label`);
        if (c.min !== undefined && c.max !== undefined && c.min > c.max) errors.push(`collection "${c.id}": min above max`);
        const typeIds = new Set<string>();
        if (!Array.isArray(c.entryTypes) || c.entryTypes.length === 0) {
          errors.push(`collection "${c.id}": needs at least one entry type`);
          continue;
        }
        for (const t of c.entryTypes) {
          if (!t || typeof t.id !== "string" || t.id.length === 0) {
            errors.push(`collection "${c.id}": entry type without id`);
            continue;
          }
          if (typeIds.has(t.id)) errors.push(`collection "${c.id}": duplicate entry type "${t.id}"`);
          typeIds.add(t.id);
          checkFields(t.fields, `collection "${c.id}" type "${t.id}"`, false, true);
          if (t.parts !== undefined) {
            if (!TARGETS.has(t.parts.target)) errors.push(`collection "${c.id}" type "${t.id}": unknown parts target "${t.parts.target}"`);
            if (t.parts.min !== undefined && t.parts.max !== undefined && t.parts.min > t.parts.max) {
              errors.push(`collection "${c.id}" type "${t.id}": parts min above max`);
            }
          }
        }
        const defaultNames = new Set<string>();
        for (const d of Array.isArray(c.defaults) ? c.defaults : []) {
          if (!d || typeof d.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name)) {
            errors.push(`collection "${c.id}": default entry name "${String(d?.name)}" must be an identifier`);
          } else if (defaultNames.has(d.name)) errors.push(`collection "${c.id}": duplicate default "${d.name}"`);
          else defaultNames.add(d.name);
          if (d && !typeIds.has(d.type)) errors.push(`collection "${c.id}": default "${d.name}" has unknown type "${d.type}"`);
        }
      }
    }
  }
  if (decl.partsCondition !== undefined && !condIds.has(decl.partsCondition)) {
    errors.push(`partsCondition "${decl.partsCondition}" is not a condition id`);
  }
  if (!decl.output || !Array.isArray(decl.output.nodalDefaults)) {
    errors.push("output.nodalDefaults must be an array");
  }
  if (decl.family !== undefined && !FAMILIES.has(decl.family)) {
    errors.push(`unknown family "${decl.family}"`);
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
        if (typeof value === "string") {
          if (value.length === 0) errors.push(`meshNaming.${kind}: empty name`);
          continue;
        }
        if (typeof value !== "object" || value === null) {
          errors.push(`meshNaming.${kind} must be a string, a {2,3} base object or a {field, names} table`);
          continue;
        }
        if ("field" in value) {
          if (typeof (value as { field?: unknown }).field !== "string") {
            errors.push(`meshNaming.${kind}: "field" must name a section field`);
          } else {
            checkFormulationMeshNaming(value as unknown as FormulationMeshNaming, `meshNaming.${kind}`, errors, fieldSpecs);
          }
          continue;
        }
        const bases = [(value as { 2?: string; 3?: string })[2], (value as { 2?: string; 3?: string })[3]];
        if (!bases.some((b) => typeof b === "string" && b.length > 0)) {
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
 * variant, substitutes "$field:<id>" from the flattened values, and turns a
 * formulation table into the selected formulation's entry.
 *
 * A kind is omitted when nothing selects it (no spec, or no value for the
 * driving field), which leaves its blocks untouched. A field value the table
 * has no entry for keeps the legacy meaning: the value itself is a base name.
 */
export function resolveMeshNaming(
  decl: ProblemtypeDeclaration,
  values: Record<string, JsonValue>,
  domainSize: 2 | 3
): ResolvedMeshNaming {
  const out: ResolvedMeshNaming = {};
  if (!decl.meshNaming) return out;
  for (const kind of ["elements", "conditions"] as const) {
    const spec = decl.meshNaming[kind];
    if (spec === undefined) continue;
    if (typeof spec === "object" && spec !== null && "field" in spec) {
      const formulation = spec as FormulationMeshNaming;
      const v = values[formulation.field];
      const source = typeof v === "string" && v.length > 0 ? v : undefined;
      if (source === undefined) continue;
      const entry = formulation.names[source];
      if (typeof entry === "string") {
        // A template when it has {dim}/{nodes} placeholders; one exact name otherwise.
        out[kind] = { template: entry, source };
      } else if (entry !== undefined) {
        const shapes: { [shape: string]: string } = {};
        for (const [dim, byNodes] of Object.entries(entry)) {
          for (const [nodes, name] of Object.entries(byNodes)) {
            shapes[meshShapeKey(Number(dim) as 2 | 3, Number(nodes))] = name;
          }
        }
        out[kind] = { shapes, source };
      } else {
        out[kind] = { base: source, source };
      }
      continue;
    }
    let base = typeof spec === "string" ? spec : spec[domainSize];
    if (base === undefined) continue;
    if (base.startsWith("$field:")) {
      const v = values[base.slice("$field:".length)];
      base = typeof v === "string" && v.length > 0 ? v : undefined;
    }
    if (base) out[kind] = { base, source: base };
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
    case "smpList":
    case "numberList":
    case "stringList":
      return [];
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
  const state: CaseState = {
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
  if (decl.collections && decl.collections.length > 0) {
    state.collections = {};
    for (const c of decl.collections) {
      state.collections[c.id] = (c.defaults ?? []).map((d) => {
        const type = c.entryTypes.find((t) => t.id === d.type);
        const entryValues: Record<string, JsonValue> = {};
        for (const f of type?.fields ?? []) entryValues[f.id] = d.values?.[f.id] ?? fieldDefault(f);
        return { name: d.name, type: d.type, parts: [], values: entryValues };
      });
    }
  }
  return state;
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
    mainScript: async (ctx) => (hooks.mainScript ? hooks.mainScript(ctx) : driverTemplateScript(decl)),
    extraFiles: async (ctx, materials) => (hooks.extraFiles ? hooks.extraFiles(ctx, materials) : []),
    validate: async (ctx) => (hooks.validate ? hooks.validate(ctx) : []),
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
