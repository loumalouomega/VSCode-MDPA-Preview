import { test } from "node:test";
import assert from "node:assert/strict";
import { parseObj } from "../parser/objParser";

const VERTEX = 1;
const LINE = 3;
const TRIANGLE = 5;
const QUAD = 9;

test("v + triangular f lines → TRIANGLE block with 1-based connectivity", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks.length, 1);
  const b = m.blocks[0];
  assert.equal(b.vtkCellType, TRIANGLE);
  assert.equal(b.count, 1);
  assert.deepEqual([...b.connectivity], [1, 2, 3]);
});

test("quad face → QUAD; 5-gon → fan of 3 triangles", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v -1 0.5 0
f 1 2 3 4
f 1 2 3 4 5
`);
  const quad = m.blocks.find((b) => b.vtkCellType === QUAD)!;
  const tri = m.blocks.find((b) => b.vtkCellType === TRIANGLE)!;
  assert.equal(quad.count, 1);
  assert.equal(tri.count, 3);
  assert.deepEqual([...tri.connectivity], [1, 2, 3, 1, 3, 4, 1, 4, 5]);
});

test("v/vt/vn slash forms use only the vertex index", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 0 1 0
vt 0 0
vn 0 0 1
f 1/1/1 2/1/1 3/1/1
f 1//1 2//1 3//1
`);
  assert.equal(m.blocks[0].count, 2);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3, 1, 2, 3]);
});

test("negative indices are relative to the vertices defined so far", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 0 1 0
f -3 -2 -1
`);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3]);
});

test("l → LINE segments, p → VERTEX cells", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 2 0 0
l 1 2 3
p 1 3
`);
  const line = m.blocks.find((b) => b.vtkCellType === LINE)!;
  const vert = m.blocks.find((b) => b.vtkCellType === VERTEX)!;
  assert.equal(line.count, 2);
  assert.deepEqual([...line.connectivity], [1, 2, 2, 3]);
  assert.equal(vert.count, 2);
});

test("g/o start named groups → blocks named after the group", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
g Left
f 1 2 3
g Right
f 2 4 3
`);
  assert.equal(m.blocks.length, 2);
  assert.deepEqual(m.blocks.map((b) => b.name), ["Left", "Right"]);
  // entity ids globally sequential across groups
  assert.deepEqual([...m.blocks[1].entityIds], [2]);
});

test("faces before any group land in the default group", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`);
  assert.equal(m.blocks[0].name, "default");
});

test("group with mixed cell types → one block per type, disambiguated names", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
g Mixed
f 1 2 3
f 1 2 3 4
`);
  assert.equal(m.blocks.length, 2);
  assert.notEqual(m.blocks[0].name, m.blocks[1].name);
  assert.ok(m.blocks[0].name.includes("Mixed"));
  assert.ok(m.blocks[1].name.includes("Mixed"));
});

test("vt/vn/usemtl/mtllib/s lines are ignored; empty model doesn't throw", () => {
  const m = parseObj(`
mtllib scene.mtl
usemtl steel
s off
vt 0 1
vn 0 0 1
`);
  assert.equal(m.nodeCount, 0);
  assert.equal(m.blocks.length, 0);
});

test("out-of-range face index → diagnostic, face skipped", () => {
  const m = parseObj(`
v 0 0 0
v 1 0 0
f 1 2 99
`);
  assert.equal(m.blocks.length, 0);
  assert.ok(m.diagnostics.length > 0);
});
