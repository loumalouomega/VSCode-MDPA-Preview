/**
 * Evaluated tokens in screenshot titles/captions and recorder frame labels
 * (roadmap item 40). Pure: no DOM, no vscode. Capture must never fail, so every
 * problem prints `?` and adds a diagnostic instead of throwing.
 *
 *   {max(F[,unit])}  {min(F[,unit])}  {avg(Part,F[,unit])}  {time}  {step}
 *
 * A vector field reduces over its magnitude. `unit` must be a display
 * alternative of the field's known dimensions (fieldDimensions.ts); a field of
 * unknown dimensions accepts no unit.
 */
import type { FieldData, MdpaModel } from "./types";
import { displayAlternatives } from "./fieldDimensions";
import { regionEntityIds } from "./plot/region";

export interface CaptionContext {
  model?: MdpaModel;
  /** Label of the frame on screen (timeline step label), if any. */
  step?: string;
  /** Physical time of the frame, if known. */
  time?: number | string;
}

export interface CaptionResult {
  text: string;
  diagnostics: string[];
}

const TOKEN = /\{\s*([A-Za-z]+)\s*(?:\(([^)]*)\))?\s*\}/g;

function findField(model: MdpaModel, variable: string): FieldData | undefined {
  for (const kind of ["Nodal", "Elemental", "Conditional"] as const) {
    const f = model.fields.find((x) => x.kind === kind && x.variable === variable);
    if (f) return f;
  }
  return undefined;
}

function rowValue(f: FieldData, row: number): number {
  const w = Math.max(1, f.components);
  if (w === 1) return f.values[row];
  let s = 0;
  for (let c = 0; c < w; c++) s += f.values[row * w + c] ** 2;
  return Math.sqrt(s);
}

export function formatCaptionNumber(v: number): string {
  if (!Number.isFinite(v)) return "?";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(3).replace(/\.?0+e/, "e");
  return String(Number(v.toPrecision(4)));
}

/** Scale (divisor) for `unit`; undefined when the field cannot show that unit. */
function unitScale(f: FieldData, unit: string | undefined): number | undefined {
  if (!unit) return 1;
  if (!f.dimensions) return undefined;
  const alt = displayAlternatives(f).find((a) => a.unit === unit);
  return alt && alt.scale > 0 ? alt.scale : undefined;
}

type Op = "max" | "min" | "avg";

function reduce(model: MdpaModel, op: Op, args: string[], diag: string[]): string {
  const [part, variable, unit] = op === "avg" ? [args[0], args[1], args[2]] : [undefined, args[0], args[1]];
  if (!variable) { diag.push(`{${op}} needs a field name.`); return "?"; }
  const field = findField(model, variable);
  if (!field || field.pendingRows) { diag.push(`No field "${variable}" for {${op}}.`); return "?"; }
  const scale = unitScale(field, unit);
  if (scale === undefined) { diag.push(`Field "${variable}" cannot be shown in "${unit}".`); return "?"; }
  let allowed: Set<number> | undefined;
  if (part !== undefined) {
    try { allowed = regionEntityIds(model, { kind: field.kind, submodelpart: part }); }
    catch { diag.push(`No SubModelPart "${part}".`); return "?"; }
  }
  let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
  for (let i = 0; i < field.ids.length; i++) {
    if (allowed && !allowed.has(field.ids[i])) continue;
    const v = rowValue(field, i);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
    n++;
  }
  if (n === 0) { diag.push(`{${op}(${variable})} found no values.`); return "?"; }
  const raw = op === "max" ? hi : op === "min" ? lo : sum / n;
  return formatCaptionNumber(raw / scale) + (unit ? ` ${unit}` : "");
}

export function hasCaptionTokens(text: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(text);
}

export function evaluateCaption(text: string, ctx: CaptionContext): CaptionResult {
  const diagnostics: string[] = [];
  if (!text) return { text, diagnostics };
  const out = text.replace(TOKEN, (whole, rawName: string, rawArgs: string | undefined) => {
    try {
      const name = rawName.toLowerCase();
      const args = rawArgs === undefined ? [] : rawArgs.split(",").map((s) => s.trim());
      if (name === "time") {
        if (ctx.time === undefined) { diagnostics.push("{time}: this frame has no physical time."); return "?"; }
        return typeof ctx.time === "number" ? formatCaptionNumber(ctx.time) : ctx.time;
      }
      if (name === "step") {
        if (ctx.step === undefined) { diagnostics.push("{step}: this frame has no step label."); return "?"; }
        return ctx.step;
      }
      if (name === "max" || name === "min" || name === "avg") {
        if (!ctx.model) { diagnostics.push(`{${name}}: no mesh is loaded.`); return "?"; }
        return reduce(ctx.model, name, args, diagnostics);
      }
      diagnostics.push(`Unknown caption token ${whole}.`);
      return whole;
    } catch (e) {
      diagnostics.push(`${whole}: ${e instanceof Error ? e.message : String(e)}`);
      return "?";
    }
  });
  return { text: out, diagnostics };
}
