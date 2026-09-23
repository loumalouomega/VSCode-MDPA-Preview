import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { applyOpAsync } from "../parser/operations";
import { remapFieldsOntoRemesh } from "../parser/remeshFields";
import { MdpaModel } from "../parser/types";

// A two-triangle planar patch with one edge-Conditions block and one field
// of each kind: a varying Nodal d, a constant Elemental E, a constant
// Conditional C. Small enough to map in microseconds, rich enough to cover
// every attach path.
const PATCH = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements

Begin Conditions LineCondition2D2N
1 0 1 2
End Conditions

Begin NodalData D
1 0 0.0
2 0 1.0
3 0 1.0
4 0 0.0
End NodalData

Begin ElementalData E
1 2.5
2 2.5
End ElementalData

Begin ConditionalData C
1 7.0
End ConditionalData
`;

const patch = (): MdpaModel => parseMdpa(PATCH);

const byKey = (m: MdpaModel): Map<string, number[]> => {
  const out = new Map<string, number[]>();
  for (const f of m.fields) out.set(`${f.kind}:${f.variable}`, [...f.values]);
  return out;
};

test("remapFieldsOntoRemesh is bit-exact on an identical mesh, every kind", async () => {
  // The property conservativeInterpolate could never give: a varying Nodal
  // field comes back resampled, not smoothed, and vertex-snapped nodes are
  // exact — so an identical mesh round-trips every value.
  const source = patch();
  const r = await remapFieldsOntoRemesh(source, source);
  assert.deepEqual(
    r.transferred.map((t) => t.name).sort(),
    ["Conditional:C", "Elemental:E", "Nodal:D"]
  );
  assert.equal(r.dropped.length, 0);
  assert.equal(r.fixedDropped, false);
  assert.equal(r.nearestFallbacks, 0);
  const got = byKey(r.model);
  assert.deepEqual(got.get("Nodal:D"), [0.0, 1.0, 1.0, 0.0]);
  assert.deepEqual(got.get("Elemental:E"), [2.5, 2.5, 2.5]);
  assert.deepEqual(got.get("Conditional:C"), [7.0]);
});

test("remapFieldsOntoRemesh is exact on an identical 3D tet mesh with a triangle condition", async () => {
  const source = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
End Conditions

Begin NodalData D
1 0 3.0
2 0 3.0
3 0 3.0
4 0 3.0
End NodalData

Begin ElementalData E
1 2.5
End ElementalData

Begin ConditionalData C
1 7.0
End ConditionalData
`);
  const r = await remapFieldsOntoRemesh(source, source);
  assert.deepEqual(
    r.transferred.map((t) => t.name).sort(),
    ["Conditional:C", "Elemental:E", "Nodal:D"]
  );
  assert.equal(r.dropped.length, 0);
  const got = byKey(r.model);
  assert.deepEqual(got.get("Nodal:D"), [3.0, 3.0, 3.0, 3.0]);
  assert.deepEqual(got.get("Elemental:E"), [2.5, 2.5]);
  assert.deepEqual(got.get("Conditional:C"), [7.0]);
});

test("remapFieldsOntoRemesh keeps Elemental and Conditional apart under a shared name", async () => {
  // Elemental P and Conditional P share one cell_data namespace on the way
  // through meshio (the second rides as "P_Conditional" there); the native
  // path never converts, so there is no suffix to invert — both come back
  // under their own kind with their own values.
  const source = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements

Begin Conditions LineCondition2D2N
1 0 1 2
End Conditions

Begin ElementalData P
1 2.0
2 2.0
End ElementalData

Begin ConditionalData P
1 9.0
End ConditionalData
`);
  const r = await remapFieldsOntoRemesh(source, source);
  assert.deepEqual(
    r.transferred.map((t) => t.name).sort(),
    ["Conditional:P", "Elemental:P"]
  );
  const got = byKey(r.model);
  // Elemental attaches across all blocks (house convention): the edge cell
  // inherits its containing volume value rather than a fabricated 0.
  assert.deepEqual(got.get("Elemental:P"), [2.0, 2.0, 2.0]);
  assert.deepEqual(got.get("Conditional:P"), [9.0]);
});

test("remapFieldsOntoRemesh drops Conditional with a reason when the target has no Conditions", async () => {
  const source = patch();
  const target: MdpaModel = {
    ...source,
    blocks: source.blocks.filter((b) => b.kind !== "Conditions"),
    fields: [],
  };
  const r = await remapFieldsOntoRemesh(target, source);
  const names = r.transferred.map((t) => t.name).sort();
  assert.ok(names.includes("Nodal:D"), names.join(","));
  assert.ok(names.includes("Elemental:E"), names.join(","));
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].name, "Conditional:C");
  assert.match(r.dropped[0].reason, /no Conditions to receive it/);
});

test("remapFieldsOntoRemesh resolves a sparse Elemental field through the nearest covered cell", async () => {
  // Only element 2 carries E: element 1 and the edge inherit element 2's
  // value (nearest covered) rather than a fabricated 0, and every output is
  // finite.
  const source = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements

Begin Conditions LineCondition2D2N
1 0 1 2
End Conditions

Begin ElementalData E
2 2.5
End ElementalData
`);
  const r = await remapFieldsOntoRemesh(source, source);
  assert.deepEqual(
    r.transferred.map((t) => t.name),
    ["Elemental:E"]
  );
  const got = byKey(r.model).get("Elemental:E")!;
  assert.equal(got.length, 3);
  assert.ok(got.every((v) => v === 2.5), got.join(","));
});

test("remapFieldsOntoRemesh passes a field-less source through untouched", async () => {
  const bare = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`);
  const r = await remapFieldsOntoRemesh(bare, bare);
  assert.equal(r.transferred.length, 0);
  assert.equal(r.dropped.length, 0);
  assert.equal(r.model, bare);
});

test("applyOpAsync remesh maps the fields and reports them (real MMG)", async () => {
  const out = await applyOpAsync(patch(), { op: "remesh", mode: "factor", factor: 0.5 });
  assert.ok(!out.noop, out.message ?? "remesh unexpectedly noop");
  assert.match(out.message ?? "", /Mapped 3 field\(s\)/);
  assert.match(out.message ?? "", /Nodal:D/);
  assert.match(out.message ?? "", /Elemental:E/);
  assert.match(out.message ?? "", /Conditional:C/);
  const names = out.model.fields.map((f) => `${f.kind}:${f.variable}`).sort();
  assert.deepEqual(names, ["Conditional:C", "Elemental:E", "Nodal:D"]);
  for (const f of out.model.fields) {
    assert.ok([...f.values].every(Number.isFinite), `${f.kind}:${f.variable} has non-finite values`);
  }
});

test("applyOpAsync remesh on a field-less mesh reports no mapping", async () => {
  const bare = parseMdpa(`Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
2 0 1 3 4
End Elements
`);
  const out = await applyOpAsync(bare, { op: "remesh", mode: "factor", factor: 0.5 });
  assert.ok(!out.noop, out.message ?? "remesh unexpectedly noop");
  assert.doesNotMatch(out.message ?? "", /Mapped/);
  assert.equal(out.model.fields.length, 0);
});

// A SURFACE source: `triWeights` used to be built from cross-product norms, so every
// weight was >= 0 by construction, `contains` accepted the first candidate of every
// bucket, and a remeshed surface's nodal field came back with weights summing to more
// than 1 (values of 3.96 from a field bounded by 1).
import { icosphere } from "./fixtures/shapes";

test("a surface source interpolates with signed weights: values stay inside the field's range and track the coordinate", async () => {
  const withZ = (m: MdpaModel): MdpaModel => ({
    ...m,
    fields: [{ kind: "Nodal", variable: "Z", components: 1, ids: m.nodeIds, values: Float64Array.from({ length: m.nodeCount }, (_, i) => m.coords[i * 3 + 2]) }],
  });
  const source = withZ(icosphere(1, 1)); // 42 coarse nodes
  const target = icosphere(1, 3); // 642 nodes, none of which lie on a coarse triangle's plane
  const r = await remapFieldsOntoRemesh({ ...target, fields: [] }, source);
  const f = r.model.fields.find((x) => x.variable === "Z")!;
  assert.equal(f.ids.length, target.nodeCount);
  let worst = 0;
  for (let i = 0; i < f.ids.length; i++) {
    assert.ok(f.values[i] >= -1.0001 && f.values[i] <= 1.0001, `value ${f.values[i]} escaped [-1, 1]`);
    worst = Math.max(worst, Math.abs(f.values[i] - target.coords[i * 3 + 2]));
  }
  assert.ok(worst < 0.25, `worst deviation from z ${worst}`);
});
