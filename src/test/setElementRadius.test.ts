/**
 * The setElementRadius operation (issue #63).
 *
 * Pure — no wasm. The behaviours pinned here are the ones that make the op
 * usable on the file that motivated it: a particle mesh with NO radius at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setElementRadius } from "../parser/setElementRadius";
import { radiusField } from "../parser/sphereElements";
import { EntityBlock, MdpaModel, SubModelPart } from "../parser/types";

function emptyPart(name: string, elementIds: number[]): SubModelPart {
  return {
    name,
    path: name,
    nodeIds: new Int32Array(0),
    elementIds: Int32Array.from(elementIds),
    conditionIds: new Int32Array(0),
    geometryIds: new Int32Array(0),
    constraintIds: new Int32Array(0),
    children: [],
  };
}

/** n particles (ids 1..n) plus, optionally, one triangle (id n+1). */
function model(n: number, opts: { triangle?: boolean; parts?: SubModelPart[] } = {}): MdpaModel {
  const ids = Int32Array.from({ length: n }, (_, i) => i + 1);
  const blocks: EntityBlock[] = [
    {
      kind: "Elements",
      name: "vertex",
      vtkCellType: 1,
      count: n,
      stride: 1,
      entityIds: ids,
      connectivity: Int32Array.from(ids),
    },
  ];
  if (opts.triangle) {
    blocks.push({
      kind: "Elements",
      name: "triangle",
      vtkCellType: 5,
      count: 1,
      stride: 3,
      entityIds: Int32Array.from([n + 1]),
      connectivity: Int32Array.from([1, 2, 3]),
    });
  }
  const coords: number[] = [];
  for (let i = 0; i < n; i++) coords.push(i, 0, 0);
  return {
    nodeCount: n,
    nodeIds: ids,
    coords: Float32Array.from(coords),
    blocks,
    subModelParts: opts.parts ?? [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: false,
    bounds: { min: [0, 0, 0], max: [Math.max(0, n - 1), 0, 0] },
  };
}

function radii(m: MdpaModel): Record<number, number> {
  const f = radiusField(m);
  if (!f) return {};
  const out: Record<number, number> = {};
  for (let i = 0; i < f.ids.length; i++) out[f.ids[i]] = f.values[i];
  return out;
}

test("absolute creates the RADIUS field when the mesh has none", () => {
  // The case that matters: the file from #63 declares no Exodus attribute.
  const before = model(3);
  const r = setElementRadius(before, 0.25, "absolute");
  assert.equal(r.changed, 3);
  assert.equal(r.created, true);
  assert.deepEqual(radii(r.model), { 1: 0.25, 2: 0.25, 3: 0.25 });
  const f = radiusField(r.model)!;
  assert.equal(f.kind, "Elemental");
  assert.equal(f.components, 1);
});

test("multiply scales existing radii and preserves their variation", () => {
  const base = setElementRadius(model(3), 0.5, "absolute").model;
  base.fields[0].values[2] = 0.25; // make one particle differ
  const r = setElementRadius(base, 2, "multiply");
  assert.equal(r.changed, 3);
  assert.equal(r.created, false);
  assert.deepEqual(radii(r.model), { 1: 1, 2: 1, 3: 0.5 });
});

test("multiply is a noop when there is no RADIUS to scale", () => {
  // Defaulting a base would silently flatten every particle to one size.
  const r = setElementRadius(model(3), 2, "multiply");
  assert.equal(r.changed, 0);
  assert.equal(radiusField(r.model), undefined);
});

test("a target scopes the change to one SubModelPart", () => {
  const m = model(4, { parts: [emptyPart("bulk", [1, 2]), emptyPart("skin", [3, 4])] });
  const all = setElementRadius(m, 0.5, "absolute").model;
  const r = setElementRadius(all, 0.1, "absolute", "skin");
  assert.equal(r.changed, 2);
  assert.deepEqual(radii(r.model), { 1: 0.5, 2: 0.5, 3: 0.1, 4: 0.1 });
});

test("a target reaches a part's descendants", () => {
  const parent = emptyPart("outer", [1]);
  parent.children = [emptyPart("inner", [2])];
  const m = model(3, { parts: [parent] });
  const r = setElementRadius(m, 0.5, "absolute", "outer");
  assert.equal(r.changed, 2);
  assert.deepEqual(radii(r.model), { 1: 0.5, 2: 0.5 });
});

test("an unknown target changes nothing rather than everything", () => {
  const r = setElementRadius(model(3), 0.5, "absolute", "nope");
  assert.equal(r.changed, 0);
  assert.equal(radiusField(r.model), undefined);
});

test("non-sphere elements are never given a radius", () => {
  const r = setElementRadius(model(2, { triangle: true }), 0.5, "absolute");
  assert.equal(r.changed, 2);
  assert.deepEqual(Object.keys(radii(r.model)), ["1", "2"]); // not the triangle (id 3)
});

test("a mesh with no one-node cells is a noop", () => {
  const m = model(0, { triangle: true });
  assert.equal(setElementRadius(m, 0.5, "absolute").changed, 0);
});

test("a non-positive or non-finite radius is rejected", () => {
  for (const v of [0, -1, NaN, Infinity]) {
    assert.equal(setElementRadius(model(3), v, "absolute").changed, 0, `value ${v}`);
  }
});

test("the input model is never mutated", () => {
  const before = model(3);
  const snapshot = JSON.stringify(before.fields);
  const r = setElementRadius(before, 0.5, "absolute");
  assert.notEqual(r.model, before);
  assert.equal(JSON.stringify(before.fields), snapshot);
});

test("applying twice replaces rather than duplicates the field", () => {
  const once = setElementRadius(model(3), 0.5, "absolute").model;
  const twice = setElementRadius(once, 0.9, "absolute").model;
  assert.equal(twice.fields.filter((f) => f.variable === "RADIUS").length, 1);
  assert.deepEqual(radii(twice), { 1: 0.9, 2: 0.9, 3: 0.9 });
});
