import { test } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_ROTATE_STEP,
  ROTATE_STEPS,
  computePanStep,
  computeRightVector,
  defaultViewCamera,
  ownsArrowKeys,
} from "../parser/navMath";

test("computeRightVector: front view (looking -Z, +Y up) has +X to the right", () => {
  const r = computeRightVector([0, 0, -1], [0, 1, 0]);
  assert.deepStrictEqual(r.map((v) => Math.round(v * 1e9) / 1e9 + 0), [1, 0, 0]);
});

test("computeRightVector: result is unit length and perpendicular to both inputs", () => {
  const dir: [number, number, number] = [0.3, -0.5, -0.8];
  const up: [number, number, number] = [0, 1, 0];
  const r = computeRightVector(dir, up);
  assert.ok(Math.abs(Math.hypot(...r) - 1) < 1e-12);
  assert.ok(Math.abs(r[0] * dir[0] + r[1] * dir[1] + r[2] * dir[2]) < 1e-12);
  assert.ok(Math.abs(r[0] * up[0] + r[1] * up[1] + r[2] * up[2]) < 1e-12);
});

test("computeRightVector: parallel dir/up degrades to +X instead of NaN", () => {
  assert.deepStrictEqual(computeRightVector([0, 1, 0], [0, 1, 0]), [1, 0, 0]);
});

test("computePanStep: 15% of the half-height of the frustum, linear in distance", () => {
  // 90 degree view angle: tan(45deg) = 1, so the half-height equals the distance.
  assert.ok(Math.abs(computePanStep(10, 90) - 1.5) < 1e-12);
  assert.ok(Math.abs(computePanStep(20, 90) - 2 * computePanStep(10, 90)) < 1e-12);
  assert.strictEqual(computePanStep(0, 30), 0);
});

test("rotate steps: 15/45/90 and the default is one of them", () => {
  assert.deepStrictEqual([...ROTATE_STEPS], [15, 45, 90]);
  assert.ok((ROTATE_STEPS as readonly number[]).includes(DEFAULT_ROTATE_STEP));
});

test("defaultViewCamera: sits on +Z of the focal point with +Y up", () => {
  const c = defaultViewCamera([2, 3, 4]);
  assert.deepStrictEqual(c.position, [2, 3, 5]);
  assert.deepStrictEqual(c.viewUp, [0, 1, 0]);
});

test("ownsArrowKeys: form fields keep their arrows, buttons do not", () => {
  for (const t of ["input", "INPUT", "select", "textarea"]) assert.ok(ownsArrowKeys(t), t);
  for (const t of ["button", "DIV", "", undefined]) assert.ok(!ownsArrowKeys(t as string | undefined), String(t));
});
