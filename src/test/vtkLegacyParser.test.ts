import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVtk } from "../parser/vtkLegacyParser";

// ---- Helpers -----------------------------------------------------------------

function vtkHeader(title = "vtk output"): string {
  return `# vtk DataFile Version 3.0\n${title}\nASCII\nDATASET UNSTRUCTURED_GRID\n`;
}

// ---- Node parsing ------------------------------------------------------------

test("parses POINTS → correct nodeCount, 1-based nodeIds, coords", () => {
  const text = vtkHeader() + `
POINTS 3 float
0.0 0.0 0.0
1.0 0.0 0.0
0.5 1.0 0.0
`;
  const m = parseVtk(text);
  assert.equal(m.nodeCount, 3);
  assert.deepEqual([...m.nodeIds], [1, 2, 3]);
  assert.ok(Math.abs(m.coords[0] - 0.0) < 1e-6);
  assert.ok(Math.abs(m.coords[3] - 1.0) < 1e-6);
  assert.ok(Math.abs(m.coords[4] - 0.0) < 1e-6);
  assert.ok(Math.abs(m.coords[7] - 1.0) < 1e-6);
});

test("coords spanning multiple lines are concatenated", () => {
  const text = vtkHeader() + `
POINTS 2 float
0.0 0.0
0.0 1.0
0.0 0.0
`;
  const m = parseVtk(text);
  assert.equal(m.nodeCount, 2);
  assert.ok(Math.abs(m.coords[3] - 1.0) < 1e-6);
});

// ---- Cell parsing ------------------------------------------------------------

test("CELLS + CELL_TYPES single type → one EntityBlock", () => {
  const text = vtkHeader() + `
POINTS 3 float
0.0 0.0 0.0
1.0 0.0 0.0
0.5 1.0 0.0

CELLS 1 4
3 0 1 2

CELL_TYPES 1
5
`;
  const m = parseVtk(text);
  assert.equal(m.blocks.length, 1);
  const b = m.blocks[0];
  assert.equal(b.vtkCellType, 5);
  assert.equal(b.name, "VtkCell_5");
  assert.equal(b.kind, "Elements");
  assert.equal(b.count, 1);
  assert.equal(b.stride, 3);
  assert.deepEqual([...b.entityIds], [1]);
  // 0-based → 1-based
  assert.deepEqual([...b.connectivity], [1, 2, 3]);
});

test("CELLS + CELL_TYPES mixed types → one EntityBlock per type", () => {
  const text = vtkHeader() + `
POINTS 5 float
0 0 0
1 0 0
0 1 0
0 0 1
1 1 0

CELLS 3 13
3 0 1 2
4 0 1 4 2
3 0 1 4

CELL_TYPES 3
5
9
5
`;
  const m = parseVtk(text);
  assert.equal(m.blocks.length, 2); // two distinct types: 5 and 9
  const tri = m.blocks.find((b) => b.vtkCellType === 5)!;
  const quad = m.blocks.find((b) => b.vtkCellType === 9)!;
  assert.ok(tri, "triangle block missing");
  assert.ok(quad, "quad block missing");
  assert.equal(tri.count, 2);
  assert.equal(quad.count, 1);
  // Connectivity is 1-based
  assert.deepEqual([...quad.connectivity], [1, 2, 5, 3]);
});

test("entityIds are globally sequential across blocks", () => {
  const text = vtkHeader() + `
POINTS 4 float
0 0 0  1 0 0  0 1 0  0 0 1

CELLS 2 9
3 0 1 2
4 0 1 3 2

CELL_TYPES 2
5
10
`;
  const m = parseVtk(text);
  const tri = m.blocks.find((b) => b.vtkCellType === 5)!;
  const tet = m.blocks.find((b) => b.vtkCellType === 10)!;
  // First VTK cell (type 5) gets id 1, second (type 10) gets id 2
  assert.deepEqual([...tri.entityIds], [1]);
  assert.deepEqual([...tet.entityIds], [2]);
});

// ---- Field parsing -----------------------------------------------------------

test("POINT_DATA FIELD scalar → FieldData kind=Nodal, components=1", () => {
  const text = vtkHeader() + `
POINTS 3 float
0 0 0  1 0 0  0 1 0

CELLS 1 4
3 0 1 2
CELL_TYPES 1
5

POINT_DATA 3
FIELD FieldData 1
PRESSURE 1 3 float
1.0 2.0 3.0
`;
  const m = parseVtk(text);
  assert.equal(m.fields.length, 1);
  const f = m.fields[0];
  assert.equal(f.kind, "Nodal");
  assert.equal(f.variable, "PRESSURE");
  assert.equal(f.components, 1);
  assert.deepEqual([...f.ids], [1, 2, 3]);
  assert.ok(Math.abs(f.values[0] - 1.0) < 1e-9);
  assert.ok(Math.abs(f.values[1] - 2.0) < 1e-9);
  assert.ok(Math.abs(f.values[2] - 3.0) < 1e-9);
});

test("POINT_DATA FIELD vector (nComponents=3) → components=3, row-major values", () => {
  const text = vtkHeader() + `
POINTS 2 float
0 0 0  1 0 0

CELLS 1 3
2 0 1
CELL_TYPES 1
3

POINT_DATA 2
FIELD FieldData 1
VELOCITY 3 2 float
1.0 2.0 3.0
4.0 5.0 6.0
`;
  const m = parseVtk(text);
  const f = m.fields[0];
  assert.equal(f.components, 3);
  assert.equal(f.values.length, 6);
  assert.ok(Math.abs(f.values[0] - 1.0) < 1e-9);
  assert.ok(Math.abs(f.values[3] - 4.0) < 1e-9);
  assert.ok(Math.abs(f.values[5] - 6.0) < 1e-9);
});

test("CELL_DATA FIELD → FieldData kind=Elemental, ids span all cells", () => {
  const text = vtkHeader() + `
POINTS 4 float
0 0 0  1 0 0  0 1 0  1 1 0

CELLS 2 8
3 0 1 2
3 1 3 2
CELL_TYPES 2
5
5

CELL_DATA 2
FIELD FieldData 1
STRESS 1 2 float
10.0 20.0
`;
  const m = parseVtk(text);
  const f = m.fields[0];
  assert.equal(f.kind, "Elemental");
  assert.equal(f.variable, "STRESS");
  assert.deepEqual([...f.ids], [1, 2]);
  assert.ok(Math.abs(f.values[0] - 10.0) < 1e-9);
  assert.ok(Math.abs(f.values[1] - 20.0) < 1e-9);
});

test("multiple FIELD arrays in one section all parsed", () => {
  const text = vtkHeader() + `
POINTS 2 float
0 0 0  1 0 0

CELLS 1 3
2 0 1
CELL_TYPES 1
3

POINT_DATA 2
FIELD FieldData 2
A 1 2 float
1.0 2.0
B 3 2 float
0.1 0.2 0.3
0.4 0.5 0.6
`;
  const m = parseVtk(text);
  assert.equal(m.fields.length, 2);
  assert.equal(m.fields[0].variable, "A");
  assert.equal(m.fields[1].variable, "B");
  assert.equal(m.fields[1].components, 3);
});

test("POINT_DATA then CELL_DATA → both sections parsed", () => {
  const text = vtkHeader() + `
POINTS 3 float
0 0 0  1 0 0  0 1 0

CELLS 1 4
3 0 1 2
CELL_TYPES 1
5

POINT_DATA 3
FIELD FieldData 1
P 1 3 float
1.0 2.0 3.0

CELL_DATA 1
FIELD FieldData 1
Q 1 1 float
9.0
`;
  const m = parseVtk(text);
  assert.equal(m.fields.length, 2);
  assert.equal(m.fields[0].kind, "Nodal");
  assert.equal(m.fields[1].kind, "Elemental");
});

// ---- SCALARS/VECTORS fallback format -----------------------------------------

test("SCALARS + LOOKUP_TABLE fallback variant → FieldData", () => {
  const text = vtkHeader() + `
POINTS 2 float
0 0 0  1 0 0

CELLS 1 3
2 0 1
CELL_TYPES 1
3

POINT_DATA 2
SCALARS temperature float 1
LOOKUP_TABLE default
25.0
30.0
`;
  const m = parseVtk(text);
  assert.equal(m.fields.length, 1);
  const f = m.fields[0];
  assert.equal(f.kind, "Nodal");
  assert.equal(f.variable, "temperature");
  assert.ok(Math.abs(f.values[0] - 25.0) < 1e-9);
});

test("VECTORS fallback variant → FieldData with components=3", () => {
  const text = vtkHeader() + `
POINTS 2 float
0 0 0  1 0 0

CELLS 1 3
2 0 1
CELL_TYPES 1
3

POINT_DATA 2
VECTORS velocity float
1.0 0.0 0.0
0.0 1.0 0.0
`;
  const m = parseVtk(text);
  assert.equal(m.fields.length, 1);
  assert.equal(m.fields[0].components, 3);
  assert.ok(Math.abs(m.fields[0].values[3] - 0.0) < 1e-9); // node 2, x=0
  assert.ok(Math.abs(m.fields[0].values[4] - 1.0) < 1e-9); // node 2, y=1
});

// ---- is3D and bounds ---------------------------------------------------------

test("is3D=false when all z=0", () => {
  const m = parseVtk(vtkHeader() + "POINTS 2 float\n0 0 0\n1 1 0\n");
  assert.equal(m.is3D, false);
});

test("is3D=true when any z != 0", () => {
  const m = parseVtk(vtkHeader() + "POINTS 2 float\n0 0 0\n1 1 1\n");
  assert.equal(m.is3D, true);
});

test("bounds computed from coords", () => {
  const m = parseVtk(vtkHeader() + "POINTS 3 float\n0 0 0\n2 0 0\n1 3 0\n");
  assert.ok(Math.abs(m.bounds.min[0] - 0) < 1e-6);
  assert.ok(Math.abs(m.bounds.max[0] - 2) < 1e-6);
  assert.ok(Math.abs(m.bounds.max[1] - 3) < 1e-6);
});

// ---- Edge cases --------------------------------------------------------------

test("empty file → empty model, no throw", () => {
  const m = parseVtk("");
  assert.equal(m.nodeCount, 0);
  assert.equal(m.blocks.length, 0);
  assert.equal(m.fields.length, 0);
  assert.equal(m.diagnostics.length, 0);
});

test("file with only header → empty model", () => {
  const m = parseVtk(vtkHeader());
  assert.equal(m.nodeCount, 0);
  assert.equal(m.blocks.length, 0);
});

test("BINARY header → diagnostic emitted, no crash", () => {
  const text = `# vtk DataFile Version 3.0\nvtk output\nBINARY\nDATASET UNSTRUCTURED_GRID\n`;
  const m = parseVtk(text);
  assert.equal(m.nodeCount, 0);
  assert.ok(m.diagnostics.length > 0);
  assert.ok(m.diagnostics[0].message.toLowerCase().includes("binary"));
});

test("mismatched CELL_TYPES count → diagnostic, partial parse", () => {
  const text = vtkHeader() + `
POINTS 3 float
0 0 0  1 0 0  0 1 0

CELLS 2 8
3 0 1 2
3 0 2 1
CELL_TYPES 1
5
`;
  const m = parseVtk(text);
  // Only 1 cell type given → only 1 cell can be typed
  assert.ok(m.diagnostics.length > 0);
  assert.equal(m.blocks[0].count, 1);
});

test("scientific notation in coords parsed correctly", () => {
  const text = vtkHeader() + "POINTS 1 float\n1.5e-3 2.0E+2 -3.14e0\n";
  const m = parseVtk(text);
  assert.ok(Math.abs(m.coords[0] - 0.0015) < 1e-9);
  assert.ok(Math.abs(m.coords[1] - 200.0) < 1e-9);
  assert.ok(Math.abs(m.coords[2] - (-3.14)) < 1e-6);
});

test("no-cell file (point cloud) → nodeIds set, blocks empty", () => {
  const text = vtkHeader() + "POINTS 4 float\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n";
  const m = parseVtk(text);
  assert.equal(m.nodeCount, 4);
  assert.equal(m.blocks.length, 0);
});
