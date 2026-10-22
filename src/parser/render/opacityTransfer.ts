// The opacity curve of a volume view (roadmap item 22 D) as plain data. The
// editor works in normalised coordinates (x: position in the scalar range,
// 0..1; a: opacity, 0..1); the backend receives it mapped into data units.

export interface OpacityPoint {
  x: number;
  a: number;
}

export interface OpacityPreset {
  id: string;
  label: string;
  points: OpacityPoint[];
}

export const OPACITY_PRESETS: OpacityPreset[] = [
  { id: "ramp", label: "Ramp (high values opaque)", points: [{ x: 0, a: 0 }, { x: 1, a: 1 }] },
  { id: "inverse", label: "Inverse ramp (low values opaque)", points: [{ x: 0, a: 1 }, { x: 1, a: 0 }] },
  { id: "shell", label: "Shell (mid values only)", points: [{ x: 0, a: 0 }, { x: 0.35, a: 0 }, { x: 0.5, a: 0.9 }, { x: 0.65, a: 0 }, { x: 1, a: 0 }] },
  { id: "faint", label: "Faint (see through everything)", points: [{ x: 0, a: 0 }, { x: 1, a: 0.25 }] },
];

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * A usable curve: values clamped to 0..1, sorted by x, an x repeated within
 * 1e-3 collapsed to its last opacity, and the ends pinned at x = 0 and x = 1
 * (a curve that stopped short would make the rest of the range transparent
 * by accident). Fewer than two points fall back to the default ramp.
 */
export function normalizeOpacityPoints(points: readonly OpacityPoint[]): OpacityPoint[] {
  const sorted = points.map((p) => ({ x: clamp01(p.x), a: clamp01(p.a) })).sort((p, q) => p.x - q.x);
  const out: OpacityPoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.x - last.x < 1e-3) last.a = p.a;
    else out.push({ ...p });
  }
  if (out.length < 2) return OPACITY_PRESETS[0].points.map((p) => ({ ...p }));
  out[0].x = 0;
  out[out.length - 1].x = 1;
  return out;
}

/** Flat `[x0, a0, x1, a1, …]` in data units over `range`. */
export function opacityToData(points: readonly OpacityPoint[], range: [number, number]): number[] {
  const [lo, hi] = range;
  const span = hi > lo ? hi - lo : 1;
  const out: number[] = [];
  for (const p of normalizeOpacityPoints(points)) out.push(lo + p.x * span, p.a);
  return out;
}

/** Add a point at x (the curve's value there), or move the nearest within `grab`. */
export function insertOpacityPoint(points: readonly OpacityPoint[], x: number, a: number): OpacityPoint[] {
  return normalizeOpacityPoints([...points, { x, a }]);
}

/** Remove an interior point; the two end points are never removed. */
export function removeOpacityPoint(points: readonly OpacityPoint[], index: number): OpacityPoint[] {
  if (index <= 0 || index >= points.length - 1) return points.map((p) => ({ ...p }));
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }));
}
