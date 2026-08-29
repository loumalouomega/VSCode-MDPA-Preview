/**
 * The time-series panel — one entity's field value across every step of a VTK
 * time series, as a hand-drawn line chart.
 *
 * Pure DOM + Canvas 2D, like qualityPanel.ts's histogram and meshSizePanel.ts's
 * box-whisker (no charting library is bundled and the CSP forbids loading one),
 * and it shares their canvas setup through `setupChartCanvas` — a third chart
 * is where that extraction earns its keep.
 *
 * It computes nothing: the scan runs on the host, because the webview holds
 * exactly one frame at a time and cannot read files. This panel is therefore
 * the second one with a genuine "waiting" state, and the first with progress
 * and a cancel button.
 *
 * Two drawing rules that are correctness, not style:
 *  - a gap is a BREAK in the line, never a bridging segment — joining across a
 *    missing step would draw data that does not exist;
 *  - a non-finite value is a gap too, matching how `computeFieldRange` already
 *    skips them when scaling a colormap.
 */

import { FieldSeries } from "../src/parser/fieldSeries";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { CHART_FONT, CHART_INK, fmtPrecise, setupChartCanvas } from "./panelWidgets";

/** Must match `.series-chart { height }` in style.css. */
const CHART_H = 132;
const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 8;
const AXIS_H = 16;

/** One colour per component; the first is used for a scalar series. */
const LINE_COLORS = ["#4e9af1", "#e0803a", "#5cb85c", "#c765d6", "#d95c5c"];

export interface SeriesPanelState {
  /** What is being plotted — stashed here because main.ts's inspectSelection
   *  is wiped on every frame arrival. */
  entity: { kind: "Nodal" | "Elemental" | "Conditional"; id: number; label: string };
  /** Variables offered, taken from the Inspect selection's own field list. */
  variables: string[];
  variable?: string;
  series?: FieldSeries;
  /** Set while a scan is in flight. */
  progress?: { done: number; total: number; label: string };
  /** The step the 3D view is showing, drawn as a vertical rule. */
  currentFrameIndex?: number;
  hoverIndex?: number;
  /** Set instead of `series` when the scan could not run. */
  message?: string;
  /** Applied edit operations are not replayed per step — see the provider. */
  historyNote?: string;
}

export interface SeriesPanelHandlers {
  onClose(): void;
  onVariable(variable: string): void;
  onCancel(): void;
  onPickStep(frameIndex: number): void;
  onHover(index: number | undefined): void;
  onExport(): void;
}

/** Finite component value at a step, or undefined for a gap. */
function valueAt(series: FieldSeries, step: number, comp: number): number | undefined {
  const v = series.values[step];
  if (!v) return undefined;
  const n = v[comp];
  return Number.isFinite(n) ? n : undefined;
}

function finiteRange(series: FieldSeries): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s < series.values.length; s++) {
    for (let c = 0; c < series.components; c++) {
      const n = valueAt(series, s, c);
      if (n === undefined) continue;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  if (!Number.isFinite(lo)) return [0, 1];
  // A flat series still needs a band to draw in.
  return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
}

export function renderSeriesPanel(
  container: HTMLElement,
  state: SeriesPanelState,
  handlers: SeriesPanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = `Over time — ${state.entity.label}`;
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  container.appendChild(buildToolbar(state, handlers));

  if (state.message) {
    container.appendChild(note(state.message));
    return;
  }
  if (state.progress) {
    const p = state.progress;
    // The host has not reported a total yet on the very first render, and
    // "step 0/0" reads like a bug rather than a start.
    container.appendChild(
      note(
        p.total > 0
          ? `Reading step ${Math.min(p.done + 1, p.total)}/${p.total}${p.label ? ` (${p.label})` : ""}…`
          : "Reading the time series…"
      )
    );
    const bar = document.createElement("div");
    bar.className = "series-bar";
    const fill = document.createElement("div");
    fill.className = "series-bar-fill";
    fill.style.width = `${p.total > 0 ? Math.round((p.done / p.total) * 100) : 0}%`;
    bar.appendChild(fill);
    container.appendChild(bar);
    return;
  }
  const series = state.series;
  if (!series) {
    container.appendChild(note("Pick a variable to plot."));
    return;
  }
  if (series.present === 0) {
    container.appendChild(
      note(
        series.missingField > 0
          ? `${series.variable} is not defined at this entity in any of the ${series.labels.length} steps.`
          : `${state.entity.label} is absent from all ${series.labels.length} steps.`
      )
    );
    return;
  }

  container.appendChild(buildLegend(series));

  const canvas = document.createElement("canvas");
  canvas.className = "series-chart";
  container.appendChild(canvas);

  const readout = document.createElement("div");
  readout.className = "series-readout";
  container.appendChild(readout);

  const geom = { x0: 0, span: 1 };
  const stepAtX = (px: number): number | undefined => {
    if (series.labels.length === 0) return undefined;
    const i = Math.round(((px - geom.x0) / geom.span) * (series.labels.length - 1));
    return Math.min(Math.max(i, 0), series.labels.length - 1);
  };

  const showReadout = (i: number | undefined): void => {
    if (i === undefined) {
      readout.textContent = "";
      return;
    }
    const v = series.values[i];
    readout.textContent =
      `step ${series.labels[i]} (${i + 1}/${series.labels.length}) — ` +
      (v ? v.map(fmtPrecise).join(", ") : "no value");
  };
  showReadout(state.hoverIndex);

  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const i = stepAtX(ev.clientX - rect.left);
    showReadout(i);
    handlers.onHover(i);
  });
  canvas.addEventListener("mouseleave", () => {
    showReadout(undefined);
    handlers.onHover(undefined);
  });
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const i = stepAtX(ev.clientX - rect.left);
    if (i !== undefined) handlers.onPickStep(series.frameIndices[i]);
  });

  // clientWidth is 0 until the canvas is in the layout — the same reason the
  // other two charts defer a frame.
  requestAnimationFrame(() => {
    const g = drawSeries(canvas, series, state);
    if (g) {
      geom.x0 = g.x0;
      geom.span = g.span;
    }
  });

  const caveats = buildCaveats(series, state);
  if (caveats) container.appendChild(caveats);
}

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "meshsize-summary";
  el.textContent = text;
  return el;
}

function buildToolbar(state: SeriesPanelState, handlers: SeriesPanelHandlers): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "series-toolbar";

  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "Variable";
  bar.appendChild(label);

  const select = document.createElement("select");
  select.className = "field-select";
  for (const v of state.variables) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    if (v === state.variable) opt.selected = true;
    select.appendChild(opt);
  }
  select.disabled = Boolean(state.progress) || state.variables.length === 0;
  select.addEventListener("change", () => handlers.onVariable(select.value));
  bar.appendChild(select);

  if (state.progress) {
    const cancel = document.createElement("button");
    cancel.className = "meshsize-mode-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => handlers.onCancel());
    bar.appendChild(cancel);
  } else {
    const csv = document.createElement("button");
    csv.className = "meshsize-mode-btn";
    csv.textContent = "CSV";
    csv.title = "Save this series as CSV";
    csv.disabled = !state.series || state.series.present === 0;
    csv.addEventListener("click", () => handlers.onExport());
    bar.appendChild(csv);
  }
  return bar;
}

function buildLegend(series: FieldSeries): HTMLElement {
  const row = document.createElement("div");
  row.className = "series-legend";
  for (let c = 0; c < series.components; c++) {
    const item = document.createElement("span");
    item.className = "series-legend-item";
    const dot = document.createElement("span");
    dot.className = "series-dot";
    dot.style.background = LINE_COLORS[c % LINE_COLORS.length];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(series.componentNames[c] ?? `c${c}`));
    row.appendChild(item);
  }
  return row;
}

/** The honest footnotes: what was missing, what changed, what is not applied. */
function buildCaveats(series: FieldSeries, state: SeriesPanelState): HTMLElement | undefined {
  const parts: string[] = [];
  const total = series.labels.length;
  if (series.missingId > 0) {
    parts.push(`${state.entity.label} is absent from ${series.missingId} of ${total} steps.`);
  }
  if (series.missingField > 0) {
    parts.push(`${series.variable} is not written in ${series.missingField} of ${total} steps.`);
  }
  if (series.topologyChangedAt !== undefined) {
    parts.push(
      `The mesh changes size at step ${series.labels[series.topologyChangedAt]} — ` +
        `id ${series.entityId} may not be the same entity after it.`
    );
  }
  if (series.errors.length > 0) {
    parts.push(`${series.errors.length} step(s) could not be read: ${series.errors[0].message}`);
  }
  if (series.cancelled) parts.push("Scan cancelled — this is a partial series.");
  if (state.historyNote) parts.push(state.historyNote);
  if (parts.length === 0) return undefined;
  const el = document.createElement("div");
  el.className = "series-caveats";
  el.textContent = parts.join(" ");
  return el;
}

/** Draws the chart and returns the x mapping, so hit-testing matches the ink. */
function drawSeries(
  canvas: HTMLCanvasElement,
  series: FieldSeries,
  state: SeriesPanelState
): { x0: number; span: number } | undefined {
  const setup = setupChartCanvas(canvas, CHART_H);
  if (!setup) return undefined;
  const { ctx, w, h } = setup;

  const n = series.labels.length;
  const plotW = w - PAD_L - PAD_R;
  const plotH = h - PAD_T - AXIS_H;
  const [lo, hi] = finiteRange(series);
  const span = hi - lo;
  const x = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - ((v - lo) / span) * plotH;

  ctx.strokeStyle = CHART_INK;
  ctx.fillStyle = CHART_INK;
  ctx.font = CHART_FONT;
  ctx.lineWidth = 1;

  // Axes: two lines and three y ticks — enough to read a value off, without
  // becoming a grid.
  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, PAD_T + plotH);
  ctx.lineTo(PAD_L + plotW, PAD_T + plotH);
  ctx.stroke();

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of [0, 0.5, 1]) {
    const v = lo + span * t;
    ctx.fillText(fmtPrecise(v), PAD_L - 4, y(v));
  }

  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(series.labels[0] ?? "", PAD_L, h);
  if (n > 1) {
    ctx.textAlign = "right";
    ctx.fillText(series.labels[n - 1] ?? "", PAD_L + plotW, h);
  }

  // "You are here": the step the 3D view is showing.
  const cur = state.currentFrameIndex;
  if (cur !== undefined) {
    const at = series.frameIndices.indexOf(cur);
    if (at >= 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(120,180,255,0.55)";
      ctx.beginPath();
      ctx.moveTo(x(at), PAD_T);
      ctx.lineTo(x(at), PAD_T + plotH);
      ctx.stroke();
      ctx.restore();
    }
  }

  for (let c = 0; c < series.components; c++) {
    ctx.strokeStyle = LINE_COLORS[c % LINE_COLORS.length];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = valueAt(series, i, c);
      if (v === undefined) {
        // Break the line rather than bridge the gap: a straight segment across
        // a missing step is data the file does not contain.
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(i), y(v));
      else ctx.moveTo(x(i), y(v));
      pen = true;
    }
    ctx.stroke();
    // Points, so a one-step island is still visible.
    for (let i = 0; i < n; i++) {
      const v = valueAt(series, i, c);
      if (v === undefined) continue;
      ctx.beginPath();
      ctx.arc(x(i), y(v), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { x0: PAD_L, span: plotW };
}
