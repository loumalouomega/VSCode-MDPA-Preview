/**
 * meshio++ format/cell-type tables for the extended mesh formats served by
 * `@meshioplusplus/wasm` (see meshio.ts for the loader, meshioConvert.ts for
 * the Mesh <-> MdpaModel bridge).
 *
 * Pure constants — no node / DOM / wasm imports, because the webview bundle
 * reaches this file through writers/exportFormats.ts.
 *
 * The tables mirror the meshio++ C++ core; keep them in sync with:
 *   cpp/include/meshioplusplus/vtk_common.hpp  (meshio_to_vtk_type, meshio_to_vtk_order)
 *   bindings_js/js_bindings.cpp                (extension_defaults, readers, writers)
 */

/**
 * meshio++ cell-type name -> VTK cell type id.
 *
 * Deliberately a SUBSET of the core's meshio_to_vtk_type(): only types that
 * geometryMap.ts's VtkCellType knows (so the webview can draw them), plus
 * `polygon`, which modelBuilder.buildBlocksFromOffsets normalizes into
 * triangles/quads.  Everything else (pixel, penta_prism, hexa_prism, quad6,
 * wedge12/18, hexahedron24, triangle7, line4, polyhedron and the
 * VTK_LAGRANGE / VTK_BEZIER high-order families) is absent on purpose:
 * meshioConvert skips those blocks with a diagnostic rather than emitting
 * cells the renderer would show as "unknown".
 */
export const MESHIO_TO_VTK_TYPE: Readonly<Record<string, number>> = {
  vertex: 1,
  line: 3,
  triangle: 5,
  polygon: 7, // normalized to TRIANGLE/QUAD/fan by buildBlocksFromOffsets
  quad: 9,
  tetra: 10,
  hexahedron: 12,
  wedge: 13,
  pyramid: 14,
  line3: 21,
  triangle6: 22,
  quad8: 23,
  tetra10: 24,
  hexahedron20: 25,
  wedge15: 26,
  pyramid13: 27,
  quad9: 28,
  hexahedron27: 29,
};

/** VTK cell type id -> meshio++ cell-type name (inverse of MESHIO_TO_VTK_TYPE). */
export const VTK_TO_MESHIO_TYPE: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MESHIO_TO_VTK_TYPE).map(([name, vtk]) => [vtk, name])
  ) as Record<number, string>
);

/**
 * Node-index permutation between meshio order and VTK order.
 *
 * `perm[j]` = the meshio-order index that belongs at VTK-order position `j`.
 * Only the linear wedge differs (meshio/gmsh prism ordering vs. vtkWedge) —
 * see vtk_common.hpp's meshio_to_vtk_order().  Miss this and every prism
 * renders inside-out and meshQuality's dihedral angles go wrong.
 *
 * [0,2,1,3,5,4] is its own inverse, so the same table serves both directions.
 */
export const MESHIO_TO_VTK_ORDER: Readonly<Record<string, readonly number[]>> = {
  wedge: [0, 2, 1, 3, 5, 4],
};

/**
 * Extension -> meshio++ format keys to try when reading, in order.
 *
 * Mirrors js_bindings.cpp's extension_defaults(), MINUS the extensions this
 * extension parses itself (.obj/.ply/.stl/.vtk/.vtu) — those readers stay
 * authoritative because they carry things meshio++ drops (OBJ g/o groups,
 * PLY vertex fields, VTK timeline/multiblock).
 *
 * More than one entry = the extension is ambiguous and meshio++ cannot
 * auto-detect: try the default (first) key, and on failure retry the rest.
 */
export const MESHIO_READ_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  ".msh": ["gmsh", "ansys", "freefem"], // default gmsh
  ".inp": ["abaqus", "ansysinp"], // default abaqus
  ".avs": ["avsucd"],
  ".bdf": ["nastran"],
  ".case": ["ensight"], // EnSight Gold master file (needs its .geo sibling)
  ".dat": ["tecplot"],
  ".dato": ["permas"],
  ".dex": ["dex"],
  ".ele": ["tetgen"],
  ".f3grid": ["flac3d"],
  ".fem": ["nastran"],
  ".geo": ["ensight"], // EnSight Gold geometry file
  ".ip": ["ip"],
  ".mesh": ["medit"],
  ".mff": ["mff"],
  ".mfm": ["mfm"],
  ".mphtxt": ["mphtxt"],
  ".nas": ["nastran"],
  ".node": ["tetgen"],
  ".off": ["off"],
  ".pf3": ["flux"],
  ".poly": ["triangle"], // Shewchuk Triangle PSLG (.node/.ele stay tetgen)
  ".post": ["permas"],
  ".su2": ["su2"],
  ".tec": ["tecplot"],
  ".ugrid": ["ugrid"],
  ".unv": ["unv"],
  ".vol": ["netgen"],
  ".wkt": ["wkt"],
  ".xdmf": ["xdmf"],
  ".xmf": ["xdmf"],
  ".xml": ["dolfin"],
};

/**
 * Every meshio++ reader key (js_bindings.cpp's readers()).  Used to validate
 * MESHIO_READ_CANDIDATES and explicit MCP `inputFormat` arguments.
 * `openfoam` is read-only AND directory-based, so no extension maps to it.
 */
export const MESHIO_READER_KEYS: readonly string[] = [
  "abaqus", "ansys", "ansysinp", "avsucd", "dex", "dolfin", "ensight", "flac3d",
  "flux", "freefem", "gmsh", "ip", "medit", "mff", "mfm", "mphtxt", "nastran",
  "netgen", "obj", "off", "openfoam", "permas", "ply", "stl", "su2", "tecplot",
  "tetgen", "triangle", "ugrid", "unv", "vtk", "vtp", "vtu", "wkt", "xdmf",
];

/**
 * Every meshio++ writer key: readers() minus openfoam (read-only), plus the
 * two write-only figure formats `svg` and `tikz` (js_bindings.cpp writers()).
 */
export const MESHIO_WRITER_KEYS: readonly string[] = [
  ...MESHIO_READER_KEYS.filter((k) => k !== "openfoam"),
  "svg",
  "tikz",
];

/**
 * Extension -> the explicit meshio++ format key used on write.
 *
 * Excluded on purpose:
 *  - `.xml` (dolfin): the writer is tri/tet-only and silently drops every
 *    other block plus all field data (cpp/src/formats/dolfin.cpp:54,162).
 *  - `.ele`/`.node` (tetgen) and `.case`/`.geo` (ensight): each writes TWO
 *    files (<stem>.node + <stem>.ele; <stem>.case + <stem>.geo — cpp/src/
 *    formats/tetgen.cpp:40-50, ensight.cpp:835-862), which a single-path write
 *    cannot express. Triangle's `.poly`, by contrast, writes one file.
 *  - `.vtp`: ours (VTK XML PolyData writer), so meshio++'s is not routed here.
 *  - `.obj`/`.ply`/`.stl`/`.vtk`/`.vtu`: ours (see MESHIO_READ_CANDIDATES).
 */
export const MESHIO_WRITE_FORMAT: Readonly<Record<string, string>> = {
  ".msh": "gmsh",
  ".inp": "abaqus",
  ".avs": "avsucd",
  ".bdf": "nastran",
  ".dat": "tecplot",
  ".dato": "permas",
  ".dex": "dex",
  ".f3grid": "flac3d",
  ".fem": "nastran",
  ".ip": "ip",
  ".mesh": "medit",
  ".mff": "mff",
  ".mfm": "mfm",
  ".mphtxt": "mphtxt",
  ".nas": "nastran",
  ".off": "off",
  ".pf3": "flux",
  ".poly": "triangle", // single-file Triangle PSLG
  ".post": "permas",
  ".su2": "su2",
  ".svg": "svg", // write-only 2D/3D-projected figure
  ".tec": "tecplot",
  ".tikz": "tikz", // write-only LaTeX/PGF figure
  ".ugrid": "ugrid",
  ".unv": "unv",
  ".vol": "netgen",
  ".wkt": "wkt",
  ".xdmf": "xdmf",
  ".xmf": "xdmf",
};

/** Extensions meshio++ reads for us (32). */
export const MESHIO_READ_EXTENSIONS: readonly string[] =
  Object.keys(MESHIO_READ_CANDIDATES);

/**
 * Extensions meshio++ writes for us (29).  `as const` because
 * writers/exportFormats.ts spreads this into EXPORTABLE_EXTENSIONS, which is
 * the source of the ExportableExtension union.
 *
 * `.dex`/`.ip`/`.mff` are meshio++'s field-only formats: they carry point_data
 * with no cell geometry, so writing one keeps the points + a field and drops
 * all connectivity (reading one yields a point cloud, or an empty mesh for
 * `.mff`). `.svg`/`.tikz` are write-only figure formats (a 2D/3D-projected
 * drawing of the mesh, not a re-readable mesh). Included for meshio++ parity /
 * MCP `mesh_convert`.
 */
export const MESHIO_EXPORT_EXTENSIONS = [
  ".msh", ".inp", ".avs", ".bdf", ".dat", ".dato", ".dex", ".f3grid", ".fem",
  ".ip", ".mesh", ".mff", ".mfm", ".mphtxt", ".nas", ".off", ".pf3", ".poly",
  ".post", ".su2", ".svg", ".tec", ".tikz", ".ugrid", ".unv", ".vol", ".wkt",
  ".xdmf", ".xmf",
] as const;

/** True when meshio++ (rather than one of our own parsers) handles `ext`. */
export function isMeshioReadExtension(ext: string): boolean {
  return ext.toLowerCase() in MESHIO_READ_CANDIDATES;
}

/**
 * Companion file basenames a format needs beside the main file in MEMFS.
 *
 * Multi-file meshio++ formats read siblings off disk regardless of which member
 * was opened.  The stem is the path minus its LAST dot ("bunny.1.node" pairs
 * with "bunny.1.ele").  Returns basenames (MEMFS is flat); [] for single-file
 * formats.  meshFileParser reads whatever is returned; a genuinely missing
 * sibling is left to meshio++ to report with a real message.
 *  - tetgen `.node`/`.ele`: the pair, whichever half was opened (tetgen.cpp:41-53).
 *  - ensight `.case`/`.geo`: opening `.case` needs the `.geo` geometry
 *    (ensight.cpp:138-144); `.geo` reads standalone but pulling `.case` is harmless.
 *  - triangle `.poly`: may defer its vertices to a sibling `.node` (triangle.cpp:238-240).
 */
export function meshioSiblingNames(fileName: string, ext: string): string[] {
  const e = ext.toLowerCase();
  const stem = fileName.slice(0, fileName.lastIndexOf("."));
  if (e === ".node" || e === ".ele") return [`${stem}.node`, `${stem}.ele`];
  if (e === ".case" || e === ".geo") return [`${stem}.case`, `${stem}.geo`];
  if (e === ".poly") return [`${stem}.poly`, `${stem}.node`];
  return [];
}
