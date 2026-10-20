/**
 * panelLayout.ts — where the viewport's floating panels sit, so no panel can
 * cover another's controls (roadmap item 1, the panel docking and overflow
 * increment).
 *
 * Pure: no DOM, no vscode. Lives in `src/parser/` rather than `webview/` so
 * `node --test` can reach it — `webview/` is outside `tsconfig.test.json` and
 * needs a DOM (the same arrangement as `navMath.ts`, which the nav dock's
 * arithmetic uses).
 *
 * The problem it solves. Three panels share the viewport's bottom-left
 * corner: the Selection panel (a 300 px card on the left edge), the Probe
 * strip and the Plot-over-time strip (both wide charts that start at the same
 * left edge and stop at the Inspect panel on the right). They were positioned
 * independently — `left/right` for the strips, `left/width` for the card —
 * and each was bottom-anchored to a different line, so with a tall Selection
 * panel and a chart open, the chart painted over the Selection panel's lower
 * half and swallowed its clicks. Measured in the browser at 1680x1000: the
 * Probe strip covered Selection's "Delete entities" and "Clear" buttons, the
 * whole seed builder and its "Add set" button. The KKSS embedding reproduced
 * exactly that — a VTK probe chart overlapping Selection's Box control and
 * intercepting clicks. The two strips overlapped each other the same way.
 *
 * The rule this module encodes:
 *
 * - The panels form ONE cluster, on ONE floor line above the nav dock.
 * - The cluster has a card column (Selection, on the left) and a strip
 *   column (Probe, Plot over time, on the right).
 * - The columns sit BESIDE each other when the width allows, and the strip
 *   column moves BELOW the card when it does not — so a chart never covers a
 *   form.
 * - Within a column the panels stack upwards and never overlap.
 * - The cluster is bounded: a panel that does not fit is shortened and
 *   scrolls internally, rather than growing past the space it was given.
 *
 * The caller measures the panels (their natural widths and heights) and
 * applies the returned geometry. Nothing here touches the DOM, so the same
 * arithmetic is testable at the Node level and identical in the browser.
 */

/**
 * The role a panel plays in the cluster. A card is a form on the left edge; a
 * strip is a wide chart that runs to the Inspect panel on the right.
 */
export type PanelRole = "card" | "strip";

/** A panel that takes part in the layout. */
export interface PanelInput {
  /** Stable id, used to match the result back to the element. */
  id: string;
  /** The role, which decides the column the panel joins. */
  role: PanelRole;
  /** False when the panel is closed (or has never been opened). */
  visible: boolean;
  /**
   * The panel's natural width, in CSS pixels, with no width constraint. Only
   * the card's matters: a strip takes the width the layout gives it.
   */
  naturalWidth: number;
  /** The panel's natural height, in CSS pixels, with no height constraint. */
  naturalHeight: number;
  /** The panel's minimum useful height: below this its content is unusable. */
  minHeight: number;
}

/** The viewport the panels live in, and what they must stay clear of. */
export interface LayoutViewport {
  /** Width of the viewport (the canvas area, not the whole window). */
  width: number;
  /** Height of the viewport. */
  height: number;
  /**
   * The cluster's floor: the distance from the viewport's bottom edge to the
   * line the panels sit on. It is above the nav dock, so a panel never
   * covers the dock.
   */
  floor: number;
  /** Distance from the left edge to the panels' left gutter. */
  leftInset: number;
  /** Distance from the right edge to the right-hand card (the Inspect panel). */
  rightInset: number;
  /** Gap between two panels that touch each other. */
  gap: number;
  /**
   * The tallest the cluster may be. A panel that does not fit is shortened
   * and scrolls internally, so the canvas stays usable underneath.
   */
  maxHeight: number;
}

export interface PanelPlacement {
  id: string;
  visible: boolean;
  /** Distance from the viewport's left edge. */
  left: number;
  /** Distance from the viewport's bottom edge. */
  bottom: number;
  /** Distance from the viewport's top edge. */
  top: number;
  /** The height the panel should take. */
  height: number;
  /** The width the panel should take. */
  width: number;
  /** True when the panel had to be shortened to fit; it scrolls internally. */
  clamped: boolean;
  /** True when the panel had to be moved below the card because the width ran out. */
  stacked: boolean;
}

/** The panels this module lays out, in the order they are asked for. */
export const LAYOUT_PANEL_IDS = ["selection", "probe", "series"] as const;
export type LayoutPanelId = (typeof LAYOUT_PANEL_IDS)[number];

/**
 * The narrowest a wide strip may be and still be worth showing. Below this
 * the chart's axis labels collide, so the strip moves under the card.
 */
export const MIN_STRIP_WIDTH = 260;

/**
 * The default insets, in CSS pixels. They mirror the stylesheet: the 8 px
 * gutter every floating panel uses and the 296 px the right-hand Inspect
 * panel occupies (an 8 px inset plus a 280 px card) — the wide strips stop
 * there so they never run under the Inspect panel.
 */
export const DEFAULT_VIEWPORT: LayoutViewport = {
  width: 1280,
  height: 800,
  floor: 60,
  leftInset: 8,
  rightInset: 296,
  gap: 8,
  maxHeight: 480,
};

/** One column of the cluster: the panels in it and the space they get. */
interface Column {
  panels: PanelInput[];
  left: number;
  width: number;
  /** The heights, one per panel, bottom to top. */
  heights: number[];
}

/**
 * Lay the panels out.
 *
 * The panels are the ones taking part, in the order they are asked for: the
 * card first (Selection), then the strips (Probe, Plot over time). A closed
 * panel contributes nothing and gets `visible: false` back.
 *
 * The result never overlaps: the strips sit beside the card when the width
 * allows and below it when it does not, the panels in a column stack upwards,
 * and the cluster is squeezed to the space it was given, with the panels that
 * can shrink shrinking first.
 */
export function layoutFloatingPanels(panels: PanelInput[], viewport: LayoutViewport): PanelPlacement[] {
  const visible = panels.filter((p) => p.visible);
  if (visible.length === 0) return panels.map((p) => emptyPlacement(p));

  const { leftInset, rightInset, gap, floor, height, maxHeight } = viewport;
  const available = Math.max(0, viewport.width - leftInset - rightInset);

  const card = visible.find((p) => p.role === "card") ?? null;
  const strips = visible.filter((p) => p.role === "strip");

  /**
   * The card keeps its own width whenever the viewport can hold it. The
   * right-hand inset (the Inspect panel) is only given up when the viewport
   * is too narrow for both: squeezing a 300px form down to 196px would make
   * its controls unusable, and losing the right inset is the lesser loss —
   * the Inspect panel is on the other side of the viewport and a narrow
   * window is already cramped.
   */
  const cardWidth = card ? Math.min(card.naturalWidth, Math.max(0, viewport.width - leftInset)) : 0;
  const stripWidthBeside = available - (card ? cardWidth + gap : 0);
  /**
   * The strips move below the card when there is no room beside it. With no
   * card at all there is nothing to move under, so the strips simply take the
   * whole row.
   */
  const stacked = card !== null && strips.length > 0 && stripWidthBeside < MIN_STRIP_WIDTH;

  // The columns. A column's panels are listed BOTTOM to TOP, so the first one
  // listed takes the floor.
  const columns: Column[] = [];
  if (card) columns.push({ panels: [card], left: leftInset, width: cardWidth, heights: [card.naturalHeight] });
  if (strips.length > 0) {
    columns.push({
      panels: strips,
      left: stacked ? leftInset : leftInset + (card ? cardWidth + gap : 0),
      // Stacked, a strip takes the whole row: the card is above it, so
      // nothing is beside it to stop at.
      width: stacked ? Math.max(0, viewport.width - leftInset) : Math.max(0, stripWidthBeside),
      heights: strips.map((s) => s.naturalHeight),
    });
  }

  // The budget: the cluster is bottom-anchored on the floor, so it can never
  // grow past the top of the viewport, and never past the share it was given.
  const budget = Math.max(0, Math.min(maxHeight, height - floor));

  // The height a column takes with the heights it was given.
  const columnHeight = (column: Column): number =>
    column.heights.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, column.panels.length - 1);

  // Squeeze the cluster to the budget. Side by side, each column is bounded on
  // its own; stacked, the two share one budget and the strip column (the
  // lower one) gives up its space first, because a chart scrolls where a
  // form does not.
  if (stacked) {
    let overflow = columns.reduce((sum, c) => sum + columnHeight(c), 0) + gap - budget;
    for (const c of [...columns].reverse()) {
      for (let i = c.heights.length - 1; i >= 0 && overflow > 0; i--) {
        const room = c.heights[i] - c.panels[i].minHeight;
        const take = Math.min(Math.max(0, room), overflow);
        c.heights[i] -= take;
        overflow -= take;
      }
    }
    // Still too tall: clip from the top of the topmost column.
    for (const c of [...columns].reverse()) {
      for (let i = c.heights.length - 1; i >= 0 && overflow > 0; i--) {
        const take = Math.min(c.heights[i], overflow);
        c.heights[i] -= take;
        overflow -= take;
      }
    }
  } else {
    for (const c of columns) {
      let overflow = columnHeight(c) - budget;
      for (let i = c.heights.length - 1; i >= 0 && overflow > 0; i--) {
        const room = c.heights[i] - c.panels[i].minHeight;
        const take = Math.min(Math.max(0, room), overflow);
        c.heights[i] -= take;
        overflow -= take;
      }
      for (let i = c.heights.length - 1; i >= 0 && overflow > 0; i--) {
        const take = Math.min(c.heights[i], overflow);
        c.heights[i] -= take;
        overflow -= take;
      }
    }
  }

  // ---- place them ---------------------------------------------------------
  const placements = new Map<string, PanelPlacement>();
  if (stacked) {
    // The card column is on top, the strip column below it; the cluster is
    // bottom-anchored, so the strip column takes the floor.
    const stripColumn = columns[columns.length - 1];
    const stripH = columnHeight(stripColumn);
    placeColumn(columns[0], floor + stripH + gap, placements, stacked, viewport);
    placeColumn(stripColumn, floor, placements, stacked, viewport);
  } else {
    for (const c of columns) placeColumn(c, floor, placements, stacked, viewport);
  }

  return panels.map((p) => placements.get(p.id) ?? emptyPlacement(p));
}

/** Place one column's panels, bottom to top, on the given floor. */
function placeColumn(
  column: Column,
  floor: number,
  placements: Map<string, PanelPlacement>,
  stacked: boolean,
  viewport: LayoutViewport
): void {
  let cursor = floor;
  for (let i = 0; i < column.panels.length; i++) {
    const panel = column.panels[i];
    const h = Math.max(0, column.heights[i] ?? 0);
    placements.set(panel.id, {
      id: panel.id,
      visible: true,
      left: column.left,
      bottom: cursor,
      top: viewport.height - cursor - h,
      height: h,
      width: Math.max(0, column.width),
      clamped: h < panel.naturalHeight - 0.5,
      stacked: panel.role === "strip" && stacked,
    });
    cursor += h + viewport.gap;
  }
}

function emptyPlacement(panel: PanelInput): PanelPlacement {
  return {
    id: panel.id,
    visible: false,
    left: 0,
    bottom: 0,
    top: 0,
    height: 0,
    width: 0,
    clamped: false,
    stacked: false,
  };
}
