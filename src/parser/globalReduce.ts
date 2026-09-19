/**
 * Global (scalar) variables derived from fields: min / max / mean / std /
 * median / sum / count / q1 / q3 / iqr of a field's values — e.g. `max_h`,
 * `mean_TEMP`. The reduction set deliberately mirrors `boxStats()` in
 * meshSize.ts (same quantile/std conventions), so a global and the Mesh Size
 * panel never disagree about what "mean" means.
 *
 * Pure module: no vscode / DOM / vtk.js / wasm imports, so it runs in the
 * extension host, the MMG worker, the MCP server, the webview bundle (a
 * Variables row shows its LIVE value, computed client-side from the field
 * values the model message already carries), and plain Node unit tests.
 *
 * ## Specs on the model, values derived on read
 *
 * `MdpaModel.globals` stores only SPECS (`{variable, kind, reduction}` per
 * output name) — never values. Every scope-build recomputes from the current
 * fields, which kills the whole staleness class by construction: crop, refine,
 * merge, remesh and timeline scrub can never leave a stale global behind,
 * because there is nothing stale to leave. A global whose source field is
 * gone simply drops out of scope (validation reports unknown-name
 * truthfully). Vector fields reduce over MAGNITUDE, matching the Field
 * panel's default scalar.
 */

import { FieldData, FieldBlockKind, MdpaModel } from "./types";

/** Every reduction a global variable can compute. */
export const GLOBAL_REDUCTIONS = [
  "min",
  "max",
  "minAbs",
  "maxAbs",
  "mean",
  "std",
  "median",
  "sum",
  "count",
  "q1",
  "q3",
  "iqr",
] as const;

export type GlobalReduction = (typeof GLOBAL_REDUCTIONS)[number];

/** A global variable definition: which field, reduced how. */
export interface GlobalSpec {
  variable: string;
  kind: FieldBlockKind;
  reduction: GlobalReduction;
}

/** Default output name for a reduction, e.g. `max_h`, `mean_TEMP`. */
export function defaultGlobalName(variable: string, reduction: GlobalReduction): string {
  return `${reduction}_${variable}`;
}

/**
 * Reduces raw values to a scalar. Non-finite entries are SKIPPED (a partly-NaN
 * field still has a meaningful max; fieldCalc drops NaN rows by the same
 * logic). Empty / all-skipped input yields NaN, which the expression
 * evaluator already treats as "could not be computed".
 */
export function reduceValues(values: ArrayLike<number>, reduction: GlobalReduction): number {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) finite.push(v);
  }
  if (reduction === "count") return finite.length;
  if (finite.length === 0) return NaN;
  switch (reduction) {
    case "sum": {
      let s = 0;
      for (const v of finite) s += v;
      return s;
    }
    case "min":
      return Math.min(...finite);
    case "max":
      return Math.max(...finite);
    case "minAbs":
      return Math.min(...finite.map((v) => Math.abs(v)));
    case "maxAbs":
      return Math.max(...finite.map((v) => Math.abs(v)));
    case "mean": {
      let s = 0;
      for (const v of finite) s += v;
      return s / finite.length;
    }
    case "std": {
      let s = 0;
      for (const v of finite) s += v;
      const mean = s / finite.length;
      let sq = 0;
      for (const v of finite) sq += (v - mean) * (v - mean);
      return Math.sqrt(sq / finite.length);
    }
    case "median":
      return quantile(finite, 0.5);
    case "q1":
      return quantile(finite, 0.25);
    case "q3":
      return quantile(finite, 0.75);
    case "iqr":
      return quantile(finite, 0.75) - quantile(finite, 0.25);
  }
}

function quantile(values: number[], q: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/** Magnitude of one entity's tuple (the Field panel's default scalar). */
function magnitude(field: FieldData, row: number): number {
  let s = 0;
  for (let k = 0; k < field.components; k++) {
    const v = field.values[row * field.components + k];
    if (!Number.isFinite(v)) return NaN;
    s += v * v;
  }
  return Math.sqrt(s);
}

/** The scalar series a spec reduces: raw values, or magnitudes for vectors. */
function specSeries(model: MdpaModel, spec: GlobalSpec): ArrayLike<number> | undefined {
  const field = model.fields.find((f) => f.kind === spec.kind && f.variable === spec.variable);
  if (!field || field.ids.length === 0) return undefined;
  // `.slice`, not `.subarray`: webview-side fields ride `postMessage` as
  // PLAIN arrays (see modelWire.ts), which have no `.subarray` — and this
  // module runs in both runtimes (live row values are computed client-side).
  if (field.components <= 1) return field.values.slice(0, field.ids.length);
  const mags = new Float64Array(field.ids.length);
  for (let i = 0; i < field.ids.length; i++) mags[i] = magnitude(field, i);
  return mags;
}

/**
 * Computes a global's current value from the model's fields. Returns NaN when
 * the source field is absent (the name then drops out of every formula
 * scope). Scalar fields reduce directly; vector fields reduce over
 * magnitude.
 */
export function computeGlobal(model: MdpaModel, spec: GlobalSpec): number {
  const series = specSeries(model, spec);
  if (!series) return NaN;
  return reduceValues(series, spec.reduction);
}

/** Finite values feeding a spec — the `n=` behind a reported global. */
export function globalValueCount(model: MdpaModel, spec: GlobalSpec): number {
  const series = specSeries(model, spec);
  if (!series) return 0;
  return reduceValues(series, "count");
}

/** Every global name → its live value, for scope population. */
export function globalScopeValues(model: MdpaModel): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, spec] of Object.entries(model.globals ?? {})) {
    out.set(name.toLowerCase(), computeGlobal(model, spec));
  }
  return out;
}
