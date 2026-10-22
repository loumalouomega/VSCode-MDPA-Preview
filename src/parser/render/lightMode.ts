// Light placement as data (roadmap item 22 F). A headlight follows the camera
// (the renderer default); a scene light is fixed in the model's frame, so it
// does not slide over the surface as the camera orbits — which is what makes a
// ridge or a dent read the same from every angle; a positional light is a
// point source near the model. Pure: the backend receives a placement, never
// the mode, so both backends share the geometry decisions.

import type { Bounds6, Vec3 } from "./types";

export type LightMode = "headlight" | "scene" | "positional";

export interface LightSpec {
  mode: LightMode;
  /** Degrees around +Z from +X (scene and positional). */
  azimuth: number;
  /** Degrees above the XY plane, -90..90 (scene and positional). */
  elevation: number;
}

export const DEFAULT_LIGHT_SPEC: LightSpec = { mode: "headlight", azimuth: 45, elevation: 35 };

/** A fixed light in world space; `null` from `lightPlacement` means "headlight". */
export interface LightPlacement {
  position: Vec3;
  focalPoint: Vec3;
  positional: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Keep a spec inside its ranges; a non-finite angle falls back to the default. */
export function normalizeLightSpec(s: LightSpec): LightSpec {
  const mode: LightMode = s.mode === "scene" || s.mode === "positional" ? s.mode : "headlight";
  const az = Number.isFinite(s.azimuth) ? ((s.azimuth % 360) + 360) % 360 : DEFAULT_LIGHT_SPEC.azimuth;
  const el = Number.isFinite(s.elevation) ? clamp(s.elevation, -90, 90) : DEFAULT_LIGHT_SPEC.elevation;
  return { mode, azimuth: az, elevation: el };
}

/**
 * Where to put the light for `bounds`. A scene light is a distant directional
 * source (placed three diagonals out so its direction is what matters); a
 * positional one sits one and a half diagonals out so falloff across the model
 * is visible. Degenerate bounds use a unit box.
 */
export function lightPlacement(spec: LightSpec, bounds: Bounds6 | undefined): LightPlacement | null {
  const s = normalizeLightSpec(spec);
  if (s.mode === "headlight") return null;
  let b = bounds;
  if (!b || b.some((v) => !Number.isFinite(v))) b = [-0.5, 0.5, -0.5, 0.5, -0.5, 0.5];
  const c: Vec3 = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  const diag = Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) || 1;
  const az = (s.azimuth * Math.PI) / 180;
  const el = (s.elevation * Math.PI) / 180;
  const d: Vec3 = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  const reach = s.mode === "scene" ? 3 * diag : 1.5 * diag;
  return {
    position: [c[0] + d[0] * reach, c[1] + d[1] * reach, c[2] + d[2] * reach],
    focalPoint: c,
    positional: s.mode === "positional",
  };
}
