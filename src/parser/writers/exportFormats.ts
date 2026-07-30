/**
 * The exportable-format registry: which extensions the writer layer can emit and
 * their human-readable labels.  Kept in its own dependency-free module (no
 * vscode / DOM / node / writer imports) so the **webview bundle** can import the
 * format list for its per-SubModelPart export dropdown without dragging the
 * writer implementations (and their `node:` deps) into `media/webview.js`.
 *
 * `meshWriter.ts` re-exports these so existing host-side importers are unchanged.
 */

import { MESHIO_EXPORT_EXTENSIONS } from "../meshioFormats";

/** Extensions our own writer layer emits — synchronous, text (writeMeshFile). */
export const NATIVE_EXPORT_EXTENSIONS = [
  ".mdpa",
  ".vtk",
  ".vtu",
  ".vtp",
  ".stl",
  ".obj",
  ".ply",
] as const;

/**
 * Every extension the writer layer can emit, in menu order: ours first, then
 * the extended formats meshio++ writes (writeMeshFileAsync).  Spreading two
 * `as const` tuples keeps this a literal type, so EXPORT_FORMAT_LABELS below
 * stays exhaustively checked.
 */
export const EXPORTABLE_EXTENSIONS = [
  ...NATIVE_EXPORT_EXTENSIONS,
  ...MESHIO_EXPORT_EXTENSIONS,
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
  // meshio++ formats. Several extensions are aliases of one format key
  // (.nas/.fem = Nastran, .tec = Tecplot, .dato = PERMAS, .xmf = XDMF,
  // .e/.ex2 = Exodus); they stay exportable for MCP callers but are omitted
  // from EXPORT_MENU_GROUPS.
  ".msh": "Gmsh",
  ".e": "Exodus II (.e)",
  ".ex2": "Exodus II (.ex2)",
  ".exo": "Exodus II",
  ".inp": "Abaqus",
  ".avs": "AVS-UCD",
  ".bdf": "Nastran",
  ".cgns": "CGNS",
  ".dat": "Tecplot",
  ".dato": "PERMAS (.dato)",
  ".dex": "DEX (fields only)",
  ".f3grid": "FLAC3D",
  ".fem": "Nastran (.fem)",
  ".h5m": "MOAB H5M",
  ".hmf": "HMF",
  ".ip": "IP (fields only)",
  ".med": "MED (Salome)",
  ".mesh": "Medit",
  ".mff": "MFF (fields only)",
  ".mfm": "Modulef MFM",
  ".mphtxt": "COMSOL",
  ".nas": "Nastran (.nas)",
  ".off": "OFF",
  ".pf3": "FLUX",
  ".poly": "Triangle PSLG (.poly)",
  ".post": "PERMAS",
  ".su2": "SU2",
  ".svg": "SVG figure",
  ".tec": "Tecplot (.tec)",
  ".tikz": "TikZ figure",
  ".ugrid": "UGRID",
  ".unv": "I-deas UNV",
  ".vol": "Netgen",
  ".wkt": "WKT",
  ".xdmf": "XDMF",
  ".xmf": "XDMF (.xmf)",
};

/** One group of export formats, for the File ▸ Export and outline menus. */
export interface ExportGroup {
  label: string;
  extensions: readonly ExportableExtension[];
}

/**
 * Menu presentation only: ~30 formats in one flat dropdown is unusable, and
 * the alias extensions above would just be noise. Every extension here must
 * appear in EXPORTABLE_EXTENSIONS (asserted by meshFormats.test.ts).
 */
export const EXPORT_MENU_GROUPS: readonly ExportGroup[] = [
  { label: "Kratos", extensions: [".mdpa"] },
  { label: "VTK", extensions: [".vtk", ".vtu", ".vtp", ".xdmf"] },
  { label: "Surface", extensions: [".stl", ".obj", ".ply", ".off", ".wkt"] },
  {
    label: "Solvers",
    extensions: [
      ".msh", ".mesh", ".inp", ".bdf", ".unv", ".vol", ".su2", ".dat",
      ".avs", ".f3grid", ".pf3", ".mfm", ".mphtxt", ".post", ".ugrid", ".poly",
    ],
  },
  // HDF5/netCDF-backed containers (meshio++ >= 8.0.0 wasm builds only). `.med`
  // is writable since meshio++ 9.9.0 and carries SubModelParts as families;
  // `.exo` writes lossily (block names survive as SubModelParts, but genuine
  // SubModelParts and time steps do not) — see MESHIO_WRITE_FORMAT's docblock
  // in meshioFormats.ts for what each one measured.
  { label: "HDF5 / netCDF", extensions: [".cgns", ".h5m", ".hmf", ".med", ".exo"] },
  // meshio++ field-only formats: geometry is dropped, only point fields kept.
  { label: "Fields", extensions: [".dex", ".ip", ".mff"] },
  // Write-only figure formats: a 2D/3D-projected drawing, not a re-readable mesh.
  { label: "Figures", extensions: [".svg", ".tikz"] },
];

export function isExportableExtension(ext: string): ext is ExportableExtension {
  return (EXPORTABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** True when our own writer layer emits `ext` synchronously as text. */
export function isNativeExportExtension(ext: string): boolean {
  return (NATIVE_EXPORT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}
