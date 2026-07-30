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
 * Exodus is still the only format this reports anything for.  MED honours a
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
  /** Basename, exactly as the main file references it. */
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
 * Some writers emit MORE than the file they were handed — since meshio++ 8.0.0
 * the XDMF writer puts the heavy arrays in a companion `<stem>.h5` and leaves
 * only `<stem>.h5:/data0` references in the XML, so returning the XML alone
 * would write a dangling file.  The MEMFS name therefore carries the caller's
 * `stem` (the XML embeds it verbatim), and everything the writer left behind is
 * returned so the caller can write it beside the destination.
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
  const before = new Set(m.FS.readdir("/"));
  m.writeMesh(`/${name}`, mesh, fmt);

  const companions: MeshioCompanionFile[] = [];
  for (const entry of m.FS.readdir("/")) {
    if (entry === name || before.has(entry)) continue;
    companions.push({ name: entry, data: m.FS.readFile(`/${entry}`) as Uint8Array });
  }
  return { data: m.FS.readFile(`/${name}`) as Uint8Array, companions };
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
