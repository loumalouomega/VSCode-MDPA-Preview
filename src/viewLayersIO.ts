/**
 * Host-side persistence for user layers.
 *
 * The `<stem>.kratosview.json` sidecar lives beside the mesh (see
 * `caseFile.ts`'s `viewFilePath`, the one authority for where sidecars live).
 * Reads are tolerant — a missing, malformed or newer-version file yields an
 * empty list with warnings, leaving the mesh with its ordinary sections.
 * Writes carry only the view annotation; they never touch the mesh bytes, the
 * operation history or the dirty marker.
 *
 * Host-only (node:fs/path): the webview never imports this module. It speaks
 * the pure `parser/userLayers.ts` shapes over `postMessage`.
 */

import * as fs from "node:fs";

import { OutlineViewSettings, validateOutlineView } from "./parser/outlineView";
import { UserLayer, parseViewSidecar, serializeViewSidecar, validateUserLayers } from "./parser/userLayers";
import { viewFilePath } from "./problemtype/caseFile";

/** Loads the sidecar for `meshFsPath`; missing/unreadable → empty + warning. `outline` is present only when the file carries it. */
export function loadViewLayers(meshFsPath: string): {
  layers: UserLayer[];
  warnings: string[];
  outline?: OutlineViewSettings;
} {
  let text: string;
  try {
    text = fs.readFileSync(viewFilePath(meshFsPath), "utf8");
  } catch {
    return { layers: [], warnings: [] };
  }
  const parsed = parseViewSidecar(text);
  return { layers: parsed.layers, warnings: parsed.warnings, outline: parsed.outline };
}

/**
 * Validates `layers` with the same pure rulebook the webview uses and writes
 * the sidecar. Invalid entries are dropped with warnings rather than failing
 * the whole write; a view-only write never marks the mesh dirty.
 *
 * `outline` is the outline presentation key. When the caller supplies none
 * the one already on disk is kept, so a layers-only save can never erase it.
 */
export function saveViewLayers(
  meshFsPath: string,
  layers: unknown,
  outline?: unknown
): { saved: number; warnings: string[] } {
  const { layers: valid, warnings } = validateUserLayers(layers);
  let outlineOut: OutlineViewSettings | undefined;
  if (outline !== undefined) {
    const v = validateOutlineView(outline);
    outlineOut = v.settings;
    warnings.push(...v.warnings);
  } else {
    try {
      outlineOut = parseViewSidecar(fs.readFileSync(viewFilePath(meshFsPath), "utf8")).outline;
    } catch {
      // No sidecar yet: nothing to preserve.
    }
  }
  try {
    fs.writeFileSync(viewFilePath(meshFsPath), serializeViewSidecar(valid, outlineOut));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { saved: 0, warnings: [...warnings, `Could not save the view sidecar: ${message}`] };
  }
  return { saved: valid.length, warnings };
}
