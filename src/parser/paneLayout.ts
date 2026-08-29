/**
 * Split-view pane layouts: which part of the render window each pane occupies.
 *
 * Pure (no vscode/DOM/vtk), so the tiling can be unit-tested — `webview/` is
 * not in `tsconfig.test.json`, which is why this lives in `parser/` even
 * though only the webview consumes it.
 *
 * A pane is a **viewport rect on the single render window**, not a DOM element
 * and not a second canvas: vtk.js draws N `vtkRenderer`s into one window, each
 * with its own camera. That is the whole reason this module is a lookup table
 * rather than geometry code — vtk.js viewports are NORMALIZED (0..1), so they
 * survive a resize untouched, and vtk.js does its own hit-testing
 * (`findPokedRenderer` -> `isInViewport`), so nothing here converts pixels or
 * resolves a point to a pane.
 *
 * The one thing worth being careful about: rects are returned in READING order
 * (index 0 is top-left), while vtk.js counts y UPWARD from the bottom. So the
 * first pane of a `2x1` is the one with the HIGHER y range.
 */

export type PaneLayoutId = "1x1" | "1x2" | "2x1" | "2x2";

export const PANE_LAYOUTS: readonly PaneLayoutId[] = ["1x1", "1x2", "2x1", "2x2"];

/** Human labels for the View-menu rows. */
export const PANE_LAYOUT_LABELS: Record<PaneLayoutId, string> = {
  "1x1": "Single",
  "1x2": "Side by side",
  "2x1": "Stacked",
  "2x2": "Quad",
};

export function isPaneLayout(value: unknown): value is PaneLayoutId {
  return typeof value === "string" && (PANE_LAYOUTS as readonly string[]).includes(value);
}

/** A vtk.js viewport: [xmin, ymin, xmax, ymax], normalized, bottom-left origin. */
export type PaneViewport = [number, number, number, number];

const LAYOUTS: Record<PaneLayoutId, PaneViewport[]> = {
  "1x1": [[0, 0, 1, 1]],
  // Two columns, left then right.
  "1x2": [
    [0, 0, 0.5, 1],
    [0.5, 0, 1, 1],
  ],
  // Two rows, TOP first — hence the higher y range leads.
  "2x1": [
    [0, 0.5, 1, 1],
    [0, 0, 1, 0.5],
  ],
  // Reading order: top-left, top-right, bottom-left, bottom-right.
  "2x2": [
    [0, 0.5, 0.5, 1],
    [0.5, 0.5, 1, 1],
    [0, 0, 0.5, 0.5],
    [0.5, 0, 1, 0.5],
  ],
};

export function paneCount(layout: PaneLayoutId): number {
  return LAYOUTS[layout].length;
}

/** The viewport rects for a layout, in reading order (index 0 = top-left). */
export function paneViewports(layout: PaneLayoutId): PaneViewport[] {
  // Copied, so a caller handing one to vtk.js cannot mutate the table.
  return LAYOUTS[layout].map((r) => [...r] as PaneViewport);
}

/**
 * Where a pane sits as CSS percentages from the TOP-left, for the DOM overlay
 * that draws the pane borders. The y flip lives here rather than at the call
 * site so the two origins are converted in exactly one place.
 */
export function paneCssRect(v: PaneViewport): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return {
    left: v[0] * 100,
    top: (1 - v[3]) * 100,
    width: (v[2] - v[0]) * 100,
    height: (v[3] - v[1]) * 100,
  };
}
