import { test } from "node:test";
import assert from "node:assert";
import {
  ColorStop,
  canLogScale,
  componentLabel,
  componentScalar,
  computeFieldRange,
  effectiveRange,
  interpolateStops,
  legendTicks,
  normValue,
  spacedIsoValues,
  transformStops,
} from "../parser/fieldScalars";
import { FieldData } from "../parser/types";

function scalarField(values: number[]): FieldData {
  return {
    kind: "Nodal",
    variable: "S",
    components: 1,
    ids: Int32Array.from(values.map((_, i) => i + 1)),
    values: Float64Array.from(values),
  };
}

function vectorField(rows: number[][]): FieldData {
  return {
    kind: "Nodal",
    variable: "V",
    components: 3,
    ids: Int32Array.from(rows.map((_, i) => i + 1)),
    values: Float64Array.from(rows.flat()),
  };
}

// --- componentScalar -----------------------------------------------------

test("componentScalar: scalar field ignores component", () => {
  const f = scalarField([4, 7]);
  assert.strictEqual(componentScalar(f, 1, "mag"), 7);
  assert.strictEqual(componentScalar(f, 1, 0), 7);
  assert.strictEqual(componentScalar(f, 1, 2), 7);
});

test("componentScalar: vector magnitude and components", () => {
  const f = vectorField([[3, 4, 0], [1, 2, 2]]);
  assert.strictEqual(componentScalar(f, 0, "mag"), 5);
  assert.strictEqual(componentScalar(f, 0, 0), 3);
  assert.strictEqual(componentScalar(f, 0, 1), 4);
  assert.strictEqual(componentScalar(f, 0, 2), 0);
  assert.strictEqual(componentScalar(f, 1, "mag"), 3);
});

test("componentLabel", () => {
  assert.strictEqual(componentLabel("mag"), "Magnitude");
  assert.strictEqual(componentLabel(0), "X");
  assert.strictEqual(componentLabel(2), "Z");
});

// --- computeFieldRange ---------------------------------------------------

test("computeFieldRange: per-component ranges of a vector field", () => {
  const f = vectorField([[3, 4, 0], [-1, 2, 10], [0, 0, -2]]);
  assert.deepStrictEqual(computeFieldRange(f, 0), [-1, 3]);
  assert.deepStrictEqual(computeFieldRange(f, 1), [0, 4]);
  assert.deepStrictEqual(computeFieldRange(f, 2), [-2, 10]);
  const [lo, hi] = computeFieldRange(f, "mag");
  assert.strictEqual(lo, 2); // |(0,0,-2)|
  assert.ok(Math.abs(hi - Math.hypot(-1, 2, 10)) < 1e-12);
});

test("computeFieldRange: NaN rows skipped; all-NaN yields [0,0]", () => {
  assert.deepStrictEqual(computeFieldRange(scalarField([NaN, 2, 5, NaN])), [2, 5]);
  assert.deepStrictEqual(computeFieldRange(scalarField([NaN, NaN])), [0, 0]);
  assert.deepStrictEqual(computeFieldRange(scalarField([])), [0, 0]);
});

// --- effectiveRange ------------------------------------------------------

test("effectiveRange: override wins and is normalized", () => {
  assert.deepStrictEqual(effectiveRange([0, 10]), [0, 10]);
  assert.deepStrictEqual(effectiveRange([0, 10], [2, 8]), [2, 8]);
  assert.deepStrictEqual(effectiveRange([0, 10], [8, 2]), [2, 8]);
  assert.deepStrictEqual(effectiveRange([0, 10], [NaN, 5]), [0, 10]);
});

// --- normValue -----------------------------------------------------------

test("normValue: linear and log", () => {
  assert.strictEqual(normValue(5, 0, 10), 0.5);
  assert.strictEqual(normValue(-3, 0, 10), 0);
  assert.strictEqual(normValue(30, 0, 10), 1);
  assert.strictEqual(normValue(3, 3, 3), 0.5); // degenerate range
  // log: geometric mean of [1, 100] is 10 → t = 0.5
  assert.ok(Math.abs(normValue(10, 1, 100, true) - 0.5) < 1e-12);
  // log requested but not applicable (min <= 0) falls back to linear
  assert.strictEqual(normValue(5, 0, 10, true), 0.5);
});

test("canLogScale", () => {
  assert.ok(canLogScale(1, 10));
  assert.ok(!canLogScale(0, 10));
  assert.ok(!canLogScale(-1, 10));
  assert.ok(!canLogScale(5, 5));
});

// --- stops ---------------------------------------------------------------

const BW: ColorStop[] = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
];

test("interpolateStops: midpoints and clamping", () => {
  assert.deepStrictEqual(interpolateStops(BW, 0.5), [0.5, 0.5, 0.5]);
  assert.deepStrictEqual(interpolateStops(BW, -1), [0, 0, 0]);
  assert.deepStrictEqual(interpolateStops(BW, 2), [1, 1, 1]);
});

test("transformStops: identity without log/bands", () => {
  assert.strictEqual(transformStops(BW, { min: 0, max: 1 }), BW);
});

test("transformStops: log re-spacing compresses low values", () => {
  const stops = transformStops(BW, { log: true, min: 1, max: 100 });
  // The color at the geometric mean (value 10 → linear pos 9/99) must be ~0.5 gray.
  const [r] = interpolateStops(stops, (10 - 1) / 99);
  assert.ok(Math.abs(r - 0.5) < 0.02, `expected ~0.5, got ${r}`);
  // Positions strictly increasing, endpoints preserved.
  assert.strictEqual(stops[0][0], 0);
  assert.strictEqual(stops[stops.length - 1][0], 1);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i][0] > stops[i - 1][0]);
});

test("transformStops: log ignored when range not log-scalable", () => {
  assert.strictEqual(transformStops(BW, { log: true, min: 0, max: 1 }), BW);
});

test("transformStops: banded yields piecewise-constant colors", () => {
  const stops = transformStops(BW, { bands: 4, min: 0, max: 1 });
  assert.strictEqual(stops.length, 8); // 2 stops per band
  // Inside the first band the color is the band-center color (t=0.125).
  const [r1] = interpolateStops(stops, 0.1);
  assert.ok(Math.abs(r1 - 0.125) < 0.01);
  const [r2] = interpolateStops(stops, 0.2);
  assert.ok(Math.abs(r2 - 0.125) < 0.01);
  // Next band jumps to 0.375.
  const [r3] = interpolateStops(stops, 0.3);
  assert.ok(Math.abs(r3 - 0.375) < 0.01);
  // Endpoints exactly 0 and 1 positions.
  assert.strictEqual(stops[0][0], 0);
  assert.strictEqual(stops[stops.length - 1][0], 1);
});

test("transformStops: banded + log places boundaries geometrically", () => {
  const stops = transformStops(BW, { bands: 2, log: true, min: 1, max: 100 });
  assert.strictEqual(stops.length, 4);
  // The band boundary sits at value 10 → linear position 9/99.
  const boundary = 9 / 99;
  const [rLo] = interpolateStops(stops, boundary - 0.02);
  const [rHi] = interpolateStops(stops, boundary + 0.02);
  assert.ok(Math.abs(rLo - 0.25) < 0.01);
  assert.ok(Math.abs(rHi - 0.75) < 0.01);
});

test("transformStops: bands < 2 treated as continuous", () => {
  assert.strictEqual(transformStops(BW, { bands: 1, min: 0, max: 1 }), BW);
  assert.strictEqual(transformStops(BW, { bands: 0, min: 0, max: 1 }), BW);
});

// --- legendTicks / spacedIsoValues --------------------------------------

test("legendTicks: linear and log spacing", () => {
  assert.deepStrictEqual(legendTicks(0, 10), [0, 5, 10]);
  const logTicks = legendTicks(1, 100, true);
  assert.strictEqual(logTicks[0], 1);
  assert.ok(Math.abs(logTicks[1] - 10) < 1e-9);
  assert.strictEqual(logTicks[2], 100);
  assert.strictEqual(legendTicks(0, 100, true)[1], 50); // log not applicable → linear
  assert.deepStrictEqual(legendTicks(0, 3, false, 4), [0, 1, 2, 3]);
});

test("spacedIsoValues: interior values, endpoints excluded", () => {
  assert.deepStrictEqual(spacedIsoValues(0, 10, 1), [5]);
  assert.deepStrictEqual(spacedIsoValues(0, 4, 3), [1, 2, 3]);
  assert.strictEqual(spacedIsoValues(0, 10, 0).length, 1); // clamped to ≥ 1
});
