/**
 * The materials-table plot: a small hand-drawn SVG chart of the grid's
 * `input → output` pairs that edits the table when its points are dragged.
 *
 * The rows stay the single source of truth. The chart never holds a copy: every
 * draw reads `getRows()`, and every edit hands the new rows to `onRows`, which
 * writes them back into the grid and the case text. All of the geometry (which
 * rows are points, how a drag keeps the input column increasing, what a nudge
 * or an insert does) is in `src/problemtype/materialTablePlot.ts`, where it is
 * tested; this file only turns pointer and key events into those calls.
 *
 * Accessibility: each point is a focusable control named with its values; the
 * arrow keys nudge it (Shift for a coarser step) and Delete removes it. The
 * grid beside the chart is the equivalent text form of everything shown here.
 */

import {
  addPoint, canPlot, hitPoint, makeScale, movePoint, niceTicks, nudgePoint, plotExtent, plotPoints, removePoint,
  type Extent, type PlotBox, type PlotScale,
} from "../src/problemtype/materialTablePlot";
import type { TableRow } from "../src/problemtype/materialTables";

const NS = "http://www.w3.org/2000/svg";
const W = 280;
const H = 170;
const BOX: PlotBox = { left: 46, top: 8, width: W - 46 - 10, height: H - 8 - 30 };
const HIT_RADIUS = 10;
const POINT_RADIUS = 4;

export interface TablePlotOptions {
  inputLabel: string;
  outputLabel: string;
  getRows(): TableRow[];
  /** New rows from a drag, a key press, an insert or a delete. */
  onRows(rows: TableRow[]): void;
}

export interface TablePlot {
  element: HTMLElement;
  /** Redraw from the grid's current rows (after typing in the grid). */
  refresh(): void;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Tick label: compact, and exponent form for very small or large values. */
function tickLabel(v: number): string {
  const a = Math.abs(v);
  if (v !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1).replace("e+", "e");
  return String(Number(v.toPrecision(4)));
}

export function createTablePlot(opts: TablePlotOptions): TablePlot {
  const root = document.createElement("div");
  root.className = "pt-tplot";
  const hint = document.createElement("div");
  hint.className = "pt-tplot-hint";
  hint.textContent = "Add at least two valid pairs to plot the table.";
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "pt-tplot-svg", role: "group" });
  svg.setAttribute("aria-label", `${opts.outputLabel} against ${opts.inputLabel}. Drag a point, or focus it and use the arrow keys.`);
  const readout = document.createElement("div");
  readout.className = "pt-tplot-readout";
  readout.textContent = "Drag a point to edit. Double-click to add one.";
  root.append(hint, svg, readout);

  /** The extent a drag started with: frozen so the axes do not chase the pointer. */
  let frozen: Extent | undefined;
  let dragIndex: number | undefined;
  let focusIndex: number | undefined;

  const current = (): { rows: TableRow[]; extent: Extent; scale: PlotScale } => {
    const rows = opts.getRows();
    const extent = frozen ?? plotExtent(plotPoints(rows));
    return { rows, extent, scale: makeScale(extent, BOX) };
  };

  const say = (x: number, y: number): void => {
    readout.textContent = `${opts.inputLabel} = ${tickLabel(x)}, ${opts.outputLabel} = ${tickLabel(y)}`;
  };

  function draw(): void {
    const { rows, extent, scale } = current();
    const ok = canPlot(rows);
    hint.hidden = ok;
    svg.style.display = ok ? "" : "none";
    readout.hidden = !ok;
    svg.textContent = "";
    if (!ok) return;
    const points = plotPoints(rows);
    const frame = svgEl("rect", { x: BOX.left, y: BOX.top, width: BOX.width, height: BOX.height, class: "pt-tplot-frame" });
    svg.appendChild(frame);
    for (const t of niceTicks(extent.xmin, extent.xmax, 4)) {
      const [px] = scale.toPx(t, extent.ymin);
      svg.appendChild(svgEl("line", { x1: px, x2: px, y1: BOX.top, y2: BOX.top + BOX.height, class: "pt-tplot-grid" }));
      const label = svgEl("text", { x: px, y: BOX.top + BOX.height + 12, "text-anchor": "middle", class: "pt-tplot-tick" });
      label.textContent = tickLabel(t);
      svg.appendChild(label);
    }
    for (const t of niceTicks(extent.ymin, extent.ymax, 4)) {
      const [, py] = scale.toPx(extent.xmin, t);
      svg.appendChild(svgEl("line", { x1: BOX.left, x2: BOX.left + BOX.width, y1: py, y2: py, class: "pt-tplot-grid" }));
      const label = svgEl("text", { x: BOX.left - 4, y: py + 3, "text-anchor": "end", class: "pt-tplot-tick" });
      label.textContent = tickLabel(t);
      svg.appendChild(label);
    }
    const xTitle = svgEl("text", { x: BOX.left + BOX.width / 2, y: H - 3, "text-anchor": "middle", class: "pt-tplot-title" });
    xTitle.textContent = opts.inputLabel;
    const yTitle = svgEl("text", { x: 3, y: BOX.top + 2, "text-anchor": "start", class: "pt-tplot-title" });
    yTitle.textContent = opts.outputLabel;
    svg.append(xTitle, yTitle);
    const path = points.map((p) => scale.toPx(p.x, p.y).join(",")).join(" ");
    svg.appendChild(svgEl("polyline", { points: path, class: "pt-tplot-line" }));
    for (const p of points) {
      const [cx, cy] = scale.toPx(p.x, p.y);
      const dot = svgEl("circle", { cx, cy, r: POINT_RADIUS, class: "pt-tplot-point", tabindex: 0, role: "button", "data-index": p.index });
      dot.setAttribute(
        "aria-label",
        `${opts.inputLabel} ${tickLabel(p.x)}, ${opts.outputLabel} ${tickLabel(p.y)}. Arrow keys move, Shift for larger steps, Delete removes.`
      );
      dot.addEventListener("focus", () => say(p.x, p.y));
      dot.addEventListener("pointerenter", () => say(p.x, p.y));
      svg.appendChild(dot);
    }
    if (focusIndex !== undefined) {
      (svg.querySelector(`[data-index="${focusIndex}"]`) as SVGElement | null)?.focus();
      focusIndex = undefined;
    }
  }

  const commit = (rows: TableRow[], focus?: number): void => {
    focusIndex = focus;
    opts.onRows(rows);
    draw();
  };

  const localXY = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const { rows, extent, scale } = current();
    const [px, py] = localXY(e);
    const hit = hitPoint(plotPoints(rows), scale, px, py, HIT_RADIUS);
    if (hit === undefined) return;
    e.preventDefault();
    dragIndex = hit;
    frozen = extent;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
    focusIndex = hit;
  });
  svg.addEventListener("pointermove", (e) => {
    if (dragIndex === undefined) return;
    const { rows, extent, scale } = current();
    const [x, y] = scale.fromPx(...localXY(e));
    const next = movePoint(rows, dragIndex, x, y, extent.xmax - extent.xmin);
    const moved = plotPoints(next).find((p) => p.index === dragIndex);
    if (moved) say(moved.x, moved.y);
    commit(next, dragIndex);
  });
  const endDrag = (e: PointerEvent): void => {
    if (dragIndex === undefined) return;
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    focusIndex = dragIndex;
    dragIndex = undefined;
    frozen = undefined;
    svg.classList.remove("dragging");
    draw();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener("dblclick", (e) => {
    const { rows, scale } = current();
    const [px, py] = localXY(e);
    if (hitPoint(plotPoints(rows), scale, px, py, HIT_RADIUS) !== undefined) return;
    if (px < BOX.left || px > BOX.left + BOX.width || py < BOX.top || py > BOX.top + BOX.height) return;
    const [x, y] = scale.fromPx(px, py);
    const added = addPoint(rows, x, y);
    if (added.inserted === undefined) {
      readout.textContent = `A point at ${opts.inputLabel} = ${tickLabel(x)} already exists.`;
      return;
    }
    commit(added.rows, added.inserted);
  });

  svg.addEventListener("keydown", (e) => {
    const target = e.target as Element;
    const raw = target.getAttribute("data-index");
    if (raw === null) return;
    const index = Number(raw);
    const { rows, extent } = current();
    const big = e.shiftKey ? 10 : 1;
    const xStep = (extent.xmax - extent.xmin) / 100;
    const yStep = (extent.ymax - extent.ymin) / 100;
    let next: TableRow[] | undefined;
    switch (e.key) {
      case "ArrowLeft": next = nudgePoint(rows, index, -big, 0, xStep, yStep); break;
      case "ArrowRight": next = nudgePoint(rows, index, big, 0, xStep, yStep); break;
      case "ArrowUp": next = nudgePoint(rows, index, 0, big, xStep, yStep); break;
      case "ArrowDown": next = nudgePoint(rows, index, 0, -big, xStep, yStep); break;
      case "Delete":
      case "Backspace": {
        const removed = removePoint(rows, index);
        e.preventDefault();
        const survivors = plotPoints(removed);
        const was = Math.max(0, plotPoints(rows).findIndex((p) => p.index === index));
        commit(removed, survivors.length > 0 ? survivors[Math.min(survivors.length - 1, was)].index : undefined);
        return;
      }
      default: return;
    }
    e.preventDefault();
    commit(next, index);
  });

  draw();
  return { element: root, refresh: draw };
}
