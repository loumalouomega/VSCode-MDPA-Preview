/**
 * Streamtube surfaces for traced streamlines (roadmap item 9).
 *
 * The renderer has no tube filter — `DisplayGeometry` only carries verts,
 * lines and polys — so tubes are generated here as an ordinary triangle mesh:
 * a surface of revolution around each traced polyline, carried as `polys`
 * with the speed as point scalars so the existing speed colouring applies
 * unchanged. View-only: the exported mesh (`streamlinesToModel`) stays line
 * cells; this never touches it.
 *
 * Frames use parallel transport (each ring's normal is the previous ring's
 * with the new tangent projected out) so the tube does not twist along the
 * line. Quads are wound outward (see the derivation in the code).
 *
 * Pure module: no vscode / DOM / vtk.js / wasm imports.
 */

import type { DisplayGeometry } from "./render/types";

/** Ceiling on ring vertices of one tube layer, so sides x seeds cannot exhaust memory. */
export const STREAMLINE_TUBE_MAX_VERTICES = 2_000_000;

export interface StreamlineTubeOptions {
  /** Absolute tube radius, in mesh units. Must be finite and > 0. */
  radius: number;
  /** Ring resolution. Must be an integer >= 3. */
  sides: number;
}

/** Total polyline vertices in a legacy `[n, i0..]*` line array. */
export function countTubeLineVertices(lines: Uint32Array): number {
  let total = 0;
  let w = 0;
  while (w < lines.length) {
    const n = lines[w++];
    total += n;
    w += n;
  }
  return total;
}

/** Ring vertices a tube layer would need — the budget check before building. */
export function estimateStreamlineTubeVertices(lines: Uint32Array, sides: number): number {
  return countTubeLineVertices(lines) * sides;
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** An arbitrary unit vector far from parallel to `t`. */
function arbitraryNormal(t: V3): V3 {
  const candidates: V3[] = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];
  for (const c of candidates) {
    const d = dot(t, c);
    const n: V3 = [c[0] - t[0] * d, c[1] - t[1] * d, c[2] - t[2] * d];
    const l = len(n);
    if (l > 1e-6) return [n[0] / l, n[1] / l, n[2] / l];
  }
  return [1, 0, 0];
}

/**
 * One tube surface per polyline in the legacy flat layout (`streamlinePolylines`).
 * `speed` rides along as point scalars, so the layer colours exactly like the
 * line overlay. Throws on a non-positive radius, fewer than 3 sides, or a
 * layer over `STREAMLINE_TUBE_MAX_VERTICES` ring vertices (the caller falls
 * back to lines and says so).
 */
export function buildStreamlineTubes(
  points: Float32Array,
  lines: Uint32Array,
  speed: Float32Array,
  opts: StreamlineTubeOptions
): DisplayGeometry {
  if (!(opts.radius > 0 && Number.isFinite(opts.radius))) {
    throw new Error("A streamtube needs a positive radius.");
  }
  if (!Number.isInteger(opts.sides) || opts.sides < 3) {
    throw new Error("A streamtube needs at least 3 sides.");
  }
  const sides = opts.sides;
  const ringVerts = estimateStreamlineTubeVertices(lines, sides);
  if (ringVerts > STREAMLINE_TUBE_MAX_VERTICES) {
    throw new Error(
      `Tubes would need ${ringVerts.toLocaleString("en-US")} ring vertices (over the ${STREAMLINE_TUBE_MAX_VERTICES.toLocaleString("en-US")} budget).`
    );
  }
  if (ringVerts === 0) {
    return { points: new Float32Array(0), polys: new Uint32Array(0) };
  }
  const out = new Float32Array(ringVerts * 3);
  const outSpeed = new Float32Array(ringVerts);
  // One quad per segment per side, stored as [4, a, b, c, d].
  let quads = 0;
  {
    let w = 0;
    while (w < lines.length) {
      const n = lines[w++];
      if (n >= 2) quads += (n - 1) * sides;
      w += n;
    }
  }
  const polys = new Uint32Array(quads * 5);

  const at = (i: number): V3 => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  let ringBase = 0; // first ring vertex of the current line
  let qw = 0; // write cursor into polys
  let w = 0;
  while (w < lines.length) {
    const n = lines[w++];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(lines[w++]);
    if (n < 2) {
      continue;
    }
    // Tangents per vertex: central differences, one-sided at the ends. A
    // zero-length step (two coincident samples) reuses the previous tangent
    // rather than inventing a direction.
    const tangents: V3[] = [];
    let prev: V3 = [1, 0, 0];
    for (let i = 0; i < n; i++) {
      const a = at(idx[Math.max(0, i - 1)]);
      const b = at(idx[Math.min(n - 1, i + 1)]);
      const d = sub(b, a);
      const l = len(d);
      const t: V3 = l > 1e-12 ? [d[0] / l, d[1] / l, d[2] / l] : prev;
      tangents.push(t);
      prev = t;
    }
    // Parallel-transport rings.
    let normal = arbitraryNormal(tangents[0]);
    for (let i = 0; i < n; i++) {
      const t = tangents[i];
      const d = dot(normal, t);
      let cur: V3 = [normal[0] - t[0] * d, normal[1] - t[1] * d, normal[2] - t[2] * d];
      if (len(cur) < 1e-9) cur = arbitraryNormal(t);
      else cur = [cur[0] / len(cur), cur[1] / len(cur), cur[2] / len(cur)];
      const bin = cross(t, cur);
      const c = at(idx[i]);
      for (let j = 0; j < sides; j++) {
        const a = (2 * Math.PI * j) / sides;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const o = ringBase + i * sides + j;
        out[o * 3] = c[0] + opts.radius * (ca * cur[0] + sa * bin[0]);
        out[o * 3 + 1] = c[1] + opts.radius * (ca * cur[1] + sa * bin[1]);
        out[o * 3 + 2] = c[2] + opts.radius * (ca * cur[2] + sa * bin[2]);
        outSpeed[o] = speed[idx[i]];
      }
      normal = cur;
    }
    // Outward-wound quads between consecutive rings: with e the outward
    // radial, (B−A)×(C−A) = +e for A=R(i,j), B=R(i,j+1), C=R(i+1,j+1)
    // (VTK splits the quad as (A,B,C)+(A,C,D)), so D=R(i+1,j) closes it.
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < sides; j++) {
        const j1 = (j + 1) % sides;
        polys[qw++] = 4;
        polys[qw++] = ringBase + i * sides + j;
        polys[qw++] = ringBase + i * sides + j1;
        polys[qw++] = ringBase + (i + 1) * sides + j1;
        polys[qw++] = ringBase + (i + 1) * sides + j;
      }
    }
    ringBase += n * sides;
  }
  return { points: out, polys, pointScalars: { name: "speed", values: outSpeed } };
}
