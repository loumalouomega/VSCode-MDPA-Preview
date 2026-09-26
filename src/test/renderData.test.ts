import { strict as assert } from "node:assert";
import { test } from "node:test";

import { VtkCellType } from "../parser/geometryMap";
import { buildCellIndex, cellPointIds, legacyCellCount, legacyToOffsets } from "../parser/render/cellArrays";
import { Cell, buildDisplayGeometry, prepareNodes } from "../parser/render/displayGeometry";
import { ctfPointsFromStops, fieldColoring, glyphColoring } from "../parser/render/scalarColoring";
import type { ColorStop } from "../parser/fieldScalars";
import type { MdpaModel } from "../parser/types";

// The renderer-boundary pure core (roadmap item 18): display geometry, cell
// layout conversion and colouring decisions. Where vtk.js is the reference
// (cell enumeration, colour transfer functions) the tests ask vtk.js itself,
// so these stay meaningful after the vtk.js backend is removed only as long as
// that dependency exists — the golden values are asserted literally too.
/* eslint-disable @typescript-eslint/no-var-requires */
const vtkPolyData: any = require("@kitware/vtk.js/Common/DataModel/PolyData").default;
const vtkColorTransferFunction: any = require("@kitware/vtk.js/Rendering/Core/ColorTransferFunction").default;

function model(coords: number[]): MdpaModel {
  const n = coords.length / 3;
  return { nodeCount: n, nodeIds: Int32Array.from({ length: n }, (_, i) => i + 1), coords: Float32Array.from(coords) } as unknown as MdpaModel;
}

// Two tets sharing a face (1,2,3), a line, a triangle and an isolated point.
const COORDS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 2, 0, 0, 2, 1, 0, 3, 3, 3];
const CELLS: Cell[] = [
  { cellType: VtkCellType.TETRA, nodeIds: [1, 2, 3, 4], entityId: 10 },
  { cellType: VtkCellType.TETRA, nodeIds: [2, 3, 4, 5], entityId: 11 },
  { cellType: VtkCellType.LINE, nodeIds: [6, 7], entityId: 20 },
  { cellType: VtkCellType.TRIANGLE, nodeIds: [2, 6, 7], entityId: 30 },
  { cellType: undefined, nodeIds: [8] },
];

test("buildDisplayGeometry: boundary skin, verts/lines/polys, pick maps in VTK enumeration order", () => {
  const built = buildDisplayGeometry(prepareNodes(model(COORDS)), CELLS, undefined, { wantPickMaps: true })!;
  const g = built.geometry;
  // Two tets share face {2,3,4}: 8 faces - 2 = 6 boundary triangles, + 1 surface triangle.
  assert.equal(legacyCellCount(g.polys), 7);
  assert.equal(legacyCellCount(g.lines), 1);
  assert.equal(legacyCellCount(g.verts), 1);
  assert.equal(g.points.length / 3, 8);
  // Cell entity ids: verts (none) -> lines (20) -> polys (triangle 30 first, then boundary faces).
  assert.deepEqual([...built.cellEntityIds!], [-1, 20, 30, 10, 10, 10, 11, 11, 11]);
  assert.equal(built.pointGlobalIds!.length, 8);
  assert.equal(g.pointScalars, undefined);
  assert.equal(g.cellScalars, undefined);
});

test("buildDisplayGeometry: point scalars follow local point birth order; cell scalars follow cell order", () => {
  const prep = prepareNodes(model(COORDS));
  const pt = buildDisplayGeometry(prep, CELLS, { name: "T", pointScalar: (nid) => nid * 10 }, { wantPickMaps: true })!;
  assert.deepEqual([...pt.geometry.pointScalars!.values], [...pt.pointGlobalIds!].map((n) => n * 10));
  const cl = buildDisplayGeometry(prep, CELLS, { name: "E", cellScalar: (eid) => (eid === undefined ? NaN : eid) }, { wantPickMaps: true })!;
  const vals = [...cl.geometry.cellScalars!.values];
  assert.deepEqual(vals.map((v) => (Number.isNaN(v) ? -1 : v)), [...cl.cellEntityIds!]);
  assert.equal(buildDisplayGeometry(prep, [], undefined), null);
});

test("cellPointIds agrees with vtk.js getCellPoints for every cell", () => {
  const g = buildDisplayGeometry(prepareNodes(model(COORDS)), CELLS)!.geometry;
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(g.points, 3);
  if (g.polys) pd.getPolys().setData(g.polys);
  if (g.lines) pd.getLines().setData(g.lines);
  if (g.verts) pd.getVerts().setData(g.verts);
  pd.buildCells(); // what vtkCellPicker does before main.ts ever calls getCellPoints
  const index = buildCellIndex(g);
  assert.equal(index.count, pd.getNumberOfCells());
  for (let c = 0; c < index.count; c++) {
    assert.deepEqual(cellPointIds(g, index, c), [...pd.getCellPoints(c).cellPointIds], `cell ${c}`);
  }
  assert.deepEqual(cellPointIds(g, index, index.count), []);
  assert.deepEqual(cellPointIds(g, index, -1), []);
});

test("legacyToOffsets converts, validates, and refuses corrupt arrays", () => {
  const r = legacyToOffsets(Uint32Array.from([3, 0, 1, 2, 4, 2, 3, 4, 5, 1, 6]), 7);
  assert.equal(r.count, 3);
  assert.deepEqual([...r.offsets], [0, 3, 7, 8]);
  assert.deepEqual([...r.connectivity], [0, 1, 2, 2, 3, 4, 5, 6]);
  assert.deepEqual(legacyToOffsets(undefined, 0), { offsets: new Int32Array([0]), connectivity: new Int32Array(0), count: 0 });
  assert.throws(() => legacyToOffsets([3, 0, 1], 3), /truncated/);
  assert.throws(() => legacyToOffsets([2, 0, 9], 3), /references point 9/);
});

const RAINBOW: ColorStop[] = [
  [0, 0, 0, 1],
  [0.5, 0, 1, 0],
  [1, 1, 0, 0],
];

test("ctfPointsFromStops reproduces a vtk.js CTF built from the same stops", () => {
  const pts = ctfPointsFromStops(RAINBOW, 10, 30);
  assert.deepEqual(pts, [10, 0, 0, 1, 20, 0, 1, 0, 30, 1, 0, 0]);
  const ctf = vtkColorTransferFunction.newInstance();
  for (let i = 0; i < pts.length; i += 4) ctf.addRGBPoint(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
  const rgb = [0, 0, 0];
  ctf.getColor(15, rgb);
  assert.deepEqual(rgb.map((v) => +v.toFixed(6)), [0, 0.5, 0.5]);
  // Degenerate: one point, mapping range stays [min, min].
  assert.deepEqual(ctfPointsFromStops(RAINBOW, 5, 5), [5, 0, 1, 0]);
});

test("fieldColoring / glyphColoring: flat on a degenerate range, mapped otherwise", () => {
  assert.deepEqual(fieldColoring(RAINBOW, { min: 1, max: 1 }, "point"), { kind: "flat", rgb: [0, 1, 0] });
  const p = fieldColoring(RAINBOW, { min: 0, max: 2 }, "point");
  assert.equal(p.kind, "mapped");
  if (p.kind === "mapped") {
    assert.equal(p.interpolateBeforeMapping, true);
    assert.deepEqual(p.range, [0, 2]);
    assert.equal(p.arrayName, undefined);
  }
  const c = fieldColoring(RAINBOW, { min: 0, max: 2 }, "cell");
  assert.ok(c.kind === "mapped" && c.association === "cell" && !c.interpolateBeforeMapping);
  // Bands transform the stops the CTF is built from.
  const banded = fieldColoring(RAINBOW, { min: 0, max: 2, bands: 2 }, "point");
  assert.ok(banded.kind === "mapped" && p.kind === "mapped" && banded.ctfPoints.length > p.ctfPoints.length);
  const gl = glyphColoring(RAINBOW, 0, 4, "magnitude");
  assert.ok(gl.kind === "mapped" && gl.arrayName === "magnitude" && !gl.interpolateBeforeMapping);
  assert.deepEqual(glyphColoring(RAINBOW, 3, 3, "radius"), { kind: "flat", rgb: [0, 1, 0] });
});
