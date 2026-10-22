// Pure decoding of a GPU id-buffer capture (roadmap item 22 B).
//
// A hardware selector draws the scene several times into an offscreen
// framebuffer, once per "pass", writing an identifier instead of a colour: the
// actor pass writes which prop covers the pixel (index + 1, so 0 means empty),
// and the cell passes write the cell index of the primitive under the pixel
// (24 low bits in one pass, the high 8 in another only when a mesh has more than
// 16,777,215 cells). Each pass comes back as RGBA bytes, three of which carry
// the number little-endian. This module turns those buffers plus a region
// predicate into "which cells of which prop are visible inside the region" with
// no vtk.js and no DOM, so the decoding is Node-testable and a second backend
// can feed it its own buffers.

import type { EntityBlock } from "../types";
import type { PreparedNodes } from "./displayGeometry";

/** One pass: RGBA bytes, row-major over `width` x `height`, row 0 = lowest y. */
export type IdPass = ArrayLike<number>;

export interface SelectionBuffers {
  width: number;
  height: number;
  /** Prop-index + 1 per pixel; 0 = no prop. */
  actor: IdPass;
  /** Cell id, low 24 bits. Alpha 0 means no cell was written there. */
  low24: IdPass;
  /** Cell id, high 8 bits; absent when the capture needed only 24 bits. */
  high24?: IdPass;
}

/** Cells visible inside a region, per prop index. */
export type RegionCells = Map<number, Set<number>>;

function packed(pass: IdPass, offset: number): number {
  return (pass[offset + 2] * 256 + pass[offset + 1]) * 256 + pass[offset];
}

/**
 * Walks every pixel whose centre `inside(x, y)` accepts (x, y are buffer pixel
 * coordinates, origin at the buffer's lower-left) and collects the visible
 * cells per prop. Pixels with no prop, or a prop outside `propCount`, are
 * skipped, as are pixels where the cell pass wrote nothing (alpha 0) — a prop
 * can cover a pixel with a primitive the cell pass did not tag, and counting it
 * as cell 0 would silently add a wrong entity.
 */
export function decodeRegionCells(
  buffers: SelectionBuffers,
  propCount: number,
  inside: (x: number, y: number) => boolean = () => true
): RegionCells {
  const { width, height, actor, low24, high24 } = buffers;
  const out: RegionCells = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const actorId = packed(actor, o);
      if (actorId <= 0 || actorId - 1 >= propCount) continue;
      if (low24[o + 3] === 0) continue;
      if (!inside(x, y)) continue;
      let id = packed(low24, o);
      if (high24) id += packed(high24, o) * 16777216;
      const prop = actorId - 1;
      let set = out.get(prop);
      if (!set) {
        set = new Set();
        out.set(prop, set);
      }
      set.add(id);
    }
  }
  return out;
}

/**
 * The centroid (mean of the corner nodes) of every cell of a block, 3 numbers
 * per cell in block order, from the model's own connectivity — NOT from the
 * displayed geometry, which holds only the boundary faces of a volume mesh and
 * so has no interior cell to find. A cell with a corner the node table does not
 * know reads NaN, so a caller skips it rather than selecting it at the origin.
 * This is the through-the-surface ("X-ray") half of region selection: unlike the
 * GPU id buffer it does not care what is in front.
 */
export function blockCentroids(block: EntityBlock, prep: PreparedNodes): Float64Array {
  const { stride, count, connectivity } = block;
  const out = new Float64Array(count * 3);
  for (let c = 0; c < count; c++) {
    let x = 0;
    let y = 0;
    let z = 0;
    let ok = stride > 0;
    for (let j = 0; j < stride && ok; j++) {
      const idx = prep.index.get(connectivity[c * stride + j]);
      if (idx === undefined) {
        ok = false;
        break;
      }
      x += prep.coords[idx * 3];
      y += prep.coords[idx * 3 + 1];
      z += prep.coords[idx * 3 + 2];
    }
    const o = c * 3;
    if (ok) {
      out[o] = x / stride;
      out[o + 1] = y / stride;
      out[o + 2] = z / stride;
    } else {
      out[o] = out[o + 1] = out[o + 2] = NaN;
    }
  }
  return out;
}
