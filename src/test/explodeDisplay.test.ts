import { test } from "node:test";
import assert from "node:assert";
import { explodeExpand } from "../parser/render/explodeDisplay";
import { MdpaModel, SubModelPart } from "../parser/types";
import { VtkCellType } from "../parser/geometryMap";

// Three unit squares in a row sharing edges: A [0,1], B [1,2], C [2,3] on x, y in [0,1].
function strip(): MdpaModel {
  const pts: number[][] = [];
  for (let i = 0; i <= 3; i++) pts.push([i, 0, 0], [i, 1, 0]);
  const coords = new Float32Array(pts.flat());
  const nodeIds = Int32Array.from(pts.map((_, i) => i + 1));
  const conn: number[] = [];
  for (let c = 0; c < 3; c++) conn.push(2 * c + 1, 2 * c + 3, 2 * c + 4, 2 * c + 2);
  const part = (name: string, el: number): SubModelPart => ({
    name, path: name, nodeIds: new Int32Array(0), elementIds: Int32Array.from([el]),
    conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [],
  });
  return {
    nodeCount: pts.length, nodeIds, coords,
    blocks: [{ kind: "Elements", name: "Q", vtkCellType: VtkCellType.QUAD, count: 3, stride: 4,
      entityIds: Int32Array.from([1, 2, 3]), propertyIds: new Int32Array(3), connectivity: Int32Array.from(conn) }],
    subModelParts: [part("A", 1), part("B", 2), part("C", 3)],
    meta: [], diagnostics: [], is3D: false,
    fields: [{ kind: "Nodal", variable: "T", components: 1, ids: nodeIds.slice(), values: Float64Array.from(pts.map((p) => p[0])) }],
    bounds: { min: [0, 0, 0], max: [3, 1, 0] },
  };
}
const boxOfPart = (m: MdpaModel, el: number) => {
  const b = m.blocks[0];
  const c = Array.from(b.entityIds).indexOf(el);
  const xs: number[] = [];
  for (let k = 0; k < 4; k++) {
    const id = b.connectivity[c * 4 + k];
    xs.push(m.coords[3 * Array.from(m.nodeIds).indexOf(id)]);
  }
  return [Math.min(...xs), Math.max(...xs)];
};

test("factor 0 returns the model unchanged", () => {
  const m = strip();
  assert.strictEqual(explodeExpand(m, { factor: 0 }).model, m);
});

test("factor 1 separates every part and leaves the host model alone", () => {
  const m = strip();
  const before = Float32Array.from(m.coords);
  const r = explodeExpand(m, { factor: 1 });
  const [a, b, c] = [1, 2, 3].map((e) => boxOfPart(r.model, e));
  assert.ok(a[1] < b[0] && b[1] < c[0], `${a} ${b} ${c}`);
  assert.deepStrictEqual(Array.from(m.coords), Array.from(before));
  assert.strictEqual(m.nodeCount, 8);
  assert.ok(r.model.nodeCount > 8, "shared nodes are duplicated in the render copy");
});

test("entity ids are unchanged and duplicated nodes map back to their source", () => {
  const r = explodeExpand(strip(), { factor: 1 });
  assert.deepStrictEqual(Array.from(r.model.blocks[0].entityIds), [1, 2, 3]);
  for (const id of r.model.nodeIds) assert.ok(r.sourceNodeId(id) >= 1 && r.sourceNodeId(id) <= 8);
});

test("nodal field rows follow the duplicated nodes", () => {
  const r = explodeExpand(strip(), { factor: 1 });
  const f = r.model.fields[0];
  assert.strictEqual(f.ids.length, r.model.nodeCount);
  for (let i = 0; i < f.ids.length; i++) {
    const src = r.sourceNodeId(f.ids[i]);
    assert.strictEqual(f.values[i], Math.floor((src - 1) / 2));
  }
});

test("an axis restriction moves parts along that axis only", () => {
  const r = explodeExpand(strip(), { factor: 1, axis: "x" });
  const ys = Array.from({ length: r.model.nodeCount }, (_, i) => r.model.coords[3 * i + 1]);
  assert.deepStrictEqual([Math.min(...ys), Math.max(...ys)], [0, 1]);
});

test("a mesh without SubModelParts is returned unchanged with a note", () => {
  const m = { ...strip(), subModelParts: [] };
  const r = explodeExpand(m, { factor: 1 });
  assert.strictEqual(r.model, m);
  assert.ok(r.diagnostics.length > 0);
});
