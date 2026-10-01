import { test } from "node:test";
import assert from "node:assert";
import {
  estimateTimeStep,
  fallbackLength,
  validateFluidTimeStepping,
  THIN_CELL_RATIO,
} from "../problemtype/timeStepEstimate";
import { finalizeModel } from "../parser/modelBuilder";
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

function pointCloud(nx: number, ny: number, nz: number) {
  const coords: number[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) coords.push(i, j, k);
  return finalizeModel({
    nodeCount: coords.length / 3,
    coords: Float32Array.from(coords),
    blocks: [],
    fields: [],
    diagnostics: [],
  });
}

test("point-only mesh falls back to bounding-box volume sizing with a stated limitation", () => {
  const cloud = pointCloud(2, 2, 2);
  const fb = fallbackLength(cloud);
  assert.ok(fb);
  assert.equal(fb?.basis, "volume");
  // Unit cube, 8 nodes: cbrt(1/8) = 0.5.
  assert.ok(Math.abs((fb?.length ?? 0) - 0.5) < 1e-6);
  assert.match(fb?.limitation ?? "", /No measurable elements/);
  const e = estimateTimeStep(cloud, { refVelocity: 1, courant: 1, safety: 1 });
  assert.ok(e.available);
  if (e.available) {
    assert.equal(e.basis, "volume");
    assert.ok(e.limitation);
    assert.ok(e.dt > 0);
  }
});

test("degenerate volume falls back to the diagonal, empty mesh stays unavailable", () => {
  const line = pointCloud(4, 1, 1);
  const e = estimateTimeStep(line, { refVelocity: 1, courant: 1, safety: 1 });
  assert.ok(e.available);
  if (e.available) assert.equal(e.basis, "bbox");
  const sheet = pointCloud(3, 3, 1);
  const area = estimateTimeStep(sheet, { refVelocity: 1, courant: 1, safety: 1 });
  assert.ok(area.available);
  if (area.available) {
    assert.equal(area.basis, "volume");
    assert.ok(Math.abs(area.length - Math.sqrt(4 / 9)) < 1e-6);
  }
  const empty = finalizeModel({ nodeCount: 0, coords: new Float32Array(0), blocks: [], fields: [], diagnostics: [] });
  assert.equal(fallbackLength(empty), undefined);
  assert.equal(estimateTimeStep(empty, { refVelocity: 1 }).available, false);
});

test("validateFluidTimeStepping accepts defaults, refuses bad adaptive values", () => {
  assert.deepEqual(validateFluidTimeStepping({ timeStepMode: "fixed", timeStep: 0.01 }), []);
  assert.deepEqual(
    validateFluidTimeStepping({ timeStepMode: "adaptive", timeStep: 0.01, courantTarget: 1, minDeltaTime: 1e-4, maxDeltaTime: 0.1 }),
    []
  );
  const bad = validateFluidTimeStepping({ timeStepMode: "adaptive", timeStep: 0, courantTarget: 0, minDeltaTime: 0.1, maxDeltaTime: 1e-4 });
  assert.ok(bad.some((i) => i.severity === "error" && /Time step must/.test(i.message)));
  assert.ok(bad.some((i) => i.severity === "error" && /Courant/.test(i.message)));
  assert.ok(bad.some((i) => i.severity === "error" && /exceeds Max/.test(i.message)));
  const warn = validateFluidTimeStepping({ timeStepMode: "adaptive", timeStep: 1, courantTarget: 1, minDeltaTime: 1e-4, maxDeltaTime: 0.1 });
  assert.ok(warn.some((i) => i.severity === "warning" && /outside/.test(i.message)));
});
