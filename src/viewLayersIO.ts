/**
 * Host-side persistence for user layers.
 *
 * The `<stem>.kratosview.json` sidecar lives beside the mesh (see
 * `caseFile.ts`'s `viewFilePath`, the one authority for where sidecars live).
 * Reads are tolerant — a missing, malformed or newer-version file yields an
 * empty list with warnings, leaving the mesh with its ordinary sections.
 * Writes carry only the view annotation; they never touch the mesh bytes, the
 * operation history or the dirty marker. A file written by a NEWER version is
 * never overwritten: reading it yields nothing usable, and saving over it
 * would silently downgrade it.
 *
 * Host-only (node:fs/path): the webview never imports this module. It speaks
 * the pure `parser/userLayers.ts` shapes over `postMessage`.
 */

import * as fs from "node:fs";

import { OutlineViewSettings, validateOutlineView } from "./parser/outlineView";
import {
  UserLayer,
  VIEW_SIDECAR_VERSION,
  parseViewSidecar,
  serializeViewSidecar,
  validateUserLayers,
} from "./parser/userLayers";
import { MeasuresCache, validateMeasuresCache } from "./parser/partMeasures";
import { ViewState, validateViewState } from "./parser/viewState";
import { viewFilePath } from "./problemtype/caseFile";

/**
 * Loads the sidecar for `meshFsPath`; missing/unreadable → empty + warning.
 * `outline` and `view` are present only when the file carries them.
 */
export function loadViewLayers(meshFsPath: string): {
  layers: UserLayer[];
  warnings: string[];
  outline?: OutlineViewSettings;
  view?: ViewState;
  measures?: MeasuresCache;
} {
  let text: string;
  try {
    text = fs.readFileSync(viewFilePath(meshFsPath), "utf8");
  } catch {
    return { layers: [], warnings: [] };
  }
  const parsed = parseViewSidecar(text);
  return { layers: parsed.layers, warnings: parsed.warnings, outline: parsed.outline, view: parsed.view, measures: parsed.measures };
}

/**
 * Validates the supplied pieces with the same pure rulebook the webview uses
 * and writes the sidecar. Invalid entries are dropped with warnings rather
 * than failing the whole write; a view-only write never marks the mesh dirty.
 *
 * `layers`, `outline` and `view` are independent keys. **Any the caller omits
 * keeps the value already on disk**, so a save that carries only one of them
 * (the outline toggle, a camera move) can never erase the others. The file is
 * written wholesale, so this preservation is the only thing protecting them.
 *
 * A sidecar from a newer version is left untouched (`saved: 0` + a warning).
 */
export function saveViewLayers(
  meshFsPath: string,
  layers?: unknown,
  outline?: unknown,
  view?: unknown,
  measures?: unknown
): { saved: number; warnings: string[] } {
  const warnings: string[] = [];
  let onDisk: ReturnType<typeof parseViewSidecar> | undefined;
  try {
    onDisk = parseViewSidecar(fs.readFileSync(viewFilePath(meshFsPath), "utf8"));
  } catch {
    // No sidecar yet: nothing to preserve.
  }
  if (onDisk?.version !== undefined && onDisk.version > VIEW_SIDECAR_VERSION) {
    return {
      saved: 0,
      warnings: [`The view sidecar was written by a newer version (${onDisk.version}) and was left unchanged.`],
    };
  }

  let layersOut: UserLayer[];
  if (layers !== undefined) {
    const v = validateUserLayers(layers);
    layersOut = v.layers;
    warnings.push(...v.warnings);
  } else {
    layersOut = onDisk?.layers ?? [];
  }

  let outlineOut: OutlineViewSettings | undefined;
  if (outline !== undefined) {
    const v = validateOutlineView(outline);
    outlineOut = v.settings;
    warnings.push(...v.warnings);
  } else {
    outlineOut = onDisk?.outline;
  }

  let viewOut: ViewState | undefined;
  if (view !== undefined) {
    const v = validateViewState(view);
    viewOut = v.view;
    warnings.push(...v.warnings);
  } else {
    viewOut = onDisk?.view;
  }

  // Same rule as the other keys: omitted keeps the on-disk cache; an invalid one is dropped.
  const measuresOut = measures !== undefined ? validateMeasuresCache(measures) : onDisk?.measures;

  try {
    fs.writeFileSync(viewFilePath(meshFsPath), serializeViewSidecar(layersOut, outlineOut, viewOut, measuresOut));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { saved: 0, warnings: [...warnings, `Could not save the view sidecar: ${message}`] };
  }
  return { saved: layersOut.length, warnings };
}
