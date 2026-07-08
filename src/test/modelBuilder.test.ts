import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBlocksFromOffsets,
  expandCellField,
  fieldFromTuples,
  finalizeModel,
} from "../parser/modelBuilder";
import { FieldData, MdpaDiagnostic } from "../parser/types";

// ---- buildBlocksFromOffsets: basic grouping -----------------------------------

test("groups cells by type, 1-based connectivity, global sequential entityIds", () => {
  const diags: MdpaDiagnostic[] = [];
  const { blocks, expansion } = buildBlocksFromOffsets(
    [5, 9, 5],
    [3, 7, 10],
    [0, 1, 2, 0, 1, 4, 2, 0, 1, 4],
    diags
  );
  assert.equal(blocks.length, 2);
  const tri = blocks.find((b) => b.vtkCellType === 5)!;
  const quad = blocks.find((b) => b.vtkCellType === 9)!;
  assert.equal(tri.name, "VtkCell_5");
  assert.equal(tri.kind, "Elements");
  assert.equal(tri.count, 2);
  assert.equal(tri.stride, 3);
  assert.deepEqual([...tri.connectivity], [1, 2, 3, 1, 2, 5]);
  assert.deepEqual([...tri.entityIds], [1, 3]);
  assert.equal(quad.count, 1);
  assert.deepEqual([...quad.connectivity], [1, 2, 5, 3]);
  assert.deepEqual([...quad.entityIds], [2]);
  assert.deepEqual([...expansion], [1, 1, 1]);
  assert.equal(diags.length, 0);
});

test("startEntityId offsets all emitted entity ids", () => {
  const { blocks } = buildBlocksFromOffsets([5], [3], [0, 1, 2], [], 100);
  assert.deepEqual([...blocks[0].entityIds], [100]);
});

test("same unknown type with different strides → separate blocks with suffixed name", () => {
  const { blocks } = buildBlocksFromOffsets(
    [42, 42],
    [4, 9],
    [0, 1, 2, 3, 0, 1, 2, 3, 4],
    []
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].name, "VtkCell_42");
  assert.equal(blocks[0].stride, 4);
  assert.equal(blocks[1].name, "VtkCell_42_5n");
  assert.equal(blocks[1].stride, 5);
});

// ---- Normalization of undrawable cell types -----------------------------------

test("POLYGON(7): 3 nodes → TRIANGLE, 4 nodes → QUAD, 5 nodes → fan of 3 triangles", () => {
  const { blocks, expansion } = buildBlocksFromOffsets(
    [7, 7, 7],
    [3, 7, 12],
    [0, 1, 2, 0, 1, 2, 3, 0, 1, 2, 3, 4],
    []
  );
  const tri = blocks.find((b) => b.vtkCellType === 5)!;
  const quad = blocks.find((b) => b.vtkCellType === 9)!;
  assert.ok(tri && quad);
  // 1 triangle from cell 0 + 3 fan triangles from cell 2
  assert.equal(tri.count, 4);
  assert.equal(quad.count, 1);
  // fan: (0,1,2),(0,2,3),(0,3,4) → 1-based
  assert.deepEqual([...tri.connectivity], [1, 2, 3, 1, 2, 3, 1, 3, 4, 1, 4, 5]);
  assert.deepEqual([...expansion], [1, 1, 3]);
  // entity ids stay sequential in emission order: cell0→1, cell1→2, cell2→3,4,5
  assert.deepEqual([...tri.entityIds], [1, 3, 4, 5]);
  assert.deepEqual([...quad.entityIds], [2]);
});

test("POLY_LINE(4): n nodes → n-1 LINE segments", () => {
  const { blocks, expansion } = buildBlocksFromOffsets([4], [4], [3, 1, 0, 2], []);
  assert.equal(blocks.length, 1);
  const line = blocks[0];
  assert.equal(line.vtkCellType, 3);
  assert.equal(line.count, 3);
  assert.deepEqual([...line.connectivity], [4, 2, 2, 1, 1, 3]);
  assert.deepEqual([...expansion], [3]);
});

test("POLY_VERTEX(2): n nodes → n VERTEX cells", () => {
  const { blocks, expansion } = buildBlocksFromOffsets([2], [3], [5, 6, 7], []);
  assert.equal(blocks[0].vtkCellType, 1);
  assert.equal(blocks[0].count, 3);
  assert.deepEqual([...blocks[0].connectivity], [6, 7, 8]);
  assert.deepEqual([...expansion], [3]);
});

test("TRIANGLE_STRIP(6): 5 nodes → 3 triangles with alternating winding", () => {
  const { blocks, expansion } = buildBlocksFromOffsets([6], [5], [0, 1, 2, 3, 4], []);
  const tri = blocks[0];
  assert.equal(tri.vtkCellType, 5);
  assert.equal(tri.count, 3);
  // even i: (i,i+1,i+2); odd i: (i+1,i,i+2) — 1-based
  assert.deepEqual([...tri.connectivity], [1, 2, 3, 3, 2, 4, 3, 4, 5]);
  assert.deepEqual([...expansion], [3]);
});

test("degenerate cell (too few nodes) → skipped with diagnostic, expansion 0", () => {
  const diags: MdpaDiagnostic[] = [];
  const { blocks, expansion } = buildBlocksFromOffsets(
    [7, 5],
    [2, 5],
    [0, 1, 0, 1, 2],
    diags
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].vtkCellType, 5);
  assert.deepEqual([...expansion], [0, 1]);
  assert.ok(diags.length > 0);
});

// ---- expandCellField -----------------------------------------------------------

test("expandCellField replicates tuples per expansion count and renumbers ids", () => {
  const field: FieldData = {
    kind: "Elemental",
    variable: "STRESS",
    components: 1,
    ids: new Int32Array([1, 2, 3]),
    values: new Float64Array([10, 20, 30]),
  };
  const out = expandCellField(field, [1, 3, 2]);
  assert.deepEqual([...out.ids], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...out.values], [10, 20, 20, 20, 30, 30]);
  assert.equal(out.variable, "STRESS");
  assert.equal(out.kind, "Elemental");
});

test("expandCellField replicates whole vector tuples", () => {
  const field: FieldData = {
    kind: "Elemental",
    variable: "V",
    components: 3,
    ids: new Int32Array([1, 2]),
    values: new Float64Array([1, 2, 3, 4, 5, 6]),
  };
  const out = expandCellField(field, [2, 1]);
  assert.deepEqual([...out.values], [1, 2, 3, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...out.ids], [1, 2, 3]);
});

test("expandCellField with identity expansion returns equivalent field", () => {
  const field: FieldData = {
    kind: "Elemental",
    variable: "Q",
    components: 1,
    ids: new Int32Array([1, 2]),
    values: new Float64Array([7, 8]),
  };
  const out = expandCellField(field, [1, 1]);
  assert.deepEqual([...out.ids], [1, 2]);
  assert.deepEqual([...out.values], [7, 8]);
});

// ---- fieldFromTuples -----------------------------------------------------------

test("fieldFromTuples synthesizes sequential 1-based ids", () => {
  const f = fieldFromTuples("Nodal", "PRESSURE", 1, [1.5, 2.5, 3.5]);
  assert.equal(f.kind, "Nodal");
  assert.equal(f.variable, "PRESSURE");
  assert.equal(f.components, 1);
  assert.deepEqual([...f.ids], [1, 2, 3]);
  assert.ok(f.values instanceof Float64Array);
  assert.ok(Math.abs(f.values[1] - 2.5) < 1e-12);
});

test("fieldFromTuples with components=3 sizes ids by tuple count", () => {
  const f = fieldFromTuples("Elemental", "V", 3, new Float64Array([1, 2, 3, 4, 5, 6]));
  assert.deepEqual([...f.ids], [1, 2]);
  assert.equal(f.values.length, 6);
});

// ---- finalizeModel -------------------------------------------------------------

test("finalizeModel synthesizes nodeIds, computes bounds and is3D", () => {
  const m = finalizeModel({
    nodeCount: 3,
    coords: new Float32Array([0, 0, 0, 2, 0, 0, 1, 3, 0]),
    blocks: [],
    fields: [],
    diagnostics: [],
  });
  assert.deepEqual([...m.nodeIds], [1, 2, 3]);
  assert.equal(m.is3D, false);
  assert.ok(Math.abs(m.bounds.max[0] - 2) < 1e-6);
  assert.ok(Math.abs(m.bounds.max[1] - 3) < 1e-6);
  assert.deepEqual(m.subModelParts, []);
  assert.deepEqual(m.meta, []);
});

test("finalizeModel is3D=true when any z nonzero; respects provided nodeIds", () => {
  const ids = new Int32Array([10, 20]);
  const m = finalizeModel({
    nodeCount: 2,
    coords: new Float32Array([0, 0, 0, 1, 1, 1]),
    nodeIds: ids,
    blocks: [],
    fields: [],
    diagnostics: [],
  });
  assert.equal(m.is3D, true);
  assert.deepEqual([...m.nodeIds], [10, 20]);
});

test("finalizeModel with zero nodes → zeroed bounds, no NaN/Infinity", () => {
  const m = finalizeModel({
    nodeCount: 0,
    coords: new Float32Array(0),
    blocks: [],
    fields: [],
    diagnostics: [],
  });
  assert.deepEqual(m.bounds.min, [0, 0, 0]);
  assert.deepEqual(m.bounds.max, [0, 0, 0]);
});
