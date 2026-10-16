import { exponentsForUnitName } from "../fieldDimensions";
import type { ImportOptions, PlotColumn, PlotTable, PlotValue } from "./types";

export const PLOT_MAX_ROWS = 1_000_000;
export const PLOT_MAX_COLUMNS = 256;
export const PLOT_MAX_BYTES = 128 * 1024 * 1024;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const finite = (s: string): number | undefined => NUMBER.test(s.trim()) && Number.isFinite(Number(s)) ? Number(s) : undefined;

/** A canonical finite number (String(n) === s) becomes a number without the regex; anything else stays a string. */
const cellValue = (s: string): PlotValue => { const n = +s; return n - n === 0 && String(n) === s ? n : s; };
const convertInPlace = (row: string[]): PlotValue[] => { const out = row as unknown as PlotValue[]; for (let i = 0; i < row.length; i++) out[i] = cellValue(row[i]); return out; };

/**
 * RFC4180 record lexer, streaming: each completed record goes to `onRow`, so a
 * caller can convert it at once instead of holding every cell as a string.
 * A trailing newline is not an extra empty sample. `onRow` returns true to stop.
 */
function lexRecords(text: string, delimiter: string, onRow: (row: string[]) => boolean | void): void {
  // Rows are allocated at the first record's width: push() growth leaves ~17 slots per retained row.
  let row: string[] = [], rc = 0, width = 0, cell = "", quoted = false, closed = false, count = 0;
  const delimCode = delimiter.charCodeAt(0);
  const push = () => { row[rc++] = cell; cell = ""; closed = false; };
  const end = (): boolean => {
    push();
    if (row.length !== rc) row.length = rc;
    if (!count) width = rc;
    const done = onRow(row) === true;
    row = width ? new Array<string>(width) : []; rc = 0;
    if (++count > PLOT_MAX_ROWS + 1) throw new Error(`Tables are limited to ${PLOT_MAX_ROWS} data rows; split the input explicitly.`);
    return done;
  };
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed) {
      if (c === delimiter) push();
      else if (c === "\r" || c === "\n") { if (end()) return; if (c === "\r" && text[i + 1] === "\n") i++; }
      else if (c.trim()) throw new Error(`Unexpected text after a quoted cell at character ${i + 1}.`);
      else cell += c;
    } else if (c === delimiter) push();
    else if (c === "\r" || c === "\n") { if (end()) return; if (c === "\r" && text[i + 1] === "\n") i++; }
    else {
      // Plain text up to the next delimiter or line break: one slice, not one append per character.
      let j = i + 1;
      for (; j < n; j++) { const k = text.charCodeAt(j); if (k === delimCode || k === 10 || k === 13) break; }
      cell += text.slice(i, j);
      i = j - 1;
    }
    if (rc >= PLOT_MAX_COLUMNS) throw new Error(`Tables are limited to ${PLOT_MAX_COLUMNS} columns.`);
  }
  if (quoted) throw new Error("Unterminated quoted cell.");
  if (cell || rc || closed) end();
}

function records(text: string, delimiter: string, stopAfter = Infinity): string[][] {
  const rows: string[][] = [];
  lexRecords(text, delimiter, row => { rows.push(row); return rows.length >= stopAfter; });
  return rows;
}

export function parsePlotTable(text: string, options: ImportOptions = {}): PlotTable {
  if (text.length > PLOT_MAX_BYTES) throw new Error("Table exceeds the 128 MiB import budget.");
  text = text.replace(/^\uFEFF/, "");
  let delimiter = options.delimiter;
  if (delimiter && ![",", "\t", ";", "|"].includes(delimiter)) throw new Error("Unsupported delimiter.");
  if (!delimiter) {
    // Score consistency on complete records, never split a quoted/multiline cell.
    let best = 0;
    delimiter = ",";
    for (const candidate of [",", "\t", ";", "|"] as const) {
      try {
        const r = records(text, candidate, 30);
        const width = r[0]?.length ?? 1;
        const score = width > 1 ? r.filter(row => row.length === width).length * 10 + width : 0;
        if (score > best) { best = score; delimiter = candidate; }
      } catch { /* a candidate delimiter may not accept this record grammar */ }
    }
  }
  // Each record is converted as it is lexed: a numeric-looking cell becomes a number,
  // kept as its original string only when String(n) would not reproduce it (so a text
  // column can still be restored exactly). This avoids a second full table of strings.
  const rows: PlotValue[][] = [];
  let firstRaw: string[] | undefined;
  lexRecords(text, delimiter, row => {
    if (!firstRaw) { firstRaw = row; return; }
    rows.push(convertInPlace(row));
  });
  if (!firstRaw) throw new Error("The table has no records.");
  const width = firstRaw.length;
  if (width > PLOT_MAX_COLUMNS) throw new Error("Too many table columns.");
  const missing = new Set(options.missing ?? ["", "NA", "N/A", "null"]);
  const isMissing = (s: string) => missing.has(s.trim());
  const isNum = (v: unknown) => typeof v === "number" || finite(v === undefined ? "" : String(v)) !== undefined;
  const header = options.header ?? (rows.length > 0 && firstRaw.some((s, i) => finite(s) === undefined && !isMissing(s) && isNum(rows[0][i])));
  const labels = header ? firstRaw : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  if (!header) rows.unshift(convertInPlace(firstRaw.slice()));
  if (rows.length > PLOT_MAX_ROWS) throw new Error(`Tables are limited to ${PLOT_MAX_ROWS} data rows; split the input explicitly.`);
  const diagnostics = [`Delimiter: ${delimiter === "\t" ? "tab" : delimiter}; ${header ? "first record is header" : "generated headers"}.`];
  const asString = (v: unknown): string | undefined => v === undefined ? undefined : String(v);
  const columns: PlotColumn[] = labels.map((label, i) => {
    const match = label.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    const id = `c${i}`;
    const unit = options.units?.[id] ?? match?.[2];
    let numeric = true;
    if (options.numericColumns) numeric = options.numericColumns.includes(id);
    else {
      for (const r of rows) {
        const v = r[i] as unknown;
        if (typeof v === "number") continue;
        const s = asString(v);
        if (s === undefined || isMissing(s)) continue;
        if (finite(s) === undefined && !/^(?:[+-]?inf(?:inity)?|nan)$/i.test(s.trim())) { numeric = false; break; }
      }
    }
    return { id, label: (match?.[1] ?? label).trim() || `Column ${i + 1}`, type: numeric ? "number" : "text", ...(unit ? { unit, dimensions: exponentsForUnitName(unit) } : {}) };
  });
  let ragged = 0, invalid = 0, absent = 0;
  // A number cell is missing only when the missing set names exactly that number's spelling.
  const missingNumbers = new Set<number>();
  for (const m of missing) { const v = cellValue(m.trim()); if (typeof v === "number" && m === m.trim()) missingNumbers.add(v); }
  const numberCol = columns.map(c => c.type === "number");
  for (const row of rows) {
    if (row.length !== width) ragged++;
    for (let i = 0; i < width; i++) {
      const v = row[i] as unknown;
      if (typeof v === "number") {
        if (missingNumbers.size && missingNumbers.has(v)) { absent++; row[i] = null; }
        else if (!numberCol[i]) row[i] = String(v);
        continue;
      }
      if (v === undefined) { absent++; row[i] = null; continue; }
      const s = v as string;
      if (isMissing(s)) { absent++; row[i] = null; continue; }
      if (!numberCol[i]) continue;
      const n = finite(s);
      if (n === undefined) { invalid++; row[i] = null; } else row[i] = n;
    }
  }
  if (ragged) throw new Error(`${ragged} records have a different column count; correct the delimiter or input.`);
  if (invalid) diagnostics.push(`${invalid} invalid/nonfinite numeric cells retained as gaps.`);
  if (absent) diagnostics.push(`${absent} missing cells retained as gaps.`);
  if (new Set(columns.map(c => c.label)).size !== columns.length) diagnostics.push("Duplicate headers have distinct stable column IDs.");
  return { columns, rows, diagnostics };
}
