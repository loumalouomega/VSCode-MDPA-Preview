/**
 * Writer dispatcher: serialises an MdpaModel to any faithfully-representable
 * mesh format, routing by extension.  The inverse counterpart of
 * meshFileParser.ts.  Pure module: no vscode / DOM / vtk.js imports.
 *
 * Structured-grid (.vti/.vts/.vtr) and multiblock (.vtm) formats are excluded:
 * an unstructured MdpaModel cannot reconstruct their implicit topology.
 */

import { MdpaModel } from "../types";
import { writeMdpa, MdpaWriteOptions } from "./mdpaWriter";
import { writeVtkLegacy } from "./vtkLegacyWriter";
import { writeVtu, writeVtp } from "./vtkXmlWriter";
import { writeStl } from "./stlWriter";
import { writeObj } from "./objWriter";
import { writePly } from "./plyWriter";

/** Extensions the writer layer can emit, in menu order. */
export const EXPORTABLE_EXTENSIONS = [
  ".mdpa",
  ".vtk",
  ".vtu",
  ".vtp",
  ".stl",
  ".obj",
  ".ply",
] as const;

export type ExportableExtension = (typeof EXPORTABLE_EXTENSIONS)[number];

/** Human-readable label per exportable extension (for save-dialog filters/menus). */
export const EXPORT_FORMAT_LABELS: Record<ExportableExtension, string> = {
  ".mdpa": "Kratos MDPA",
  ".vtk": "Legacy VTK",
  ".vtu": "VTK Unstructured Grid",
  ".vtp": "VTK PolyData",
  ".stl": "STL",
  ".obj": "Wavefront OBJ",
  ".ply": "Stanford PLY",
};

export function isExportableExtension(ext: string): ext is ExportableExtension {
  return (EXPORTABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export interface MeshWriteOptions extends MdpaWriteOptions {
  /** Base name (no extension) used by formats that embed one (STL solid name). */
  name?: string;
}

/**
 * Serialises `model` to the format implied by `ext` (e.g. ".vtu").  Returns the
 * file text.  Throws for unsupported extensions.
 */
export function writeMeshFile(
  model: MdpaModel,
  ext: string,
  opts: MeshWriteOptions = {}
): string {
  switch (ext.toLowerCase()) {
    case ".mdpa":
      return writeMdpa(model, opts);
    case ".vtk":
      return writeVtkLegacy(model);
    case ".vtu":
      return writeVtu(model);
    case ".vtp":
      return writeVtp(model);
    case ".stl":
      return writeStl(model, opts.name);
    case ".obj":
      return writeObj(model);
    case ".ply":
      return writePly(model);
    default:
      throw new Error(
        `Cannot export to "${ext}" (supported: ${EXPORTABLE_EXTENSIONS.join(", ")}).`
      );
  }
}
