/**
 * Which cells did a coordinate move turn inside-out?
 *
 * Shrinkwrap and Sobolev deformation move nodes without any cell-inversion
 * guard (upstream states so for shrinkwrap explicitly), so the operation
 * reports what its move did to the cells rather than leaving a folded mesh to be
 * found by the solver. The mesh keeps its node order and connectivity across
 * such a move, which is what lets this compare the SAME cell before and after.
 *
 * A volume cell is decomposed into tetrahedra (`cellDecomposition.ts`, the
 * tables `simplexify` uses) and counts as inverted when any of them changed the
 * sign of its volume; a surface cell is decomposed into triangles and counts as
 * folded when any triangle's normal now points against its old direction. A
 * cell that was already degenerate before the move is not counted — it cannot
 * be "newly" inverted.
 *
 * Pure module (no vscode / DOM / wasm).
 */

import { EntityKind, MdpaModel } from "./types";
import { decompositionFor } from "./cellDecomposition";
import { cellCategory } from "./writers/writerCommon";

export interface InvertedCells {
  /** Volume cells with a tetrahedron whose orientation flipped. */
  volume: number;
  /** Surface cells with a triangle whose normal reversed. */
  surface: number;
  /** The first `limit` offending cells, for highlighting. */
  cells: { kind: EntityKind; id: number }[];
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * `before` and `after` must be the same mesh with moved coordinates (same node
 * order and connectivity), which is what both deformation ops produce.
 */
export function invertedCells(before: MdpaModel, after: MdpaModel, limit = 1000): InvertedCells {
  const out: InvertedCells = { volume: 0, surface: 0, cells: [] };
  if (before.nodeCount !== after.nodeCount) return out;
  const index = new Map<number, number>();
  for (let i = 0; i < before.nodeCount; i++) index.set(before.nodeIds[i], i);
  const at = (m: MdpaModel, id: number): V3 => {
    const i = index.get(id)!;
    return [m.coords[i * 3], m.coords[i * 3 + 1], m.coords[i * 3 + 2]];
  };

  for (const block of before.blocks) {
    const cat = cellCategory(block.vtkCellType);
    if (cat !== "volume" && cat !== "surface") continue;
    const dec = decompositionFor(block.vtkCellType);
    const groups = cat === "volume" ? dec.tets : dec.tris;
    if (!groups) continue;
    for (let c = 0; c < block.count; c++) {
      const ids: number[] = [];
      let ok = true;
      for (let k = 0; k < dec.corners; k++) {
        const id = block.connectivity[c * block.stride + k];
        if (!index.has(id)) ok = false;
        ids.push(id);
      }
      if (!ok) continue;
      let flipped = false;
      for (const g of groups) {
        const p0 = g.map((k) => at(before, ids[k]));
        const p1 = g.map((k) => at(after, ids[k]));
        if (cat === "volume") {
          const v0 = dot(cross(sub(p0[1], p0[0]), sub(p0[2], p0[0])), sub(p0[3], p0[0]));
          const v1 = dot(cross(sub(p1[1], p1[0]), sub(p1[2], p1[0])), sub(p1[3], p1[0]));
          if (v0 * v1 < 0) flipped = true;
        } else {
          const n0 = cross(sub(p0[1], p0[0]), sub(p0[2], p0[0]));
          const n1 = cross(sub(p1[1], p1[0]), sub(p1[2], p1[0]));
          if (dot(n0, n1) < 0) flipped = true;
        }
        if (flipped) break;
      }
      if (!flipped) continue;
      if (cat === "volume") out.volume++;
      else out.surface++;
      if (out.cells.length < limit) out.cells.push({ kind: block.kind, id: block.entityIds[c] });
    }
  }
  return out;
}

/** One clause for an outcome message, or "" when nothing flipped. */
export function describeInverted(r: InvertedCells): string {
  const parts: string[] = [];
  if (r.volume > 0) parts.push(`${r.volume} volume cell(s) inverted`);
  if (r.surface > 0) parts.push(`${r.surface} surface cell(s) folded over`);
  return parts.length > 0 ? `Warning: ${parts.join(" and ")} by the move — check the result before solving.` : "";
}
