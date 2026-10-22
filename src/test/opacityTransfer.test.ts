import { test } from "node:test";
import assert from "node:assert/strict";
import { insertOpacityPoint, normalizeOpacityPoints, opacityToData, OPACITY_PRESETS, removeOpacityPoint } from "../parser/render/opacityTransfer";

test("normalising clamps, sorts, pins the ends and collapses repeats", () => {
  const n = normalizeOpacityPoints([{ x: 0.6, a: 2 }, { x: -1, a: 0.2 }, { x: 0.6004, a: 0.5 }, { x: 0.9, a: NaN }]);
  assert.deepEqual(n, [{ x: 0, a: 0.2 }, { x: 0.6, a: 0.5 }, { x: 1, a: 0 }]);
});
test("fewer than two points fall back to the default ramp", () => {
  assert.deepEqual(normalizeOpacityPoints([{ x: 0.5, a: 1 }]), OPACITY_PRESETS[0].points);
  assert.deepEqual(normalizeOpacityPoints([]), OPACITY_PRESETS[0].points);
});
test("data-unit mapping spans the scalar range; a flat range does not divide by zero", () => {
  assert.deepEqual(opacityToData([{ x: 0, a: 0 }, { x: 1, a: 1 }], [10, 20]), [10, 0, 20, 1]);
  assert.deepEqual(opacityToData([{ x: 0, a: 0 }, { x: 1, a: 1 }], [5, 5]), [5, 0, 6, 1]);
});
test("insert and remove keep the ends", () => {
  const ramp = OPACITY_PRESETS[0].points;
  const three = insertOpacityPoint(ramp, 0.5, 0.9);
  assert.equal(three.length, 3);
  assert.equal(removeOpacityPoint(three, 1).length, 2);
  assert.equal(removeOpacityPoint(three, 0).length, 3);
  assert.equal(removeOpacityPoint(three, 2).length, 3);
});
test("every preset is already a valid curve", () => {
  for (const p of OPACITY_PRESETS) assert.deepEqual(normalizeOpacityPoints(p.points), p.points, p.id);
});
