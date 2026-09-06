import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMeshFile, xdmfDataFiles } from "../parser/meshFileParser";
import {
  SUPPORTED_MESH_EXTENSIONS,
  TIMELINE_EXTENSIONS,
} from "../parser/meshFormats";

function tmpFile(name: string, content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meshparse-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const ASCII_VTK = `# vtk DataFile Version 3.0
vtk output
ASCII
DATASET UNSTRUCTURED_GRID
POINTS 3 float
0 0 0
1 0 0
0 1 0
CELLS 1 4
3 0 1 2
CELL_TYPES 1
5
`;

test("dispatches .vtk ASCII to the streaming legacy parser", async () => {
  const p = tmpFile("mesh.vtk", ASCII_VTK);
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].vtkCellType, 5);
});

test("progress callback fires for .vtk", async () => {
  const p = tmpFile("mesh.vtk", ASCII_VTK);
  let calls = 0;
  await parseMeshFile(p, () => calls++);
  assert.ok(calls > 0);
});

test("unknown extension rejects with a descriptive error", async () => {
  const p = tmpFile("mesh.xyz", "whatever");
  await assert.rejects(() => parseMeshFile(p), /\.xyz/);
});

test("extension matching is case-insensitive", async () => {
  const p = tmpFile("MESH.VTK", ASCII_VTK);
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
});

test("dispatches BINARY .vtk to the binary legacy parser", async () => {
  const header = Buffer.from(
    "# vtk DataFile Version 3.0\nvtk output\nBINARY\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n",
    "latin1"
  );
  const pts = Buffer.alloc(9 * 4);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => pts.writeFloatBE(v, i * 4));
  const p = tmpFile("bin.vtk", Buffer.concat([header, pts, Buffer.from("\n")]));
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
  // No "binary not supported" diagnostic
  assert.ok(!m.diagnostics.some((d) => d.message.toLowerCase().includes("not supported")));
});

test("dispatches .stl to the STL parser", async () => {
  const ascii = `solid S
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid S
`;
  const p = tmpFile("part.stl", ascii);
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks[0].vtkCellType, 5);
});

test("dispatches .vtu to the VTK XML parser", async () => {
  const vtu = `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" byte_order="LittleEndian">
  <UnstructuredGrid>
    <Piece NumberOfPoints="3" NumberOfCells="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0</DataArray>
      </Points>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
        <DataArray type="UInt8" Name="types" format="ascii">5</DataArray>
      </Cells>
    </Piece>
  </UnstructuredGrid>
</VTKFile>
`;
  const p = tmpFile("mesh.vtu", vtu);
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks[0].vtkCellType, 5);
});

test("dispatches .obj to the OBJ parser", async () => {
  const p = tmpFile("part.obj", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks[0].vtkCellType, 5);
});

test("dispatches .ply to the PLY parser", async () => {
  const ply = `ply
format ascii 1.0
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
`;
  const p = tmpFile("part.ply", ply);
  const m = await parseMeshFile(p);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks[0].vtkCellType, 5);
});

test("format constants are consistent", () => {
  for (const ext of TIMELINE_EXTENSIONS) {
    assert.ok(SUPPORTED_MESH_EXTENSIONS.includes(ext));
  }
  assert.ok(SUPPORTED_MESH_EXTENSIONS.includes(".stl"));
  assert.ok(!TIMELINE_EXTENSIONS.includes(".stl"));
});

// meshio++ 8.0.0 made XDMF's wasm writer keep its heavy arrays in a companion
// .h5. The reader opens it by the name in the XML, so the dispatcher has to
// place it in the virtual filesystem too — an XDMF+HDF file was previously
// unopenable (this covers ParaView output as much as our own).
test("xdmfDataFiles finds the external files a DataItem references", () => {
  const xml = `<Xdmf><Domain><Grid>
    <DataItem DataType="Float" Dimensions="4 3" Format="HDF" Precision="8">beam.h5:/data0</DataItem>
    <DataItem DataType="Int" Dimensions="1 4" Format="HDF" Precision="8">beam.h5:/data1</DataItem>
    <DataItem Format="Binary" Dimensions="4">beam0.bin</DataItem>
    <DataItem Format="XML" Dimensions="2">1 2</DataItem>
  </Grid></Domain></Xdmf>`;
  assert.deepEqual(xdmfDataFiles(xml), ["beam.h5", "beam0.bin"]);
});

test("xdmfDataFiles ignores inline data and subdirectory references", () => {
  assert.deepEqual(xdmfDataFiles("<DataItem Format='XML'>1 2 3</DataItem>"), []);
  assert.deepEqual(xdmfDataFiles(""), []);
  // The virtual filesystem is flat, so a nested path cannot be honoured; it is
  // left to meshio++ to report rather than silently mapped to a basename.
  assert.deepEqual(
    xdmfDataFiles('<DataItem Format="HDF">sub/beam.h5:/data0</DataItem>'),
    []
  );
});

// --- GiD postprocess (meshio++ >= 10.19.0 reader / 10.18.0 writer) ----------
//
// The first COMPOUND extension this extension handles, so these tests are as
// much about the dispatch (`meshExtname`) and the sibling staging as about the
// format: `path.extname("case.post.msh")` is ".msh", which routes to gmsh.

/** Writes a GiD ascii pair to a fresh temp dir and returns the directory. */
async function writeGidPair(): Promise<string> {
  const { parseMdpa } = await import("../parser/mdpaParser");
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const model = parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0", " 2 1.0 0.0 0.0", " 3 0.0 1.0 0.0", " 4 0.0 0.0 1.0", " 5 1.0 1.0 1.0",
      "End Nodes",
      "Begin Elements Element3D4N",
      " 1 0 1 2 3 4",
      " 2 0 2 3 4 5",
      "End Elements",
      "Begin NodalData TEMP",
      " 1 0 10.0", " 2 0 20.0", " 3 0 30.0", " 4 0 40.0", " 5 0 50.0",
      "End NodalData",
      "",
    ].join("\n")
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gid-"));
  const { data, companions } = await writeMeshFileAsync(model, ".post.msh", { name: "case" });
  fs.writeFileSync(path.join(dir, "case.post.msh"), data);
  for (const c of companions) fs.writeFileSync(path.join(dir, c.name), c.data);
  return dir;
}

test("a GiD ascii pair round-trips to disk and back", async () => {
  const dir = await writeGidPair();
  // The results half is a COMPANION of the write, not a second call — the same
  // mechanism that already carries XDMF's .h5 and OpenFOAM's polyMesh tree,
  // which is why the writer layer needed no change for a paired format.
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ["case.post.msh", "case.post.res"],
    "both halves land on disk"
  );

  const model = await parseMeshFile(path.join(dir, "case.post.msh"));
  assert.equal(model.nodeCount, 5);
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 2);
  const temp = model.fields.find((f) => f.variable === "TEMP");
  assert.ok(temp, `expected TEMP, got ${model.fields.map((f) => f.variable)}`);
  assert.deepEqual(Array.from(temp.values), [10, 20, 30, 40, 50], "values survive exactly");
});

test("opening the GiD results half finds its geometry sibling", async () => {
  // .post.res carries no coordinates at all: without meshioSiblingNames staging
  // .post.msh alongside it, this read yields nothing.
  const dir = await writeGidPair();
  const model = await parseMeshFile(path.join(dir, "case.post.res"));
  assert.equal(model.nodeCount, 5, "geometry came from the sibling");
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 2);
});

test("a multi-step GiD file reports its steps and selects between them", async () => {
  // What makes gid eligible for IN_FILE_TIMELINE_EXTENSIONS: readMetadata does a
  // header-only scan of .post.res, so the timeline's length is known before any
  // step is read. meshio++ writes one step, so the second is appended by hand —
  // a Kratos GiD run produces many.
  const { readMeshTimeSteps } = await import("../parser/meshFileParser");
  const dir = await writeGidPair();
  const res = path.join(dir, "case.post.res");
  fs.appendFileSync(
    res,
    [
      'Result "TEMP" "meshio++" 2 Scalar OnNodes',
      "Values",
      "1 100", "2 200", "3 300", "4 400", "5 500",
      "End Values",
      "",
    ].join("\n")
  );

  const main = path.join(dir, "case.post.msh");
  assert.deepEqual(await readMeshTimeSteps(main), [1, 2], "both steps are discoverable");

  const first = await parseMeshFile(main, undefined, { timeStep: 0 });
  const second = await parseMeshFile(main, undefined, { timeStep: 1 });
  assert.deepEqual(
    Array.from(first.fields.find((f) => f.variable === "TEMP")!.values),
    [10, 20, 30, 40, 50]
  );
  assert.deepEqual(
    Array.from(second.fields.find((f) => f.variable === "TEMP")!.values),
    [100, 200, 300, 400, 500],
    "timeStep selects the step, rather than always returning the first"
  );
});

test("a multi-step GiD pair is discovered as an in-file series", async () => {
  // discoverSeriesSteps and the VTK provider's discover() now branch on the same
  // timelineKindFor, so this is the closest a unit test gets to the decision
  // that draws the timeline bar. (It passed before the fix too — fieldSeriesScan
  // was always right; the reproduction is in meshFormats.test.ts. This is the
  // drift guard on the shared helper.)
  const { discoverSeriesSteps } = await import("../parser/fieldSeriesScan");
  const dir = await writeGidPair();
  fs.appendFileSync(
    path.join(dir, "case.post.res"),
    [
      'Result "TEMP" "meshio++" 2 Scalar OnNodes',
      "Values",
      "1 100", "2 200", "3 300", "4 400", "5 500",
      "End Values",
      "",
    ].join("\n")
  );

  for (const half of ["case.post.msh", "case.post.res"]) {
    const { steps, source } = await discoverSeriesSteps(path.join(dir, half));
    assert.equal(source, "inFile", `${half} drives an in-file series`);
    assert.equal(steps.length, 2, `${half} sees both steps`);
  }
});

test("a .post.msh is not mistaken for a gmsh file", async () => {
  // The regression this whole compound-extension change exists to prevent. A
  // GiD file handed to the gmsh reader fails; that it parses at all is the
  // proof the dispatch resolved the longer suffix.
  const dir = await writeGidPair();
  const model = await parseMeshFile(path.join(dir, "case.post.msh"));
  assert.equal(model.nodeCount, 5);
  assert.deepEqual(model.diagnostics, [], "no fallback-reader warnings");
});
