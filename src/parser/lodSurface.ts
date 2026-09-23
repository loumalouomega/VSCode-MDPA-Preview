/**
 * A lighter surface to DRAW while a big mesh is being navigated — the preview
 * level of detail. Pure module (no vscode / DOM); the geometry comes from
 * `decimateModel`, so the same collapse rules and pinning apply.
 *
 * What this is NOT: a change to the document. The open mesh, its history, its
 * saves and its exports are untouched; the webview merely draws these triangles
 * in place of the full layers while the LOD toggle is on. Because a decimated
 * triangle is a re-meshed patch rather than one of the mesh's cells, picking is
 * DISABLED while it shows (the alternative — resolving a click on a decimated
 * face back to a source cell — has no unambiguous answer at a collapsed vertex),
 * and the status line says so.
 *
 * A solid contributes its boundary: the skin is extracted, quads are split into
 * triangles, and THAT is decimated — decimation is defined on triangle surfaces
 * only. Lines and points are not drawn in this mode.
 */

import { MdpaModel } from "./types";
import { cellCategory } from "./writers/writerCommon";
import { extractSkinModel } from "./extractSkin";
import { simplexifyModel } from "./simplexify";
import { decimateModel } from "./decimate";

export interface LodSurface {
  /** Flat xyz of the surviving nodes. */
  points: Float32Array;
  /** Flat triples of indices INTO `points`. */
  triangles: Uint32Array;
  /** Triangles the surface had before decimation. */
  sourceFaces: number;
  keptFaces: number;
  /** The drawn surface is the mesh's skin (it has volume cells) rather than its own faces. */
  skin: boolean;
  note?: string;
}

/** Default keep-fraction: half for a modest mesh, capped so the drawn surface stays near 50 000 triangles. */
export function lodRatio(faces: number): number {
  return faces <= 20_000 ? 0.5 : Math.min(0.5, 50_000 / faces);
}

export async function lodSurface(model: MdpaModel, ratio?: number): Promise<LodSurface> {
  const hasVolume = model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume");
  let surface: MdpaModel;
  if (hasVolume) {
    const skin = extractSkinModel(model);
    if (skin.faces === 0) throw new Error("The mesh has no boundary faces to draw.");
    surface = skin.model;
  } else {
    // Only the faces: lines and points cannot be mixed into a decimated surface.
    surface = { ...model, blocks: model.blocks.filter((b) => cellCategory(b.vtkCellType) === "surface") };
    if (surface.blocks.length === 0) throw new Error("The mesh has no surface faces to draw.");
  }
  surface = { ...surface, constraints: undefined, fields: [], subModelParts: [] };
  const tri = simplexifyModel(surface).model;
  const faces = tri.blocks.reduce((s, b) => s + b.count, 0);
  const r = await decimateModel(tri, { ratio: ratio ?? lodRatio(faces), preserveFeatures: true });
  const index = new Map<number, number>();
  for (let i = 0; i < r.model.nodeCount; i++) index.set(r.model.nodeIds[i], i);
  const tris: number[] = [];
  for (const b of r.model.blocks) {
    for (let c = 0; c < b.count; c++) {
      for (let k = 0; k < 3; k++) tris.push(index.get(b.connectivity[c * b.stride + k]) ?? 0);
    }
  }
  return {
    points: r.model.coords,
    triangles: Uint32Array.from(tris),
    sourceFaces: faces,
    keptFaces: r.facesAfter,
    skin: hasVolume,
    note: r.warnings.length ? r.warnings.join(" ") : undefined,
  };
}
