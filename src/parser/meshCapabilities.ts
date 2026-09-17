/**
 * The meshio++ capability inventory: what the installed WASM build can read,
 * write, select and enumerate, plus which of it this extension routes.
 *
 * No vscode / DOM imports, so it stays Node-testable and MCP-reachable. This
 * is the headless query roadmap Tier 1 item 1 asks for: instead of scattering
 * "is X supported?" across format tables and test pins, one call answers from
 * the LIVE artifact (readers/writers/options-awareness/backend/cgnslib) next
 * to the static routing tables that decide what the extension does with them.
 */

import { loadMeshio, meshioPackageVersion } from "./meshio";
import {
  HEADER_METADATA_EXTENSIONS,
  IN_FILE_TIMELINE_EXTENSIONS,
  SUPPORTED_MESH_EXTENSIONS,
  TIMELINE_EXTENSIONS,
} from "./meshFormats";
import {
  MESHIO_EXPORT_EXTENSIONS,
  MESHIO_LENIENT_RETRY_FORMATS,
  MESHIO_READ_CANDIDATES,
  MESHIO_READER_KEYS,
  MESHIO_WRITER_KEYS,
  MESHIO_WRITE_FORMAT,
} from "./meshioFormats";

/** One routed reader key and what the live build says about it. */
export interface MeshCapabilityReader {
  /** meshio++ format key, e.g. `"exodus"`. */
  key: string;
  /** Extensions routed to it, default first (MESHIO_READ_CANDIDATES). */
  extensions: string[];
  /** Whether `readMeshSelective` options (timeStep/lenient) reach it. */
  optionsAware: boolean;
}

/** What `getMeshCapabilities` reports. Plain JSON — no BigInt, no Maps. */
export interface MeshCapabilities {
  /** Installed `@meshioplusplus/wasm` version, when its package.json is found. */
  packageVersion?: string;
  /** Sequential or threaded build actually instantiated (`parallelBackend`). */
  backend: string;
  /** Whether ADF containers / CGNS 3.x layouts are reachable (`hasCgnslib`). */
  hasCgnslib: boolean;
  /** Format keys the live build reports (availableFormats). */
  live: { readers: string[]; writers: string[] };
  /** Reader keys this extension routes, with their extensions and options-awareness. */
  readers: MeshCapabilityReader[];
  /** Reader keys the live build reports that nothing here routes to, and why. */
  unroutedReaders: { key: string; reason: string }[];
  /** Extension -> explicit write format key (MESHIO_WRITE_FORMAT). */
  writers: Record<string, string>;
  /** Extensions the extension can open / export (native + meshio). */
  extensions: { supported: string[]; exportable: string[] };
  /** In-file (single-file time series) vs filename-grammar timeline extensions. */
  timelines: { inFile: string[]; filename: string[] };
  /** Extensions whose readMetadata stays header-only (the metadataOnly gate). */
  headerMetadata: string[];
  /** Formats retried leniently before the next read candidate. */
  lenientRetry: string[];
}

/** Keys the live build reports that this extension deliberately does not route. */
const UNROUTED_READER_REASONS: Record<string, string> = {
  mdpa: "parsed natively everywhere, never routed through meshio++",
  gmsh22: "write-only MSH 2.2 alias; .msh writes 4.1",
  vti: "read natively by vtkXmlParser; the writer needs a dense lattice",
  vts: "read natively by vtkXmlParser; the writer needs a dense lattice",
  vtr: "read natively by vtkXmlParser; the writer needs a uniform lattice",
  vtm: "read/written natively by vtkMultiblock/vtmWriter; a multi-file index the single-path contract cannot express",
};

export async function getMeshCapabilities(): Promise<MeshCapabilities> {
  const m = await loadMeshio();
  const live = m.availableFormats();
  // Both directions: `svg`/`tikz` are write-only figure formats with no read
  // candidate, and `gmsh22` is a write-only alias — readers alone miss them.
  const routed = [
    ...new Set([
      ...Object.values(MESHIO_READ_CANDIDATES).flat(),
      ...Object.values(MESHIO_WRITE_FORMAT),
    ]),
  ].sort();
  const readers: MeshCapabilityReader[] = routed.map((key) => {
    let optionsAware = false;
    try {
      optionsAware = m.readerSupportsOptions(key);
    } catch {
      /* a key the build does not know answers false by refusing */
    }
    return {
      key,
      extensions: Object.entries(MESHIO_READ_CANDIDATES)
        .filter(([, keys]) => keys.includes(key))
        .map(([ext]) => ext),
      optionsAware,
    };
  });
  // Union of both directions: `gmsh22` is write-only, so readers alone miss it.
  const unroutedReaders = [...new Set([...live.readers, ...live.writers])]
    .filter((key) => !routed.includes(key))
    .sort()
    .map((key) => ({
      key,
      reason: UNROUTED_READER_REASONS[key] ?? "not routed by this extension",
    }));
  return {
    ...(meshioPackageVersion() ? { packageVersion: meshioPackageVersion() as string } : {}),
    backend: m.parallelBackend(),
    hasCgnslib: m.hasCgnslib(),
    live: { readers: [...live.readers].sort(), writers: [...live.writers].sort() },
    readers,
    unroutedReaders,
    writers: { ...MESHIO_WRITE_FORMAT },
    extensions: {
      supported: [...SUPPORTED_MESH_EXTENSIONS],
      exportable: [...MESHIO_EXPORT_EXTENSIONS],
    },
    timelines: {
      inFile: [...IN_FILE_TIMELINE_EXTENSIONS],
      filename: [...TIMELINE_EXTENSIONS],
    },
    headerMetadata: [...HEADER_METADATA_EXTENSIONS],
    lenientRetry: [...MESHIO_LENIENT_RETRY_FORMATS],
  };
}

/** The static half, for tests that must not instantiate WASM. */
export function routedReaderKeys(): string[] {
  return [...new Set(Object.values(MESHIO_READ_CANDIDATES).flat())].sort();
}

/** Re-exported so capability consumers import from one module. */
export { MESHIO_READER_KEYS, MESHIO_WRITER_KEYS };
