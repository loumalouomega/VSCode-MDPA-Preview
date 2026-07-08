/**
 * The exportable-format registry: which extensions the writer layer can emit and
 * their human-readable labels.  Kept in its own dependency-free module (no
 * vscode / DOM / node / writer imports) so the **webview bundle** can import the
 * format list for its per-SubModelPart export dropdown without dragging the
 * writer implementations (and their `node:` deps) into `media/webview.js`.
 *
 * `meshWriter.ts` re-exports these so existing host-side importers are unchanged.
 */

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
