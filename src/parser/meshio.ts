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

import { MeshioMesh, meshioToModel, modelToMeshio } from "./meshioConvert";
import {
  MESHIO_LENIENT_RETRY_FORMATS,
  MESHIO_READ_CANDIDATES,
  MESHIO_WRITE_FORMAT,
} from "./meshioFormats";
// The same relative-path guard the problem-archive extractor applies to a zip
// entry: a companion's name is likewise joined onto a real destination folder.
import { isSafeEntryName } from "./problemZip";
import { MdpaDiagnostic, MdpaModel } from "./types";

/** The `readMetadata` shape this module actually reads (a subset of MeshMetadata). */
export interface MeshioMetadata {
  /** The file's time-series values (from meshio++ >= 8.6.0); empty for a format with no time concept. */
  timeValues: number[];
}

/** The subset of the Emscripten module we use. */
interface MeshioModule {
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
  writeMesh(p: string, mesh: MeshioMesh, format?: string): void;
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
   * since 9.22.0 and still does at 10.20.2 — but meshio.test.ts asserts it,
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

  /** Part index per cell, one array per cell block, block-aligned. */
  partitionLabels(
    mesh: MeshioMesh,
    nparts: number,
    method?: string,
    imbalance?: number,
    mode?: string,
    seed?: number,
    weightsKey?: string
  ): number[][];

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
}

/**
 * One integrated quantity, as `dataIntegrate` actually reports it (measured
 * against the live 10.20.2 artifact rather than transcribed from the docs).
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
export async function loadMeshio(): Promise<MeshioModule> {
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
  /** Basename — MEMFS is flat and several readers inspect their own extension. */
  name: string;
  data: Uint8Array;
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
 * `timeStep` selects a step of a multi-step file (meshio++ >= 8.6.0; Exodus
 * is currently the only format whose time series can be SIZED before a read —
 * MED honours a step too, but has no metadata reader, so `readMeshioTimeValues`
 * returns nothing for it and no timeline can be built). 0 is the first step
 * — omitting `timeStep` and passing 0 are equivalent, both routing through
 * `readMeshSelective` rather than `readMesh` once any candidate needs it. An
 * out-of-range step throws (surfaced verbatim; meshio++'s message already
 * names the available count).
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
  timeStep?: number
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
  for (const f of files) m.FS.writeFile(`/${f.name}`, f.data);

  const diagnostics: MdpaDiagnostic[] = [];
  const errors: string[] = [];
  for (const { fmt, lenient } of attempts) {
    try {
      const mesh =
        timeStep === undefined && !lenient
          ? m.readMesh(`/${mainName}`, fmt)
          : m.readMeshSelective(`/${mainName}`, { format: fmt, timeStep, lenient });
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
      return meshioToModel(mesh, diagnostics);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const detail = attempts
    .map((a, i) => `  ${a.fmt}${a.lenient ? " (lenient)" : ""}: ${errors[i]}`)
    .join("\n");
  throw new Error(`Could not read "${mainName}" as ${candidates.join(" / ")}:\n${detail}`);
}

/**
 * The time-series values a multi-step file carries (meshio++ >= 8.6.0's
 * `MeshMetadata.timeValues`); empty for a format with no time concept.  Used to
 * size and label the in-file timeline — see `IN_FILE_TIMELINE_EXTENSIONS` in
 * meshFormats.ts.
 *
 * Exodus and GiD postprocess are the formats this reports anything for — gid
 * joined upstream's step-capable metadata readers in meshio++ 10.20.0, via a
 * header-only scan of the `.post.res` that skips every Values body.  MED honours a
 * `timeStep` on READ since meshio++ 9.9.0, but is not one of upstream's
 * metadata readers, so its `timeValues` comes back empty (measured at 9.9.0) —
 * a MED step count is only discoverable by trying one and catching the throw,
 * which is why MED stays out of `IN_FILE_TIMELINE_EXTENSIONS`.
 */
export async function readMeshioTimeValues(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string
): Promise<number[]> {
  const candidates = format ? [format] : MESHIO_READ_CANDIDATES[ext.toLowerCase()] ?? [];
  if (candidates.length === 0) {
    throw new Error(`No meshio++ reader is registered for "${ext}".`);
  }

  const m = await loadMeshio();
  for (const f of files) m.FS.writeFile(`/${f.name}`, f.data);

  const errors: string[] = [];
  for (const fmt of candidates) {
    try {
      return m.readMetadata(`/${mainName}`, fmt).timeValues;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const detail = candidates.map((f, i) => `  ${f}: ${errors[i]}`).join("\n");
  throw new Error(`Could not read "${mainName}" as ${candidates.join(" / ")}:\n${detail}`);
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
  opts: { format?: string; diagnostics?: MdpaDiagnostic[]; stem?: string } = {}
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
  // A real extension plus an explicit format key: never ambiguous.
  const stem = memfsStem(opts.stem);
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

  return { data: m.FS.readFile(`${root}/${name}`) as Uint8Array, companions };
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
