import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStl } from "../parser/stlParser";

// ---- Helpers -------------------------------------------------------------------

const TRIANGLE = 5;

function asciiStl(name: string, facets: number[][][]): string {
  let s = `solid ${name}\n`;
  for (const tri of facets) {
    s += "  facet normal 0 0 1\n    outer loop\n";
    for (const v of tri) s += `      vertex ${v[0]} ${v[1]} ${v[2]}\n`;
    s += "    endloop\n  endfacet\n";
  }
  s += `endsolid ${name}\n`;
  return s;
}

/** Builds a binary STL buffer with the given triangles (header text optional). */
function binaryStl(facets: number[][][], headerText = "binary stl"): Buffer {
  const buf = Buffer.alloc(84 + facets.length * 50);
  buf.write(headerText, 0, "latin1");
  buf.writeUInt32LE(facets.length, 80);
  let off = 84;
  for (const tri of facets) {
    // normal (unused by parser)
    buf.writeFloatLE(0, off); buf.writeFloatLE(0, off + 4); buf.writeFloatLE(1, off + 8);
    off += 12;
    for (const v of tri) {
      buf.writeFloatLE(v[0], off);
      buf.writeFloatLE(v[1], off + 4);
      buf.writeFloatLE(v[2], off + 8);
      off += 12;
    }
    buf.writeUInt16LE(0, off);
    off += 2;
  }
  return buf;
}

const TWO_TRIS = [
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
];

// ---- ASCII ----------------------------------------------------------------------

test("ascii STL: welded vertices, one TRIANGLE block named after the solid", () => {
  const m = parseStl(Buffer.from(asciiStl("Part", TWO_TRIS)));
  assert.equal(m.nodeCount, 4); // 6 raw vertices weld to 4
  assert.equal(m.blocks.length, 1);
  const b = m.blocks[0];
  assert.equal(b.name, "Part");
  assert.equal(b.vtkCellType, TRIANGLE);
  assert.equal(b.count, 2);
  assert.equal(b.stride, 3);
  assert.deepEqual([...b.entityIds], [1, 2]);
  // shared vertices reuse node ids
  const conn = [...b.connectivity];
  assert.equal(conn[1], conn[3]); // (1,0,0) shared
  assert.equal(conn[2], conn[5]); // (0,1,0) shared
});

test("ascii STL: multiple solids → one block each", () => {
  const text =
    asciiStl("A", [TWO_TRIS[0]]) + asciiStl("B", [TWO_TRIS[1]]);
  const m = parseStl(Buffer.from(text));
  assert.equal(m.blocks.length, 2);
  assert.deepEqual(m.blocks.map((b) => b.name), ["A", "B"]);
  assert.equal(m.blocks[0].count, 1);
  assert.equal(m.blocks[1].count, 1);
  // entity ids remain globally sequential
  assert.deepEqual([...m.blocks[1].entityIds], [2]);
});

test("ascii STL: unnamed solid gets a fallback block name", () => {
  const m = parseStl(Buffer.from(asciiStl("", [TWO_TRIS[0]]).replace("solid \n", "solid\n")));
  assert.equal(m.blocks.length, 1);
  assert.ok(m.blocks[0].name.length > 0);
});

// ---- Binary ---------------------------------------------------------------------

test("binary STL: parsed with welding, one Facets block", () => {
  const m = parseStl(binaryStl(TWO_TRIS));
  assert.equal(m.nodeCount, 4);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].vtkCellType, TRIANGLE);
  assert.equal(m.blocks[0].count, 2);
});

test("binary STL whose header starts with 'solid' is still detected as binary", () => {
  const m = parseStl(binaryStl(TWO_TRIS, "solid tricky header"));
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].count, 2);
});

test("binary STL with wrong facet count → diagnostic, parses what fits", () => {
  const buf = binaryStl(TWO_TRIS);
  buf.writeUInt32LE(9999, 80); // lie about the count
  const m = parseStl(buf);
  assert.equal(m.blocks[0]?.count ?? 0, 2);
  assert.ok(m.diagnostics.length > 0);
});

// ---- Edge cases -----------------------------------------------------------------

test("empty buffer → empty model with diagnostic, no throw", () => {
  const m = parseStl(Buffer.alloc(0));
  assert.equal(m.nodeCount, 0);
  assert.equal(m.blocks.length, 0);
});

test("is3D reflects z-coordinates", () => {
  const flat = parseStl(Buffer.from(asciiStl("F", TWO_TRIS)));
  assert.equal(flat.is3D, false);
  const tri3d = [[[0, 0, 0], [1, 0, 0], [0, 1, 1]]];
  const m3 = parseStl(Buffer.from(asciiStl("S", tri3d)));
  assert.equal(m3.is3D, true);
});
