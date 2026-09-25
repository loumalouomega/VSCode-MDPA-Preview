/**
 * The line-probe panel — one nodal field along a probe line, distance-versus-
 * value, drawn with the shared chart scaffolding like the time-series panel.
 *
 * A fourth chart, but zero-to-one new ink: it reuses `setupChartCanvas`,
 * `CHART_INK` and the `.series-*` CSS family, differing from the series panel
 * in the abscissa's meaning (arclength, not step index) and in where the data
 * comes from — one `meshAnalysis` round trip for the CURRENT frame (the wasm is
 * host-only), not a multi-file scan.
 *
 * Two of the series panel's drawing rules carry over as correctness, not style:
 *  - a gap is a BREAK in the line, never a bridging segment — a line leaving
 *    the mesh must not draw a value that was never sampled there;
 *  - a non-finite value is a gap too.
 */

import type { ProbeResult } from "../src/parser/pathProbe";
import { glyph } from "../src/uiGlyphs";
import { CHART_FONT, CHART_INK, fmtPrecise, setupChartCanvas } from "./panelWidgets";

/** Must match `.series-chart { height }` in style.css. */
const CHART_H = 132;
const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 8;
const AXIS_H = 16;

/** One colour per component; the first is used for a scalar profile. */
const LINE_COLORS = ["#4e9af1", "#e0803a", "#5cb85c", "#c765d6", "#d95c5c"];

export interface ProbePanelState {
  /** Nodal fields offered (probe samples nodal data only). */
  variables: string[];
  variable?: string;
  samples: number;
  probe?: ProbeResult;
  /** Set instead of `probe` when the sampling could not run. */
  message?: string;
  /** The timeline step the shown profile belongs to; absent without a series. */
  stepLabel?: string;
  hoverIndex?: number;
}

export interface ProbePanelHandlers {
  onClose(): void;
  onVariable(variable: string): void;
  onSamples(n: number): void;
  onExport(): void;
}

/** Finite component value at a sample, or undefined for a gap. */
function valueAt(probe: ProbeResult, i: number, comp: number): number | undefined {
  const v = probe.rows[i].values[comp];
  return v !== null && Number.isFinite(v) ? v : undefined;
}

function valueRange(probe: ProbeResult): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < probe.rows.length; i++) {
    for (let c = 0; c < probe.components; c++) {
      const n = valueAt(probe, i, c);
      if (n === undefined) continue;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  }
  if (!Number.isFinite(lo)) return [0, 1];
  return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
}

export function renderProbePanel(
  container: HTMLElement,
  state: ProbePanelState,
  handlers: ProbePanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = `Line probe — ${state.variable ?? ""}${state.stepLabel ? ` · step ${state.stepLabel}` : ""}`;
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  const bar = document.createElement("div");
  bar.className = "series-toolbar";
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "Field";
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
  if (state.variable && !state.variables.includes(state.variable)) {
    const opt = document.createElement("option");
    opt.value = state.variable;
    opt.textContent = state.variable;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => handlers.onVariable(select.value));
  bar.appendChild(select);

  const sLabel = document.createElement("label");
  sLabel.className = "field-label";
  sLabel.textContent = "Samples";
  bar.appendChild(sLabel);
  const samples = document.createElement("input");
  samples.type = "number";
  samples.className = "field-select";
  samples.min = "2";
  samples.max = "100000";
  samples.step = "1";
  samples.value = String(state.samples);
  samples.title = "Equidistant samples along the line (2 to 100000)";
  samples.addEventListener("change", () => {
    const v = Math.round(Number(samples.value));
    if (Number.isFinite(v)) handlers.onSamples(Math.min(100000, Math.max(2, v)));
  });
  bar.appendChild(samples);

  const csv = document.createElement("button");
  csv.className = "panel-btn";
  csv.textContent = "CSV";
  csv.title = "Save the current profile as CSV";
  csv.disabled = !state.probe || state.probe.rows.length === 0;
  csv.addEventListener("click", () => handlers.onExport());
  bar.appendChild(csv);
  container.appendChild(bar);

  const note = (text: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "meshsize-summary";
    el.textContent = text;
    return el;
  };

  if (state.message) {
    container.appendChild(note(state.message));
    return;
  }
  const probe = state.probe;
  if (!probe) {
    container.appendChild(note("Sampling…"));
    return;
  }

  if (probe.components > 1) {
    const legend = document.createElement("div");
    legend.className = "series-legend";
    for (let c = 0; c < probe.columns.length; c++) {
      const item = document.createElement("span");
      item.className = "series-legend-item";
      const dot = document.createElement("span");
      dot.className = "series-dot";
      dot.style.background = LINE_COLORS[c % LINE_COLORS.length];
      item.appendChild(dot);
      item.appendChild(document.createTextNode(probe.columns[c] ?? `c${c}`));
      legend.appendChild(item);
    }
    container.appendChild(legend);
  }

  const canvas = document.createElement("canvas");
  canvas.className = "series-chart";
  container.appendChild(canvas);

  const readout = document.createElement("div");
  readout.className = "series-readout";
  container.appendChild(readout);

  const geom = { x0: 0, span: 1 };
  const rowAtX = (px: number): number | undefined => {
    if (probe.rows.length === 0) return undefined;
    const i = Math.round(((px - geom.x0) / geom.span) * (probe.rows.length - 1));
    return Math.min(Math.max(i, 0), probe.rows.length - 1);
  };

  const showReadout = (i: number | undefined): void => {
    if (i === undefined) {
      readout.textContent = "";
      return;
    }
    const row = probe.rows[i];
    const values = row.values.map((v, c) => `${probe.columns[c] ?? c} ${v === null ? "—" : fmtPrecise(v)}`);
    readout.textContent = `d ${fmtPrecise(row.distance)} (${i + 1}/${probe.rows.length}) — ${values.join(", ")}`;
  };
  showReadout(state.hoverIndex);

  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    showReadout(rowAtX(ev.clientX - rect.left));
  });
  canvas.addEventListener("mouseleave", () => showReadout(undefined));

  requestAnimationFrame(() => {
    const g = drawProfile(canvas, probe);
    if (g) {
      geom.x0 = g.x0;
      geom.span = g.span;
    }
  });

  if (probe.uncovered > 0) {
    const el = document.createElement("div");
    el.className = "series-caveats";
    el.textContent =
      `${probe.uncovered} of ${probe.rows.length} samples are uncovered — the line leaves the mesh` +
      ` or crosses a region where the field is not written.`;
    container.appendChild(el);
  }
}

/** Draws the profile and fills the x mapping used by hover hit-testing. */
function drawProfile(
  canvas: HTMLCanvasElement,
  probe: ProbeResult
): { x0: number; span: number } | undefined {
  const setup = setupChartCanvas(canvas, CHART_H);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const n = probe.rows.length;
  const plotW = w - PAD_L - PAD_R;
  const plotH = h - PAD_T - AXIS_H;
  const [lo, hi] = valueRange(probe);
  const span = hi - lo;
  const x = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - ((v - lo) / span) * plotH;
  const x0 = x(0);
  const xSpan = x(n - 1) - x0;

  ctx.strokeStyle = CHART_INK;
  ctx.fillStyle = CHART_INK;
  ctx.font = CHART_FONT;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, PAD_T + plotH);
  ctx.lineTo(PAD_L + plotW, PAD_T + plotH);
  ctx.stroke();

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of [0, 0.5, 1]) {
    ctx.fillText(fmtPrecise(lo + span * t), PAD_L - 4, y(lo + span * t));
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const t of [0, 0.5, 1]) {
    const row = probe.rows[Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))];
    ctx.fillText(fmtPrecise(row.distance), x0 + t * xSpan, PAD_T + plotH + AXIS_H - 2);
  }

  // One line per component, broken across every gap — bridGING a null draws
  // data that was never sampled, the exact lie a gap exists to prevent.
  for (let c = 0; c < probe.components; c++) {
    ctx.strokeStyle = LINE_COLORS[c % LINE_COLORS.length];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = valueAt(probe, i, c);
      if (v === undefined) {
        pen = false;
        continue;
      }
      const px = x(i);
      const py = y(v);
      if (!pen) {
        ctx.moveTo(px, py);
        pen = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
  return { x0, span: xSpan };
}

/**
 * The probe as CSV, built from the `ProbeResult` the webview already holds —
 * the seriesExport direction (the webview owns a few hundred numbers; the host
 * would have to re-run the sampling). Columns match `probeToCsv`'s shape;
 * that function cannot cross into this bundle because `pathProbe.ts` pulls the
 * wasm host loader through `meshCompare.ts`.
 */
export function probeResultToCsv(probe: ProbeResult): string {
  const lines = [["distance", "x", "y", "z", ...probe.columns].join(",")];
  for (const row of probe.rows) {
    lines.push([row.distance, ...row.position, ...row.values.map((v) => (v === null ? "" : v))].join(","));
  }
  return lines.join("\n") + "\n";
}
