import assert from "node:assert/strict";
import test from "node:test";

import { streamlinePolylines, traceStreamlines } from "../parser/streamlines";
import {
  buildStreamlineTubes,
  countTubeLineVertices,
  estimateStreamlineTubeVertices,
  STREAMLINE_TUBE_MAX_VERTICES,
} from "../parser/streamlineTubes";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { tetBar } from "./fixtures/shapes";

const parse = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

function withField(m: MdpaModel, name: string, fn: (x: number, y: number, z: number) => number[]): MdpaModel {
  const values = new Float64Array(m.nodeCount * 3);
  for (let i = 0; i < m.nodeCount; i++) {
    const v = fn(m.coords[i * 3], m.coords[i * 3 + 1], m.coords[i * 3 + 2]);
    for (let k = 0; k < 3; k++) values[i * 3 + k] = v[k];
  }
  return { ...m, fields: [...m.fields, { kind: "Nodal", variable: name, components: 3, ids: Int32Array.from(m.nodeIds), values }] };
}

async function straightTubes() {
  const bar = withField(tetBar(4), "V", () => [2, 0, 0]);
  const r = await traceStreamlines(bar, { variable: "V", seeds: { kind: "points", points: [[0.5, 0.4, 0.6]] } });
  const d = streamlinePolylines(r);
  return { r, d };
}

test("a straight line grows a tube of the requested radius with one ring per vertex", async () => {
  const { d } = await straightTubes();
  const verts = d.speed.length;
  const radius = 0.05;
  const sides = 8;
  const g = buildStreamlineTubes(d.points, d.lines, d.speed, { radius, sides });
  assert.equal(g.points.length / 3, verts * sides);
  assert.equal(g.pointScalars?.name, "speed");
  assert.equal(g.pointScalars?.values.length, verts * sides);
  // Every ring vertex sits exactly one radius from its centreline point.
  for (let i = 0; i < verts; i++) {
    const cx = d.points[i * 3];
    for (let j = 0; j < sides; j++) {
      const o = (i * sides + j) * 3;
      const dist = Math.hypot(g.points[o] - cx, g.points[o + 1] - 0.4, g.points[o + 2] - 0.6);
      assert.ok(Math.abs(dist - radius) < 1e-6, `ring ${i} side ${j}: ${dist}`); // float32 storage
    }
  }
  // One outward quad per segment per side, stored as [4, a, b, c, d].
  const quads = (verts - 1) * sides;
  assert.equal(g.polys?.length, quads * 5);
  assert.equal(countTubeLineVertices(d.lines), verts);
  assert.equal(estimateStreamlineTubeVertices(d.lines, sides), verts * sides);
});

test("tube quads are wound outward", async () => {
  const { d } = await straightTubes();
  const sides = 6;
  const g = buildStreamlineTubes(d.points, d.lines, d.speed, { radius: 0.05, sides });
  const P = (i: number): [number, number, number] => [g.points[i * 3], g.points[i * 3 + 1], g.points[i * 3 + 2]];
  // First quad: A=R(0,0), B=R(0,1), C=R(1,1) — (B−A)×(C−A) must point away
  // from the centreline (radially outward at ring 0, side 0).
  const a = g.polys!.slice(1, 5);
  const sub = (p: [number, number, number], q: [number, number, number]): [number, number, number] => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p: [number, number, number], q: [number, number, number]): [number, number, number] => [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
  const n = cross(sub(P(a[1]), P(a[0])), sub(P(a[2]), P(a[0])));
  const radial = sub(P(a[0]), [d.points[0], 0.4, 0.6]);
  const dot = n[0] * radial[0] + n[1] * radial[1] + n[2] * radial[2];
  assert.ok(dot > 0, "the first quad faces outward");
});

test("speed rides the rings and a second line starts on a fresh base", async () => {
  const bar = withField(tetBar(4), "V", () => [1, 0, 0]);
  const r = await traceStreamlines(bar, {
    variable: "V",
    seeds: { kind: "points", points: [[0.5, 0.2, 0.5], [0.5, 0.8, 0.5]] },
  });
  assert.equal(r.lines.length, 2);
  const d = streamlinePolylines(r);
  const g = buildStreamlineTubes(d.points, d.lines, d.speed, { radius: 0.02, sides: 6 });
  // Ring vertex (line 2, vertex 0, side 0) carries line 2's first speed…
  const firstLen = r.lines[0].speed.length;
  assert.ok(Math.abs(g.pointScalars!.values[firstLen * 6] - r.lines[1].speed[0]) < 1e-12);
  // …and sits on line 2's centreline, not line 1's.
  const o = firstLen * 6 * 3;
  assert.ok(Math.abs(g.points[o + 1] - 0.8) < 0.03 && Math.abs(g.points[o + 2] - 0.5) < 0.03);
});

test("coincident samples do not produce NaN vertices", async () => {
  // A hand-built polyline with a zero-length step in the middle.
  const points = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);
  const lines = new Uint32Array([4, 0, 1, 2, 3]);
  const speed = new Float32Array([1, 1, 1, 1]);
  const g = buildStreamlineTubes(points, lines, speed, { radius: 0.1, sides: 6 });
  assert.equal(g.points.length / 3, 4 * 6);
  for (const v of g.points) assert.ok(Number.isFinite(v));
});

test("empty input is empty geometry, and bad options or an over-budget layer throw", async () => {
  const empty = buildStreamlineTubes(new Float32Array(0), new Uint32Array(0), new Float32Array(0), { radius: 0.1, sides: 8 });
  assert.equal(empty.points.length, 0);
  const { d } = await straightTubes();
  assert.throws(() => buildStreamlineTubes(d.points, d.lines, d.speed, { radius: 0, sides: 8 }), /positive radius/);
  assert.throws(() => buildStreamlineTubes(d.points, d.lines, d.speed, { radius: 0.1, sides: 2 }), /at least 3 sides/);
  // A claimed 500k-vertex line at 8 sides exceeds the budget without allocating it.
  assert.throws(
    () => buildStreamlineTubes(new Float32Array(0), new Uint32Array([500000, 0]), new Float32Array(0), { radius: 0.1, sides: 8 }),
    /over the .* budget/
  );
  assert.ok(STREAMLINE_TUBE_MAX_VERTICES >= 1_000_000);
});

test("a curved line keeps a constant radius (parallel transport does not twist)", async () => {
  const rot = (x: number, y: number): number[] => [-y, x, 0];
  const disc: MdpaModel = (() => {
    const n = 12;
    const half = 2;
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
    const m = parse("Begin Nodes\n" + nodes.join("\n") + "\nEnd Nodes\nBegin Elements Element2D3N\n" + tris.join("\n") + "\nEnd Elements\n");
    const values = new Float64Array(m.nodeCount * 2);
    for (let i = 0; i < m.nodeCount; i++) {
      const v = rot(m.coords[i * 3], m.coords[i * 3 + 1]);
      values[i * 2] = v[0];
      values[i * 2 + 1] = v[1];
    }
    return { ...m, fields: [...m.fields, { kind: "Nodal", variable: "V", components: 2, ids: Int32Array.from(m.nodeIds), values }] };
  })();
  const r = await traceStreamlines(disc, { variable: "V", seeds: { kind: "points", points: [[1, 0, 0]] }, maxLength: 3, maxSteps: 5000 });
  assert.ok(r.lines.length === 1);
  const d = streamlinePolylines(r);
  const radius = 0.03;
  const g = buildStreamlineTubes(d.points, d.lines, d.speed, { radius, sides: 8 });
  // Distance from each ring vertex to its own centreline point stays the radius.
  for (let i = 0; i < d.speed.length; i++) {
    for (let j = 0; j < 8; j += 3) {
      const o = (i * 8 + j) * 3;
      const dist = Math.hypot(g.points[o] - d.points[i * 3], g.points[o + 1] - d.points[i * 3 + 1], g.points[o + 2] - d.points[i * 3 + 2]);
      assert.ok(Math.abs(dist - radius) < 1e-6, `vertex ${i}: ${dist}`); // float32 storage
    }
  }
});
