// Pure maths behind the interactive widgets (roadmap item 22 C). The clip
// plane has ONE source of truth, `PaneClipState`; the draggable handle is a
// view of it, so both directions of the mapping live here and are tested as a
// round trip. Also the angle and polyline measures the Inspect panel reports.

import type { ClipAxis, PaneClipState } from "../paneView";
import type { Vec3 } from "./types";

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface PlaneState {
  origin: Vec3;
  /** Unit length. */
  normal: Vec3;
}

/** Range of dot(p, n) over a box, the span the Clip slider runs along. */
export function projectedRange(b: Box, n: Vec3): [number, number] {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 3; i++) {
    const a = n[i] * b.min[i];
    const c = n[i] * b.max[i];
    lo += Math.min(a, c);
    hi += Math.max(a, c);
  }
  return [lo, hi];
}

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** The plane a clip state describes over `box` (what the GPU clip uses). */
export function planeFromClip(clip: Pick<PaneClipState, "axis" | "flipped" | "freeNormal" | "t">, box: Box): PlaneState {
  if (clip.axis === "free") {
    const f = clip.freeNormal;
    const len = Math.hypot(f[0], f[1], f[2]);
    let normal: Vec3 = len > 1e-9 ? [f[0] / len, f[1] / len, f[2] / len] : [0, 0, 1];
    if (clip.flipped) normal = [-normal[0], -normal[1], -normal[2]];
    const [lo, hi] = projectedRange(box, normal);
    const dist = lo + clip.t * (hi - lo);
    // normal * dist is a point on the plane because normal is unit length.
    return { origin: [normal[0] * dist, normal[1] * dist, normal[2] * dist], normal };
  }
  const n = AXES[clip.axis];
  const normal: Vec3 = clip.flipped ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
  const origin: Vec3 = [0, 0, 0];
  origin[clip.axis] = box.min[clip.axis] + clip.t * (box.max[clip.axis] - box.min[clip.axis]);
  return { origin, normal };
}

/**
 * The clip state for a dragged plane: an axis preset when the normal is within
 * `snapDegrees` of a coordinate axis (so dragging back to square lands on the
 * X/Y/Z preset the segmented control shows), otherwise the Free mode. `t` is
 * clamped to 0..1, so a handle dragged outside the model parks on its face.
 * A zero normal keeps the previous state's normal.
 */
export function clipFromPlane(
  plane: PlaneState,
  box: Box,
  previous: PaneClipState,
  snapDegrees = 2
): Pick<PaneClipState, "axis" | "flipped" | "freeNormal" | "t"> {
  const len = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  if (len < 1e-9) return { axis: previous.axis, flipped: previous.flipped, freeNormal: previous.freeNormal, t: previous.t };
  const n: Vec3 = [plane.normal[0] / len, plane.normal[1] / len, plane.normal[2] / len];
  const cosSnap = Math.cos((snapDegrees * Math.PI) / 180);
  const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  for (let a = 0; a < 3; a++) {
    if (Math.abs(n[a]) >= cosSnap) {
      const span = box.max[a] - box.min[a];
      return {
        axis: a as ClipAxis,
        flipped: n[a] < 0,
        freeNormal: previous.freeNormal,
        t: span > 0 ? clamp01((plane.origin[a] - box.min[a]) / span) : 0,
      };
    }
  }
  const [lo, hi] = projectedRange(box, n);
  const dist = plane.origin[0] * n[0] + plane.origin[1] * n[1] + plane.origin[2] * n[2];
  return { axis: "free", flipped: false, freeNormal: n, t: hi > lo ? clamp01((dist - lo) / (hi - lo)) : 0 };
}

/** Interior angle at `b` between the rays to `a` and `c`, degrees (0 if degenerate). */
export function angleAt(a: Vec3, b: Vec3, c: Vec3): number {
  const u: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const v: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** Total length of a polyline. */
export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  }
  return total;
}
