// Pure scalar-semantics helpers behind the webview's field visualization (and,
// later, host-side whole-timeline range scans): vector component selection,
// scalar ranges, and colormap-stop transforms (log scale, discrete bands).
// No vscode/DOM/vtk imports — Node-testable like the rest of src/parser/.

import { FieldData } from "./types";

/** Which scalar a (possibly vector) field yields: magnitude or one component. */
export type FieldComponent = "mag" | 0 | 1 | 2;

export const FIELD_COMPONENTS: FieldComponent[] = ["mag", 0, 1, 2];

export function componentLabel(component: FieldComponent): string {
  return component === "mag" ? "Magnitude" : "XYZ"[component];
}

/** Scalar value of row `i` for the requested component (magnitude for vectors). */
export function componentScalar(
  field: FieldData,
  i: number,
  component: FieldComponent = "mag"
): number {
  const c = field.components;
  if (c <= 1) return field.values[i];
  if (component === "mag") {
    let sum = 0;
    for (let k = 0; k < c; k++) {
      const v = field.values[i * c + k];
      sum += v * v;
    }
    return Math.sqrt(sum);
  }
  return component < c ? field.values[i * c + component] : 0;
}

/**
 * The [min, max] over a field's rows for a component. Non-finite values are
 * skipped (NaN marks an absent row in sparse fields); an empty/all-NaN field
 * yields [0, 0].
 */
export function computeFieldRange(
  field: FieldData,
  component: FieldComponent = "mag"
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.ids.length; i++) {
    const s = componentScalar(field, i, component);
    if (!Number.isFinite(s)) continue;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (!Number.isFinite(min)) return [0, 0];
  return [min, max];
}

/**
 * The range the colormap actually spans: a user override wins over the data
 * range. The override is normalized (lo ≤ hi) so swapped inputs cannot
 * invert the map.
 */
export function effectiveRange(
  dataRange: [number, number],
  override?: [number, number]
): [number, number] {
  if (!override || !Number.isFinite(override[0]) || !Number.isFinite(override[1])) {
    return dataRange;
  }
  return override[0] <= override[1] ? [override[0], override[1]] : [override[1], override[0]];
}

/** Log color mapping needs a strictly positive, non-degenerate range. */
export function canLogScale(min: number, max: number): boolean {
  return min > 0 && max > min;
}

/**
 * Normalized position of a value in [min, max] — linear, or logarithmic when
 * `log` (caller guards with canLogScale). Clamped to [0, 1].
 */
export function normValue(v: number, min: number, max: number, log = false): number {
  let t: number;
  if (log && canLogScale(min, max)) {
    t = v <= 0 ? 0 : Math.log(v / min) / Math.log(max / min);
  } else {
    const span = max - min;
    t = span > 0 ? (v - min) / span : 0.5;
  }
  return Math.max(0, Math.min(1, t));
}

// --- Colormap stops ------------------------------------------------------
// A colormap is an ordered list of stops [t, r, g, b] with t ∈ [0,1] and rgb
// ∈ [0,1]. The same stop list drives the vtk color transfer function, the DOM
// legend gradient and direct color lookups, so transforming the stops once
// transforms every consumer consistently.

export type ColorStop = [t: number, r: number, g: number, b: number];

/** Linearly interpolated RGB at normalized position t along the stop list. */
export function interpolateStops(stops: ColorStop[], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1];
      const [t1, r1, g1, b1] = stops[i];
      const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

export interface StopTransform {
  /** Logarithmic value→color mapping. Ignored unless canLogScale(min, max). */
  log?: boolean;
  /** Discrete bands (piecewise-constant colors). 0/undefined = continuous. */
  bands?: number;
  /** The effective scalar range the stops will be stretched over. */
  min: number;
  max: number;
}

/** Half the band-boundary gap: bands read as hard edges, CTFs stay monotonic. */
const BAND_EDGE = 1e-4;

/**
 * Transforms a colormap's stops for display: log scale re-spaces the colors so
 * a LINEAR placement over [min, max] (which is what a vtk CTF and a CSS
 * gradient both do) yields logarithmic coloring; banding replaces the gradient
 * with N constant bands (log-spaced boundaries when both are on). The result
 * is an ordinary stop list — every consumer (CTF, legend gradient,
 * interpolateStops) works on it unchanged.
 */
export function transformStops(stops: ColorStop[], opts: StopTransform): ColorStop[] {
  const log = !!opts.log && canLogScale(opts.min, opts.max);
  const bands = opts.bands && opts.bands >= 2 ? Math.floor(opts.bands) : 0;

  // Linear position in [min,max] of the value whose log-normalized position is t.
  const posOf = (t: number): number => {
    if (!log) return t;
    const v = opts.min * Math.pow(opts.max / opts.min, t);
    return (v - opts.min) / (opts.max - opts.min);
  };

  if (bands) {
    const out: ColorStop[] = [];
    for (let k = 0; k < bands; k++) {
      const [r, g, b] = interpolateStops(stops, (k + 0.5) / bands);
      const lo = posOf(k / bands);
      const hi = posOf((k + 1) / bands);
      out.push([lo === 0 ? 0 : lo + BAND_EDGE, r, g, b]);
      out.push([hi === 1 ? 1 : hi - BAND_EDGE, r, g, b]);
    }
    return out;
  }

  if (!log) return stops;
  // Resample the continuous map at log-spaced values so linear interpolation
  // between the new stops approximates the log mapping.
  const SAMPLES = 32;
  const out: ColorStop[] = [];
  for (let k = 0; k <= SAMPLES; k++) {
    const t = k / SAMPLES;
    const [r, g, b] = interpolateStops(stops, t);
    out.push([posOf(t), r, g, b]);
  }
  return out;
}

/**
 * The legend's tick values (low → high). Linear ticks are evenly spaced;
 * log ticks are geometrically spaced (so the middle tick is the geometric
 * mean, matching where the middle color actually lands).
 */
export function legendTicks(min: number, max: number, log = false, count = 3): number[] {
  const n = Math.max(2, count);
  const ticks: number[] = [];
  const useLog = log && canLogScale(min, max);
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    ticks.push(useLog ? min * Math.pow(max / min, t) : min + t * (max - min));
  }
  return ticks;
}

/** Evenly spaced interior iso values (endpoints excluded — they yield nothing). */
export function spacedIsoValues(min: number, max: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  const out: number[] = [];
  for (let k = 1; k <= n; k++) {
    out.push(min + (k / (n + 1)) * (max - min));
  }
  return out;
}
