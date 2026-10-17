import { test } from "node:test";
import assert from "node:assert/strict";
import { eigSym3, metricFromWall, wallLayerSizes, layersToThickness } from "../parser/anisoMetric";

const spec = { firstHeight: 0.001, growth: 1.2, hmax: 1, maxAspect: 50, tangentialGrowth: 0.25 };

test("wall sizes start at the first height and grow like a geometric stack", () => {
  const w0 = wallLayerSizes(0, spec);
  assert.equal(w0.normal, 0.001);
  // The continuous law h1 + (r-1) d equals the discrete stack's k-th cell at its centre-line distance.
  const d = 0.001 * (1 + 1.2 + 1.2 ** 2); // after three layers
  assert.ok(Math.abs(wallLayerSizes(d, spec).normal - 0.001 * 1.2 ** 3) < 1e-12);
  assert.equal(wallLayerSizes(1e6, spec).normal, 1);
});

test("the along-wall size obeys the aspect limit and never drops below the across size", () => {
  const w = wallLayerSizes(0, { ...spec, tangentialSize: 10 });
  assert.equal(w.tangential, 0.001 * 50);
  const far = wallLayerSizes(10, spec);
  assert.ok(far.tangential >= far.normal && far.tangential <= 1);
});

test("the metric stretches along the gradient and is isotropic where the gradient is unusable", () => {
  const m = metricFromWall([0, 0, 1], 0, spec);
  const { values } = eigSym3([m[0], m[1], m[2], m[3], m[4], m[5]]);
  const sorted = [...values].sort((a, b) => b - a);
  assert.ok(Math.abs(sorted[0] - 1 / 0.001 ** 2) / (1 / 0.001 ** 2) < 1e-9);
  assert.ok(Math.abs(sorted[2] - 1 / 0.05 ** 2) / (1 / 0.05 ** 2) < 1e-9);
  // The big eigenvalue is along z: m33 carries it.
  assert.ok(m[5] > m[0] && m[0] === m[3]);
  const iso = metricFromWall([0, 0, 0], 0, spec);
  assert.deepEqual([iso[0], iso[1], iso[3]], [iso[3], 0, iso[0]]);
  const nan = metricFromWall([NaN, 0, 0], 0, spec);
  assert.ok(Number.isFinite(nan[0]));
});

test("an oblique gradient gives a symmetric positive-definite tensor", () => {
  const m = metricFromWall([1, 1, 1], 0.01, spec);
  const { values } = eigSym3([m[0], m[1], m[2], m[3], m[4], m[5]]);
  assert.ok(values.every((v) => v > 0));
});

test("layers to a thickness", () => {
  assert.equal(layersToThickness(0.001, 1.2, 0.001), 1);
  assert.equal(layersToThickness(0.001, 1, 0.01), 10);
  const n = layersToThickness(0.001, 1.2, 0.05);
  assert.ok(0.001 * (1.2 ** n - 1) / 0.2 >= 0.05 && 0.001 * (1.2 ** (n - 1) - 1) / 0.2 < 0.05);
});
