/**
 * Supported mesh-preview file extensions, grouped by capability.
 * Pure constants — importable from both fs-using and pure modules.
 */

// `meshExtname`/`meshioSiblingNames` are imported (not just re-exported below)
// because timelineKindFor/timelineWatchGlob call them; the `export ... from`
// block creates no local binding, so this is not a duplicate declaration.
import { MESHIO_READ_EXTENSIONS, meshExtname, meshioSiblingNames, meshStem } from "./meshioFormats";

// The compound-extension resolver lives in meshioFormats.ts (the zero-import
// leaf that owns the .post.* registry entries needing it) and is re-exported
// here, where the other extension constants live, so a call site can import
// it alongside them without knowing which module declares it.
export {
  COMPOUND_MESH_EXTENSIONS,
  meshExtname,
  meshStem,
} from "./meshioFormats";

/** VTK XML dataset formats (parsed by vtkXmlParser). */
export const VTK_XML_EXTENSIONS = [".vtu", ".vtp", ".vti", ".vts", ".vtr"] as const;

/** Extensions parsed natively, independently of their timeline capabilities. */
export const NATIVE_MESH_EXTENSIONS: readonly string[] = [
  ".vtk", ...VTK_XML_EXTENSIONS, ".vtm", ".stl", ".obj", ".ply",
  // .pvd (roadmap item 3): a native reader (pvdIndex.ts), never meshio-
  // routed — see meshioFormats.ts's "eight keys deliberately absent" for
  // why pvd/pvtu/pvtp themselves stay unrouted there.
  ".pvd",
];

/** Extended formats read through meshio++. */
export const MESHIO_EXTENSIONS: readonly string[] = MESHIO_READ_EXTENSIONS;

/**
 * meshio++ extensions carrying their own multi-step time series INSIDE one
 * file (meshio++ >= 8.6.0's `ReadOptions.timeStep`/`MeshMetadata.timeValues`
 * — Exodus, GiD postprocess since 10.20.0, and MED/CGNS/Tecplot since the
 * 11.3.0 Tier B1 native metadata readers), plus OpenFOAM, whose steps
 * are numeric time DIRECTORIES beside the marker rather than inside it.
 * Deliberately NOT part of TIMELINE_EXTENSIONS:
 * that constant drives `groupVtkFiles`'s `<prefix>_<rank>_<step>` FILENAME
 * grammar and the directory-wide watcher glob, neither of which applies here
 * — a single Exodus file holds every step, so vtkEditorProvider drives its
 * timeline off `readMeshTimeSteps`/`ParseMeshOptions.timeStep` instead and
 * watches the one file for changes rather than a directory glob. OpenFOAM
 * reuses the same index-plus-label plumbing: `readMeshTimeSteps` lists the
 * numeric directories and `timeStep` selects one for its fields (plus its
 * polyMesh overlay when it has one).
 *
 * `.msh` is NOT here even though a non-default step selects distinctly: its
 * metadata only enumerates sections carrying time tags, and untagged files
 * (like the audit fixture) report no times, so the step count stays
 * undiscoverable before a read. Other audited temporal candidates return no
 * times or cannot select a step. See transientAudit.test.ts
 * and fixtures/transient/README.md for the 12.0.0 live-WASM evidence.
 */
export const IN_FILE_TIMELINE_EXTENSIONS: readonly string[] = [
  ".e",
  ".exo",
  ".ex2",
  // Tier B1 (meshio++ 11.3.0): MED reports the union of every field's step
  // times, CGNS its Base/ZoneIterativeData TimeValues, Tecplot every ZONE's
  // SOLUTIONTIME/STRANDID — all header-only, which is the gate this list
  // expresses. `.dat` shares the tecplot reader with `.tec`.
  ".med",
  ".cgns",
  ".dat",
  ".tec",
  // GiD postprocess joined upstream's step-capable formats in meshio++ 10.20.0:
  // its steps live in the `.post.res` headers and `readMetadata` now reports
  // them as timeValues via a header-only scan. That is precisely the gate this
  // list expresses — a timeline whose length can be known before reading a
  // step — so gid qualifies where MED still does not. Verified against the
  // published 12.0.0 artifact rather than assumed.
  ".post.msh",
  ".post.res",
  ".post.bin",
  ".post.h5",
  // XDMF: `readMeshTimeSteps` counts the `<Time Value>` entries in the light
  // XML itself — a few kilobytes, with the arrays in the sibling `.h5`, and
  // no wasm instance at all. Upstream's own readMetadata reports the same
  // times header-only since the 15.x line (re-measured at 15.4.0: distinct
  // timeValues, fellBackToFullRead false); the native count is kept because
  // it is cheaper, not because upstream cannot answer.
  ".xdmf",
  ".xmf",
  // VTKHDF joined upstream's step-capable formats in meshio++ 14.0.0: a
  // Steps group's own metadata is reported header-only (measured against
  // the live 15.4.0 build with a real multi-step fixture — see
  // fixtures/transient/generate-vtkhdf.mjs — distinct timeValues,
  // fellBackToFullRead false, distinct per-step selection). `.hdf` is
  // upstream's own alternate extension for the same key (meshio++ 15.1.0).
  ".vtkhdf",
  ".hdf",
  // .pvd (roadmap item 3): a NATIVE in-file timeline, not a meshio one —
  // pvdIndex.ts's parsePvdIndex/pvdTimeValues read the light XML directly,
  // the same shape as XDMF's own native count just above. Unlike every
  // other entry in this list, .pvd is ALSO in NATIVE_MESH_EXTENSIONS, which
  // is why TIMELINE_EXTENSIONS now filters that spread too.
  ".pvd",
  // OpenFOAM qualifies through OUR reader too: the steps are numeric time
  // directories (`0`, `0.5`, `1e-3`, …) listed by `listOpenFoamTimes`, and
  // `ParseMeshOptions.timeStep` selects one. The gate — a timeline whose
  // length is knowable before a step is read — is met by a directory listing.
  ".foam",
];

/** Filename series use the existing per-file reader, including its companions.
 * Discovery lists filenames only; mesh bytes are loaded on frame selection.
 * Formats with their own timeline remain exclusively in-file.
 */
export const TIMELINE_EXTENSIONS: readonly string[] = [
  // Both spreads are filtered, not just the meshio one: .pvd (roadmap
  // item 3) is the first NATIVE extension with an in-file timeline of its
  // own, so the earlier "only meshio needs filtering" assumption no longer
  // holds. A no-op for every other native extension today (none of them
  // are in IN_FILE_TIMELINE_EXTENSIONS).
  ...NATIVE_MESH_EXTENSIONS.filter((ext) => !IN_FILE_TIMELINE_EXTENSIONS.includes(ext)),
  ...MESHIO_EXTENSIONS.filter((ext) => !IN_FILE_TIMELINE_EXTENSIONS.includes(ext)),
];

/** Supported preview formats with neither timeline mechanism. */
export const STATIC_EXTENSIONS: readonly string[] = [];

/**
 * Which of the three timeline shapes a mesh path takes.  THE dispatch decision
 * behind the preview's timeline bar and the field-series scan.
 *
 *  - `"in-file"`  — every step lives inside the one file; size it with
 *                   `readMeshTimeSteps` and select with `ParseMeshOptions.timeStep`.
 *  - `"filename"` — the Kratos `<prefix>_<rank>_<step>.<ext>` grammar across
 *                   sibling FILES; size it with `groupVtkFiles`.
 *  - `"static"`   — no timeline; parse the opened file alone.
 *
 * It lives here, pure, rather than as two `includes` chains at each call site,
 * because that is exactly how it drifted: `vtkEditorProvider.discover()` spelled
 * it with `path.extname`, so every GiD `case.post.msh` resolved to `".msh"`,
 * matched neither list, and silently lost BOTH its timeline and its watcher —
 * a shipped, documented feature that could not fire — while `fieldSeriesScan`
 * (on `meshExtname`) got the same question right.  There is no VS Code
 * integration harness in this repo, so a decision made above the vscode line is
 * a decision nothing can test; keeping it here is what makes it assertable.
 *
 * In-file is checked FIRST, matching `discover()`'s own order.  The two lists
 * are disjoint (asserted in meshFormats.test.ts), so that order is
 * documentation rather than a tiebreak — which is what lets one `kind` replace
 * two independent `includes`.  A *runtime* fall-through still remains at the
 * call site: an `"in-file"` file that turns out to hold one step or none is
 * loaded as a static view, since that is a fact about the bytes, not the path.
 */
export type TimelineKind = "in-file" | "filename" | "static";

export function timelineKindFor(fsPath: string): TimelineKind {
  const ext = meshExtname(fsPath);
  if (IN_FILE_TIMELINE_EXTENSIONS.includes(ext)) return "in-file";
  if (TIMELINE_EXTENSIONS.includes(ext)) return "filename";
  return "static";
}

/**
 * The watcher pattern for a mesh, RELATIVE TO ITS DIRECTORY, or `undefined`
 * when a format has no timeline to grow.  Takes a basename — what the provider
 * already holds — since the answer is a directory-relative pattern either way.
 *
 *  - `"filename"`: the whole directory, built FROM `TIMELINE_EXTENSIONS` so it
 *    cannot go stale, so a solver's newly written step files extend the timeline.
 *  - `"in-file"`: the file itself — except GiD ascii, which is a
 *    `.post.msh` (geometry) + `.post.res` (results) pair whose STEPS are
 *    appended to the `.post.res` half.  Watching only an opened `.post.msh`
 *    would build a watcher that never fires. OpenFOAM is the other exception:
 *    the marker never changes, so the timeline watches one level of time
 *    directories (a new step plus the field files inside each step).
 *  - `"static"`: nothing to watch.
 */
export function timelineWatchGlob(fileName: string): string | undefined {
  if (meshExtname(fileName) === ".foam") return "{*,*/*}";
  if (meshExtname(fileName) === ".pvd") {
    // The pieces referenced by a .pvd sit in a "<stem>/" subdirectory next
    // to it (our own writer's own layout — see sequenceExport.ts's
    // packPvdSeries — and the layout upstream's own writer already uses,
    // measured against the live 15.4.0 build). A new piece written under
    // that directory grows the timeline without the .pvd index itself
    // necessarily changing first, so both must be watched, the same
    // two-part shape .foam's own override uses.
    return `{${fileName},${meshStem(fileName)}/**}`;
  }
  switch (timelineKindFor(fileName)) {
    case "filename":
      return `*.{${TIMELINE_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`;
    case "in-file": {
      const pair = meshioSiblingNames(fileName, meshExtname(fileName));
      // `pair` is spelled lowercase; on a case-sensitive filesystem a
      // CASE.POST.MSH would not match it, so fall back to the exact name.
      return pair.length > 1 && pair.includes(fileName) ? `{${pair.join(",")}}` : fileName;
    }
    case "static":
      return undefined;
  }
}

/**
 * An ADDITIONAL directory-relative watch pattern for a format whose BYTES live
 * beside the opened file rather than inside it, or `undefined` for the ordinary
 * case.
 *
 * Deliberately a separate question from `timelineWatchGlob`, which asks "can
 * this grow more steps?" — this one asks "can this file's content change
 * without the file itself changing?".  `.foam` is the only format where the
 * answer is yes: the opened file is a 0-byte marker whose mesh is really
 * `constant/polyMesh/`, so re-running `blockMesh` leaves the marker's mtime
 * untouched and nothing keyed on it would ever notice.  The `*` covers the
 * `.gz` variants a `writeCompression on` case writes.
 */
export function contentWatchGlob(fileName: string): string | undefined {
  return meshExtname(fileName) === ".foam" ? "constant/polyMesh/*" : undefined;
}

/**
 * meshio++ extensions whose `readMetadata` stays header-only
 * (`fellBackToFullRead: false`) — the only formats a "fast" metadata path may
 * serve. Measured per format against the published 12.0.0 artifact
 * (src/test/meshio.test.ts pins the table) rather than read off the `.d.ts`:
 * Exodus/medit/abaqus/nastran/su2/unv still fall back to a full read
 * (MED/CGNS/Tecplot stopped falling back with the 11.3.0 native metadata
 * readers), so serving those as "header-only" would charge full-parse cost at
 * header price. Deliberately meshio-routed extensions only: `.vtu`/`.vtk`/`.vtp`
 * have header-capable meshio readers too, but this extension parses those
 * natively (no read candidates are registered for them), so no fast path can
 * reach them. Native header paths additionally report no bbox and no regions
 * (upstream maps none there) — absent, never null, so "not computed" cannot
 * be misread as a box at the origin or an empty group set. `.vtkhdf`/`.hdf`
 * joined at the 15.4.0 bump (roadmap item 3), re-measured the same way
 * (fixtures/transient/generate-vtkhdf.mjs).
 */
export const HEADER_METADATA_EXTENSIONS: readonly string[] = [
  ".xdmf",
  ".xmf",
  ".msh",
  ".med",
  ".cgns",
  ".dat",
  ".tec",
  ".post.msh",
  ".post.res",
  ".post.bin",
  ".post.h5",
  ".vtkhdf",
  ".hdf",
];

/** Every extension the mesh preview can open. */
export const SUPPORTED_MESH_EXTENSIONS: readonly string[] = [
  ...NATIVE_MESH_EXTENSIONS,
  ...MESHIO_EXTENSIONS,
];
