/**
 * xlsxWriter.ts — the .xlsx delivery format for a TableView, over the
 * from-scratch ZIP writer. Pure Node, no wasm and no spreadsheet dependency:
 * the archive is read back with our own `readZip` and the sheet XML asserted
 * directly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CellValue, TableView, prepareTable } from "../parser/dataTable";
import { parseMdpa } from "../parser/mdpaParser";
import {
  XLSX_MAX_ROWS,
  cellRef,
  sanitizeSheetName,
  writeXlsx,
  xlsxCapacity,
} from "../parser/writers/xlsxWriter";
import { readZip } from "../parser/zip";

const SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.5 0.0 0.0
End Nodes

Begin Elements Element2D2N
1 0 1 2
End Elements

Begin NodalData TEMP
1 10.5
End NodalData
`;

function parts(data: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of readZip(data)) map.set(e.name, Buffer.from(e.data).toString("utf8"));
  return map;
}

/** A minimal synthetic view, so a test can control cells exactly. */
function fakeView(columns: string[], rows: CellValue[][]): TableView {
  return {
    kind: "Nodes",
    columns,
    columnTypes: columns.map(() => "text" as const),
    rowCount: rows.length,
    row: (i) => rows[i].slice(),
    rowInto: (i, out) => {
      for (let c = 0; c < columns.length; c++) out[c] = rows[i][c];
      return out;
    },
  };
}

test("writes the five OOXML parts a reader needs", () => {
  const { data, rows, truncated } = writeXlsx(prepareTable(parseMdpa(SRC), "Nodes"));
  const p = parts(data);
  assert.deepEqual([...p.keys()].sort(), [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/_rels/workbook.xml.rels",
    "xl/workbook.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  assert.equal(rows, 2);
  assert.equal(truncated, 0);
  assert.ok(p.get("[Content_Types].xml")!.includes("/xl/worksheets/sheet1.xml"));
  assert.ok(p.get("xl/workbook.xml")!.includes('r:id="rId1"'));
});

test("headers are inline strings, values are numbers, and a blank cell is absent", () => {
  const view = prepareTable(parseMdpa(SRC), "Nodes");
  const sheet = parts(writeXlsx(view).data).get("xl/worksheets/sheet1.xml")!;
  assert.ok(sheet.includes('<c r="A1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>'));
  assert.ok(sheet.includes('<c r="A2"><v>1</v></c>'));
  assert.ok(
    sheet.includes('<c r="B3"><v>1.5</v></c>'),
    "the Float32 coordinate reads 1.5, not its double expansion"
  );
  assert.ok(sheet.includes('<c r="E2"><v>10.5</v></c>'));
  // Node 2 carries no TEMP record: the cell is omitted, never written as 0.
  assert.ok(!sheet.includes('<c r="E3">'));
});

test("XML metacharacters are escaped and control characters dropped", () => {
  const ctrl = String.fromCharCode(1);
  const view = fakeView(["a & b"], [['<x>"q"'], ["tab\tkept" + ctrl + "dropped"]]);
  const sheet = parts(writeXlsx(view).data).get("xl/worksheets/sheet1.xml")!;
  assert.ok(sheet.includes("a &amp; b"));
  assert.ok(sheet.includes('&lt;x&gt;"q"'));
  // A tab is legal XML and survives; a control character has no escape at all,
  // so it is dropped rather than written into a file no reader will open.
  assert.ok(sheet.includes("tab\tkeptdropped"));
  assert.ok(!sheet.includes(ctrl));
});

test("a non-finite number is written as text, not a broken numeric cell", () => {
  const view: TableView = { ...fakeView(["v"], [[NaN], [Infinity]]), columnTypes: ["f64"] };
  const sheet = parts(writeXlsx(view).data).get("xl/worksheets/sheet1.xml")!;
  assert.ok(sheet.includes('t="inlineStr"><is><t>NaN</t>'));
  assert.ok(sheet.includes('t="inlineStr"><is><t>Infinity</t>'));
});

test("the worksheet caps are reported rather than silently applied", () => {
  const oversize: TableView = {
    kind: "Nodes",
    columns: ["id"],
    columnTypes: ["id"],
    rowCount: XLSX_MAX_ROWS + 5,
    row: (i) => [i],
    rowInto: (i, out) => {
      out[0] = i;
      return out;
    },
  };
  const cap = xlsxCapacity(oversize);
  assert.equal(cap.rows, XLSX_MAX_ROWS);
  assert.equal(cap.truncated, 5);
  assert.equal(cap.truncatedColumns, 0);
  assert.deepEqual(xlsxCapacity(fakeView(["a", "b"], [["x", "y"]])), {
    rows: 1,
    truncated: 0,
    truncatedColumns: 0,
  });
});

test("cell references and sheet names follow the format's rules", () => {
  assert.equal(cellRef(0, 1), "A1");
  assert.equal(cellRef(25, 7), "Z7");
  assert.equal(cellRef(26, 1), "AA1");
  assert.equal(sanitizeSheetName("a/b:c"), "a_b_c");
  assert.equal(sanitizeSheetName(""), "Sheet1");
  assert.equal(sanitizeSheetName("x".repeat(40)).length, 31);
});
