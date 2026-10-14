/**
 * Parser, completion and help for the command line (`commandSpec.ts` holds the
 * registry). Pure: no DOM, no vscode, no fs — Node-testable and bundled into
 * the webview.
 *
 * Accepted syntax (one or more steps separated by `;`):
 *   verb {json}                     the remainder is one JSON object of arguments
 *   verb key=value key2=[1,2] flag  `flag` alone means true; `"quoted words"` ok
 *   verb value1 value2              bare tokens fill the spec's `positional` list
 *
 * Values are coerced by the parameter's declared type, which is the point: the
 * host validator rebuilds each record from a whitelist, so an unknown key would
 * be dropped silently and `fixBoundary=false` would become `Boolean("false")`.
 * Both are caught here with a message naming the culprit.
 */

import {
  COMMANDS,
  COMMAND_CATEGORIES,
  type CommandAction,
  type CommandSpec,
  type ParamSpec,
} from "./commandSpec";

export type StepResult =
  | { ok: true; action: CommandAction }
  | { ok: false; error: string; hint?: string };

export type ParseResult =
  | { ok: true; steps: CommandAction[] }
  | { ok: false; error: string; hint?: string; step?: number };

export interface CompletionContext {
  fields?: readonly string[];
  parts?: readonly string[];
  blocks?: readonly string[];
}

// ---- tokenizing -------------------------------------------------------------

/** Splits on `;` outside quotes and `{}`/`[]` nesting. Empty steps are dropped. */
export function splitSteps(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "{" || c === "[") {
      depth++;
      cur += c;
    } else if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (c === ";" && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface Token {
  text: string;
  start: number;
}

/** Whitespace-separated tokens; quotes and `{}`/`[]` nesting keep a token whole. */
export function tokenize(line: string): { tokens: Token[]; unterminated: boolean } {
  const tokens: Token[] = [];
  let cur = "";
  let start = -1;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const inTok = start >= 0;
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < line.length) cur += line[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (/\s/.test(c) && depth === 0) {
      if (inTok) {
        tokens.push({ text: cur, start });
        cur = "";
        start = -1;
      }
      continue;
    }
    if (!inTok) start = i;
    cur += c;
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
  }
  if (start >= 0) tokens.push({ text: cur, start });
  return { tokens, unterminated: quote !== "" || depth > 0 };
}

function unquote(raw: string): { text: string; quoted: boolean } {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
    return { text: raw.slice(1, -1).replace(/\\(["'\\])/g, "$1"), quoted: true };
  }
  return { text: raw, quoted: false };
}

// ---- resolution -------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Up to `max` closest names (prefix matches first, then edit distance <= 2). */
export function suggest(word: string, names: readonly string[], max = 3): string[] {
  const w = word.toLowerCase();
  const scored = names
    .map((n) => {
      const l = n.toLowerCase();
      const d = l.startsWith(w) || w.startsWith(l) ? 0 : editDistance(w, l);
      return { n, d };
    })
    .filter((s) => s.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((x, y) => x.d - y.d || x.n.localeCompare(y.n));
  return scored.slice(0, max).map((s) => s.n);
}

function verbNames(specs: readonly CommandSpec[]): { name: string; spec: CommandSpec }[] {
  const out: { name: string; spec: CommandSpec }[] = [];
  for (const spec of specs) {
    out.push({ name: spec.name, spec });
    for (const a of spec.aliases ?? []) out.push({ name: a, spec });
  }
  return out;
}

export function resolveCommand(
  word: string,
  specs: readonly CommandSpec[] = COMMANDS
): { ok: true; spec: CommandSpec } | { ok: false; error: string; hint?: string } {
  const w = word.toLowerCase();
  const names = verbNames(specs);
  const exact = names.find((n) => n.name.toLowerCase() === w);
  if (exact) return { ok: true, spec: exact.spec };
  const pref = names.filter((n) => n.name.toLowerCase().startsWith(w));
  const uniq = [...new Set(pref.map((p) => p.spec))];
  if (uniq.length === 1) return { ok: true, spec: uniq[0] };
  if (uniq.length > 1) {
    return {
      ok: false,
      error: `"${word}" is ambiguous`,
      hint: `did you mean ${uniq.slice(0, 6).map((s) => s.name).join(", ")}${uniq.length > 6 ? ", …" : ""}?`,
    };
  }
  const near = suggest(word, names.map((n) => n.name));
  return {
    ok: false,
    error: `unknown command "${word}"`,
    hint: near.length ? `did you mean ${near.join(", ")}? (type "list" for all commands)` : 'type "list" for all commands',
  };
}

// ---- coercion ---------------------------------------------------------------

function parseIdList(s: string): number[] | undefined {
  const t = s.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? v : undefined;
    } catch {
      return undefined;
    }
  }
  const out: number[] = [];
  for (const part of t.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(-?\d+)\s*-\s*(\d+)$/.exec(p);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (b < a || b - a > 1_000_000) return undefined;
      for (let i = a; i <= b; i++) out.push(i);
    } else if (/^-?\d+(\.\d+)?$/.test(p)) out.push(Number(p));
    else return undefined;
  }
  return out.length ? out : undefined;
}

function parseArray(s: string): unknown[] | undefined {
  const t = s.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }
  return t.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

export function coerce(
  p: ParamSpec,
  raw: string,
  quoted: boolean
): { ok: true; value: unknown } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `${p.name}: ${why}` });
  switch (p.type) {
    case "number": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) ? { ok: true, value: n } : bad(`"${raw}" is not a number`);
    }
    case "int": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isInteger(n) ? { ok: true, value: n } : bad(`"${raw}" is not an integer`);
    }
    case "bool": {
      const l = raw.toLowerCase();
      if (["true", "yes", "on", "1"].includes(l)) return { ok: true, value: true };
      if (["false", "no", "off", "0"].includes(l)) return { ok: true, value: false };
      return bad(`"${raw}" is not true/false`);
    }
    case "enum": {
      const values = p.values ?? [];
      const l = raw.toLowerCase();
      const hit = values.find((v) => v.toLowerCase() === l) ?? values.find((v) => v.toLowerCase() === "." + l);
      return hit !== undefined ? { ok: true, value: hit } : bad(`"${raw}" is not one of ${values.join(" | ")}`);
    }
    case "vec3": {
      const arr = parseArray(raw);
      const nums = arr?.map(Number);
      return nums && nums.length === 3 && nums.every(Number.isFinite)
        ? { ok: true, value: nums }
        : bad(`"${raw}" is not three numbers (e.g. 0,0,1)`);
    }
    case "ids": {
      const ids = parseIdList(raw);
      return ids ? { ok: true, value: ids } : bad(`"${raw}" is not an id list (e.g. 1,2,5-10)`);
    }
    case "list": {
      const arr = parseArray(raw);
      return arr && arr.length ? { ok: true, value: arr.map(String) } : bad("expected a comma-separated list");
    }
    case "json": {
      if (quoted) return { ok: true, value: raw };
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: true, value: raw };
      }
    }
    case "ext":
      return raw.trim() ? { ok: true, value: raw.startsWith(".") ? raw : "." + raw } : bad("expected a file extension");
    default:
      return { ok: true, value: raw };
  }
}

// ---- usage ------------------------------------------------------------------

function paramUsage(p: ParamSpec): string {
  const shape = p.type === "enum" ? (p.values ?? []).join("|") : p.type === "string" ? "text" : p.type;
  const s = `${p.name}=<${shape}>`;
  return p.required ? s : `[${s}]`;
}

export function usageLine(spec: CommandSpec): string {
  return [spec.name, ...spec.params.map(paramUsage)].join(" ");
}

export function helpLines(spec: CommandSpec): string[] {
  const lines = [`${usageLine(spec)} — ${spec.summary}`, `example: ${spec.example}`];
  if (spec.positional?.length) lines.push(`positional: ${spec.positional.join(", ")}`);
  return lines;
}

// ---- parsing ----------------------------------------------------------------

export function parseCommand(line: string, specs: readonly CommandSpec[] = COMMANDS): StepResult {
  const { tokens, unterminated } = tokenize(line);
  if (!tokens.length) return { ok: false, error: "empty command" };
  if (unterminated) return { ok: false, error: "unbalanced quote or bracket", hint: "close the quote/bracket and run again" };
  const verbTok = tokens[0].text;
  const resolved = resolveCommand(verbTok.startsWith("?") && verbTok.length > 1 ? "help" : verbTok, specs);
  if (!resolved.ok) return resolved;
  const spec = resolved.spec;
  const rest = tokens.slice(verbTok.startsWith("?") && verbTok.length > 1 ? 0 : 1);
  if (verbTok.startsWith("?") && verbTok.length > 1) rest[0] = { text: verbTok.slice(1), start: 0 };

  const args: Record<string, unknown> = {};
  const byName = new Map(spec.params.map((p) => [p.name.toLowerCase(), p]));
  const positional = [...(spec.positional ?? [])];
  const usage = usageLine(spec);

  const setArg = (p: ParamSpec, raw: string, quoted: boolean): { ok: false; error: string; hint?: string } | undefined => {
    const c = coerce(p, raw, quoted);
    if (!c.ok) return { ok: false, error: `${spec.name}: ${c.error}`, hint: usage };
    args[p.name] = c.value;
    return undefined;
  };

  for (const tok of rest) {
    const t = tok.text;
    if (t.startsWith("{")) {
      let obj: unknown;
      try {
        obj = JSON.parse(t);
      } catch (e) {
        return { ok: false, error: `${spec.name}: invalid JSON (${(e as Error).message})`, hint: usage };
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return { ok: false, error: `${spec.name}: JSON arguments must be an object`, hint: usage };
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const p = byName.get(k.toLowerCase());
        if (!p) return unknownParam(spec, k, usage);
        args[p.name] = v;
      }
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t);
    if (kv) {
      const p = byName.get(kv[1].toLowerCase());
      if (!p) return unknownParam(spec, kv[1], usage);
      const { text, quoted } = unquote(kv[2]);
      const err = setArg(p, text, quoted);
      if (err) return err;
      const idx = positional.indexOf(p.name);
      if (idx >= 0) positional.splice(idx, 1);
      continue;
    }
    const flag = byName.get(t.toLowerCase());
    if (flag && flag.type === "bool") {
      args[flag.name] = true;
      continue;
    }
    const next = positional.shift();
    if (!next) {
      return {
        ok: false,
        error: `${spec.name}: unexpected "${t}"`,
        hint: unknownHint(spec, t, usage),
      };
    }
    const p = byName.get(next.toLowerCase())!;
    const { text, quoted } = unquote(t);
    const err = setArg(p, text, quoted);
    if (err) return err;
  }

  for (const p of spec.params) {
    if (p.required && args[p.name] === undefined) {
      return { ok: false, error: `${spec.name}: missing required parameter "${p.name}"`, hint: usage };
    }
  }

  return { ok: true, action: toAction(spec, args) };
}

function unknownParam(spec: CommandSpec, key: string, usage: string): StepResult {
  const near = suggest(key, spec.params.map((p) => p.name));
  return {
    ok: false,
    error: `${spec.name}: unknown parameter "${key}"`,
    hint: near.length ? `did you mean ${near.join(", ")}? — ${usage}` : usage,
  };
}

function unknownHint(spec: CommandSpec, token: string, usage: string): string {
  const near = suggest(token, spec.params.map((p) => p.name));
  return near.length ? `did you mean ${near.join(", ")}? — ${usage}` : usage;
}

function toAction(spec: CommandSpec, args: Record<string, unknown>): CommandAction {
  const e = spec.exec;
  switch (e.kind) {
    case "op":
      return { kind: "op", op: spec.name, message: { type: "applyOp", op: spec.name, ...args } };
    case "post": {
      const message: Record<string, unknown> = { type: e.type };
      const nested: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (e.nest?.args.includes(k)) nested[k] = v;
        else message[k] = v;
      }
      if (e.nest && Object.keys(nested).length) message[e.nest.key] = nested;
      return { kind: "post", message };
    }
    case "ui": {
      const state = args.state === "on" ? true : args.state === "off" ? false : undefined;
      return { kind: "ui", action: e.action, state };
    }
    case "view":
      return { kind: "view", fn: e.fn, args };
    default:
      return { kind: "meta", fn: e.fn, args };
  }
}

export function parseCommandLine(text: string, specs: readonly CommandSpec[] = COMMANDS): ParseResult {
  const steps = splitSteps(text);
  if (!steps.length) return { ok: false, error: "empty command" };
  const actions: CommandAction[] = [];
  for (let i = 0; i < steps.length; i++) {
    const r = parseCommand(steps[i], specs);
    if (!r.ok) {
      return {
        ok: false,
        error: steps.length > 1 ? `step ${i + 1}: ${r.error}` : r.error,
        hint: r.hint,
        step: i,
      };
    }
    actions.push(r.action);
  }
  return { ok: true, steps: actions };
}

// ---- completion -------------------------------------------------------------

export interface Completion {
  /** Offset in the full text where the replaced word starts. */
  from: number;
  candidates: string[];
}

/** Completes the word at the end of `text` (the cursor is assumed to be there). */
export function completions(
  text: string,
  ctx: CompletionContext = {},
  specs: readonly CommandSpec[] = COMMANDS
): Completion {
  // Only the current step matters.
  let stepStart = 0;
  {
    let depth = 0;
    let quote = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0) stepStart = i + 1;
    }
  }
  const stepText = text.slice(stepStart);
  const lead = stepText.length - stepText.trimStart().length;
  const body = stepText.slice(lead);
  const bodyStart = stepStart + lead;
  const { tokens } = tokenize(body);
  const endsWithSpace = /\s$/.test(body);

  // Verb position.
  if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
    const word = (tokens[0]?.text ?? "").toLowerCase();
    const names = verbNames(specs)
      .map((n) => n.name)
      .filter((n) => n.toLowerCase().startsWith(word) && !n.startsWith("?"));
    return { from: bodyStart, candidates: [...new Set(names)].sort((a, b) => a.localeCompare(b)) };
  }

  const resolved = resolveCommand(tokens[0].text, specs);
  if (!resolved.ok) return { from: text.length, candidates: [] };
  const spec = resolved.spec;
  const cur = endsWithSpace ? { text: "", start: text.length } : { text: tokens[tokens.length - 1].text, start: bodyStart + tokens[tokens.length - 1].start };
  const usedTokens = endsWithSpace ? tokens.slice(1) : tokens.slice(1, -1);
  const used = new Set<string>();
  let positionalUsed = 0;
  for (const t of usedTokens) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t.text);
    if (kv) used.add(kv[1].toLowerCase());
    else if (!t.text.startsWith("{")) positionalUsed++;
  }

  const eq = cur.text.indexOf("=");
  const pool = (p: ParamSpec): readonly string[] => {
    if (p.type === "enum") return p.values ?? [];
    if (p.type === "bool") return ["true", "false"];
    if (p.type === "field") return ctx.fields ?? [];
    if (p.type === "part") return ctx.parts ?? [];
    if (p.type === "block") return ctx.blocks ?? [];
    return [];
  };

  if (eq > 0) {
    const key = cur.text.slice(0, eq).toLowerCase();
    const p = spec.params.find((q) => q.name.toLowerCase() === key);
    if (!p) return { from: cur.start, candidates: [] };
    const prefix = cur.text.slice(eq + 1).toLowerCase();
    const cands = pool(p).filter((v) => v.toLowerCase().startsWith(prefix));
    return { from: cur.start + eq + 1, candidates: [...cands] };
  }

  const prefix = cur.text.toLowerCase();
  const out: string[] = [];
  // The next positional parameter's values first (e.g. `view <top|front|…>`).
  const nextPos = (spec.positional ?? [])[positionalUsed];
  if (nextPos) {
    const p = spec.params.find((q) => q.name === nextPos);
    if (p) for (const v of pool(p)) if (v.toLowerCase().startsWith(prefix)) out.push(v);
  }
  for (const p of spec.params) {
    if (used.has(p.name.toLowerCase())) continue;
    if (p.name.toLowerCase().startsWith(prefix)) out.push(`${p.name}=`);
  }
  return { from: cur.start, candidates: out };
}

/** One summary line per command, for `list`. */
export function listLines(category?: string, specs: readonly CommandSpec[] = COMMANDS): string[] {
  const cats = category ? COMMAND_CATEGORIES.filter((c) => c.startsWith(category.toLowerCase())) : COMMAND_CATEGORIES;
  const lines: string[] = [];
  for (const c of cats) {
    const names = specs.filter((s) => s.category === c).map((s) => s.name);
    if (names.length) lines.push(`${c}: ${names.join(" ")}`);
  }
  return lines;
}
