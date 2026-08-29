/**
 * Parses the VALUES inside an mdpa `Begin Properties <id>` block.
 *
 * Until this module existed the extension kept only a `MetaBlock`
 * (`{label, lineCount}`) for a Properties block — it counted the lines and threw
 * the text away. That was enough for a lossless Save, because `mdpaWriter.ts`
 * copies Properties verbatim out of the original source text, but it left the
 * actual data unreachable. Two features want it:
 *
 *  - **beam / line-cell rendering** needs `CROSS_AREA` per cell, joined through
 *    the `propertyIds` an `EntityBlock` already carries per row;
 *  - **merge mesh** reports (`mergeMesh.ts`) that a merged-in file's Properties
 *    are dropped and its cells' ids now resolve against the *base* mesh.
 *
 * Pure — no `vscode`, no DOM, no fs — because the webview bundle reaches it
 * through the beam renderer, the same cross-runtime arrangement `sizeExpr.ts`
 * and `sphereElements.ts` use.
 *
 * **Tolerant, never throwing**, like every other parser here: an unrecognised
 * value is kept as its raw text (`kind: "string"`) rather than dropped, so a
 * Properties inspector can still show it and a round-trip through this module
 * loses nothing a human could read. Only a *malformed* structured value — a
 * `[3]` whose payload is not three numbers — earns a diagnostic, and even then
 * the values that did parse are kept.
 *
 * The syntaxes below are the ones that actually occur in Kratos files; the
 * repo's own reference fixture (`test_model_part_io_read.mdpa`) carries all of
 * them, which is what this module is tested against:
 *
 * ```
 * IS_RESTARTED 1                                        number
 * COMPUTE_LUMPED_MASS_MATRIX False                      bool (Python-cased, unquoted)
 * DENSITY 3.4E-5  //scalar                              number (comment already stripped)
 * VOLUME_ACCELERATION [3] (0.00,0.00,9.8)               vector — also written [3](...)
 * LOCAL_INERTIA_TENSOR [3,3] ((0,0.27,0.27),(...),(...)) matrix
 * ```
 *
 * A `Begin Table` nested inside a Properties block is captured as a
 * `PropertyTable` on the owning set rather than being lost — see
 * `mdpaParser.ts`, which previously let it become a stray top-level meta block.
 */

/** One parsed value. A plain, JSON-serializable tagged union — see PropertySet. */
export type PropertyValue =
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "vector"; values: number[] }
  | { kind: "matrix"; rows: number[][] }
  | { kind: "string"; value: string };

/** A `Begin Table` nested inside a Properties block. */
export interface PropertyTable {
  /** Header tokens after `Begin Table` — e.g. `["TEMPERATURE", "VISCOSITY"]`. */
  args: string[];
  /** One row of numbers per data line. */
  rows: number[][];
}

/**
 * One `Begin Properties <id>` block.
 *
 * `variables` is a plain object rather than a `Map` **deliberately**: this rides
 * on `MdpaModel` across `postMessage` to the webview, and the screenshot harness
 * re-serializes every message through `JSON.stringify` (with a typed-array
 * tag/revive replacer). A `Map` survives VS Code's structured clone but becomes
 * `{}` in the harness — i.e. it would work in production and silently fail in
 * the one environment used to verify the rendering.
 */
export interface PropertySet {
  id: number;
  variables: Record<string, PropertyValue>;
  tables: PropertyTable[];
}

/**
 * Reads a variable out of a set without touching the prototype chain.
 *
 * Names come from a file on disk, so `__proto__` / `constructor` are reachable
 * as keys; a bare `set.variables[name]` would return `Object.prototype`'s member
 * for those. (`sizeExpr.ts` guards the same way for the same reason.)
 */
export function propertyValue(set: PropertySet, name: string): PropertyValue | undefined {
  return Object.prototype.hasOwnProperty.call(set.variables, name)
    ? set.variables[name]
    : undefined;
}

/** The numeric value of `name`, or undefined when it is absent or not a number. */
export function propertyNumber(set: PropertySet, name: string): number | undefined {
  const v = propertyValue(set, name);
  if (v?.kind === "number" && Number.isFinite(v.value)) return v.value;
  return undefined;
}

/** Finds a set by its Properties id. */
export function findPropertySet(
  sets: readonly PropertySet[] | undefined,
  id: number
): PropertySet | undefined {
  return sets?.find((s) => s.id === id);
}

/** Creates an empty set. Kept here so the container shape has one owner. */
export function emptyPropertySet(id: number): PropertySet {
  // Object.create(null) rather than {} so a variable literally named
  // "__proto__" becomes an ordinary own property instead of reassigning the
  // prototype. JSON.stringify treats it exactly like a plain object.
  return { id, variables: Object.create(null) as Record<string, PropertyValue>, tables: [] };
}

/**
 * Parses the id out of a `Begin Properties …` header's arguments.
 *
 * Returns `undefined` for a missing or unreadable id, and the caller must then
 * diagnose and **not register the set**. Defaulting to 0 would be worse than
 * useless: every example mdpa opens with a real `Begin Properties 0`, so a
 * malformed header would silently shadow it and hand every cell that references
 * property 0 the wrong section.
 */
export function propertiesIdFromArgs(args: readonly string[]): number | undefined {
  const raw = args[0];
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? undefined : id;
}

/** Splits "A, B ,C" into trimmed, non-empty parts. */
function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses a comma-separated numeric list; undefined if any entry is not a number. */
function numberList(text: string): number[] | undefined {
  const parts = splitList(text);
  if (parts.length === 0) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return undefined;
    out.push(n);
  }
  return out;
}

/** Strips one balanced outer pair of parentheses, or returns undefined. */
function unwrapParens(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return undefined;
  return t.slice(1, -1);
}

const BOOL_WORDS: Record<string, boolean> = {
  true: true,
  false: false,
  True: true,
  False: false,
};

/** True when the text is a single bareword Kratos writes for a boolean. */
function boolWord(text: string): boolean | undefined {
  const b = BOOL_WORDS[text];
  return typeof b === "boolean" ? b : undefined;
}

/**
 * Parses one `NAME <value>` line's value half.
 *
 * `raw` is the text after the variable name, whitespace-normalized (the caller
 * has already stripped `//` comments). `onDiagnostic` is called for a value that
 * is structurally recognisable but internally inconsistent — the value is still
 * returned, with whatever parsed.
 */
export function parsePropertyValue(
  raw: string,
  onDiagnostic?: (message: string) => void
): PropertyValue {
  const text = raw.trim();
  if (text.length === 0) return { kind: "string", value: "" };

  // Structured forms announce themselves with a leading dimension spec:
  //   [3] (a,b,c)          vector
  //   [3,3] ((..),(..))    matrix
  // The space between the spec and the payload is optional in the wild.
  const dim = /^\[\s*(\d+)\s*(?:,\s*(\d+)\s*)?\]\s*(.*)$/s.exec(text);
  if (dim) {
    const rowsDeclared = parseInt(dim[1], 10);
    const colsDeclared = dim[2] === undefined ? undefined : parseInt(dim[2], 10);
    const payload = dim[3].trim();

    if (colsDeclared === undefined) {
      const inner = unwrapParens(payload);
      const values = inner === undefined ? undefined : numberList(inner);
      if (!values) {
        onDiagnostic?.(`vector value "${text}" is not a parenthesised list of numbers.`);
        return { kind: "string", value: text };
      }
      if (values.length !== rowsDeclared) {
        onDiagnostic?.(
          `vector declares [${rowsDeclared}] but carries ${values.length} value(s); ` +
            `keeping the values as written.`
        );
      }
      return { kind: "vector", values };
    }

    const outer = unwrapParens(payload);
    if (outer === undefined) {
      onDiagnostic?.(`matrix value "${text}" is not parenthesised.`);
      return { kind: "string", value: text };
    }
    // Rows are the innermost parenthesised groups; anything between them is
    // separator punctuation we do not need to model.
    const rows: number[][] = [];
    let bad = false;
    for (const m of outer.matchAll(/\(([^()]*)\)/g)) {
      const nums = numberList(m[1]);
      if (!nums) {
        bad = true;
        break;
      }
      rows.push(nums);
    }
    if (bad || rows.length === 0) {
      onDiagnostic?.(`matrix value "${text}" does not parse as rows of numbers.`);
      return { kind: "string", value: text };
    }
    if (rows.length !== rowsDeclared || rows.some((r) => r.length !== colsDeclared)) {
      onDiagnostic?.(
        `matrix declares [${rowsDeclared},${colsDeclared}] but carries ` +
          `${rows.length} row(s) of ${rows.map((r) => r.length).join("/")}; ` +
          `keeping the values as written.`
      );
    }
    return { kind: "matrix", rows };
  }

  // Unstructured: a single token is a bool or a number if it looks like one,
  // and otherwise — like anything with embedded spaces — is kept verbatim.
  if (!/\s/.test(text)) {
    const b = boolWord(text);
    if (b !== undefined) return { kind: "bool", value: b };
    const n = Number(text);
    if (Number.isFinite(n)) return { kind: "number", value: n };
  }
  return { kind: "string", value: text };
}

/**
 * Parses one whole `Begin Properties … End Properties` block from its inner
 * lines. Standalone entry point used by the tests; `mdpaParser.ts` feeds the
 * same logic line by line as part of its own state machine.
 */
export function parsePropertiesBlock(
  id: number,
  lines: readonly string[],
  onDiagnostic?: (message: string) => void
): PropertySet {
  const set = emptyPropertySet(id);
  let table: PropertyTable | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === "Begin" && tokens[1] === "Table") {
      table = { args: tokens.slice(2), rows: [] };
      set.tables.push(table);
      continue;
    }
    if (tokens[0] === "End" && tokens[1] === "Table") {
      table = undefined;
      continue;
    }
    if (table) {
      const nums = tokens.map(Number);
      if (nums.every((n) => Number.isFinite(n))) table.rows.push(nums);
      continue;
    }
    addPropertyLine(set, tokens, line, onDiagnostic);
  }
  return set;
}

/**
 * Records one `NAME <value>` line onto a set.
 *
 * Shared by `parsePropertiesBlock` and `mdpaParser.ts` so the two cannot drift.
 * `line` is the whitespace-normalized full line; `tokens` is it split — both are
 * passed because the caller already has them and a matrix value cannot be
 * reassembled from tokens without re-joining.
 */
export function addPropertyLine(
  set: PropertySet,
  tokens: readonly string[],
  line: string,
  onDiagnostic?: (message: string) => void
): void {
  const name = tokens[0];
  if (!name) return;
  const rest = line.slice(name.length).trim();
  set.variables[name] = parsePropertyValue(rest, (m) =>
    onDiagnostic?.(`Properties ${set.id}, ${name}: ${m}`)
  );
}
