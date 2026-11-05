import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorExpand } from "../parser/render/mirrorDisplay";
import { VtkCellType } from "../parser/geometryMap";
import type { EntityBlock, FieldData, MdpaModel } from "../parser/types";

function model(opts: {
  pts: number[][];
  cells?: { type: number; nodes: number[] }[];
  fields?: FieldData[];
}): MdpaModel {
  const n = opts.pts.length;
  const coords = new Float32Array(3 * n);
  opts.pts.forEach((p, i) => coords.set(p, 3 * i));
  const blocks: EntityBlock[] = [];
  let id = 1;
  for (const c of opts.cells ?? []) {
    blocks.push({
      kind: "Elements",
      name: `B${c.type}`,
      vtkCellType: c.type,
      count: 1,
      stride: c.nodes.length,
      entityIds: Int32Array.of(id++),
      connectivity: Int32Array.from(c.nodes),
    });
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of opts.pts) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  return {
    nodeCount: n,
    nodeIds: Int32Array.from(opts.pts.map((_, i) => i + 1)),
    coords,
    blocks,
    subModelParts: [],
    meta: [],
    fields: opts.fields ?? [],
    diagnostics: [],
    is3D: true,
    bounds: { min, max },
  } as MdpaModel;
}

function tetVolume(m: MdpaModel, nodes: number[]): number {
  const idx = new Map<number, number>();
  m.nodeIds.forEach((id, i) => idx.set(id, i));
  const p = nodes.map((id) => {
    const i = idx.get(id)!;
    return [m.coords[3 * i], m.coords[3 * i + 1], m.coords[3 * i + 2]];
  });
  const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const c = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
  return (
    (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
  );
}

const X = { origin: [0, 0, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number] };
const Y = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };

test("mirror shares on-plane nodes and re-winds to positive volume", () => {
  const m = model({
    pts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    cells: [{ type: VtkCellType.TETRA, nodes: [1, 2, 3, 4] }],
  });
  assert.ok(tetVolume(m, [1, 2, 3, 4]) > 0);
  const r = mirrorExpand(m, X);
  assert.equal(r.sharedNodes, 3);
  assert.equal(r.model.nodeCount, 5);
  assert.equal(r.model.blocks.length, 2);
  assert.equal(r.model.blocks[1].name, "B10_mirror");
  const copy = Array.from(r.model.blocks[1].connectivity);
  assert.ok(tetVolume(r.model, copy) > 0, "mirrored tetrahedron must keep positive volume");
  assert.ok(Math.abs(tetVolume(r.model, copy) - tetVolume(m, [1, 2, 3, 4])) < 1e-9);
  // The reflected node sits at x = -1.
  const k = r.model.nodeIds.indexOf(2 + r.nodeOffset);
  assert.equal(r.model.coords[3 * k], -1);
});

test("hexahedron and wedge copies keep positive orientation tables consistent", () => {
  const hex = model({
    pts: [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 0, 1], [2, 0, 1], [2, 1, 1], [1, 1, 1]],
    cells: [{ type: VtkCellType.HEXAHEDRON, nodes: [1, 2, 3, 4, 5, 6, 7, 8] }],
  });
  const r = mirrorExpand(hex, X);
  const c = Array.from(r.model.blocks[1].connectivity);
  // Bottom face of the copy must run counter-clockwise seen from +z: signed area > 0.
  const at = (id: number) => {
    const i = r.model.nodeIds.indexOf(id);
    return [r.model.coords[3 * i], r.model.coords[3 * i + 1]];
  };
  const [a, b, d, e] = [at(c[0]), at(c[1]), at(c[2]), at(c[3])];
  const area = (a[0] * b[1] - b[0] * a[1] + b[0] * d[1] - d[0] * b[1] + d[0] * e[1] - e[0] * d[1] + e[0] * a[1] - a[0] * e[1]) / 2;
  assert.ok(area > 0);
});

test("vectors flip the normal component and tensors reflect as R T R", () => {
  const m = model({
    pts: [[1, 0, 0], [2, 1, 0]],
    fields: [
      { kind: "Nodal", variable: "U", components: 3, ids: Int32Array.of(1, 2), values: Float64Array.of(1, 2, 3, 4, 5, 6) },
      { kind: "Nodal", variable: "T", components: 9, ids: Int32Array.of(2), values: Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
      { kind: "Nodal", variable: "S", components: 1, ids: Int32Array.of(1, 2), values: Float64Array.of(7, 8) },
    ],
  });
  const r = mirrorExpand(m, X);
  const U = r.model.fields.find((f) => f.variable === "U")!;
  assert.equal(U.ids.length, 4);
  assert.deepEqual(Array.from(U.values.subarray(6, 9)), [-1, 2, 3]);
  assert.deepEqual(Array.from(U.values.subarray(9, 12)), [-4, 5, 6]);
  assert.deepEqual(Array.from(r.model.fields.find((f) => f.variable === "S")!.values), [7, 8, 7, 8]);
  // R = diag(-1,1,1): off-diagonal terms touching x flip sign.
  const T = r.model.fields.find((f) => f.variable === "T")!;
  assert.deepEqual(Array.from(T.values.subarray(9, 18)), [1, -2, -3, -4, 5, 6, -7, 8, 9]);
});

test("a quarter plate mirrored twice carries the symmetric displacement sign rule", () => {
  const pts = [[1, 1, 0], [2, 1, 0], [1, 2, 0], [2, 2, 0]];
  const m = model({
    pts,
    fields: [
      {
        kind: "Nodal",
        variable: "DISPLACEMENT",
        components: 3,
        ids: Int32Array.of(1, 2, 3, 4),
        values: Float64Array.from(pts.flatMap((p) => [p[0], p[1], 0])),
      },
    ],
  });
  const once = mirrorExpand(m, X).model;
  const twice = mirrorExpand(once, Y).model;
  assert.equal(twice.nodeCount, 16);
  const f = twice.fields[0];
  for (let r = 0; r < f.ids.length; r++) {
    const i = twice.nodeIds.indexOf(f.ids[r]);
    assert.ok(Math.abs(f.values[3 * r] - twice.coords[3 * i]) < 1e-6, "u_x == x for every copy");
    assert.ok(Math.abs(f.values[3 * r + 1] - twice.coords[3 * i + 1]) < 1e-6, "u_y == y for every copy");
  }
});

test("id maps resolve copies to their source", () => {
  const m = model({
    pts: [[1, 0, 0], [2, 0, 0], [1, 1, 0]],
    cells: [{ type: VtkCellType.TRIANGLE, nodes: [1, 2, 3] }],
  });
  const r = mirrorExpand(m, X);
  assert.equal(r.sourceNodeId(2 + r.nodeOffset), 2);
  assert.equal(r.sourceNodeId(2), 2);
  const copyId = r.model.blocks[1].entityIds[0];
  assert.notEqual(copyId, 1);
  assert.equal(r.sourceEntityId(copyId), 1);
});

test("unsupported cell types are copied and reported; the zero normal is refused", () => {
  const m = model({
    pts: Array.from({ length: 18 }, (_, i) => [1 + i, 0, 0] as [number, number, number]),
    cells: [{ type: VtkCellType.QUADRATIC_WEDGE_18, nodes: Array.from({ length: 18 }, (_, i) => i + 1) }],
  });
  const r = mirrorExpand(m, X);
  assert.ok(r.diagnostics.some((d) => /re-winding/.test(d)));
  assert.throws(() => mirrorExpand(m, { origin: [0, 0, 0], normal: [0, 0, 0] }), /zero vector/);
});

// VTK mid-edge tables: node index -> the two corners it bisects (face/body centres: the corners it averages).
const MID: Record<number, { corners: number; mids: number[][] }> = {
  [VtkCellType.QUADRATIC_TRIANGLE]: { corners: 3, mids: [[0, 1], [1, 2], [2, 0]] },
  [VtkCellType.QUADRATIC_QUAD]: { corners: 4, mids: [[0, 1], [1, 2], [2, 3], [3, 0]] },
  [VtkCellType.BIQUADRATIC_QUAD]: { corners: 4, mids: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 1, 2, 3]] },
  [VtkCellType.QUADRATIC_TETRA]: { corners: 4, mids: [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]] },
  [VtkCellType.QUADRATIC_HEXAHEDRON]: {
    corners: 8,
    mids: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
  },
  [VtkCellType.TRIQUADRATIC_HEXAHEDRON]: {
    corners: 8,
    mids: [
      [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
      [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7],
    ],
  },
  [VtkCellType.QUADRATIC_WEDGE]: {
    corners: 6,
    mids: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]],
  },
  [VtkCellType.QUADRATIC_PYRAMID]: {
    corners: 5,
    mids: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]],
  },
};
const REF: Record<number, [number, number, number][]> = {
  3: [[1, 0, 0], [2, 0, 0], [1, 1, 0]],
  4: [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]],
};

test("quadratic cells: mid nodes follow their edge/face after re-winding (item 24)", () => {
  const hexRef: [number, number, number][] = [
    [1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 0, 1], [2, 0, 1], [2, 1, 1], [1, 1, 1],
  ];
  const corners = (type: number, n: number): [number, number, number][] => {
    if (n === 8) return hexRef;
    if (type === VtkCellType.QUADRATIC_TETRA) return [[1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 0, 1]];
    if (type === VtkCellType.QUADRATIC_WEDGE) return [[1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 0, 1], [2, 0, 1], [1, 1, 1]];
    if (type === VtkCellType.QUADRATIC_PYRAMID) return [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1.5, 0.5, 1]];
    return REF[n];
  };
  for (const [typeStr, spec] of Object.entries(MID)) {
    const type = Number(typeStr);
    const cs = corners(type, spec.corners);
    const mids = spec.mids.map((ids) => {
      const p = [0, 0, 0];
      for (const i of ids) for (let k = 0; k < 3; k++) p[k] += cs[i][k] / ids.length;
      return p as [number, number, number];
    });
    const pts = [...cs, ...mids];
    const m = model({ pts, cells: [{ type, nodes: pts.map((_, i) => i + 1) }] });
    const r = mirrorExpand(m, X);
    assert.equal(r.diagnostics.filter((d) => /re-winding/.test(d)).length, 0, `type ${type} has a table`);
    const conn = Array.from(r.model.blocks[1].connectivity);
    const at = (id: number): number[] => {
      const i = r.model.nodeIds.indexOf(id);
      return [r.model.coords[3 * i], r.model.coords[3 * i + 1], r.model.coords[3 * i + 2]];
    };
    // Every mid node of the copy sits at the centroid of the copy's own corner nodes it belongs to.
    spec.mids.forEach((ids, j) => {
      const got = at(conn[spec.corners + j]);
      const want = [0, 0, 0];
      for (const i of ids) {
        const c = at(conn[i]);
        for (let k = 0; k < 3; k++) want[k] += c[k] / ids.length;
      }
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - want[k]) < 1e-5, `type ${type} mid ${j} axis ${k}: ${got[k]} vs ${want[k]}`);
    });
  }
});

test("SubModelParts gain mirrored copies with offset ids and rebuilt child paths (item 24)", () => {
  const m = model({
    pts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    cells: [{ type: VtkCellType.TETRA, nodes: [1, 2, 3, 4] }],
  });
  const child = {
    name: "Inner", path: "Outer/Inner", nodeIds: Int32Array.of(2), elementIds: new Int32Array(0),
    conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [],
  };
  const outer = {
    name: "Outer", path: "Outer", nodeIds: Int32Array.of(1, 2, 3, 4), elementIds: Int32Array.of(1),
    conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: Int32Array.of(7), children: [child],
  };
  m.subModelParts = [outer];
  const r = mirrorExpand(m, X);
  // Nodes 1, 3, 4 lie on x = 0 and keep their ids; node 2 gets a reflected copy.
  assert.equal(r.model.subModelParts.length, 2);
  assert.strictEqual(r.model.subModelParts[0], outer, "source part untouched");
  const copy = r.model.subModelParts[1];
  assert.equal(copy.name, "Outer_mirror");
  assert.equal(copy.path, "Outer_mirror");
  assert.deepEqual(Array.from(copy.nodeIds), [1, 2 + r.nodeOffset, 3, 4]);
  assert.deepEqual(Array.from(copy.elementIds), [1 + r.entityOffset]);
  assert.equal(copy.constraintIds.length, 0);
  assert.equal(copy.children[0].path, "Outer_mirror/Inner_mirror");
  assert.deepEqual(Array.from(copy.children[0].nodeIds), [2 + r.nodeOffset]);
  assert.deepEqual(Array.from(outer.nodeIds), [1, 2, 3, 4], "source ids not mutated");
});
