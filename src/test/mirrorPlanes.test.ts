import { test } from "node:test";
import assert from "node:assert/strict";
import { MIRROR_PLANES, mirrorPlaneAt, parseMirrorAction } from "../parser/render/mirrorPlanes";
import { serializeViewState, validateViewState } from "../parser/viewState";

test("the plane list covers every axis and side except the original x-min row", () => {
  assert.equal(MIRROR_PLANES.length, 8);
  assert.ok(!MIRROR_PLANES.some((p) => p.action === "mirror:x:min"));
  assert.ok(MIRROR_PLANES.some((p) => p.action === "mirror:z:center"));
  assert.equal(new Set(MIRROR_PLANES.map((p) => p.action)).size, 8);
});

test("parseMirrorAction accepts only mirror:<axis>:<side>", () => {
  assert.deepEqual(parseMirrorAction("mirror:y:max"), { axis: 1, side: "max" });
  assert.deepEqual(parseMirrorAction("mirror:z:center"), { axis: 2, side: "center" });
  for (const bad of ["mirror", "mirror:w:min", "mirror:x:top", "layout:1x1", undefined]) assert.equal(parseMirrorAction(bad), undefined);
});

test("min and max stay symbolic, the centre resolves to the bounding-box midpoint", () => {
  const b = { min: [0, -2, 10], max: [4, 6, 20] };
  assert.equal(mirrorPlaneAt("min", 1, b), "min");
  assert.equal(mirrorPlaneAt("max", 0, b), "max");
  assert.equal(mirrorPlaneAt("center", 1, b), 2);
  assert.equal(mirrorPlaneAt("center", 2, b), 15);
});

test("a z-max mirror and a numeric centre survive the view sidecar", () => {
  for (const mirror of [{ axis: 2 as const, at: "max" as const }, { axis: 1 as const, at: 2.5 }]) {
    const raw = JSON.parse(JSON.stringify(serializeViewState({ ...validateViewState({}).view, mirror } as never)));
    assert.deepEqual(validateViewState(raw).view.mirror, mirror);
  }
});
