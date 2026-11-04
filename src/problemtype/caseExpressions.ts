/**
 * Units and case parameters in problemtype forms (roadmap item 27).
 *
 * A numeric field may hold, instead of a number, an expression string:
 * a unit-suffixed literal (`10[mm]`, `20[degC]`, `2[bar]`), a parameter name
 * from the case's `Parameters` table (`L = 2[m]`), or arithmetic over those
 * (`2*L + 5[mm]`). It is resolved to a plain number in the field's declared
 * unit before anything is generated, so recipes and generated documents only
 * ever contain numbers. Rules:
 *
 *  - a unit literal fixes the expression's QUANTITY (length, time, stress, …);
 *    mixing two quantities in one expression is refused, and units are not
 *    multiplied or divided;
 *  - a quantity that does not match the field's unit is a `unit-mismatch`
 *    WARNING and the number is kept unconverted — typed values warn, they are
 *    never silently converted (the preset catalog's refusal rule is for presets);
 *  - an expression with no unit is read in the field's own unit;
 *  - temperature scales are affine, so `20[degC]` converts only as a whole
 *    value (to K, °C or °F), never inside arithmetic;
 *  - a bracket never contains a decimal comma, and numbers keep `.`.
 *
 * The grammar is `sizeExpr.ts`'s own parser (never `eval`). Pure module.
 */
import { parseSizeExpr } from "../parser/sizeExpr";
import { unitFactor, unitOfField } from "./materialCatalog";
import type { CaseState, FieldSpec, JsonValue, ProblemtypeDeclaration } from "./types";

export interface CaseParameter { name: string; expr: string }

const LITERAL = /(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)\s*\[([^\]]*)\]/g;
const TEMPERATURE: Record<string, { toK: (v: number) => number; fromK: (k: number) => number }> = {
  K: { toK: (v) => v, fromK: (k) => k },
  degC: { toK: (v) => v + 273.15, fromK: (k) => k - 273.15 },
  "°C": { toK: (v) => v + 273.15, fromK: (k) => k - 273.15 },
  degF: { toK: (v) => (v - 32) * 5 / 9 + 273.15, fromK: (k) => (k - 273.15) * 9 / 5 + 32 },
  "°F": { toK: (v) => (v - 32) * 5 / 9 + 273.15, fromK: (k) => (k - 273.15) * 9 / 5 + 32 },
};
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["pi", "e", "min", "max", "clamp", "abs", "sqrt", "sin", "cos", "tan", "exp", "log", "pow", "floor", "ceil", "round"]);

interface Evaluated { value: number; quantity?: string; temperature?: boolean; unit?: string }

/** A canonical value for `value unit`, with its quantity; throws on an unknown unit. */
function literalValue(value: number, unit: string): Evaluated {
  const u = unit.trim();
  if (u.includes(",")) throw new Error(`the unit "[${u}]" contains a comma; use "." for decimals`);
  const t = TEMPERATURE[u];
  if (t) return { value: t.toK(value), quantity: "temperature", temperature: true, unit: u };
  const f = unitFactor(u);
  if (!f) throw new Error(`unknown unit "[${u}]"`);
  return { value: value * f.factor, quantity: f.quantity, unit: u };
}

/** Evaluates one expression to a canonical value (SI base of its quantity). */
function evaluate(text: string, params: Map<string, Evaluated>): Evaluated {
  const trimmed = text.trim();
  const literals: Evaluated[] = [];
  const replaced = trimmed.replace(LITERAL, (_m, num: string, unit: string) => {
    const lit = literalValue(Number(num), unit);
    literals.push(lit);
    return `(${lit.value})`;
  });
  const single = literals.length === 1 && trimmed.replace(LITERAL, "").trim() === "";
  if (literals.some((l) => l.temperature) && !single) throw new Error("a temperature scale offset (°C, °F) cannot be used inside arithmetic; convert it as a whole value");
  let compiled;
  try {
    compiled = parseSizeExpr(replaced, [...params.keys()]);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const scope: Record<string, number> = {};
  const used: Evaluated[] = [...literals];
  for (const v of compiled.variablesUsed) {
    const p = params.get(v);
    if (!p) continue;
    scope[v] = p.value;
    if (p.quantity) used.push(p);
  }
  const quantities = new Set(used.map((u) => u.quantity));
  if (quantities.size > 1) throw new Error(`combines ${[...quantities].join(" and ")}; units are not multiplied or divided`);
  const value = compiled.evaluate(scope);
  if (!Number.isFinite(value)) throw new Error("does not evaluate to a finite number");
  const first = used[0];
  return { value, quantity: first?.quantity, temperature: first?.temperature && used.length === 1 };
}

/** Evaluates the parameter table in order (a parameter may use earlier ones). Throws on the first bad one. */
export function evaluateParameters(parameters: readonly CaseParameter[]): Map<string, Evaluated> {
  const out = new Map<string, Evaluated>();
  for (const p of parameters) {
    if (!NAME.test(p.name) || RESERVED.has(p.name.toLowerCase())) throw new Error(`Parameter "${p.name}" is not a usable name (letters, digits and _, not a function or constant).`);
    const key = p.name.toLowerCase();
    if (out.has(key)) throw new Error(`Parameter "${p.name}" is defined twice.`);
    try {
      out.set(key, evaluate(p.expr, out));
    } catch (err) {
      throw new Error(`Parameter "${p.name}": ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  return out;
}

export interface Resolved { value: number; warning?: string }

/** Resolves one field expression into the field's declared unit. */
export function resolveFieldExpression(text: string, targetUnit: string | undefined, params: Map<string, Evaluated>): Resolved {
  const ev = evaluate(text, params);
  if (!ev.quantity) return { value: ev.value };
  const targetTemp = targetUnit ? TEMPERATURE[targetUnit] : undefined;
  if (ev.quantity === "temperature" && targetTemp) return { value: targetTemp.fromK(ev.value) };
  const target = targetUnit && !targetTemp ? unitFactor(targetUnit) : undefined;
  if (target && target.quantity === ev.quantity) return { value: ev.value / target.factor };
  return {
    value: ev.value,
    warning: `unit-mismatch: "${text.trim()}" is a ${ev.quantity} but the field ${targetUnit ? `takes "${targetUnit}"` : "declares no unit"}; the number ${ev.value} was used unconverted.`,
  };
}

const isNumeric = (f: FieldSpec): boolean => f.type === "number" || f.type === "int";

/**
 * Replaces every expression string in a numeric field of the state (sections,
 * assignments, materials, collection entries) with its resolved number.
 * Throws one refusal listing every bad expression; warnings are returned.
 */
export function resolveStateExpressions(decl: ProblemtypeDeclaration, state: CaseState): { state: CaseState; warnings: string[] } {
  const params = evaluateParameters(state.parameters ?? []);
  const warnings: string[] = [];
  const problems: string[] = [];
  const resolveValues = (values: Record<string, JsonValue>, fields: readonly FieldSpec[], where: string): Record<string, JsonValue> => {
    let copy: Record<string, JsonValue> | undefined;
    for (const f of fields) {
      const v = values[f.id];
      // A vector3 holds three components, each a number or an expression (`[1[kN], "L/2", 0]`).
      if (f.type === "vector3" && Array.isArray(v) && v.some((c) => typeof c === "string")) {
        const comps = v.map((c, i) => {
          if (typeof c !== "string" || c.trim() === "") return c;
          try {
            const r = resolveFieldExpression(c.trim(), unitOfField(f), params);
            if (r.warning) warnings.push(`${where} ${f.label}[${"xyz"[i] ?? i}]: ${r.warning}`);
            return r.value;
          } catch (err) {
            problems.push(`${where} ${f.label}[${"xyz"[i] ?? i}]: ${err instanceof Error ? err.message : String(err)}.`);
            return c;
          }
        });
        (copy ??= { ...values })[f.id] = comps as JsonValue;
        continue;
      }
      if (typeof v !== "string" || !isNumeric(f)) continue;
      const t = v.trim();
      if (t === "") continue;
      try {
        const r = resolveFieldExpression(t, unitOfField(f), params);
        if (r.warning) warnings.push(`${where} ${f.label}: ${r.warning}`);
        (copy ??= { ...values })[f.id] = f.type === "int" ? Math.round(r.value) : r.value;
      } catch (err) {
        problems.push(`${where} ${f.label}: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
    return copy ?? values;
  };
  const out: CaseState = { ...state };
  out.values = Object.fromEntries(
    Object.entries(state.values).map(([sid, vals]) => {
      const section = decl.sections.find((s) => s.id === sid);
      return [sid, section ? resolveValues(vals, section.fields, section.label) : vals];
    })
  );
  out.assignments = state.assignments.map((a) => {
    const cond = decl.conditions.find((c) => c.id === a.conditionId);
    return cond ? { ...a, values: resolveValues(a.values, cond.fields ?? [], `${cond.label} on ${a.smpPath}:`) } : a;
  });
  out.materials = state.materials.map((m) => {
    const law = decl.materialLaws.find((l) => l.id === m.lawId);
    return law ? { ...m, values: resolveValues(m.values, law.variables, `${law.name || law.id} on ${m.smpPath}:`) } : m;
  });
  if (state.collections && decl.collections) {
    out.collections = Object.fromEntries(
      Object.entries(state.collections).map(([cid, entries]) => {
        const spec = decl.collections!.find((c) => c.id === cid);
        return [cid, entries.map((e) => {
          const type = spec?.entryTypes.find((t) => t.id === e.type);
          return type ? { ...e, values: resolveValues(e.values, type.fields, `${e.name}:`) } : e;
        })];
      })
    );
  }
  if (problems.length > 0) throw new Error(`The case has expression problems, so nothing was generated:\n- ${problems.join("\n- ")}`);
  return { state: out, warnings };
}
