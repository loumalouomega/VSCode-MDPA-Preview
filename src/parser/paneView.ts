/**
 * Per-pane viewer state for the split view: what each viewport shows, as
 * opposed to `paneLayout.ts`, which says where each viewport IS.
 *
 * Pure (no vscode/DOM/vtk), so it can be unit-tested — `webview/` is not in
 * `tsconfig.test.json`, which is why this lives in `parser/` even though only
 * the webview consumes it, exactly like `paneLayout.ts` and `recordPlan.ts`.
 *
 * Split view originally shipped camera-only: every pane drew the same actors
 * and only the camera diverged, so field settings and the clip plane were
 * module-level singletons in `webview/main.ts`. Making them per-pane is what
 * this module holds the state for.
 *
 * The one hazard worth a module of its own: `modes` is a `Set` and
 * `isoValues` / `freeNormal` / `rangeOverride` are arrays, so a `{...state}`
 * spread produces two panes SHARING them — a change in one silently appears in
 * the other, which looks exactly like the panes not being independent at all.
 * Every clone here is deep for that reason, and the tests assert it.
 */

import { FieldComponent } from "./fieldScalars";
import { ThresholdRule } from "./thresholdCells";

/**
 * The independently-combinable field-visualization modes.
 *
 * Defined here rather than in `webview/fieldPanel.ts` (which re-exports it
 * unchanged) so this pure module can name it without importing a DOM module —
 * the same leaf-module arrangement `src/parser/opLabels.ts` has with
 * `operations.ts`.
 */
export type FieldMode = "contour" | "quiver" | "iso" | "deformed" | "threshold";

/** X / Y / Z preset, or a user-entered oblique normal. */
export type ClipAxis = 0 | 1 | 2 | "free";

/** Everything the Field panel edits, for one pane. */
export interface PaneFieldState {
  selectedKey: string;
  /** The set of currently-active modes (combinable). */
  modes: Set<FieldMode>;
  colormap: string;
  /** Which scalar of a vector field drives contour/iso/threshold. */
  component: FieldComponent;
  /** User-entered [min,max] override; undefined = use the field's data range. */
  rangeOverride?: [number, number];
  log: boolean;
  /** Discrete color bands; 0 = continuous. */
  bands: number;
  scalarBar: boolean;
  /** One or more iso values (evenly spaced by default; user-editable). */
  isoValues: number[];
  /** Quiver arrow scale. */
  scale: number;
  /** The vector field driving the deformation (may differ from the coloring field). */
  deformKey: string;
  deformScale: number;
  /** [lo,hi] window of cells to show; undefined = everything passes. */
  thresholdRange?: [number, number];
  thresholdRule: ThresholdRule;
}

/**
 * Everything the nav card's Clip group edits, for one pane.
 *
 * `t` (the slider position, 0..1) used to live only in the DOM `<input
 * type=range>`, which is fine for one plane and impossible for several: two
 * panes cannot hold two positions in one slider. The DOM is the view now and
 * this is the storage.
 */
export interface PaneClipState {
  active: boolean;
  axis: ClipAxis;
  flipped: boolean;
  /** The Free mode's normal; not necessarily unit length (normalized on use). */
  freeNormal: [number, number, number];
  /** Slider position along the model's extent on the plane normal, 0..1. */
  t: number;
}

export interface PaneViewState {
  field: PaneFieldState;
  clip: PaneClipState;
}

export function defaultPaneFieldState(colormap: string): PaneFieldState {
  return {
    selectedKey: "",
    modes: new Set<FieldMode>(["contour"]),
    colormap,
    component: "mag",
    rangeOverride: undefined,
    log: false,
    bands: 0,
    scalarBar: false,
    isoValues: [],
    scale: 1,
    deformKey: "",
    deformScale: 1,
    thresholdRange: undefined,
    thresholdRule: "all",
  };
}

export function defaultPaneClipState(): PaneClipState {
  return { active: false, axis: 2, flipped: false, freeNormal: [0, 0, 1], t: 0.5 };
}

export function defaultPaneViewState(colormap: string): PaneViewState {
  return { field: defaultPaneFieldState(colormap), clip: defaultPaneClipState() };
}

export function clonePaneFieldState(s: PaneFieldState): PaneFieldState {
  return {
    ...s,
    modes: new Set(s.modes),
    isoValues: [...s.isoValues],
    rangeOverride: s.rangeOverride ? [s.rangeOverride[0], s.rangeOverride[1]] : undefined,
    thresholdRange: s.thresholdRange ? [s.thresholdRange[0], s.thresholdRange[1]] : undefined,
  };
}

export function clonePaneClipState(s: PaneClipState): PaneClipState {
  return { ...s, freeNormal: [s.freeNormal[0], s.freeNormal[1], s.freeNormal[2]] };
}

export function clonePaneViewState(s: PaneViewState): PaneViewState {
  return { field: clonePaneFieldState(s.field), clip: clonePaneClipState(s.clip) };
}

/**
 * The per-pane states for the next layout.
 *
 * The FOCUSED pane survives as pane 0 in both directions — the same rule
 * `setPaneLayout` applies to the renderers themselves, so the view you were
 * working in is never the one thrown away — and every new pane is seeded from
 * it and then diverges, mirroring `copyCamera`.
 *
 * `keepIndex` out of range falls back to 0 rather than throwing: it comes from
 * `focusedPaneIndex()`, which already degrades that way when the interactor
 * reports a renderer that is not a pane.
 */
export function reconcilePaneStates(
  prev: readonly PaneViewState[],
  keepIndex: number,
  nextCount: number,
  fallbackColormap: string
): PaneViewState[] {
  const keep =
    prev[keepIndex >= 0 && keepIndex < prev.length ? keepIndex : 0] ??
    defaultPaneViewState(fallbackColormap);
  const out: PaneViewState[] = [clonePaneViewState(keep)];
  for (let i = 1; i < nextCount; i++) out.push(clonePaneViewState(keep));
  return out;
}

/** A "Pane 2 of 4" label for the panels, or undefined in a single-pane layout. */
export function paneLabel(index: number, total: number): string | undefined {
  return total > 1 ? `Pane ${index + 1} of ${total}` : undefined;
}
