// Scalar colouring as data (roadmap item 18, renderer boundary).
//
// Every coloured prop — a contour surface, a threshold region, the cut cap,
// quiver arrows, spheres, beam tubes, the mesh-size overlay — used to
// configure its vtk.js mapper by hand, with the same degenerate-range rule
// written out four times. Here the decision is made once, as a
// `ScalarColoring` value both backends apply.
//
// The degenerate-range rule: when max <= min, vtk.js's per-vertex
// scalar->texture-coordinate math divides by the range width with no zero
// guard, producing NaN texture coordinates and GPU-dependent colours (see the
// long note that used to sit in webview/fieldRender.ts). The fix is to turn
// scalar colouring off and paint one deliberate mid-colormap hue — kept for
// VTK-wasm too, so a flat field looks the same on both backends.

import { ColorStop, interpolateStops, transformStops } from "../fieldScalars";
import type { ScalarColoring } from "./types";

/**
 * A colour transfer function as flat `x, r, g, b` quadruples, in exactly the
 * order a backend must `AddRGBPoint` them. A degenerate range collapses to a
 * single point at `min` coloured at the stops' midpoint, which keeps the CTF's
 * mapping range truthfully `[min, min]` — a fake `[min, min+1]` span would put
 * bogus ticks on the in-scene scalar bar.
 */
export function ctfPointsFromStops(stops: ColorStop[], min: number, max: number): number[] {
  if (max <= min) {
    const [r, g, b] = interpolateStops(stops, 0.5);
    return [min, r, g, b];
  }
  const span = max - min;
  const out: number[] = [];
  for (const [t, r, g, b] of stops) out.push(min + t * span, r, g, b);
  return out;
}

export interface FieldColoringStyle {
  min: number;
  max: number;
  log?: boolean;
  bands?: number;
}

/**
 * Colouring for a field-attached surface (contour, threshold, cut cap,
 * mesh-size): point-data fields interpolate before mapping, cell-data fields
 * colour flat per cell. `stops` are the colormap's own, untransformed.
 */
export function fieldColoring(stops: ColorStop[], style: FieldColoringStyle, association: "point" | "cell"): ScalarColoring {
  if (style.max <= style.min) return { kind: "flat", rgb: interpolateStops(stops, 0.5) };
  const transformed = transformStops(stops, { log: style.log, bands: style.bands, min: style.min, max: style.max });
  return {
    kind: "mapped",
    ctfPoints: ctfPointsFromStops(transformed, style.min, style.max),
    range: [style.min, style.max],
    association,
    interpolateBeforeMapping: association === "point",
  };
}

/**
 * Colouring for a glyph layer by one of its point arrays (quiver magnitude,
 * sphere/beam radius). No log/band transform — the glyph builders never had
 * one — and no interpolation before mapping (one colour per glyph).
 */
export function glyphColoring(stops: ColorStop[], min: number, max: number, arrayName: string): ScalarColoring {
  if (max <= min) return { kind: "flat", rgb: interpolateStops(stops, 0.5) };
  return {
    kind: "mapped",
    ctfPoints: ctfPointsFromStops(stops, min, max),
    range: [min, max],
    association: "point",
    interpolateBeforeMapping: false,
    arrayName,
  };
}
