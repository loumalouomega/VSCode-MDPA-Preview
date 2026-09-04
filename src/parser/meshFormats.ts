/**
 * Supported mesh-preview file extensions, grouped by capability.
 * Pure constants — importable from both fs-using and pure modules.
 */

import { MESHIO_READ_EXTENSIONS } from "./meshioFormats";

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

/**
 * Extensions that participate in Kratos-style time-step grouping
 * (`<prefix>_<rank>_<step>.<ext>`) and the timeline bar.
 */
export const TIMELINE_EXTENSIONS: readonly string[] = [
  ".vtk",
  ...VTK_XML_EXTENSIONS,
  ".vtm",
];

/** Extensions always opened as a single static view (no grouping). */
export const STATIC_EXTENSIONS: readonly string[] = [".stl", ".obj", ".ply"];

/**
 * Extended formats read through meshio++ (see meshioFormats.ts).  None take
 * part in Kratos-style filename time-step grouping, so they fall through to
 * the static path — EXCEPT the extensions in IN_FILE_TIMELINE_EXTENSIONS
 * below, which get a different kind of timeline (steps inside one file).
 */
export const MESHIO_EXTENSIONS: readonly string[] = MESHIO_READ_EXTENSIONS;

/**
 * meshio++ extensions carrying their own multi-step time series INSIDE one
 * file (meshio++ >= 8.6.0's `ReadOptions.timeStep`/`MeshMetadata.timeValues`
 * — Exodus, and GiD postprocess since 10.20.0). Deliberately NOT part of TIMELINE_EXTENSIONS:
 * that constant drives `groupVtkFiles`'s `<prefix>_<rank>_<step>` FILENAME
 * grammar and the directory-wide watcher glob, neither of which applies here
 * — a single Exodus file holds every step, so vtkEditorProvider drives its
 * timeline off `readMeshTimeSteps`/`ParseMeshOptions.timeStep` instead and
 * watches the one file for changes rather than a directory glob.
 *
 * `.med` is NOT here even though its reader honours `timeStep` since meshio++
 * 9.9.0: this list gates `readMeshTimeSteps`, and MED is not one of upstream's
 * metadata readers, so its step count is undiscoverable without reading a step
 * and catching the throw.  A timeline whose length cannot be known cannot be
 * drawn.  (A `timeStep` passed explicitly — the MCP `mesh_info`/`mesh_convert`
 * argument — does reach a MED read regardless of this list.)
 */
export const IN_FILE_TIMELINE_EXTENSIONS: readonly string[] = [
  ".e",
  ".exo",
  ".ex2",
  // GiD postprocess joined upstream's step-capable formats in meshio++ 10.20.0:
  // its steps live in the `.post.res` headers and `readMetadata` now reports
  // them as timeValues via a header-only scan. That is precisely the gate this
  // list expresses — a timeline whose length can be known before reading a
  // step — so gid qualifies where MED still does not. Verified against the
  // published 10.20.2 artifact rather than assumed.
  ".post.msh",
  ".post.res",
  ".post.bin",
  ".post.h5",
];

/**
 * meshio++ extensions whose `readMetadata` stays header-only
 * (`fellBackToFullRead: false`) — the only formats a "fast" metadata path may
 * serve. Measured per format against the published 10.20.2 artifact
 * (src/test/meshio.test.ts pins the table) rather than read off the `.d.ts`:
 * Exodus/MED/CGNS/medit/abaqus/nastran/su2/unv all fall back to a full read,
 * so serving them as "header-only" would charge full-parse cost at header
 * price. Deliberately meshio-routed extensions only: `.vtu`/`.vtk`/`.vtp`
 * have header-capable meshio readers too, but this extension parses those
 * natively (no read candidates are registered for them), so no fast path can
 * reach them. Native header paths additionally report no bbox and no regions
 * (upstream maps none there) — absent, never null, so "not computed" cannot
 * be misread as a box at the origin or an empty group set.
 */
export const HEADER_METADATA_EXTENSIONS: readonly string[] = [
  ".xdmf",
  ".xmf",
  ".msh",
  ".post.msh",
  ".post.res",
  ".post.bin",
  ".post.h5",
];

/** Every extension the mesh preview can open. */
export const SUPPORTED_MESH_EXTENSIONS: readonly string[] = [
  ...TIMELINE_EXTENSIONS,
  ...STATIC_EXTENSIONS,
  ...MESHIO_EXTENSIONS,
];
