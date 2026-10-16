/**
 * The Optimization progress panel: how an OptimizationApplication run is going,
 * read from the summary file the optimizer writes (the host reads it through
 * the same parser the Kratos Runs row and MCP `case_optimization` use — see
 * src/problemtype/optimization/summaryLog.ts — and posts `optimizationProgress`).
 *
 * Pure DOM in the shared `.meshsize-*` chrome, with two hand-drawn charts on the
 * `setupChartCanvas` surface: the objective against the optimization step, and
 * each constraint's standardized value (at or below zero is satisfied) against a
 * dashed zero line. A gap (a cell that is not a number) breaks the line rather
 * than being bridged.
 */

import { glyph } from "../src/uiGlyphs";
import type { OptimizationSummary, SummaryCell } from "../src/problemtype/optimization/summaryLog";
import { optimizationRowText } from "../src/problemtype/optimization/summaryLog";
import { CHART_FONT, CHART_INK, fmtPrecise as fmt, setupChartCanvas } from "./panelWidgets";

export interface OptimizationPanelState {
  /** False until the host answered, or when the preview belongs to no optimization case. */
  available: boolean;
  received: boolean;
  caseName?: string;
  reason?: string;
  formulation?: string;
  designFields?: boolean;
  summary?: OptimizationSummary;
  columns: string[];
  rows: { step: number; cells: SummaryCell[] }[];
  totalRows: number;
  warnings: string[];
}

export interface OptimizationPanelHandlers {
  onClose(): void;
  onRefresh(): void;
  onPlot(): void;
  onDesignFields(): void;
  onExport(): void;
  onExportCad(): void;
}

export function emptyOptimizationPanelState(): OptimizationPanelState {
  return { available: false, received: false, columns: [], rows: [], totalRows: 0, warnings: [] };
}

const CHART_H = 110;
/** Axis labels: three significant digits, exponential when very large or small. */
const axisLabel = (v: number): string => (v !== 0 && (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-2) ? v.toExponential(2) : String(Number(v.toPrecision(3))));
const SERIES_COLORS = ["#4daafc", "#e5c07b", "#c678dd", "#98c379", "#e06c75", "#56b6c2"];

function columnValues(state: OptimizationPanelState, name: string): (number | null)[] {
  const i = state.columns.indexOf(name);
  return state.rows.map((r) => {
    const c = i < 0 ? null : r.cells[i];
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  });
}

/** Draws one or more line series over the steps; gaps break the line. */
function drawChart(
  canvas: HTMLCanvasElement,
  steps: number[],
  series: { name: string; values: (number | null)[]; color: string }[],
  zeroLine: boolean
): void {
  requestAnimationFrame(() => {
    const surface = setupChartCanvas(canvas, CHART_H);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const pad = { l: 54, r: 8, t: 8, b: 16 };
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (zeroLine) all.push(0);
    if (all.length === 0 || steps.length === 0) {
      ctx.fillStyle = CHART_INK;
      ctx.font = CHART_FONT;
      ctx.fillText("no values yet", pad.l, h / 2);
      return;
    }
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (lo === hi) {
      const d = Math.abs(lo) || 1;
      lo -= d * 0.5;
      hi += d * 0.5;
    }
    const s0 = steps[0];
    const s1 = steps[steps.length - 1] === s0 ? s0 + 1 : steps[steps.length - 1];
    const x = (s: number): number => pad.l + ((s - s0) / (s1 - s0)) * (w - pad.l - pad.r);
    const y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
    ctx.strokeStyle = CHART_INK;
    ctx.fillStyle = CHART_INK;
    ctx.font = CHART_FONT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.lineTo(w - pad.r, h - pad.b);
    ctx.stroke();
    ctx.fillText(axisLabel(hi), 2, pad.t + 8);
    ctx.fillText(axisLabel(lo), 2, h - pad.b);
    ctx.fillText(String(s0), pad.l, h - 3);
    ctx.fillText(String(steps[steps.length - 1]), w - pad.r - 16, h - 3);
    if (zeroLine && lo < 0 && hi > 0) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.l, y(0));
      ctx.lineTo(w - pad.r, y(0));
      ctx.stroke();
      ctx.restore();
    }
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = 1.5;
      let open = false;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        if (v === null) {
          open = false;
          return;
        }
        if (open) ctx.lineTo(x(steps[i]), y(v));
        else ctx.moveTo(x(steps[i]), y(v));
        open = true;
      });
      ctx.stroke();
      s.values.forEach((v, i) => {
        if (v === null) return;
        ctx.fillRect(x(steps[i]) - 1.5, y(v) - 1.5, 3, 3);
      });
    }
  });
}

function legend(series: { name: string; color: string }[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "opt-legend";
  for (const s of series) {
    const item = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = "opt-swatch";
    swatch.style.background = s.color;
    const text = document.createElement("span");
    text.textContent = s.name;
    item.append(swatch, text);
    box.appendChild(item);
  }
  return box;
}

export function renderOptimizationPanel(container: HTMLElement, state: OptimizationPanelState, handlers: OptimizationPanelHandlers): void {
  container.textContent = "";
  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = state.caseName ? `Optimization — ${state.caseName}` : "Optimization progress";
  const close = document.createElement("button");
  close.className = "meshsize-close";
  close.title = "Close";
  close.innerHTML = glyph("x");
  close.addEventListener("click", () => handlers.onClose());
  header.append(title, close);
  container.appendChild(header);

  const line = (text: string, className = "meshsize-summary"): HTMLElement => {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    container.appendChild(el);
    return el;
  };

  if (!state.received) {
    line("Reading the optimization summary…");
    return;
  }
  if (state.formulation) line(state.formulation, "opt-formulation");
  if (state.summary) line(optimizationRowText(state.summary).replace(/^Optimization — /, ""), "opt-verdict");
  if (!state.available || !state.summary || state.rows.length === 0) {
    line(state.reason ?? "No optimization iterations have been written yet.");
  }

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const button = (label: string, tip: string, onClick: () => void, disabled = false): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "panel-btn";
    b.textContent = label;
    b.title = tip;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    actions.appendChild(b);
  };
  const noRows = state.rows.length === 0;
  button("Refresh", "Read the summary file again", handlers.onRefresh);
  button("Open in Plots", "Objective and constraints in the plotting workspace", handlers.onPlot, noRows);
  button("Design fields", "Open the per-iteration controls and gradients in the timeline viewer", handlers.onDesignFields, !state.designFields);
  button("Export CSV", "Save the summary rows shown as CSV", handlers.onExport, noRows);
  button("Export CAD", "Write the final optimized geometry as STEP (shape as-is, or a density level set)", handlers.onExportCad, !state.designFields);
  container.appendChild(actions);

  const summary = state.summary;
  if (summary && !noRows) {
    const steps = state.rows.map((r) => r.step);
    if (summary.objective) {
      const card = document.createElement("div");
      card.className = "meshsize-card";
      const cardTitle = document.createElement("div");
      cardTitle.className = "meshsize-card-title";
      const change = summary.objective.changePercent;
      cardTitle.textContent = `Objective — ${summary.objective.response}${summary.objective.current !== undefined ? ` = ${fmt(summary.objective.current)}` : ""}${change !== undefined ? ` (${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)}%)` : ""}`;
      const canvas = document.createElement("canvas");
      canvas.className = "opt-chart";
      card.append(cardTitle, canvas);
      container.appendChild(card);
      drawChart(canvas, steps, [{ name: summary.objective.response, values: columnValues(state, `${summary.objective.response}:value`), color: SERIES_COLORS[0] }], false);
    }
    if (summary.constraints.length > 0) {
      const card = document.createElement("div");
      card.className = "meshsize-card";
      const cardTitle = document.createElement("div");
      cardTitle.className = "meshsize-card-title";
      cardTitle.textContent = "Constraints — standardized value (≤ 0 is satisfied)";
      const canvas = document.createElement("canvas");
      canvas.className = "opt-chart";
      const series = summary.constraints.map((c, i) => ({
        name: `${c.response} ${c.type}${c.satisfied === undefined ? " (unknown)" : c.satisfied ? " ✓" : " ✗"}`,
        values: columnValues(state, `${c.response}:std_value`),
        color: SERIES_COLORS[(i + 1) % SERIES_COLORS.length],
      }));
      card.append(cardTitle, canvas, legend(series));
      container.appendChild(card);
      drawChart(canvas, steps, series, true);
    }

    const table = document.createElement("table");
    table.className = "meshsize-table opt-table";
    const head = document.createElement("tr");
    for (const name of ["STEP", ...state.columns]) {
      const th = document.createElement("th");
      th.textContent = name;
      th.title = name;
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const r of [...state.rows].reverse().slice(0, 50)) {
      const tr = document.createElement("tr");
      const stepCell = document.createElement("td");
      stepCell.textContent = String(r.step);
      tr.appendChild(stepCell);
      for (const c of r.cells) {
        const td = document.createElement("td");
        td.textContent = c === null ? "" : typeof c === "number" ? fmt(c) : String(c);
        td.title = c === null ? "no value" : String(c);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    const wrap = document.createElement("div");
    wrap.className = "opt-table-wrap";
    wrap.appendChild(table);
    container.appendChild(wrap);
    if (state.totalRows > state.rows.length) line(`Showing the last ${state.rows.length} of ${state.totalRows} steps; Open in Plots and Export use them all.`);
  }
  for (const w of state.warnings) line(w, "meshsize-summary opt-warning");
}
