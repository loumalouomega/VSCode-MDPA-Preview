/**
 * Pure camera arithmetic behind the bottom navigation dock
 * (`webview/navControls.ts`). Lives here, not in `webview/`, so `node --test`
 * can reach it — `webview/` is not part of `tsconfig.test.json` and needs a DOM.
 */

export type Vec3 = [number, number, number];

/** The rotate step choices offered by the dock's ⋯ popover, in degrees. */
export const ROTATE_STEPS = [15, 45, 90] as const;
export type RotateStep = (typeof ROTATE_STEPS)[number];
export const DEFAULT_ROTATE_STEP: RotateStep = 45;

/** Compute the right-hand vector perpendicular to `dir` and `up`. */
export function computeRightVector(dir: Vec3, up: Vec3): Vec3 {
  const rx = dir[1] * up[2] - dir[2] * up[1];
  const ry = dir[2] * up[0] - dir[0] * up[2];
  const rz = dir[0] * up[1] - dir[1] * up[0];
  const len = Math.hypot(rx, ry, rz);
  if (len < 1e-10) return [1, 0, 0];
  return [rx / len, ry / len, rz / len];
}

/** Pan step in world units: 15% of the half-height of the visible frustum. */
export function computePanStep(distance: number, viewAngleDeg: number): number {
  return distance * Math.tan((viewAngleDeg * Math.PI) / 360) * 0.15;
}

/**
 * The camera a freshly loaded model is framed from: looking down -Z with +Y up
 * (vtk.js's own default, which `resetCamera()` keeps on load). The dock's
 * "Reset view" restores this orientation — unlike "Fit", which only re-frames
 * from wherever the camera currently looks. `position` is one unit from `focal`;
 * the caller follows with `resetCamera()`, which rescales the distance.
 */
export function defaultViewCamera(focal: Vec3): { position: Vec3; viewUp: Vec3 } {
  return { position: [focal[0], focal[1], focal[2] + 1], viewUp: [0, 1, 0] };
}

/**
 * True when a keyboard event's target owns the arrow keys itself (a slider, a
 * number field or a select), so a menu's roving ArrowUp/ArrowDown navigation
 * must leave it alone. `tagName` is compared case-insensitively.
 */
export function ownsArrowKeys(tagName: string | undefined): boolean {
  const t = (tagName ?? "").toUpperCase();
  return t === "INPUT" || t === "SELECT" || t === "TEXTAREA";
}
