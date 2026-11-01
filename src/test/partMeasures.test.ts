import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { computePartMeasures, formatMeasure, measureKey } from "../parser/partMeasures";

const SRC = `Begin Nodes
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
5 1 1 1
End Nodes
Begin Elements Element3D4N
1 1 1 2 3 4
2 1 2 3 4 5
End Elements
Begin Conditions SurfaceCondition3D3N
1 1 1 2 3
End Conditions
Begin SubModelPart Outer
  Begin SubModelPartElements
  1
  End SubModelPartElements
  Begin SubModelPart Inner
    Begin SubModelPartElements
    1
    2
    End SubModelPartElements
  End SubModelPart
End SubModelPart
Begin SubModelPart Skin
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

test("whole-model volume, boundary area and per-part measures (no double counting)", () => {
  const m = parseMdpa(SRC);
  const r = computePartMeasures(m);
  assert.equal(r.total?.dimension, 3);
  assert.ok(Math.abs(r.total!.value - (1 / 6 + vol2())) < 1e-9);
  assert.equal(r.boundary?.dimension, 2);
  assert.ok(Math.abs(r.boundary!.value - 0.5) < 1e-9);
  assert.ok(Math.abs(r.parts["Skin"]!.value - 0.5) < 1e-9);
  assert.equal(r.parts["Skin"]!.dimension, 2);
  // Outer's subtree is the union of elements 1 and 2 — element 1 appears twice but counts once.
  assert.ok(Math.abs(r.parts["Outer"]!.value - r.total!.value) < 1e-9);
  const innerPath = Object.keys(r.parts).find((k) => k.endsWith("Inner"))!;
  assert.ok(Math.abs(r.parts[innerPath]!.value - r.total!.value) < 1e-9);
});

function vol2(): number {
  // tet (2,3,4,5): |det| / 6
  const a = [1, 0, 0], b = [0, 1, 0], c = [0, 0, 1], d = [1, 1, 1];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  return Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
}

test("measureKey changes with the geometry and formatMeasure labels the dimension", () => {
  const m = parseMdpa(SRC);
  const k = measureKey(m);
  assert.equal(measureKey(parseMdpa(SRC)), k);
  assert.notEqual(measureKey(parseMdpa(SRC.replace("5 1 1 1", "5 2 2 2"))), k);
  assert.match(formatMeasure({ value: 0.5, dimension: 2 }), /²/);
  assert.match(formatMeasure({ value: 2, dimension: 3 }), /³/);
});

// --- revolved measures (roadmap item 44) ------------------------------------------

// A 2 x 3 rectangle in the xy plane: radius R = 2 along x, height H = 3 along y, axis y at x = 0.
const RECT = `Begin Nodes
1 0 0 0
2 2 0 0
3 2 3 0
4 0 3 0
End Nodes
Begin Elements Element2D3N
1 1 1 2 3
2 1 1 3 4
End Elements
Begin Conditions LineCondition2D2N
1 1 2 3
End Conditions
Begin SubModelPart Wall
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart
`;

test("a rectangle revolved about y measures pi R^2 H, and its outer edge 2 pi R H", () => {
  const model = parseMdpa(RECT);
  const plain = computePartMeasures(model);
  assert.equal(plain.total!.dimension, 2);
  assert.ok(Math.abs(plain.total!.value - 6) < 1e-9);
  assert.equal(plain.revolvedAbout, undefined);
  const r = computePartMeasures(model, { revolveAbout: "y" });
  assert.equal(r.revolvedAbout, "y");
  assert.equal(r.total!.dimension, 3);
  assert.ok(Math.abs(r.total!.value - Math.PI * 4 * 3) < 1e-9);
  assert.equal(r.parts.Wall!.dimension, 2);
  assert.ok(Math.abs(r.parts.Wall!.value - 2 * Math.PI * 2 * 3) < 1e-9);
});

test("revolving about x uses |y| as the radius", () => {
  const r = computePartMeasures(parseMdpa(RECT), { revolveAbout: "x" });
  assert.ok(Math.abs(r.total!.value - Math.PI * 9 * 2) < 1e-9);
});

test("revolved measures refuse a 3D mesh and an unsupported axis", () => {
  assert.throws(() => computePartMeasures(parseMdpa(SRC), { revolveAbout: "y" }), /planar/);
  assert.throws(() => computePartMeasures(parseMdpa(RECT), { revolveAbout: "z" as "x" }), /in-plane axis/);
});
