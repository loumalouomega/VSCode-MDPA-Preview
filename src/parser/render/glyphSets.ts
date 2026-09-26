// Glyph layers as data (roadmap item 18): quiver arrows / face normals,
// sphere particles and beam tubes. Formerly webview/{quiver,sphereGlyph,
// beamGlyph}.ts, which built vtk.js glyph actors directly; the geometry and
// colouring decisions are unchanged and now reach either backend as a
// `GlyphSet` plus a `ScalarColoring`.

import type { ColorStop } from "../fieldScalars";
import { glyphColoring } from "./scalarColoring";
import type { GlyphSet, RGB, ScalarColoring } from "./types";

export interface QuiverData {
  points: Float32Array; // x,y,z anchors
  vectors: Float32Array; // 3 per anchor
  magnitudes: Float32Array; // 1 per anchor
}

/**
 * Arrows at anchor points (nodes, cell centroids or face centroids), oriented
 * by the vector array and scaled by its magnitude: per-arrow length is
 * `scaleFactor * |vector|`.
 */
export function quiverGlyphSet(data: QuiverData, scaleFactor: number): GlyphSet {
  return {
    anchors: data.points,
    arrays: [
      { name: "vectors", values: data.vectors, components: 3, role: "vectors" },
      { name: "magnitude", values: data.magnitudes, components: 1, role: "scalars" },
    ],
    source: { kind: "arrow" },
    orientationArray: "vectors",
    scaleArray: "vectors",
    scaleMode: "magnitude",
    scaleFactor,
  };
}

/**
 * Magnitude colouring for arrows, or one flat colour. `flatColor` is for the
 * face-normal overlay, whose vectors are all unit length, so a colormap would
 * paint the whole field one hue and say nothing.
 */
export function quiverColoring(stops: ColorStop[], magMin: number, magMax: number, flatColor?: RGB): ScalarColoring {
  if (flatColor) return { kind: "flat", rgb: flatColor };
  return glyphColoring(stops, magMin, magMax, "magnitude");
}

export interface SphereGlyphData {
  /** x,y,z per particle. */
  points: Float32Array;
  /** One radius per particle, already resolved (field value or the fallback). */
  radii: Float32Array;
}

/**
 * Unit spheres scaled by each particle's radius: SCALE_BY_MAGNITUDE of a
 * 1-component array is the value itself, so the drawn radius is exactly
 * `scaleFactor * radii[i]`. No orientation — a sphere has none.
 */
export function sphereGlyphSet(data: SphereGlyphData, scaleFactor: number, resolution: number): GlyphSet {
  return {
    anchors: data.points,
    arrays: [{ name: "radius", values: data.radii, components: 1, role: "scalars" }],
    source: { kind: "sphere", resolution },
    scaleArray: "radius",
    scaleMode: "magnitude",
    scaleFactor,
  };
}

export interface GlyphRangeColor {
  stops: ColorStop[];
  min: number;
  max: number;
}

/**
 * Colour-by-radius, or the layer's flat colour. The flat branch matters: the
 * radius array is the SCALE array, and left alone it would double as the
 * colour array and tint every particle (or tube) by its own size.
 */
export function radiusColoring(color: RGB, byRadius?: GlyphRangeColor): ScalarColoring {
  if (!byRadius) return { kind: "flat", rgb: color };
  return glyphColoring(byRadius.stops, byRadius.min, byRadius.max, "radius");
}

export interface BeamGlyphData {
  /** Midpoint x,y,z per cell — the glyph anchor. */
  centers: Float32Array;
  /** Endpoint-to-endpoint vector per cell: direction AND length. */
  axes: Float32Array;
  /** Section radius per cell, already resolved or defaulted. */
  radii: Float32Array;
  /** Cells in the arrays above. */
  count: number;
}

/**
 * Tubes: a unit cylinder along +X per cell, anchored at the midpoint,
 * oriented by the endpoint vector and scaled per component by
 * `[length, 2r·thickness, 2r·thickness]` in its own local frame.
 *
 * `thickness` multiplies the RADIUS only, never the length — that is why it
 * is baked into the scale array instead of the scale factor: under
 * component scaling the factor multiplies all three components alike, so a
 * factor of 2 would also make every tube twice as long as its element and
 * detach it from its endpoints. The factor therefore stays 1 (the opposite of
 * the sphere layer, where the factor is the right knob).
 */
export function beamGlyphSet(data: BeamGlyphData, thickness: number, resolution: number): GlyphSet {
  const scales = new Float32Array(data.count * 3);
  for (let i = 0; i < data.count; i++) {
    const o = i * 3;
    const length = Math.hypot(data.axes[o], data.axes[o + 1], data.axes[o + 2]);
    const d = 2 * data.radii[i] * thickness;
    scales[o] = length;
    scales[o + 1] = d;
    scales[o + 2] = d;
  }
  return {
    anchors: data.centers,
    arrays: [
      // The axis drives orientation; a separate array drives scale (length and
      // thickness are independent here, unlike an arrow whose length IS the datum).
      { name: "axis", values: data.axes, components: 3, role: "vectors" },
      { name: "beamScale", values: scales, components: 3, role: "array" },
      // Colour by radius, when asked: its own 1-component array, since the
      // magnitude of `beamScale` mixes length into the value.
      { name: "radius", values: data.radii.slice(0, data.count), components: 1, role: "scalars" },
    ],
    source: { kind: "cylinderX", resolution },
    orientationArray: "axis",
    scaleArray: "beamScale",
    scaleMode: "components",
    scaleFactor: 1,
  };
}
