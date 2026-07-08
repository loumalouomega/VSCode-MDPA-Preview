import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { parseVtk } from "../parser/vtkLegacyParser";
import { parseVtkXml } from "../parser/vtkXmlParser";
import { parseStl } from "../parser/stlParser";
import { parseObj } from "../parser/objParser";
import { parsePly } from "../parser/plyParser";

import { writeMdpa } from "../parser/writers/mdpaWriter";
import { writeVtkLegacy } from "../parser/writers/vtkLegacyWriter";
import { writeVtu, writeVtp } from "../parser/writers/vtkXmlWriter";
import { writeStl } from "../parser/writers/stlWriter";
import { writeObj } from "../parser/writers/objWriter";
import { writePly } from "../parser/writers/plyWriter";
import {
  EXPORTABLE_EXTENSIONS,
  isExportableExtension,
  writeMeshFile,
} from "../parser/writers/meshWriter";
import { MdpaModel } from "../parser/types";

const TRIANGLE = 5;
const QUAD = 9;
const TETRA = 10;

// A surface model: two triangles + one quad, with node/cell fields and a submodelpart.
const SURFACE_SRC = `Begin Properties 1
  DENSITY 2700.0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 2.0 0.0 0.0
End Nodes

Begin Elements Element2D3N
1 1 2 5 3
End Elements

Begin Elements Element2D4N
2 1 1 2 3 4
End Elements

Begin NodalData TEMPERATURE
1 0 100.0
3 0 300.0
End NodalData

Begin NodalData DISPLACEMENT
1 0 (1.0,2.0,3.0)
2 1 (4.0,5.0,6.0)
End NodalData

Begin ElementalData ACTIVE
1 1.0
2 0.0
End ElementalData

Begin SubModelPart Inlet
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

// A single tetrahedron (volume) → 4 boundary triangles, 4 nodes.
const VOLUME_SRC = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements
`;

function surfaceModel(): MdpaModel {
  return parseMdpa(SURFACE_SRC);
}
function volumeModel(): MdpaModel {
  return parseMdpa(VOLUME_SRC);
}

// ---- MDPA -----------------------------------------------------------------------

test("MDPA round-trip preserves nodes, blocks, fields, submodelparts", () => {
  const m = surfaceModel();
  const round = parseMdpa(writeMdpa(m));

  assert.equal(round.nodeCount, m.nodeCount);
  assert.deepEqual([...round.nodeIds], [...m.nodeIds]);
  assert.equal(round.blocks.length, m.blocks.length);

  const tri = round.blocks.find((b) => b.name === "Element2D3N")!;
  assert.equal(tri.vtkCellType, TRIANGLE);
  assert.deepEqual([...tri.connectivity], [2, 5, 3]);

  const quad = round.blocks.find((b) => b.name === "Element2D4N")!;
  assert.equal(quad.vtkCellType, QUAD);

  const temp = round.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.deepEqual([...temp.ids], [1, 3]);
  assert.deepEqual([...temp.values], [100, 300]);

  const disp = round.fields.find((f) => f.variable === "DISPLACEMENT")!;
  assert.equal(disp.components, 3);
  assert.deepEqual([...disp.values], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...disp.fixed!], [0, 1]);

  const active = round.fields.find((f) => f.variable === "ACTIVE")!;
  assert.equal(active.kind, "Elemental");
  assert.deepEqual([...active.values], [1, 0]);

  assert.equal(round.subModelParts.length, 1);
  assert.equal(round.subModelParts[0].name, "Inlet");
  assert.deepEqual([...round.subModelParts[0].nodeIds], [1, 2]);
  assert.deepEqual([...round.subModelParts[0].elementIds], [1]);
});

test("MDPA writer preserves Properties verbatim when given source text", () => {
  const m = surfaceModel();
  const out = writeMdpa(m, { sourceText: SURFACE_SRC });
  assert.match(out, /Begin Properties 1/);
  assert.match(out, /DENSITY 2700/);
});

test("MDPA writer emits a default Properties block without source text", () => {
  const out = writeMdpa(surfaceModel());
  assert.match(out, /Begin Properties 0\nEnd Properties/);
});

// ---- Legacy VTK -----------------------------------------------------------------

test("legacy VTK round-trip preserves geometry and cells", () => {
  const m = surfaceModel();
  const round = parseVtk(writeVtkLegacy(m));

  assert.equal(round.nodeCount, 5);
  // coords preserved (node 5 at x=2)
  assert.equal(round.coords[4 * 3], 2);
  const totalCells = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.equal(totalCells, 2);
  assert.ok(round.blocks.some((b) => b.vtkCellType === TRIANGLE));
  assert.ok(round.blocks.some((b) => b.vtkCellType === QUAD));
});

test("legacy VTK round-trip carries point and cell fields", () => {
  const round = parseVtk(writeVtkLegacy(surfaceModel()));
  const temp = round.fields.find((f) => f.variable === "TEMPERATURE" && f.kind === "Nodal")!;
  assert.equal(temp.values.length, 5); // dense, one per point
  assert.equal(temp.values[0], 100);
  assert.equal(temp.values[2], 300);
  const active = round.fields.find((f) => f.variable === "ACTIVE" && f.kind === "Elemental")!;
  assert.equal(active.values.length, 2);
});

// ---- VTU / VTP ------------------------------------------------------------------

test("VTU round-trip preserves geometry, cells and fields", () => {
  const round = parseVtkXml(Buffer.from(writeVtu(surfaceModel())));
  assert.equal(round.nodeCount, 5);
  const totalCells = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.equal(totalCells, 2);
  const temp = round.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.equal(temp.values.length, 5);
  assert.equal(temp.values[2], 300);
});

test("VTP round-trip preserves surface polygons", () => {
  const round = parseVtkXml(Buffer.from(writeVtp(surfaceModel())));
  assert.equal(round.nodeCount, 5);
  // triangle stays a triangle; quad is normalized into triangles by the parser
  const totalCells = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.ok(totalCells >= 2);
  assert.ok(round.blocks.some((b) => b.vtkCellType === TRIANGLE));
});

// ---- STL / OBJ / PLY ------------------------------------------------------------

test("STL export of a volume mesh yields the boundary triangles", () => {
  const round = parseStl(Buffer.from(writeStl(volumeModel())));
  assert.equal(round.nodeCount, 4); // 4 corners welded
  const total = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.equal(total, 4); // tetra has 4 boundary faces
});

test("STL export of a surface mesh triangulates the quad", () => {
  const round = parseStl(Buffer.from(writeStl(surfaceModel())));
  // 1 triangle + quad (2 tris) = 3 facets
  const total = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.equal(total, 3);
});

test("OBJ round-trip preserves vertices and surface faces", () => {
  const round = parseObj(writeObj(surfaceModel()));
  assert.equal(round.nodeCount, 5);
  const total = round.blocks.reduce((s, b) => s + b.count, 0);
  // triangle + quad kept as polygons (quad normalized to 2 tris by modelBuilder)
  assert.ok(total >= 2);
});

test("OBJ export of a volume mesh writes boundary faces", () => {
  const round = parseObj(writeObj(volumeModel()));
  assert.equal(round.nodeCount, 4);
  const total = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.equal(total, 4);
});

test("PLY round-trip preserves geometry, faces and nodal scalar fields", () => {
  const round = parsePly(Buffer.from(writePly(surfaceModel())));
  assert.equal(round.nodeCount, 5);
  const total = round.blocks.reduce((s, b) => s + b.count, 0);
  assert.ok(total >= 2);
  const temp = round.fields.find((f) => f.variable === "TEMPERATURE")!;
  assert.ok(temp);
  assert.equal(temp.values.length, 5);
  assert.equal(temp.values[2], 300);
});

// ---- Dispatcher -----------------------------------------------------------------

test("writeMeshFile routes by extension and rejects unsupported formats", () => {
  const m = surfaceModel();
  assert.match(writeMeshFile(m, ".mdpa"), /Begin Nodes/);
  assert.match(writeMeshFile(m, ".vtk"), /DATASET UNSTRUCTURED_GRID/);
  assert.match(writeMeshFile(m, ".vtu"), /UnstructuredGrid/);
  assert.match(writeMeshFile(m, ".VTP"), /PolyData/); // case-insensitive
  assert.match(writeMeshFile(m, ".stl"), /solid/);
  assert.match(writeMeshFile(m, ".obj"), /^v /m);
  assert.match(writeMeshFile(m, ".ply"), /^ply/);
  assert.throws(() => writeMeshFile(m, ".vti"), /Cannot export/);
});

test("isExportableExtension matches the exportable set case-insensitively", () => {
  for (const ext of EXPORTABLE_EXTENSIONS) {
    assert.ok(isExportableExtension(ext));
    assert.ok(isExportableExtension(ext.toUpperCase()));
  }
  assert.equal(isExportableExtension(".vti"), false);
  assert.equal(isExportableExtension(".vtm"), false);
});
