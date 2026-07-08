/**
 * MdpaModel → Wavefront OBJ.  Every node becomes a `v`; surface cells become
 * `f` faces (corner nodes), line cells `l`, point cells `p`, and each block
 * becomes a named `g` group.  Volume cells contribute their triangulated
 * boundary faces under a trailing "boundary" group.
 *
 * OBJ vertex indices are 1-based and global, so node ids are remapped to the
 * coord order (1..nodeCount).  Pure module: no vscode / DOM / vtk.js imports.
 */

import { MdpaDiagnostic, MdpaModel } from "../types";
import {
  cellCategory,
  cornerCount,
  nodeIndexMap,
  num,
  surfaceTriangles,
} from "./writerCommon";

export function writeObj(model: MdpaModel): string {
  const idToIndex = nodeIndexMap(model);
  const lines: string[] = ["# Exported by Kratos MDPA Preview"];

  for (let i = 0; i < model.nodeCount; i++) {
    lines.push(`v ${num(model.coords[i * 3])} ${num(model.coords[i * 3 + 1])} ${num(model.coords[i * 3 + 2])}`);
  }

  let hasVolume = false;
  for (const block of model.blocks) {
    const cat = cellCategory(block.vtkCellType);
    if (cat === "volume") {
      hasVolume = true;
      continue;
    }
    if (cat !== "surface" && cat !== "line" && cat !== "point") continue;
    const corners = Math.min(cornerCount(block.vtkCellType) || block.stride, block.stride);
    const kw = cat === "surface" ? "f" : cat === "line" ? "l" : "p";
    lines.push(`g ${block.name.replace(/\s+/g, "_")}`);
    for (let c = 0; c < block.count; c++) {
      const refs: number[] = [];
      let ok = true;
      for (let k = 0; k < corners; k++) {
        const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
        if (idx === undefined) {
          ok = false;
          break;
        }
        refs.push(idx + 1); // OBJ is 1-based
      }
      if (ok && refs.length > 0) lines.push(`${kw} ${refs.join(" ")}`);
    }
  }

  if (hasVolume) {
    const diagnostics: MdpaDiagnostic[] = [];
    const tris = surfaceTriangles(model, diagnostics, { volumeOnly: true });
    if (tris.length > 0) {
      lines.push("g boundary");
      for (let t = 0; t < tris.length; t += 3) {
        lines.push(`f ${tris[t] + 1} ${tris[t + 1] + 1} ${tris[t + 2] + 1}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
