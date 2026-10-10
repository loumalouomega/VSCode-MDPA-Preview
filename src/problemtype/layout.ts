/**
 * Presentation decisions for the Problemtype sidebar, kept below the DOM line
 * so they are Node-testable (`webview/` is not): how a section's fields fall
 * into groups, which tree branch a condition is listed under, and how the
 * catalog dropdown is grouped. The vocabulary mirrors GiD's data tree
 * (Parts → Initial conditions → Boundary conditions → Loads → Solution).
 *
 * Pure module: no vscode / DOM imports. Everything here is presentational —
 * none of it changes what is saved in `<stem>.kratoscase.json` or generated.
 */

import type {
  Assignment,
  ConditionCategory,
  ConditionSpec,
  FieldGroupSpec,
  FieldSpec,
  ProblemtypeDeclaration,
  ProblemtypeFamily,
  SectionSpec,
} from "./types";

/** Display order and chrome of the condition branches. */
export const CONDITION_CATEGORIES: { id: ConditionCategory; label: string; icon: string }[] = [
  { id: "initial", label: "Initial conditions", icon: "ptInitial" },
  { id: "constraints", label: "Boundary conditions", icon: "ptConstraint" },
  { id: "loads", label: "Loads", icon: "ptLoad" },
  { id: "other", label: "Other processes", icon: "condition" },
];

/** Display order and labels of the catalog's `<optgroup>`s. */
export const FAMILIES: { id: ProblemtypeFamily | "other"; label: string }[] = [
  { id: "solid", label: "Solids & structures" },
  { id: "fluid", label: "Fluids" },
  { id: "thermal", label: "Thermal" },
  { id: "coupled", label: "Coupled physics" },
  { id: "particles", label: "Particles & granular" },
  { id: "workflow", label: "Workflow" },
  { id: "other", label: "Other" },
];

/**
 * The tree branch a condition is listed under: its own `category`, else
 * derived from the process list the way GiD files its processes. Custom lists
 * (ShallowWater's `boundary_conditions_process_list`) are matched by name.
 */
export function conditionCategory(cond: Pick<ConditionSpec, "category" | "list">): ConditionCategory {
  if (cond.category) return cond.category;
  const list = String(cond.list).toLowerCase();
  if (list === "constraints_process_list") return "constraints";
  if (list === "loads_process_list") return "loads";
  if (list.includes("initial")) return "initial";
  if (list.includes("boundary") || list.includes("constraint")) return "constraints";
  if (list.includes("load")) return "loads";
  return "other";
}

export interface ConditionBranch {
  category: ConditionCategory;
  label: string;
  icon: string;
  conditions: ConditionSpec[];
}

/**
 * The declaration's conditions split into non-empty branches in tree order.
 * The Parts pseudo-condition is not a branch member: it has its own card.
 */
export function groupConditions(decl: Pick<ProblemtypeDeclaration, "conditions" | "partsCondition">): ConditionBranch[] {
  const branches: ConditionBranch[] = CONDITION_CATEGORIES.map((c) => ({ ...c, category: c.id, conditions: [] }));
  for (const cond of decl.conditions) {
    if (cond.id === decl.partsCondition) continue;
    const branch = branches.find((b) => b.category === conditionCategory(cond));
    branch?.conditions.push(cond);
  }
  return branches.filter((b) => b.conditions.length > 0);
}

/** Number of applied assignments per branch (conditions the declaration lost count as "other"). */
export function countByCategory(
  decl: Pick<ProblemtypeDeclaration, "conditions" | "partsCondition">,
  assignments: Pick<Assignment, "conditionId">[]
): Record<ConditionCategory, number> {
  const out: Record<ConditionCategory, number> = { initial: 0, constraints: 0, loads: 0, other: 0 };
  for (const a of assignments) {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    if (!cond || cond.id === decl.partsCondition) continue;
    out[conditionCategory(cond)] += 1;
  }
  return out;
}

/** Whether a field's `visibleWhen` rule(s) are satisfied by the form's current values. */
export function isFieldVisible(
  f: Pick<FieldSpec, "visibleWhen">,
  values: Record<string, unknown>
): boolean {
  const rules = f.visibleWhen === undefined ? [] : Array.isArray(f.visibleWhen) ? f.visibleWhen : [f.visibleWhen];
  return rules.every((rule) => {
    const current = values[rule.field];
    if (rule.equals !== undefined) return current === rule.equals;
    if (Array.isArray(rule.oneOf)) return rule.oneOf.some((v) => v === current);
    return true;
  });
}

export interface FieldGroup {
  spec: FieldGroupSpec;
  fields: FieldSpec[];
}

export interface SectionLayout {
  /** Fields with no group, drawn first and un-nested. */
  loose: FieldSpec[];
  /** Declared groups that hold at least one field, in declaration order. */
  groups: FieldGroup[];
  /** `advanced` fields without a group, drawn under one collapsed group. */
  advanced: FieldSpec[];
}

/**
 * Splits a section's fields for drawing. A field naming a group that does not
 * exist stays loose (validateDeclaration refuses that for authored
 * problemtypes; this keeps a hand-edited catalog from dropping a field).
 */
export function groupSectionFields(section: Pick<SectionSpec, "fields" | "groups">): SectionLayout {
  const declared = Array.isArray(section.groups) ? section.groups : [];
  const byId = new Map<string, FieldGroup>(declared.map((g) => [g.id, { spec: g, fields: [] }]));
  const loose: FieldSpec[] = [];
  const advanced: FieldSpec[] = [];
  for (const f of section.fields) {
    const target = f.group !== undefined ? byId.get(f.group) : undefined;
    if (target) target.fields.push(f);
    else if (f.advanced) advanced.push(f);
    else loose.push(f);
  }
  return { loose, groups: [...byId.values()].filter((g) => g.fields.length > 0), advanced };
}

/** One catalog `<optgroup>`: `indices` point into the entries passed in. */
export interface CatalogGroup {
  id: string;
  label: string;
  indices: number[];
}

/**
 * Groups catalog entries by family for the dropdown. Entries that failed to
 * load (no declaration) go last in their own "Could not load" group so a
 * broken workspace file is visible but never mixed with working ones.
 */
export function catalogGroups(entries: { decl?: Pick<ProblemtypeDeclaration, "family"> }[]): CatalogGroup[] {
  const groups: CatalogGroup[] = FAMILIES.map((f) => ({ id: f.id, label: f.label, indices: [] }));
  const failed: CatalogGroup = { id: "failed", label: "Could not load", indices: [] };
  entries.forEach((e, i) => {
    if (!e.decl) {
      failed.indices.push(i);
      return;
    }
    const family = e.decl.family ?? "other";
    (groups.find((g) => g.id === family) ?? groups[groups.length - 1]).indices.push(i);
  });
  return [...groups, failed].filter((g) => g.indices.length > 0);
}

/**
 * The short status chips under the problemtype header, e.g.
 * `["2 conditions", "1 material"]`. Pure counting — never a verdict on whether
 * the case is complete, which only generation can say.
 */
export function summaryChips(
  decl: Pick<ProblemtypeDeclaration, "conditions" | "partsCondition">,
  state: { assignments: Pick<Assignment, "conditionId">[]; materials: unknown[] }
): string[] {
  const parts = state.assignments.filter((a) => a.conditionId === decl.partsCondition).length;
  const others = state.assignments.length - parts;
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [
    plural(parts, "domain part", "domain parts"),
    plural(others, "condition", "conditions"),
    plural(state.materials.length, "material", "materials"),
  ];
}
