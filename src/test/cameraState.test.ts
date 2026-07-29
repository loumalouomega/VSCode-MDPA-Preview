import { test } from "node:test";
import assert from "node:assert";
import { cameraStateToJson, isCameraState, parseCameraJson } from "../parser/cameraState";

const VALID = {
  position: [1, 2, 3] as [number, number, number],
  focalPoint: [0, 0, 0] as [number, number, number],
  viewUp: [0, 1, 0] as [number, number, number],
  parallelScale: 5,
};

test("isCameraState: accepts a well-formed camera state", () => {
  assert.ok(isCameraState(VALID));
});

test("isCameraState: rejects missing/malformed fields", () => {
  assert.ok(!isCameraState(undefined));
  assert.ok(!isCameraState(null));
  assert.ok(!isCameraState({}));
  assert.ok(!isCameraState({ ...VALID, position: [1, 2] }));
  assert.ok(!isCameraState({ ...VALID, position: [1, 2, "x"] }));
  assert.ok(!isCameraState({ ...VALID, parallelScale: "5" }));
  assert.ok(!isCameraState({ ...VALID, parallelScale: NaN }));
  assert.ok(!isCameraState("not an object"));
});

test("parseCameraJson: round-trips a valid state through cameraStateToJson", () => {
  const json = cameraStateToJson(VALID);
  const parsed = parseCameraJson(json);
  assert.deepStrictEqual(parsed, VALID);
});

test("parseCameraJson: undefined on malformed JSON", () => {
  assert.strictEqual(parseCameraJson("{not json"), undefined);
});

test("parseCameraJson: undefined on well-formed JSON with the wrong shape", () => {
  assert.strictEqual(parseCameraJson(JSON.stringify({ foo: "bar" })), undefined);
  assert.strictEqual(parseCameraJson(JSON.stringify([1, 2, 3])), undefined);
});
