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
 * part in time-step grouping, so they fall through to the static path.
 */
export const MESHIO_EXTENSIONS: readonly string[] = MESHIO_READ_EXTENSIONS;

/** Every extension the mesh preview can open. */
export const SUPPORTED_MESH_EXTENSIONS: readonly string[] = [
  ...TIMELINE_EXTENSIONS,
  ...STATIC_EXTENSIONS,
  ...MESHIO_EXTENSIONS,
];
