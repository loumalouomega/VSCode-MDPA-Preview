/**
 * dataTable.ts — the table view over a parsed mesh and its CSV serialization.
 * Pure, no wasm.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CellValue,
  TableView,
  csvChunks,
  f32str,
  prepareTable,
  tableRowCount,
  toCsv,
} from "../parser/dataTable";
import { buildMembershipIndex } from "../parser/smpMembership";
import { parseMdpa } from "../parser/mdpaParser";
import { FieldData, MdpaModel } from "../parser/types";

const SRC = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements

Begin Conditions Condition2D2N
7 0 1 2
End Conditions

Begin NodalData TEMP
1 10.0
2 20.0
End NodalData

Begin NodalData DISP
1 (1.0, 2.0, 3.0)
2 (4.0, 5.0, 6.0)
3 (7.0, 8.0, 9.0)
4 (0.0, 0.0, 0.0)
End NodalData

Begin ElementalData MAT
1 5.0
2 6.0
End ElementalData

Begin SubModelPart Inner
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

function model(): MdpaModel {
  return parseMdpa(SRC);
}

/** Rows as CSV cell strings, header excluded. */
function csvRows(view: TableView): string[] {
  return toCsv(view).trimEnd().split("\r\n").slice(1);
}

test("Nodes columns: id, coordinates, then one column per Nodal field", () => {
  const view = prepareTable(model(), "Nodes");
  assert.deepEqual(view.columns, [
    "id",
    "x",
    "y",
    "z",
    "TEMP",
    "DISP_X",
    "DISP_Y",
    "DISP_Z",
  ]);
  assert.deepEqual(view.columnTypes, [
    "id",
    "f32",
    "f32",
    "f32",
    "f64",
    "f64",
    "f64",
    "f64",
  ]);
  assert.equal(view.rowCount, 4);
  assert.deepEqual(view.row(1), [2, 1, 0, 0, 20, 4, 5, 6]);
});

test("a field wider than 3 components gets numbered columns, not a 3-column truncation", () => {
  const m = model();
  const hessian: FieldData = {
    kind: "Nodal",
    variable: "H",
    components: 9,
    ids: Int32Array.from([1]),
    values: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
  };
  m.fields.push(hessian);
  const view = prepareTable(m, "Nodes");
  const cols = view.columns.filter((c) => c.startsWith("H_"));
  assert.deepEqual(cols, ["H_0", "H_1", "H_2", "H_3", "H_4", "H_5", "H_6", "H_7", "H_8"]);
});

test("a sparse field leaves the cell blank, not zero", () => {
  const view = prepareTable(model(), "Nodes");
  const temp = view.columns.indexOf("TEMP");
  // Nodes 3 and 4 carry no TEMP record.
  assert.equal(view.row(2)[temp], undefined);
  const rows = csvRows(view);
  assert.equal(rows[2].split(",")[temp], "");
  assert.notEqual(rows[2].split(",")[temp], "0");
});

test("Elements carry block + connectivity, and only fields that reach them", () => {
  const view = prepareTable(model(), "Elements");
  assert.deepEqual(view.columns, ["id", "block", "nodes", "MAT"]);
  assert.deepEqual(view.row(0), [1, "Element2D3N", "1 2 3", 5]);
  assert.equal(view.rowCount, 2);
  // The Conditions table sees no Elemental field.
  const cond = prepareTable(model(), "Conditions");
  assert.deepEqual(cond.columns, ["id", "block", "nodes"]);
  assert.deepEqual(cond.row(0), [7, "Condition2D2N", "1 2"]);
});

test("nodeColumns splits connectivity and pads a shorter stride with blanks", () => {
  const m = model();
  const view = prepareTable(m, "Elements", { nodeColumns: true });
  assert.deepEqual(view.columns, ["id", "block", "n1", "n2", "n3", "MAT"]);
  assert.deepEqual(view.row(0), [1, "Element2D3N", 1, 2, 3, 5]);

  // Two blocks of different stride: the short one pads rather than shifting.
  const mixed = parseMdpa(
    SRC.replace(
      "End Elements",
      "End Elements\n\nBegin Elements Element2D4N\n5 0 1 2 3 4\nEnd Elements"
    )
  );
  const v2 = prepareTable(mixed, "Elements", { nodeColumns: true });
  assert.deepEqual(v2.columns.slice(0, 6), ["id", "block", "n1", "n2", "n3", "n4"]);
  assert.deepEqual(v2.row(0).slice(0, 6), [1, "Element2D3N", 1, 2, 3, undefined]);
  assert.deepEqual(v2.row(2).slice(0, 6), [5, "Element2D4N", 1, 2, 3, 4]);
});

test("a field column appears by OVERLAP with the kind, not by field kind alone", () => {
  // partition writes ONE Elemental field spanning Elements, Conditions and
  // Geometries alike, so "Geometries have no fields" is false.
  const m = model();
  m.blocks.push({
    kind: "Geometries",
    name: "Line2D2",
    count: 1,
    stride: 2,
    entityIds: Int32Array.from([90]),
    connectivity: Int32Array.from([1, 2]),
  });
  m.fields.push({
    kind: "Elemental",
    variable: "PARTITION_INDEX",
    components: 1,
    ids: Int32Array.from([1, 2, 90]),
    values: Float64Array.from([0, 1, 1]),
  });
  const geo = prepareTable(m, "Geometries");
  assert.ok(geo.columns.includes("PARTITION_INDEX"), "geometry rows are covered");
  assert.equal(geo.row(0)[geo.columns.indexOf("PARTITION_INDEX")], 1);
  // MAT covers no geometry, so it contributes no permanently-blank column.
  assert.ok(!geo.columns.includes("MAT"));
});

test("the SubModelParts column lists membership, and the filter narrows rows", () => {
  const m = model();
  const idx = buildMembershipIndex(m.subModelParts);
  const view = prepareTable(m, "Nodes", { membership: true }, idx);
  const at = view.columns.indexOf("SubModelParts");
  assert.ok(at > 0);
  assert.equal(view.row(0)[at], "Inner");
  assert.equal(view.row(3)[at], "");

  const filtered = prepareTable(m, "Nodes", { submodelpart: "Inner" });
  assert.equal(filtered.rowCount, 2);
  assert.deepEqual([filtered.row(0)[0], filtered.row(1)[0]], [1, 2]);
  assert.equal(tableRowCount(m, "Nodes", { submodelpart: "Inner" }), 2);
  assert.equal(prepareTable(m, "Elements", { submodelpart: "Inner" }).rowCount, 1);
  // An unknown path yields no rows rather than the whole mesh.
  assert.equal(prepareTable(m, "Nodes", { submodelpart: "Nope" }).rowCount, 0);
});

test("CSV quotes commas, quotes and newlines", () => {
  const m = model();
  m.subModelParts[0].name = 'Weird, "name"\nsecond';
  m.subModelParts[0].path = 'Weird, "name"\nsecond';
  const idx = buildMembershipIndex(m.subModelParts);
  const view = prepareTable(m, "Nodes", { membership: true }, idx);
  const csv = toCsv(view);
  assert.ok(csv.includes('"Weird, ""name""\nsecond"'));
  // The quoted newline must not be read as a row break.
  assert.equal(csv.split("\r\n").length - 1, view.rowCount + 1);
});

test("coordinates serialize as the shortest Float32 round-trip, not the double expansion", () => {
  const m = model();
  m.coords = Float32Array.from([0.1, 1 / 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const view = prepareTable(m, "Nodes");
  const cells = csvRows(view)[0].split(",");
  assert.equal(cells[1], "0.1");
  assert.equal(cells[2], "0.33333334");
  assert.notEqual(cells[1], String(m.coords[0]));
  assert.equal(f32str(Math.fround(2.5)), "2.5");
  assert.equal(f32str(NaN), "NaN");
});

test("field values keep full double precision", () => {
  const m = model();
  (m.fields.find((f) => f.variable === "TEMP") as FieldData).values[0] = Math.PI;
  const view = prepareTable(m, "Nodes");
  const cells = csvRows(view)[0].split(",");
  assert.equal(Number(cells[view.columns.indexOf("TEMP")]), Math.PI);
});

test("row and rowInto agree across a block boundary, and rowCount sums the blocks", () => {
  const mixed = parseMdpa(
    SRC.replace(
      "End Elements",
      "End Elements\n\nBegin Elements Element2D4N\n5 0 1 2 3 4\n6 0 1 2 3 4\nEnd Elements"
    )
  );
  const view = prepareTable(mixed, "Elements");
  assert.equal(view.rowCount, 4);
  assert.equal(tableRowCount(mixed, "Elements"), 4);
  const buf = new Array<CellValue>(view.columns.length);
  for (const i of [0, 1, 2, 3, 0, 3]) {
    assert.deepEqual(view.rowInto(i, buf), view.row(i), `row ${i}`);
  }
  assert.equal(view.row(3)[1], "Element2D4N");
});

test("csvChunks concatenates to toCsv whatever the chunk size", () => {
  const view = prepareTable(model(), "Nodes");
  let out = "";
  for (const chunk of csvChunks(view, 1)) out += chunk;
  assert.equal(out, toCsv(view));
});
