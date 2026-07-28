/**
 * Supported mesh-preview file extensions, grouped by capability.
 * Pure constants — importable from both fs-using and pure modules.
 */

import { MESHIO_READ_EXTENSIONS } from "./meshioFormats";

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
 * — currently only Exodus). Deliberately NOT part of TIMELINE_EXTENSIONS:
 * that constant drives `groupVtkFiles`'s `<prefix>_<rank>_<step>` FILENAME
 * grammar and the directory-wide watcher glob, neither of which applies here
 * — a single Exodus file holds every step, so vtkEditorProvider drives its
 * timeline off `readMeshTimeSteps`/`ParseMeshOptions.timeStep` instead and
 * watches the one file for changes rather than a directory glob.
 */
export const IN_FILE_TIMELINE_EXTENSIONS: readonly string[] = [".e", ".exo", ".ex2"];

/** Every extension the mesh preview can open. */
export const SUPPORTED_MESH_EXTENSIONS: readonly string[] = [
  ...TIMELINE_EXTENSIONS,
  ...STATIC_EXTENSIONS,
  ...MESHIO_EXTENSIONS,
];
