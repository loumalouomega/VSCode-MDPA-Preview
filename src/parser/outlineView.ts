/**
 * Pure, view-only presentation rules for the SubModelPart outline.
 *
 * Nothing here touches layers, visibility, selection or the model: it only
 * decides which rows the outline renders. Bundled by both runtimes (the host
 * validates the sidecar key; the webview flattens the tree), no `vscode`/DOM.
 */

/** Outline presentation settings persisted in the `<stem>.kratosview.json` sidecar. */
export interface OutlineViewSettings {
  /** List every SubModelPart as one flat row, labelled with its full path. */
  flattenSubModelParts: boolean;
}

export const DEFAULT_OUTLINE_VIEW: OutlineViewSettings = { flattenSubModelParts: false };

/**
 * Tolerant read of the sidecar's `outline` value. An absent key is the
 * ordinary case (older sidecars) and yields defaults silently; anything
 * malformed degrades to defaults with a warning, never a failed open.
 */
export function validateOutlineView(raw: unknown): { settings: OutlineViewSettings; warnings: string[] } {
  if (raw === undefined) return { settings: { ...DEFAULT_OUTLINE_VIEW }, warnings: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: { ...DEFAULT_OUTLINE_VIEW }, warnings: ["View sidecar outline settings are malformed — defaults used."] };
  }
  const r = raw as Record<string, unknown>;
  const warnings: string[] = [];
  let flatten = DEFAULT_OUTLINE_VIEW.flattenSubModelParts;
  if (r.flattenSubModelParts !== undefined) {
    if (typeof r.flattenSubModelParts === "boolean") flatten = r.flattenSubModelParts;
    else warnings.push("View sidecar outline.flattenSubModelParts is not a boolean — default used.");
  }
  return { settings: { flattenSubModelParts: flatten }, warnings };
}

/** The structural slice of an outline node this module needs. */
export interface FlattenableNode {
  label: string;
  /** SubModelPart path (slash-separated), present on SubModelPart rows. */
  exportPath?: string;
  children?: FlattenableNode[];
}

/**
 * Flattens a SubModelPart tree into depth-first depth-0 rows. A nested part is
 * labelled with its full slash path so the flat list stays unambiguous (two
 * children called `Inlet` under different parents would otherwise collide);
 * top-level parts keep their plain name. Returns shallow copies with `children`
 * removed — the input is never mutated, and `layerId`/`exportPath`/`counts`
 * (recursive) are carried unchanged so every row action still addresses the
 * same layer and part.
 */
export function flattenPartNodes<T extends FlattenableNode>(nodes: readonly T[]): T[] {
  const out: T[] = [];
  const walk = (list: readonly T[], depth: number): void => {
    for (const node of list) {
      const { children, ...rest } = node as T & { children?: T[] };
      const label = depth > 0 && node.exportPath ? node.exportPath : node.label;
      out.push({ ...(rest as unknown as T), label });
      if (children) walk(children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}
