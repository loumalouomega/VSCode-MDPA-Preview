/**
 * Pure name-completion engine for formula and caption inputs (roadmap item 85).
 *
 * No DOM / vscode imports: feeds from the exact scope functions used by
 * validation (`scopeVariables`, `remeshSizeExprVars`, `formulaVariables`,
 * `EXPR_FUNCTION_INFO`, `EXPR_CONSTANT_NAMES`) so every offered name validates.
 */

import type { FieldBlockKind, FieldData } from "./types";
import { fieldUnitLabel, displayAlternatives } from "./fieldDimensions";
import { scopeVariables } from "./fieldCalc";
import {
  EXPR_CONSTANT_NAMES,
  EXPR_FUNCTION_INFO,
  REMESH_DISTANCE_VAR,
  SIZE_EXPR_VARIABLES,
  remeshSizeExprVars,
} from "./sizeExpr";

export type FormulaCompletionKind =
  | "nodal"
  | "elemental"
  | "conditional"
  | "global"
  | "coord"
  | "stat"
  | "distance"
  | "function"
  | "constant"
  | "token"
  | "part"
  | "unit";

export interface FormulaCompletionItem {
  /** Text inserted into the input. */
  insert: string;
  /** Label shown in the popup list. */
  label: string;
  /** Role badge (e.g. "nodal field", "global", "fn(3)"). */
  detail: string;
  /** Unit label when known (e.g. "m/s", "Pa"). */
  unit?: string;
  kind: FormulaCompletionKind;
}

export interface ExprScopeOptions {
  mode: "fieldCalc" | "remesh" | "formulaSelect";
  /** Target location when `mode === "fieldCalc"` (defaults to `"Nodal"`). */
  location?: FieldBlockKind;
  /** All fields on the current model. */
  fields: readonly FieldData[];
  /** Model global variable names. */
  globals?: readonly string[];
  /** Whether a distance surface is attached (when `mode === "remesh"`). */
  hasDistanceSurface?: boolean;
}

const COORDS = new Set(["x", "y", "z"]);
const STATS = new Set(["h", "mean", "std", "min", "max", "median", "q1", "q3", "iqr"]);

function buildFieldMetaMap(fields: readonly FieldData[]): Map<string, { kind: FieldBlockKind; unit?: string }> {
  const map = new Map<string, { kind: FieldBlockKind; unit?: string }>();
  const axis = ["x", "y", "z"];
  for (const f of fields) {
    const unit = fieldUnitLabel(f);
    if (f.components === 1) {
      map.set(f.variable.toLowerCase(), { kind: f.kind, unit });
    } else {
      for (let c = 0; c < Math.min(f.components, 3); c++) {
        map.set(`${f.variable}_${axis[c]}`.toLowerCase(), { kind: f.kind, unit });
      }
    }
  }
  return map;
}

function fieldKindTag(kind: FieldBlockKind): { ckind: FormulaCompletionKind; detail: string } {
  if (kind === "Nodal") return { ckind: "nodal", detail: "nodal field" };
  if (kind === "Elemental") return { ckind: "elemental", detail: "elemental field" };
  return { ckind: "conditional", detail: "conditional field" };
}

/**
 * Builds completion items for an expression input from the exact same scope
 * arrays that `validateSizeExpr` / `validateFormula` validate against.
 */
export function buildExprCompletions(opts: ExprScopeOptions): FormulaCompletionItem[] {
  const globals = opts.globals ?? [];
  const relevantFields: FieldData[] =
    opts.mode === "fieldCalc"
      ? opts.fields.filter((f) => f.kind === (opts.location ?? "Nodal"))
      : opts.fields.filter((f) => f.kind === "Nodal");

  let allowedNames: readonly string[];
  if (opts.mode === "remesh") {
    const nodalExtra = scopeVariables(relevantFields, false, []);
    allowedNames = remeshSizeExprVars(Boolean(opts.hasDistanceSurface), nodalExtra, globals);
  } else {
    allowedNames = scopeVariables(relevantFields, true, globals);
  }

  const fieldMeta = buildFieldMetaMap(relevantFields);
  const globalSet = new Set(globals.map((g) => g.toLowerCase()));
  const items: FormulaCompletionItem[] = [];
  const seen = new Set<string>();

  for (const name of allowedNames) {
    if (seen.has(name)) continue;
    seen.add(name);

    if (COORDS.has(name)) {
      items.push({ insert: name, label: name, detail: "coord", kind: "coord" });
    } else if (opts.mode === "remesh" && name === REMESH_DISTANCE_VAR && opts.hasDistanceSurface) {
      items.push({ insert: name, label: name, detail: "distance", kind: "distance" });
    } else if (opts.mode === "remesh" && STATS.has(name) && (SIZE_EXPR_VARIABLES as readonly string[]).includes(name)) {
      items.push({
        insert: name,
        label: name,
        detail: name === "h" ? "nodal size" : "size stat",
        kind: "stat",
      });
    } else if (fieldMeta.has(name)) {
      const meta = fieldMeta.get(name)!;
      const { ckind, detail } = fieldKindTag(meta.kind);
      items.push({ insert: name, label: name, detail, unit: meta.unit, kind: ckind });
    } else if (globalSet.has(name)) {
      items.push({ insert: name, label: name, detail: "global", kind: "global" });
    } else {
      items.push({ insert: name, label: name, detail: "variable", kind: "global" });
    }
  }

  for (const fn of EXPR_FUNCTION_INFO) {
    const arityText = fn.arity === "any" ? "1+" : String(fn.arity);
    items.push({
      insert: `${fn.name}(`,
      label: `${fn.name}(…)`,
      detail: `fn(${arityText})`,
      kind: "function",
    });
  }

  for (const c of EXPR_CONSTANT_NAMES) {
    items.push({ insert: c, label: c, detail: "constant", kind: "constant" });
  }

  return items;
}

export interface CaptionCompletionContext {
  fields?: readonly FieldData[];
  parts?: readonly string[];
}

const CAPTION_TOKENS: readonly FormulaCompletionItem[] = [
  { insert: "{max(", label: "{max(F)}", detail: "token", kind: "token" },
  { insert: "{min(", label: "{min(F)}", detail: "token", kind: "token" },
  { insert: "{avg(", label: "{avg(Part, F)}", detail: "token", kind: "token" },
  { insert: "{time}", label: "{time}", detail: "token", kind: "token" },
  { insert: "{step}", label: "{step}", detail: "token", kind: "token" },
];

export interface CompletionMatch {
  start: number;
  end: number;
  prefix: string;
  items: FormulaCompletionItem[];
}

function filterItems(items: readonly FormulaCompletionItem[], prefix: string): FormulaCompletionItem[] {
  const q = prefix.toLowerCase();
  if (!q) return [...items];
  const starts: FormulaCompletionItem[] = [];
  const contains: FormulaCompletionItem[] = [];
  for (const item of items) {
    const lbl = item.label.toLowerCase();
    const ins = item.insert.toLowerCase();
    if (lbl.startsWith(q) || ins.startsWith(q)) starts.push(item);
    else if (lbl.includes(q) || ins.includes(q)) contains.push(item);
  }
  return [...starts, ...contains];
}

/**
 * Computes matching completions at `cursor` in `text` for an expression input.
 * Returns `null` when the popup should stay closed.
 */
export function matchExprCompletions(
  text: string,
  cursor: number,
  items: readonly FormulaCompletionItem[],
  opts?: { minPrefix?: number; force?: boolean }
): CompletionMatch | null {
  const head = text.slice(0, cursor);
  const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(head);
  const prefix = m ? m[1] : "";
  const start = cursor - prefix.length;
  const minPrefix = opts?.minPrefix ?? 2;
  if (!opts?.force && prefix.length < minPrefix) return null;
  const matched = filterItems(items, prefix);
  if (matched.length === 0) return null;
  return { start, end: cursor, prefix, items: matched };
}

/**
 * Computes matching completions at `cursor` in `text` for a caption/title input.
 * Supports `{max(F[,unit])}`, `{min(F[,unit])}`, `{avg(Part, F[,unit])}`, `{time}`, `{step}`.
 */
export function matchCaptionCompletions(
  text: string,
  cursor: number,
  ctx: CaptionCompletionContext,
  opts?: { minPrefix?: number; force?: boolean }
): CompletionMatch | null {
  const head = text.slice(0, cursor);
  const minPrefix = opts?.minPrefix ?? 2;

  // Inside `{op(arg0, arg1, ...`
  const callMatch = /\{\s*(max|min|avg)\s*\(([^)}]*)$/i.exec(head);
  if (callMatch) {
    const op = callMatch[1].toLowerCase();
    const argsRaw = callMatch[2];
    const parts = argsRaw.split(",");
    const argIndex = parts.length - 1;
    const rawPrefix = parts[argIndex].trimStart();
    const start = cursor - rawPrefix.length;

    if (!opts?.force && rawPrefix.length < minPrefix) return null;

    let pool: FormulaCompletionItem[] = [];
    if (op === "avg" && argIndex === 0) {
      pool = (ctx.parts ?? []).map((p) => ({
        insert: p,
        label: p,
        detail: "part",
        kind: "part",
      }));
    } else if ((op !== "avg" && argIndex === 0) || (op === "avg" && argIndex === 1)) {
      const seen = new Set<string>();
      for (const f of ctx.fields ?? []) {
        if (seen.has(f.variable)) continue;
        seen.add(f.variable);
        const { ckind, detail } = fieldKindTag(f.kind);
        pool.push({
          insert: f.variable,
          label: f.variable,
          detail,
          unit: fieldUnitLabel(f),
          kind: ckind,
        });
      }
    } else {
      const fieldName = (op === "avg" ? parts[1] : parts[0])?.trim();
      const field = (ctx.fields ?? []).find((f) => f.variable === fieldName);
      if (field) {
        pool = displayAlternatives(field).map((alt) => ({
          insert: alt.unit,
          label: alt.unit,
          detail: "unit",
          kind: "unit",
        }));
      }
    }

    const matched = filterItems(pool, rawPrefix);
    if (matched.length === 0) return null;
    return { start, end: cursor, prefix: rawPrefix, items: matched };
  }

  // Typing a `{token` prefix
  const braceMatch = /(\{[A-Za-z]*)$/.exec(head);
  if (braceMatch) {
    const prefix = braceMatch[1];
    const start = cursor - prefix.length;
    if (!opts?.force && prefix.length < minPrefix) return null;
    const matched = filterItems(CAPTION_TOKENS, prefix);
    if (matched.length === 0) return null;
    return { start, end: cursor, prefix, items: matched };
  }

  // Forced Ctrl+Space outside braces offers all tokens at cursor
  if (opts?.force) {
    return { start: cursor, end: cursor, prefix: "", items: [...CAPTION_TOKENS] };
  }

  return null;
}

/** Replaces `[start, end)` in `text` with `item.insert` and returns the new text + cursor. */
export function applyFormulaCompletion(
  text: string,
  start: number,
  end: number,
  item: Pick<FormulaCompletionItem, "insert">
): { text: string; cursor: number } {
  const next = text.slice(0, start) + item.insert + text.slice(end);
  return { text: next, cursor: start + item.insert.length };
}
