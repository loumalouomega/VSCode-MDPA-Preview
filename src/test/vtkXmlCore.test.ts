import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import {
  parseVtkXmlFile,
  decodeDataArray,
  findAll,
  findFirst,
} from "../parser/vtkXmlCore";
import { MdpaDiagnostic } from "../parser/types";

// ---- Encoding helpers (mirror what VTK writers produce) --------------------------

type HeaderType = "UInt32" | "UInt64";

function valueBuf(values: number[], dtype: string, le: boolean): Buffer {
  const sizes: Record<string, number> = {
    Int32: 4, Int64: 8, Float32: 4, Float64: 8, UInt8: 1,
  };
  const size = sizes[dtype];
  const b = Buffer.alloc(values.length * size);
  values.forEach((v, i) => {
    const o = i * size;
    if (dtype === "Float32") le ? b.writeFloatLE(v, o) : b.writeFloatBE(v, o);
    else if (dtype === "Float64") le ? b.writeDoubleLE(v, o) : b.writeDoubleBE(v, o);
    else if (dtype === "Int32") le ? b.writeInt32LE(v, o) : b.writeInt32BE(v, o);
    else if (dtype === "Int64")
      le ? b.writeBigInt64LE(BigInt(v), o) : b.writeBigInt64BE(BigInt(v), o);
    else if (dtype === "UInt8") b.writeUInt8(v, o);
  });
  return b;
}

function headerBuf(vals: number[], ht: HeaderType, le: boolean): Buffer {
  const size = ht === "UInt64" ? 8 : 4;
  const b = Buffer.alloc(vals.length * size);
  vals.forEach((v, i) => {
    if (ht === "UInt64")
      le ? b.writeBigUInt64LE(BigInt(v), i * 8) : b.writeBigUInt64BE(BigInt(v), i * 8);
    else le ? b.writeUInt32LE(v, i * 4) : b.writeUInt32BE(v, i * 4);
  });
  return b;
}

/** Uncompressed inline/appended-base64: base64(header ‖ payload) as ONE stream. */
function inlineUncompressed(payload: Buffer, ht: HeaderType, le: boolean): string {
  return Buffer.concat([headerBuf([payload.length], ht, le), payload]).toString("base64");
}

/**
 * Compressed inline/appended-base64: base64(headerBlock) ‖ base64(compressedBlocks)
 * — encoded SEPARATELY (the classic VTK trap).
 */
function inlineCompressed(
  payload: Buffer,
  ht: HeaderType,
  le: boolean,
  blockSize: number
): string {
  const blocks: Buffer[] = [];
  for (let o = 0; o < payload.length; o += blockSize) {
    blocks.push(payload.subarray(o, Math.min(o + blockSize, payload.length)));
  }
  const comp = blocks.map((b) => zlib.deflateSync(b));
  const lastPartial = payload.length % blockSize;
  const header = headerBuf(
    [comp.length, blockSize, lastPartial, ...comp.map((c) => c.length)],
    ht,
    le
  );
  return header.toString("base64") + Buffer.concat(comp).toString("base64");
}

/** Raw appended bytes for one array: header ‖ payload (uncompressed). */
function rawUncompressed(payload: Buffer, ht: HeaderType, le: boolean): Buffer {
  return Buffer.concat([headerBuf([payload.length], ht, le), payload]);
}

interface DocOpts {
  byteOrder?: "LittleEndian" | "BigEndian";
  headerType?: HeaderType;
  compressed?: boolean;
  appended?: { encoding: "raw" | "base64"; blob: Buffer | string };
}

/** Wraps DataArray markup in a minimal valid VTKFile document. */
function doc(dataArrays: string, opts: DocOpts = {}): Buffer {
  const bo = opts.byteOrder ?? "LittleEndian";
  const ht = opts.headerType ?? "UInt32";
  const comp = opts.compressed ? ` compressor="vtkZLibDataCompressor"` : "";
  let appended = "";
  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="${bo}" header_type="${ht}"${comp}>
  <UnstructuredGrid>
    <Piece NumberOfPoints="3" NumberOfCells="1">
      ${dataArrays}
    </Piece>
  </UnstructuredGrid>
`,
      "latin1"
    )
  );
  if (opts.appended) {
    parts.push(Buffer.from(`  <AppendedData encoding="${opts.appended.encoding}">\n   _`, "latin1"));
    parts.push(
      typeof opts.appended.blob === "string"
        ? Buffer.from(opts.appended.blob, "latin1")
        : opts.appended.blob
    );
    parts.push(Buffer.from(`\n  </AppendedData>\n`, "latin1"));
  }
  parts.push(Buffer.from(`</VTKFile>\n`, "latin1"));
  void appended;
  return Buffer.concat(parts);
}

function decodeFirst(buf: Buffer): { values: Float64Array; diags: MdpaDiagnostic[] } {
  const file = parseVtkXmlFile(buf);
  const el = findAll(file.root, "DataArray")[0];
  const diags: MdpaDiagnostic[] = [];
  return { values: decodeDataArray(el, file, diags), diags };
}

const FLOATS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

// ---- Tokenizer ------------------------------------------------------------------

test("parses the XML head: root, datasetType, nesting, attributes", () => {
  const file = parseVtkXmlFile(doc(`<Points><DataArray type="Float32" Name="pts" format="ascii">1 2 3</DataArray></Points>`));
  assert.equal(file.root.tag, "VTKFile");
  assert.equal(file.datasetType, "UnstructuredGrid");
  assert.equal(file.littleEndian, true);
  assert.equal(file.headerType, "UInt32");
  assert.equal(file.compressed, false);
  const points = findFirst(file.root, "Points")!;
  assert.ok(points);
  const da = findFirst(points, "DataArray")!;
  assert.equal(da.attrs.Name, "pts");
  assert.equal(da.attrs.type, "Float32");
});

test("tokenizer handles self-closing tags, comments, single quotes, entities", () => {
  const buf = Buffer.from(`<?xml version='1.0'?>
<!-- a comment <with angle brackets> -->
<VTKFile type='PolyData' byte_order='BigEndian'>
  <PolyData>
    <Piece a='x &amp; y' b="&lt;3&gt;&quot;&apos;"/>
  </PolyData>
</VTKFile>`);
  const file = parseVtkXmlFile(buf);
  assert.equal(file.datasetType, "PolyData");
  assert.equal(file.littleEndian, false);
  const piece = findFirst(file.root, "Piece")!;
  assert.equal(piece.attrs.a, "x & y");
  assert.equal(piece.attrs.b, `<3>"'`);
});

test("non-VTKFile root throws a descriptive error", () => {
  assert.throws(() => parseVtkXmlFile(Buffer.from(`<html></html>`)), /VTKFile/);
});

// ---- format="ascii" ---------------------------------------------------------------

test("decodes ascii DataArray", () => {
  const { values, diags } = decodeFirst(
    doc(`<DataArray type="Float64" Name="v" format="ascii">
      0 0.5 1 1.5
      2 2.5 3 3.5 4
    </DataArray>`)
  );
  assert.deepEqual([...values], FLOATS);
  assert.equal(diags.length, 0);
});

// ---- format="binary" (inline base64) ----------------------------------------------

test("decodes inline base64 uncompressed Float32", () => {
  const b64 = inlineUncompressed(valueBuf(FLOATS, "Float32", true), "UInt32", true);
  const { values, diags } = decodeFirst(
    doc(`<DataArray type="Float32" Name="v" format="binary">${b64}</DataArray>`)
  );
  assert.deepEqual([...values], FLOATS);
  assert.equal(diags.length, 0);
});

test("decodes inline base64 zlib-compressed, multi-block with short last block", () => {
  const payload = valueBuf(FLOATS, "Float64", true); // 72 bytes
  const b64 = inlineCompressed(payload, "UInt32", true, 32); // 3 blocks: 32+32+8
  const { values, diags } = decodeFirst(
    doc(`<DataArray type="Float64" Name="v" format="binary">${b64}</DataArray>`, {
      compressed: true,
    })
  );
  assert.deepEqual([...values], FLOATS);
  assert.equal(diags.length, 0);
});

test("decodes inline base64 compressed with exactly-full blocks (last partial = 0)", () => {
  const payload = valueBuf([1, 2, 3, 4], "Float64", true); // 32 bytes
  const b64 = inlineCompressed(payload, "UInt32", true, 16); // 2 full blocks
  const { values } = decodeFirst(
    doc(`<DataArray type="Float64" Name="v" format="binary">${b64}</DataArray>`, {
      compressed: true,
    })
  );
  assert.deepEqual([...values], [1, 2, 3, 4]);
});

test("decodes inline base64 compressed with header_type=UInt64", () => {
  const payload = valueBuf(FLOATS, "Float32", true);
  const b64 = inlineCompressed(payload, "UInt64", true, 16);
  const { values } = decodeFirst(
    doc(`<DataArray type="Float32" Name="v" format="binary">${b64}</DataArray>`, {
      compressed: true,
      headerType: "UInt64",
    })
  );
  assert.deepEqual([...values], FLOATS);
});

// ---- format="appended" --------------------------------------------------------------

test("decodes appended raw at byte offsets (two arrays)", () => {
  const a1 = rawUncompressed(valueBuf([1, 2, 3], "Float32", true), "UInt32", true);
  const a2 = rawUncompressed(valueBuf([10, 20], "Int32", true), "UInt32", true);
  const blob = Buffer.concat([a1, a2]);
  const buf = doc(
    `<DataArray type="Float32" Name="a" format="appended" offset="0"/>
     <DataArray type="Int32" Name="b" format="appended" offset="${a1.length}"/>`,
    { appended: { encoding: "raw", blob } }
  );
  const file = parseVtkXmlFile(buf);
  const das = findAll(file.root, "DataArray");
  const diags: MdpaDiagnostic[] = [];
  assert.deepEqual([...decodeDataArray(das[0], file, diags)], [1, 2, 3]);
  assert.deepEqual([...decodeDataArray(das[1], file, diags)], [10, 20]);
  assert.equal(diags.length, 0);
});

test("decodes appended raw compressed", () => {
  const payload = valueBuf(FLOATS, "Float64", true);
  const blocks = [payload.subarray(0, 40), payload.subarray(40)];
  const comp = blocks.map((b) => zlib.deflateSync(b));
  const header = headerBuf([2, 40, payload.length - 40, comp[0].length, comp[1].length], "UInt32", true);
  const blob = Buffer.concat([header, ...comp]);
  const buf = doc(
    `<DataArray type="Float64" Name="a" format="appended" offset="0"/>`,
    { appended: { encoding: "raw", blob }, compressed: true }
  );
  const file = parseVtkXmlFile(buf);
  const diags: MdpaDiagnostic[] = [];
  const values = decodeDataArray(findAll(file.root, "DataArray")[0], file, diags);
  assert.deepEqual([...values], FLOATS);
});

test("decodes appended base64 at character offsets (two arrays)", () => {
  const s1 = inlineUncompressed(valueBuf([1, 2, 3], "Float32", true), "UInt32", true);
  const s2 = inlineUncompressed(valueBuf([7, 8], "Float32", true), "UInt32", true);
  const buf = doc(
    `<DataArray type="Float32" Name="a" format="appended" offset="0"/>
     <DataArray type="Float32" Name="b" format="appended" offset="${s1.length}"/>`,
    { appended: { encoding: "base64", blob: s1 + s2 } }
  );
  const file = parseVtkXmlFile(buf);
  const das = findAll(file.root, "DataArray");
  const diags: MdpaDiagnostic[] = [];
  assert.deepEqual([...decodeDataArray(das[0], file, diags)], [1, 2, 3]);
  assert.deepEqual([...decodeDataArray(das[1], file, diags)], [7, 8]);
});

// ---- Byte order and wide integers ---------------------------------------------------

test("decodes BigEndian Float64 inline base64", () => {
  const b64 = inlineUncompressed(valueBuf(FLOATS, "Float64", false), "UInt32", false);
  const { values } = decodeFirst(
    doc(`<DataArray type="Float64" Name="v" format="binary">${b64}</DataArray>`, {
      byteOrder: "BigEndian",
    })
  );
  assert.deepEqual([...values], FLOATS);
});

test("decodes Int64 data (within safe range)", () => {
  const ints = [1, -5, 4294967296, 9007199254740991];
  const b64 = inlineUncompressed(valueBuf(ints, "Int64", true), "UInt32", true);
  const { values, diags } = decodeFirst(
    doc(`<DataArray type="Int64" Name="v" format="binary">${b64}</DataArray>`)
  );
  assert.deepEqual([...values], ints);
  assert.equal(diags.length, 0);
});

test("unknown DataArray type → diagnostic, empty result", () => {
  const { values, diags } = decodeFirst(
    doc(`<DataArray type="Complex128" Name="v" format="ascii">1 2</DataArray>`)
  );
  assert.equal(values.length, 0);
  assert.ok(diags.length > 0);
});

// ---- find helpers --------------------------------------------------------------------

test("findAll returns nested matches in document order", () => {
  const file = parseVtkXmlFile(
    doc(`<PointData>
      <DataArray type="Float32" Name="one" format="ascii">1</DataArray>
      <DataArray type="Float32" Name="two" format="ascii">2</DataArray>
    </PointData>`)
  );
  const das = findAll(file.root, "DataArray");
  assert.equal(das.length, 2);
  assert.deepEqual(das.map((d) => d.attrs.Name), ["one", "two"]);
});
