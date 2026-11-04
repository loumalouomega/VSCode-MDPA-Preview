import { test } from "node:test";
import assert from "node:assert/strict";
import { revolveExpand, REVOLVE_MAX_CELLS } from "../parser/render/revolveDisplay";
import { VtkCellType } from "../parser/geometryMap";
import { decompositionFor } from "../parser/cellDecomposition";
import type { EntityBlock, FieldData, MdpaModel } from "../parser/types";

function model(opts: { pts: number[][]; cells: { type: number; nodes: number[] }[]; fields?: FieldData[] }): MdpaModel {
  const n = opts.pts.length;
  const coords = new Float32Array(3 * n);
  opts.pts.forEach((p, i) => coords.set(p.length === 2 ? [p[0], p[1], 0] : p, 3 * i));
  const blocks: EntityBlock[] = opts.cells.map((c, i) => ({
    kind: "Elements",
    name: `B${i}`,
    vtkCellType: c.type,
    count: 1,
    stride: c.nodes.length,
    entityIds: Int32Array.of(i + 1),
    connectivity: Int32Array.from(c.nodes),
  }));
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], coords[3 * i + a]); max[a] = Math.max(max[a], coords[3 * i + a]); }
  return {
    nodeCount: n, nodeIds: Int32Array.from(opts.pts.map((_, i) => i + 1)), coords, blocks,
    subModelParts: [], meta: [], fields: opts.fields ?? [], diagnostics: [], is3D: false, bounds: { min, max },
  } as MdpaModel;
}

/** Sum of signed tet volumes of every cell (cellDecomposition's convention). */
function volumes(m: MdpaModel): { total: number; negative: number } {
  const idx = new Map<number, number>();
  m.nodeIds.forEach((id, i) => idx.set(id, i));
  let total = 0, negative = 0;
  for (const bl of m.blocks)
    for (let c = 0; c < bl.count; c++) {
      let v = 0;
      for (const t of decompositionFor(bl.vtkCellType).tets ?? []) {
        const p = t.map((l) => {
          const i = idx.get(bl.connectivity[c * bl.stride + l])!;
          return [m.coords[3 * i], m.coords[3 * i + 1], m.coords[3 * i + 2]];
        });
        const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        const d = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
        v += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
      }
      total += v;
      if (v <= 0) negative++;
    }
  return { total, negative };
}

const spec = { axis: "y" as const, startDeg: 0, sweepDeg: 360, layers: 64 };

test("a revolved rectangle measures the faceted pi R^2 H and every cell is positive", () => {
  const R = 2, H = 3;
  // Quad touching the axis (edge on x=0) and one away from it.
  const m = model({
    pts: [[0, 0], [1, 0], [1, H], [0, H], [R, 0], [R, H]],
    cells: [
      { type: VtkCellType.QUAD, nodes: [1, 2, 3, 4] },
      { type: VtkCellType.QUAD, nodes: [2, 5, 6, 3] },
    ],
  });
  const r = revolveExpand(m, spec);
  const v = volumes(r.model);
  assert.equal(v.negative, 0);
  const n = spec.layers;
  const exact = (Math.PI * R * R * H * Math.sin((2 * Math.PI) / n)) / ((2 * Math.PI) / n);
  assert.ok(Math.abs(v.total - exact) / exact < 1e-5, `${v.total} vs ${exact}`);
  assert.equal(r.axisNodes, 2);
  assert.ok(r.model.blocks.some((b) => b.vtkCellType === VtkCellType.WEDGE));
  assert.ok(r.model.blocks.some((b) => b.vtkCellType === VtkCellType.HEXAHEDRON));
});

test("clockwise source cells are also oriented to positive volume", () => {
  const m = model({
    pts: [[1, 0], [2, 0], [2, 1], [1, 1]],
    cells: [{ type: VtkCellType.QUAD, nodes: [1, 4, 3, 2] }],
  });
  assert.equal(volumes(revolveExpand(m, spec).model).negative, 0);
});

test("triangles: interior wedge, axis edge tetrahedron, axis vertex pyramid", () => {
  const m = model({
    pts: [[1, 0], [2, 0], [1.5, 1], [0, 0], [0, 1], [3, 0], [3, 1]],
    cells: [
      { type: VtkCellType.TRIANGLE, nodes: [1, 2, 3] }, // wedge
      { type: VtkCellType.TRIANGLE, nodes: [4, 1, 5] }, // axis edge 4-5? only 4 and 5 on axis
      { type: VtkCellType.TRIANGLE, nodes: [4, 6, 7] }, // one vertex on the axis
    ],
  });
  const r = revolveExpand(m, spec);
  const types = r.model.blocks.map((b) => b.vtkCellType).sort();
  assert.deepEqual(types, [VtkCellType.TETRA, VtkCellType.WEDGE, VtkCellType.PYRAMID].sort());
  assert.equal(volumes(r.model).negative, 0);
});

test("a radial vector field stays radial at every ring and the hoop-constant scalar is copied", () => {
  const pts = [[1, 0], [2, 0], [2, 1], [1, 1]];
  const m = model({
    pts,
    cells: [{ type: VtkCellType.QUAD, nodes: [1, 2, 3, 4] }],
    fields: [
      { kind: "Nodal", variable: "U", components: 2, ids: Int32Array.of(1, 2, 3, 4), values: Float64Array.from(pts.flatMap((p) => [p[0] * 0.1, p[1] * 0.2])) },
      { kind: "Nodal", variable: "T", components: 1, ids: Int32Array.of(1, 2, 3, 4), values: Float64Array.of(10, 20, 30, 40) },
    ],
  });
  const r = revolveExpand(m, { ...spec, layers: 12 });
  const U = r.model.fields.find((f) => f.variable === "U")!;
  const T = r.model.fields.find((f) => f.variable === "T")!;
  assert.equal(U.components, 3);
  const idx = new Map<number, number>();
  r.model.nodeIds.forEach((id, i) => idx.set(id, i));
  for (let row = 0; row < U.ids.length; row++) {
    const i = idx.get(U.ids[row])!;
    const x = r.model.coords[3 * i], z = r.model.coords[3 * i + 2];
    const rr = Math.hypot(x, z);
    const ur = (U.values[3 * row] * x + U.values[3 * row + 2] * z) / rr;
    const ut = (-U.values[3 * row] * z + U.values[3 * row + 2] * x) / rr;
    const src = r.sourceNodeId(U.ids[row]) - 1;
    assert.ok(Math.abs(ur - pts[src][0] * 0.1) < 1e-5, "radial component preserved");
    assert.ok(Math.abs(ut) < 1e-5, "no hoop component appears");
    assert.ok(Math.abs(U.values[3 * row + 1] - pts[src][1] * 0.2) < 1e-9, "axial component untouched");
    assert.equal(T.values[row], [10, 20, 30, 40][src]);
  }
  assert.equal(U.ids.length, 4 * 12);
});

test("id maps resolve copies to their source; sweeps below 360 open the solid", () => {
  const m = model({
    pts: [[1, 0], [2, 0], [2, 1], [1, 1]],
    cells: [{ type: VtkCellType.QUAD, nodes: [1, 2, 3, 4] }],
  });
  const r = revolveExpand(m, { axis: "y", startDeg: 0, sweepDeg: 90, layers: 3 });
  assert.equal(r.model.nodeCount, 4 * 4); // 3 slabs -> 4 rings
  assert.equal(r.model.blocks[0].count, 3);
  assert.equal(r.sourceNodeId(2 + 2 * r.nodeStride), 2);
  assert.equal(r.sourceEntityId(1 + 2 * r.entityStride), 1);
});

test("axis x revolves about x and keeps the axial coordinate", () => {
  const m = model({ pts: [[0, 1], [1, 1], [1, 2], [0, 2]], cells: [{ type: VtkCellType.QUAD, nodes: [1, 2, 3, 4] }] });
  const r = revolveExpand(m, { axis: "x", startDeg: 0, sweepDeg: 360, layers: 8 });
  assert.equal(volumes(r.model).negative, 0);
  for (let i = 0; i < r.model.nodeCount; i++) {
    const rr = Math.hypot(r.model.coords[3 * i + 1], r.model.coords[3 * i + 2]);
    assert.ok(Math.abs(rr - 1) < 1e-6 || Math.abs(rr - 2) < 1e-6);
  }
});

test("non-planar meshes, negative radius, bad sweeps and the size guard are refused", () => {
  const ok = { pts: [[1, 0], [2, 0], [2, 1], [1, 1]], cells: [{ type: VtkCellType.QUAD, nodes: [1, 2, 3, 4] }] };
  assert.throws(() => revolveExpand(model({ ...ok, pts: [[1, 0, 1], [2, 0, 0], [2, 1, 0], [1, 1, 0]] }), spec), /not planar/);
  assert.throws(() => revolveExpand(model({ ...ok, pts: [[-1, 0], [2, 0], [2, 1], [1, 1]] }), spec), /negative/);
  assert.throws(() => revolveExpand(model(ok), { ...spec, sweepDeg: 0 }), /sweep/);
  assert.throws(() => revolveExpand(model(ok), { ...spec, layers: 2 }), /at least 3/);
  const big = model({ ...ok });
  big.blocks[0] = { ...big.blocks[0], count: REVOLVE_MAX_CELLS, entityIds: new Int32Array(0), connectivity: new Int32Array(0) };
  assert.throws(() => revolveExpand(big, spec), /exceeds the view limit/);
});

test("unsupported cells are skipped with a diagnostic", () => {
  const m = model({
    pts: [[0, 0], [1, 0], [1, 1], [0, 1]],
    cells: [{ type: VtkCellType.QUAD, nodes: [1, 2, 3, 4] }, { type: VtkCellType.LINE, nodes: [2, 3] }],
  });
  // quad with edge 1-4 on the axis OK; line cell skipped
  const r = revolveExpand(m, spec);
  assert.ok(r.diagnostics.some((d) => /skipped 1 cell/.test(d)));
});
