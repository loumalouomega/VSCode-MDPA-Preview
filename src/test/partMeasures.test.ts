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
