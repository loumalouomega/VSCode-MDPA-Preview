import { test } from "node:test";
import assert from "node:assert";
import { estimateTimeStep, THIN_CELL_RATIO } from "../problemtype/timeStepEstimate";
import { tetBar } from "./fixtures/shapes";
import { scaleCoords } from "../parser/transformCoords";

test("dt scales with size and inversely with velocity", () => {
  const bar = tetBar(4);
  const a = estimateTimeStep(bar, { refVelocity: 1, courant: 1, safety: 1 });
  const b = estimateTimeStep(bar, { refVelocity: 2, courant: 1, safety: 1 });
  const c = estimateTimeStep(scaleCoords(bar, 2, 2, 2), { refVelocity: 1, courant: 1, safety: 1 });
  assert.ok(a.available && b.available && c.available);
  if (a.available && b.available && c.available) {
    assert.ok(a.dt > 0);
    assert.ok(Math.abs(b.dt - a.dt / 2) < 1e-9);
    assert.ok(Math.abs(c.dt - a.dt * 2) < 1e-6);
  }
});

test("zero velocity and bad factors are unavailable with a reason", () => {
  const bar = tetBar(2);
  for (const input of [{ refVelocity: 0 }, { refVelocity: NaN }, { refVelocity: 1, courant: 0 }]) {
    const e = estimateTimeStep(bar, input);
    assert.equal(e.available, false);
    if (!e.available) assert.ok(e.reason.length > 0);
  }
});

test("thin elements switch to the shortest-edge basis and say so", () => {
  const bar = tetBar(2);
  const thin = scaleCoords(bar, 1, 1, 0.01);
  const e = estimateTimeStep(thin, { refVelocity: 1, courant: 1, safety: 1 });
  assert.ok(e.available);
  if (e.available) {
    assert.equal(e.basis, "shortest-edge");
    assert.ok(e.limitation);
  }
  assert.ok(THIN_CELL_RATIO > 1);
});

test("step, frame and storage budgets", () => {
  const bar = tetBar(3);
  const e = estimateTimeStep(bar, { refVelocity: 1, courant: 1, safety: 1, endTime: 1, outputInterval: 0.25 });
  assert.ok(e.available);
  if (e.available) {
    assert.equal(e.steps, Math.ceil(1 / e.dt));
    assert.equal(e.frames, 5);
    assert.ok(e.storage && e.storage.maxBytes > e.storage.minBytes && e.storage.minBytes > 0);
    assert.ok(e.flowThroughTime > 0);
  }
});

test("describeEstimate reports basis, compares without replacing the user's step", async () => {
  const { describeEstimate } = await import("../problemtype/timeStepEstimate");
  const bar = tetBar(3);
  const e = estimateTimeStep(bar, { refVelocity: 1, courant: 1, safety: 1, endTime: 1, outputInterval: 0.5 });
  const lines = describeEstimate(e, 0.5);
  assert.ok(lines[0].includes("Convective estimate"));
  assert.ok(lines.some((l) => l.includes("× the estimate")));
  assert.ok(lines.some((l) => l.includes("output frames")));
  assert.deepEqual(describeEstimate({ available: false, reason: "x" }), ["Time-step estimate unavailable: x"]);
});
