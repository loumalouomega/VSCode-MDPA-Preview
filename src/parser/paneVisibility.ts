/**
 * Per-pane layer visibility — the pure half (no imports, so both runtimes
 * bundle it and `node:test` can reach it; `webview/` is outside
 * `tsconfig.test.json`).
 *
 * A split view draws one set of layers in every pane. The outline's checkbox
 * stays the MASTER switch ("show this layer"); pane scope is an additional
 * filter on top of it, never a replacement, so an existing checkbox keeps its
 * meaning and a layer with no pane scope draws exactly as before. A layer is
 * described by the list of panes it is HIDDEN in (absent = hidden nowhere), so
 * the default — and every sidecar written before this existed — means
 * "everywhere".
 */

/** Pane indices a layer is hidden in: ascending, unique, non-negative integers. `undefined` = none. */
export type PaneHidden = readonly number[] | undefined;

/** The most panes a layout has (mirrors `paneLayout.ts`'s 2x2). */
export const MAX_PANE_SCOPE = 4;

/** True when a layer is NOT hidden in pane `index` (the pane term of the draw rule). */
export function paneDraws(hidden: PaneHidden, index: number): boolean {
  return !hidden || !hidden.includes(index);
}

/** The scope after hiding (`hide: true`) or showing the layer in one pane; empty collapses to `undefined`. */
export function setPaneHidden(hidden: PaneHidden, index: number, hide: boolean): number[] | undefined {
  if (!Number.isInteger(index) || index < 0) return hidden ? [...hidden] : undefined;
  const set = new Set(hidden ?? []);
  if (hide) set.add(index);
  else set.delete(index);
  return set.size === 0 ? undefined : [...set].sort((a, b) => a - b);
}

/** True when the layer is hidden in at least one pane of a layout with `count` panes. */
export function isPartlyHidden(hidden: PaneHidden, count: number): boolean {
  return !!hidden && hidden.some((i) => i < count);
}

/**
 * The scope after a layout switch. `setPaneLayout` keeps one pane (the focused
 * one) and re-creates every other pane seeded from it, exactly as it does for
 * the camera, field and clip state — so the kept pane's answer applies to all
 * of them and the panes then diverge.
 */
export function reconcilePaneHidden(hidden: PaneHidden, keepIndex: number, nextCount: number): number[] | undefined {
  if (!hidden || nextCount < 1 || !hidden.includes(keepIndex)) return undefined;
  return Array.from({ length: nextCount }, (_, i) => i);
}

/** Tolerant read of untrusted JSON: keeps valid, unique indices below `maxPanes`, sorted. */
export function validatePaneHidden(raw: unknown, maxPanes: number = MAX_PANE_SCOPE): { hidden: number[] | undefined; dropped: number } {
  if (!Array.isArray(raw)) return { hidden: undefined, dropped: raw === undefined ? 0 : 1 };
  const keep = new Set<number>();
  let dropped = 0;
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < maxPanes) keep.add(v);
    else dropped++;
  }
  return { hidden: keep.size === 0 ? undefined : [...keep].sort((a, b) => a - b), dropped };
}

/** Outline tooltip: "Shown in every pane" / "Hidden in panes 2, 3" (1-based, only panes that exist). */
export function describePaneScope(hidden: PaneHidden, count: number): string {
  const panes = (hidden ?? []).filter((i) => i < count).map((i) => i + 1);
  if (panes.length === 0) return "Shown in every pane";
  if (panes.length >= count) return "Hidden in every pane";
  return `Hidden in ${panes.length === 1 ? "pane" : "panes"} ${panes.join(", ")}`;
}
