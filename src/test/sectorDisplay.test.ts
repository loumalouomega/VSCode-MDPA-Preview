import { test } from "node:test";
import assert from "node:assert/strict";
import { sectorExpand } from "../parser/render/sectorDisplay";
import { VtkCellType } from "../parser/geometryMap";
import type { MdpaModel } from "../parser/types";

function sector(): MdpaModel {
  // One triangle-prism-like tet in a 90 degree sector about z, one node on the axis.
  const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const coords = new Float32Array(pts.flat());
  return {
    nodeCount: 4, nodeIds: Int32Array.of(1, 2, 3, 4), coords,
    blocks: [{ kind: "Elements", name: "T", vtkCellType: VtkCellType.TETRA, count: 1, stride: 4, entityIds: Int32Array.of(1), connectivity: Int32Array.of(1, 2, 3, 4) }],
    subModelParts: [], meta: [],
    fields: [
      { kind: "Nodal", variable: "U", components: 3, ids: Int32Array.of(1, 2, 3, 4), values: Float64Array.from([0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      { kind: "Nodal", variable: "S", components: 1, ids: Int32Array.of(1, 2, 3, 4), values: Float64Array.of(1, 2, 3, 4) },
    ],
    diagnostics: [], is3D: true, bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  } as MdpaModel;
}

test("four copies about z share the axis nodes, rotate coordinates and keep orientation", () => {
  const r = sectorExpand(sector(), { axis: "z", copies: 4 });
  assert.equal(r.axisNodes, 2);
  assert.equal(r.model.nodeCount, 4 + 3 * 2);
  assert.equal(r.model.blocks.length, 4);
  const idx = new Map<number, number>();
  r.model.nodeIds.forEach((id, i) => idx.set(id, i));
  const nodeAt = (id: number) => { const i = idx.get(id)!; return [r.model.coords[3 * i], r.model.coords[3 * i + 1], r.model.coords[3 * i + 2]]; };
  const p = nodeAt(2 + r.nodeStride); // node 2 (1,0,0) rotated 90 degrees -> (0,1,0)
  assert.ok(Math.abs(p[0]) < 1e-6 && Math.abs(p[1] - 1) < 1e-6);
  // Rotation keeps the signed tet volume.
  const vol = (conn: Int32Array) => {
    const [a, b, c, d] = Array.from(conn).map(nodeAt);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  for (const bl of r.model.blocks) assert.ok(vol(bl.connectivity) > 0);
});

test("vectors rotate with the copy, scalars are copied, ids map back", () => {
  const r = sectorExpand(sector(), { axis: "z", copies: 4 });
  const U = r.model.fields.find((f) => f.variable === "U")!;
  const row = Array.from(U.ids).indexOf(2 + r.nodeStride);
  // Source U at node 2 is (1,0,0); after a 90 degree rotation about z -> (0,1,0).
  assert.ok(Math.abs(U.values[3 * row]) < 1e-9 && Math.abs(U.values[3 * row + 1] - 1) < 1e-9);
  const S = r.model.fields.find((f) => f.variable === "S")!;
  assert.equal(S.values[Array.from(S.ids).indexOf(2 + 2 * r.nodeStride)], 2);
  assert.equal(r.sourceNodeId(2 + 3 * r.nodeStride), 2);
  assert.equal(r.sourceEntityId(1 + 3 * r.entityStride), 1);
});

test("bad copy counts and the size guard are refused", () => {
  assert.throws(() => sectorExpand(sector(), { axis: "z", copies: 1 }), /between 2/);
  assert.throws(() => sectorExpand(sector(), { axis: "z", copies: 4, angleDeg: 0 }), /non-zero/);
});
