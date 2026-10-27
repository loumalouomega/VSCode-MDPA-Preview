import type {
  AgglomerateOptions,
  CadJsonInfo,
  FitCadOptions,
  FitCadResult,
  IgaOptions,
  MeshCadSurfaceOptions,
  MeshCadSurfaceResult,
  MfemInfo,
  OctreeMeshOptions,
  OctreeMeshResult,
  RefinePatchesOptions,
  RefinePatchesResult,
  RegionEdit,
  RegionSelector,
} from "@meshioplusplus/wasm";
/**
 * Loader + virtual-filesystem I/O for `@meshioplusplus/wasm` (meshio++'s C++
 * core as WebAssembly), which backs the extended mesh formats — everything
 * this extension has no parser of its own for (Gmsh, Abaqus, Nastran, UNV,
 * Medit, Netgen, SU2, XDMF, …).
 *
 * No vscode / DOM imports, so it stays Node-testable.  The pure Mesh <->
 * MdpaModel conversion lives in meshioConvert.ts; this file owns the wasm.
 *
 * Two things make this package different from @loumalouomega/mmg-wasm:
 *
 *  1. It is ESM-only (no CJS build, no `exports` map) while the extension host
 *     bundle is CommonJS.  It therefore cannot be `require`d and must not be
 *     bundled: its Emscripten glue reads `import.meta.url` (for createRequire
 *     and _scriptName), which an esbuild ESM->CJS rewrite turns into
 *     `undefined`.  So the package stays `external`, is copied verbatim into
 *     dist/meshio/, and is pulled in through a real dynamic import that
 *     survives esbuild's and tsc's CJS downlevelling — the same "ship it
 *     verbatim and load it at runtime" shape as pyodide.
 *
 *  2. `{ wasmBinary }` does NOT work here (Emscripten pruned it from this
 *     build's INCOMING_MODULE_JS_API — it is silently ignored, so the mmg
 *     pattern would fail).  `locateFile` is the supported hook, and since the
 *     loader already knows the resolved package dir it passes one
 *     unconditionally, in both the dev and packaged layouts.
 *
 * Since 8.8.0 the package ships TWO native variants of each artifact — the
 * sequential `meshioplusplus_wasm.{mjs,wasm}` and the OpenMP/pthreads
 * `meshioplusplus_wasm_mt.{mjs,wasm}`, and since 17.0.0 the same pair again
 * with a `_full` infix behind `{full: true}` — and `loadMeshioPlusPlus` picks
 * between the variants itself: its `resolveVariant` returns "mt" whenever
 * `crossOriginIsolated` is undefined, which is exactly the case under Node,
 * hence in the extension host.  So `locateFile` MUST honour the filename it is
 * handed rather than returning a fixed path: hand the mt glue the sequential
 * binary and every meshio format dies with
 *   Aborted(LinkError: WebAssembly.instantiate(): Import #0 module="a"
 *           function="a" error: function import requires a callable)
 * — an error that names neither the file nor the variant.  meshio.test.ts pins
 * this so a refactor cannot quietly reintroduce a fixed path.
 *
 * Which build an instance gets is decided here, not by upstream's `auto`: the
 * threaded build only in a worker thread that runs one operation and then ends
 * (`markSingleOperationThread`), the sequential build everywhere else.  The
 * threaded build's pthread pool outlives the instance, so an in-process caller
 * leaks it.
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { isMainThread } from "node:worker_threads";

import {
  MeshioMedInfo,
  MeshioMesh,
  MeshioMeshInfo,
  applyMedDimensions,
  meshioToModel,
  modelToMeshio,
} from "./meshioConvert";
import {
  FULL_ONLY_READ_EXTENSIONS,
  FULL_ONLY_READER_KEYS,
  MESHIO_LENIENT_RETRY_FORMATS,
  MESHIO_READ_CANDIDATES,
  MESHIO_WRITE_FORMAT,
} from "./meshioFormats";
// The `.step` export fits the model's boundary skin (see writeStepModel);
// extractSkin is pure (types + writerCommon only), so this back-reference
// creates no cycle.
import { extractSkinModel } from "./extractSkin";
import { cellCategory, closedTriangleSkin } from "./writers/writerCommon";
// The same relative-path guard the problem-archive extractor applies to a zip
// entry: a companion's name is likewise joined onto a real destination folder.
import { isSafeEntryName } from "./problemZip";
import { rewriteOpenFoamPatches } from "./openfoamWrite";
import { writeOpenFoamFields } from "./openfoamFieldWrite";
import { augmentMeshioWithFoamFields } from "./openfoamCase";
import type { OpenFoamParsedField } from "./openfoamFields";
import { MdpaDiagnostic, MdpaModel, SourceMetadata, SubModelPart } from "./types";
import { trackEngine } from "../engineActivity";

/**
 * The `readMetadata` shape this module reads: a file's shape without its heavy
 * arrays. A strict subset of upstream's `MeshMetadata` — the module never
 * adopts more than it reads.
 */
export interface MeshioMetadataCellBlock {
  /** meshio++ cell type name, e.g. `"triangle"`, `"tetra10"`. */
  type: string;
  numCells: number;
  /** 0 for a ragged block, whose rows have no single node count. */
  nodesPerCell: number;
  ragged: boolean;
}

/** One named region's shape, without its entries (what a SubModelPart tree costs). */
export interface MeshioRegionSummary {
  name: string;
  kind: "point" | "cell" | "side";
  /** Topological dimension the group was declared for, or -1 if unspecified. */
  dim: number;
  /** Format-native integer id (gmsh physical tag, MED family id), or -1. */
  tag: number;
  /** Number of grouped entities (not the entries themselves). */
  numEntries: number;
}

export interface MeshioMetadata {
  numPoints: number;
  pointDim: number;
  /** Total across every block. */
  numCells: number;
  cellBlocks: MeshioMetadataCellBlock[];
  pointDataNames: string[];
  cellDataNames: string[];
  fieldDataNames: string[];
  /** The format that was actually used, whether given or inferred/sniffed. */
  format: string;
  /**
   * True when the format has no header-only path and the file had to be read
   * whole. The summary is still correct, just not cheap — callers offering a
   * "fast" path must refuse on true rather than serve a full read at header
   * price. Measured per format at 12.0.0 (see HEADER_METADATA_EXTENSIONS):
   * Exodus/medit/abaqus/nastran/su2/unv fall back; gmsh/xdmf/gid stay
   * header-only, joined by MED/CGNS/Tecplot since the 11.3.0 native metadata
   * readers.
   */
  fellBackToFullRead: boolean;
  /** The file's time-series values (from meshio++ >= 8.6.0); empty for a format with no time concept. */
  timeValues: number[];
  /**
   * The file's named regions, without their entries. Empty on a native
   * header-only path (VTU/XDMF/Gmsh/gid map none today) — never a wrong
   * answer, only cheap where a full read happened anyway.
   */
  regions: MeshioRegionSummary[];
  /** Omitted rather than null when no bounding box was computed (native paths). */
  bboxMin?: number[];
  bboxMax?: number[];
}

/** The subset of the Emscripten module we use. */
/**
 * meshio++'s stateful transient-XDMF writer (see `createXdmfTimeSeriesWriter`).
 * Only the members this extension calls are declared, like `MeshioModule`.
 */
export interface XdmfTimeSeriesWriter {
  /** The static grid, exactly once and first; any data on the mesh is ignored. */
  writePointsCells(mesh: MeshioMesh): void;
  /** One step's point/cell data at `time`; the geometry is ignored. */
  writeData(time: number, mesh: MeshioMesh): void;
  /** Writes the light XML and closes the heavy container. Idempotent. */
  finalize(): void;
  numSteps(): number;
  /** finalize-if-needed, then release the handle. */
  close(): void;
}

export interface MeshioModule {
  checkQuality(
    mesh: MeshioMesh,
    require?: string,
    maxInverted?: number,
    maxDegenerate?: number,
  ): {
    passed: boolean;
    numCells: number;
    numInverted: number;
    numDegenerate: number;
    checks: Array<{
      name: string;
      metric: string;
      min: number;
      max: number;
      maxFraction: number;
      evaluated: number;
      violations: number;
      fraction: number;
      worst: number;
      worstCell: number;
      passed: boolean;
    }>;
    summary: string;
  };

  /**
   * The FULL artifact's CAD fitter (meshio++ >= 17.0.0; needs OpenCASCADE, so
   * the lean module throws a `{full: true}` refusal by name). Segments the
   * closed triangle skin itself and fits each patch: an analytic primitive
   * where one fits (plane/sphere/cylinder/cone/torus, fillets, blends,
   * threads), a freeform B-spline patch where none does, and a faceted patch
   * as the last demotion. `stepPath` writes the solid as AP214 STEP into the
   * virtual filesystem; the return carries the re-meshed solid (with
   * `fit_cad:*` cell data), the fit counters, and `info` — the solid's B-rep
   * in `CadJsonInfo` shape, which `writeMesh(..., "cad_json", {info})` writes
   * back out. Used by the `.step` export's auto-fit (writeStepModel).
   *
   * meshio++ 17.11.0 adds to the report: `closed` (whether every edge of a
   * shell borders two faces), and — with the `faceDeviation` option — the
   * measured two-sided distance between each face and the skin
   * (`hausdorffMax`/`hausdorffRms`; NaN when it was not measured). It also
   * adds `refinePatches` (a standalone operation, unrouted here) and six
   * planar-domain generators; see meshCapabilities' operations.unavailable.
   *
   * @throws {Error} on a mesh that is not a closed, consistently wound
   *   triangle surface, or an unknown options key.
   */
  fitCad(mesh: MeshioMesh, options?: FitCadOptions): FitCadResult;

  /**
   * Triangulate the faces of a B-rep (`CadJsonInfo`: a `.cad.json` read, or a
   * full artifact's STEP/IGES read) into one conforming surface mesh (meshio++
   * >= 17.13.0), no CAD kernel. A face that cannot be meshed is listed in
   * `faces` with its status and reason; `strict` throws instead.
   */
  meshCadSurface(info: CadJsonInfo, options: MeshCadSurfaceOptions): MeshCadSurfaceResult;

  /**
   * Mesh the inside of a skin on a balanced octree (meshio++ >= 17.13.0):
   * conforming graded tetrahedra (`output: "tet"`), castellated hexahedral
   * leaves or all-hexahedra by the octree dual.
   */
  octreeMesh(mesh: MeshioMesh, options?: OctreeMeshOptions): OctreeMeshResult;

  /**
   * The older adaptive octree around a skin (17.8.0), positional arguments as
   * the typings declare them; `null` takes the default.
   */
  octree(
    mesh: MeshioMesh,
    rootCells?: number[] | null,
    minLevel?: number,
    maxLevel?: number,
    bounds?: number[] | null,
    padding?: number,
    paddingRelative?: number,
    dimension?: number,
    sampleDistance?: number,
    balance?: string,
    fill?: string,
    sign?: string,
    attachDistance?: boolean,
    evenOdd?: boolean,
    maxCells?: number
  ): {
    mesh: MeshioMesh;
    dimension: number;
    numLeaves: number;
    numBoundary: number;
    numNonManifold: number;
    numInconsistent: number;
  };

  /**
   * Split a surface into smooth patches (cell data `segment:patch`, -1 off the
   * surface). The mesh comes back unchanged apart from the added data.
   */
  segment(
    mesh: MeshioMesh,
    featureAngle?: number,
    normalTolerance?: number,
    curvatureTolerance?: number,
    minPatchCells?: number,
    region?: string,
    prefix?: string,
    method?: "angle" | "primitive",
    tolerance?: number
  ): {
    mesh: MeshioMesh;
    numPatches: number;
    numMerged: number;
    numFeatureEdges: number;
    numBoundaryEdges: number;
    numNonManifoldEdges: number;
  };

  /** Variational refinement of the `segment:patch` labels (17.11.0). */
  refinePatches(mesh: MeshioMesh, options?: RefinePatchesOptions): RefinePatchesResult;

  /** Procedural generators (17.9.0, planar-domain ones 17.11.0); `null` = default. */
  rectangle(dims?: number[] | null, size?: number[] | null, origin?: number[] | null, cellType?: string, split?: string, order?: number, maxCells?: number): MeshioMesh;
  box(dims?: number[] | null, size?: number[] | null, origin?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  disk(radius?: number, n?: number, center?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  uvSphere(radius?: number, nu?: number, nv?: number, center?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  icosaSphere(radius?: number, subdivisions?: number, center?: number[] | null, order?: number, maxCells?: number): MeshioMesh;
  cylinder(radius?: number, height?: number, nxy?: number, nz?: number, center?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  referenceTriangle(n?: number, size?: number[] | null, origin?: number[] | null, order?: number, maxCells?: number): MeshioMesh;
  ngon(sides?: number, radius?: number, rings?: number, center?: number[] | null, order?: number, maxCells?: number): MeshioMesh;
  annulus(innerRadius?: number, outerRadius?: number, ntheta?: number, nr?: number, angle?: number, center?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  lshape(n?: number, size?: number, center?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  plateWithHole(radius?: number, size?: number, nt?: number, nr?: number, center?: number[] | null, cellType?: string, order?: number, maxCells?: number): MeshioMesh;
  honeycomb(dims?: number[] | null, edge?: number, origin?: number[] | null, maxCells?: number): MeshioMesh;
  referenceCells(types?: string[] | null, pairs?: boolean): MeshioMesh;

  /**
   * The IGA ops over a NURBS side channel (meshio++ >= 16.42.0's mfem info,
   * 17.x's cad_json — both LEAN-build features, no OpenCASCADE needed).
   * `igaRefine` h/p-refines the patches (subdivisions per direction, degree
   * elevation, B-rep edge/trim controls) and `igaSample` samples them into
   * Lagrange cells; both return the mesh AND the refined side channel, which
   * writes back through `writeMesh(..., "cad_json", {info})` / the MFEM
   * writer while the mesh still is its sampling. The info is PLAIN data
   * (measured: it survives a structured clone and works on a different
   * instance than the one that read it) but holds typed arrays, so it must
   * never be JSON-serialized.
   *
   * @throws {Error} when the info is not a NURBS side channel or an option is
   *   out of range.
   */
  igaRefine(
    info: MfemInfo | CadJsonInfo,
    options?: IgaOptions & { subdivisions?: number | number[]; elevate?: number | number[] }
  ): { mesh: MeshioMesh; info: MfemInfo | CadJsonInfo };
  igaSample(info: MfemInfo | CadJsonInfo, options?: IgaOptions): {
    mesh: MeshioMesh;
    info: MfemInfo | CadJsonInfo;
  };

  /**
   * The sharp, open, non-manifold and inconsistently wound edges of a surface
   * (or of a volume mesh's skin) as a mesh of `line` cells over the input's
   * points, with cell data `feature:kind` (1 feature, 2 boundary,
   * 3 non-manifold, 4 inconsistent) and `feature:angle` (degrees). The counts
   * cover the whole surface, selected or not. See doc/feature_edges.md.
   * @throws {Error} on an angle outside [0, 180] or an unknown region.
   */
  featureEdges(
    mesh: MeshioMesh,
    featureAngle?: number,
    feature?: boolean,
    boundary?: boolean,
    nonManifold?: boolean,
    inconsistent?: boolean,
    region?: string,
  ): {
    mesh: MeshioMesh;
    numFeature: number;
    numBoundary: number;
    numNonManifold: number;
    numInconsistent: number;
  };

  /**
   * The (sampled) Hausdorff distance between the surfaces of two meshes; a
   * volume mesh contributes its skin. `faceSamples = s > 0` also samples the
   * centroids of the `s*s` sub-triangles of every triangle (vertices alone
   * give a lower bound). See doc/hausdorff.md.
   * @throws {Error} when a mesh has no surface triangles.
   */
  hausdorffDistance(
    a: MeshioMesh,
    b: MeshioMesh,
    faceSamples?: number,
    regionA?: string,
    regionB?: string,
  ): {
    distance: number;
    aToB: number;
    bToA: number;
    meanAToB: number;
    rmsAToB: number;
    meanBToA: number;
    rmsBToA: number;
    numSamplesA: number;
    numSamplesB: number;
    worstPointA: Float64Array;
    worstPointB: Float64Array;
  };

  /**
   * Apply region edits, in order, to a copy of `mesh` (points, cells and data
   * untouched): `union`, `intersection`, `difference` (two or more inputs of
   * one kind, result named `output`), `rename`, `retag` (`tag`/`dim`) and
   * `delete`. An input names exactly one region; pin `kind`/`dim`/`tag` when a
   * name is shared. See doc/regions.md.
   * @throws {Error} on a missing or ambiguous region, mixed kinds, or a result
   *   that would replace an unrelated region.
   */
  editRegions(mesh: MeshioMesh, edits: RegionEdit | RegionEdit[]): MeshioMesh;

  /**
   * The master node each node of the `slave` region maps onto under the
   * row-major 4x4 affine `matrix` (16 numbers), within `atol`. `slave` is
   * ascending and `master` aligned with it (0-based point ids). See
   * doc/periodic.md.
   * @throws {Error} on a master claimed twice or, with `requireComplete`, an
   *   unmatched slave node.
   */
  matchPeriodicNodes(
    mesh: MeshioMesh,
    slave: string | RegionSelector,
    master: string | RegionSelector,
    matrix: ArrayLike<number>,
    atol?: number,
    requireComplete?: boolean,
  ): {
    slave: Int32Array;
    master: Int32Array;
    unmatched: Int32Array;
    numFixed: number;
    maxResidual: number;
  };


  FS: {
    writeFile(p: string, data: Uint8Array | string): void;
    readFile(p: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string;
    readdir(p: string): string[];
    /**
     * `stat`/`isDir` are needed only to harvest a writer that produced a
     * DIRECTORY rather than a sibling file — OpenFOAM's `constant/polyMesh/`
     * (meshio++ >= 9.20.0) is the only one today.  See writeMeshioBytes.
     */
    stat(p: string): { mode: number };
    isDir(mode: number): boolean;
    mkdir(p: string): void;
    /**
     * Emscripten's recursive mkdir, and idempotent unlike `mkdir` above.  It is
     * on the live module but absent from upstream's `.d.ts`, so it is declared
     * here like the rest of this hand-picked subset.  Staging a format whose
     * files live in a SUBDIRECTORY (OpenFOAM's `constant/polyMesh/`) needs it:
     * `writeFile` into a missing directory throws an `FS.ErrnoError` whose
     * `message` is `undefined`.
     */
    mkdirTree(p: string): void;
    /** Removes a staged file. Used by the series packer to bound its memory. */
    unlink(p: string): void;
  };
  readMesh(p: string, format?: string): MeshioMesh;
  readMeshSelective(
    p: string,
    options?: {
      format?: string;
      pointsOnly?: boolean;
      arrays?: string[] | null;
      timeStep?: number;
      /**
       * meshio++ >= 9.9.0: read the constructs the strict path refuses rather
       * than failing the whole file.  Only the readers in upstream's
       * `registry_readers_ex` see it at all — MED is the one that matters here
       * (see MESHIO_LENIENT_RETRY_FORMATS).
       */
      lenient?: boolean;
      /**
       * meshio++ >= 11.2.0: attach the format's side-channel `.info` to the
       * result (openfoam/med/mdpa/ansysinp/unv/gmsh/exodus). Silently ignored
       * (no `.info` on the result) for a format with no side channel. Only
       * OpenFOAM's shape is consumed by this extension — see openfoamCase.ts.
       */
      info?: boolean;
      /**
       * meshio++ >= 14.0.0 (roadmap item 3): keep one partition/composite
       * block of a partitioned file (VTKHDF Steps' own composite blocks,
       * `.pvtu`/`.pvtp`). `0` is the first, negative counts from the end;
       * `null`/absent merges every piece into one mesh with one `cell`
       * region per piece — upstream's own default, unchanged behaviour for
       * every caller that never sets this.
       */
      piece?: number | null;
      /**
       * meshio++ >= 14.0.0: drop the ghost cells (halo) of a partitioned
       * `.pvtu`/`.pvtp`/`.pvd` — every cell with a `vtkGhostType` bit set,
       * and the points only they used. `false` (the default) keeps them;
       * every other reader ignores this option.
       */
      dropGhosts?: boolean;
    }
  ): MeshioMesh;
  readMetadata(p: string, format?: string): MeshioMetadata;
  /**
   * Whether a reader honours `readMeshSelective`'s options at all (upstream's
   * `registry_readers_ex`).  Nothing here branches on it — the option sets are
   * decided by the tables in meshioFormats.ts — but it is the capability those
   * tables claim, so meshio.test.ts asserts it against the live artifact rather
   * than trusting a comment.
   */
  readerSupportsOptions(format: string): boolean;
  writeMesh(
    p: string,
    mesh: MeshioMesh,
    format?: string,
    /**
     * `{info}` writes the format's side channel back (or, with no explicit
     * `info`, reuses `mesh.info` when its own `format` matches the write
     * target). Throws naming the format for one with no Info-bearing writer.
     * The other keys are upstream's own WriteOptions — the tests use
     * `encoding`/`codec` to author zstd/lz4 `.vtu` fixtures (full artifact
     * only); the extension's own write paths use none of them.
     */
    options?: {
      info?: MeshioMeshInfo;
      encoding?: "ascii" | "binary";
      /** Block codec for VTK XML: "zlib" (both artifacts), "zstd"/"lz4" (full only). */
      codec?: string;
    }
  ): void;
  /**
   * A transient-XDMF writer. Stateful and handle-shaped: `writePointsCells`
   * once with the static grid, then `writeData` per step, then `finalize` —
   * NOTHING appears in MEMFS until `finalize()` (measured). `autoFlush` stays
   * off: upstream documents a per-step `flush()` as quadratic.
   */
  createXdmfTimeSeriesWriter(
    p: string,
    options?: {
      dataFormat?: "HDF" | "XML" | "Binary";
      gzipLevel?: number;
      mode?: "truncate" | "append";
      autoFlush?: boolean;
    }
  ): XdmfTimeSeriesWriter;
  /** meshio++ >= 8.8.0: "seq" (sequential build) or "openmp" (threaded build). */
  parallelBackend(): string;
  /**
   * The format keys this BUILD actually carries, which is not simply a function
   * of the version: several formats are gated on optional native dependencies
   * (`gid` on gidpost, itself gated on zlib; the HDF5 containers on HDF5), and
   * upstream has shipped release artifacts with those switched off. The
   * hand-maintained tables in meshioFormats.ts claim to mirror this, and
   * meshio.test.ts asserts the claims that matter rather than assuming them.
   */
  availableFormats(): { readers: string[]; writers: string[] };

  /**
   * meshio++ >= 9.22.0: whether the optional cgnslib backend is linked in.
   *
   * CGNS works either way (meshio++ reads and writes it over raw HDF5); this
   * reports whether ADF-backed containers and the CGNS 3.x section layout are
   * reachable too. Nothing branches on it — the wasm build has carried cgnslib
   * since 9.22.0 and still does at 12.0.0 — but meshio.test.ts asserts it,
   * because a build that silently
   * dropped the dependency still reads every file meshio++ writes itself, so
   * the regression would only surface on a user's ADF file.
   */
  hasCgnslib(): boolean;

  /**
   * meshio++ >= 17.0.0 ships the same API as two artifacts: this "lean" one
   * (MIT) and a "full" one (OpenCASCADE, zstd, lz4, bzip2; mixed licence —
   * see the package's THIRD_PARTY_NOTICES.md) that `loadMeshioFull` loads.
   * `buildFlavour` names which one THIS instance is; `hasOcct`/`hasZstd`/
   * `hasLz4`/`hasBzip2` say which optional native libraries it links (all
   * four are false on lean, true on full, measured against 17.2.0).
   *
   * Nothing here branches on them — the routing tables decide what runs and
   * meshFileParser retries locally — but `mesh_capabilities` reports them and
   * meshio.test.ts asserts them, so a loader that handed back the wrong
   * flavour, or a rebuild that dropped a dependency, fails a test rather than
   * a user's file.
   */
  buildFlavour(): "lean" | "full";
  /** Whether OpenCASCADE is linked (step/iges reads, fitCad): full artifact only. */
  hasOcct(): boolean;
  /** Whether the VTK XML readers accept zstd-deflated data: full artifact only. */
  hasZstd(): boolean;
  /** Whether the VTK XML readers accept lz4-deflated data: full artifact only. */
  hasLz4(): boolean;
  /** Whether libMesh readers inflate .bz2 containers: full artifact only. */
  hasBzip2(): boolean;
  /**
   * Whether the KaHIP partitioner is linked (meshio++ >= 17.9.0): full artifact
   * only. `partition` / `partitionLabels` with `method: "kahip"` run there and
   * refuse by name on the lean one.
   */
  hasKahip(): boolean;

  /**
   * Provenance (former roadmap item 6, delivered 2026-10-01): with a scope open, a writer records the richer
   * header block (source, target, notes, timestamp) into the target format's
   * header slot — but only a format that HAS a slot. `readProvenance` says
   * whether one came out (`recognised`), which is the only way to know.
   */
  withProvenance<T>(mode: number | null | undefined, fn: () => T): T;
  provenanceNote(category: string, detail: string): void;
  provenanceSetSource(path: string, format: string): void;
  provenanceSetTarget(format: string, encoding?: string, codec?: string, floatFormat?: string): void;
  readProvenance(path: string): { lines: string[]; recognised: boolean };

  // --- operations -----------------------------------------------------------
  // Only the ones this extension uses as an ORACLE: each returns something we
  // apply to our own MdpaModel rather than a mesh we adopt wholesale. See
  // smoothMesh.ts / reorderMesh.ts / partitionMesh.ts for why that matters —
  // meshioConvert's round-trip would otherwise destroy every SubModelPart.

  /** Relax node positions; moves points only, never renumbers. */
  smooth(
    mesh: MeshioMesh,
    method?: string,
    iterations?: number,
    lambda?: number,
    mu?: number,
    fixBoundary?: boolean,
    preserveFeatures?: boolean,
    featureAngle?: number,
    guardInversion?: boolean
  ): {
    mesh: MeshioMesh;
    numNodesMoved: number;
    maxDisplacement: number;
    numSkippedInversion: number;
  };

  /** Renumber for bandwidth ("rcm") or locality ("morton"/"hilbert"). */
  reorder(
    mesh: MeshioMesh,
    method?: string
  ): { mesh: MeshioMesh; nodePermutation: Int32Array; cellPermutations: Int32Array[] };

  /** Max |maxNodeIndex - minNodeIndex| over cells — the before/after for reorder. */
  computeBandwidth(mesh: MeshioMesh): number;

  /**
   * Part index per cell, one array per cell block, block-aligned. Integer
   * arrays cross as BigInt64Array since meshio++ 11.2.0 — convert with
   * `meshioDataToNumbers` before pushing into number[] (see partitionMesh.ts).
   */
  partitionLabels(
    mesh: MeshioMesh,
    nparts: number,
    method?: string,
    imbalance?: number,
    mode?: string,
    seed?: number,
    weightsKey?: string
  ): ArrayLike<number | bigint>[];

  /**
   * meshio++ >= 9.10.0: the gradient / divergence / curl of a `point_data`
   * array, attached to the returned mesh under `output`.
   *
   * gradientField.ts always asks for `location: "point"`, which yields one
   * tuple per EXISTING point in the input's own order — what makes this usable
   * as an oracle. `component` is negative for every component.
   */
  gradient(
    mesh: MeshioMesh,
    array: string,
    operator?: string,
    method?: string,
    location?: "point" | "cell",
    output?: string,
    component?: number,
    overwrite?: boolean
  ): { mesh: MeshioMesh; numSkipped: number; numFallback: number };

  /**
   * meshio++ >= 10.9.0: the Hessian of a SCALAR `point_data` array, attached to
   * the returned mesh under `output` as the flattened row-major 3x3 (9
   * components, `H[i][j]` at `i*3+j`).
   *
   * A composition of two `gradient` calls, not a new kernel, and `method` is
   * forwarded to both passes. hessianField.ts asks for `location: "point"` for
   * the same reason gradientField.ts does — one tuple per EXISTING point, in
   * the input's own order, which is what makes it usable as an oracle. Raises
   * on a `cell_data` array or one with more than one component.
   */
  hessian(
    mesh: MeshioMesh,
    array: string,
    method?: string,
    location?: "point" | "cell",
    output?: string,
    overwrite?: boolean
  ): { mesh: MeshioMesh; numSkipped: number; numFallback: number };

  /**
   * meshio++ >= 10.10.0: the Zienkiewicz-Zhu recovery-based error indicator of
   * a `point_data` array, attached as a Float64 `cell_data` array under
   * `output` — one value per cell, in the same block-major order
   * `partitionLabels` uses, which is what makes it an oracle.
   *
   * `marking` other than "none" attaches a second Int64 0/1 array under
   * `marked`. Cells that cannot be evaluated read NaN in the indicator and 0
   * (never NaN) in the marking array, and are counted in `numSkipped`.
   */
  estimateError(
    mesh: MeshioMesh,
    array: string,
    method?: string,
    marking?: string,
    markingValue?: number,
    output?: string,
    marked?: string,
    overwrite?: boolean
  ): { mesh: MeshioMesh; globalError: number; numSkipped: number; numMarked: number };

  /**
   * meshio++ >= 10.4.0: signed distances from a flat `[x0,y0,z0, x1,…]` array
   * of query points to a surface mesh. Negative is inside.
   *
   * The purest oracle shape in this codebase: our own mesh never crosses the
   * wasm boundary at all — coordinates in, one double per point out, in order.
   * Raises when the length is not a multiple of three, or the surface has no
   * triangles.
   */
  sampleDistance(
    surface: MeshioMesh,
    points: number[],
    sign?: string,
    band?: number,
    watertightCheck?: string
  ): Float64Array;

  /**
   * meshio++ >= 10.7.0: mass-preserving cross-mesh field transfer — over the
   * region the two meshes share, `sum(value * measure)` is equal on both
   * sides, which `interpolate`'s barycentric mode does not guarantee.
   *
   * An empty `arrays` transfers every source `point_data` AND `cell_data`
   * array. Output arrays are always Float64. Note that BOTH meshes are
   * simplexified internally, so the returned mesh's CELL set is not
   * necessarily the target's — see transferField.ts, which adopts an array
   * only when its tuple count still matches.
   *
   * `onConflict` is "error" (the default) | "overwrite" | "suffix"; upstream
   * raises naming those three, so a wrong value fails loudly rather than being
   * silently ignored.
   */
  conservativeInterpolate(
    source: MeshioMesh,
    target: MeshioMesh,
    arrays?: string[],
    defaultValue?: number,
    onConflict?: string
  ): MeshioMesh;

  /**
   * meshio++ >= 10.8.0: cell-measure-weighted total and mean of `cell_data`
   * arrays, for the whole mesh and independently per named `Cell` region.
   * Read-only — the mesh is never modified. A `point_data`-only name raises.
   */
  dataIntegrate(mesh: MeshioMesh, arrays?: string[]): MeshioFieldIntegral[];

  /** meshio++ >= 10.4.0: what is wrong with a surface, in numbers not a flag. */
  surfaceWatertightCheck(mesh: MeshioMesh): {
    boundaryEdges: number;
    nonManifoldEdges: number;
    inconsistentPairs: number;
    degenerateTriangles: number;
    watertight: boolean;
  };

  /**
   * Applies a 16-element row-major transform matrix to every point (and, with
   * `rotateVectorData`, every vector-shaped point_data array). A shape-
   * preserving op — same point count/order, same cells, same regions and
   * `propertySets` — used by meshioFidelity.ts's acceptance tests as a second
   * witness beside `smooth`.
   */
  transform(mesh: MeshioMesh, matrix: number[], rotateVectorData?: boolean): MeshioMesh;

  /**
   * Converts the element representation: drops higher-order nodes
   * ("linearize"), decomposes into same-dimension simplices ("simplexify"),
   * or promotes linear cells to serendipity quadratic ("elevate"). A
   * RESTRUCTURING op — point/cell counts can change, `propertySets` is
   * dropped (measured against the live 12.0.0 artifact) — used by
   * meshioFidelity.ts's acceptance tests as the restructuring-op witness.
   */
  convertCells(mesh: MeshioMesh, mode: "linearize" | "simplexify" | "elevate", recordParentIds?: boolean): MeshioMesh;
  // --- Tier 2 operations -----------------------------------------------------
  // Preparation and analysis kernels (roadmap Tier 2). Each is called
  // positionally, exactly as `@meshioplusplus/wasm` 12.0.0 declares it. Integer
  // outputs cross as BigInt64Array (meshio++ >= 11.2.0), hence the
  // `ArrayLike<number | bigint>` spelling — convert with `meshioDataToNumbers`.

  repair(
    mesh: MeshioMesh,
    fixOrientation?: boolean,
    orientOutward?: boolean,
    fillHoles?: boolean,
    splitNonManifold?: boolean,
    maxHoleEdges?: number,
    weldTolerance?: number,
    recordProvenance?: boolean
  ): MeshioRepairResult;

  decimate(
    mesh: MeshioMesh,
    ratio?: number,
    targetFaces?: number,
    maxError?: number,
    placement?: string,
    preserveBoundary?: boolean,
    preserveFeatures?: boolean,
    featureAngle?: number,
    frozen?: number[] | Int32Array | null,
    returnMaps?: boolean
  ): {
    mesh: MeshioMesh;
    facesRemoved: number;
    pointsRemoved: number;
    collapsesRejected: number;
    maxErrorApplied: number;
    pointMap?: Int32Array;
    cellMaps?: Int32Array[];
  };

  computeCurvature(
    mesh: MeshioMesh,
    mean?: boolean,
    gaussian?: boolean,
    dualArea?: "mixed-voronoi" | "barycentric",
    includeBoundary?: boolean,
    recordArea?: boolean,
    recordPrincipal?: boolean,
    region?: string
  ): {
    mesh: MeshioMesh;
    numBoundary: number;
    numIsolated: number;
    numDegenerate: number;
    totalAngleDefect: number;
    quality: MeshioSurfaceQuality;
  };

  shrinkwrap(
    mesh: MeshioMesh,
    target: MeshioMesh,
    offset?: number,
    maxDistance?: number,
    weights?: string,
    targetRegion?: string,
    normalWeight?: "angle" | "area",
    recordDistance?: boolean,
    recordClosestCell?: boolean
  ): {
    mesh: MeshioMesh;
    quality: MeshioSurfaceQuality;
    numProjected: number;
    numMissed: number;
    numSkipped: number;
    maxDisplacement: number;
  };

  sobolevDeform(
    mesh: MeshioMesh,
    array: string,
    lengthScale: number,
    fixedPointsArray?: string,
    fixBoundary?: boolean,
    recordFiltered?: boolean,
    maxIterations?: number,
    tolerance?: number
  ): {
    mesh: MeshioMesh;
    numIterations: number;
    residual: number;
    converged: boolean;
    numFixed: number;
    numIsolated: number;
    maxDisplacement: number;
  };

  remesh(
    mesh: MeshioMesh,
    numClusters: number,
    subdivide?: number,
    subsampleRatio?: number,
    maxSubdivide?: number,
    maxIterations?: number,
    maxRepairPasses?: number,
    metric?: "isotropic" | "quadric" | "anisotropic",
    gradation?: number,
    preserveBoundary?: boolean,
    maxAnisotropy?: number
  ): {
    mesh: MeshioMesh;
    numClusters: number;
    numIterations: number;
    subdivideApplied: number;
    numIsolatedClusters: number;
    numNonManifoldVertices: number;
  };

  remeshVolume(
    mesh: MeshioMesh,
    resolution?: number[] | null,
    cellSize?: number,
    bounds?: number[] | null,
    padding?: number,
    paddingRelative?: number,
    maxCells?: number,
    maxTets?: number,
    warpFraction?: number,
    sign?: string,
    watertightCheck?: string
  ): {
    mesh: MeshioMesh;
    numTets: number;
    numVerticesWarped: number;
    numTetsRejected: number;
    numNonManifoldEdges: number;
  };

  optimizeVolume(
    mesh: MeshioMesh,
    maxIterations?: number,
    relocate?: boolean,
    flip?: boolean,
    preserveBoundary?: boolean,
    minImprovement?: number
  ): {
    mesh: MeshioMesh;
    numFlips: number;
    num23Flips: number;
    num32Flips: number;
    numVerticesMoved: number;
    numTets: number;
    minQualityBefore: number;
    minQualityAfter: number;
  };

  /**
   * Isoparametric tessellation of curved cells (meshio++ >= 16.42.0):
   * `triangle6`/`quad8`/`quad9` become one `triangle` block, `tetra10` and
   * `hexahedron27` one `tetra` block, everything else passes through. The
   * result carries `tessellate:source_cell`/`sub_index` (cell data) and
   * `tessellate:source_point` (point data, -1 for a new point); it drops cell
   * regions, so membership has to be rebuilt by the caller.
   */
  tessellate(
    mesh: MeshioMesh,
    levels?: number,
    curved?: boolean,
    fields?: boolean,
    recordStencil?: boolean
  ): {
    mesh: MeshioMesh;
    numSourcePoints: number;
    numSourceCells: number;
    numCurvedSourceCells: number;
    numPassThroughSourceCells: number;
    numPoints: number;
    numCells: number;
    numBoundaryFacets: number;
    numInteriorFacets: number;
    numFacetsWithBadCount: number;
  };

  grid(dims: number[], origin?: number[] | null, spacing?: number[] | null, maxCells?: number): MeshioMesh;

  voxelize(
    mesh: MeshioMesh,
    resolution?: number[] | null,
    cellSize?: number,
    bounds?: number[] | null,
    padding?: number,
    paddingRelative?: number,
    fill?: "all" | "surface" | "inside",
    sign?: string,
    attachOccupancy?: boolean,
    maxCells?: number,
    watertightCheck?: string
  ): { mesh: MeshioMesh; dims: number[]; origin: number[]; spacing: number[]; numOccupied: number };

  computeSdf(
    surface: MeshioMesh,
    structure?: "voxel" | "octree",
    resolution?: number[] | null,
    cellSize?: number,
    bounds?: number[] | null,
    padding?: number,
    paddingRelative?: number,
    rootResolution?: number,
    maxDepth?: number,
    bandCells?: number,
    recordLevels?: boolean,
    maxCells?: number,
    sign?: string,
    location?: "corner" | "center",
    band?: number,
    watertightCheck?: string
  ): {
    mesh: MeshioMesh;
    dims: number[];
    origin: number[];
    spacing: number[];
    maxDepth: number;
    numBanded: number;
    quality: MeshioSurfaceQuality;
  };

  /** Typed `object` upstream; the shape is `MeshioDiffReport` (measured). */
  diff(a: MeshioMesh, b: MeshioMesh, atol?: number, rtol?: number, unordered?: boolean): MeshioDiffReport;
  meshesEqual(a: MeshioMesh, b: MeshioMesh, atol?: number, rtol?: number, unordered?: boolean): boolean;

  /**
   * Point sampling from `source` onto `target` (`"nearest"` | `"barycentric"`).
   * NOT mass preserving — that is `conservativeInterpolate`. An empty `arrays`
   * transfers every point_data array; cell_data only when named.
   */
  interpolate(
    source: MeshioMesh,
    target: MeshioMesh,
    method?: "nearest" | "barycentric",
    arrays?: string[],
    extrapolate?: boolean,
    defaultValue?: number,
    onConflict?: string
  ): MeshioMesh;

  slice(mesh: MeshioMesh, origin: number[], normal: number[], recordParentIds?: boolean): MeshioMesh;

  /** A negative `component` means the row magnitude here (the opposite sense to `gradient`'s "all"). */
  isosurface(
    mesh: MeshioMesh,
    array: string,
    isovalues: number | number[],
    component?: number,
    recordParentIds?: boolean
  ): MeshioMesh;

  split(
    mesh: MeshioMesh,
    by: "type" | "component" | "region" | "tag",
    tagName?: string,
    returnMaps?: boolean
  ): { key: string; mesh: MeshioMesh; pointMap?: Int32Array; cellMaps?: Int32Array[] }[];

  partition(
    mesh: MeshioMesh,
    nparts: number,
    method?: string,
    imbalance?: number,
    mode?: string,
    seed?: number,
    recordIds?: boolean,
    ghostLayers?: number,
    weightsKey?: string,
    returnMaps?: boolean
  ): { partId: number; mesh: MeshioMesh; pointMap?: Int32Array; cellMaps?: Int32Array[] }[];

  dataCondition(
    mesh: MeshioMesh,
    location: "point" | "cell" | "field",
    names?: string[],
    mode?: "clamp" | "normalize" | "standardize",
    lo?: number,
    hi?: number,
    scope?: "component" | "magnitude",
    nanPolicy?: "ignore" | "replace" | "fail",
    nanReplacement?: number,
    suffix?: string
  ): MeshioMesh;

  subdivide(mesh: MeshioMesh, recordParentIds?: boolean, returnMaps?: boolean): MeshioMesh | { mesh: MeshioMesh; cellMaps: Int32Array[] };
  agglomerate(mesh: MeshioMesh, targetGroupSize?: number, returnMaps?: boolean, options?: AgglomerateOptions): MeshioMesh | { mesh: MeshioMesh; cellMap: Int32Array };
}

/** upstream's `SurfaceQualityInfo`, shared by repair / curvature / shrinkwrap / computeSdf. */
export interface MeshioSurfaceQuality {
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentPairs: number;
  degenerateTriangles: number;
  watertight: boolean;
}

export interface MeshioRepairResult {
  mesh: MeshioMesh;
  qualityBefore: MeshioSurfaceQuality;
  qualityAfter: MeshioSurfaceQuality;
  numFlipped: number;
  numComponents: number;
  largestComponent: number;
  numOrientedOutward: number;
  numUnorientable: number;
  numVerticesSplit: number;
  numHolesDetected: number;
  numHolesFilled: number;
  numHolesSkipped: number;
  numFacesAdded: number;
  numPointsAdded: number;
  pointsWelded: number;
}

/** One array's difference as `diff` reports it (measured against the 12.0.0 build). */
export interface MeshioArrayDiff {
  name: string;
  shapeMismatch: boolean;
  sizeA: number;
  sizeB: number;
  maxAbsError: number;
  maxRelError: number;
  worstIndex: number;
  numExceeding: number;
  exact: boolean;
}

export interface MeshioDiffReport {
  verdict: "identical" | "equal within tolerance" | "different";
  unordered: boolean;
  correspondenceFailed: boolean;
  pointCountMismatch: boolean;
  points: unknown;
  blockCountMismatch: boolean;
  blocks: {
    block: number;
    typeA: string;
    typeB: string;
    countA: number;
    countB: number;
    typeMismatch: boolean;
    countMismatch: boolean;
    connMismatchCount: number;
  }[];
  pointData: { onlyInA?: string[]; onlyInB?: string[]; shared?: MeshioArrayDiff[] };
  cellData: { onlyInA?: string[]; onlyInB?: string[]; shared?: MeshioArrayDiff[] };
  fieldData: { onlyInA?: string[]; onlyInB?: string[]; shared?: MeshioArrayDiff[] };
  messages: string[];
}


/**
 * One integrated quantity, as `dataIntegrate` actually reports it (measured
 * against the live 12.0.0 artifact rather than transcribed from the docs).
 *
 * Every figure is per-component, because an array is integrated component by
 * component. A cell whose measure is not computable, or a component whose value
 * is non-finite, is excluded from that component's numerator AND denominator —
 * never given a fallback weight of 1 — which is why `domainMeasurePerComponent`
 * can differ between components of the same array.
 */
export interface MeshioIntegralTotals {
  numCells: number;
  numSkipped: number;
  totalPerComponent: number[];
  meanPerComponent: number[];
  domainMeasurePerComponent: number[];
  numNanPerComponent: number[];
}

/** One `cell_data` array's integral: over the whole mesh, and per Cell region. */
export interface MeshioFieldIntegral {
  name: string;
  numComponents: number;
  domain: MeshioIntegralTotals;
  /**
   * One entry per named `Cell` region. `modelToMeshio`'s buildRegions emits one
   * per EntityBlock and one per SubModelPart, so this is the per-part
   * breakdown — and regions are not a partition, so a cell in two regions
   * contributes fully to both.
   */
  regions: (MeshioIntegralTotals & { name: string })[];
}

/** Which native artifact to load; see the module docblock. */
type MeshioVariant = "auto" | "mt" | "seq";

interface MeshioNamespace {
  loadMeshioPlusPlus(
    overrides?: Record<string, unknown>,
    options?: {
      variant?: MeshioVariant;
      /**
       * meshio++ >= 17.0.0: instantiate the FULL artifact
       * (`meshioplusplus_wasm_full{,_mt}.{mjs,wasm}`) instead of the lean one.
       * With no `fullGlue` it imports the full glue relative to the package's
       * own index.mjs, so the packaged `dist/meshio/` tree — which preserves
       * the src/ + dist/ layout — needs neither.
       */
      full?: boolean;
      /** Where the full artifact's glue module lives; see `full` above. */
      fullGlue?: string | URL;
    }
  ): Promise<MeshioModule>;
}

let extraOverrides: Record<string, unknown> = {};

/**
 * Extra Emscripten module overrides, merged into every subsequent load.
 * Mirrors remesh.ts's configureMmg as an escape hatch (tests, odd layouts, or
 * an `instantiateWasm` that caches the compiled module).  Normally unused:
 * `locateFile` is resolved automatically.
 */
export function configureMeshio(options: Record<string, unknown>): void {
  extraOverrides = options;
}

/**
 * The installed package directory.
 *   1. node_modules — dev, and the `out/` test layout
 *   2. <bundle>/meshio — packaged (esbuild's copy-meshio plugin)
 */
let resolvedDir: string | undefined;

function packageDir(): string {
  if (resolvedDir) return resolvedDir; // module resolution cannot change at runtime
  try {
    resolvedDir = path.dirname(require.resolve("@meshioplusplus/wasm/package.json"));
    return resolvedDir;
  } catch {
    /* packaged layout below */
  }
  const bundled = path.join(__dirname, "meshio");
  if (fs.existsSync(path.join(bundled, "src", "index.mjs"))) {
    resolvedDir = bundled;
    return resolvedDir;
  }
  throw new Error(
    "@meshioplusplus/wasm was not found — the extended mesh formats are unavailable."
  );
}

/**
 * Where the kernel tree is read from, reported (never decided) here: the same
 * two-step resolution `packageDir()` performs, without loading anything.
 * `source` is the fact a staged-distribution check needs — a packaged server
 * that silently resolved `node_modules` is running against the checkout, not
 * against what it ships. `undefined` when neither layout carries the module.
 */
export function meshioPackageSource():
  | { dir: string; source: "node_modules" | "bundled" }
  | undefined {
  try {
    return {
      dir: path.dirname(require.resolve("@meshioplusplus/wasm/package.json")),
      source: "node_modules",
    };
  } catch {
    /* packaged layout below */
  }
  const bundled = path.join(__dirname, "meshio");
  return fs.existsSync(path.join(bundled, "src", "index.mjs"))
    ? { dir: bundled, source: "bundled" }
    : undefined;
}

/**
 * The installed `@meshioplusplus/wasm` version, or undefined when no
 * package.json is found in either layout. Reads the same two locations
 * `packageDir()` resolves (dev node_modules, then the packaged dist/meshio
 * copy esbuild's copy-meshio plugin ships) without importing the module.
 */
export function meshioPackageVersion(): string | undefined {
  for (const dir of packageDirs()) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** The two layouts `packageDir()` resolves, in the same order: dev first. */
function packageDirs(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(path.dirname(require.resolve("@meshioplusplus/wasm/package.json")));
  } catch {
    /* dev package absent — try the packaged layout */
  }
  dirs.push(path.join(__dirname, "meshio"));
  return dirs;
}

/**
 * Whether the installed/packaged tree carries the FULL artifact
 * (`dist/meshioplusplus_wasm_full.wasm`, the OpenCASCADE build of meshio++
 * >= 17.0.0). A file-system fact, deliberately not a load: `mesh_capabilities`
 * reports it before paying for a second ~27 MB instantiation, and
 * `loadMeshioFull()` is what fails loudly when the pair is missing.
 */
export function meshioFullInstalled(): boolean {
  return packageDirs().some((dir) =>
    fs.existsSync(path.join(dir, "dist", "meshioplusplus_wasm_full.wasm"))
  );
}

// Hidden from esbuild AND from tsc's CommonJS downlevelling, both of which
// would rewrite a literal import() into a require() and break on this
// ESM-only package.
const dynImport = new Function("u", "return import(u)") as (
  u: string
) => Promise<MeshioNamespace>;

let nsPromise: Promise<MeshioNamespace> | undefined;

function namespace(): Promise<MeshioNamespace> {
  if (!nsPromise) {
    const entry = path.join(packageDir(), "src", "index.mjs");
    nsPromise = dynImport(pathToFileURL(entry).href).catch((e: unknown) => {
      nsPromise = undefined; // never poison the cache with a transient failure
      throw e;
    });
  }
  return nsPromise;
}

/**
 * A fresh, independent module instance per call.
 *
 * Deliberately NOT memoized: the build sets ALLOW_MEMORY_GROWTH=1, so a
 * long-lived instance would pin the high-water mark of the largest mesh ever
 * opened.  Dropping an instance lets its WebAssembly.Memory go at GC — which
 * only the SEQUENTIAL build can rely on: the threaded build's pthread pool keeps
 * its memory alive, so it is handed out only to a worker thread that ends after
 * one operation (`markSingleOperationThread`).  It also means no MEMFS
 * bookkeeping: a throwing read leaves no debris behind.  Only the ES-module
 * namespace is cached (expensive to resolve, holds no heap).
 */
export function loadMeshio(): Promise<MeshioModule> {
  // Reported to the status bar's engine line (engineActivity.ts): the one place
  // every meshio++ read, write and oracle op instantiates the module.
  return trackEngine("meshio", () => loadMeshioFlavour(false));
}

/**
 * The FULL artifact of the same release (meshio++ >= 17.0.0): the same C++
 * core plus OpenCASCADE, zstd, lz4 and bzip2, under a mixed licence. It is a
 * DIFFERENT artifact rather than a feature flag on the lean one: the lean
 * build keeps serving every format and operation it already covers, and this
 * one is loaded lazily, only where the lean build cannot serve — the
 * step/iges reads, `fitCad` and the zstd/lz4 `.vtu` and bzip2 libMesh
 * fallbacks (see meshFileParser.ts).
 *
 * Same contracts as `loadMeshio` — a fresh instance per call (the docblock
 * above explains why dropping it matters, and this artifact is twice the
 * size), the name-aware `locateFile` for whichever variant the loader picks,
 * and the one-off mt -> seq fallback. The full glue resolves its own
 * `../dist/` siblings relative to the packaged `src/index.mjs`, so no
 * `fullGlue` override is needed in either layout.
 */
export function loadMeshioFull(): Promise<MeshioModule> {
  return trackEngine("meshio", () => loadMeshioFlavour(true));
}

/**
 * Which partitioner a request ends up on, and therefore which artifact it
 * needs. MEASURED against 17.10.0 (the shipped typings say `auto` resolves to
 * the space-filling curve, which is true only of the lean build): on the full
 * artifact `auto` returns exactly KaHIP's labels. So here `auto` means "the
 * best partitioner this install has" — KaHIP when the full artifact is
 * installed, the curve otherwise — and the RESOLVED method is what callers
 * report. An absent method stays `sfc`: recipes recorded before KaHIP existed
 * must keep producing the same labels, and `sfc` needs no 30 MB second
 * instantiation.
 */
export type PartitionMethodRequest = "sfc" | "kahip" | "auto";

export function resolvePartitionMethod(method?: PartitionMethodRequest): "sfc" | "kahip" {
  if (method === "kahip") return "kahip";
  if (method === "auto") return meshioFullInstalled() ? "kahip" : "sfc";
  return "sfc";
}

/** The module a partition call needs: the full artifact for KaHIP, the lean one for the curve. */
export function loadMeshioForPartition(method: "sfc" | "kahip"): Promise<MeshioModule> {
  return method === "kahip" ? loadMeshioFull() : loadMeshio();
}

async function loadMeshioFlavour(full: boolean): Promise<MeshioModule> {
  const ns = await namespace();
  const dist = path.join(packageDir(), "dist");
  const overrides = {
    // Name-aware ON PURPOSE: `locateFile` is handed the bare filename of
    // whichever variant the loader picked ("meshioplusplus_wasm_mt.wasm" under
    // Node).  See the module docblock — a fixed path is a hard LinkError.
    locateFile: (name: string) => path.join(dist, path.basename(name)),
    ...extraOverrides,
  };
  const flavour = full ? { full: true as const } : {};
  // The threaded build only in a single-operation worker thread (see
  // `markSingleOperationThread`); the sequential build everywhere else.
  const threaded = singleOperationThread && !isMainThread;
  if (forceSequential || !threaded) {
    return ns.loadMeshioPlusPlus(overrides, { ...flavour, variant: "seq" });
  }
  try {
    return await ns.loadMeshioPlusPlus(overrides, full ? { full: true } : undefined);
  } catch (e) {
    // An environment that cannot host Wasm threads (no SharedArrayBuffer, a
    // locked-down container) aborts inside the mt glue.  Fall back once and
    // remember the DECISION — never the instance, see the docblock above.
    forceSequential = true;
    try {
      return await ns.loadMeshioPlusPlus(overrides, { ...flavour, variant: "seq" });
    } catch {
      forceSequential = false; // do not poison future loads with a transient failure
      throw e; // the original error is the informative one
    }
  }
}

/**
 * The module a meshio++ READ needs: the full artifact for a format the lean
 * build cannot serve AT ALL — the OpenCASCADE CAD readers and their four
 * spellings (FULL_ONLY_READ_EXTENSIONS / FULL_ONLY_READER_KEYS) — the lean one
 * everywhere else, which is every other read in the extension.
 *
 * A direct dispatch rather than attempt-then-retry, because there is nothing
 * to retry with on the lean side: its registry has no entry for these keys, so
 * the attempt fails before it can name the missing dependency. The codec
 * fallbacks (zstd/lz4 `.vtu`, bzip2 libMesh) are the OPPOSITE shape — the
 * reader exists in the lean build and only the codec is missing — and stay in
 * meshFileParser.ts's error-allowlisted retry.
 *
 * `format` (an explicit MCP `inputFormat`) can override the extension's own
 * candidates, so both are consulted: asking for "step" on a `.cad` path must
 * reach the full build exactly as a `.step` file does.
 */
function loadMeshioForRead(ext: string, candidates: readonly string[]): Promise<MeshioModule> {
  const fullOnly =
    FULL_ONLY_READ_EXTENSIONS.includes(ext.toLowerCase()) ||
    candidates.some((key) => FULL_ONLY_READER_KEYS.includes(key));
  return fullOnly ? loadMeshioFull() : loadMeshio();
}

/** Set once if the auto-selected (threaded) build fails to instantiate. */
let forceSequential = false;

/** Set by `markSingleOperationThread`; see there for why. */
let singleOperationThread = false;

/**
 * Lets THIS worker thread instantiate the threaded build. Call it at the top of
 * a worker entry point that runs exactly one operation and is then terminated
 * (the read, write, oracle, derived and analysis workers). Nothing else calls it.
 *
 * Measured on Node 20, which has no `navigator` global, so the threaded glue
 * falls back to an eight-thread pool: each threaded instance started eight
 * worker threads, and no later GC released them or the shared memory they hold.
 * Sixty instances held 491 threads and 4.4 GB. The sequential build is reclaimed
 * at GC. Terminating the thread that instantiated the threaded build releases
 * all of it (52 threads back to 11), which is why a worker that ends after one
 * operation may use it. A worker that reads many meshes, and the host thread,
 * must not: their instances would accumulate until the process exits. The test
 * suite runs every in-process read in the host thread, which took it to 12.5 GB
 * on a 16 GB machine and got the hosted Linux runner shut down (CI run
 * 40533717580).
 */
export function markSingleOperationThread(): void {
  singleOperationThread = true;
}

/** A file to place in the virtual filesystem before reading. */
export interface MeshioInputFile {
  /**
   * Path RELATIVE to the staging root, `/`-separated — the mirror of
   * `MeshioCompanionFile.name` on the write side.
   *
   * Usually a bare basename (several readers inspect their own extension), but
   * it may carry directories: OpenFOAM's reader wants
   * `constant/polyMesh/{points,faces,owner,…}`, which no flat name can express.
   * Guarded with `isSafeEntryName`, so a staged name can never escape the root.
   */
  name: string;
  data: Uint8Array;
}

/**
 * Reads the message off a thrown value, including an Emscripten `FS.ErrnoError`
 * — whose `message` is `undefined`, so the obvious
 * `e instanceof Error ? e.message : String(e)` yields the literal "undefined"
 * and hides which file failed to stage.
 */
function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const errno = (e as { errno?: number } | null)?.errno;
  if (typeof errno === "number") return `errno ${errno}`;
  return String(e);
}

/**
 * Stages `files` under a scratch root and returns the path to hand the reader.
 *
 * A scratch root rather than "/" for the reason `writeMeshioBytes` uses
 * `/mio_out`: a staged file legitimately named `tmp`, `home` or `dev` would
 * otherwise collide with MEMFS's own entries.  Every reader resolves a
 * companion reference against the main file's own directory (XDMF's
 * `<stem>.h5`, tetgen's pair), so moving the whole set together changes
 * nothing for them.  The module is a fresh instance per call — see
 * `loadMeshio` — so the root is always empty, and `mkdirTree` is idempotent
 * regardless.
 */
function stageFiles(
  m: MeshioModule,
  mainName: string,
  files: readonly MeshioInputFile[]
): string {
  const root = "/mio_in";
  m.FS.mkdirTree(root);
  for (const f of files) {
    if (!isSafeEntryName(f.name)) {
      throw new Error(`Refusing to stage "${f.name}": it escapes the staging directory.`);
    }
    const dest = `${root}/${f.name}`;
    const slash = dest.lastIndexOf("/");
    if (slash > root.length) m.FS.mkdirTree(dest.slice(0, slash));
    try {
      m.FS.writeFile(dest, f.data);
    } catch (e) {
      throw new Error(`Could not stage "${f.name}": ${errText(e)}`);
    }
  }
  return `${root}/${mainName}`;
}

/**
 * Reads `mainName` (plus any companion files, e.g. tetgen's .node/.ele pair)
 * through meshio++.
 *
 * `format` forces a single format key; otherwise the extension's candidate
 * list is tried in order — the default first, then the alternatives, since
 * meshio++ cannot auto-detect `.msh` (gmsh/ansys/freefem) or `.inp`
 * (abaqus/ansysinp).  The caller supplies the bytes so this module never
 * touches the disk (and meshFileParser avoids an import cycle).
 *
 * `timeStep` selects a step of a multi-step file (meshio++ >= 8.6.0; Exodus,
 * GiD, MED, CGNS and Tecplot time series can all be SIZED before a read since
 * the 11.3.0 native metadata readers — see IN_FILE_TIMELINE_EXTENSIONS).
 * 0 is the first step — omitting `timeStep` and passing 0 are equivalent,
 * both routing through `readMeshSelective` rather than `readMesh` once any
 * candidate needs it. An out-of-range step throws (surfaced verbatim;
 * meshio++'s message already names the available count). NOTE for MED: a
 * strict step-0 select throws upstream (0 is the "default", so a
 * multi-timestep field demands a non-default step or leniency) — the lenient
 * retry in the candidate walk is what makes MED step 0 land correctly.
 *
 * Each candidate that allows it (`MESHIO_LENIENT_RETRY_FORMATS`) gets a second,
 * LENIENT attempt before the next candidate is tried: for MED that is the
 * difference between opening a real Salome/Code_Aster file and refusing it, and
 * the strict attempt comes first so a file that needs nothing extra is read
 * exactly as before.
 */
/**
 * `MeshioMedInfo` -> `MdpaModel.source`. Blank strings (MED files routinely
 * leave name/description/units unset) are omitted rather than shown as
 * empty metadata — the `MeshSummary.unknown[]` convention: "not set" and
 * "set to nothing" read the same to a user, so only report what is real.
 * `fieldUnits[name]` is upstream's `[UNI, UNT]` pair (the field's own value
 * unit, then its time unit); only `UNI` has a place in `units.fields` today.
 */
function medInfoToSource(info: MeshioMedInfo): SourceMetadata {
  const source: SourceMetadata = { format: "med" };
  if (info.meshName.trim().length > 0) source.meshName = info.meshName;
  if (info.description.trim().length > 0) source.description = info.description;
  const fields: Record<string, string> = {};
  for (const [name, [uni]] of Object.entries(info.fieldUnits)) {
    if (uni.trim().length > 0) fields[name] = uni;
  }
  const coords = info.unitCoords.trim();
  const time = info.unitTime.trim();
  if (coords.length > 0 || time.length > 0 || Object.keys(fields).length > 0) {
    source.units = {
      ...(coords.length > 0 ? { coords } : {}),
      ...(time.length > 0 ? { time } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
  }
  return source;
}

// ---- reads: the worker seam (roadmap item 2) -------------------------------------

/**
 * Data-only description of the `augment` hook a read applies to the raw meshio
 * mesh before conversion. A function cannot cross a thread, so the one real
 * caller (an OpenFOAM case injecting its time-directory fields) hands over the
 * data and `augmentFor` rebuilds the closure on whichever thread does the read.
 */
export type MeshioAugment = { kind: "openfoam"; parsed: OpenFoamParsedField[] };

/** Partitioned-file selection (roadmap item 3); `undefined` for both is upstream's default. */
export interface MeshioReadOptions {
  piece?: number | null;
  dropGhosts?: boolean;
  /**
   * Read only these `point_data`/`cell_data` arrays (upstream's own names,
   * case-sensitive, before `sanitizeVariable`). `undefined` reads them all.
   */
  arrays?: string[] | null;
}

/** What each kind of meshio++ read returns. */
export interface MeshioReadResults {
  model: MdpaModel;
  timeValues: number[];
  metadata: MeshioMetadata;
}

/**
 * One meshio++ read in a form that can cross a thread boundary: staged bytes
 * in, plain data out. The `AbortSignal` is not part of it (it travels beside
 * the job, see `MeshioReadRunner`).
 */
export interface MeshioReadJob<K extends keyof MeshioReadResults = keyof MeshioReadResults> {
  kind: K;
  mainName: string;
  files: MeshioInputFile[];
  ext: string;
  format?: string;
  /** `model` jobs only. */
  timeStep?: number;
  /** `model` jobs only. */
  augment?: MeshioAugment;
  /** `model` jobs only. */
  opts?: MeshioReadOptions;
}

/** How meshio++ reads execute; swappable so the extension can run them in a worker thread. */
export type MeshioReadRunner = <K extends keyof MeshioReadResults>(
  job: MeshioReadJob<K>,
  signal?: AbortSignal
) => Promise<MeshioReadResults[K]>;

/** Rebuilds the augment closure from its data description. */
export function augmentFor(a: MeshioAugment): (mesh: MeshioMesh, diagnostics: MdpaDiagnostic[]) => void {
  return (mesh, diagnostics) => augmentMeshioWithFoamFields(mesh, a.parsed, diagnostics);
}

/** Runs one meshio++ read in the CURRENT thread — what the default runner and the read worker both call. */
export const readMeshioInProcess: MeshioReadRunner = async (job, signal) => {
  if (signal?.aborted) throw new Error("cancelled");
  switch (job.kind) {
    case "model":
      return (await readMeshioModelInProcess(
        job.mainName,
        job.files,
        job.ext,
        job.format,
        job.timeStep,
        job.augment ? augmentFor(job.augment) : undefined,
        job.opts
      )) as never;
    case "timeValues":
      return (await readMetadataWith(job.mainName, job.files, job.ext, job.format, (md) => md.timeValues)) as never;
    default:
      return (await readMetadataWith(job.mainName, job.files, job.ext, job.format, (md) => md)) as never;
  }
};

let meshioReadRunner: MeshioReadRunner = readMeshioInProcess;
let readWorkerInstalled = false;

/**
 * Replaces the in-process meshio++ reader (the default, used by plain-Node
 * tests and by the other worker threads, which already run off the host).
 * `extension.ts` and the MCP server install a worker-thread client so a large
 * read never blocks the host and a superseded one can be cancelled.
 */
export function configureMeshioReadRunner(runner: MeshioReadRunner): void {
  meshioReadRunner = runner;
  readWorkerInstalled = runner !== readMeshioInProcess;
}

async function runMeshioRead<K extends keyof MeshioReadResults>(
  job: MeshioReadJob<K>,
  signal?: AbortSignal
): Promise<MeshioReadResults[K]> {
  // A worker has its own engineActivity singleton; in-process, loadMeshio()
  // already reports, so tracking both would double-count.
  return readWorkerInstalled
    ? trackEngine("meshio", () => meshioReadRunner(job, signal))
    : meshioReadRunner(job, signal);
}

/**
 * Reads a mesh with meshio++ and converts it to an `MdpaModel`.
 *
 * `augment` may be a function (always runs in-process, as every direct test
 * caller passes) or a `MeshioAugment` description (runs wherever the installed
 * runner does). `opts.signal` cancels the read when a worker runner is
 * installed — a synchronous wasm call in-process cannot be interrupted — and
 * rejects with "cancelled".
 */
export async function readMeshioModel(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string,
  timeStep?: number,
  augment?: MeshioAugment | ((mesh: MeshioMesh, diagnostics: MdpaDiagnostic[]) => void),
  /**
   * `piece`/`dropGhosts` (roadmap item 3): partitioned-file selection, for
   * .pvtu/.pvtp and a Steps-carrying .vtkhdf's own composite blocks. A
   * trailing options object rather than two more positionals, since
   * `readMeshioModel` already has enough of those; `undefined` for both
   * (every caller before this one) is the unchanged upstream default.
   */
  opts?: MeshioReadOptions & { signal?: AbortSignal }
): Promise<MdpaModel> {
  const { signal, ...readOpts } = opts ?? {};
  if (typeof augment === "function") {
    if (signal?.aborted) throw new Error("cancelled");
    return readMeshioModelInProcess(mainName, files, ext, format, timeStep, augment, readOpts);
  }
  return runMeshioRead(
    { kind: "model", mainName, files, ext, format, timeStep, augment, opts: readOpts },
    signal
  );
}

/** The reader keys whose `{info: true}` side channel is a NURBS payload (see readModelWith). */
const NURBS_INFO_FORMATS: readonly string[] = ["cad_json", "step", "iges", "mfem"];

async function readMeshioModelInProcess(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string,
  timeStep?: number,
  augment?: (mesh: MeshioMesh, diagnostics: MdpaDiagnostic[]) => void,
  opts?: MeshioReadOptions
): Promise<MdpaModel> {
  const candidates = format ? [format] : MESHIO_READ_CANDIDATES[ext.toLowerCase()] ?? [];
  if (candidates.length === 0) {
    throw new Error(`No meshio++ reader is registered for "${ext}".`);
  }

  const attempts: { fmt: string; lenient: boolean }[] = [];
  for (const fmt of candidates) {
    attempts.push({ fmt, lenient: false });
    if (MESHIO_LENIENT_RETRY_FORMATS.includes(fmt)) attempts.push({ fmt, lenient: true });
  }

  const m = await loadMeshioForRead(ext, candidates);
  try {
    return await readModelWith(m, mainName, files, candidates, attempts, timeStep, augment, opts);
  } catch (e) {
    // The codec fallback (meshio++ >= 17.0.0's full artifact): a file whose
    // VTK XML blocks are zstd/lz4-deflated, or whose libMesh bytes are
    // bzip2-compressed, is readable only where the codec is linked. The lean
    // refusal names its own missing flag (measured verbatim), so the retry
    // fires ONLY on that — an ordinary read failure propagates untouched.
    if (!isCodecFallbackError(e) || !meshioFullInstalled()) throw e;
    const fm = await loadMeshioFull();
    const model = await readModelWith(fm, mainName, files, candidates, attempts, timeStep, augment, opts);
    model.diagnostics.push({
      line: 0,
      message: `Read via the full artifact — the lean build cannot inflate this file: ${errText(e)}`,
    });
    return model;
  }
}

/** The candidate walk itself, run against whichever module the caller resolved. */
async function readModelWith(
  m: MeshioModule,
  mainName: string,
  files: MeshioInputFile[],
  candidates: readonly string[],
  attempts: readonly { fmt: string; lenient: boolean }[],
  timeStep: number | undefined,
  augment: ((mesh: MeshioMesh, diagnostics: MdpaDiagnostic[]) => void) | undefined,
  opts: MeshioReadOptions | undefined
): Promise<MdpaModel> {
  const mainPath = stageFiles(m, mainName, files);

  const diagnostics: MdpaDiagnostic[] = [];
  const errors: string[] = [];
  for (const { fmt, lenient } of attempts) {
    try {
      // MED's own info side channel (mesh name/description/units, and —
      // lenient-only — exactly which constructs a lenient read could not
      // represent) needs `readMeshSelective(..., {info: true})`, which
      // `readMesh`'s fast path cannot request. The NURBS side channels need
      // the same switch: a cad_json B-rep, a full artifact's step/iges read
      // and an MFEM NURBS mesh all carry their patches in `mesh.info`, and
      // the IGA derive kinds consume that (see deriveMesh.ts). Requesting it
      // for every other format is a silent noop upstream, so this widens
      // ONLY these formats off the fast one rather than slowing every reader
      // down.
      const wantInfo = fmt === "med" || NURBS_INFO_FORMATS.includes(fmt);
      const wantSelective =
        timeStep !== undefined ||
        lenient ||
        wantInfo ||
        opts?.piece !== undefined ||
        opts?.dropGhosts !== undefined ||
        opts?.arrays !== undefined;
      const mesh = !wantSelective
        ? m.readMesh(mainPath, fmt)
        : m.readMeshSelective(mainPath, {
            format: fmt,
            timeStep,
            lenient,
            info: wantInfo,
            piece: opts?.piece,
            dropGhosts: opts?.dropGhosts,
            arrays: opts?.arrays,
          });
      if (fmt !== candidates[0]) {
        diagnostics.push({
          line: 0,
          message: `Read as "${fmt}" — the default "${candidates[0]}" failed: ${errors[0]}`,
        });
      }
      const medInfo = mesh.info?.format === "med" ? (mesh.info as MeshioMedInfo) : undefined;
      if (lenient) {
        const skipped = medInfo?.skippedConstructs ?? [];
        diagnostics.push({
          line: 0,
          message:
            skipped.length > 0
              ? `Read "${fmt}" leniently — the strict read failed (${errors[errors.length - 1]}). ` +
                `Constructs this reader cannot represent were skipped: ${skipped.join(", ")}. ` +
                `The mesh itself is complete.`
              : `Read "${fmt}" leniently — the strict read failed (${errors[errors.length - 1]}). ` +
                `Constructs this reader cannot represent were skipped; the mesh itself is complete.`,
        });
      }
      if (augment) augment(mesh, diagnostics);
      const model = meshioToModel(mesh, diagnostics);
      if (medInfo) {
        model.source = medInfoToSource(medInfo);
        applyMedDimensions(model, medInfo.fieldUnits);
      }
      // The NURBS side channel: kept ON the model for the IGA derive kinds,
      // dropped by every applied edit (operations.ts's applyOpAsync — a mesh
      // an op changed is no longer the patches' sampling). The info object is
      // plain data (measured: it crosses a worker by structured clone and
      // runs on another instance) but holds typed arrays, so it must never be
      // JSON-serialized; summaries read `format`/`patches`/`faces` only.
      const info = mesh.info;
      const infoFormat = info?.format;
      if (info && (infoFormat === "cad_json" || infoFormat === "mfem")) {
        const raw = info as { patches?: unknown[]; faces?: unknown[] };
        model.nurbs = {
          format: infoFormat,
          patches: Array.isArray(raw.patches) ? raw.patches.length : 0,
          faces: infoFormat === "cad_json" && Array.isArray(raw.faces) ? raw.faces.length : 0,
          info,
        };
      }
      return model;
    } catch (e) {
      errors.push(errText(e));
    }
  }

  const detail = attempts
    .map((a, i) => `  ${a.fmt}${a.lenient ? " (lenient)" : ""}: ${errors[i]}`)
    .join("\n");
  throw new Error(`Could not read "${mainName}" as ${candidates.join(" / ")}:\n${detail}`);
}

/**
 * The lean build's own refusals for a codec only the full artifact links.
 * Measured verbatim against 17.2.0 — the three messages a lean read gives for
 * a zstd/lz4 VTK XML file and a bzip2 libMesh file (`VTK XML zstd
 * decompression requires a build with -DMESHIOPLUSPLUS_WITH_ZSTD=ON`, the lz4
 * twin, and `libMesh: <path> is bzip2-compressed and this build has no
 * bzip2 (MESHIOPLUSPLUS_WITH_BZIP2; the Python reader inflates it)`). Note
 * they do NOT say `{full: true}` — that phrasing is the CAD refusals' — so
 * the allowlist is keyed on the flag name the kernel actually prints.
 */
function isCodecFallbackError(e: unknown): boolean {
  return /MESHIOPLUSPLUS_WITH_(ZSTD|LZ4|BZIP2)/.test(errText(e));
}

/**
 * Shared candidate walk backing `readMeshioTimeValues`/`readMeshioMetadata`:
 * both stage the file and try each candidate format's `readMetadata`, in the
 * same aggregated-error shape, differing only in which part of the result
 * each one wants.
 */
async function readMetadataWith<T>(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format: string | undefined,
  pick: (md: MeshioMetadata) => T
): Promise<T> {
  const candidates = format ? [format] : MESHIO_READ_CANDIDATES[ext.toLowerCase()] ?? [];
  if (candidates.length === 0) {
    throw new Error(`No meshio++ reader is registered for "${ext}".`);
  }

  const m = await loadMeshioForRead(ext, candidates);
  try {
    return await readMetadataFrom(m, mainName, files, candidates, pick);
  } catch (e) {
    // The same codec fallback readMeshioModelInProcess applies: a summary of
    // a zstd/lz4 VTK XML file or a bzip2 libMesh file needs the full
    // artifact's inflator, and the lean refusal names the missing flag.
    if (!isCodecFallbackError(e) || !meshioFullInstalled()) throw e;
    return await readMetadataFrom(await loadMeshioFull(), mainName, files, candidates, pick);
  }
}

/** The metadata walk itself, run against whichever module the caller resolved. */
async function readMetadataFrom<T>(
  m: MeshioModule,
  mainName: string,
  files: MeshioInputFile[],
  candidates: readonly string[],
  pick: (md: MeshioMetadata) => T
): Promise<T> {
  const mainPath = stageFiles(m, mainName, files);

  const errors: string[] = [];
  for (const fmt of candidates) {
    try {
      return pick(m.readMetadata(mainPath, fmt) as unknown as MeshioMetadata);
    } catch (e) {
      errors.push(errText(e));
    }
  }
  const detail = candidates.map((f, i) => `  ${f}: ${errors[i]}`).join("\n");
  throw new Error(`Could not read "${mainName}" as ${candidates.join(" / ")}:\n${detail}`);
}

/**
 * The time-series values a multi-step file carries (meshio++ >= 8.6.0's
 * `MeshMetadata.timeValues`); empty for a format with no time concept.  Used to
 * size and label the in-file timeline — see `IN_FILE_TIMELINE_EXTENSIONS` in
 * meshFormats.ts.
 *
 * Exodus, GiD postprocess, MED, CGNS and Tecplot are the formats this reports
 * anything for — gid joined upstream's step-capable metadata readers in
 * meshio++ 10.20.0 (header-only `.post.res` scan), and MED/CGNS/Tecplot in
 * 11.3.0 (native `read_*_metadata`: MED's CHA/PDT union, CGNS's
 * Base/ZoneIterativeData TimeValues, Tecplot's ZONE SOLUTIONTIME/STRANDID).
 * A static MED reports its single step `[0]`. Explicit MED step reads still
 * work through the application's lenient retry (transientAudit.test.ts).
 */
export async function readMeshioTimeValues(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string,
  signal?: AbortSignal
): Promise<number[]> {
  return runMeshioRead({ kind: "timeValues", mainName, files, ext, format }, signal);
}

/**
 * The header-only counterpart of `readMeshioModel`: the file's shape without
 * its heavy arrays (counts, block shapes, data-array names, regions, bbox).
 * Same candidate walk and aggregated errors as the time-values probe above.
 *
 * Header-only is a per-format property, not a promise: formats without a
 * native metadata path report `fellBackToFullRead: true`, and the summary is
 * then no cheaper than parsing — see HEADER_METADATA_EXTENSIONS for the
 * measured table and the gate callers must apply.
 */
export async function readMeshioMetadata(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string,
  signal?: AbortSignal
): Promise<MeshioMetadata> {
  return runMeshioRead({ kind: "metadata", mainName, files, ext, format }, signal);
}

/** One file produced beside the main output (see `writeMeshioBytes`). */
export interface MeshioCompanionFile {
  /**
   * Path RELATIVE to the main file's directory, `/`-separated.
   *
   * Usually a bare basename, exactly as the main file references it (XDMF's
   * `<stem>.h5`).  OpenFOAM is the one writer that emits a tree rather than a
   * sibling, so this can carry directories — `constant/polyMesh/points`.  It
   * is always a relative path that stays inside the destination directory
   * (checked with `isSafeEntryName`), so a caller may join it onto the
   * destination dir after creating the intermediate folders.
   */
  name: string;
  data: Uint8Array;
}

/** What a meshio++ write produced: the named file, plus anything beside it. */
export interface MeshioWriteResult {
  data: Uint8Array;
  /** Empty for the single-file formats. */
  companions: MeshioCompanionFile[];
  /** Present when a provenance scope was requested; see `ProvenanceRequest`. */
  provenance?: { embedded: boolean; lines: string[] };
}

/**
 * What to record when a meshio++ write is asked to carry provenance. `notes`
 * are (category, detail) pairs; `source` names where the mesh came from.
 * Whether the block actually landed in the file is reported back on the result
 * as `provenance.embedded` — a format with no header slot silently keeps only
 * its one-line credit, and pretending otherwise would be the report lying.
 */
export interface ProvenanceRequest {
  source?: { file: string; format: string };
  notes?: { category: string; detail: string }[];
}

/**
 * Writes an already-built meshio++ mesh into a scratch MEMFS directory and
 * harvests everything the writer produced. Shared by `writeMeshioBytes` (which
 * converts a model first) and `writeRawMeshioBytes` (which does not).
 */
function writeMeshToBytes(
  m: MeshioModule,
  mesh: MeshioMesh,
  e: string,
  fmt: string,
  stemOpt: string | undefined,
  prov?: ProvenanceRequest
): MeshioWriteResult {
  // A real extension plus an explicit format key: never ambiguous.
  const stem = memfsStem(stemOpt);
  const name = `${stem}${e}`;
  // Write into a scratch directory rather than "/": every path a writer derives
  // is relative to the file it was handed (OpenFOAM's polyMesh tree included),
  // so everything it produced is then INSIDE this directory and the harvest is
  // a plain walk. Diffing "/" instead would have to know which of MEMFS's own
  // entries (/tmp, /home, /dev, /proc) to ignore. The module is a fresh
  // instance per call (see loadMeshio), so the directory is always empty.
  const root = "/mio_out";
  m.FS.mkdir(root);
  if (fmt === "elmer") {
    m.writeMesh(root, mesh, fmt);
    return { data: new Uint8Array(), companions: harvest(m, root, name) };
  }
  if (prov) {
    // Mode 1 = best effort: a format without a header slot writes normally and
    // simply keeps its credit line, which `readProvenance` then reports as
    // unrecognised. Mode 2 would refuse those, which no caller wants.
    m.withProvenance(1, () => {
      if (prov.source) m.provenanceSetSource(prov.source.file, prov.source.format);
      for (const n of prov.notes ?? []) m.provenanceNote(n.category, n.detail);
      m.provenanceSetTarget(fmt);
      m.writeMesh(`${root}/${name}`, mesh, fmt);
    });
    const found = m.readProvenance(`${root}/${name}`);
    return {
      data: m.FS.readFile(`${root}/${name}`) as Uint8Array,
      companions: harvest(m, root, name),
      provenance: { embedded: found.recognised, lines: found.lines },
    };
  }
  m.writeMesh(`${root}/${name}`, mesh, fmt);
  return { data: m.FS.readFile(`${root}/${name}`) as Uint8Array, companions: harvest(m, root, name) };
}

/**
 * The `.step` export: ONE target with auto-fit behaviour (the 17.2.0 "Skin to
 * CAD" decision), reached through `writeMeshioBytes`'s `fmt === "step"`
 * intercept — so the UI Export menu, Save As and every MCP write share it.
 *
 * Both behaviours write the model's BOUNDARY SKIN (`extractSkinModel`), for
 * two measured reasons: the faceted `step` writer treats every cell it is
 * handed as surface (a tetra's first three nodes would be misread as a
 * triangle and the write refused as inconsistently wound), and `fitCad` wants
 * exactly the skin. A volume model therefore exports its boundary as the
 * solid — stated in a diagnostic, never silent.
 *
 *  - A closed, consistently wound, all-triangle skin attempts the FULL
 *    artifact's `fitCad`: analytic faces where primitives fit, demoted
 *    patches where they do not. The AP214 STEP comes back from `stepPath`,
 *    and the solid's B-rep also rides beside it as a `<stem>.cad.json`
 *    companion (via `writeMesh(..., "cad_json", {info})`). The diagnostic
 *    names the fitted face types so the report says WHICH export ran, whether
 *    the solid came out closed, and how far it lies from the skin it was
 *    fitted from (`faceDeviation`, meshio++ 17.11.0).
 *  - Anything else — quad skins, open surfaces, `fitCad: false`, a fit that
 *    failed or a full artifact that would not load — falls through to the
 *    faceted `step` writer, WITHOUT `info` (the writer refuses it: "STEP
 *    writes faceted solids"). Its own refusal of a non-solid surface
 *    (open edges, bad winding) propagates verbatim rather than being caught:
 *    it names the exact defect, which is the useful part.
 *
 * `opts.fitCad` is the fit controls: an object rides `fitCad` verbatim
 * (upstream validates keys and values), `false` skips fitting entirely, and
 * undefined takes the kernel's own defaults. `stepPath` is NOT caller-settable
 * here — the write always targets its own scratch path (`mio_out/<stem>.step`),
 * and the caller's object is spread FIRST so it cannot move it.
 */
async function writeStepModel(
  model: MdpaModel,
  e: string,
  opts: {
    diagnostics?: MdpaDiagnostic[];
    stem?: string;
    onWarning?: (message: string) => void;
    provenance?: ProvenanceRequest;
    fitCad?: FitCadOptions | false;
  }
): Promise<MeshioWriteResult> {
  const note = (message: string) => {
    opts.diagnostics?.push({ line: 0, message });
    opts.onWarning?.(message);
  };
  const { model: skin, faces } = extractSkinModel(model);
  if (faces === 0) {
    throw new Error(
      "STEP writes a solid's surface, and this mesh has no surface or volume cells to skin."
    );
  }
  // Surface cells survive extractSkin verbatim; only VOLUME cells were
  // collapsed into boundary faces, and that deserves its own line.
  if (model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume")) {
    note(`STEP: volume interiors are not representable — wrote the boundary skin (${faces} faces).`);
  }
  const mesh = modelToMeshio(skin, opts.diagnostics ?? [], { dim: 3 });

  if (opts.fitCad !== false && closedTriangleSkin(skin)) {
    try {
      const m = await loadMeshioFull();
      const stem = memfsStem(opts.stem);
      const name = `${stem}.step`;
      // fitCad writes `stepPath` itself (AP214, from OpenCASCADE) — it does
      // not create directories, so the scratch dir is made first, the same
      // convention writeMeshToBytes uses.
      const root = "/mio_out";
      m.FS.mkdir(root);
      // `faceDeviation` (meshio++ 17.11.0) measures the fitted solid against
      // the skin it was fitted FROM: the two-sided distance between each face
      // and the mesh the user exported. Forced ON, so the export can state how
      // far the B-rep lies from the geometry — a caller may still switch it
      // off with `fitCad: {faceDeviation: false}`. `stepPath` stays forced
      // last, so a caller-supplied object can never move the write.
      const fit = m.fitCad(mesh, {
        faceDeviation: true,
        ...(opts.fitCad ?? {}),
        stepPath: `${root}/${name}`,
      });
      if (!fit.valid) {
        throw new Error(`the fitted B-rep failed OpenCASCADE's validity check`);
      }
      let companions: MeshioCompanionFile[] = [];
      try {
        // The B-rep, portably: cad_json takes the fit's own mesh + info and
        // writes the solid back out (measured: reads back with its faces).
        m.writeMesh(`${root}/${stem}.cad.json`, fit.mesh, "cad_json", { info: fit.info });
        companions = harvest(m, root, name);
      } catch (err) {
        note(
          `STEP: the ${stem}.cad.json B-rep companion failed (${errText(err)}) — ` +
            `the .step itself is written.`
        );
      }
      if (opts.provenance) {
        note("A fitted STEP has no provenance slot; the export report sidecar carries it.");
      }
      note(
        `STEP: fitted CAD B-rep via fitCad — ${describeFitCad(fit)}; ` +
          `the B-rep also rides beside it as ${stem}.cad.json.`
      );
      return { data: m.FS.readFile(`${root}/${name}`) as Uint8Array, companions };
    } catch (err) {
      note(
        `STEP: fitCad did not produce a solid (${errText(err)}) — wrote a faceted solid instead.`
      );
    }
  } else if (opts.fitCad !== false) {
    note(
      "STEP: no closed, consistently wound all-triangle skin to fit — wrote a faceted solid " +
        "(fitCad needs one; Extract Skin gives a volume mesh its boundary, Repair closes a leaky one)."
    );
  }
  const m = await loadMeshio();
  return writeMeshToBytes(m, mesh, e, "step", opts.stem, opts.provenance);
}

/**
 * The fitted-face census a fitCad diagnostic reports: which types ran, what
 * was demoted, whether the solid came out closed, and — when the fit measured
 * it — how far the fitted solid lies from the skin it was fitted from.
 *
 * The two deviations are DIFFERENT quantities and are never conflated:
 * `maxDeviation` is upstream's own fit tolerance (how far a face may sit from
 * its primitive), while `hausdorffMax`/`hausdorffRms` (meshio++ 17.11.0's
 * `faceDeviation`) is the measured two-sided distance between each face and
 * the skin — the chordal error the tessellation itself carries. The second is
 * NaN when the caller switched the measurement off, and then it is not stated.
 */
function describeFitCad(fit: FitCadResult): string {
  const named: [string, number][] = [
    ["plane", fit.numPlane],
    ["sphere", fit.numSphere],
    ["cylinder", fit.numCylinder],
    ["cone", fit.numCone],
    ["torus", fit.numTorus],
    ["B-spline patch", fit.numBspline],
    ["fillet", fit.numFillet],
    ["thread", fit.numHelical],
    ["chamfer", fit.numChamfer],
    ["blend", fit.numBlend],
  ];
  const parts = named.filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}${n === 1 ? "" : "s"}`);
  if (fit.numFacetedFaces > 0) {
    parts.push(`${fit.numFacetedFaces} demoted to faceted`);
  }
  const faces = parts.length > 0 ? parts.join(", ") : `${fit.numFaces} faceted`;
  const notes: string[] = [];
  if (fit.maxDeviation > 0) {
    notes.push(`max deviation ${fit.maxDeviation.toPrecision(3)}`);
  }
  // 17.11.0: every edge of a shell borders two faces.
  if (typeof fit.closed === "boolean") {
    notes.push(fit.closed ? "closed solid" : "OPEN solid");
  }
  if (Number.isFinite(fit.hausdorffMax)) {
    notes.push(
      `skin deviation ${fit.hausdorffMax.toPrecision(3)} (RMS ${fit.hausdorffRms.toPrecision(3)})`
    );
  }
  // 17.13.0: the freeform pipeline. Only stated when it did something beyond
  // the legacy mode, so a default fit reads exactly as before.
  if (fit.freeformMode && fit.freeformMode !== "legacy") {
    const free: string[] = [`freeform ${fit.freeformMode}`];
    if (fit.numFreeformAdaptive > 0) free.push(`${fit.numFreeformAdaptive} adaptive patch(es)`);
    if (fit.numNetworkPatches > 0) {
      free.push(`${fit.numNetworkPatches} network patch(es), ${fit.numExtraordinaryVertices} extraordinary vertex(es)`);
    }
    if (Number.isFinite(fit.maxG1AngleDeg) && fit.maxG1AngleDeg > 0) {
      free.push(`max G1 jump ${fit.maxG1AngleDeg.toPrecision(3)}°`);
    }
    if (Number.isFinite(fit.maxFreeformDistance) && fit.maxFreeformDistance > 0) {
      free.push(`freeform distance ${fit.maxFreeformDistance.toPrecision(3)}`);
    }
    notes.push(free.join(", "));
  }
  if (typeof fit.facetAreaFraction === "number" && fit.facetAreaFraction > 0) {
    notes.push(`${(100 * fit.facetAreaFraction).toPrecision(3)}% of the area stayed faceted`);
  }
  if (fit.brepChecked) notes.push("B-rep checked");
  // Outside the legacy mode the report lists every patch it tried; name why
  // a patch was demoted, which is the question a user asks next.
  const demoted = (fit.faces ?? []).filter((f) => f.demotionReason !== "none");
  if (demoted.length > 0) {
    const reasons = new Map<string, number>();
    for (const f of demoted) reasons.set(f.demotionReason, (reasons.get(f.demotionReason) ?? 0) + 1);
    notes.push(`demotions: ${[...reasons].map(([r, n]) => `${n} ${r}`).join(", ")}`);
  }
  return notes.length > 0 ? `${faces} (${notes.join("; ")})` : faces;
}

/**
 * Writes a meshio++ mesh WITHOUT going through an `MdpaModel`. Needed for the
 * one thing our own writers deliberately cannot do: a structured `.vti` lattice
 * (an unstructured model cannot reconstruct the implicit topology), which is
 * exactly what a voxel grid or a signed-distance volume is. The caller names the
 * format key (`"vti"`).
 */
export async function writeRawMeshioBytes(
  mesh: MeshioMesh,
  ext: string,
  format: string,
  opts: { stem?: string; provenance?: ProvenanceRequest } = {}
): Promise<MeshioWriteResult> {
  const m = await loadMeshio();
  return writeMeshToBytes(m, mesh, ext.toLowerCase(), format, opts.stem, opts.provenance);
}

/**
 * Serializes a model through meshio++.  Always bytes: gmsh (4.1) and ansys
 * write BINARY, so a string-only path would corrupt them.
 *
 * Some writers emit MORE than the file they were handed, in two shapes:
 *  - A SIBLING: since meshio++ 8.0.0 the XDMF writer puts the heavy arrays in a
 *    companion `<stem>.h5` and leaves only `<stem>.h5:/data0` references in the
 *    XML, so returning the XML alone would write a dangling file.
 *  - A DIRECTORY: since meshio++ 9.20.0 the OpenFOAM writer emits
 *    `constant/polyMesh/{points,faces,owner,neighbour,boundary}` and leaves the
 *    named `.foam` path as a 0-byte marker.  Here the companions ARE the mesh
 *    and `data` is the empty marker, so a caller that skipped them would write
 *    nothing at all.
 * The harvest is therefore a RECURSIVE walk, and a companion's `name` is a
 * relative path rather than a basename.  The MEMFS name carries the caller's
 * `stem` because XDMF's XML embeds it verbatim.
 */
/** Every SubModelPart (recursively) whose membership is nodes only. */
function nodeOnlyPartPaths(parts: readonly SubModelPart[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (
      p.nodeIds.length > 0 &&
      p.elementIds.length === 0 &&
      p.conditionIds.length === 0 &&
      p.geometryIds.length === 0
    ) {
      out.push(p.path);
    }
    out.push(...nodeOnlyPartPaths(p.children));
  }
  return out;
}

export async function writeMeshioBytes(
  model: MdpaModel,
  ext: string,
  opts: {
    format?: string;
    diagnostics?: MdpaDiagnostic[];
    stem?: string;
    onWarning?: (message: string) => void;
    /** Ask the kernel to embed a provenance block where the format has a slot. */
    provenance?: ProvenanceRequest;
    /**
     * The `.step` export's fit controls (writeStepModel): an options object
     * rides `fitCad` verbatim, `false` skips fitting and writes the faceted
     * solid directly, and undefined asks the kernel's own defaults. Ignored
     * by every other format. The fit always measures the solid against the
     * skin (`faceDeviation`, meshio++ 17.11.0) unless the object switches
     * that off.
     */
    fitCad?: FitCadOptions | false;
  } = {}
): Promise<MeshioWriteResult> {
  const e = ext.toLowerCase();
  const fmt = opts.format ?? MESHIO_WRITE_FORMAT[e];
  if (!fmt) throw new Error(`meshio++ cannot write "${ext}".`);

  // The `.step` export is NOT a plain writer call: its auto-fit intercept
  // (fitCad, or the faceted fallback) owns the whole write. See writeStepModel.
  if (fmt === "step") return writeStepModel(model, e, opts);

  const m = await loadMeshio();
  // Capability-driven export (roadmap item 3): MESHIO_WRITE_FORMAT is a
  // static table that can drift ahead of, or behind, what THIS build
  // actually links (a build without gidpost still lists "gid" in our table
  // even though writing it throws — see the MESHIO_WRITE_FORMAT docblock).
  // Checking the live registry here turns that mismatch into a named
  // refusal instead of a raw wasm exception from deep inside writeMesh.
  if (!m.availableFormats().writers.includes(fmt)) {
    throw new Error(
      `meshio++ ${meshioPackageVersion() ?? "(unknown version)"} does not link a "${fmt}" ` +
        `writer for "${ext}" in this build. See mesh_capabilities for what this build supports.`
    );
  }
  const note = (message: string) => { opts.diagnostics?.push({line:0,message}); opts.onWarning?.(message); };
  // Triangle is a 2D writer. Keeping dim=3 makes even a flat XY fixture
  // unwritable; dropping a nonzero z, on the other hand, would silently project
  // a surface. Only the exactly representable case gets the 2D conversion.
  if (fmt === "triangle") {
    for (let i = 0; i < model.nodeCount; i++) {
      if (model.coords[3 * i + 2] !== 0) throw new Error("Triangle requires XY-plane coordinates (z = 0); export a 3D surface as another format instead of projecting it.");
    }
  }
  if (["marc", "radioss", "febio"].includes(fmt)) note(`${fmt}: mesh-only export; solver material, load and control cards are not reconstructed from the Kratos model.`);
  if (["elmer", "mfem", "mphbin", "patran", "marc", "radioss", "z88"].includes(fmt) && model.fields.length) note(`${fmt}: this mesh export cannot preserve arbitrary result fields; use VTK or another results format to retain them.`);
  if (["elmer", "mfem", "mphbin"].includes(fmt) && model.subModelParts.length) note(`${fmt}: node-only groups are not representable; overlapping cell groups may collapse to one format-native label.`);
  // Exodus is the one format with a home for per-element scalars — everything
  // else it would simply drop. See modelToMeshio's `exodusAttributes`.
  const mesh = modelToMeshio(model, opts.diagnostics ?? [], {
    exodusAttributes: fmt === "exodus",
    dim: fmt === "triangle" ? 2 : 3,
    // Zone files come from the parts: no per-block cell region (a block is
    // not a zone) and face zones as side regions (former roadmap item 13, delivered 2026-10-19).
    openfoamZones: fmt === "openfoam",
  });
  const out = writeMeshToBytes(m, mesh, e, fmt, opts.stem, opts.provenance);
  if (fmt === "gmsh") {
    // Measured against the live wasm (roadmap item 3): a SubModelPart whose
    // membership is nodes only (no elements/conditions/geometries) writes
    // its `mesh.regions` point-kind region same as every other format, but
    // Gmsh's own physical groups are dimension-tagged (0=point..3=volume)
    // and the writer never emits a dim-0 one from it — the part vanishes
    // with no diagnostic at all, silently, which is worse than a warning
    // naming it. `.med`/`.inp` keep point-only groups; this is Gmsh-specific.
    const dropped = nodeOnlyPartPaths(model.subModelParts);
    for (const path of dropped) {
      const message =
        `A node-only SubModelPart ("${path}") has no cells to carry a Gmsh ` +
        `physical group tag and will not survive this export — use .med or ` +
        `.inp if the group needs to round-trip.`;
      opts.diagnostics?.push({ line: 0, message });
      opts.onWarning?.(message);
    }
  }
  if (fmt === "openfoam") {
    // The generic registry writer synthesizes one `defaultFaces` patch; the
    // model's own patch names are recovered onto the companions instead (see
    // `openfoamWrite.ts`). Diagnostics ride both channels the other writers
    // use: the array for headless callers, `onWarning` for the UI/MCP path.
    const rewritten = rewriteOpenFoamPatches(out.companions, model);
    out.companions = rewritten.companions;
    opts.diagnostics?.push(...rewritten.diagnostics);
    for (const d of rewritten.diagnostics) opts.onWarning?.(d.message);
    // Field export (roadmap item 3, Step 5): AFTER the patch rewrite, so a
    // written field's boundaryField block lists the model's own patch names
    // rather than the writer's synthesized `defaultFaces`.
    const fieldsOut = writeOpenFoamFields(out.companions, model, []);
    out.companions = fieldsOut.companions;
    opts.diagnostics?.push(...fieldsOut.diagnostics);
    for (const d of fieldsOut.diagnostics) opts.onWarning?.(d.message);
  }
  return out;
}

/**
 * Everything a writer left in its scratch directory beyond the named output,
 * as relative paths.  Shared by the single-mesh writer and the XDMF series
 * packer, which both leave a `<stem>.h5` beside the file they were asked for.
 */
function harvest(m: MeshioModule, root: string, name: string): MeshioCompanionFile[] {
  const companions: MeshioCompanionFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of m.FS.readdir(dir)) {
      if (entry === "." || entry === "..") continue;
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (rel === name) continue; // the named output itself
      const abs = `${dir}/${entry}`;
      if (m.FS.isDir(m.FS.stat(abs).mode)) {
        walk(abs, rel);
        continue;
      }
      // Nothing upstream produces an unsafe name, but a companion's path is
      // joined onto a real destination directory by every caller, so it gets
      // the same guard as a zip entry rather than being trusted.
      if (!isSafeEntryName(rel)) continue;
      companions.push({ name: rel, data: m.FS.readFile(abs) as Uint8Array });
    }
  };
  walk(root, "");
  return companions;
}

/**
 * A MEMFS-safe stem.  MEMFS is flat and the name reaches file content verbatim
 * (XDMF's `<stem>.h5` references), so path separators and the empty string are
 * not viable; anything unusable falls back to "out".
 */
function memfsStem(stem?: string): string {
  const clean = (stem ?? "").replace(/[/\\]/g, "_").trim();
  return clean.length > 0 ? clean : "out";
}

/** One step of a series to pack: its bytes are read only when its turn comes. */
export interface PackStep {
  /** The step file's own name; only its EXTENSION is used, to pick a reader. */
  name: string;
  /** The time this step is written at (the Kratos step number, not its index). */
  time: number;
  /** Read bytes for a direct transcode, or a parsed model for native/companion
   * readers. Called once, in order, and released before the next step. */
  read: () => Promise<Uint8Array | MdpaModel>;
}

export interface PackResult extends MeshioWriteResult {
  /** How many steps were written. */
  steps: number;
  warnings: string[];
  reports: import("./exportReport").CompactExportReport[];
  sidecar?: { name: string; text: string };
}

/**
 * Packs an ordered series of single-mesh files into ONE transient XDMF.
 *
 * Streaming by construction: each step is staged into MEMFS, read, written and
 * then UNLINKED before the next is touched, so peak memory is one step no
 * matter how long the series is.  `sequenceToTimeseries` would do the same job
 * in one call but takes the whole file list at once, which for a 200-step run
 * of 50 MB files means staging 10 GB into a heap that
 * `ALLOW_MEMORY_GROWTH=1` never gives back — the same reason `loadMeshio` is
 * deliberately not memoized.
 *
 * VTK datasets retain the direct byte transcode. Other formats can supply a
 * parsed model so native field handling, reader retries and companion staging
 * agree with the preview. XDMF export converts that model with modelToMeshio;
 * original entity IDs/kinds are not an XDMF round-trip guarantee.
 *
 * XDMF's temporal collection carries ONE static grid, so a series whose
 * topology changes cannot be represented and is refused by name rather than
 * written against the first step's mesh — the refusal points at `.pvd`, the
 * container that CAN hold it (`packPvd.ts`).
 */
export async function packXdmfSeries(
  steps: PackStep[],
  opts: {
    stem?: string;
    onProgress?: (done: number, total: number) => void;
    /** Actual destination basename, including the .xmf alias. */
    targetFile?: string;
    /** Checked before each step is read, so a cancelled pack stops early. */
    beforeRead?: () => void;
    /** Cooperative cancellation, checked alongside `beforeRead`. */
    signal?: AbortSignal;
    provenance?: import("./exportReport").ProvenanceMode;
  } = {}
): Promise<PackResult> {
  if (opts.signal?.aborted) throw new Error("cancelled");
  if (steps.length === 0) throw new Error("No steps to pack.");
  const m = await loadMeshio();
  const stem = memfsStem(opts.stem);
  const name = `${stem}.xdmf`;
  const inRoot = "/mio_in";
  const outRoot = "/mio_out";
  m.FS.mkdirTree(inRoot);
  m.FS.mkdir(outRoot);

  const warnings: string[] = [];
  const reports: import("./exportReport").CompactExportReport[] = [];
  const writer = m.createXdmfTimeSeriesWriter(`${outRoot}/${name}`, {
    dataFormat: "HDF",
    // Per-step flushing re-serializes the whole document, so it is quadratic
    // in the step count — exactly the shape this function exists to survive.
    autoFlush: false,
  });
  let written = 0;
  try {
    let grid: { points: number; cells: number } | undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      opts.beforeRead?.();
      if (opts.signal?.aborted) throw new Error("cancelled");
      const staged = `${inRoot}/step${i}${extOf(step.name)}`;
      const input = await step.read();
      if (opts.signal?.aborted) throw new Error("cancelled");
      if (input instanceof Uint8Array) m.FS.writeFile(staged, input);
      try {
        const diagnostics: MdpaDiagnostic[] = [];
        const mesh = input instanceof Uint8Array ? m.readMesh(staged) : modelToMeshio(input, diagnostics);
        warnings.push(...diagnostics.map((d) => d.message));
        const points = mesh.points.length / (mesh.dim || 3);
        const cells = meshCellCount(mesh);
        if (!grid) {
          grid = { points, cells };
          writer.writePointsCells(mesh);
        } else if (points !== grid.points || cells !== grid.cells) {
          // Same test the field-series scan uses for `topologyChangedAt`.
          // The refusal names the container that CAN hold it: a user who has
          // just been told "no" needs to be told what "yes" is. A `.pvd`
          // (packPvd.ts) is a collection of per-step files, each carrying its
          // own mesh, so saying only that an XDMF cannot is a dead end.
          throw new Error(
            `The mesh changes between steps (step 1 has ${grid.points} nodes and ` +
              `${grid.cells} cells, step ${i + 1} has ${points} and ${cells}). ` +
              `An XDMF time series carries one grid for every step, so this ` +
              `series cannot be packed into a single file — pack it as .pvd ` +
              `instead, whose per-step files each carry their own mesh.`
          );
        }
        writer.writeData(step.time, mesh);
        // This temporal writer is not the measured single-mesh XDMF writer.
        // Describe its input and output without borrowing that table's claims.
        const { buildUnverifiedReport, compactExportReport } = await import("./exportReport");
        reports.push(compactExportReport(buildUnverifiedReport({ model: input instanceof Uint8Array ? undefined : input, ext: extOf(opts.targetFile ?? name), format: "xdmf-series", targetFile: opts.targetFile ?? name, sourceFile: path.basename(step.name), sourceFormat: extOf(step.name), ops: [{ op: "packSeries", parameters: { time: step.time } }], companions: [`${stem}.h5`], warnings: diagnostics.map((d) => d.message), kernelVersion: meshioPackageVersion(), provenance: { embedded: false, note: opts.provenance === "none" ? "provenance was switched off" : "temporal XDMF writer has no provenance scope; reports identify each input step" } }, "temporal XDMF writer; single-mesh measurements do not verify a packed series")));
        written++;
      } finally {
        // Release the step before the next one is read — the whole point.
        if (input instanceof Uint8Array) {
          try { m.FS.unlink(staged); } catch { /* already gone */ }
        }
      }
      opts.onProgress?.(i + 1, steps.length);
    }
    // The files exist in MEMFS only from here.
    writer.finalize();
  } finally {
    writer.close();
  }

  const { seriesReportSidecar } = await import("./exportReport");
  const sidecar = seriesReportSidecar(opts.targetFile ?? name, reports, opts.provenance ?? "auto");
  return {
    sidecar,
    data: m.FS.readFile(`${outRoot}/${name}`) as Uint8Array,
    companions: harvest(m, outRoot, name),
    steps: written,
    warnings,
    reports,
  };
}

/** The extension meshio++ should pick a reader from, lowercased. */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/** Total cells across a mesh's blocks, whichever shape the binding returned. */
function meshCellCount(mesh: MeshioMesh): number {
  let n = 0;
  for (const block of mesh.cells ?? []) {
    const b = block as { data?: { length: number }; num_cells?: number };
    if (typeof b.num_cells === "number") n += b.num_cells;
    else if (b.data) n += b.data.length;
  }
  return n;
}
