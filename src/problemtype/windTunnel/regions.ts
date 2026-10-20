/**
 * Refinement regions: the shapes and the check that says whether one can run.
 *
 * A leaf module on purpose. The wizard's form (`form.ts`) is bundled into the
 * WEBVIEW and must validate a region as the user types, while `plan.ts` pulls in
 * the body geometry, which reaches the meshio++ loader and Node built-ins. The
 * webview bundle cannot take those, so anything the form needs at run time lives
 * here and `plan.ts` re-exports it.
 */

import type { Vec3 } from "./body";

/**
 * Extra refinement regions, in the tunnel frame in metres: a size law that is
 * `size` inside the region and grows with the distance outside it. They
 * replace the single wake box; when `regions` is undefined the wake applies
 * exactly as before.
 */
export type RefinementRegion =
  | { shape: "box"; min: Vec3; max: Vec3; size: number; growth?: number }
  | { shape: "cone"; start: Vec3; end: Vec3; radiusStart: number; radiusEnd: number; size: number; growth?: number }
  | { shape: "ellipsoid"; center: Vec3; radii: Vec3; size: number; growth?: number };

const finiteVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** What makes a region unusable, in one clause; undefined when it can run. */
export function checkRegion(region: RefinementRegion): string | undefined {
  if (!region || typeof region !== "object") return "the region is not an object";
  if (!(region.size > 0)) return "the size must be above zero";
  if (region.growth !== undefined && !(region.growth >= 0)) return "the growth cannot be below 0";
  switch (region.shape) {
    case "box":
      if (!finiteVec3(region.min) || !finiteVec3(region.max)) return "min and max must be [x, y, z] in metres";
      if (!(region.min[0] < region.max[0] && region.min[1] < region.max[1] && region.min[2] < region.max[2])) {
        return "min must be below max on every axis";
      }
      return undefined;
    case "cone":
      if (!finiteVec3(region.start) || !finiteVec3(region.end)) return "start and end must be [x, y, z] in metres";
      if (!(region.end[0] !== region.start[0] || region.end[1] !== region.start[1] || region.end[2] !== region.start[2])) {
        return "start and end coincide: a cone needs an axis (use a box or an ellipsoid for a point)";
      }
      if (!(region.radiusStart >= 0) || !(region.radiusEnd >= 0)) return "the radii cannot be below 0";
      return undefined;
    case "ellipsoid":
      if (!finiteVec3(region.center) || !finiteVec3(region.radii)) return "center and radii must be [x, y, z] in metres";
      if (!(region.radii[0] > 0 && region.radii[1] > 0 && region.radii[2] > 0)) return "the radii must be above zero";
      return undefined;
    default:
      return `unknown shape "${(region as { shape: unknown }).shape}" (box, cone or ellipsoid)`;
  }
}

/**
 * The volume a refinement region occupies (m³), for the cost estimate.
 *
 * A box is its side product; an ellipsoid is 4/3 π rx ry rz; a cone is the
 * frustum between its two radii (a true cone when one radius is 0). Never
 * negative and never NaN: an invalid region contributes nothing, and the
 * estimate runs even when the plan carries errors.
 */
export function refinementRegionVolume(region: RefinementRegion): number {
  try {
    if (region.shape === "box") {
      const v = (region.max[0] - region.min[0]) * (region.max[1] - region.min[1]) * (region.max[2] - region.min[2]);
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    if (region.shape === "ellipsoid") {
      const v = (4 / 3) * Math.PI * region.radii[0] * region.radii[1] * region.radii[2];
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    const dx = region.end[0] - region.start[0];
    const dy = region.end[1] - region.start[1];
    const dz = region.end[2] - region.start[2];
    const h = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const v = (Math.PI * h * (region.radiusStart ** 2 + region.radiusStart * region.radiusEnd + region.radiusEnd ** 2)) / 3;
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  } catch {
    return 0;
  }
}
