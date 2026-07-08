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
import {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
  ExportableExtension,
  isExportableExtension,
} from "./exportFormats";

// Re-exported from the pure `exportFormats` module so host-side importers keep
// their `./meshWriter` import path while the webview can import the same
// constants without pulling in the writer implementations.
export {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
  ExportableExtension,
  isExportableExtension,
};

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
