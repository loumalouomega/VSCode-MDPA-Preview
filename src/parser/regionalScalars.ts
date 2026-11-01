/**
 * Regional scalars inside formulas: `avg(PART, F)`, `int(PART, F)`, `max(PART, F)`
 * and `min(PART, F)` (roadmap item 34).
 *
 * Each call is evaluated ONCE per apply, before the formula is parsed, and
 * replaced by a numeric literal. The grammar therefore stays `sizeExpr.ts`'s
 * own recursive-descent parser (never `eval`). The numbers come from the same
 * `plot/region.ts` reductions plots and monitors use, so conventions match:
 * Elemental `avg`/`int` are measure-weighted, Nodal `avg` is the unweighted
 * entity mean, `min`/`max` run over the part's subtree (deduplicated), and
 * entities with no value are excluded, never read as zero.
 *
 * `max(a, b)` / `min(a, b)` keep their ordinary two-argument meaning: a call is
 * regional only when its first argument names a SubModelPart of the model.
 * `avg`/`int` have no other meaning, so an unknown part or field is an error.
 *
 * Pure module (no vscode/DOM): Node-testable, bundled by nobody in the webview.
 */
import type { FieldData, MdpaModel } from "./types";
import { findSubModelPart } from "./subModelPartExtract";
import { sampleRegion } from "./plot/region";
import type { PlotRegionSource } from "./plot/types";
import { REGIONAL_CALL, hasRegionalCall } from "./regionalCalls";

const CALL = REGIONAL_CALL;

/** True when the text contains something that looks like a regional call (cheap pre-check). */
export function mayHaveRegionalScalars(expr: string): boolean {
  return hasRegionalCall(expr);
}

function pickField(model: MdpaModel, name: string): FieldData | undefined {
  const lower = name.toLowerCase();
  const matches = model.fields.filter((f) => f.variable.toLowerCase() === lower);
  return matches.find((f) => f.kind === "Elemental") ?? matches.find((f) => f.kind === "Nodal") ?? matches[0];
}

/** One regional scalar: the value and a short disclosure of how it was computed. */
export interface RegionalValue {
  call: string;
  value: number;
  note: string;
}

/**
 * Replaces every regional call in `expr` by its numeric value. Throws (before
 * anything is applied) for an unknown part or field, a non-scalar field where a
 * scalar is needed, or a region with no covered entity.
 */
export function expandRegionalScalars(
  model: MdpaModel,
  expr: string
): { expr: string; values: RegionalValue[] } {
  const values: RegionalValue[] = [];
  const cache = new Map<string, number>();
  CALL.lastIndex = 0;
  const out = expr.replace(CALL, (call, fn: string, part: string, variable: string) => {
    const op = fn.toLowerCase();
    const partFound = findSubModelPart(model, part);
    if (!partFound) {
      if (op === "max" || op === "min") return call; // ordinary two-argument function
      throw new Error(`${fn}(${part}, ${variable}): no SubModelPart "${part}".`);
    }
    const field = pickField(model, variable);
    if (!field) throw new Error(`${fn}(${part}, ${variable}): no field "${variable}" on the mesh.`);
    const key = `${op}|${part}|${field.kind}|${field.variable}`;
    let value = cache.get(key);
    if (value === undefined) {
      const spec: PlotRegionSource = {
        id: "regional",
        type: "region",
        path: "",
        scope: "current",
        kind: field.kind,
        variable: field.variable,
        submodelpart: part,
        operation: "mean",
      };
      let note: string;
      if (op === "int") {
        if (field.kind !== "Elemental") {
          throw new Error(`int(${part}, ${variable}): "${field.variable}" is ${field.kind}; integrate an Elemental scalar (convert with Average field first).`);
        }
        spec.operation = "measureIntegral";
        note = "measure integral";
      } else if (op === "avg" && field.kind === "Elemental") {
        const total = sampleRegion(model, { ...spec, operation: "measureIntegral" } as PlotRegionSource);
        const t = total.values[0];
        if (t === null || !(total.measure > 0)) throw new Error(`${fn}(${part}, ${variable}): no covered entity in "${part}".`);
        value = t / total.measure;
        note = "measure-weighted mean";
      } else {
        spec.operation = op === "avg" ? "mean" : (op as "min" | "max");
        note = op === "avg" ? "entity mean" : op;
      }
      if (value === undefined) {
        const sample = sampleRegion(model, spec);
        const v = sample.values[0];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          throw new Error(`${fn}(${part}, ${variable}): no covered entity in "${part}".`);
        }
        value = v;
      }
      cache.set(key, value);
      values.push({ call, value, note });
    }
    // Parenthesised so a negative literal keeps its precedence.
    return `(${value})`;
  });
  return { expr: out, values };
}
