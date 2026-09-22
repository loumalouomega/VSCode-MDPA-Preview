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
 * Since 8.8.0 the package ships TWO native artifacts — the sequential
 * `meshioplusplus_wasm.{mjs,wasm}` and the OpenMP/pthreads
 * `meshioplusplus_wasm_mt.{mjs,wasm}` — and `loadMeshioPlusPlus` picks between
 * them itself: its `resolveVariant` returns "mt" whenever `crossOriginIsolated`
 * is undefined, which is exactly the case under Node, hence in the extension
 * host.  So `locateFile` MUST honour the filename it is handed rather than
 * returning a fixed path: hand the mt glue the sequential binary and every
 * meshio format dies with
 *   Aborted(LinkError: WebAssembly.instantiate(): Import #0 module="a"
 *           function="a" error: function import requires a callable)
 * — an error that names neither the file nor the variant.  meshio.test.ts pins
 * this so a refactor cannot quietly reintroduce a fixed path.
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { MeshioMesh, MeshioMeshInfo, meshioToModel, modelToMeshio } from "./meshioConvert";
import {
  MESHIO_LENIENT_RETRY_FORMATS,
  MESHIO_READ_CANDIDATES,
  MESHIO_WRITE_FORMAT,
} from "./meshioFormats";
// The same relative-path guard the problem-archive extractor applies to a zip
// entry: a companion's name is likewise joined onto a real destination folder.
import { isSafeEntryName } from "./problemZip";
import { rewriteOpenFoamPatches } from "./openfoamWrite";
import { MdpaDiagnostic, MdpaModel } from "./types";
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
     */
    options?: { info?: MeshioMeshInfo }
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
  agglomerate(mesh: MeshioMesh, targetGroupSize?: number, returnMaps?: boolean): MeshioMesh | { mesh: MeshioMesh; cellMap: Int32Array };
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
    options?: { variant?: MeshioVariant }
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
 * The installed `@meshioplusplus/wasm` version, or undefined when no
 * package.json is found in either layout. Reads the same two locations
 * `packageDir()` resolves (dev node_modules, then the packaged dist/meshio
 * copy esbuild's copy-meshio plugin ships) without importing the module.
 */
export function meshioPackageVersion(): string | undefined {
  for (const dir of (() => {
    const dirs: string[] = [];
    try {
      dirs.push(path.dirname(require.resolve("@meshioplusplus/wasm/package.json")));
    } catch {
      /* dev package absent — try the packaged layout */
    }
    dirs.push(path.join(__dirname, "meshio"));
    return dirs;
  })()) {
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
 * opened for the lifetime of the extension host.  Dropping the instance lets
 * the whole WebAssembly.Memory go at GC — the same reasoning that gives MMG a
 * worker per run.  It also means no MEMFS bookkeeping: a throwing read leaves
 * no debris behind.  Only the ES-module namespace is cached (expensive to
 * resolve, holds no heap).
 */
export function loadMeshio(): Promise<MeshioModule> {
  // Reported to the status bar's engine line (engineActivity.ts): the one place
  // every meshio++ read, write and oracle op instantiates the module.
  return trackEngine("meshio", loadMeshioUntracked);
}

async function loadMeshioUntracked(): Promise<MeshioModule> {
  const ns = await namespace();
  const dist = path.join(packageDir(), "dist");
  const overrides = {
    // Name-aware ON PURPOSE: `locateFile` is handed the bare filename of
    // whichever variant the loader picked ("meshioplusplus_wasm_mt.wasm" under
    // Node).  See the module docblock — a fixed path is a hard LinkError.
    locateFile: (name: string) => path.join(dist, path.basename(name)),
    ...extraOverrides,
  };
  if (forceSequential) return ns.loadMeshioPlusPlus(overrides, { variant: "seq" });
  try {
    return await ns.loadMeshioPlusPlus(overrides);
  } catch (e) {
    // An environment that cannot host Wasm threads (no SharedArrayBuffer, a
    // locked-down container) aborts inside the mt glue.  Fall back once and
    // remember the DECISION — never the instance, see the docblock above.
    forceSequential = true;
    try {
      return await ns.loadMeshioPlusPlus(overrides, { variant: "seq" });
    } catch {
      forceSequential = false; // do not poison future loads with a transient failure
      throw e; // the original error is the informative one
    }
  }
}

/** Set once if the auto-selected (threaded) build fails to instantiate. */
let forceSequential = false;

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
export async function readMeshioModel(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string,
  timeStep?: number,
  augment?: (mesh: MeshioMesh, diagnostics: MdpaDiagnostic[]) => void
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

  const m = await loadMeshio();
  const mainPath = stageFiles(m, mainName, files);

  const diagnostics: MdpaDiagnostic[] = [];
  const errors: string[] = [];
  for (const { fmt, lenient } of attempts) {
    try {
      const mesh =
        timeStep === undefined && !lenient
          ? m.readMesh(mainPath, fmt)
          : m.readMeshSelective(mainPath, { format: fmt, timeStep, lenient });
      if (fmt !== candidates[0]) {
        diagnostics.push({
          line: 0,
          message: `Read as "${fmt}" — the default "${candidates[0]}" failed: ${errors[0]}`,
        });
      }
      if (lenient) {
        diagnostics.push({
          line: 0,
          message:
            `Read "${fmt}" leniently — the strict read failed (${errors[errors.length - 1]}). ` +
            `Constructs this reader cannot represent were skipped; the mesh itself is complete.`,
        });
      }
      if (augment) augment(mesh, diagnostics);
      return meshioToModel(mesh, diagnostics);
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

  const m = await loadMeshio();
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
  format?: string
): Promise<number[]> {
  return readMetadataWith(mainName, files, ext, format, (md) => md.timeValues);
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
  format?: string
): Promise<MeshioMetadata> {
  return readMetadataWith(mainName, files, ext, format, (md) => md);
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
}

/**
 * Writes an already-built meshio++ mesh into a scratch MEMFS directory and
 * harvests everything the writer produced. Shared by `writeMeshioBytes` (which
 * converts a model first) and `writeRawMeshioBytes` (which does not).
 */
function writeMeshToBytes(m: MeshioModule, mesh: MeshioMesh, e: string, fmt: string, stemOpt: string | undefined): MeshioWriteResult {
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
  m.writeMesh(`${root}/${name}`, mesh, fmt);
  return { data: m.FS.readFile(`${root}/${name}`) as Uint8Array, companions: harvest(m, root, name) };
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
  opts: { stem?: string } = {}
): Promise<MeshioWriteResult> {
  const m = await loadMeshio();
  return writeMeshToBytes(m, mesh, ext.toLowerCase(), format, opts.stem);
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
export async function writeMeshioBytes(
  model: MdpaModel,
  ext: string,
  opts: {
    format?: string;
    diagnostics?: MdpaDiagnostic[];
    stem?: string;
    onWarning?: (message: string) => void;
  } = {}
): Promise<MeshioWriteResult> {
  const e = ext.toLowerCase();
  const fmt = opts.format ?? MESHIO_WRITE_FORMAT[e];
  if (!fmt) throw new Error(`meshio++ cannot write "${ext}".`);

  const m = await loadMeshio();
  // Exodus is the one format with a home for per-element scalars — everything
  // else it would simply drop. See modelToMeshio's `exodusAttributes`.
  const mesh = modelToMeshio(model, opts.diagnostics ?? [], {
    exodusAttributes: fmt === "exodus",
  });
  const out = writeMeshToBytes(m, mesh, e, fmt, opts.stem);
  if (fmt === "openfoam") {
    // The generic registry writer synthesizes one `defaultFaces` patch; the
    // model's own patch names are recovered onto the companions instead (see
    // `openfoamWrite.ts`). Diagnostics ride both channels the other writers
    // use: the array for headless callers, `onWarning` for the UI/MCP path.
    const rewritten = rewriteOpenFoamPatches(out.companions, model);
    out.companions = rewritten.companions;
    opts.diagnostics?.push(...rewritten.diagnostics);
    for (const d of rewritten.diagnostics) opts.onWarning?.(d.message);
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
 * written against the first step's mesh.
 */
export async function packXdmfSeries(
  steps: PackStep[],
  opts: { stem?: string; onProgress?: (done: number, total: number) => void } = {}
): Promise<PackResult> {
  if (steps.length === 0) throw new Error("No steps to pack.");
  const m = await loadMeshio();
  const stem = memfsStem(opts.stem);
  const name = `${stem}.xdmf`;
  const inRoot = "/mio_in";
  const outRoot = "/mio_out";
  m.FS.mkdirTree(inRoot);
  m.FS.mkdir(outRoot);

  const warnings: string[] = [];
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
      const staged = `${inRoot}/step${i}${extOf(step.name)}`;
      const input = await step.read();
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
          throw new Error(
            `The mesh changes between steps (step 1 has ${grid.points} nodes and ` +
              `${grid.cells} cells, step ${i + 1} has ${points} and ${cells}). ` +
              `An XDMF time series carries one grid for every step, so this ` +
              `series cannot be packed into a single file.`
          );
        }
        writer.writeData(step.time, mesh);
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

  return {
    data: m.FS.readFile(`${outRoot}/${name}`) as Uint8Array,
    companions: harvest(m, outRoot, name),
    steps: written,
    warnings,
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
