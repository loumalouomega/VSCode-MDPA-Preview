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
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { MeshioMesh, meshioToModel, modelToMeshio } from "./meshioConvert";
import { MESHIO_READ_CANDIDATES, MESHIO_WRITE_FORMAT } from "./meshioFormats";
import { MdpaDiagnostic, MdpaModel } from "./types";

/** The subset of the Emscripten module we use. */
interface MeshioModule {
  FS: {
    writeFile(p: string, data: Uint8Array | string): void;
    readFile(p: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string;
    readdir(p: string): string[];
  };
  readMesh(p: string, format?: string): MeshioMesh;
  writeMesh(p: string, mesh: MeshioMesh, format?: string): void;
}

interface MeshioNamespace {
  loadMeshioPlusPlus(overrides?: Record<string, unknown>): Promise<MeshioModule>;
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
  const wasm = path.join(packageDir(), "dist", "meshioplusplus_wasm.wasm");
  return ns.loadMeshioPlusPlus({ locateFile: () => wasm, ...extraOverrides });
}

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
 */
export async function readMeshioModel(
  mainName: string,
  files: MeshioInputFile[],
  ext: string,
  format?: string
): Promise<MdpaModel> {
  const candidates = format ? [format] : MESHIO_READ_CANDIDATES[ext.toLowerCase()] ?? [];
  if (candidates.length === 0) {
    throw new Error(`No meshio++ reader is registered for "${ext}".`);
  }

  const m = await loadMeshio();
  for (const f of files) m.FS.writeFile(`/${f.name}`, f.data);

  const diagnostics: MdpaDiagnostic[] = [];
  const errors: string[] = [];
  for (const fmt of candidates) {
    try {
      const mesh = m.readMesh(`/${mainName}`, fmt);
      if (fmt !== candidates[0]) {
        diagnostics.push({
          line: 0,
          message: `Read as "${fmt}" — the default "${candidates[0]}" failed: ${errors[0]}`,
        });
      }
      return meshioToModel(mesh, diagnostics);
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
  const mesh = modelToMeshio(model, opts.diagnostics ?? []);
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
