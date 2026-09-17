import { test } from "node:test";
import assert from "node:assert";

// webview/colormaps.ts (which owns the real, shipped `makeCtfFromStops`)
// cannot be imported here: tsconfig.test.json's `rootDir` is `src`, and that
// file lives outside it (it also pulls in `@kitware/vtk.js`, which
// src/parser/ modules are deliberately kept free of). So this test pins the
// real vtk.js `ColorTransferFunction` behavior the fix in
// webview/colormaps.ts:makeCtfFromStops relies on, via a faithful local
// mirror of both the fixed and the pre-fix logic. Keep this in sync with
// webview/colormaps.ts if that function's degenerate-range handling changes.
const vtkColorTransferFunction: any = require("@kitware/vtk.js/Rendering/Core/ColorTransferFunction")
  .default;

type ColorStop = [t: number, r: number, g: number, b: number];

const RAINBOW: ColorStop[] = [
  [0.0, 0.0, 0.0, 1.0],
  [0.25, 0.0, 1.0, 1.0],
  [0.5, 0.0, 1.0, 0.0],
  [0.75, 1.0, 1.0, 0.0],
  [1.0, 1.0, 0.0, 0.0],
];

function interpolateStops(stops: ColorStop[], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1];
      const [t1, r1, g1, b1] = stops[i];
      const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

// Mirrors the FIXED webview/colormaps.ts:makeCtfFromStops.
function makeCtfFromStops(stops: ColorStop[], min: number, max: number) {
  const ctf = vtkColorTransferFunction.newInstance();
  if (max <= min) {
    const [r, g, b] = interpolateStops(stops, 0.5);
    ctf.addRGBPoint(min, r, g, b);
    return ctf;
  }
  const span = max - min;
  for (const [t, r, g, b] of stops) {
    ctf.addRGBPoint(min + t * span, r, g, b);
  }
  return ctf;
}

// Mirrors the PRE-FIX logic (`span = max > min ? max - min : 1`), to prove
// the bogus [min, min+1] range it produced on a degenerate field was real.
function oldMakeCtfFromStops(stops: ColorStop[], min: number, max: number) {
  const ctf = vtkColorTransferFunction.newInstance();
  const span = max > min ? max - min : 1;
  for (const [t, r, g, b] of stops) {
    ctf.addRGBPoint(min + t * span, r, g, b);
  }
  return ctf;
}

test("fixed makeCtfFromStops reports the true degenerate range, not a fake [min, min+1]", () => {
  const ctf = makeCtfFromStops(RAINBOW, 0, 0);
  assert.deepStrictEqual(ctf.getMappingRange(), [0, 0]);
});

test("the pre-fix fallback really did widen a degenerate range to [min, min+1]", () => {
  const ctf = oldMakeCtfFromStops(RAINBOW, 0, 0);
  assert.deepStrictEqual(ctf.getMappingRange(), [0, 1]);
});

test("fixed makeCtfFromStops is unchanged for a normal (non-degenerate) range", () => {
  const ctf = makeCtfFromStops(RAINBOW, 10, 20);
  assert.deepStrictEqual(ctf.getMappingRange(), [10, 20]);
});

test("a degenerate range still collapses correctly for a negative min", () => {
  const ctf = makeCtfFromStops(RAINBOW, -5, -5);
  assert.deepStrictEqual(ctf.getMappingRange(), [-5, -5]);
});

test("a degenerate CTF colors every sample the same, single mid-colormap hue", () => {
  const ctf = makeCtfFromStops(RAINBOW, 0, 0);
  const mid = interpolateStops(RAINBOW, 0.5);
  const atRange: number[] = [];
  ctf.getColor(0, atRange);
  assert.deepStrictEqual(atRange, mid);
  // Sampling off the (zero-width) range still returns the one defined color,
  // never black/NaN — texture generation degenerates cleanly (getTable's
  // xStart===xEnd path), matching every real scalar in a flat field.
  const offRange: number[] = [];
  ctf.getColor(999, offRange);
  assert.deepStrictEqual(offRange, mid);
});
