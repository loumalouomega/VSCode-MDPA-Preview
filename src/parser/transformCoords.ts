/**
 * Coordinate transforms — scale, translate, and rotate — as separate pure
 * operations. Each maps every node coordinate and recomputes the bounds.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 */

import { MdpaModel } from "./types";

export type Axis = "x" | "y" | "z";
type Vec3 = [number, number, number];

/** Applies a per-point function to every node, recomputing bounds. */
function mapCoords(model: MdpaModel, fn: (x: number, y: number, z: number) => Vec3): MdpaModel {
  const n = model.nodeCount;
  const coords = new Float32Array(n * 3);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = fn(model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]);
    for (let k = 0; k < 3; k++) {
      coords[i * 3 + k] = p[k];
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  if (n === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  return {
    ...model,
    coords,
    diagnostics: [],
    bounds: { min, max },
  };
}

/** Per-axis scale about the origin. */
export function scaleCoords(model: MdpaModel, sx: number, sy: number, sz: number): MdpaModel {
  return mapCoords(model, (x, y, z) => [x * sx, y * sy, z * sz]);
}

/** Translation by (dx, dy, dz). */
export function translateCoords(model: MdpaModel, dx: number, dy: number, dz: number): MdpaModel {
  return mapCoords(model, (x, y, z) => [x + dx, y + dy, z + dz]);
}

/**
 * Right-handed rotation (degrees) about a line parallel to a coordinate axis
 * that passes through the center point (cx, cy, cz) — defaults to the origin.
 */
export function rotateCoords(
  model: MdpaModel,
  axis: Axis,
  angleDeg: number,
  cx = 0,
  cy = 0,
  cz = 0
): MdpaModel {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return mapCoords(model, (x, y, z) => {
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    switch (axis) {
      case "x":
        return [x, cy + dy * c - dz * s, cz + dy * s + dz * c];
      case "y":
        return [cx + dx * c + dz * s, y, cz - dx * s + dz * c];
      case "z":
        return [cx + dx * c - dy * s, cy + dx * s + dy * c, z];
    }
  });
}
