/**
 * Folds a cell layout back into polyhedra (`MdpaModel.polyhedra`, see types.ts).
 *
 * The model holds a read polyhedron as the tetrahedra it was decomposed into.
 * For a format that can hold the real cell (the native `.vtu` writer), the first
 * child of each polyhedron becomes the polyhedron itself and its siblings
 * disappear, so an Elemental field written against the Element ids still lands
 * on the right cell (the polyhedron takes its representative child's value; the
 * children carry the parent's value by construction, and differ only if an edit
 * touched one of them — which drops the side channel anyway).
 *
 * A polyhedron is folded only if EVERY child is still a tetrahedron Element of
 * the layout and every face node resolves; otherwise it is left as its
 * tetrahedra, so a partly-deleted polyhedron degrades to what is actually there.
 *
 * Pure; no vscode / DOM.
 */

import { MdpaModel } from "../types";
import { VTK_POLYHEDRON } from "../polyhedraTopology";
import { CellLayout, LaidOutCell, nodeIndexMap } from "./writerCommon";

const VTK_TETRA = 10;

export interface FoldedLayout {
  layout: CellLayout;
  /** Folded cell index -> its faces as 0-based node indices (the cell's `type` is VTK_POLYHEDRON). */
  faces: Map<number, number[][]>;
  /** Number of polyhedra folded. */
  folded: number;
}

export function foldPolyhedra(model: MdpaModel, layout: CellLayout): FoldedLayout {
  const poly = model.polyhedra;
  if (!poly || poly.count === 0) return { layout, faces: new Map(), folded: 0 };
  const idToIndex = nodeIndexMap(model);

  const drop = new Set<number>(); // old cell indices of non-representative children
  const rep = new Map<number, number[][]>(); // old cell index of the representative -> faces (node indices)
  for (let p = 0; p < poly.count; p++) {
    const cells: number[] = [];
    let ok = poly.childOffsets[p + 1] > poly.childOffsets[p];
    for (let k = poly.childOffsets[p]; ok && k < poly.childOffsets[p + 1]; k++) {
      const c = layout.elementIdToCell.get(poly.childIds[k]);
      if (c === undefined || layout.cells[c].type !== VTK_TETRA) ok = false;
      else cells.push(c);
    }
    if (!ok) continue;
    const faces: number[][] = [];
    for (let f = poly.cellOffsets[p]; ok && f < poly.cellOffsets[p + 1]; f++) {
      const face: number[] = [];
      for (let k = poly.faceOffsets[f]; k < poly.faceOffsets[f + 1]; k++) {
        const idx = idToIndex.get(poly.nodes[k]);
        if (idx === undefined) {
          ok = false;
          break;
        }
        face.push(idx);
      }
      faces.push(face);
    }
    if (!ok || faces.length < 4) continue;
    rep.set(cells[0], faces);
    for (let i = 1; i < cells.length; i++) drop.add(cells[i]);
  }
  if (rep.size === 0) return { layout, faces: new Map(), folded: 0 };

  const oldToNew = new Int32Array(layout.cells.length).fill(-1);
  const cells: LaidOutCell[] = [];
  const faceMap = new Map<number, number[][]>();
  for (let i = 0; i < layout.cells.length; i++) {
    if (drop.has(i)) continue;
    oldToNew[i] = cells.length;
    const faces = rep.get(i);
    if (faces) {
      const unique: number[] = [];
      const seen = new Set<number>();
      for (const face of faces) {
        for (const n of face) {
          if (seen.has(n)) continue;
          seen.add(n);
          unique.push(n);
        }
      }
      faceMap.set(cells.length, faces);
      cells.push({ ...layout.cells[i], type: VTK_POLYHEDRON, nodes: unique });
    } else {
      cells.push(layout.cells[i]);
    }
  }
  const remap = (m: Map<number, number>): Map<number, number> => {
    const out = new Map<number, number>();
    for (const [id, c] of m) if (oldToNew[c] >= 0) out.set(id, oldToNew[c]);
    return out;
  };
  return {
    layout: {
      cells,
      elementIdToCell: remap(layout.elementIdToCell),
      conditionIdToCell: remap(layout.conditionIdToCell),
      geometryIdToCell: remap(layout.geometryIdToCell),
      skipped: layout.skipped,
    },
    faces: faceMap,
    folded: rep.size,
  };
}
