import assert from "node:assert/strict";
import test from "node:test";

import { appendSeedPoint, buildStreamlineRequest, defaultStreamlineForm, parseVec3 } from "../parser/streamlineForm";
import {
  defaultStreamlineStyle,
  formatVec3,
  planeSeedsFromClip,
  previewSeedPoints,
} from "../parser/streamlineForm";
import { resolveSeeds } from "../parser/streamlines";
import { tetBar } from "./fixtures/shapes";

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
  assert.equal(formatVec3([0.1 + 0.2, 1, 2]), "0.3 1 2");
});

test("the style default is lines at 2.5px", () => {
  assert.deepEqual(defaultStreamlineStyle(), { mode: "lines", lineWidth: 2.5, tubeRadiusFraction: 0.005, tubeSides: 8 });
});

test("a clip plane seeds its own position: axis modes span the box extents", () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [4, 2, 1] as [number, number, number] };
  const clip = (axis: 0 | 1 | 2 | "free", t = 0.5, flipped = false, freeNormal: [number, number, number] = [0, 0, 1]) => ({
    active: false,
    axis,
    flipped,
    freeNormal,
    t,
  });
  const z = planeSeedsFromClip(bounds, clip(2), 2, 3);
  assert.ok(z.kind === "plane");
  if (z.kind === "plane") {
    assert.deepEqual(z.origin, [0, 0, 0.5]);
    assert.deepEqual(z.u, [4, 0, 0]);
    assert.deepEqual(z.v, [0, 2, 0]);
  }
  const x = planeSeedsFromClip(bounds, clip(0, 0.25), 1, 1);
  assert.ok(x.kind === "plane" && x.nu === 1 && x.nv === 1);
  if (x.kind === "plane") assert.deepEqual(x.origin, [1, 0, 0]);
  // Flipping only negates the plane normal, never its position.
  const flipped = planeSeedsFromClip(bounds, clip(2, 0.5, true), 2, 2);
  assert.ok(flipped.kind === "plane");
  if (flipped.kind === "plane" && z.kind === "plane") assert.deepEqual(flipped.origin, z.origin);
  assert.throws(() => planeSeedsFromClip(bounds, clip(2), 0, 2), /whole-number/);
});

test("a free-normal clip plane seeds the tight projected rectangle", () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [4, 2, 1] as [number, number, number] };
  const seeds = planeSeedsFromClip(
    bounds,
    { active: true, axis: "free", flipped: false, freeNormal: [0, 0, 1], t: 0.5 },
    3,
    2
  );
  assert.ok(seeds.kind === "plane");
  if (seeds.kind !== "plane") return;
  // Every lattice point lies on the plane z = 0.5 and together they span the box face.
  const pts = previewSeedPoints(seeds)!;
  assert.equal(pts.length, 6);
  for (const p of pts) assert.ok(Math.abs(p[2] - 0.5) < 1e-9);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  assert.ok(Math.min(...xs) === 0 && Math.max(...xs) === 4);
  assert.ok(Math.min(...ys) === 0 && Math.max(...ys) === 2);
  assert.throws(
    () =>
      planeSeedsFromClip(bounds, { active: true, axis: "free", flipped: false, freeNormal: [0, 0, 0], t: 0.5 }, 2, 2),
    /degenerate/
  );
});

test("seed previews mirror the host lattice math; a part previews as nothing", () => {
  const bar = tetBar(2);
  const line = { kind: "line" as const, from: [0, 0, 0] as [number, number, number], to: [1, 0, 0] as [number, number, number], count: 3 };
  assert.deepEqual(previewSeedPoints(line), resolveSeeds(bar, line, 100));
  const plane = {
    kind: "plane" as const,
    origin: [0, 0, 0] as [number, number, number],
    u: [0, 1, 0] as [number, number, number],
    v: [0, 0, 1] as [number, number, number],
    nu: 2,
    nv: 2,
  };
  assert.deepEqual(previewSeedPoints(plane), resolveSeeds(bar, plane, 100));
  assert.deepEqual(previewSeedPoints({ kind: "points", points: [[1, 2, 3]] }), [[1, 2, 3]]);
  assert.equal(previewSeedPoints({ kind: "part", path: "Left" }), undefined);
});
