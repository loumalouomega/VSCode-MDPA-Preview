/**
 * XLSX (SpreadsheetML) writer for a `TableView` — the second consumer of the
 * from-scratch ZIP writer in `src/parser/zip.ts`, which until now existed only
 * for the problem archive.
 *
 * Host-only: `zip.ts` pulls `node:zlib`, so this module must never be imported
 * by the webview bundle. The webview gets `dataTable.ts` and nothing else from
 * this pair.
 *
 * Deliberately minimal OOXML — five parts, inline strings (`t="inlineStr"`)
 * rather than a shared-string table, and bare `<v>` numbers with no styles.
 * A spreadsheet is a delivery format here, not a document: the point is that
 * the numbers open in Excel/Sheets/Numbers with their column headers intact.
 *
 * CSV remains the format for a table larger than a worksheet can hold — that
 * is why both ship, and why the row cap below reports what it dropped instead
 * of quietly writing a short file.
 */

import { TableView, f32str } from "../dataTable";
import { ZipEntry, createZip } from "../zip";

/** A worksheet holds 1 048 576 rows; one of them is the header. */
export const XLSX_MAX_ROWS = 1_048_575;
/** ...and 16 384 columns. */
export const XLSX_MAX_COLUMNS = 16_384;

export interface XlsxResult {
  data: Buffer;
  /** Data rows actually written (header excluded). */
  rows: number;
  /** Rows dropped at the worksheet limit — non-zero means tell the user. */
  truncated: number;
  /** Columns dropped at the worksheet limit. */
  truncatedColumns: number;
}

function xmlText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    // XML 1.0 forbids most control characters outright; there is no escape
    // that would make them legal, so they are dropped rather than emitted.
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
  }
  return out;
}

/** A1, B1, … Z1, AA1 — the column part is base-26 bijective. */
export function cellRef(col: number, row: number): string {
  let name = "";
  for (let n = col + 1; n > 0; ) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name + row;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/** Excel rejects these in a sheet name, and silently mangles an over-long one. */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
  return cleaned.length > 0 ? cleaned : "Sheet1";
}

/**
 * What of `view` fits in a worksheet. Split out of `writeXlsx` so the caps can
 * be asserted without serializing a million rows to prove it.
 */
export function xlsxCapacity(view: TableView): Omit<XlsxResult, "data"> {
  const truncatedColumns = Math.max(0, view.columns.length - XLSX_MAX_COLUMNS);
  const rows = Math.min(view.rowCount, XLSX_MAX_ROWS);
  return { rows, truncated: view.rowCount - rows, truncatedColumns };
}

/**
 * Serializes a table to a single-worksheet .xlsx.
 *
 * The sheet XML is assembled as Buffer chunks rather than one JS string for
 * the same reason the CSV path streams: a million-row sheet is hundreds of MB
 * of markup, which a single string cannot hold.
 */
export function writeXlsx(view: TableView, sheetName = "Sheet1"): XlsxResult {
  const { rows, truncated, truncatedColumns } = xlsxCapacity(view);
  const nCols = view.columns.length - truncatedColumns;

  const chunks: Buffer[] = [];
  let pending = "";
  const emit = (s: string): void => {
    pending += s;
    if (pending.length >= 1 << 20) {
      chunks.push(Buffer.from(pending, "utf8"));
      pending = "";
    }
  };

  emit(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>`
  );

  emit(`<row r="1">`);
  for (let c = 0; c < nCols; c++) {
    emit(
      `<c r="${cellRef(c, 1)}" t="inlineStr"><is><t xml:space="preserve">` +
        `${xmlText(view.columns[c])}</t></is></c>`
    );
  }
  emit(`</row>`);

  const buf = new Array(view.columns.length);
  for (let i = 0; i < rows; i++) {
    view.rowInto(i, buf);
    const r = i + 2;
    emit(`<row r="${r}">`);
    for (let c = 0; c < nCols; c++) {
      const v = buf[c];
      if (v === undefined) continue; // a blank cell is simply absent
      const ref = cellRef(c, r);
      if (typeof v === "string") {
        emit(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`);
      } else if (Number.isFinite(v)) {
        // Excel has no NaN/Infinity literal, so a non-finite value is written
        // as text — visible and honest, rather than a zero or a broken file.
        emit(`<c r="${ref}"><v>${view.columnTypes[c] === "f32" ? f32str(v) : String(v)}</v></c>`);
      } else {
        emit(`<c r="${ref}" t="inlineStr"><is><t>${String(v)}</t></is></c>`);
      }
    }
    emit(`</row>`);
  }

  emit(`</sheetData></worksheet>`);
  if (pending.length > 0) chunks.push(Buffer.from(pending, "utf8"));

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(sanitizeSheetName(sheetName)), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.concat(chunks) },
  ];

  return { data: createZip(entries), rows, truncated, truncatedColumns };
}
