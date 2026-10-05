import { exponentsForUnitName } from "../fieldDimensions";
import type { ImportOptions, PlotColumn, PlotTable, PlotValue } from "./types";

export const PLOT_MAX_ROWS = 1_000_000;
export const PLOT_MAX_COLUMNS = 256;
export const PLOT_MAX_BYTES = 128 * 1024 * 1024;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const finite = (s: string): number | undefined => NUMBER.test(s.trim()) && Number.isFinite(Number(s)) ? Number(s) : undefined;

/** RFC4180 record lexer. A trailing newline is not an extra empty sample. */
function records(text: string, delimiter: string, stopAfter = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const push = () => { row.push(cell); cell = ""; closed = false; };
  const end = () => {
    push();
    rows.push(row); row = [];
    if (rows.length > PLOT_MAX_ROWS + 1) throw new Error(`Tables are limited to ${PLOT_MAX_ROWS} data rows; split the input explicitly.`);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === delimiter) push();
    else if (c === "\r" || c === "\n") { end(); if (rows.length >= stopAfter) return rows; if (c === "\r" && text[i + 1] === "\n") i++; }
    else {
      if (closed && c.trim()) throw new Error(`Unexpected text after a quoted cell at character ${i + 1}.`);
      cell += c;
    }
    if (row.length >= PLOT_MAX_COLUMNS) throw new Error(`Tables are limited to ${PLOT_MAX_COLUMNS} columns.`);
  }
  if (quoted) throw new Error("Unterminated quoted cell.");
  if (cell || row.length || closed) end();
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
  const raw = records(text, delimiter);
  if (!raw.length) throw new Error("The table has no records.");
  const width = raw[0].length;
  if (width > PLOT_MAX_COLUMNS) throw new Error("Too many table columns.");
  const missing = new Set(options.missing ?? ["", "NA", "N/A", "null"]);
  const isMissing = (s: string) => missing.has(s.trim());
  const header = options.header ?? (raw.length > 1 && raw[0].some((s, i) => finite(s) === undefined && !isMissing(s) && finite(raw[1][i] ?? "") !== undefined));
  const labels = header ? raw.shift()! : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  if (raw.length > PLOT_MAX_ROWS) throw new Error(`Tables are limited to ${PLOT_MAX_ROWS} data rows; split the input explicitly.`);
  const diagnostics = [`Delimiter: ${delimiter === "\t" ? "tab" : delimiter}; ${header ? "first record is header" : "generated headers"}.`];
  const columns: PlotColumn[] = labels.map((label, i) => {
    const match = label.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    const id = `c${i}`;
    const unit = options.units?.[id] ?? match?.[2];
    const values = raw.map(r => r[i] ?? "").filter(s => !isMissing(s));
    const numeric = options.numericColumns ? options.numericColumns.includes(id) : values.length === 0 || values.every(s => finite(s) !== undefined || /^(?:[+-]?inf(?:inity)?|nan)$/i.test(s.trim()));
    return { id, label: (match?.[1] ?? label).trim() || `Column ${i + 1}`, type: numeric ? "number" : "text", ...(unit ? { unit, dimensions: exponentsForUnitName(unit) } : {}) };
  });
  let ragged = 0, invalid = 0, absent = 0;
  const rows: PlotValue[][] = raw.map(row => {
    if (row.length !== width) ragged++;
    return columns.map((c, i) => {
      const s = row[i];
      if (s === undefined || isMissing(s)) { absent++; return null; }
      if (c.type === "text") return s;
      const n = finite(s);
      if (n === undefined) { invalid++; return null; }
      return n;
    });
  });
  if (ragged) throw new Error(`${ragged} records have a different column count; correct the delimiter or input.`);
  if (invalid) diagnostics.push(`${invalid} invalid/nonfinite numeric cells retained as gaps.`);
  if (absent) diagnostics.push(`${absent} missing cells retained as gaps.`);
  if (new Set(columns.map(c => c.label)).size !== columns.length) diagnostics.push("Duplicate headers have distinct stable column IDs.");
  return { columns, rows, diagnostics };
}
