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
  EXPORT_MENU_GROUPS,
  ExportableExtension,
  ExportGroup,
  isExportableExtension,
  isNativeExportExtension,
} from "./exportFormats";
import { MeshioCompanionFile, writeMeshioBytes } from "../meshio";

// Re-exported from the pure `exportFormats` module so host-side importers keep
// their `./meshWriter` import path while the webview can import the same
// constants without pulling in the writer implementations.
export {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
  EXPORT_MENU_GROUPS,
  ExportableExtension,
  ExportGroup,
  isExportableExtension,
  isNativeExportExtension,
};

export interface MeshWriteOptions extends MdpaWriteOptions {
  /** Base name (no extension) used by formats that embed one (STL solid name). */
  name?: string;
  /**
   * Force a meshio++ format key (e.g. "ansys", "freefem") instead of the
   * extension's default. Ignored by the native writers.
   */
  format?: string;
}

/**
 * Serialises `model` to one of the NATIVE formats implied by `ext` (e.g.
 * ".vtu").  Returns the file text.  Synchronous and text-only — use
 * `writeMeshFileAsync` for the extended (meshio++) formats, several of which
 * are binary.
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
        `Cannot export to "${ext}" with writeMeshFile — use writeMeshFileAsync ` +
          `for the extended formats (supported: ${EXPORTABLE_EXTENSIONS.join(", ")}).`
      );
  }
}

/**
 * The result of `writeMeshFileAsync`: the named file, plus any companion the
 * writer emitted beside it (XDMF's `<stem>.h5`).  `companions` is empty for
 * every single-file format, which is all of them except XDMF.
 */
export interface MeshWriteResult {
  data: string | Uint8Array;
  companions: MeshioCompanionFile[];
}

/**
 * Serialises `model` to ANY exportable format.
 *
 * Returns a Uint8Array for the meshio++ formats — gmsh (4.1) and ansys write
 * BINARY, so routing them through a string would corrupt them — and text for
 * the native writers.  `fs.writeFile` handles either: a string defaults to
 * utf8, a Uint8Array is written raw (so callers must NOT pass an encoding).
 *
 * `opts.name` is the destination stem.  Besides naming an STL solid it names
 * the file inside meshio++'s virtual filesystem, which matters because the XDMF
 * writer emits `<stem>.h5` beside the XML and references it by that name.
 */
export async function writeMeshFileAsync(
  model: MdpaModel,
  ext: string,
  opts: MeshWriteOptions = {}
): Promise<MeshWriteResult> {
  const e = ext.toLowerCase();
  if (isNativeExportExtension(e)) {
    // Rather than silently write the native format the caller did not ask for.
    if (opts.format) {
      throw new Error(
        `"${e}" is written by our own writer, which has no format variants — ` +
          `remove format="${opts.format}" or choose a meshio++ output extension.`
      );
    }
    return { data: writeMeshFile(model, e, opts), companions: [] };
  }
  if (isExportableExtension(e)) {
    return writeMeshioBytes(model, e, { format: opts.format, stem: opts.name });
  }
  throw new Error(
    `Cannot export to "${ext}" (supported: ${EXPORTABLE_EXTENSIONS.join(", ")}).`
  );
}
