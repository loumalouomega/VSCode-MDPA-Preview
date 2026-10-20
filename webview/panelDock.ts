/**
 * panelDock.ts — the webview's side of the floating-panel layout
 * (roadmap item 1, the panel docking and overflow increment).
 *
 * The pure arithmetic lives in `src/parser/panelLayout.ts`; this module is
 * the DOM half: it measures the panels, applies the geometry the arithmetic
 * returns, and re-runs the layout whenever something that can change it
 * happens (a panel opens or closes, a panel's content grows, the window
 * resizes, the timeline appears).
 *
 * Two rules it holds to:
 *
 * - **It only moves panels.** It never re-renders a panel's contents, so a
 *   form keeps the text the user typed into it and keeps the focus, even
 *   when the layout shifts under it.
 * - **It never leaves a panel where the user cannot reach it.** A panel that
 *   does not fit is shortened and scrolls internally (`overflow-y: auto`),
 *   rather than being pushed out of the viewport or left under another one.
 *
 * The panels it manages are the ones that share the viewport's bottom-left
 * corner: the Selection card and the two wide strips (the Probe chart and
 * the Plot-over-time chart). The panels docked to the TOP edge (Quality,
 * Mesh size, Field, …) keep their own anchors — they never shared the
 * bottom-left corner with anything, so they are not part of this cluster.
 */

import { layoutFloatingPanels, type LayoutViewport, type PanelInput, type PanelPlacement } from "../src/parser/panelLayout";

/** The panels in the cluster, and how each is found. */
interface ManagedPanel {
  id: string;
  role: "card" | "strip";
  el: HTMLElement;
  /** False when the panel is closed. */
  isOpen(): boolean;
  /** The panel's natural width, measured from the stylesheet. */
  naturalWidth(): number;
  /** The panel's minimum useful height. */
  minHeight(): number;
  /**
   * Called when the panel's width changed, so a chart can redraw itself
   * against the new width. It must NOT re-render the panel's contents: a
   * form keeps what the user typed into it.
   */
  onWidthChanged?(): void;
}

export interface PanelDockOptions {
  /** The viewport the panels live in (the canvas area). */
  container: HTMLElement;
  /** The panels, in the order they are asked for. */
  panels: ManagedPanel[];
  /**
   * The distance from the container's bottom edge to the cluster's floor: the
   * line the nav dock's top sits on. The dock is lifted above the cluster, so
   * the cluster never covers it.
   */
  floor(): number;
  /** The width the right-hand card (the Inspect panel) occupies. */
  rightInset(): number;
}

/** The gap between two panels, in CSS pixels. Mirrors the stylesheet. */
const GAP = 8;

export class PanelDock {
  private readonly opts: PanelDockOptions;
  private observer: ResizeObserver | undefined;
  private frame = 0;

  constructor(opts: PanelDockOptions) {
    this.opts = opts;
  }

  /** Start watching for the changes that can move a panel. */
  start(): void {
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.schedule());
      for (const panel of this.opts.panels) this.observer.observe(panel.el);
    }
    window.addEventListener("resize", this.schedule);
  }

  /** Stop watching and release the observer. */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    window.removeEventListener("resize", this.schedule);
  }

  /**
   * Re-run the layout on the next frame. Several things can ask for this at
   * once (a panel opens, the chart draws, the window resizes), and the
   * layout reads the DOM, so it waits for the frame in which the DOM has
   * settled.
   */
  schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.apply();
    });
  };

  /** Measure the panels and apply the layout. */
  apply(): void {
    const panels = this.opts.panels;
    const inputs: PanelInput[] = panels.map((p) => {
      const visible = p.isOpen() && p.el.style.display !== "none";
      return {
        id: p.id,
        role: p.role,
        visible,
        naturalWidth: p.naturalWidth(),
        naturalHeight: visible ? p.el.scrollHeight : 0,
        minHeight: p.minHeight(),
      };
    });

    const viewport = this.viewport();
    const placements = layoutFloatingPanels(inputs, viewport);
    for (const placement of placements) {
      const panel = panels.find((p) => p.id === placement.id);
      if (!panel) continue;
      const changed = this.place(panel.el, placement);
      // A chart draws into a canvas sized from its own width, so a width
      // change means the drawing is stale. The panel is asked to redraw; it
      // is NOT re-rendered from scratch, so a form keeps its contents.
      if (changed) panel.onWidthChanged?.();
    }
  }

  /** The viewport the panels are laid out in. */
  private viewport(): LayoutViewport {
    const box = this.opts.container.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      // The floor is the line the nav dock's top sits on, so the cluster
      // always clears the dock. The dock is lifted above the cluster anyway,
      // but the floor keeps the panels off the canvas' bottom edge.
      floor: Math.round(this.opts.floor()),
      leftInset: 8,
      rightInset: Math.round(this.opts.rightInset()),
      gap: GAP,
      // The cluster may take at most this share of the viewport's height, so
      // the canvas stays usable underneath it.
      maxHeight: Math.max(0, Math.round(box.height * 0.6)),
    };
  }

  /**
   * Apply one placement to one element. Returns true when the panel's width
   * changed, so the caller can ask a chart to redraw.
   */
  private place(el: HTMLElement, placement: PanelPlacement): boolean {
    if (!placement.visible) return false;
    const before = el.style.getPropertyValue("--panel-width");
    // The geometry is set through custom properties so the stylesheet owns
    // the look and this owns only the position.
    el.style.setProperty("--panel-left", `${placement.left}px`);
    el.style.setProperty("--panel-bottom", `${placement.bottom}px`);
    el.style.setProperty("--panel-width", `${placement.width}px`);
    el.style.setProperty("--panel-height", `${placement.height}px`);
    el.style.maxHeight = `${placement.height}px`;
    el.style.overflowY = "auto";
    // The panels carried an inline `bottom` of their own before the cluster
    // existed (the Probe strip was moved by hand when the timeline appeared).
    // An inline value beats the stylesheet's `var(--panel-bottom)`, so it is
    // cleared here — otherwise the strip keeps the old line and the cluster
    // does not hold together.
    el.style.bottom = "";
    el.style.left = "";
    el.style.right = "";
    el.style.width = "";
    el.dataset.docked = "1";
    return before !== `${placement.width}px`;
  }
}
