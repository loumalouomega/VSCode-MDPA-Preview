/**
 * recordPlan.ts — the video recorder's frame plan.
 *
 * The turntable's "closes the loop" property and the zero-padded frame names
 * are the two things that are silently wrong if you get them subtly off: a
 * duplicated 0°/360° frame only shows up as a stutter on repeat, and unpadded
 * names only misbehave once a recording passes ten frames.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECORD_SETTINGS,
  RecordSettings,
  buildRecordPlan,
  clampFps,
  clampFrames,
  describePlan,
  frameFileName,
} from "../parser/recordPlan";

function settings(over: Partial<RecordSettings> = {}): RecordSettings {
  return { ...DEFAULT_RECORD_SETTINGS, ...over };
}

test("a turntable closes the loop exactly, with no duplicated frame", () => {
  const plan = buildRecordPlan(settings({ source: "turntable", turntableFrames: 8 }), 0);
  assert.equal(plan.steps.length, 8);
  const deltas = plan.steps.map((s) => (s.kind === "turntable" ? s.azimuthDelta : NaN));
  // Every step is the same rotation...
  assert.deepEqual(new Set(deltas), new Set([45]));
  // ...and they sum to exactly one revolution, so frame 0 and the frame after
  // the last are the same view — the loop repeats seamlessly.
  assert.equal(
    deltas.reduce((a, b) => a + b, 0),
    360
  );
});

test("a turntable divides a full turn however many frames are asked for", () => {
  for (const n of [2, 3, 24, 48, 360]) {
    const plan = buildRecordPlan(settings({ source: "turntable", turntableFrames: n }), 0);
    assert.equal(plan.steps.length, n);
    const total = plan.steps.reduce(
      (a, s) => a + (s.kind === "turntable" ? s.azimuthDelta : 0),
      0
    );
    assert.ok(Math.abs(total - 360) < 1e-9, `${n} frames summed to ${total}`);
  }
});

test("a timeline visits every step once, in order", () => {
  const plan = buildRecordPlan(settings({ source: "timeline" }), 5);
  assert.deepEqual(
    plan.steps.map((s) => (s.kind === "timeline" ? s.frameIndex : -1)),
    [0, 1, 2, 3, 4]
  );
});

test("a timeline with nothing to play yields an empty plan, not a one-frame video", () => {
  // The caller reports this rather than producing a video of a single still.
  for (const n of [0, 1]) {
    const plan = buildRecordPlan(settings({ source: "timeline" }), n);
    assert.deepEqual(plan.steps, []);
    assert.equal(describePlan(plan), "Nothing to record.");
  }
  assert.equal(buildRecordPlan(settings({ source: "timeline" }), 2).steps.length, 2);
});

test("fps and frame counts are clamped rather than trusted", () => {
  assert.equal(clampFps(0), 1);
  assert.equal(clampFps(-5), 1);
  assert.equal(clampFps(1000), 60);
  assert.equal(clampFps(12.4), 12);
  assert.equal(clampFps(NaN), DEFAULT_RECORD_SETTINGS.fps);

  assert.equal(clampFrames(1), 2);
  assert.equal(clampFrames(99999), 720);
  assert.equal(clampFrames(NaN), DEFAULT_RECORD_SETTINGS.turntableFrames);
});

test("the plan carries the timing the player and the loop both need", () => {
  const plan = buildRecordPlan(settings({ source: "turntable", turntableFrames: 24, fps: 12 }), 0);
  assert.equal(plan.fps, 12);
  assert.equal(plan.frameIntervalMs, 1000 / 12);
  assert.equal(plan.durationSec, 2);
  assert.equal(describePlan(plan), "24 frames · 2.0s at 12 fps");
});

test("frame names are zero-padded so a glob sorts them correctly", () => {
  // The lexicographic trap: "_10" must not sort before "_2".
  const names = [2, 10].map((i) => frameFileName("beam", i, 100));
  assert.deepEqual(names, ["beam_0002.png", "beam_0010.png"]);
  assert.deepEqual([...names].sort(), names);
  // At least four digits, so ffmpeg's %04d works for any small recording.
  assert.equal(frameFileName("beam", 0, 3), "beam_0000.png");
  // ...and wider when the count needs it.
  assert.equal(frameFileName("beam", 5, 100000), "beam_00005.png");
});
