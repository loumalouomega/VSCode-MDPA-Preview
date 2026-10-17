/**
 * Kratos materials-table text: `"input,output; …"` pairs, one row per `;`.
 * Used by temperature-dependent (and any table-reading) constitutive laws: the
 * sidebar edits it as a grid, the materials file carries the parsed rows, and
 * Generate, preflight and the editor share the validation here.
 *
 * Pure: no vscode, no DOM.
 */

/** Parses a `"input,output; …"` table text into Kratos `[[in, out], …]` rows. */
export function parseTableText(raw: unknown): number[][] {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("enter one `input,output` pair per `;`");
  const rows = raw.split(";").map((r) => r.trim()).filter((r) => r !== "");
  if (rows.length < 2) throw new Error("at least two pairs are needed to interpolate");
  return rows.map((r) => {
    const pair = r.split(",").map((x) => Number(x.trim()));
    if (pair.length !== 2 || pair.some((x) => !Number.isFinite(x))) throw new Error(`"${r}" is not an "input,output" pair of numbers`);
    return pair;
  });
}

/** Formats parsed rows back to editable text, round-tripping through the parser. */
export function formatTableText(rows: number[][]): string {
  return rows.map((r) => `${String(r[0])},${String(r[1])}`).join("; ");
}

/** The validation message for a table text, or undefined when it parses. */
export function tableTextProblem(raw: unknown): string | undefined {
  try {
    parseTableText(raw);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** One grid row: the pair plus the per-row problem, if any. */
export interface TableRow {
  input: string;
  output: string;
}

/** Splits editable text into grid rows, keeping malformed rows editable with their problem. */
export function textToRows(raw: unknown): { rows: TableRow[]; problems: string[] } {
  if (typeof raw !== "string" || raw.trim() === "") return { rows: [{ input: "", output: "" }], problems: ["enter one `input,output` pair per `;`"] };
  const rows: TableRow[] = [];
  const problems: string[] = [];
  for (const part of raw.split(";")) {
    const text = part.trim();
    if (text === "") continue;
    const pair = text.split(",").map((x) => x.trim());
    if (pair.length !== 2 || pair.some((x) => !Number.isFinite(Number(x)) || x === "")) {
      problems.push(`"${text}" is not an "input,output" pair of numbers`);
      rows.push({ input: pair[0] ?? "", output: pair[1] ?? "" });
    } else {
      rows.push({ input: pair[0], output: pair[1] });
    }
  }
  if (rows.length === 0) {
    rows.push({ input: "", output: "" });
    if (problems.length === 0) problems.push("enter one `input,output` pair per `;`");
  }
  if (rows.length === 1 && problems.length === 0) problems.push("at least two pairs are needed to interpolate");
  return { rows, problems };
}

/** Joins grid rows back to editable text, skipping empty rows. */
export function rowsToText(rows: TableRow[]): string {
  return rows
    .map((r) => `${r.input.trim()},${r.output.trim()}`)
    .filter((r) => r !== ",")
    .join("; ");
}
