/**
 * Derived meshes — slice, isosurface, threshold region — over the real WASM and
 * against analytic fields: a slice of a linear field interpolates exactly, the
 * isosurface of x lies in the plane x = c, a threshold keeps the original ids,
 * parts and Conditions, and every derived cell can name the cell it came from.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { applyOp } from "../parser/operations";
import { deriveMesh } from "../parser/deriveMesh";
import { restrictToElements, elementMeasures } from "../parser/selectCells";
import { MdpaModel } from "../parser/types";

const parse = (text: string): MdpaModel => {
  const r = parseMdpa(text) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/**
 * An n x 1 x 1 bar of unit cubes as tetrahedra (6 per cube), with a nodal T = x,
 * an elemental C = 100 + element id, a Conditions block on the x = 0 face, a
 * part per half, a constraint tying the two end nodes, and Properties.
 */
function bar(n: number): MdpaModel {
  const nodes: string[] = [];
  const at = (i: number, j: number, k: number): number => i * 4 + j * 2 + k + 1;
  for (let i = 0; i <= n; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) nodes.push(`${at(i, j, k)} ${i} ${j} ${k}`);
  const hexes: string[] = [];
  for (let i = 0; i < n; i++) {
    hexes.push(`${i + 1} 1 ${at(i, 0, 0)} ${at(i + 1, 0, 0)} ${at(i + 1, 1, 0)} ${at(i, 1, 0)} ${at(i, 0, 1)} ${at(i + 1, 0, 1)} ${at(i + 1, 1, 1)} ${at(i, 1, 1)}`);
  }
  const src =
    "Begin Properties 1\nEnd Properties\nBegin Nodes\n" + nodes.join("\n") + "\nEnd Nodes\n" +
    "Begin Elements Element3D8N\n" + hexes.join("\n") + "\nEnd Elements\n" +
    "Begin Conditions SurfaceCondition3D4N\n900 1 1 2 4 3\nEnd Conditions\n" +
    "Begin NodalData T\n" + nodes.map((s) => { const [id, x] = s.split(" "); return `${id} 0 ${x}`; }).join("\n") + "\nEnd NodalData\n";
  const tets = applyOp(parse(src), { op: "simplexify" }).model;
  const elemental = {
    kind: "Elemental" as const,
    variable: "C",
    components: 1,
    ids: Int32Array.from(tets.blocks.find((b) => b.kind === "Elements")!.entityIds),
    values: Float64Array.from(tets.blocks.find((b) => b.kind === "Elements")!.entityIds, (id) => 100 + id),
  };
  const first = [...tets.blocks.find((b) => b.kind === "Elements")!.entityIds].slice(0, 6 * Math.floor(n / 2));
  const last = [...tets.blocks.find((b) => b.kind === "Elements")!.entityIds].slice(6 * Math.floor(n / 2));
  return {
    ...tets,
    fields: [...tets.fields, elemental],
    subModelParts: [
      { name: "Left", path: "Left", nodeIds: Int32Array.from([1, 2, 3, 4]), elementIds: Int32Array.from(first), conditionIds: Int32Array.from([900]), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
      { name: "Right", path: "Right", nodeIds: Int32Array.from([at(n, 0, 0), at(n, 1, 1)]), elementIds: Int32Array.from(last), conditionIds: new Int32Array(0), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] },
    ],
  };
}

const field = (m: MdpaModel, kind: string, name: string) => m.fields.find((f) => f.kind === kind && f.variable === name);

test("a slice of a linear field interpolates it exactly, and every cell names the cell it was cut from", async () => {
  const m = bar(4);
  const r = await deriveMesh(m, { kind: "slice", origin: [1.5, 0, 0], normal: [1, 0, 0] });
  // Every point of the cut lies in the plane x = 1.5, and T = x there.
  for (let i = 0; i < r.model.nodeCount; i++) assert.ok(Math.abs(r.model.coords[i * 3] - 1.5) < 1e-6);
  const t = field(r.model, "Nodal", "T")!;
  for (const v of t.values) assert.ok(Math.abs(v - 1.5) < 1e-6, `T = ${v}`);
  // Provenance: SOURCE_ENTITY_ID is a real element id, of the Elements kind, and the plane really crosses that cell.
  const srcId = field(r.model, "Elemental", "SOURCE_ENTITY_ID")!;
  const srcKind = field(r.model, "Elemental", "SOURCE_ENTITY_KIND")!;
  const ids = new Set(m.blocks.find((b) => b.kind === "Elements")!.entityIds);
  assert.equal(srcId.ids.length, r.model.blocks.reduce((s, b) => s + b.count, 0));
  for (let i = 0; i < srcId.values.length; i++) {
    assert.ok(ids.has(srcId.values[i]));
    assert.equal(srcKind.values[i], 0);
  }
  // The elemental field rode along from each parent (C = 100 + parent id).
  const c = field(r.model, "Elemental", "C")!;
  for (let i = 0; i < c.values.length; i++) {
    const k = srcId.ids.indexOf(c.ids[i]);
    assert.equal(c.values[i], 100 + srcId.values[k]);
  }
  assert.ok(!r.model.fields.some((f) => f.variable.includes(":") || f.variable === "slice_parent_cell"));
  assert.match(r.summary, /Slice through/);
  // The source mesh is untouched.
  assert.equal(m.blocks.find((b) => b.kind === "Elements")!.count, 24);
});

test("an isosurface of x lies in the plane, carries ISO_VALUE and the index of each value", async () => {
  const m = bar(4);
  const r = await deriveMesh(m, { kind: "isosurface", variable: "T", values: [1.25, 2.75] });
  const xs = new Set<number>();
  for (let i = 0; i < r.model.nodeCount; i++) xs.add(+r.model.coords[i * 3].toFixed(4));
  assert.deepEqual([...xs].sort(), [1.25, 2.75]);
  const v = field(r.model, "Elemental", "ISO_VALUE")!;
  const idx = field(r.model, "Elemental", "ISO_INDEX")!;
  assert.deepEqual([...new Set(v.values)].sort(), [1.25, 2.75]);
  assert.deepEqual([...new Set(idx.values)].sort(), [0, 1]);
  assert.ok(field(r.model, "Elemental", "SOURCE_ENTITY_ID"));
});

test("an isosurface needs a nodal field that actually crosses the value", async () => {
  const m = bar(2);
  await assert.rejects(deriveMesh(m, { kind: "isosurface", variable: "C", values: [1] }), /piecewise constant.*Average field/);
  await assert.rejects(deriveMesh(m, { kind: "isosurface", variable: "NOPE", values: [1] }), /No nodal field/);
  await assert.rejects(deriveMesh(m, { kind: "isosurface", variable: "T", values: [99] }), /never crosses/);
  await assert.rejects(deriveMesh(m, { kind: "isosurface", variable: "T", values: [] }), /at least one/);
  await assert.rejects(deriveMesh(m, { kind: "slice", origin: [0, 0, 0], normal: [0, 0, 0] }), /zero vector/);
  await assert.rejects(deriveMesh(m, { kind: "slice", origin: [50, 0, 0], normal: [1, 0, 0] }), /does not cut/);
});

test("a threshold region keeps original ids, fields, parts and the Conditions still on it", async () => {
  const m = bar(4);
  const r = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [0, 2] });
  const els = r.model.blocks.find((b) => b.kind === "Elements")!;
  const srcEls = m.blocks.find((b) => b.kind === "Elements")!;
  assert.equal(els.count, 12, "the cubes at x in [0,2]");
  for (const id of els.entityIds) assert.ok(srcEls.entityIds.includes(id), "original element ids kept");
  // Fields ride along, restricted; ids untouched.
  assert.ok(field(r.model, "Elemental", "C")!.ids.every((id) => els.entityIds.includes(id)));
  assert.ok(Math.max(...field(r.model, "Nodal", "T")!.values) <= 2);
  // The x = 0 condition lies on the region, so it survives; parts are narrowed.
  assert.deepEqual([...r.model.blocks.find((b) => b.kind === "Conditions")!.entityIds], [900]);
  assert.deepEqual(r.model.subModelParts.map((p) => p.name).sort(), ["Left", "Right"]);
  assert.equal(r.model.subModelParts.find((p) => p.name === "Right")!.elementIds.length, 0);
  assert.match(r.summary, /12 of 24 element\(s\) — 50\.0% of the volume/);
  // A window that keeps the far end drops the x = 0 condition, which lies outside it.
  const far = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [3, 4] });
  assert.equal(far.model.blocks.some((b) => b.kind === "Conditions"), false);
});

test("threshold rules and cell fields: 'any' widens the nodal selection; an elemental field tests the cell's own value", async () => {
  const m = bar(4);
  const all = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [1.5, 2.5], rule: "all" }).catch(() => undefined);
  const any = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [1.5, 2.5], rule: "any" });
  const count = (r?: { model: MdpaModel }) => r?.model.blocks.find((b) => b.kind === "Elements")?.count ?? 0;
  assert.ok(count(any) > count(all));
  const ids = [...m.blocks.find((b) => b.kind === "Elements")!.entityIds].sort((a, b) => a - b);
  const cell = await deriveMesh(m, { kind: "threshold", variable: "C", fieldKind: "Elemental", range: [100 + ids[0], 100 + ids[5]] });
  assert.equal(count(cell), 6);
});

test("normalized ranges need an explicit reference; 'frame' is opt-in and says so", async () => {
  const m = bar(4);
  const fixed = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", normalized: { range: [0, 0.5], reference: [0, 4] } });
  const abs = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [0, 2] });
  assert.equal(fixed.model.blocks.find((b) => b.kind === "Elements")!.count, abs.model.blocks.find((b) => b.kind === "Elements")!.count);
  assert.match(fixed.summary, /fixed reference \[0, 4\]/);
  const frame = await deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", normalized: { range: [0, 0.5], reference: "frame" } });
  assert.match(frame.summary, /THIS frame's own range/);
  await assert.rejects(deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal" }), /either an absolute/);
  await assert.rejects(deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [0, 1], normalized: { range: [0, 1], reference: [0, 4] } }), /either an absolute/);
  await assert.rejects(deriveMesh(m, { kind: "threshold", variable: "T", fieldKind: "Nodal", normalized: { range: [0, 1], reference: [4, 4] } }), /hi > lo/);
});

test("a threshold can return the region's boundary surface instead", async () => {
  const r = await deriveMesh(bar(4), { kind: "threshold", variable: "T", fieldKind: "Nodal", range: [0, 2], output: "skin" });
  assert.ok(r.model.blocks.every((b) => b.vtkCellType === 5 || b.vtkCellType === 9), "triangles/quads only");
  assert.match(r.summary, /Boundary surface of that region: \d+ face/);
  assert.equal(r.suffix, "threshold_skin");
});

test("a constraint reaching outside the selected region is dropped and counted", async () => {
  const m = bar(4);
  // Node 1 is on the x = 0 end, node 20 on the x = 4 end.
  const cText =
    "Begin Nodes\n" + Array.from({ length: 20 }, (_, i) => `${i + 1} 0 0 0`).join("\n") + "\nEnd Nodes\n" +
    "Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X\n1 0.0 [1.0] 1 20\nEnd Constraints\n";
  const withConstraint: MdpaModel = { ...m, constraints: parse(cText).constraints };
  assert.equal(withConstraint.constraints!.length, 1);
  const r = restrictToElements(withConstraint, new Set(m.blocks.find((b) => b.kind === "Elements")!.entityIds.slice(0, 6)));
  assert.equal(r.droppedConstraints, 1);
  const { measure, dimension } = elementMeasures(m);
  assert.equal(dimension, 3);
  assert.ok(Math.abs([...measure.values()].reduce((a, b) => a + b, 0) - 4) < 1e-9, "four unit cubes");
});
