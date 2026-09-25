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
 * The meshio++ "fidelity carrier" array names — see meshioFidelity.ts, which
 * consumes these to reconstruct Kratos ids/kind/propertyIds/grouping after an
 * operation whose result would otherwise be adopted lossily. Live here,
 * alongside `EXODUS_ATTRIBUTE_PREFIX`, because this file is the zero-import
 * leaf both meshioConvert.ts (emits them) and meshioFidelity.ts (reads them
 * back) can import with no cycle.
 *
 * `MESHIO_ID_KEY`/`MESHIO_PROPERTY_KEY` are NOT this extension's invention —
 * they are meshio++'s OWN MDPA id/property-id conventions (`point_data`/
 * `cell_data["mdpa:id"]` in `src/cpp/src/formats/mdpa.cpp`'s `kMdpaIdName`,
 * and `cell_data["gmsh:physical"]`, MDPA's reuse of gmsh's tag-key
 * convention). `MESHIO_KIND_KEY` is ours: upstream only carries the
 * Elements/Conditions distinction in the per-format `MdpaInfo.entityNames`
 * side channel, which does not survive an operation, so this extension adds
 * its own per-cell carrier for it. The `sanitizeVariable` colon-stripping
 * that ordinary field names go through (see meshioConvert.ts) is exactly why
 * a colon-bearing name can never collide with a real Kratos variable.
 */
export const MESHIO_ID_KEY = "mdpa:id";
export const MESHIO_PROPERTY_KEY = "gmsh:physical";
export const MESHIO_KIND_KEY = "kratos:kind";
/**
 * The carry path's SubModelPart region-name prefix — see meshioConvert.ts's
 * `buildRegions`. A colon can never appear in a Kratos SubModelPart-derived
 * block name, so a region name starting with this is unambiguously a part,
 * never a block's own `Cell` region.
 */
export const MESHIO_PART_PREFIX = "kratos:smp/";
/**
 * Regions are NOT carrier-prefixed: `buildRegions` already emits one `Cell`
 * region per block (named after the `EntityBlock`) and one `Cell`+`Point`
 * region pair per SubModelPart UNCONDITIONALLY, carriers or not — that
 * mechanism predates this module. The carry path reuses it as-is and relies
 * on `regionsToParts`' dotted-nesting policy (see meshioRegions.ts) to
 * recover nested SubModelParts; block-name recovery on adopt goes through
 * `MESHIO_KIND_KEY` + the recovered entity id, not through a region.
 */
/** Every `point_data`/`cell_data` key the carry path emits, for stripping before `meshioToModel`. */
export const MESHIO_CARRIER_KEYS: ReadonlySet<string> = new Set([
  MESHIO_ID_KEY,
  MESHIO_PROPERTY_KEY,
  MESHIO_KIND_KEY,
]);


/**
 * meshio++ cell-type name -> VTK cell type id.
 *
 * Deliberately a SUBSET of the core's meshio_to_vtk_type(): only types that
 * geometryMap.ts's VtkCellType knows (so the webview can draw them), plus
 * `polygon`, which modelBuilder.buildBlocksFromOffsets normalizes into
 * triangles/quads.  Everything else (pixel, penta_prism, hexa_prism, quad6,
 * wedge12, hexahedron24, line4, polyhedron and the VTK_LAGRANGE / VTK_BEZIER
 * high-order families) is absent on purpose: meshioConvert skips those blocks
 * with a diagnostic rather than emitting cells the renderer would show as
 * "unknown".
 *
 * The 16.14.0 bump added `wedge18` and `triangle7` here (both new to
 * upstream's own table in 16.0.0, the same release that taught MED to read
 * HEXA27/PENTA18).  `hexahedron27` was already mapped, since 9.9.0, which is
 * why MED's 27-node hexahedron opened while its 18-node wedge did not.
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
  // meshio++ 16.0.0. `wedge18` is MED's P18 / Code_Aster's PENTA18; note
  // upstream FIXED a bug here in the same release — the Python engine had
  // been naming the group `PE18`, which is not MED's name.
  wedge18: 32,
  triangle7: 34,
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
  // meshio++ >= 16.7.0: the Abaqus results file, ASCII or binary in either
  // byte order, time-capable. Ambiguous by content upstream (its first card
  // says which), so the ordering here is ours: Abaqus' own `.fil` first.
  ".fil": ["abaqus_fil"],
  ".msh": ["gmsh", "ansys", "freefem"], // default gmsh
  ".inp": ["abaqus", "ansysinp"], // default abaqus
  ".avs": ["avsucd"],
  ".bdf": ["nastran"],
  ".case": ["ensight"], // EnSight Gold master file (needs its .geo sibling)
  ".cgns": ["cgns"], // HDF5-backed; needs a meshio++ >= 8.0.0 wasm build
  // meshio++ >= 16.3.0: MAPDL's binary results. Also recognised by content
  // (the standard header of MAPDL file 12), so the extension is a hint.
  ".rth": ["ansys_rst"],
  ".rst": ["ansys_rst"],
  // meshio++ >= 16.7.0: LS-DYNA' animation output. The name-only `d3plot`
  // spelling (no extension) is the more common one and is not routable from
  // here; this catches the files that DO carry it.
  ".d3plot": ["lsdyna_d3plot"],
  ".dat": ["tecplot"],
  ".dato": ["permas"],
  // meshio++ >= 15.7.0: the MSC Nastran HDF5 result database, time-capable.
  // `.h5` is genuinely ambiguous against MOAB's `.h5m`, so both are tried —
  // upstream refuses a non-MSC file and a non-MOAB one by name, so the retry
  // is safe in either order. GiD's longer `.post.h5` stays `gid` (below),
  // since meshExtname returns the longest registered compound match.
  ".h5": ["h5m", "nastran_h5"],
  ".dex": ["dex"],
  ".e": ["exodus"], // netCDF-backed; needs a meshio++ >= 8.6.0 wasm build
  ".ele": ["tetgen"],
  ".ex2": ["exodus"],
  ".exo": ["exodus"],
  ".f3grid": ["flac3d"],
  ".fem": ["nastran"],
  // meshio++ 12.0.0 reads a case from the marker path; openfoamCase.ts stages
  // the constant/polyMesh/ tree the reader resolves from it.
  ".foam": ["openfoam"],
  ".frd": ["frd"], // Calculix results — read-only upstream (absent from writers())
  ".geo": ["ensight"], // EnSight Gold geometry file
  ".h5m": ["h5m"], // HDF5-backed (MOAB)
  ".hdf": ["vtkhdf"], // upstream's own default since 15.1.0
  ".hmf": ["hmf"], // HDF5-backed
  ".ip": ["ip"],
  // LS-DYNA keyword deck (meshio++ >= 15.2.0). Only the geometry keywords
  // (*NODE/*ELEMENT_*) round-trip; solver control cards are not represented
  // in an MdpaModel and are silently absent on write.
  ".dyn": ["lsdyna"],
  ".k": ["lsdyna"],
  ".key": ["lsdyna"],
  ".med": ["med"], // HDF5-backed (Salome MED)
  ".mesh": ["medit"],
  ".mff": ["mff"],
  ".mfm": ["mfm"],
  ".mphtxt": ["mphtxt"],
  ".nas": ["nastran"],
  ".node": ["tetgen"],
  ".off": ["off"],
  // meshio++ >= 16.3.0: MSC Nastran's OP2 bulk result file, time-capable.
  ".op2": ["nastran_op2"],
  // Point-cloud formats (meshio++ >= 15.1.0). Neither has cells; a mesh
  // written to either drops all connectivity and keeps points + point_data.
  ".pcd": ["pcd"],
  ".pf3": ["flux"],
  ".poly": ["triangle"], // Shewchuk Triangle PSLG (.node/.ele stay tetgen)
  ".post": ["permas"],
  // GiD postprocess (meshio++ >= 10.19.0 for the reader). COMPOUND extensions,
  // and the reason meshFormats.ts has meshExtname: `path.extname` on
  // "case.post.msh" yields ".msh", which is gmsh above — three different
  // formats behind ".post", ".msh" and ".post.msh". Ascii is a `.post.msh` +
  // `.post.res` PAIR (see meshioSiblingNames); `.post.bin` and `.post.h5` are
  // single files, deflated and HDF5 respectively.
  ".post.msh": ["gid"],
  ".post.res": ["gid"],
  ".post.bin": ["gid"],
  ".post.h5": ["gid"],
  // Parallel/partitioned VTK XML (meshio++ >= 14.0.0, roadmap item 3): an
  // arbitrary number of <Piece Source="..."/> pieces, staged via
  // meshFileParser.ts's pvtuPieceFiles rather than a fixed-pair
  // meshioSiblingNames entry, since the piece count is not knowable from
  // the extension alone.
  ".pvtu": ["pvtu"],
  ".pvtp": ["pvtp"],
  ".su2": ["su2"],
  // meshio++ >= 16.8.0: MSC Marc's formatted post file, time-capable. `.dat`
  // is shared with Tecplot and with the `marc` input deck, so only the
  // unambiguous `.t19` is claimed here.
  ".t19": ["marc_t19"],
  ".tec": ["tecplot"],
  ".ugrid": ["ugrid"],
  ".unv": ["unv"],
  ".vol": ["netgen"],
  // HDF5-backed (meshio++ >= 14.0.0). `.hdf` above is upstream's own default
  // extension for the same key.
  ".vtkhdf": ["vtkhdf"],
  ".wkt": ["wkt"],
  ".xdmf": ["xdmf"],
  ".xmf": ["xdmf"],
  // meshio++ >= 16.2.0: FEBio's plot file, one state per read.
  ".xplt": ["xplt"],
  ".xml": ["dolfin"],
  // Point-cloud text formats (meshio++ >= 15.1.0), same no-cells shape as pcd.
  // `.txt`/`.asc`/`.pts` are upstream's OWN defaults for this reader too, but
  // are deliberately not claimed here — they would take over every plain text
  // file offered in the Open dialog.
  ".xyz": ["xyz"],
  ".xyzn": ["xyz"],
  ".xyzrgb": ["xyz"],
};

/**
 * Every meshio++ reader key (js_bindings.cpp's readers()).  Used to validate
 * MESHIO_READ_CANDIDATES and explicit MCP `inputFormat` arguments.
 *
 * `openfoam` is directory-based in BOTH directions, and both halves are now
 * reachable: `.foam` maps to it on read (see MESHIO_READ_CANDIDATES) since the
 * staging filesystem learned to hold a `constant/polyMesh/` TREE.  Before that
 * only the write half worked — `meshioSiblingNames` expresses a PAIR of files,
 * not a tree.  See openfoamCase.ts.
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
 * Five keys the live 15.4.0 artifact reports as readers are deliberately
 * absent, all for the same reason — nothing here routes to them: `mdpa`
 * (parsed natively everywhere in this extension, never routed through
 * meshio++), `vti` (VTK XML ImageData, upstream's since the 9.22.0 ->
 * 10.14.0 jump), the 11.6.0 additions `vts`/`vtr`/`vtm`, and `pvd`
 * (roadmap item 3). Reading `.vti`/`.vts`/`.vtr` is owned by our own
 * vtkXmlParser.ts, and upstream's writers *raise* on anything but a
 * dense/uniform lattice, which an unstructured MdpaModel never is — the
 * same fact that already keeps `.vti` out of NATIVE_EXPORT_EXTENSIONS —
 * while `vtm` is a multi-file index the single-path writer contract cannot
 * express (ours in writers/vtmWriter.ts stays authoritative). `pvd` is
 * read NATIVELY instead (pvdIndex.ts): each step is an ordinary
 * `.vtu`/`.vtp`, already owned by our own readers, and a native reader
 * lets step selection stay a light XML scan the same way XDMF's does,
 * with no wasm instance at all.
 *
 * `pvtu`/`pvtp` (parallel/partitioned VTK XML — an arbitrary number of
 * `<Piece Source="…"/>` fragments making up ONE static dataset, a
 * different concept from `pvd`'s time series) ARE routed (roadmap item 3),
 * closing a gap an earlier pass of this comment left open on the false
 * assumption that upstream's lack of its own WASM smoke coverage meant
 * they could not be read: measured directly against the live wasm instead
 * — `readerSupportsOptions("pvtu")` is `true` and a hand-built two-piece
 * `.pvtu` merges correctly through `readMeshSelective` — what was actually
 * missing was companion discovery, since a `.pvtu`/`.pvtp` references an
 * ARBITRARY NUMBER of pieces named inside its own XML rather than the
 * FIXED pair every other multi-file meshio format here stages
 * (`meshioSiblingNames`). `meshFileParser.ts`'s `pvtuPieceFiles` is that
 * discovery function, the `.pvd`/`xdmfDataFiles` shape. Writing is a
 * separate, still-absent capability: `MESHIO_WRITE_FORMAT` maps no
 * extension to `pvtu`/`pvtp`, since this extension has no writer that
 * produces a partitioned dataset (`MESHIO_WRITER_KEYS` lists the key only
 * because it is a superset of what is routed, not a claim that a `.pvtu`
 * export exists).
 *
 * Listing any of these five would put a guaranteed-to-throw or
 * un-stageable target in the MCP `outputFormat` menu. `gid` (GiD postprocess)
 * is by contrast PRESENT on both sides, because unlike those five it IS
 * routed: the four compound `.post.*` extensions above map to it on read
 * and `.post.msh` on write. Its write half needs gidpost, which is
 * hard-gated on zlib, so a build without either reports `gid` as readable
 * but not writable — measured against the published 12.0.0 artifact, this
 * one has both, and meshio.test.ts asserts that rather than assuming it.
 * meshFormats.test.ts asserts only that these tables are
 * a SUPERSET of what we route, so the omissions are intentional rather than
 * drift.
 *
 * `frd` (Calculix results, meshio++ >= 15.3.0) is read-only upstream — it is
 * absent from `availableFormats().writers`, not merely unrouted here, so it
 * belongs in MESHIO_READER_KEYS but is subtracted back out below.
 *
 * The 16.14.0 bump (roadmap Tier 0) added eleven solver-RESULT readers and
 * routed the seven that have a real extension (`.fil`, `.rst`/`.rth`,
 * `.d3plot`, `.t19`, `.h5`, `.op2`, `.xplt` — see MESHIO_READ_CANDIDATES).
 * The other four are listed here but are deliberately NOT candidates, because
 * upstream finds them by FILE NAME and not by extension, so no extension this
 * extension offers can reach them: `ansys_rst_cyclic` (a cyclic-symmetry
 * model's full rotor rather than one sector — which is also why it must not
 * become an automatic `.rst` retry, since that would silently change what a
 * plain `.rst` means), `lsdyna_binout` (`binout`, `binout0000`, …),
 * `radioss_anim` (`<stem>A001`, `<stem>A002`, …) and `radioss_th`
 * (`<stem>T01`, …). All four stay reachable through an explicit MCP
 * `inputFormat`, which is what this table gates. So MESHIO_READER_KEYS means
 * "a reader key this build links and this extension accepts being told to
 * use" — a superset of "a key some extension routes to", and
 * `mesh_capabilities`' `unroutedReaders` is where the difference between the
 * two is reported per key, each with a reason.
 */
export const MESHIO_READER_KEYS: readonly string[] = [
  "abaqus", "abaqus_fil", "ansys", "ansys_rst", "ansys_rst_cyclic", "ansysinp",
  "avsucd", "cgns", "dex", "dolfin", "ensight", "exodus", "flac3d", "flux",
  "frd", "freefem", "gid", "gmsh", "h5m", "hmf", "ip", "lsdyna",
  "lsdyna_binout", "lsdyna_d3plot", "marc_t19", "med", "medit", "mff", "mfm",
  "mphtxt", "nastran", "nastran_h5", "nastran_op2", "netgen", "obj", "off",
  "openfoam", "pcd", "permas", "ply", "pvtp", "pvtu", "radioss_anim",
  "radioss_th", "stl", "su2", "tecplot", "tetgen", "triangle", "ugrid", "unv",
  "vtk", "vtkhdf", "vtp", "vtu", "wkt", "xdmf", "xplt", "xyz",
];

/**
 * Reader keys the live build does NOT also expose as writers — it reports
 * them from `availableFormats().readers` and not from `.writers`, so they are
 * subtracted from MESHIO_WRITER_KEYS rather than being absent by omission.
 * Measured against the 16.14.0 artifact.
 *
 * `frd` (CalculiX results, >= 15.3.0) has been read-only since it arrived.
 * The eleven solver-RESULT readers the 16.14.0 bump brought in are all
 * read-only too, and for the same structural reason upstream has no reason to
 * grow the other direction: a `.fil`/`.rst`/`.op2`/`.d3plot` result file is
 * something a solver produced, and meshio++'s job is to read it, not to
 * author a file a solver would accept. That is the same argument that keeps
 * `gltf` routed-but-unwritten for want of a consumer rather than a writer.
 *
 * Kept as a named set rather than eleven inline `!==` tests: the next release
 * that adds a read-only reader should be one line here, and
 * `mcpTools.test.ts`'s live-build assertion is what proves the set is neither
 * missing a key nor carrying one the build does write.
 */
export const MESHIO_READ_ONLY_KEYS: readonly string[] = [
  "abaqus_fil",
  "ansys_rst",
  "ansys_rst_cyclic",
  "frd",
  "lsdyna_binout",
  "lsdyna_d3plot",
  "marc_t19",
  "nastran_h5",
  "nastran_op2",
  "radioss_anim",
  "radioss_th",
  "xplt",
];

/**
 * Every meshio++ writer key we route to or validate against: readers() MINUS
 * the read-only keys above PLUS the two write-only figure formats `svg`/`tikz`
 * (js_bindings.cpp writers(), present since before this table existed).
 *
 * `openfoam` used to be subtracted here — it was read-only through 9.19.0.
 * meshio++ 9.20.0 added the polyMesh writer, so it stays in.
 *
 * `gltf`/`glb` (meshio++ >= 15.4.0, write-only — no reader exists upstream
 * either) and `gmsh22` (a write-only alias for the legacy MSH 2.2 format;
 * `.msh` writes 4.1) ARE real writer keys the live artifact reports, and are
 * deliberately absent here for the same "nothing routes to them" reason as
 * the five reader-side omissions above: no extension maps to `gltf`/`glb`
 * (no web-viewer consumer in this extension yet) and none maps to `gmsh22`
 * (4.1 is the only Gmsh flavour offered). `pvd` is also absent from THIS
 * table even though it is now routed (pvdIndex.ts): it has no meshio++
 * writer key backing it — `.pvd` export is `sequenceExport.ts`'s own
 * `packPvdSeries` (roadmap item 3), never `writeMeshioBytes`.
 */
export const MESHIO_WRITER_KEYS: readonly string[] = [
  ...MESHIO_READER_KEYS.filter((key) => !MESHIO_READ_ONLY_KEYS.includes(key)),
  "svg",
  "tikz",
];

/**
 * Extension -> the explicit meshio++ format key used on write.
 *
 * Excluded on purpose:
 *  - `.vtp`: ours (VTK XML PolyData writer), so meshio++'s is not routed here.
 *  - `.obj`/`.ply`/`.stl`/`.vtk`/`.vtu`: ours (see MESHIO_READ_CANDIDATES).
 *
 * `.xml` (dolfin), `.ele` (tetgen, with a `.node` companion) and `.case`
 * (ensight, with a `.geo` companion) were excluded through 4.2.0 for a
 * save-dialog shape reason rather than an upstream one: DOLFIN raises on
 * anything but triangles/tetrahedra, tetgen and ensight each write TWO files
 * (<stem>.node + <stem>.ele — `cpp/src/formats/tetgen.cpp`; <stem>.case +
 * <stem>.geo — `ensight.cpp`), and nothing checked either constraint before
 * the wasm ran. `writeMeshioBytes` already returns companions for every
 * other multi-file format (XDMF's `.h5`, OpenFOAM's `constant/polyMesh/`),
 * so the missing piece was never the companion plumbing — it was
 * `exportEligibility.ts`, which now refuses BEFORE the write with the actual
 * geometric reason (DOLFIN/tetgen: no triangle/tetrahedron cells;
 * DOLFIN/tetgen mixed-type meshes: drops the rest with a named warning) and
 * is called from `serializeToPath` (meshExport.ts) and MCP `writeModel`
 * (mcp/tools.ts) before `writeMeshFileAsync`. DOLFIN's field data is a
 * warning, not a refusal: each array becomes its own `<stem>_<name>.xml`
 * sibling file (meshio++ >= 9.9.0), which `writeModelFile`'s companion
 * handling already writes correctly — it is simply not what most people
 * expect from "Export…", hence the warning.
 *
 * `.med` (Salome) became writable at meshio++ 9.9.0 and is measured, not
 * assumed — it was excluded through 9.8.0 because **any** vector field wrote
 * without error and then threw "MED: field data size does not match its
 * declared shape" on the read back, which a real Kratos mesh trips at once.
 * The cause was the shapeless data boundary, closed by the `*_components`
 * maps modelToMeshio now emits; re-measured at 12.0.0 against the Kratos
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
 * and the losses are worth knowing before you pick it (re-measured at 12.0.0;
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
 * before); measured against the live 12.0.0 artifact, writing `<dir>/x.foam`
 * emits a 0-byte marker at that exact path — which is what `data` carries —
  * plus the real mesh as six files under `<dir>/constant/polyMesh/` (points,
  * faces, owner, neighbour, boundary, plus cellZones since 11.4.0):
 * `points`, `faces`, `owner`, `neighbour`, `boundary`.  Those five arrive as
 * companions with `constant/polyMesh/`-prefixed names, so a caller that
 * mkdir's each companion's dirname reproduces the tree (see meshio.ts's
 * writeMeshioBytes and meshExport.ts's serializeModelToPath).
 *
 * Two limits worth knowing before picking it:
 *  - The generic registry writer has no `OpenFoamInfo` side channel, so it
 *    emits ONE synthesized `defaultFaces` patch of type `patch` — which is
 *    what `blockMesh` itself produces.  Patch names are never inferred from
 *    geometry; instead they are recovered afterwards from the model's own
 *    leaf SubModelParts (see `openfoamWrite.ts`), so a case read with named
 *    patches re-exports with those names (types defaulting to `patch`).
 *    A mesh with no patch information still gets the single `defaultFaces`.
 *  - Reading IS wired up now (`.foam` is a read candidate; see openfoamCase.ts).
 *
 * `.k` (LS-DYNA, meshio++ >= 15.2.0): geometry keywords only (`*NODE`,
 * `*ELEMENT_*`); no solver control cards, since an MdpaModel has nowhere to
 * keep them. `.key`/`.dyn` are read candidates for the same key but are not
 * offered as write targets — one canonical extension per format, the same
 * policy that keeps `.e`/`.ex2` out while only `.exo` exports.
 *
 * `.pcd`/`.xyz` (meshio++ >= 15.1.0): point-cloud formats with no cell
 * concept — every EntityBlock's connectivity is dropped, only nodes and
 * Nodal fields survive. `.xyzn`/`.xyzrgb` are read-only aliases, not offered
 * as write targets for the same one-canonical-extension reason as `.k`.
 *
 * `.vtkhdf` (meshio++ >= 14.0.0): HDF5-backed VTK, structurally the same
 * unstructured/point/cell-data shape as `.vtu`, so nothing is lost that
 * `.vtu` itself would not already lose.
 */
export const MESHIO_WRITE_FORMAT: Readonly<Record<string, string>> = {
  ".msh": "gmsh",
  ".e": "exodus",
  ".ex2": "exodus",
  ".exo": "exodus",
  ".inp": "abaqus",
  ".avs": "avsucd",
  ".bdf": "nastran",
  ".case": "ensight", // writes a .geo companion (see exportEligibility.ts)
  ".cgns": "cgns",
  ".dat": "tecplot",
  ".dato": "permas",
  ".dex": "dex",
  ".ele": "tetgen", // writes a .node companion (see exportEligibility.ts)
  ".f3grid": "flac3d",
  ".fem": "nastran",
  ".foam": "openfoam", // writes a constant/polyMesh/ tree beside the marker
  ".h5m": "h5m",
  ".hmf": "hmf",
  ".ip": "ip",
  ".k": "lsdyna",
  ".med": "med",
  ".mesh": "medit",
  ".mff": "mff",
  ".mfm": "mfm",
  ".mphtxt": "mphtxt",
  ".nas": "nastran",
  ".off": "off",
  ".pcd": "pcd",
  ".pf3": "flux",
  ".poly": "triangle", // single-file Triangle PSLG
  ".post": "permas",
  // Only the ascii flavour is offered as a write target. `.post.bin`/`.post.h5`
  // are the SAME format in another on-disk flavour rather than other formats,
  // so listing all three would put one format in the export menu three times —
  // the policy that already keeps `.e`/`.ex2` out while only `.exo` is
  // exportable. Ascii is also the flavour GiD users exchange and the only one
  // readable in a build without zlib. The `.post.res` half comes back as a
  // COMPANION from writeMeshioBytes, exactly like XDMF's `.h5`.
  ".post.msh": "gid",
  ".su2": "su2",
  ".svg": "svg", // write-only 2D/3D-projected figure
  ".tec": "tecplot",
  ".tikz": "tikz", // write-only LaTeX/PGF figure
  ".ugrid": "ugrid",
  ".unv": "unv",
  ".vol": "netgen",
  ".vtkhdf": "vtkhdf",
  ".wkt": "wkt",
  ".xdmf": "xdmf",
  ".xml": "dolfin", // writes a "<stem>_<field>.xml" companion per data array
  ".xmf": "xdmf",
  ".xyz": "xyz",
};

/** Extensions meshio++ reads for us (54). */
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
 * represented.  Which ones were dropped now reaches the diagnostic by name
 * (roadmap item 3's MED-metadata scope): `readMeshioModel` requests
 * `info: true` for `med` and reads `MedInfo.skippedConstructs`, so the
 * message lists the actual constructs rather than only saying a lenient
 * read was needed.
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
  ".msh", ".e", ".ex2", ".exo", ".inp", ".avs", ".bdf", ".case", ".cgns",
  ".dat", ".dato", ".dex", ".ele", ".f3grid", ".fem", ".foam", ".h5m",
  ".hmf", ".ip", ".k", ".med", ".mesh", ".mff", ".mfm", ".mphtxt", ".nas",
  ".off", ".pcd", ".pf3", ".poly", ".post", ".post.msh", ".su2", ".svg",
  ".tec", ".tikz", ".ugrid", ".unv", ".vol", ".vtkhdf", ".wkt", ".xdmf",
  ".xml", ".xmf", ".xyz",
] as const;

/** True when meshio++ (rather than one of our own parsers) handles `ext`. */
export function isMeshioReadExtension(ext: string): boolean {
  return ext.toLowerCase() in MESHIO_READ_CANDIDATES;
}

/**
 * Extensions made of MORE THAN ONE dot-segment.
 *
 * GiD postprocess is the first and so far only format to need this: it
 * registers `.post.msh`/`.post.res`/`.post.bin`/`.post.h5` (meshio++ >=
 * 10.18.0). A plain `path.extname("case.post.msh")` returns `".msh"`, which
 * this extension already maps to **gmsh** — so without longest-suffix-first
 * resolution a GiD file is silently handed to the wrong reader. meshio++ hit
 * exactly this and fixed it the same way in its own `resolve_format`
 * (`registry.cpp`), and `.post` on its own is a THIRD format again (permas),
 * so all three must resolve differently.
 */
export const COMPOUND_MESH_EXTENSIONS: readonly string[] = [
  ".post.msh",
  ".post.res",
  ".post.bin",
  ".post.h5",
];

/** The basename of a path, with either separator. */
function baseName(fsPath: string): string {
  const cut = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return cut >= 0 ? fsPath.slice(cut + 1) : fsPath;
}

/**
 * The mesh extension of a path: the longest registered COMPOUND extension it
 * ends with, else the ordinary last-dot one. Always lowercased.
 *
 * This is the single authority for "which format is this path?" — every
 * dispatch site uses it instead of `path.extname`, so a compound extension
 * cannot be resolved correctly in one place and wrongly in another. Deliberately
 * implemented with plain string operations rather than `node:path`, so this
 * module keeps its "pure constants, importable from anywhere" promise.
 *
 * Matches `path.extname`'s behaviour for the ordinary cases, including
 * returning `""` for a name with no dot and treating a leading-dot name
 * (`.mdpa`) as having no extension.
 */
export function meshExtname(fsPath: string): string {
  const name = baseName(fsPath);
  const lower = name.toLowerCase();
  // Longest first, so a future `.a.b.c` cannot be shadowed by `.b.c`.
  let best = "";
  for (const ext of COMPOUND_MESH_EXTENSIONS) {
    if (lower.length > ext.length && lower.endsWith(ext) && ext.length > best.length) {
      best = ext;
    }
  }
  if (best) return best;
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot) : "";
}

/**
 * The path's basename with its mesh extension removed — `case.post.msh` gives
 * `case`, where `path.basename(p, path.extname(p))` would give `case.post` and
 * quietly produce a `case.post.post.msh` on the next join.
 */
export function meshStem(fsPath: string): string {
  const name = baseName(fsPath);
  const ext = meshExtname(fsPath);
  return ext ? name.slice(0, name.length - ext.length) : name;
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
  // GiD ascii is a `.post.msh` (geometry) + `.post.res` (results) pair, and
  // either half may be the one opened. `stem` above cuts at the LAST dot, which
  // for "case.post.msh" gives "case.post" — so the compound-aware meshStem is
  // required here, not a convenience.
  if (e === ".post.msh" || e === ".post.res") {
    const base = meshStem(fileName);
    return [`${base}.post.msh`, `${base}.post.res`];
  }
  return [];
}
