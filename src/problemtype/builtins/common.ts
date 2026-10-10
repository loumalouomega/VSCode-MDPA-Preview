/**
 * Declaration fragments shared by the built-in problemtypes, mirroring what
 * GiDInterface repeats across its apps (apps/Common/xml/*.spd, Solvers.xml,
 * Processes.xml): the linear-solver choice, the condition → process builders
 * and the per-component `constrained` broadcast.
 *
 * Pure: no vscode / DOM imports.
 */

import { asBool, asNum, asStr, dottedModelPart, resolveProcessTemplate } from "../api";
import type {
  Assignment,
  ConditionCategory,
  ConditionSpec,
  FieldSpec,
  GenContext,
  JsonObject,
  JsonValue,
  ProcessList,
  ConditionTarget,
} from "../types";

/** The whole-simulation interval most processes use. */
export const TOTAL: JsonValue = [0.0, "End"];
/** GiD's "Initial" interval: the processes run only at the first step. */
export const INITIAL: JsonValue = [0.0, 0.0];

/** GiD's Common/Solvers.xml OpenMP standard solvers (Automatic is the default and writes nothing). */
export const LINEAR_SOLVER_OPTIONS = [
  { value: "automatic", label: "Automatic" },
  { value: "LinearSolversApplication.sparse_lu", label: "Sparse LU" },
  { value: "cg", label: "Conjugate gradients" },
  { value: "bicgstab", label: "BiCGStab" },
];

/** The "Linear solver" field group's fields, ids shared by every built-in that offers it. */
export function linearSolverFields(group: string): FieldSpec[] {
  const iterative = { field: "linearSolver", oneOf: ["cg", "bicgstab"] as JsonValue[] };
  return [
    {
      id: "linearSolver",
      label: "Solver",
      type: "enum",
      default: "automatic",
      options: LINEAR_SOLVER_OPTIONS,
      group,
      help: "Automatic lets Kratos pick the default solver of the selected strategy.",
    },
    { id: "linearMaxIteration", label: "Max iterations", type: "int", default: 200, min: 1, group, visibleWhen: iterative },
    { id: "linearTolerance", label: "Tolerance", type: "number", default: 1e-7, min: 0, group, visibleWhen: iterative },
    {
      id: "preconditioner",
      label: "Preconditioner",
      type: "enum",
      default: "none",
      options: [{ value: "none" }, { value: "diagonal" }, { value: "ilu" }, { value: "ilu0" }],
      group,
      visibleWhen: iterative,
    },
  ];
}

/**
 * `linear_solver_settings` for the chosen solver; undefined for Automatic (GiD
 * writes nothing then — `write::getSolversParametersDict` skips "Automatic*").
 */
export function linearSolverSettings(v: Record<string, JsonValue>): JsonObject | undefined {
  const solver = asStr(v.linearSolver, "automatic");
  if (solver === "automatic") return undefined;
  if (solver === "cg" || solver === "bicgstab") {
    return {
      solver_type: solver,
      max_iteration: asNum(v.linearMaxIteration, 200),
      tolerance: asNum(v.linearTolerance, 1e-7),
      preconditioner_type: asStr(v.preconditioner, "none"),
      scaling: false,
    };
  }
  return { solver_type: solver };
}

interface ConditionBase {
  id: string;
  label: string;
  target?: ConditionTarget;
  category?: ConditionCategory;
  icon?: string;
  help?: string;
  list?: ProcessList;
  interval?: JsonValue;
}

/** `AssignVectorVariableProcess` on nodes: value + a single Fixed checkbox broadcast per component. */
export function vectorConstraint(variable: string, o: ConditionBase & { unit?: string; fixed?: boolean }): ConditionSpec {
  return {
    id: o.id,
    label: o.label,
    list: o.list ?? "constraints_process_list",
    target: o.target ?? "any",
    category: o.category ?? "constraints",
    icon: o.icon,
    help: o.help,
    fields: [
      { id: "value", label: `Value${o.unit ? ` [${o.unit}]` : ""}`, type: "vector3", default: [0, 0, 0] },
      { id: "constrained", label: "Fixed", type: "bool", default: o.fixed ?? true },
    ],
    processTemplate: {
      python_module: "assign_vector_variable_process",
      kratos_module: "KratosMultiphysics",
      process_name: "AssignVectorVariableProcess",
      Parameters: {
        model_part_name: "$path",
        variable_name: variable,
        interval: o.interval ?? TOTAL,
        constrained: "$field:constrained",
        value: "$field:value",
      },
    },
  };
}

/** `AssignScalarVariableProcess` on nodes. */
export function scalarConstraint(
  variable: string,
  o: ConditionBase & { unit?: string; dflt?: number; fixed?: boolean }
): ConditionSpec {
  return {
    id: o.id,
    label: o.label,
    list: o.list ?? "constraints_process_list",
    target: o.target ?? "any",
    category: o.category ?? "constraints",
    icon: o.icon,
    help: o.help,
    fields: [
      { id: "value", label: `Value${o.unit ? ` [${o.unit}]` : ""}`, type: "number", default: o.dflt ?? 0 },
      { id: "constrained", label: "Fixed", type: "bool", default: o.fixed ?? true },
    ],
    processTemplate: {
      python_module: "assign_scalar_variable_process",
      kratos_module: "KratosMultiphysics",
      process_name: "AssignScalarVariableProcess",
      Parameters: {
        model_part_name: "$path",
        variable_name: variable,
        interval: o.interval ?? TOTAL,
        constrained: "$field:constrained",
        value: "$field:value",
      },
    },
  };
}

/** `AssignVectorByDirectionProcess` (a vector variable given as modulus × direction) on nodes. */
export function vectorByDirection(variable: string, o: ConditionBase & { unit?: string; dflt?: number; direction?: number[] }): ConditionSpec {
  return {
    id: o.id,
    label: o.label,
    list: o.list ?? "loads_process_list",
    target: o.target ?? "volume",
    category: o.category ?? "loads",
    icon: o.icon,
    help: o.help,
    fields: [
      { id: "modulus", label: `Modulus${o.unit ? ` [${o.unit}]` : ""}`, type: "number", default: o.dflt ?? 0 },
      { id: "direction", label: "Direction", type: "vector3", default: o.direction ?? [0, 0, -1] },
    ],
    processTemplate: {
      python_module: "assign_vector_by_direction_process",
      kratos_module: "KratosMultiphysics",
      process_name: "AssignVectorByDirectionProcess",
      Parameters: {
        model_part_name: "$path",
        variable_name: variable,
        modulus: "$field:modulus",
        constrained: false,
        direction: "$field:direction",
        interval: o.interval ?? TOTAL,
      },
    },
  };
}

/** `AssignVectorByDirectionToConditionProcess`: a vector load on Conditions (point/line/surface loads). */
export function vectorLoadOnConditions(variable: string, o: ConditionBase & { unit?: string; dflt?: number; direction?: number[] }): ConditionSpec {
  return {
    id: o.id,
    label: o.label,
    list: o.list ?? "loads_process_list",
    target: o.target ?? "any",
    category: o.category ?? "loads",
    icon: o.icon,
    help: o.help,
    fields: [
      { id: "modulus", label: `Modulus${o.unit ? ` [${o.unit}]` : ""}`, type: "number", default: o.dflt ?? 0 },
      { id: "direction", label: "Direction", type: "vector3", default: o.direction ?? [0, 0, -1] },
    ],
    processTemplate: {
      python_module: "assign_vector_by_direction_to_condition_process",
      kratos_module: "KratosMultiphysics",
      process_name: "AssignVectorByDirectionToConditionProcess",
      Parameters: {
        model_part_name: "$path",
        variable_name: variable,
        modulus: "$field:modulus",
        direction: "$field:direction",
        interval: o.interval ?? TOTAL,
      },
    },
  };
}

/** `AssignScalarVariableToConditionsProcess`: a scalar (pressure, flux…) applied on Conditions. */
export function scalarOnConditions(variable: string, o: ConditionBase & { unit?: string; dflt?: number }): ConditionSpec {
  return {
    id: o.id,
    label: o.label,
    list: o.list ?? "loads_process_list",
    target: o.target ?? "surface",
    category: o.category ?? "loads",
    icon: o.icon,
    help: o.help,
    fields: [{ id: "value", label: `Value${o.unit ? ` [${o.unit}]` : ""}`, type: "number", default: o.dflt ?? 0 }],
    processTemplate: {
      python_module: "assign_scalar_variable_to_conditions_process",
      kratos_module: "KratosMultiphysics",
      process_name: "AssignScalarVariableToConditionsProcess",
      Parameters: {
        model_part_name: "$path",
        variable_name: variable,
        value: "$field:value",
        interval: o.interval ?? TOTAL,
      },
    },
  };
}

/**
 * The per-component broadcast every `AssignVectorVariableProcess` condition
 * needs: the single "Fixed" checkbox becomes `constrained: [b, b, b]`, which a
 * static template cannot express. Returns undefined for any other condition so
 * the declarative template resolves as usual.
 */
export function broadcastConstrained(cond: ConditionSpec, a: Assignment, ctx: GenContext): JsonObject | undefined {
  const template = cond.processTemplate as { python_module?: string; Parameters?: JsonObject };
  if (template.python_module !== "assign_vector_variable_process") return undefined;
  const resolved = resolveProcessTemplate(cond, a, ctx) as { Parameters: JsonObject };
  const fixed = asBool(a.values.constrained as JsonValue, true);
  const value = Array.isArray(a.values.value) ? a.values.value : [0, 0, 0];
  resolved.Parameters.model_part_name = dottedModelPart(ctx.modelPartName, a.smpPath);
  resolved.Parameters.constrained = [fixed, fixed, fixed];
  resolved.Parameters.value = value;
  return resolved as JsonObject;
}

/**
 * Copies a field list dropping every `visibleWhen` rule that reads one of the
 * given field ids (a field removed from a derived declaration would otherwise
 * leave rules that read `undefined` and hide their fields for good). Fields
 * left with no rule lose the property.
 */
export function withoutRulesOn(fields: FieldSpec[], removed: string[]): FieldSpec[] {
  const drop = new Set(removed);
  return fields.map((f) => {
    if (f.visibleWhen === undefined) return { ...f };
    const rules = Array.isArray(f.visibleWhen) ? f.visibleWhen : [f.visibleWhen];
    const kept = rules.filter((r) => !drop.has(r.field));
    const copy: FieldSpec = { ...f };
    if (kept.length === 0) delete copy.visibleWhen;
    else copy.visibleWhen = kept.length === 1 ? kept[0] : kept;
    return copy;
  });
}

/** Returns a copy of `fields` with every id (and every `visibleWhen`/`group` reference) prefixed. */
export function prefixFields(fields: FieldSpec[], prefix: string, groupPrefix = prefix): FieldSpec[] {
  const rename = (r: { field: string }) => ({ ...r, field: prefix + r.field });
  return fields.map((f) => {
    const copy: FieldSpec = { ...f, id: prefix + f.id };
    if (f.group !== undefined) copy.group = groupPrefix + f.group;
    if (f.visibleWhen !== undefined) {
      copy.visibleWhen = Array.isArray(f.visibleWhen) ? f.visibleWhen.map(rename) : rename(f.visibleWhen);
    }
    return copy;
  });
}

/** The values whose ids start with `prefix`, with the prefix removed (the inverse of `prefixFields` for hooks). */
export function unprefixValues(values: Record<string, JsonValue>, prefix: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(values)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}
