import { test } from "node:test";
import assert from "node:assert/strict";
import { angleAt, clipFromPlane, planeFromClip, polylineLength, projectedRange } from "../parser/render/widgetMath";
import { defaultPaneClipState } from "../parser/paneView";

const box = { min: [0, 0, 0] as [number, number, number], max: [2, 4, 6] as [number, number, number] };
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

test("projected range of an axis normal is the box extent on that axis", () => {
  assert.deepEqual(projectedRange(box, [0, 1, 0]), [0, 4]);
  assert.deepEqual(projectedRange(box, [0, -1, 0]), [-4, 0]);
});
test("axis clip round-trips through the widget plane", () => {
  const clip = { ...defaultPaneClipState(), axis: 1 as const, flipped: true, t: 0.25 };
  const plane = planeFromClip(clip, box);
  assert.deepEqual(plane.normal, [-0, -1, -0]);
  assert.equal(plane.origin[1], 1);
  const back = clipFromPlane(plane, box, defaultPaneClipState());
  assert.equal(back.axis, 1);
  assert.equal(back.flipped, true);
  assert.ok(near(back.t, 0.25));
});
test("free clip round-trips and a near-axis drag snaps to the preset", () => {
  const clip = { ...defaultPaneClipState(), axis: "free" as const, freeNormal: [1, 1, 0] as [number, number, number], t: 0.6 };
  const plane = planeFromClip(clip, box);
  const back = clipFromPlane(plane, box, defaultPaneClipState());
  assert.equal(back.axis, "free");
  assert.ok(near(back.t, 0.6));
  const snapped = clipFromPlane({ origin: [1, 0, 0], normal: [0.9999, 0.01, 0] }, box, defaultPaneClipState());
  assert.equal(snapped.axis, 0);
  assert.ok(near(snapped.t, 0.5));
});
test("a handle dragged outside the model parks on its face; zero normal keeps state", () => {
  const out = clipFromPlane({ origin: [0, 99, 0], normal: [0, 1, 0] }, box, defaultPaneClipState());
  assert.equal(out.t, 1);
  const prev = { ...defaultPaneClipState(), axis: 2 as const, t: 0.3 };
  const kept = clipFromPlane({ origin: [0, 0, 0], normal: [0, 0, 0] }, box, prev);
  assert.equal(kept.axis, 2);
  assert.equal(kept.t, 0.3);
});
test("angle and polyline measures", () => {
  assert.ok(near(angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0]), 90));
  assert.ok(near(angleAt([1, 0, 0], [0, 0, 0], [-1, 0, 0]), 180));
  assert.equal(angleAt([0, 0, 0], [0, 0, 0], [1, 0, 0]), 0);
  assert.ok(near(polylineLength([[0, 0, 0], [3, 4, 0], [3, 4, 12]]), 17));
  assert.equal(polylineLength([[1, 1, 1]]), 0);
});
