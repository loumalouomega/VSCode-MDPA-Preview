import { test } from "node:test";
import assert from "node:assert/strict";

import { eigSym3, metricFromHessian } from "../parser/anisoMetric";

test("eigSym3 diagonalizes a diagonal matrix", () => {
  const { values, vectors } = eigSym3([4, 0, 0, 1, 0, 9]);
  assert.deepEqual([...values].sort((a, b) => a - b), [1, 4, 9]);
  // Eigenvectors are orthonormal.
  for (let i = 0; i < 3; i++) {
    const n = Math.hypot(...vectors[i]);
    assert.ok(Math.abs(n - 1) < 1e-12);
    for (let j = i + 1; j < 3; j++) {
      const dot = vectors[i][0] * vectors[j][0] + vectors[i][1] * vectors[j][1] + vectors[i][2] * vectors[j][2];
      assert.ok(Math.abs(dot) < 1e-12);
    }
  }
});

test("eigSym3 recovers eigenvalues of a rotated diagonal", () => {
  // R = 45° about z; M = R diag(1,4,9) Rᵀ.
  const c = Math.SQRT1_2;
  const m = [
    c * c * 1 + c * c * 4, c * c * 1 - c * c * 4, 0,
    c * c * 1 + c * c * 4, 0,
    9,
  ];
  const { values } = eigSym3(m);
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(Math.abs(sorted[0] - 1) < 1e-9, sorted.join(","));
  assert.ok(Math.abs(sorted[1] - 4) < 1e-9, sorted.join(","));
  assert.ok(Math.abs(sorted[2] - 9) < 1e-9, sorted.join(","));
});

test("metricFromHessian maps strongest curvature to hmin", () => {
  // H = diag(2, 0.02, 0.02): strong curvature along x only.
  const m = metricFromHessian([2, 0, 0, 0, 0.02, 0, 0, 0, 0.02], 0.05, 0.5);
  // m11 = 1/hmin², m22 = m33 clamped toward 1/hmax².
  assert.ok(Math.abs(m[0] - 1 / (0.05 * 0.05)) < 1e-6, m.join(","));
  assert.ok(m[3] < m[0] && m[5] < m[0]);
  assert.ok(Math.abs(m[3] - 1 / (0.5 * 0.5)) < 1e-6, m.join(","));
  assert.equal(m[1], 0);
  assert.equal(m[2], 0);
  assert.equal(m[4], 0);
});

test("metricFromHessian: flat and non-finite input go isotropic-coarse", () => {
  const flat = metricFromHessian([0, 0, 0, 0, 0, 0, 0, 0, 0], 0.05, 0.5);
  assert.deepEqual([...flat], [4, 0, 0, 4, 0, 4]);
  const bad = metricFromHessian([1, 0, 0, 0, NaN, 0, 0, 0, 1], 0.05, 0.5);
  assert.deepEqual([...bad], [4, 0, 0, 4, 0, 4]);
});

test("metricFromHessian symmetrizes and stays positive-definite", () => {
  // Antisymmetric noise on top of diag(3,1,2).
  const m = metricFromHessian([3, 0.5, 0, -0.5, 1, 0.25, 0, -0.25, 2], 0.05, 0.5);
  const { values } = eigSym3(m);
  assert.ok(values.every((l) => l > 0), values.join(","));
});
