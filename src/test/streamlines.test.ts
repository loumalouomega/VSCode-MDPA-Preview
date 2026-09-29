import assert from "node:assert/strict";
import test from "node:test";

import { buildCellLocator } from "../parser/cellLocator";
import {
  STREAM_TERMINATION,
  describeStreamlines,
  resolveSeeds,
  streamlinePolylines,
  streamlinesToModel,
  traceStreamlines,
} from "../parser/streamlines";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { tetBar } from "./fixtures/shapes";

const parse = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/** An n x n grid of squares over [-half, half]^2, two triangles each (z = 0). */
function plane(n: number, half: number): MdpaModel {
  const at = (i: number, j: number): number => j * (n + 1) + i + 1;
  const nodes: string[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) nodes.push(`${at(i, j)} ${-half + (2 * half * i) / n} ${-half + (2 * half * j) / n} 0`);
  const tris: string[] = [];
  let id = 1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      tris.push(`${id++} 0 ${at(i, j)} ${at(i + 1, j)} ${at(i + 1, j + 1)}`);
      tris.push(`${id++} 0 ${at(i, j)} ${at(i + 1, j + 1)} ${at(i, j + 1)}`);
    }
  }
  return parse("Begin Nodes\n" + nodes.join("\n") + "\nEnd Nodes\nBegin Elements Element2D3N\n" + tris.join("\n") + "\nEnd Elements\n");
}

/** Attaches a Nodal vector field computed from each node's coordinates. */
function withField(m: MdpaModel, name: string, components: 2 | 3, fn: (x: number, y: number, z: number) => number[]): MdpaModel {
  const values = new Float64Array(m.nodeCount * components);
  for (let i = 0; i < m.nodeCount; i++) {
    const v = fn(m.coords[i * 3], m.coords[i * 3 + 1], m.coords[i * 3 + 2]);
    for (let k = 0; k < components; k++) values[i * components + k] = v[k];
  }
  return { ...m, fields: [...m.fields, { kind: "Nodal", variable: name, components, ids: Int32Array.from(m.nodeIds), values }] };
}

test("the locator finds the containing simplex with weights summing to 1, and nothing outside the mesh", () => {
  const loc = buildCellLocator(plane(4, 1))!;
  assert.equal(loc.dimension, 2);
  const hit = loc.locate([0.3, -0.2, 0])!;
  assert.ok(hit);
  assert.ok(Math.abs(hit.weights.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(loc.locate([1.5, 0, 0]), null);
  assert.equal(loc.locate([0, -1.0001, 0]), null);
  assert.equal(loc.locate([NaN, 0, 0]), null);
  assert.ok(loc.locate([1, 1, 0]), "a corner of the domain is inside");
  const tets = buildCellLocator(tetBar(3))!;
  assert.equal(tets.dimension, 3);
  assert.ok(tets.locate([1.5, 0.5, 0.5]));
  assert.equal(tets.locate([1.5, 0.5, 2]), null);
});

test("a uniform field gives a straight line that ends at the domain boundary", async () => {
  const bar = withField(tetBar(4), "V", 3, () => [2, 0, 0]);
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "points", points: [[0.5, 0.4, 0.6]] } });
  assert.equal(r.lines.length, 1);
  const l = r.lines[0];
  assert.equal(l.termination, STREAM_TERMINATION.leftDomain);
  const n = l.speed.length;
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(l.points[i * 3 + 1] - 0.4) < 1e-6 && Math.abs(l.points[i * 3 + 2] - 0.6) < 1e-6);
    assert.ok(Math.abs(l.speed[i] - 2) < 1e-9);
    if (i > 0) assert.ok(l.arclength[i] > l.arclength[i - 1]);
  }
  assert.ok(Math.abs(l.points[(n - 1) * 3] - l.arclength[n - 1] - 0.5) < 1e-6, "x advances exactly by arc length");
  assert.ok(l.points[(n - 1) * 3] > 3.9, `stopped ${4 - l.points[(n - 1) * 3]} short of the boundary`);
});

test("backward and both directions", async () => {
  const bar = withField(tetBar(4), "V", 3, () => [1, 0, 0]);
  const seeds = { kind: "points" as const, points: [[2.5, 0.5, 0.5] as [number, number, number]] };
  const back = await traceStreamlines(bar, { variable: "V", seeds, direction: "backward" });
  assert.equal(back.lines.length, 1);
  const bl = back.lines[0];
  assert.equal(bl.direction, -1);
  assert.ok(bl.points[(bl.speed.length - 1) * 3] < 0.1);
  assert.ok(Math.abs(bl.velocity[0] - 1) < 1e-9, "velocity is the field's own direction, not the traversal's");
  const both = await traceStreamlines(bar, { variable: "V", seeds, direction: "both" });
  assert.deepEqual(both.lines.map((x) => x.direction).sort(), [-1, 1]);
  assert.equal(both.lines[0].seedIndex, 0);
});

test("a rotational field closes on itself: one revolution returns within a small fraction of the radius", async () => {
  for (const comps of [2, 3] as const) {
    const m = withField(plane(40, 2), "V", comps, (x, y) => [-y, x, 0]);
    const r = await traceStreamlines(m, { variable: "V", seeds: { kind: "points", points: [[1, 0, 0]] }, maxLength: 2 * Math.PI, maxSteps: 20000 });
    const l = r.lines[0];
    assert.equal(l.termination, STREAM_TERMINATION.maxLength);
    const n = l.speed.length;
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(Math.hypot(l.points[i * 3], l.points[i * 3 + 1]) - 1));
    assert.ok(worst < 1e-3, `radius drift ${worst}`);
    const end = Math.hypot(l.points[(n - 1) * 3] - 1, l.points[(n - 1) * 3 + 1]);
    assert.ok(end < 5e-3, `did not close: ${end}`);
    assert.ok(Math.abs(l.arclength[n - 1] - 2 * Math.PI) < 1e-6);
  }
});

test("seeds that give no line are reported with the reason, never dropped", async () => {
  const m = withField(plane(8, 1), "V", 2, (x) => [x > 0.5 ? 0 : 1, 0, 0]);
  // outside the domain, and inside a zero-speed region
  const r = await traceStreamlines(m, { variable: "V", seeds: { kind: "points", points: [[5, 0, 0], [0.9, 0, 0], [-0.9, 0, 0]] } });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].seedIndex, 2);
  assert.equal(r.lines[0].termination, STREAM_TERMINATION.stagnation, "it runs into the stopped region");
  const byCode = Object.fromEntries(r.rejected.map((x) => [x.seedIndex, x.termination]));
  assert.equal(byCode[0], STREAM_TERMINATION.seedOutside);
  assert.equal(byCode[1], STREAM_TERMINATION.immediateStop);
  assert.match(describeStreamlines(r), /outside the domain/);
  assert.match(describeStreamlines(r), /stopped immediately/);
});

test("an identically zero field terminates every seed safely", async () => {
  const m = withField(plane(4, 1), "V", 2, () => [0, 0, 0]);
  const r = await traceStreamlines(m, { variable: "V", seeds: { kind: "line", from: [-0.5, 0, 0], to: [0.5, 0, 0], count: 3 } });
  assert.equal(r.lines.length, 0);
  assert.equal(r.rejected.length, 3);
  assert.ok(r.rejected.every((x) => x.termination === STREAM_TERMINATION.immediateStop));
});

test("a node with no value ends the line as missing data", async () => {
  const bar = withField(tetBar(4), "V", 3, (x) => (x >= 2 ? [NaN, NaN, NaN] : [1, 0, 0]));
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "points", points: [[0.5, 0.5, 0.5]] } });
  assert.equal(r.lines[0].termination, STREAM_TERMINATION.missingData);
  assert.ok(r.lines[0].points[(r.lines[0].speed.length - 1) * 3] < 2);
});

test("maxSteps and maxLength bound a line, and the cap is what ends it", async () => {
  const bar = withField(tetBar(4), "V", 3, () => [1, 0, 0]);
  const seeds = { kind: "points" as const, points: [[0.2, 0.5, 0.5] as [number, number, number]] };
  const steps = await traceStreamlines(bar, { variable: "V", seeds, maxSteps: 3 });
  assert.equal(steps.lines[0].termination, STREAM_TERMINATION.maxSteps);
  assert.equal(steps.lines[0].speed.length, 4);
  const len = await traceStreamlines(bar, { variable: "V", seeds, maxLength: 1.5 });
  assert.equal(len.lines[0].termination, STREAM_TERMINATION.maxLength);
  assert.ok(Math.abs(len.lines[0].arclength[len.lines[0].speed.length - 1] - 1.5) < 1e-9);
});

test("refusals are named: scalar and elemental fields, unknown variable, too many seeds, bad parameters", async () => {
  const bar = withField(tetBar(2), "V", 3, () => [1, 0, 0]);
  const seeds = { kind: "points" as const, points: [[0.5, 0.5, 0.5] as [number, number, number]] };
  await assert.rejects(traceStreamlines(bar, { variable: "T", seeds }), /2- or 3-component/);
  await assert.rejects(traceStreamlines(bar, { variable: "C", seeds }), /Elemental field.*Average field/);
  await assert.rejects(traceStreamlines(bar, { variable: "nope", seeds }), /Nodal vector fields: V/);
  await assert.rejects(traceStreamlines(bar, { variable: "V", seeds: { kind: "line", from: [0, 0, 0], to: [1, 0, 0], count: 50 }, maxSeeds: 10 }), /exceed the limit of 10/);
  await assert.rejects(traceStreamlines(bar, { variable: "V", seeds, stepFraction: 0 }), /stepFraction/);
  await assert.rejects(traceStreamlines(bar, { variable: "V", seeds, maxSteps: 0 }), /maxSteps/);
  await assert.rejects(traceStreamlines(bar, { variable: "V", seeds, direction: "sideways" as never }), /direction/);
});

test("an aborted signal returns the partial (here empty) result flagged as cancelled", async () => {
  const bar = withField(tetBar(2), "V", 3, () => [1, 0, 0]);
  const ac = new AbortController();
  ac.abort();
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "line", from: [0.1, 0.5, 0.5], to: [0.1, 0.9, 0.5], count: 4 } }, { signal: ac.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.lines.length, 0);
  assert.match(describeStreamlines(r), /cancelled/);
});

test("seed generation: line, plane and SubModelPart nodes", () => {
  const bar = tetBar(4);
  assert.deepEqual(resolveSeeds(bar, { kind: "line", from: [0, 0, 0], to: [1, 0, 0], count: 3 }, 100), [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]]);
  const grid = resolveSeeds(bar, { kind: "plane", origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], nu: 2, nv: 3 }, 100);
  assert.equal(grid.length, 6);
  assert.deepEqual(grid[5], [0, 1, 1]);
  assert.deepEqual(resolveSeeds(bar, { kind: "plane", origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], nu: 1, nv: 1 }, 100), [[0, 0.5, 0.5]]);
  const left = resolveSeeds(bar, { kind: "part", path: "Left" }, 100);
  assert.equal(left.length, 4);
  assert.ok(left.every((p) => p[0] === 0));
  assert.throws(() => resolveSeeds(bar, { kind: "part", path: "Nope" }, 100), /No SubModelPart/);
  assert.throws(() => resolveSeeds(bar, { kind: "points", points: [[0, 0, NaN]] }, 100), /finite/);
});

test("streamlines seeded from a SubModelPart trace inward from the inlet face", async () => {
  const bar = withField(tetBar(4), "V", 3, () => [1, 0, 0]);
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "part", path: "Left" } });
  assert.equal(r.lines.length, 4);
  assert.ok(r.lines.every((l) => l.termination === STREAM_TERMINATION.leftDomain));
});

test("the export model has one node per vertex, one Line2D2N per segment and numeric per-line fields", async () => {
  const bar = withField(tetBar(4), "V", 3, () => [1, 0, 0]);
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "points", points: [[0.5, 0.2, 0.5], [0.5, 0.8, 0.5]] }, direction: "both" });
  const m = streamlinesToModel(r);
  const vertices = r.lines.reduce((a, l) => a + l.speed.length, 0);
  assert.equal(m.nodeCount, vertices);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].name, "Line2D2N");
  assert.equal(m.blocks[0].stride, 2);
  assert.equal(m.blocks[0].count, vertices - r.lines.length);
  const by = (n: string) => m.fields.find((f) => f.variable === n)!;
  assert.equal(by("STREAM_VELOCITY").components, 3);
  assert.equal(by("STREAM_SPEED").ids.length, m.nodeCount);
  assert.equal(by("STREAM_TERMINATION").ids.length, m.blocks[0].count);
  assert.deepEqual([...new Set(by("STREAM_DIRECTION").values)].sort(), [-1, 1]);
  assert.deepEqual([...new Set(by("STREAM_SEED").values)].sort(), [0, 1]);
  // every segment joins two consecutive vertices of one line
  for (let s = 0; s < m.blocks[0].count; s++) assert.equal(m.blocks[0].connectivity[s * 2 + 1] - m.blocks[0].connectivity[s * 2], 1);
});

test("polylines for drawing use the legacy [n, i0..] layout over one shared point array", async () => {
  const bar = withField(tetBar(4), "V", 3, () => [1, 0, 0]);
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "line", from: [0.1, 0.2, 0.5], to: [0.1, 0.8, 0.5], count: 3 } });
  const d = streamlinePolylines(r);
  assert.equal(d.termination.length, 3);
  assert.equal(d.points.length / 3, d.speed.length);
  let w = 0;
  let seen = 0;
  for (let li = 0; li < 3; li++) {
    const n = d.lines[w++];
    for (let i = 0; i < n; i++, seen++) assert.equal(d.lines[w++], seen);
  }
  assert.equal(w, d.lines.length);
});
