import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTypeName, VtkCellType } from "../parser/geometryMap";

test("decodes standard Element<dim>D<n>N names", () => {
  assert.equal(decodeTypeName("Element2D3N").vtkCellType, VtkCellType.TRIANGLE);
  assert.equal(decodeTypeName("Element2D4N").vtkCellType, VtkCellType.QUAD);
  assert.equal(decodeTypeName("Element3D4N").vtkCellType, VtkCellType.TETRA);
  assert.equal(decodeTypeName("Element3D8N").vtkCellType, VtkCellType.HEXAHEDRON);
  assert.equal(decodeTypeName("Element3D6N").vtkCellType, VtkCellType.WEDGE);
});

test("decodes application-prefixed names", () => {
  assert.equal(
    decodeTypeName("SmallDisplacementElement3D4N").vtkCellType,
    VtkCellType.TETRA
  );
  assert.equal(
    decodeTypeName("LineCondition2D2N").vtkCellType,
    VtkCellType.LINE
  );
  assert.equal(
    decodeTypeName("SurfaceCondition3D3N").vtkCellType,
    VtkCellType.TRIANGLE
  );
});

test("decodes quadratic element names", () => {
  assert.equal(decodeTypeName("Element3D10N").vtkCellType, VtkCellType.QUADRATIC_TETRA);
  assert.equal(decodeTypeName("Element3D20N").vtkCellType, VtkCellType.QUADRATIC_HEXAHEDRON);
  assert.equal(decodeTypeName("Element2D6N").vtkCellType, VtkCellType.QUADRATIC_TRIANGLE);
});

test("decodes bare geometry names via family fallback", () => {
  assert.equal(decodeTypeName("Triangle2D3").vtkCellType, VtkCellType.TRIANGLE);
  assert.equal(decodeTypeName("Line2D2").vtkCellType, VtkCellType.LINE);
  assert.equal(decodeTypeName("Tetrahedra3D4").vtkCellType, VtkCellType.TETRA);
  assert.equal(decodeTypeName("Hexahedra3D8").vtkCellType, VtkCellType.HEXAHEDRON);
});

test("decodes non-standard prefixed names via the trailing <dim>D<n>N suffix", () => {
  assert.equal(
    decodeTypeName("TotalLagrangianElement3D4N").vtkCellType,
    VtkCellType.TETRA
  );
  assert.equal(
    decodeTypeName("UPwSmallStrainElement3D10N").vtkCellType,
    VtkCellType.QUADRATIC_TETRA
  );
  assert.equal(
    decodeTypeName("AxisymmetricLoadCondition2D2N").vtkCellType,
    VtkCellType.LINE
  );
});

test("trailing <dim>D<n>N suffix wins over an earlier <dim>D in the name", () => {
  // "2D" appears first, but the authoritative suffix is 3D4N → tetrahedron
  const d = decodeTypeName("Stress2DPlaneElement3D4N");
  assert.equal(d.dimension, 3);
  assert.equal(d.nodeCount, 4);
  assert.equal(d.vtkCellType, VtkCellType.TETRA);
});

test("reports undefined for unmappable names", () => {
  assert.equal(decodeTypeName("MysteryElement").vtkCellType, undefined);
});

test("extracts dimension and node count", () => {
  const d = decodeTypeName("Element3D8N");
  assert.equal(d.dimension, 3);
  assert.equal(d.nodeCount, 8);
});
