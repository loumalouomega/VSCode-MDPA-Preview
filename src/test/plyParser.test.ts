import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePly } from "../parser/plyParser";

const LINE = 3;
const TRIANGLE = 5;
const QUAD = 9;

// ---- ASCII ----------------------------------------------------------------------

test("ascii PLY: vertices + triangle face → TRIANGLE block", () => {
  const m = parsePly(Buffer.from(`ply
format ascii 1.0
comment made by hand
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2
`));
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].vtkCellType, TRIANGLE);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3]);
});

test("ascii PLY: quad and 5-gon faces → QUAD + triangle fan", () => {
  const m = parsePly(Buffer.from(`ply
format ascii 1.0
element vertex 5
property float x
property float y
property float z
element face 2
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
1 1 0
0 1 0
-1 0.5 0
4 0 1 2 3
5 0 1 2 3 4
`));
  const quad = m.blocks.find((b) => b.vtkCellType === QUAD)!;
  const tri = m.blocks.find((b) => b.vtkCellType === TRIANGLE)!;
  assert.equal(quad.count, 1);
  assert.equal(tri.count, 3);
});

test("ascii PLY: extra numeric vertex properties become Nodal fields", () => {
  const m = parsePly(Buffer.from(`ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
property float quality
property uchar red
end_header
0 0 0 0.5 255
1 0 0 0.75 128
`));
  assert.equal(m.fields.length, 2);
  const q = m.fields.find((f) => f.variable === "quality")!;
  assert.equal(q.kind, "Nodal");
  assert.equal(q.components, 1);
  assert.ok(Math.abs(q.values[1] - 0.75) < 1e-6);
  const r = m.fields.find((f) => f.variable === "red")!;
  assert.ok(Math.abs(r.values[0] - 255) < 1e-9);
});

test("ascii PLY: edge element → LINE block", () => {
  const m = parsePly(Buffer.from(`ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element edge 2
property int vertex1
property int vertex2
end_header
0 0 0
1 0 0
0 1 0
0 1
1 2
`));
  const line = m.blocks.find((b) => b.vtkCellType === LINE)!;
  assert.equal(line.count, 2);
  assert.deepEqual([...line.connectivity], [1, 2, 2, 3]);
});

// ---- Binary ---------------------------------------------------------------------

function binaryPlyHeader(endian: "little" | "big"): string {
  return `ply
format binary_${endian}_endian 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
`;
}

function buildBinaryPly(endian: "little" | "big"): Buffer {
  const head = Buffer.from(binaryPlyHeader(endian), "latin1");
  const body = Buffer.alloc(3 * 12 + 1 + 3 * 4);
  const le = endian === "little";
  const wf = (v: number, o: number) => (le ? body.writeFloatLE(v, o) : body.writeFloatBE(v, o));
  const wi = (v: number, o: number) => (le ? body.writeInt32LE(v, o) : body.writeInt32BE(v, o));
  const verts = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  let off = 0;
  for (const v of verts) {
    wf(v[0], off); wf(v[1], off + 4); wf(v[2], off + 8);
    off += 12;
  }
  body.writeUInt8(3, off); off += 1;
  wi(0, off); wi(1, off + 4); wi(2, off + 8);
  return Buffer.concat([head, body]);
}

test("binary_little_endian PLY parses", () => {
  const m = parsePly(buildBinaryPly("little"));
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks[0].vtkCellType, TRIANGLE);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3]);
  assert.ok(Math.abs(m.coords[3] - 1) < 1e-6);
});

test("binary_big_endian PLY parses", () => {
  const m = parsePly(buildBinaryPly("big"));
  assert.equal(m.nodeCount, 3);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3]);
});

// ---- Edge cases -----------------------------------------------------------------

test("missing magic → diagnostic, empty model", () => {
  const m = parsePly(Buffer.from("not a ply file"));
  assert.equal(m.nodeCount, 0);
  assert.ok(m.diagnostics.length > 0);
});

test("face index out of range → diagnostic, face skipped", () => {
  const m = parsePly(Buffer.from(`ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
3 0 1 9
`));
  assert.equal(m.blocks.length, 0);
  assert.ok(m.diagnostics.length > 0);
});
