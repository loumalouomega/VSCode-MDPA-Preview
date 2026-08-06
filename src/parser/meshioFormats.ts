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
 * meshio++'s namespace for Exodus per-element attributes (upstream
 * `formats/exodus.hpp`'s `kExodusAttributePrefix`).
 *
 * Exodus stores a fixed number of floats per element of a block (`attrib{k}`,
 * named by `attrib_name{k}`) — the standard home for a SPHERE's radius, a
 * beam's cross-section, a shell's thickness. meshio++ >= 9.3.0 carries them as
 * `cell_data` under this prefix, which keeps an attribute (constant in time)
 * apart from a same-named element *variable* (per time step), and on write is
 * the only signal saying which arrays belong in `attrib{k}`.
 *
 * meshioConvert.ts strips it on read and re-applies it when writing Exodus.
 */
export const EXODUS_ATTRIBUTE_PREFIX = "exodus:attr:";

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
  ".cgns": ["cgns"], // HDF5-backed; needs a meshio++ >= 8.0.0 wasm build
  ".dat": ["tecplot"],
  ".dato": ["permas"],
  ".dex": ["dex"],
  ".e": ["exodus"], // netCDF-backed; needs a meshio++ >= 8.6.0 wasm build
  ".ele": ["tetgen"],
  ".ex2": ["exodus"],
  ".exo": ["exodus"],
  ".f3grid": ["flac3d"],
  ".fem": ["nastran"],
  ".geo": ["ensight"], // EnSight Gold geometry file
  ".h5m": ["h5m"], // HDF5-backed (MOAB)
  ".hmf": ["hmf"], // HDF5-backed
  ".ip": ["ip"],
  ".med": ["med"], // HDF5-backed (Salome MED)
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
 *
 * `openfoam` is directory-based in BOTH directions, and only the write half is
 * reachable from here (see MESHIO_WRITE_FORMAT's `.foam` entry).  Reading a
 * case means staging `constant/polyMesh/{points,faces,owner,neighbour,
 * boundary}` in MEMFS, which readMeshioModel's single-file staging cannot
 * supply — `meshioSiblingNames` expresses a PAIR of files, not a tree — so no
 * extension maps to it on read.
 *
 * `cgns`/`h5m`/`hmf`/`med`/`exodus` need HDF5 or netCDF, which the wasm build
 * only gained in meshio++ 8.0.0.  `exodus` additionally needed 8.6.0: before
 * that the reader threw ReadError on `qa_records`/`info_records`/node sets —
 * a Python-fallback deferral that does not exist in wasm, so every real
 * SEACAS/Cubit/Sierra file (all of which carry `qa_records`) failed to open.
 * `readMesh(..., "exodus")` and `readerSupportsOptions("exodus")` (needed for
 * `timeStep` selection — see meshio.ts's readMeshioModel) are both verified
 * working against the live 9.9.0 artifact, as is `readerSupportsOptions("med")`
 * — MED joined the options-aware readers at 9.9.0, which is what makes the
 * lenient retry in readMeshioModel reachable at all.
 *
 * Two keys the live artifact reports are deliberately absent: `mdpa` (parsed
 * natively everywhere in this extension, never routed through meshio++) and
 * `gmsh22` (a write-only alias for the legacy MSH 2.2 format; `.msh` writes
 * 4.1).  meshFormats.test.ts asserts only that these tables are a SUPERSET of
 * what we route, so the omissions are intentional rather than drift.
 */
export const MESHIO_READER_KEYS: readonly string[] = [
  "abaqus", "ansys", "ansysinp", "avsucd", "cgns", "dex", "dolfin", "ensight",
  "exodus", "flac3d", "flux", "freefem", "gmsh", "h5m", "hmf", "ip", "med",
  "medit", "mff", "mfm", "mphtxt", "nastran", "netgen", "obj", "off",
  "openfoam", "permas", "ply", "stl", "su2", "tecplot", "tetgen", "triangle",
  "ugrid", "unv", "vtk", "vtp", "vtu", "wkt", "xdmf",
];

/**
 * Every meshio++ writer key: readers() plus the two write-only figure formats
 * `svg` and `tikz` (js_bindings.cpp writers()).
 *
 * `openfoam` used to be subtracted here — it was read-only through 9.19.0.
 * meshio++ 9.20.0 added the polyMesh writer, and the live 9.22.0 artifact
 * reports it in `availableFormats().writers`, so readers and writers now
 * differ only by the two figure formats.
 */
export const MESHIO_WRITER_KEYS: readonly string[] = [
  ...MESHIO_READER_KEYS,
  "svg",
  "tikz",
];

/**
 * Extension -> the explicit meshio++ format key used on write.
 *
 * Excluded on purpose:
 *  - `.xml` (dolfin): the writer is triangle/tetrahedron-only and RAISES on
 *    anything else — correct by format (DOLFIN XML is simplicial), but it means
 *    the entry would fail for most Kratos meshes. Its field data is no longer
 *    the problem (meshio++ 9.9.0 writes `point_data` as `dim="0"` mesh
 *    functions and already round-tripped `cell_data`), but each array is its
 *    own `<stem>_<name>.xml` sibling file, so one export would scatter a dozen
 *    files a Save As dialog never named.
 *  - `.ele`/`.node` (tetgen) and `.case`/`.geo` (ensight): each writes TWO
 *    files (<stem>.node + <stem>.ele; <stem>.case + <stem>.geo — cpp/src/
 *    formats/tetgen.cpp:40-50, ensight.cpp:835-862), which a single-path write
 *    cannot express. Triangle's `.poly`, by contrast, writes one file.
 *    (`writeMeshioBytes` does return companions, so this is a save-dialog
 *    shape question rather than an upstream limitation — an `.ele` picked in a
 *    Save As dialog would silently produce a second file the user never named.)
 *  - `.vtp`: ours (VTK XML PolyData writer), so meshio++'s is not routed here.
 *  - `.obj`/`.ply`/`.stl`/`.vtk`/`.vtu`: ours (see MESHIO_READ_CANDIDATES).
 *
 * `.med` (Salome) became writable at meshio++ 9.9.0 and is measured, not
 * assumed — it was excluded through 9.8.0 because **any** vector field wrote
 * without error and then threw "MED: field data size does not match its
 * declared shape" on the read back, which a real Kratos mesh trips at once.
 * The cause was the shapeless data boundary, closed by the `*_components`
 * maps modelToMeshio now emits; re-measured at 9.22.0 against the Kratos
 * fixture that used to fail, a VELOCITY vector field round-trips intact.
 * What a MED export does and does not carry:
 *  - Point and cell fields survive, scalar and vector alike.
 *  - SubModelParts survive as MED families, from the `regions` modelToMeshio
 *    emits; MED keys a family by NAME, so a part's node and cell regions are
 *    deliberately given the same name and come back as one part. A part's
 *    format-native id does not survive (a MED family id is per unique name
 *    COMBINATION, not per name) — nothing here needs it.
 *  - Blocks of the same cell type are consolidated into one `MAI/<type>`
 *    section, so `Triangle2D3` Geometries and `Element2D3N` Elements come back
 *    as a single `triangle` block. The per-block `Cell` regions are what still
 *    name them.
 *  - MED reads add `point_tags`/`cell_tags` arrays of its own (the family ids
 *    the regions were derived from), so a re-opened export carries two extra
 *    integer fields.
 *
 * `.e`/`.exo`/`.ex2` (Exodus) is writable since meshio++ 9.3.0, but lossily,
 * and the losses are worth knowing before you pick it (re-measured at 9.22.0;
 * 9.9.0 was what changed two of them, and nothing has moved since):
 *  - Element blocks survive, and so does `point_data`. A nodal variable whose
 *    name ends in `X`/`Y`/`Z` is re-stacked with its siblings into a vector on
 *    read — an upstream Exodus convention, and the one that reassembles a
 *    Kratos-split `DISPLACEMENT_X/Y/Z` triple.
 *  - Per-element scalars go through the `exodus:attr:` namespace (constant-in-
 *    time attributes — where a particle RADIUS belongs); everything else in
 *    `cell_data` is now written as an element VARIABLE, vectors included
 *    (meshio++ 9.9.0; before that it was dropped). An unprefixed array that
 *    does not cover every block is still warn-and-skipped upstream.
 *  - Block NAMES now round-trip (`eb_names`, meshio++ 9.9.0) via the per-block
 *    `Cell` regions modelToMeshio emits — they come back as one SubModelPart
 *    per block instead of the reader's synthetic `Block N`. Node sets and side
 *    sets are still not written, so a genuine SubModelPart does NOT survive.
 *  - A single time step is emitted, labelled from `field_data["exodus:time"]`,
 *    which nothing here sets — so a time series is still flattened to 0.0.
 *  - The output is NetCDF-4/HDF5, not classic netCDF-3.
 *
 * `.foam` (OpenFOAM polyMesh) is the one entry here that is NOT a single file,
 * and it is why MeshioCompanionFile.name carries a relative PATH rather than a
 * basename.  meshio++ 9.20.0 added the writer (the format was read-only
 * before); measured against the live 9.22.0 artifact, writing `<dir>/x.foam`
 * emits a 0-byte marker at that exact path — which is what `data` carries —
 * plus the real mesh as five files under `<dir>/constant/polyMesh/`:
 * `points`, `faces`, `owner`, `neighbour`, `boundary`.  Those five arrive as
 * companions with `constant/polyMesh/`-prefixed names, so a caller that
 * mkdir's each companion's dirname reproduces the tree (see meshio.ts's
 * writeMeshioBytes and meshExport.ts's serializeModelToPath).
 *
 * Two limits worth knowing before picking it:
 *  - The generic registry writer has no `OpenFoamInfo` side channel, so every
 *    case gets ONE synthesized `defaultFaces` patch of type `patch` — which is
 *    what `blockMesh` itself produces.  Patch names are never inferred from
 *    geometry, and a real case's patch names cannot be round-tripped through
 *    this path.
 *  - Reading is not wired up (see MESHIO_READER_KEYS) — this is export-only.
 */
export const MESHIO_WRITE_FORMAT: Readonly<Record<string, string>> = {
  ".msh": "gmsh",
  ".e": "exodus",
  ".ex2": "exodus",
  ".exo": "exodus",
  ".inp": "abaqus",
  ".avs": "avsucd",
  ".bdf": "nastran",
  ".cgns": "cgns",
  ".dat": "tecplot",
  ".dato": "permas",
  ".dex": "dex",
  ".f3grid": "flac3d",
  ".fem": "nastran",
  ".foam": "openfoam", // writes a constant/polyMesh/ tree beside the marker
  ".h5m": "h5m",
  ".hmf": "hmf",
  ".ip": "ip",
  ".med": "med",
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

/** Extensions meshio++ reads for us (39). */
export const MESHIO_READ_EXTENSIONS: readonly string[] =
  Object.keys(MESHIO_READ_CANDIDATES);

/**
 * Formats whose strict read is worth retrying leniently (meshio++ >= 9.9.0's
 * `ReadOptions::mLenient`) before giving up — see readMeshioModel.
 *
 * `med` only, and for a specific reason: meshio++'s Python surface silently
 * falls back to a pure-Python reference reader for the MED constructs its C++
 * core declines (a field's units, a non-default timestep key, a named profile,
 * an ELNO/ELGA support), and wasm has no such fallback — so through 9.8.0 a
 * real Salome/Code_Aster file simply could not be opened here at all.  A
 * lenient read gets through it, dropping the individual fields that cannot be
 * represented.  Which ones were dropped is not knowable from JS: upstream
 * records them in a `MedInfo` the registry boundary discards, so the diagnostic
 * readMeshioModel emits can only say that a lenient read was needed.
 */
export const MESHIO_LENIENT_RETRY_FORMATS: readonly string[] = ["med"];

/**
 * Extensions meshio++ writes for us (37).  `as const` because
 * writers/exportFormats.ts spreads this into EXPORTABLE_EXTENSIONS, which is
 * the source of the ExportableExtension union.
 *
 * `.dex`/`.ip`/`.mff` are meshio++'s field-only formats: they carry point_data
 * with no cell geometry, so writing one keeps the points + a field and drops
 * all connectivity (reading one yields a point cloud, or an empty mesh for
 * `.mff`). `.svg`/`.tikz` are write-only figure formats (a 2D/3D-projected
 * drawing of the mesh, not a re-readable mesh). Included for meshio++ parity /
 * MCP `mesh_convert`.
 *
 * `.xdmf`/`.xmf` and `.foam` are the MULTI-file writers here, and they are
 * multi-file in two different shapes:
 *  - Since meshio++ 8.0.0 the wasm XDMF writer puts the heavy arrays in a
 *    companion `<stem>.h5` and leaves `<stem>.h5:/data0` references in the XML
 *    — one SIBLING beside the main file.
 *  - Since meshio++ 9.20.0 the OpenFOAM writer emits a `constant/polyMesh/`
 *    DIRECTORY beside a 0-byte `.foam` marker — five companions carrying a
 *    relative path rather than a basename.
 * Either way `writeMeshioBytes` returns them and every caller must write them
 * beside the main file, creating directories as needed.
 *
 * `.e`/`.exo`/`.ex2` write lossily — see MESHIO_WRITE_FORMAT's docblock.
 */
export const MESHIO_EXPORT_EXTENSIONS = [
  ".msh", ".e", ".ex2", ".exo", ".inp", ".avs", ".bdf", ".cgns", ".dat",
  ".dato", ".dex", ".f3grid", ".fem", ".foam", ".h5m", ".hmf", ".ip", ".med",
  ".mesh", ".mff", ".mfm", ".mphtxt", ".nas", ".off", ".pf3", ".poly", ".post",
  ".su2", ".svg", ".tec", ".tikz", ".ugrid", ".unv", ".vol", ".wkt", ".xdmf",
  ".xmf",
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
