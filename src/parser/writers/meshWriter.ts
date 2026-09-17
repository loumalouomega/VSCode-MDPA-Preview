/**
 * Writer dispatcher: serialises an MdpaModel to any faithfully-representable
 * mesh format, routing by extension.  The inverse counterpart of
 * meshFileParser.ts.  Pure module: no vscode / DOM / vtk.js imports.
 *
 * Structured-grid (.vti/.vts/.vtr) formats are excluded: an unstructured
 * MdpaModel cannot reconstruct their implicit topology. Multiblock (.vtm) IS
 * writable — one `.vtu` per top-level SubModelPart plus the unclaimed
 * remainder — but only through `writeMeshFileAsync`, since an index plus
 * companions cannot fit the single-string `writeMeshFile` shape.
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
  EXPORT_FLAVOUR_LABELS,
  EXPORT_FORMAT_FLAVOURS,
  EXPORT_FORMAT_LABELS,
  EXPORT_MENU_GROUPS,
  ExportableExtension,
  ExportGroup,
  isExportableExtension,
  isNativeExportExtension,
} from "./exportFormats";
import { MeshioCompanionFile, writeMeshioBytes } from "../meshio";
import { MdpaDiagnostic } from "../types";
import { writeVtm } from "./vtmWriter";

// Re-exported from the pure `exportFormats` module so host-side importers keep
// their `./meshWriter` import path while the webview can import the same
// constants without pulling in the writer implementations.
export {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FLAVOUR_LABELS,
  EXPORT_FORMAT_FLAVOURS,
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
 * are binary, and for `.vtm`, which is an index plus one `.vtu` per dataset.
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
    case ".vtm":
      throw new Error(
        `Cannot export to ".vtm" with writeMeshFile — a .vtm is an index plus ` +
          `one .vtu per dataset; use writeMeshFileAsync.`
      );
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
 * writer emitted beside it.  `companions` is empty for the single-file
 * formats; `.vtm` (one `.vtu` per dataset), XDMF (its `<stem>.h5`), GiD
 * postprocess (its `.post.res` half) and OpenFOAM (its `constant/polyMesh/`
 * tree) all produce companions.
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
    if (e === ".vtm") {
      // The one native format that is not one file: the index is `data`, each
      // `.vtu` dataset a companion — the same shape the XDMF writer returns,
      // so every caller already handles it.
      const diagnostics: MdpaDiagnostic[] = [];
      const { index, datasets } = writeVtm(model, opts.name ?? "out", diagnostics);
      for (const d of diagnostics) opts.onWarning?.(d.message);
      return {
        data: index,
        companions: datasets.map((d) => ({ name: d.file, data: d.data })),
      };
    }
    return { data: writeMeshFile(model, e, opts), companions: [] };
  }
  if (isExportableExtension(e)) {
    // Own diagnostics array, not opts.diagnostics ?? [] left inside
    // writeMeshioBytes: without one here, every modelToMeshio export
    // diagnostic (a sparse field's zero-fill warning, a cell-data collision
    // rename, a dropped cell type) was discarded on every UI/MCP write, since
    // nothing else ever read it back out. onWarning is intentionally NOT
    // passed to writeMeshioBytes itself — it already forwards its own
    // OpenFOAM-patch diagnostics into this same array, and forwarding them a
    // second time here would double-report them.
    const diagnostics: MdpaDiagnostic[] = [];
    const result = await writeMeshioBytes(model, e, {
      format: opts.format,
      stem: opts.name,
      diagnostics,
    });
    for (const d of diagnostics) opts.onWarning?.(d.message);
    return result;
  }
  throw new Error(
    `Cannot export to "${ext}" (supported: ${EXPORTABLE_EXTENSIONS.join(", ")}).`
  );
}
