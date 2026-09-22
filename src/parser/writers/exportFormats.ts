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

/** Extensions our own writer layer emits — synchronous, text (writeMeshFile),
 *  except `.vtm`, which is an index plus one `.vtu` per dataset and therefore
 *  only via `writeMeshFileAsync` (its companions carry the datasets). */
export const NATIVE_EXPORT_EXTENSIONS = [
  ".mdpa",
  ".vtk",
  ".vtu",
  ".vtp",
  ".vtm",
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
  ".vtm": "VTK Multiblock",
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
  ".foam": "OpenFOAM polyMesh",
  ".post.msh": "GiD postprocess (.post.msh + .post.res)",
  ".h5m": "MOAB H5M",
  ".hmf": "HMF",
  ".ip": "IP (fields only)",
  ".k": "LS-DYNA (geometry only)",
  ".med": "MED (Salome)",
  ".mesh": "Medit",
  ".mff": "MFF (fields only)",
  ".mfm": "Modulef MFM",
  ".mphtxt": "COMSOL",
  ".nas": "Nastran (.nas)",
  ".off": "OFF",
  ".pcd": "Point Cloud (PCD, no cells)",
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
  ".vtkhdf": "VTKHDF",
  ".wkt": "WKT",
  ".xdmf": "XDMF",
  ".xmf": "XDMF (.xmf)",
  ".xyz": "Point Cloud (XYZ, no cells)",
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
  { label: "VTK", extensions: [".vtk", ".vtu", ".vtp", ".vtm", ".xdmf", ".vtkhdf"] },
  {
    label: "Surface",
    extensions: [".stl", ".obj", ".ply", ".off", ".wkt", ".pcd", ".xyz"],
  },
  {
    label: "Solvers",
    extensions: [
      ".msh", ".mesh", ".inp", ".bdf", ".unv", ".vol", ".su2", ".dat",
      ".avs", ".f3grid", ".pf3", ".mfm", ".mphtxt", ".post", ".ugrid", ".poly",
      ".k",
      // Writes a constant/polyMesh/ DIRECTORY beside the .foam marker, not one
      // file (meshio++ >= 9.20.0). See MESHIO_WRITE_FORMAT's `.foam` docblock.
      ".foam",
      // GiD postprocess (meshio++ >= 10.18.0), the ascii flavour: a .post.msh
      // geometry file plus a .post.res results SIBLING, which comes back as a
      // companion exactly like XDMF's .h5. The one COMPOUND extension in this
      // registry — see meshExtname in meshioFormats.ts for why that needs care.
      ".post.msh",
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

/**
 * Ambiguous export extensions and the meshio++ writer keys each one offers,
 * default first. `.msh` is Gmsh unless asked otherwise, `.inp` is Abaqus —
 * the alternatives used to be reachable only through MCP `mesh_convert`'s
 * explicit `outputFormat`, so the host's Export paths ask via a QuickPick
 * when no flavour was passed. Mirrors `MESHIO_READ_CANDIDATES` for these two
 * extensions (asserted in meshFormats.test.ts); every key must also be a real
 * writer key, since these feed `writeMeshioBytes`' `format` verbatim.
 */
export const EXPORT_FORMAT_FLAVOURS: Readonly<Record<string, readonly string[]>> = {
  ".msh": ["gmsh", "ansys", "freefem"],
  ".inp": ["abaqus", "ansysinp"],
};

/** Human-readable label per flavour key (for the QuickPick and dialog titles). */
export const EXPORT_FLAVOUR_LABELS: Readonly<Record<string, string>> = {
  gmsh: "Gmsh",
  ansys: "ANSYS",
  freefem: "FreeFem",
  abaqus: "Abaqus",
  ansysinp: "ANSYS",
};

/** True when our own writer layer emits `ext` synchronously as text. */
export function isNativeExportExtension(ext: string): boolean {
  return (NATIVE_EXPORT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}
