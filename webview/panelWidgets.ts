// DOM widgets shared by the floating analysis panels (Mesh Size, Spheres).
//
// They render against the `.meshsize-*` / `.field-*` classes in style.css,
// which the panels already share (`#meshsize-panel, #sphere-panel` is one rule)
// — so the markup has to be shared too, or a second copy quietly drifts off the
// stylesheet. Pure DOM: no vtk, no model types.

import { COLORMAPS, gradientCss, gradientCssFromStops, ColorStop } from "./colormaps";

/** Compact numeric formatting for panel labels and legends. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(2);
  return v.toFixed(3);
}

/**
 * Six-significant-digit formatting for a value the reader is meant to READ
 * rather than glance at — a table cell, an integral total. `fmt` above is the
 * label/legend form and rounds to three, which is too lossy for a number
 * someone opened a panel specifically to look up.
 */
export function fmtPrecise(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 1e5 || a < 1e-3 ? v.toExponential(4) : v.toPrecision(6);
}

/**
 * Ink and font for a hand-drawn chart's axes and labels. A literal grey rather
 * than a theme token because it has to read on both light and dark and Canvas
 * cannot inherit a CSS variable — the same choice the histogram and the
 * box-whisker each made independently before this was shared.
 */
export const CHART_INK = "rgba(150,150,150,0.9)";
export const CHART_FONT = "9px var(--vscode-font-family, sans-serif)";

/**
 * Prepares a canvas for a hand-drawn chart: a device-pixel-ratio-scaled
 * backing store behind a CSS-pixel drawing surface, so the caller can plot in
 * CSS pixels and still get crisp lines on a HiDPI display.
 *
 * Call it from inside a `requestAnimationFrame` AFTER the canvas is in the
 * DOM — `clientWidth` is 0 until then, which is why every caller defers.
 *
 * Returns the CSS-pixel box to draw in, so callers stop re-deriving it. The
 * height is echoed back rather than measured because it is fixed by the CSS
 * rule for the canvas's class, and the two numbers must agree.
 */
export function setupChartCanvas(
  canvas: HTMLCanvasElement,
  cssH: number,
  fallbackW = 300
): { ctx: CanvasRenderingContext2D; w: number; h: number } | undefined {
  const w = canvas.clientWidth || fallbackW;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.scale(dpr, dpr);
  return { ctx, w, h: cssH };
}

/** A small-caps section heading. */
export function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "meshsize-section";
  el.textContent = text;
  return el;
}

/** A labelled colormap picker. */
export function colormapRow(
  selected: string,
  onChange: (name: string) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = "Colormap";
  row.appendChild(l);
  const sel = document.createElement("select");
  sel.className = "field-select";
  for (const cm of COLORMAPS) {
    const opt = document.createElement("option");
    opt.value = cm.name;
    opt.textContent = cm.name;
    if (cm.name === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  row.appendChild(sel);
  return row;
}

/** A colormap gradient bar with min / mid / max labels. */
export function legend(colormap: string, min: number, max: number): HTMLElement {
  return legendFromStops(gradientCss(colormap), [min, (min + max) / 2, max]);
}

/**
 * A gradient bar with arbitrary tick labels, built from an explicit stop list
 * (used when the gradient has been transformed — log scale, discrete bands —
 * so it no longer matches a plain named colormap).
 */
export function legendFromStops(
  background: string | ColorStop[],
  tickValues: number[]
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-legend";
  const bar = document.createElement("div");
  bar.className = "field-legend-gradient";
  bar.style.background = Array.isArray(background) ? gradientCssFromStops(background) : background;
  wrap.appendChild(bar);
  const labels = document.createElement("div");
  labels.className = "field-legend-labels";
  for (const v of tickValues) {
    const span = document.createElement("span");
    span.textContent = fmt(v);
    labels.appendChild(span);
  }
  wrap.appendChild(labels);
  return wrap;
}
