/**
 * The meshio++ capability inventory: what the installed WASM build can read,
 * write, select and enumerate, plus which of it this extension routes.
 *
 * No vscode / DOM imports, so it stays Node-testable and MCP-reachable. This
 * is the headless query roadmap Tier 1 item 1 asks for: instead of scattering
 * "is X supported?" across format tables and test pins, one call answers from
 * the LIVE artifacts — both of them, since 17.2.0 ships a full OCCT/zstd/lz4/
 * bzip2 artifact beside the lean one (readers/writers/options-awareness/
 * flavour/backend/cgnslib) — next to the static routing tables that decide
 * what the extension does with them.
 */

import { ADOPTING_OPS } from "./adoptingOps";
import { exportFidelityCapabilities, ExportFidelityCapabilities } from "./exportReport";
import { loadMeshio, loadMeshioFull, meshioFullInstalled, meshioPackageVersion } from "./meshio";
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
  MESHIO_ID_KEY,
  MESHIO_KIND_KEY,
  MESHIO_PROPERTY_KEY,
  MESHIO_PART_PREFIX,
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
  namedWriters: string[];
  operations: { available: string[]; unavailable: { name: string; reason: string }[] };
  /** Sequential or threaded build actually instantiated (`parallelBackend`). */
  backend: string;
  /**
   * The LIVE build's flavour ("lean" here) and the optional native libraries
   * it links (`buildFlavour`/`hasOcct`/`hasZstd`/`hasLz4`/`hasBzip2`,
   * meshio++ >= 17.0.0). All four libraries are false on the lean build.
   */
  build: {
    flavour: string;
    occt: boolean;
    zstd: boolean;
    lz4: boolean;
    bzip2: boolean;
    /** KaHIP partitioner linked (meshio++ >= 17.9.0): false on the lean build. */
    kahip: boolean;
  };
  /**
   * The FULL artifact shipped beside the lean one since 17.2.0 (OpenCASCADE,
   * zstd, lz4, bzip2; mixed licence — see the package's THIRD_PARTY_NOTICES).
   * `installed` is the file-system fact; `build` is a SECOND live
   * instantiation, present only when it loaded, and `error` says why not when
   * it did not. The step/iges reads, fitCad and the zstd/lz4/bzip2 fallbacks
   * run on it (see meshFileParser.ts).
   */
  full: {
    installed: boolean;
    build?: {
      flavour: string;
      backend: string;
      occt: boolean;
      zstd: boolean;
      lz4: boolean;
      bzip2: boolean;
      kahip: boolean;
      readers: string[];
      writers: string[];
    };
    error?: string;
  };
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
  /**
   * The explicit fidelity adapter (meshioFidelity.ts) — what a meshio++
   * operation's result can be reconstructed into via carry -> op -> adopt,
   * and what it cannot. Static data (no wasm call needed for it), published
   * here so it reaches the same headless query as everything else.
   */
  fidelity: MeshFidelityCapabilities;
  /**
   * What each WRITER did with the reference mesh when it was measured
   * (former roadmap item 6): per category retained/transformed/omitted, or why the
   * writer could not be measured. The same table the export report reads, so an
   * agent can ask before writing what a format will keep.
   */
  exportFidelity: ExportFidelityCapabilities;
  /**
   * Which partitioners the LIVE build can actually run (probed with a two-cell
   * mesh, not assumed): `sfc` runs on the lean artifact; `kahip` (meshio++ >=
   * 17.9.0) only on the full one, which `backends` names per method. When the
   * full artifact is absent `kahip` is unavailable with the refusal's own
   * reason. `auto` is whichever of the two is best here (measured: on the full
   * artifact it returns KaHIP's labels, not the curve's).
   */
  partitioning: {
    available: string[];
    unavailable: { method: string; reason: string }[];
    backends: Record<string, "lean" | "full">;
  };
}

/** One fidelity-carrier array the adapter can emit, and what it recovers. */
export interface MeshFidelityCarrier {
  key: string;
  scope: "point" | "cell";
  recovers: string;
  /** True for the two carriers that are meshio++'s OWN MDPA convention, not this extension's. */
  upstreamConvention: boolean;
}

export interface MeshFidelityCapabilities {
  carriers: MeshFidelityCarrier[];
  /** The SubModelPart region-name prefix the carry path uses (meshioConvert.ts's buildRegions). */
  partRegionPrefix: string;
  /** Which MdpaModel slots survive a carry -> op -> adopt round trip, and how. */
  slots: Record<
    "nodeIds" | "entityIds" | "entityKinds" | "propertyIds" | "properties" | "subModelParts" | "constraints" | "blockNames" | "fieldFixedFlags",
    "carried" | "reconstructed" | "lost"
  >;
  /**
   * Whether `adoptMeshioMesh` can reconstruct at all: it falls back to the
   * plain read path (synthesized ids, everything "Elements") for a result
   * containing a ragged (polygon/polyhedron) cell block.
   */
  raggedCellBlocksSupported: boolean;
  /** Operations whose result is adopted through this adapter (see adoptingOps.ts). */
  adoptingOperations: string[];
}

/**
 * The reason a key the live build reports is NOT routed to by extension.
 * An unrouted key with no entry here falls back to a generic sentence, and
 * `mcpTools.test.ts` asserts that no key is left on that fallback — so a new
 * upstream format fails a test here until somebody says which of these it is.
 */
const UNROUTED_READER_REASONS: Record<string, string> = {
  mdpa: "parsed natively everywhere, never routed through meshio++",
  gmsh22: "write-only MSH 2.2 alias; .msh writes 4.1",
  vti: "read natively by vtkXmlParser; the writer needs a dense lattice",
  vts: "read natively by vtkXmlParser; the writer needs a dense lattice",
  vtr: "read natively by vtkXmlParser; the writer needs a uniform lattice",
  // The six formats we parse and write with our OWN parsers, which upstream
  // also happens to link. They are in MESHIO_READER_KEYS only because that
  // table is the MCP `inputFormat` enum's vocabulary and it is checked as a
  // superset of what we route — routing one of these to meshio++ would be a
  // REGRESSION, since our readers carry what meshio++ drops (OBJ g/o groups,
  // PLY vertex fields, VTK appended data and multiblock).
  obj: "parsed natively (OBJ g/o groups); routing it to meshio++ would lose them",
  ply: "parsed natively (PLY vertex properties become Nodal fields); meshio++ drops them",
  stl: "parsed natively (binary + ascii detection); ours stays authoritative",
  vtk: "parsed natively (legacy VTK, incl. binary); ours stays authoritative",
  vtp: "parsed AND written natively (vtkXmlWriter/vtmWriter); meshio++'s vtp writer is not routed",
  vtu: "parsed natively (VTK XML, incl. appended data and multiple pieces); ours stays authoritative",
  vtm: "read/written natively by vtkMultiblock/vtmWriter; a multi-file index the single-path contract cannot express",
  pvd: "read natively instead (pvdIndex.ts, roadmap item 3): each step is an ordinary .vtu/.vtp, already owned by our own readers",
  // The four name-matched result readers (16.14.0). Upstream finds these by
  // FILE NAME, not by extension, so no extension this extension offers can
  // select them — each stays reachable through an explicit MCP `inputFormat`
  // (which MESHIO_READER_KEYS gates) and is a reader key, just not a
  // candidate. `ansys_rst_cyclic` has a second reason: it reads a cyclic
  // model's FULL ROTOR where `ansys_rst` reads one sector, so making it an
  // automatic `.rst` retry would silently change what a plain `.rst` means.
  ansys_rst_cyclic:
    "found by file name, not extension; also a DIFFERENT read of the same .rst (the full rotor of a cyclic model), so it must not become an automatic retry — reach it with an explicit inputFormat",
  lsdyna_binout:
    "found by file name (`binout`, `binout0000`, …) with no extension; reach it with an explicit inputFormat",
  radioss_anim:
    "found by file name (`<stem>A001`, …) with no extension; reach it with an explicit inputFormat",
  radioss_th:
    "found by file name (`<stem>T01`, …) with no extension; reach it with an explicit inputFormat",
  // `neuroglancer` (17.3.0: native in the shared registry, both directions):
  // the precomputed format is a DIRECTORY of sharded chunks addressed by an
  // index, not a file — no extension this extension offers can select it, and
  // neither the single-file read staging nor the single-path write contract
  // can express it. Deliberately absent from both routing tables, on purpose.
  neuroglancer:
    "a precomputed segment directory, not a file; nothing routes to it",

};

/**
 * The reason a key carries when UNROUTED_READER_REASONS has nothing to say
 * about it. Exported so the test that guards the table asserts against this
 * exact string rather than a hand-copied literal that could drift.
 *
 * This exists because the previous fallback, "not routed by this extension",
 * read like a decision and was not one: a newly published upstream format
 * landed in `unroutedReaders` silently, every assertion still passed, and the
 * key was simply unavailable. A key now has to be examined and named.
 */
export const UNEXAMINED_REASON = "UNEXAMINED: no routing decision recorded";

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
      // A key with no entry above is a GAP in that table, not a legitimate
      // "we chose not to" — so the fallback is a distinctive string on
      // purpose, and mcpTools.test.ts refuses it.
      reason: UNROUTED_READER_REASONS[key] ?? UNEXAMINED_REASON,
    }));
  return {
    ...(meshioPackageVersion() ? { packageVersion: meshioPackageVersion() as string } : {}),
    backend: m.parallelBackend(),
    build: {
      flavour: m.buildFlavour(),
      occt: m.hasOcct(),
      kahip: m.hasKahip(),
      zstd: m.hasZstd(),
      lz4: m.hasLz4(),
      bzip2: m.hasBzip2(),
    },
    full: await probeFullArtifact(),
    hasCgnslib: m.hasCgnslib(),
    live: { readers: [...live.readers].sort(), writers: [...live.writers].sort() },
    readers,
    unroutedReaders,
    writers: { ...MESHIO_WRITE_FORMAT },
    namedWriters: [...MESHIO_WRITER_KEYS],
    operations: { available: ["featureEdges", "hausdorff", "qualityGate", "periodicNodes", "regionAlgebra", "resampleSequence"], unavailable: [
      { name: "agglomerate", reason: "Polyhedral output cannot be preserved by the editable model." },
      { name: "segment (method: primitive)", reason: "Primitive-aware patch segmentation (17.9.0): segment itself is an interactive op with no adopting adapter here yet; fitCad self-segments." },
      { name: "generators (rectangle, box, disk, uvSphere, icosaSphere, cylinder, referenceCells)", reason: "Procedural mesh generators (17.9.0): a new-mesh feature, not an edit of the open one; no entry point or Kratos naming decision yet." },
      { name: "octree", reason: "Adaptive octree/hex mesh generation around a skin (17.8.0): no fidelity-checked adapter, field transfer or Kratos-semantics review yet." },
      { name: "retagRegions", reason: "SubModelParts do not retain native region tags or side selectors." }
    ] },
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
    fidelity: FIDELITY_CAPABILITIES,
    exportFidelity: exportFidelityCapabilities(),
    partitioning: await probePartitioners(m),
  };
}

/**
 * The second, FULL artifact: reported separately from the lean live build
 * because it is a separate instantiation. `installed` never loads (see
 * meshioFullInstalled); everything else is one real load, released when the
 * call returns like every `loadMeshio` call. A full artifact that is installed
 * but cannot instantiate is reported with the error rather than hidden.
 */
async function probeFullArtifact(): Promise<MeshCapabilities["full"]> {
  if (!meshioFullInstalled()) return { installed: false };
  try {
    const fm = await loadMeshioFull();
    const live = fm.availableFormats();
    return {
      installed: true,
      build: {
        flavour: fm.buildFlavour(),
        backend: fm.parallelBackend(),
        occt: fm.hasOcct(),
        zstd: fm.hasZstd(),
        lz4: fm.hasLz4(),
        bzip2: fm.hasBzip2(),
        kahip: fm.hasKahip(),
        readers: [...live.readers].sort(),
        writers: [...live.writers].sort(),
      },
    };
  } catch (e) {
    return { installed: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Runs each partitioner on a two-triangle mesh. The lean build is asked first;
 * a method it refuses is retried on the full artifact when that is installed
 * (one extra instantiation, only while `kahip` is unavailable on lean), and the
 * backend that served it is recorded. A method no installed artifact can run
 * is unavailable with the refusal's own reason.
 */
async function probePartitioners(m: Awaited<ReturnType<typeof loadMeshio>>): Promise<MeshCapabilities["partitioning"]> {
  const mesh = {
    dim: 3,
    points: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    cells: [{ type: "triangle", nodesPerCell: 3, data: new Int32Array([0, 1, 2, 0, 2, 3]) }],
    point_data: {},
    cell_data: {},
    field_data: {},
  } as unknown as Parameters<typeof m.partitionLabels>[0];
  const available: string[] = [];
  const unavailable: { method: string; reason: string }[] = [];
  const backends: Record<string, "lean" | "full"> = {};
  let full: Awaited<ReturnType<typeof loadMeshioFull>> | undefined;
  for (const method of ["sfc", "kahip"]) {
    try {
      m.partitionLabels(mesh, 2, method);
      available.push(method);
      backends[method] = "lean";
      continue;
    } catch (err) {
      const leanReason = err instanceof Error ? err.message : String(err);
      if (!meshioFullInstalled()) {
        unavailable.push({ method, reason: leanReason });
        continue;
      }
      try {
        full ??= await loadMeshioFull();
        full.partitionLabels(mesh, 2, method);
        available.push(method);
        backends[method] = "full";
      } catch (err2) {
        unavailable.push({ method, reason: err2 instanceof Error ? err2.message : String(err2) });
      }
    }
  }
  return { available, unavailable, backends };
}

/** Static — no wasm call needed — so it is defined once at module scope. */
const FIDELITY_CAPABILITIES: MeshFidelityCapabilities = {
  carriers: [
    { key: MESHIO_ID_KEY, scope: "point", recovers: "node ids", upstreamConvention: true },
    { key: MESHIO_ID_KEY, scope: "cell", recovers: "entity ids (per kind)", upstreamConvention: true },
    { key: MESHIO_KIND_KEY, scope: "cell", recovers: "Elements/Conditions/Geometries", upstreamConvention: false },
    { key: MESHIO_PROPERTY_KEY, scope: "cell", recovers: "propertyIds", upstreamConvention: true },
  ],
  partRegionPrefix: MESHIO_PART_PREFIX,
  slots: {
    nodeIds: "carried",
    entityIds: "carried",
    entityKinds: "carried",
    propertyIds: "carried",
    properties: "carried",
    subModelParts: "carried",
    constraints: "reconstructed",
    blockNames: "lost",
    fieldFixedFlags: "lost",
  },
  raggedCellBlocksSupported: false,
  adoptingOperations: [...ADOPTING_OPS],
};

/** The static half, for tests that must not instantiate WASM. */
export function routedReaderKeys(): string[] {
  return [...new Set(Object.values(MESHIO_READ_CANDIDATES).flat())].sort();
}

/** Re-exported so capability consumers import from one module. */
export { MESHIO_READER_KEYS, MESHIO_WRITER_KEYS };
