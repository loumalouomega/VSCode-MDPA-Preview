import assert from "node:assert/strict";
import test from "node:test";
import { buildCapturePlan, captureBackground, captureFieldLabel, captureStepLabel, DEFAULT_CAPTURE_SETTINGS as defaults, validateCaptureSize } from "../parser/capturePlan";

test("focused capture uses the selected pane at native density and top-left coordinates", () => {
  const p = buildCapturePlan({ ...defaults, scope: "focused", resolution: "2" }, 1200, 800, "2x2", 2);
  assert.deepEqual([p.width, p.height, p.renderWidth, p.renderHeight], [1200, 800, 2400, 1600]);
  assert.deepEqual(p.crop, { x: 0, y: 800, width: 1200, height: 800 });
  assert.deepEqual(p.panes, [{ index: 2, rect: { x: 0, y: 0, width: 1200, height: 800 } }]);
});
test("custom aspect ratios pad rather than distort the scene", () => {
  const p = buildCapturePlan({ ...defaults, resolution: "custom", width: 1000, height: 1000 }, 1200, 600, "1x2", 0);
  assert.deepEqual(p.destination, { x: 0, y: 250, width: 1000, height: 500 });
  assert.deepEqual(p.panes[1].rect, { x: 500, y: 250, width: 500, height: 500 });
});
test("limits cover the hidden full-layout buffer as well as the output", () => {
  assert.throws(() => buildCapturePlan({ ...defaults, scope: "focused", resolution: "4" }, 2400, 2000, "2x2", 0), /limit/);
  for (const dims of [[0, 20], [NaN, 20], [2.5, 20], [8193, 1], [4001, 4000]]) assert.throws(() => validateCaptureSize(dims[0], dims[1]));
  assert.throws(() => validateCaptureSize(2049, 100, 2048), /limit/);
  validateCaptureSize(4000, 4000);
});
test("labels use supplied units and distinguish steps from known physical times", () => {
  assert.equal(captureFieldLabel("VELOCITY", 3, 1, { VELOCITY: "m/s" }), "VELOCITY · Y [m/s]");
  assert.equal(captureFieldLabel("VELOCITY", 3, "mag"), "VELOCITY · Magnitude");
  assert.equal(captureFieldLabel("PRESSURE", 1, "mag"), "PRESSURE");
  assert.equal(captureStepLabel("4", undefined, "s"), "Step: 4");
  assert.equal(captureStepLabel("0.2", "time", "s"), "Time: 0.2 s");
  assert.equal(captureStepLabel(undefined), "");
});
test("transparent backgrounds request real zero alpha and scene backgrounds are retained", () => {
  assert.equal(captureBackground(defaults), undefined);
  assert.deepEqual(captureBackground({ ...defaults, background: "transparent" }), [0, 0, 0, 0]);
  assert.deepEqual(captureBackground({ ...defaults, background: "custom", color: "#ff0080" }), [1, 0, 128 / 255, 1]);
  assert.throws(() => captureBackground({ ...defaults, background: "custom", color: "invalid" }));
});
