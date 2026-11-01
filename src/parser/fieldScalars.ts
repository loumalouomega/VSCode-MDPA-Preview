// Pure scalar-semantics helpers behind the webview's field visualization (and,
// later, host-side whole-timeline range scans): vector component selection,
// scalar ranges, and colormap-stop transforms (log scale, discrete bands).
// No vscode/DOM/vtk imports — Node-testable like the rest of src/parser/.

import { FieldData } from "./types";

/** Which scalar a (possibly vector) field yields: magnitude or one component. */
export type FieldComponent = "mag" | number;

/** The selectable components of a field `width` components wide: magnitude, then one per column. */
export function fieldComponents(width: number): FieldComponent[] {
  const out: FieldComponent[] = ["mag"];
  for (let k = 0; k < Math.max(0, width); k++) out.push(k);
  return out;
}

/**
 * The label for one component. Widths 2 and 3 are vectors and read X/Y/Z; any
 * wider field is named by INDEX, exactly as `dataTable.ts`'s
 * `componentColumnNames` names its columns (`H_0 … H_8`), so a legend, a table
 * column and a chart line can never disagree about which one is "the fifth".
 * A 3x3 (9) or 2x2 (4) tensor additionally shows its row-major position.
 */
export function componentLabel(component: FieldComponent, width?: number): string {
  if (component === "mag") return "Magnitude";
  if (width === undefined || width <= 3) return "XYZ"[component] ?? String(component);
  const side = width === 9 ? 3 : width === 4 ? 2 : 0;
  if (side === 0) return String(component);
  return `${component} (${"XYZ"[Math.floor(component / side)]}${"XYZ"[component % side]})`;
}

/** A component that no longer fits a (narrower) field falls back to magnitude. */
export function clampComponent(component: FieldComponent, width: number): FieldComponent {
  return component === "mag" || component < width ? component : "mag";
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

/** Largest 1/2/5 x 10^n value that is <= v (v > 0 and finite). */
export function floorNice125(v: number): number {
  const e = Math.floor(Math.log10(v));
  const base = Math.pow(10, e);
  const m = v / base;
  const nice = m >= 5 ? 5 : m >= 2 ? 2 : 1;
  return nice * base;
}

/**
 * Automatic deformation scale: draws the largest displacement at about 10 % of
 * the bounding-box diagonal, rounded DOWN to a 1/2/5 x 10^n factor a person
 * would type. Returns 1 when either input is zero or not finite (nothing to
 * scale against). Display only.
 */
export function autoDeformScale(maxMagnitude: number, bboxDiagonal: number): number {
  if (!(maxMagnitude > 0) || !(bboxDiagonal > 0)) return 1;
  if (!Number.isFinite(maxMagnitude) || !Number.isFinite(bboxDiagonal)) return 1;
  const raw = (0.1 * bboxDiagonal) / maxMagnitude;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return floorNice125(raw);
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

/**
 * True when a range is a constant field in disguise: solver round-off (relative
 * 1e-9 of the magnitude) must not be spread over the whole colormap.
 */
export function isConstantRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  const mag = Math.max(Math.abs(min), Math.abs(max));
  return max - min <= 1e-9 * (mag > 0 ? mag : 1e-300);
}

/** Symmetric range [-m, m] with m = max |value|. */
export function symmetricRange(min: number, max: number): [number, number] {
  const m = Math.max(Math.abs(min), Math.abs(max));
  return [-m, m];
}

export interface ResolvedRange {
  /** The [lo, hi] the colormap spans (widened around a constant field). */
  range: [number, number];
  /** The field is constant within round-off (and no manual override applies). */
  constant: boolean;
  /** The constant's value when `constant`. */
  constantValue?: number;
}

/**
 * Resolution order: manual override > symmetric > data range. A constant data
 * range (no override, not symmetric-forced) is widened to a non-degenerate
 * interval so it draws in ONE colour, and flagged so the legend can say so.
 */
export function resolveColorRange(
  dataRange: [number, number],
  override?: [number, number],
  symmetric = false
): ResolvedRange {
  if (override && Number.isFinite(override[0]) && Number.isFinite(override[1])) {
    return { range: effectiveRange(dataRange, override), constant: false };
  }
  if (isConstantRange(dataRange[0], dataRange[1])) {
    const v = (dataRange[0] + dataRange[1]) / 2;
    const d = Math.abs(v) > 0 ? Math.abs(v) * 1e-3 : 1;
    return { range: [v - d, v + d], constant: true, constantValue: v };
  }
  return { range: symmetric ? symmetricRange(dataRange[0], dataRange[1]) : dataRange, constant: false };
}

export interface FieldExtreme {
  value: number;
  /** Row index into the field's ids/values. */
  row: number;
  /** Entity id holding it. */
  id: number;
}

/** The rows holding the true minimum and maximum (finite rows only). */
export function fieldExtremes(
  field: FieldData,
  component: FieldComponent = "mag"
): { min: FieldExtreme; max: FieldExtreme } | undefined {
  let lo: FieldExtreme | undefined;
  let hi: FieldExtreme | undefined;
  for (let i = 0; i < field.ids.length; i++) {
    const v = componentScalar(field, i, component);
    if (!Number.isFinite(v)) continue;
    if (!lo || v < lo.value) lo = { value: v, row: i, id: field.ids[i] };
    if (!hi || v > hi.value) hi = { value: v, row: i, id: field.ids[i] };
  }
  return lo && hi ? { min: lo, max: hi } : undefined;
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
