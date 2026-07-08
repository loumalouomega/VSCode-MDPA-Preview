/**
 * Applies an affine coordinate transform to every node: a uniform scale followed
 * by a translation (`coord' = coord * scale + (dx, dy, dz)`). Useful for unit
 * conversion (e.g. mm → m) or repositioning a mesh.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel with recomputed bounds is returned.
 */

import { MdpaModel } from "./types";

export interface CoordTransform {
  scale: number;
  dx: number;
  dy: number;
  dz: number;
}

export function transformCoords(model: MdpaModel, t: CoordTransform): MdpaModel {
  const n = model.nodeCount;
  const coords = new Float32Array(n * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const off = [t.dx, t.dy, t.dz];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = model.coords[i * 3 + k] * t.scale + off[k];
      coords[i * 3 + k] = v;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (n === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  return {
    nodeCount: n,
    nodeIds: model.nodeIds,
    coords,
    blocks: model.blocks,
    subModelParts: model.subModelParts,
    meta: model.meta,
    fields: model.fields,
    diagnostics: [],
    is3D: model.is3D,
    bounds: { min, max },
  };
}
