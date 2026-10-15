import { test } from "node:test";
import assert from "node:assert/strict";

import { gridSamples, linspace, radicalInverse, sampleParameters, seededRandom } from "../problemtype/rom/sampling";
import { classifyChanges, diffLeaves, PROBE_A, PROBE_B, valueAtPath } from "../problemtype/rom/parameterPaths";

const RANGES = [
  { min: -50, max: 50 },
  { min: 2, max: 3 },
];

test("the PRNG is deterministic per seed and in [0, 1)", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, seededRandom(43)));
});

test("Halton digits are the radical inverse", () => {
  assert.deepEqual([1, 2, 3, 4].map((i) => radicalInverse(i, 2)), [0.5, 0.25, 0.75, 0.125]);
  assert.deepEqual([1, 2, 3].map((i) => radicalInverse(i, 3)), [1 / 3, 2 / 3, 1 / 9]);
});

test("every method stays inside the ranges and is reproducible", () => {
  for (const method of ["lhs", "halton", "random"] as const) {
    const s1 = sampleParameters(RANGES, method, 8, 3, 7);
    const s2 = sampleParameters(RANGES, method, 8, 3, 7);
    assert.deepEqual(s1, s2, method);
    assert.equal(s1.train.length, 8);
    assert.equal(s1.test.length, 3);
    for (const row of [...s1.train, ...s1.test]) {
      assert.equal(row.length, 2);
      assert.ok(row[0] >= -50 && row[0] <= 50 && row[1] >= 2 && row[1] <= 3, `${method}: ${row}`);
    }
  }
});

test("a Latin hypercube puts exactly one point in each stratum of each parameter", () => {
  const { train } = sampleParameters(RANGES, "lhs", 10, 0, 3);
  for (let d = 0; d < 2; d++) {
    const strata = train.map((row) => Math.floor(((row[d] - RANGES[d].min) / (RANGES[d].max - RANGES[d].min)) * 10)).sort((a, b) => a - b);
    assert.deepEqual(strata, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }
});

test("Halton test points continue after the training points", () => {
  const { train, test: testSet } = sampleParameters([{ min: 0, max: 1 }], "halton", 3, 2, 0);
  assert.deepEqual(train.map((r) => r[0]), [0.5, 0.25, 0.75]);
  assert.deepEqual(testSet.map((r) => r[0]), [0.125, 0.625]);
});

test("the full grid is the tensor product of each parameter's points", () => {
  assert.deepEqual(linspace({ min: 0, max: 1 }, 3), [0, 0.5, 1]);
  assert.deepEqual(linspace({ min: 0, max: 1 }, 1), [0.5]);
  const grid = gridSamples([{ min: 0, max: 1, gridPoints: 2 }, { min: 10, max: 30, gridPoints: 3 }]);
  assert.deepEqual(grid, [[0, 10], [0, 20], [0, 30], [1, 10], [1, 20], [1, 30]]);
  const { train } = sampleParameters([{ min: 0, max: 1, gridPoints: 4 }], "grid", 99, 2, 1);
  assert.equal(train.length, 4);
  assert.deepEqual(sampleParameters([], "lhs", 5, 5, 1), { train: [], test: [] });
});

test("perturbation diffs: equal values, templated strings and derived leaves", () => {
  const a = { p: { value: PROBE_A, expr: `(${PROBE_A})`, scaled: PROBE_A * 2, keep: 1, list: [0, PROBE_A, 0] } };
  const b = { p: { value: PROBE_B, expr: `(${PROBE_B})`, scaled: PROBE_B * 2, keep: 1, list: [0, PROBE_B, 0] } };
  const changes = diffLeaves(a, b);
  assert.deepEqual(changes.map((c) => c.path.join(".")).sort(), ["p.expr", "p.list.1", "p.scaled", "p.value"]);
  const { paths, problems } = classifyChanges("parameters", changes);
  assert.deepEqual(paths.map((p) => [p.path.join("."), p.kind, p.template]).sort(), [
    ["p.expr", "string", "({mu})"],
    ["p.list.1", "number", undefined],
    ["p.value", "number", undefined],
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /p\.scaled is derived from the value/);
  assert.equal(valueAtPath(a, ["p", "list", 1]), PROBE_A);
  assert.equal(valueAtPath(a, ["p", "nope", 1]), undefined);
});
