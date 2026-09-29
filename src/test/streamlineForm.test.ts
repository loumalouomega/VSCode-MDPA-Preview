import assert from "node:assert/strict";
import test from "node:test";

import { appendSeedPoint, buildStreamlineRequest, defaultStreamlineForm, parseVec3 } from "../parser/streamlineForm";

const form = (extra: Record<string, unknown>) => ({ ...defaultStreamlineForm(), variable: "V", ...extra });

test("vectors parse from spaces or commas and nothing else", () => {
  assert.deepEqual(parseVec3("1 2 3"), [1, 2, 3]);
  assert.deepEqual(parseVec3(" 1, 2 ,3 "), [1, 2, 3]);
  assert.equal(parseVec3("1 2"), undefined);
  assert.equal(parseVec3("1 2 x"), undefined);
  assert.equal(parseVec3("1 2 Infinity"), undefined);
});

test("point seeds: one per line, the bad line is named", () => {
  const ok = buildStreamlineRequest(form({ points: "0 0 0\n\n1, 2, 3\n" }));
  assert.ok(ok.ok && ok.request.seeds.kind === "points" && ok.request.seeds.points.length === 2);
  const bad = buildStreamlineRequest(form({ points: "0 0 0\n1 2" }));
  assert.ok(!bad.ok && /Seed point 2 \("1 2"\)/.test(bad.error));
  assert.ok(!buildStreamlineRequest(form({ points: "" })).ok);
});

test("line and plane seeds validate their counts, and blank bounds mean the module's defaults", () => {
  const line = buildStreamlineRequest(form({ seedKind: "line", lineFrom: "0 0 0", lineTo: "1 0 0", lineCount: "5" }));
  assert.ok(line.ok && line.request.maxSteps === undefined && line.request.maxLength === undefined);
  assert.ok(!buildStreamlineRequest(form({ seedKind: "line", lineFrom: "0 0 0", lineTo: "1 0 0", lineCount: "1" })).ok);
  assert.ok(!buildStreamlineRequest(form({ seedKind: "line", lineFrom: "0 0 0", lineCount: "5" })).ok);
  const plane = buildStreamlineRequest(form({ seedKind: "plane", planeOrigin: "0 0 0", planeU: "0 1 0", planeV: "0 0 1", planeNu: "3", planeNv: "2" }));
  assert.ok(plane.ok && plane.request.seeds.kind === "plane");
  assert.ok(!buildStreamlineRequest(form({ seedKind: "plane", planeOrigin: "0 0 0", planeU: "0 1 0", planeV: "0 0 1", planeNu: "0" })).ok);
});

test("a part seed needs a part; numeric bounds must be numbers, whole where they count things", () => {
  assert.ok(!buildStreamlineRequest(form({ seedKind: "part" })).ok);
  const part = buildStreamlineRequest(form({ seedKind: "part", part: "Inlet", maxSteps: "500", maxLength: "2.5", stepFraction: "0.1", direction: "both" }));
  assert.ok(part.ok);
  if (part.ok) {
    assert.equal(part.request.maxSteps, 500);
    assert.equal(part.request.maxLength, 2.5);
    assert.equal(part.request.stepFraction, 0.1);
    assert.equal(part.request.direction, "both");
  }
  const steps = buildStreamlineRequest(form({ seedKind: "part", part: "Inlet", maxSteps: "1.5" }));
  assert.ok(!steps.ok && /Max steps must be a whole number/.test(steps.error));
  assert.ok(!buildStreamlineRequest(form({ seedKind: "part", part: "Inlet", maxLength: "abc" })).ok);
  assert.ok(!buildStreamlineRequest({ ...defaultStreamlineForm(), seedKind: "part", part: "Inlet" }).ok, "no field picked");
});

test("a picked point is appended on its own line without float noise", () => {
  assert.equal(appendSeedPoint("", [0.1 + 0.2, 1, 2]), "0.3 1 2");
  assert.equal(appendSeedPoint("1 2 3\n", [4, 5, 6]), "1 2 3\n4 5 6");
});
