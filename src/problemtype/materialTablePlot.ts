/**
 * The geometry behind the materials-table plot: which grid rows are drawable,
 * how a table maps to a plot box, and how dragging, nudging, adding and
 * removing a point rewrite the rows. Pure: no vscode, no DOM, so the webview
 * chart and the Node tests share one definition of "what a drag does".
 *
 * Rules that are claims, and so stated here:
 * - A row is drawable only when both cells parse as finite numbers; a malformed
 *   row stays in the grid (and in the text) but is never drawn or moved.
 * - Kratos interpolates a table, so the input column must increase. A drag
 *   keeps each point strictly between its drawable neighbours; the output
 *   column is free.
 * - Values written back are rounded to {@link VALUE_DIGITS} significant digits,
 *   so a drag leaves tidy text instead of 17-digit doubles.
 */

import type { TableRow } from "./materialTables";

/** Significant digits written back to the grid after a drag or nudge. */
export const VALUE_DIGITS = 6;

/** A drawable grid row: its position in the rows array and its numeric pair. */
export interface PlotPoint {
  index: number;
  x: number;
  y: number;
}

export interface Extent {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** The drawing rectangle, in pixels, inside the chart's margins. */
export interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlotScale {
  toPx(x: number, y: number): [number, number];
  /** Pointer position to data values; positions outside the box clamp onto it. */
  fromPx(px: number, py: number): [number, number];
}

const finiteCell = (s: string): number | undefined => {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** Formats a value for the grid: short, and parsed back to the same number. */
export function formatValue(v: number): string {
  return String(Number(v.toPrecision(VALUE_DIGITS)));
}

/** The rows that can be drawn, in row order, each remembering its row index. */
export function plotPoints(rows: readonly TableRow[]): PlotPoint[] {
  const out: PlotPoint[] = [];
  rows.forEach((r, index) => {
    const x = finiteCell(r.input);
    const y = finiteCell(r.output);
    if (x !== undefined && y !== undefined) out.push({ index, x, y });
  });
  return out;
}

/** Whether the drawable points make a plottable curve (two or more). */
export function canPlot(rows: readonly TableRow[]): boolean {
  return plotPoints(rows).length >= 2;
}

/**
 * The data range with 6 % padding. A degenerate range (one value, or equal
 * values) opens to a unit span around it so the scales never divide by zero.
 */
export function plotExtent(points: readonly PlotPoint[]): Extent {
  if (points.length === 0) return { xmin: 0, xmax: 1, ymin: 0, ymax: 1 };
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x;
    if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  const pad = (lo: number, hi: number): [number, number] => {
    if (hi === lo) {
      const unit = lo === 0 ? 1 : Math.abs(lo) * 0.5;
      return [lo - unit, hi + unit];
    }
    const p = (hi - lo) * 0.06;
    return [lo - p, hi + p];
  };
  const [x0, x1] = pad(xmin, xmax);
  const [y0, y1] = pad(ymin, ymax);
  return { xmin: x0, xmax: x1, ymin: y0, ymax: y1 };
}

/** About `count` round tick values covering [min, max] (1/2/5 × 10^k steps). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step, guard = 0; t <= max + step * 1e-9 && guard < 100; t += step, guard++) {
    ticks.push(Number(t.toPrecision(12)));
  }
  return ticks;
}

/** Linear scales between an extent and a pixel box; y grows upward in data, downward in pixels. */
export function makeScale(extent: Extent, box: PlotBox): PlotScale {
  const xs = extent.xmax - extent.xmin || 1;
  const ys = extent.ymax - extent.ymin || 1;
  return {
    toPx: (x, y) => [
      box.left + ((x - extent.xmin) / xs) * box.width,
      box.top + (1 - (y - extent.ymin) / ys) * box.height,
    ],
    fromPx: (px, py) => {
      const cx = Math.min(box.left + box.width, Math.max(box.left, px));
      const cy = Math.min(box.top + box.height, Math.max(box.top, py));
      return [
        extent.xmin + ((cx - box.left) / box.width) * xs,
        extent.ymin + (1 - (cy - box.top) / box.height) * ys,
      ];
    },
  };
}

/** The row index of the point nearest the pointer within `radius` pixels, if any. */
export function hitPoint(
  points: readonly PlotPoint[],
  scale: PlotScale,
  px: number,
  py: number,
  radius: number
): number | undefined {
  let best: number | undefined;
  let bestD = radius * radius;
  for (const p of points) {
    const [qx, qy] = scale.toPx(p.x, p.y);
    const d = (qx - px) ** 2 + (qy - py) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = p.index;
    }
  }
  return best;
}

/** Rows with one row's cells replaced; every other row object is reused. */
function withRow(rows: readonly TableRow[], index: number, input: string, output: string): TableRow[] {
  return rows.map((r, i) => (i === index ? { input, output } : r));
}

/**
 * Where the input of the point on `rowIndex` may go: strictly between its
 * drawable neighbours (a margin of `span * 1e-3` keeps the order after the
 * value is rounded for the grid). Outer points are free on their open side.
 */
export function clampInput(rows: readonly TableRow[], rowIndex: number, x: number, span: number): number {
  const pts = plotPoints(rows);
  const at = pts.findIndex((p) => p.index === rowIndex);
  if (at < 0) return x;
  const margin = Math.abs(span) * 1e-3;
  const lo = at > 0 ? pts[at - 1].x + margin : -Infinity;
  const hi = at < pts.length - 1 ? pts[at + 1].x - margin : Infinity;
  if (lo > hi) return pts[at].x;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Moves the drawable point on `rowIndex` to (x, y), keeping the input column
 * increasing. `span` is the plot's x extent (the drag margin scales with it).
 * A row that is not drawable is returned unchanged.
 */
export function movePoint(rows: readonly TableRow[], rowIndex: number, x: number, y: number, span: number): TableRow[] {
  if (!plotPoints(rows).some((p) => p.index === rowIndex)) return rows.slice();
  const cx = clampInput(rows, rowIndex, x, span);
  return withRow(rows, rowIndex, formatValue(cx), formatValue(y));
}

/** Keyboard step: `dx`/`dy` are multiples of the given steps (data units). */
export function nudgePoint(
  rows: readonly TableRow[],
  rowIndex: number,
  dx: number,
  dy: number,
  xStep: number,
  yStep: number
): TableRow[] {
  const p = plotPoints(rows).find((q) => q.index === rowIndex);
  if (!p) return rows.slice();
  return movePoint(rows, rowIndex, p.x + dx * xStep, p.y + dy * yStep, xStep * 1000);
}

/**
 * Inserts a point at (x, y) in input order. A duplicate input (to the grid's
 * rounding) is refused, because a table cannot interpolate two outputs at one
 * input; the result then reports `inserted: undefined` and the rows unchanged.
 */
export function addPoint(
  rows: readonly TableRow[],
  x: number,
  y: number
): { rows: TableRow[]; inserted: number | undefined } {
  const fx = formatValue(x);
  const pts = plotPoints(rows);
  if (pts.some((p) => formatValue(p.x) === fx)) return { rows: rows.slice(), inserted: undefined };
  const next = pts.find((p) => p.x > Number(fx));
  const at = next ? next.index : pts.length > 0 ? pts[pts.length - 1].index + 1 : rows.length;
  const out = rows.slice();
  out.splice(at, 0, { input: fx, output: formatValue(y) });
  return { rows: out, inserted: at };
}

/** Removes a row; the grid always keeps at least one (empty) row to edit. */
export function removePoint(rows: readonly TableRow[], rowIndex: number): TableRow[] {
  const out = rows.filter((_, i) => i !== rowIndex);
  return out.length > 0 ? out : [{ input: "", output: "" }];
}
