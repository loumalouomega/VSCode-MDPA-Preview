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
