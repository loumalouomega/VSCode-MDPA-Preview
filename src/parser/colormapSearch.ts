// Search over the colormap registry (roadmap item 22 F). Pure, so the filter the
// picker applies is Node-tested; the registry itself lives in
// webview/colormaps.ts (its stops feed the renderer, the DOM legend, the scalar
// bar and the screenshot burn-in alike, so a new map reaches all four).

export type ColormapCategoryName = "diverging" | "sequential" | "rainbow" | "other";

export interface ColormapInfo {
  name: string;
  category: ColormapCategoryName;
  colorblindSafe: boolean;
}

/**
 * Maps whose name contains every whitespace-separated word of `query`
 * (case-insensitive), optionally only the colour-blind-safe ones; the category
 * word ("diverging") also matches. An empty query keeps everything, in the
 * registry's own order.
 */
export function filterColormaps<T extends ColormapInfo>(maps: readonly T[], query: string, onlyColorblindSafe: boolean): T[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return maps.filter((m) => {
    if (onlyColorblindSafe && !m.colorblindSafe) return false;
    const hay = `${m.name.toLowerCase()} ${m.category}`;
    return words.every((w) => hay.includes(w));
  });
}

/** Maps grouped by category in a stable display order, empty groups dropped. */
export function groupByCategory<T extends ColormapInfo>(maps: readonly T[]): { category: ColormapCategoryName; maps: T[] }[] {
  const order: ColormapCategoryName[] = ["sequential", "diverging", "rainbow", "other"];
  return order
    .map((category) => ({ category, maps: maps.filter((m) => m.category === category) }))
    .filter((g) => g.maps.length > 0);
}
