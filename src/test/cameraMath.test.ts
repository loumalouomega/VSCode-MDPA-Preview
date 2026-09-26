import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  WheelNormalizer,
  clippingRangeForBounds,
  cubeFaceHit,
  directionOfProjection,
  orthogonalizeViewUp,
  resetCameraToBounds,
  rotateAbout,
  scrollZoom,
  trackballPan,
  trackballRotate,
  viewRay,
  zoomDrag,
  zoomDragScale,
  type CameraLens,
  type CameraPose,
} from "../parser/render/cameraMath";
import type { Vec3 } from "../parser/render/types";

const close = (a: number[], b: number[], eps = 1e-9, msg = "") =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${msg} [${i}] ${v} vs ${b[i]}`));
const len = (v: Vec3) => Math.hypot(...v);

const front: CameraPose = { position: [0, 0, 10], focalPoint: [0, 0, 0], viewUp: [0, 1, 0] };
const persp: CameraLens = { parallelProjection: false, parallelScale: 1, viewAngle: 30, clippingRange: [1, 100] };
const ortho: CameraLens = { ...persp, parallelProjection: true, parallelScale: 2 };

test("rotateAbout is a right-handed rotation", () => {
  close(rotateAbout([1, 0, 0], [0, 0, 1], Math.PI / 2), [0, 1, 0]);
  close(rotateAbout([0, 1, 0], [1, 0, 0], Math.PI / 2), [0, 0, 1]);
});

test("trackball rotate: a full viewport width of motion is a 360-degree azimuth about the view-up", () => {
  const quarter = trackballRotate(front, 100, 0, [400, 300]); // 100/400 of 360 = 90 degrees
  close(quarter.position, [10, 0, 0], 1e-9, "position");
  close(quarter.focalPoint, [0, 0, 0]);
  close(quarter.viewUp, [0, 1, 0]);
  const full = trackballRotate(front, 400, 0, [400, 300]);
  close(full.position, front.position, 1e-9);
});

test("trackball rotate: vertical motion elevates, keeps distance to the centre and an orthonormal view-up", () => {
  const r = trackballRotate(front, 0, -75, [400, 300]); // -75 -> +90 degrees about dop x up
  // dop = -z, up = +y: the elevation axis is dop x up = +x; +90 degrees about +x takes (0,0,10) to (0,-10,0).
  close(r.position, [0, -10, 0], 1e-9);
  assert.ok(Math.abs(len(r.position) - 10) < 1e-9);
  const dop = directionOfProjection(r);
  assert.ok(Math.abs(dop[0] * r.viewUp[0] + dop[1] * r.viewUp[1] + dop[2] * r.viewUp[2]) < 1e-9);
  assert.ok(Math.abs(len(r.viewUp) - 1) < 1e-9);
});

test("trackball rotate turns about the world origin (vtk.js's default centre), not the focal point", () => {
  const off: CameraPose = { position: [5, 0, 10], focalPoint: [5, 0, 0], viewUp: [0, 1, 0] };
  const r = trackballRotate(off, 200, 0, [400, 300]); // 180 degrees about +y through the origin
  close(r.position, [-5, 0, -10], 1e-9);
  close(r.focalPoint, [-5, 0, 0], 1e-9);
});

test("parallel pan moves camera and focal point together by twice the parallel scale per viewport height", () => {
  const r = trackballPan(front, ortho, [100, 100], [150, 100], 200);
  // right = vpn x up = (+z) x (+y) = -x; dx = 50/200 * 2 * 2 = 1.
  close(r.position, [-1, 0, 10]);
  close(r.focalPoint, [-1, 0, 0]);
  const v = trackballPan(front, ortho, [100, 100], [100, 150], 200);
  close(v.position, [0, -1, 10]);
});

test("perspective pan keeps the grabbed point under the cursor at the centre's depth", () => {
  const h = 300;
  const r = trackballPan(front, persp, [100, 100], [130, 100], h);
  const perPixel = (2 * 10 * Math.tan(Math.PI / 12)) / h;
  close(r.position, [-30 * perPixel, 0, 10], 1e-9);
  close(r.focalPoint, [-30 * perPixel, 0, 0], 1e-9);
});

test("zoom drag: parallel rescales, perspective moves along the view direction", () => {
  assert.equal(zoomDragScale(ortho, 300), 1.5 / 300);
  assert.equal(zoomDragScale(persp, 300), (1.5 * 100) / 300);
  const p = zoomDrag(front, ortho, 30, zoomDragScale(ortho, 300));
  assert.ok("parallelScale" in p);
  if ("parallelScale" in p) assert.ok(Math.abs(p.parallelScale - (1 - 0.15) * 2) < 1e-12);
  const q = zoomDrag(front, persp, 3, 0.5);
  assert.ok("pose" in q);
  if ("pose" in q) close(q.pose.position, [0, 0, 8.5]);
});

test("scroll zoom follows vtk.js: 1 - spin/10 as a dolly, or its inverse on the parallel scale", () => {
  assert.deepEqual(scrollZoom(persp, 1), { dolly: 0.9 });
  const o = scrollZoom(ortho, -1);
  assert.ok("parallelScale" in o && Math.abs(o.parallelScale - 2 / 1.1) < 1e-12);
});

test("the wheel normalizer makes a gesture's first notch +-1 on every device", () => {
  const w = new WheelNormalizer();
  assert.equal(w.normalize(100, 0, 0), 1);
  assert.equal(w.normalize(200, 0, 50), 2);
  const t = new WheelNormalizer();
  assert.equal(t.normalize(-3, 1, 0), -1); // three lines = 120 px -> coefficient 1.2
});

test("orthogonalizeViewUp removes the component along the direction of projection", () => {
  const up = orthogonalizeViewUp({ position: [0, 0, 10], focalPoint: [0, 0, 0], viewUp: [0, 1, 1] });
  close(up, [0, 1, 0], 1e-12);
});

test("resetCameraToBounds matches VTK's reset: fits the bounding sphere along the view-plane normal", () => {
  const r = resetCameraToBounds(front, 30, [-1, 1, -1, 1, -1, 1]);
  const radius = Math.sqrt(3);
  close(r.pose.focalPoint, [0, 0, 0]);
  close(r.pose.position, [0, 0, radius / Math.sin(Math.PI / 12)], 1e-9);
  assert.ok(Math.abs(r.parallelScale - radius) < 1e-12);
  // A view-up parallel to the view-plane normal is swapped.
  const top: CameraPose = { position: [0, 10, 0], focalPoint: [0, 0, 0], viewUp: [0, 1, 0] };
  close(resetCameraToBounds(top, 30, [0, 0, 0, 0, 0, 0]).pose.viewUp, [0, 0, 1]);
});

test("a ray through the centre of the marker hits the face facing the camera", () => {
  const pose: CameraPose = { position: [0, 0, 5], focalPoint: [0, 0, 0], viewUp: [0, 1, 0] };
  const c = viewRay(pose, persp, 1, [0, 0]);
  assert.deepEqual(cubeFaceHit(c.origin, c.dir), [0, 0, 1]);
  const side: CameraPose = { position: [5, 0, 0], focalPoint: [0, 0, 0], viewUp: [0, 1, 0] };
  const s = viewRay(side, persp, 1, [0, 0]);
  assert.deepEqual(cubeFaceHit(s.origin, s.dir), [1, 0, 0]);
  // Near the top edge of a front view the ray grazes above the cube.
  const miss = viewRay(pose, persp, 1, [0, 0.99]);
  assert.equal(cubeFaceHit(miss.origin, miss.dir), undefined);
  // Parallel rays work too.
  const o = viewRay(pose, { ...ortho, parallelScale: 1 }, 1, [0.2, 0.2]);
  assert.deepEqual(cubeFaceHit(o.origin, o.dir), [0, 0, 1]);
});

test("clippingRangeForBounds follows vtk.js: corner depths, minimum gap, 5% expansion, 1% near floor", () => {
  // Unit cube 10 in front of the camera: corners at depths 9..11 (gap 2 exceeds the minimum gap).
  const r = clippingRangeForBounds(front, persp, [-1, 1, -1, 1, -1, 1]);
  const near = 0.99 * 9 - 2 * 0.05;
  const far = 1.01 * 11 + (11 - near) * 0.05;
  assert.ok(Math.abs(r[0] - near) < 1e-12, `near ${r[0]}`);
  assert.ok(Math.abs(r[1] - far) < 1e-12, `far ${r[1]}`);
  // A flat box widens to the minimum gap (0.2 * tan(15 deg) * far) around its depth.
  const flat = clippingRangeForBounds(front, persp, [-1, 1, -1, 1, 0, 0]);
  assert.ok(flat[1] - flat[0] > 0.2 * Math.tan(Math.PI / 12) * 10 * 0.99);
  // Bounds behind the camera clamp the near plane to 1% of the far one.
  const behind = clippingRangeForBounds(front, persp, [-1, 1, -1, 1, 5, 20]);
  assert.ok(Math.abs(behind[0] - 0.01 * behind[1]) < 1e-12);
});
