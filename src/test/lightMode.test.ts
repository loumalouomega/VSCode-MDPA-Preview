import { test } from "node:test";
import assert from "node:assert/strict";
import { lightPlacement, normalizeLightSpec } from "../parser/render/lightMode";

const box: [number, number, number, number, number, number] = [0, 2, 0, 2, 0, 2];

test("headlight has no placement", () => {
  assert.equal(lightPlacement({ mode: "headlight", azimuth: 0, elevation: 0 }, box), null);
});
test("scene light points from the requested direction at the centre", () => {
  const p = lightPlacement({ mode: "scene", azimuth: 0, elevation: 90 }, box)!;
  assert.deepEqual(p.focalPoint, [1, 1, 1]);
  assert.ok(Math.abs(p.position[0] - 1) < 1e-9 && Math.abs(p.position[1] - 1) < 1e-9);
  assert.ok(p.position[2] > 1);
  assert.equal(p.positional, false);
});
test("positional sits closer than a scene light", () => {
  const far = lightPlacement({ mode: "scene", azimuth: 30, elevation: 20 }, box)!;
  const near = lightPlacement({ mode: "positional", azimuth: 30, elevation: 20 }, box)!;
  const dist = (p: { position: number[] }) => Math.hypot(p.position[0] - 1, p.position[1] - 1, p.position[2] - 1);
  assert.ok(dist(near) < dist(far));
  assert.equal(near.positional, true);
});
test("degenerate bounds and bad angles stay finite", () => {
  const p = lightPlacement({ mode: "scene", azimuth: NaN, elevation: 500 }, [NaN, 0, 0, 0, 0, 0])!;
  assert.ok(p.position.every(Number.isFinite));
  const n = normalizeLightSpec({ mode: "scene", azimuth: -90, elevation: -200 });
  assert.equal(n.azimuth, 270);
  assert.equal(n.elevation, -90);
});
