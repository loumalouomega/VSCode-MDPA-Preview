/**
 * Field management and conditioning: rename, keep/drop, and value conditioning
 * (clamp / normalize / standardize) of the fields an `MdpaModel` already holds.
 *
 * Pure module (no vscode / DOM / wasm). All four are NATIVE rather than
 * meshio++'s `dataRename`/`dataKeep`/`dataDrop`/`dataCondition`, for the
 * "keep the native one" rule the rest of the mesh operations follow: a
 * `FieldData` is already keyed by entity id, may cover only part of the mesh
 * (a gap must stay a gap, never become 0), spans up to three id spaces, and
 * carries a Nodal `fixed` flag — converting through `modelToMeshio` would have
 * to flatten and then re-split all of that for a change that is one array
 * operation. `dataCondition`'s semantics are fully specified upstream
 * (doc/data_condition.md) and `fieldManage.test.ts` cross-checks this module
 * against the live wasm for every mode/scope/NaN policy, so the two cannot
 * drift without a test failing.
 */

import { FieldBlockKind, FieldData, MdpaModel } from "./types";
import type { GlobalSpec } from "./globalReduce";

const KRATOS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A legal Kratos variable name: the writer emits names verbatim, so no colon/space/etc. */
export function isValidFieldName(name: string): boolean {
  return KRATOS_NAME.test(name);
}

// --- rename ------------------------------------------------------------------

export interface RenameFieldParams {
  kind: FieldBlockKind;
  variable: string;
  newName: string;
  /** "error" (default) refuses to clobber an existing field; "overwrite" replaces it. */
  onConflict?: "error" | "overwrite";
}

export interface RenameFieldResult {
  model: MdpaModel;
  renamed: boolean;
  message?: string;
  /** Global reductions whose source was renamed along with the field. */
  globalsUpdated: number;
}

export function renameFieldModel(model: MdpaModel, p: RenameFieldParams): RenameFieldResult {
  const src = model.fields.find((f) => f.kind === p.kind && f.variable === p.variable);
  if (!src) return { model, renamed: false, message: `No ${p.kind} field named "${p.variable}".`, globalsUpdated: 0 };
  if (!isValidFieldName(p.newName)) {
    return {
      model,
      renamed: false,
      message: `"${p.newName}" is not a valid Kratos variable name (letters, digits and underscores; not starting with a digit).`,
      globalsUpdated: 0,
    };
  }
  if (p.newName === p.variable) return { model, renamed: false, message: "The new name equals the old one.", globalsUpdated: 0 };
  const clash = model.fields.find((f) => f.kind === p.kind && f.variable === p.newName);
  if (clash && p.onConflict !== "overwrite") {
    return {
      model,
      renamed: false,
      message: `A ${p.kind} field named "${p.newName}" already exists; rename it first or choose overwrite.`,
      globalsUpdated: 0,
    };
  }
  const fields = model.fields
    .filter((f) => f !== clash)
    .map((f) => (f === src ? { ...f, variable: p.newName } : f));
  // A global reduction names its source (kind + variable); keep it pointing at
  // the renamed field rather than leaving it to read NaN.
  let globalsUpdated = 0;
  let globals = model.globals;
  if (globals) {
    const next: Record<string, GlobalSpec> = {};
    for (const [name, spec] of Object.entries(globals)) {
      if (spec.kind === p.kind && spec.variable === p.variable) {
        next[name] = { ...spec, variable: p.newName };
        globalsUpdated++;
      } else next[name] = spec;
    }
    if (globalsUpdated > 0) globals = next;
  }
  return {
    model: { ...model, fields, ...(globals ? { globals } : {}) },
    renamed: true,
    globalsUpdated,
  };
}

// --- keep / drop ---------------------------------------------------------------

export interface FieldSelectParams {
  /** Restrict to one location; omitted = every location. */
  kind?: FieldBlockKind;
  variables: string[];
}

export interface FieldSelectResult {
  model: MdpaModel;
  /** "kind:variable" of every field removed. */
  removed: string[];
  /** Requested names that matched nothing. */
  missing: string[];
  /** Global reductions left without a source field by the removal. */
  orphanedGlobals: string[];
}

function orphaned(model: MdpaModel, fields: readonly FieldData[]): string[] {
  const out: string[] = [];
  for (const [name, spec] of Object.entries(model.globals ?? {})) {
    if (!fields.some((f) => f.kind === spec.kind && f.variable === spec.variable)) out.push(name);
  }
  return out;
}

export function dropFieldsModel(model: MdpaModel, p: FieldSelectParams): FieldSelectResult {
  const want = new Set(p.variables);
  const removed: string[] = [];
  const found = new Set<string>();
  const fields = model.fields.filter((f) => {
    const hit = want.has(f.variable) && (p.kind === undefined || f.kind === p.kind);
    if (hit) {
      removed.push(`${f.kind}:${f.variable}`);
      found.add(f.variable);
    }
    return !hit;
  });
  const missing = p.variables.filter((v) => !found.has(v));
  if (removed.length === 0) return { model, removed, missing, orphanedGlobals: [] };
  return {
    model: { ...model, fields },
    removed,
    missing,
    orphanedGlobals: orphaned(model, fields).filter((g) => !orphaned(model, model.fields).includes(g)),
  };
}

/**
 * Keeps only the listed variables. With `kind`, other locations are left
 * untouched (upstream `dataKeep`'s rule); without it, the list applies to every
 * location.
 */
export function keepFieldsModel(model: MdpaModel, p: FieldSelectParams): FieldSelectResult {
  const want = new Set(p.variables);
  const removed: string[] = [];
  const matched = new Set<string>();
  const fields = model.fields.filter((f) => {
    if (p.kind !== undefined && f.kind !== p.kind) return true;
    if (want.has(f.variable)) {
      matched.add(f.variable);
      return true;
    }
    removed.push(`${f.kind}:${f.variable}`);
    return false;
  });
  const missing = p.variables.filter((v) => !matched.has(v));
  if (removed.length === 0) return { model, removed, missing, orphanedGlobals: [] };
  return {
    model: { ...model, fields },
    removed,
    missing,
    orphanedGlobals: orphaned(model, fields).filter((g) => !orphaned(model, model.fields).includes(g)),
  };
}

// --- conditioning ----------------------------------------------------------------

export const CONDITION_MODES = ["clamp", "normalize", "standardize"] as const;
export type ConditionMode = (typeof CONDITION_MODES)[number];
export const CONDITION_SCOPES = ["component", "magnitude"] as const;
export type ConditionScope = (typeof CONDITION_SCOPES)[number];
export const NAN_POLICIES = ["ignore", "replace", "fail"] as const;
export type NanPolicy = (typeof NAN_POLICIES)[number];

export interface ConditionFieldParams {
  kind: FieldBlockKind;
  variable: string;
  mode: ConditionMode;
  /** clamp bounds / normalize target range (default 0 and 1). Ignored by standardize. */
  lo?: number;
  hi?: number;
  /** "component" (default) conditions each column on its own; "magnitude" rescales whole rows. */
  scope?: ConditionScope;
  /** What a non-finite value does: "ignore" (default) leaves it, "replace" writes `nanReplacement`, "fail" throws. */
  nanPolicy?: NanPolicy;
  nanReplacement?: number;
  /** Write the result under this name instead of in place. */
  output?: string;
}

export interface ConditionFieldResult {
  model: MdpaModel;
  /** Rows written; 0 = nothing happened. */
  conditioned: number;
  message?: string;
  /** Input statistics the transform was computed from (per component, or one entry for magnitude). */
  stats?: { min: number; max: number; mean: number; std: number }[];
}

interface Acc {
  n: number;
  min: number;
  max: number;
  sum: number;
  sumSq: number;
}
const newAcc = (): Acc => ({ n: 0, min: Infinity, max: -Infinity, sum: 0, sumSq: 0 });
function addTo(a: Acc, v: number): void {
  a.n++;
  if (v < a.min) a.min = v;
  if (v > a.max) a.max = v;
  a.sum += v;
}

/**
 * Two-pass mean/population-std over the finite values, so a large offset does
 * not cancel catastrophically (the one-pass sum-of-squares form does). The
 * population form (divide by N) is what upstream's `standardize` uses —
 * measured against the live wasm, not assumed.
 */
function finish(values: number[]): { min: number; max: number; mean: number; std: number } {
  if (values.length === 0) return { min: NaN, max: NaN, mean: NaN, std: NaN };
  const a = newAcc();
  for (const v of values) addTo(a, v);
  const mean = a.sum / a.n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return { min: a.min, max: a.max, mean, std: Math.sqrt(ss / a.n) };
}

export function conditionFieldModel(model: MdpaModel, p: ConditionFieldParams): ConditionFieldResult {
  const src = model.fields.find((f) => f.kind === p.kind && f.variable === p.variable);
  if (!src) return { model, conditioned: 0, message: `No ${p.kind} field named "${p.variable}".` };
  const lo = p.lo ?? 0;
  const hi = p.hi ?? 1;
  if (p.mode === "clamp" && !(lo <= hi)) return { model, conditioned: 0, message: "Clamp needs lo <= hi." };
  if (p.mode === "normalize" && !(lo < hi)) return { model, conditioned: 0, message: "Normalize needs lo < hi." };
  if (p.output !== undefined && !isValidFieldName(p.output)) {
    return { model, conditioned: 0, message: `"${p.output}" is not a valid Kratos variable name.` };
  }
  const policy = p.nanPolicy ?? "ignore";
  const repl = p.nanReplacement ?? 0;
  const c = Math.max(1, src.components);
  const rows = src.ids.length;
  const asMagnitude = (p.scope ?? "component") === "magnitude" && c > 1;
  const notes: string[] = [];
  if ((p.scope ?? "component") === "magnitude" && c === 1) notes.push("A scalar has no direction, so the component scope was used.");

  if (policy === "fail") {
    for (let i = 0; i < rows * c; i++) {
      if (!Number.isFinite(src.values[i])) {
        throw new Error(`Non-finite value at index ${i} of "${p.variable}" (nanPolicy "fail").`);
      }
    }
  }

  const out = new Float64Array(src.values.length);
  let stats: { min: number; max: number; mean: number; std: number }[];

  const transform = (stat: { min: number; max: number; mean: number; std: number }): ((x: number) => number) => {
    switch (p.mode) {
      case "clamp":
        return (x) => Math.min(Math.max(x, lo), hi);
      case "normalize": {
        const span = stat.max - stat.min;
        if (!(span > 0)) {
          notes.push("A constant (or all non-finite) input has no range to normalize; the target lower bound was written.");
          return () => lo;
        }
        return (x) => lo + ((x - stat.min) / span) * (hi - lo);
      }
      default: {
        if (!(stat.std > 0)) {
          notes.push("Zero standard deviation; 0 was written.");
          return () => 0;
        }
        return (x) => (x - stat.mean) / stat.std;
      }
    }
  };

  if (asMagnitude) {
    const mags = new Float64Array(rows);
    const finite: number[] = [];
    const rowFinite = new Uint8Array(rows);
    for (let i = 0; i < rows; i++) {
      let s = 0;
      let ok = true;
      for (let k = 0; k < c; k++) {
        const v = src.values[i * c + k];
        if (!Number.isFinite(v)) ok = false;
        s += v * v;
      }
      rowFinite[i] = ok ? 1 : 0;
      mags[i] = Math.sqrt(s);
      if (ok) finite.push(mags[i]);
    }
    const stat = finish(finite);
    stats = [stat];
    const f = transform(stat);
    for (let i = 0; i < rows; i++) {
      for (let k = 0; k < c; k++) {
        const v = src.values[i * c + k];
        if (!rowFinite[i]) {
          out[i * c + k] = policy === "replace" && !Number.isFinite(v) ? repl : v;
        } else {
          // A zero-magnitude row has no direction to keep, so it stays zero.
          out[i * c + k] = mags[i] > 0 ? v * (f(mags[i]) / mags[i]) : 0;
        }
      }
    }
  } else {
    stats = [];
    for (let k = 0; k < c; k++) {
      const col: number[] = [];
      for (let i = 0; i < rows; i++) {
        const v = src.values[i * c + k];
        if (Number.isFinite(v)) col.push(v);
      }
      const stat = finish(col);
      stats.push(stat);
      const f = transform(stat);
      for (let i = 0; i < rows; i++) {
        const v = src.values[i * c + k];
        out[i * c + k] = Number.isFinite(v) ? f(v) : policy === "replace" ? repl : v;
      }
    }
  }

  const inPlace = p.output === undefined || p.output === p.variable;
  const target = inPlace ? p.variable : (p.output as string);
  const next: FieldData = {
    kind: src.kind,
    variable: target,
    components: src.components,
    ids: src.ids,
    values: out,
    ...(inPlace && src.fixed ? { fixed: src.fixed } : {}),
  };
  const fields = model.fields
    .filter((f) => !(f.kind === src.kind && f.variable === target && f !== src))
    .map((f) => (f === src && inPlace ? next : f));
  if (!inPlace) fields.push(next);
  return {
    model: { ...model, fields },
    conditioned: rows,
    stats,
    message: notes.length ? notes.join(" ") : undefined,
  };
}
