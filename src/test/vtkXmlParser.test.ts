import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVtkXml } from "../parser/vtkXmlParser";

const TRIANGLE = 5;

function vtuDoc(pieces: string, attrs = ""): Buffer {
  return Buffer.from(`<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" header_type="UInt32"${attrs}>
  <UnstructuredGrid>
${pieces}
  </UnstructuredGrid>
</VTKFile>
`);
}

const TRI_PIECE = `<Piece NumberOfPoints="3" NumberOfCells="1">
  <Points>
    <DataArray type="Float32" NumberOfComponents="3" format="ascii">
      0 0 0  1 0 0  0 1 0
    </DataArray>
  </Points>
  <Cells>
    <DataArray type="Int64" Name="connectivity" format="ascii">0 1 2</DataArray>
    <DataArray type="Int64" Name="offsets" format="ascii">3</DataArray>
    <DataArray type="UInt8" Name="types" format="ascii">5</DataArray>
  </Cells>
  <PointData>
    <DataArray type="Float64" Name="PRESSURE" format="ascii">1.5 2.5 3.5</DataArray>
  </PointData>
  <CellData>
    <DataArray type="Float64" Name="STRESS" format="ascii">42</DataArray>
  </CellData>
</Piece>`;

test("ascii .vtu → nodes, 1-based ids, VtkCell_5 block, Nodal + Elemental fields", () => {
  const m = parseVtkXml(vtuDoc(TRI_PIECE));
  assert.equal(m.nodeCount, 3);
  assert.deepEqual([...m.nodeIds], [1, 2, 3]);
  assert.ok(Math.abs(m.coords[3] - 1) < 1e-6);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].name, "VtkCell_5");
  assert.equal(m.blocks[0].vtkCellType, TRIANGLE);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3]);

  assert.equal(m.fields.length, 2);
  const p = m.fields.find((f) => f.variable === "PRESSURE")!;
  assert.equal(p.kind, "Nodal");
  assert.ok(Math.abs(p.values[1] - 2.5) < 1e-12);
  const s = m.fields.find((f) => f.variable === "STRESS")!;
  assert.equal(s.kind, "Elemental");
  assert.ok(Math.abs(s.values[0] - 42) < 1e-12);
  assert.equal(m.diagnostics.length, 0);
});

test(".vtu with appended raw data parses end-to-end", () => {
  // Points: 3 × Float32×3; connectivity Int32; offsets Int32; types UInt8
  const pts = Buffer.alloc(4 + 36);
  pts.writeUInt32LE(36, 0);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => pts.writeFloatLE(v, 4 + i * 4));
  const conn = Buffer.alloc(4 + 12);
  conn.writeUInt32LE(12, 0);
  [0, 1, 2].forEach((v, i) => conn.writeInt32LE(v, 4 + i * 4));
  const offs = Buffer.alloc(4 + 4);
  offs.writeUInt32LE(4, 0);
  offs.writeInt32LE(3, 4);
  const types = Buffer.alloc(4 + 1);
  types.writeUInt32LE(1, 0);
  types.writeUInt8(5, 4);

  const blob = Buffer.concat([pts, conn, offs, types]);
  const o1 = 0, o2 = pts.length, o3 = o2 + conn.length, o4 = o3 + offs.length;

  const buf = Buffer.concat([
    Buffer.from(`<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" byte_order="LittleEndian" header_type="UInt32">
  <UnstructuredGrid>
    <Piece NumberOfPoints="3" NumberOfCells="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="appended" offset="${o1}"/>
      </Points>
      <Cells>
        <DataArray type="Int32" Name="connectivity" format="appended" offset="${o2}"/>
        <DataArray type="Int32" Name="offsets" format="appended" offset="${o3}"/>
        <DataArray type="UInt8" Name="types" format="appended" offset="${o4}"/>
      </Cells>
    </Piece>
  </UnstructuredGrid>
  <AppendedData encoding="raw">
   _`),
    blob,
    Buffer.from(`
  </AppendedData>
</VTKFile>
`),
  ]);

  const m = parseVtkXml(buf);
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks[0].vtkCellType, TRIANGLE);
  assert.deepEqual([...m.blocks[0].connectivity], [1, 2, 3]);
  assert.equal(m.diagnostics.length, 0);
});

test("multi-Piece .vtu concatenates with node offsets", () => {
  const piece2 = `<Piece NumberOfPoints="3" NumberOfCells="1">
  <Points>
    <DataArray type="Float32" NumberOfComponents="3" format="ascii">
      2 0 0  3 0 0  2 1 0
    </DataArray>
  </Points>
  <Cells>
    <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
    <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
    <DataArray type="UInt8" Name="types" format="ascii">5</DataArray>
  </Cells>
</Piece>`;
  const m = parseVtkXml(vtuDoc(TRI_PIECE + "\n" + piece2));
  assert.equal(m.nodeCount, 6);
  const tri = m.blocks[0];
  assert.equal(tri.count, 2);
  // second piece's connectivity offset by 3 nodes
  assert.deepEqual([...tri.connectivity], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...tri.entityIds], [1, 2]);
});

test("unsupported dataset type throws", () => {
  const buf = Buffer.from(`<VTKFile type="Weird"><Weird/></VTKFile>`);
  assert.throws(() => parseVtkXml(buf), /Weird/);
});

// ---- PolyData (.vtp) ---------------------------------------------------------------

const LINE = 3;
const QUAD = 9;
const HEX = 12;

test(".vtp: polyline splits to LINE segments, polygon → TRIANGLE, cell fields expand", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="PolyData" byte_order="LittleEndian">
  <PolyData>
    <Piece NumberOfPoints="5" NumberOfLines="1" NumberOfPolys="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">
          0 0 0  1 0 0  2 0 0  0 1 0  1 1 0
        </DataArray>
      </Points>
      <Lines>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
      </Lines>
      <Polys>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 3</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray>
      </Polys>
      <CellData>
        <DataArray type="Float64" Name="MARK" format="ascii">10 20</DataArray>
      </CellData>
    </Piece>
  </PolyData>
</VTKFile>
`);
  const m = parseVtkXml(buf);
  const line = m.blocks.find((b) => b.vtkCellType === LINE)!;
  const tri = m.blocks.find((b) => b.vtkCellType === TRIANGLE)!;
  assert.equal(line.count, 2); // 3-node polyline → 2 segments
  assert.deepEqual([...line.connectivity], [1, 2, 2, 3]);
  assert.equal(tri.count, 1);
  // cell data: [line-cell 10, poly-cell 20] → expanded [10, 10, 20]
  const mark = m.fields.find((f) => f.variable === "MARK")!;
  assert.deepEqual([...mark.values], [10, 10, 20]);
  assert.deepEqual([...mark.ids], [1, 2, 3]);
});

test(".vtp: verts and strips are normalized to VERTEX / TRIANGLE", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="PolyData" byte_order="LittleEndian">
  <PolyData>
    <Piece NumberOfPoints="4" NumberOfVerts="1" NumberOfStrips="1">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">
          0 0 0  1 0 0  0 1 0  1 1 0
        </DataArray>
      </Points>
      <Verts>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 3</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">2</DataArray>
      </Verts>
      <Strips>
        <DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 3</DataArray>
        <DataArray type="Int32" Name="offsets" format="ascii">4</DataArray>
      </Strips>
    </Piece>
  </PolyData>
</VTKFile>
`);
  const m = parseVtkXml(buf);
  const vert = m.blocks.find((b) => b.vtkCellType === 1)!;
  const tri = m.blocks.find((b) => b.vtkCellType === TRIANGLE)!;
  assert.equal(vert.count, 2);
  assert.equal(tri.count, 2); // 4-node strip → 2 triangles
});

// ---- ImageData (.vti) ----------------------------------------------------------------

test(".vti: 3D extent → hexahedra with origin/spacing coordinates", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="ImageData" byte_order="LittleEndian">
  <ImageData WholeExtent="0 1 0 1 0 1" Origin="10 20 30" Spacing="2 3 4">
    <Piece Extent="0 1 0 1 0 1">
      <PointData>
        <DataArray type="Float64" Name="T" format="ascii">0 1 2 3 4 5 6 7</DataArray>
      </PointData>
    </Piece>
  </ImageData>
</VTKFile>
`);
  const m = parseVtkXml(buf);
  assert.equal(m.nodeCount, 8);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].vtkCellType, HEX);
  assert.equal(m.blocks[0].count, 1);
  assert.equal(m.blocks[0].stride, 8);
  // first point at origin, second offset by spacing in x
  assert.ok(Math.abs(m.coords[0] - 10) < 1e-6);
  assert.ok(Math.abs(m.coords[3] - 12) < 1e-6);
  assert.ok(Math.abs(m.coords[1] - 20) < 1e-6);
  // last point = origin + spacing
  assert.ok(Math.abs(m.coords[7 * 3 + 2] - 34) < 1e-6);
  const t = m.fields.find((f) => f.variable === "T")!;
  assert.equal(t.kind, "Nodal");
  assert.equal(t.ids.length, 8);
});

test(".vti: collapsed z extent → QUAD cells", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="ImageData" byte_order="LittleEndian">
  <ImageData WholeExtent="0 2 0 1 0 0" Origin="0 0 0" Spacing="1 1 1">
    <Piece Extent="0 2 0 1 0 0"/>
  </ImageData>
</VTKFile>
`);
  const m = parseVtkXml(buf);
  assert.equal(m.nodeCount, 6);
  assert.equal(m.blocks[0].vtkCellType, QUAD);
  assert.equal(m.blocks[0].count, 2);
  // first quad: nodes (0,0),(1,0),(1,1),(0,1) → 1-based ids 1,2,5,4
  assert.deepEqual([...m.blocks[0].connectivity.slice(0, 4)], [1, 2, 5, 4]);
});

test(".vti: oversized extent throws before allocating", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="ImageData" byte_order="LittleEndian">
  <ImageData WholeExtent="0 4999 0 4999 0 4999" Origin="0 0 0" Spacing="1 1 1">
    <Piece Extent="0 4999 0 4999 0 4999"/>
  </ImageData>
</VTKFile>
`);
  assert.throws(() => parseVtkXml(buf), /too large/i);
});

// ---- StructuredGrid (.vts) --------------------------------------------------------------

test(".vts: explicit points + extent-based cells", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="StructuredGrid" byte_order="LittleEndian">
  <StructuredGrid WholeExtent="0 1 0 1 0 0">
    <Piece Extent="0 1 0 1 0 0">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" format="ascii">
          0 0 5  1 0 5  0 1 5  1 1 5
        </DataArray>
      </Points>
    </Piece>
  </StructuredGrid>
</VTKFile>
`);
  const m = parseVtkXml(buf);
  assert.equal(m.nodeCount, 4);
  assert.equal(m.blocks[0].vtkCellType, QUAD);
  assert.equal(m.blocks[0].count, 1);
  assert.ok(Math.abs(m.coords[2] - 5) < 1e-6);
});

// ---- RectilinearGrid (.vtr) ----------------------------------------------------------------

test(".vtr: tensor-product coordinates + extent-based cells", () => {
  const buf = Buffer.from(`<?xml version="1.0"?>
<VTKFile type="RectilinearGrid" byte_order="LittleEndian">
  <RectilinearGrid WholeExtent="0 2 0 1 0 0">
    <Piece Extent="0 2 0 1 0 0">
      <Coordinates>
        <DataArray type="Float32" Name="x" format="ascii">0 1 4</DataArray>
        <DataArray type="Float32" Name="y" format="ascii">0 2</DataArray>
        <DataArray type="Float32" Name="z" format="ascii">7</DataArray>
      </Coordinates>
    </Piece>
  </RectilinearGrid>
</VTKFile>
`);
  const m = parseVtkXml(buf);
  assert.equal(m.nodeCount, 6);
  assert.equal(m.blocks[0].vtkCellType, QUAD);
  assert.equal(m.blocks[0].count, 2);
  // node 1 = (1,0,7); node 5 = (1,2,7)
  assert.ok(Math.abs(m.coords[3] - 1) < 1e-6);
  assert.ok(Math.abs(m.coords[5] - 7) < 1e-6);
  assert.ok(Math.abs(m.coords[4 * 3 + 1] - 2) < 1e-6);
});
