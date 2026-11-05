/**
 * The ALE mesh quality panel (roadmap item 46): did the mesh solver keep the fluid mesh
 * valid over the run? A scan over every frame (host side, `aleSeries`, the same
 * `aleQualitySeries` core MCP `mesh_ale_quality` calls) compares each element's signed
 * measure and shape quality on the deformed coordinates with the same element at the first
 * usable frame. This panel draws the worst-shape-ratio curve and lists the frames; a click
 * goes to that frame, "Go to worst frame" jumps to the worst one and "Select worst elements"
 * turns that frame's inverted (or, failing that, worst) elements into a selection set.
 *
 * Pure DOM + Canvas 2D in the `.meshsize-*` chrome. Read-only: nothing here is an OpRecord.
 */
import { t } from "../src/parser/i18n/runtime";
import { glyph } from "../src/uiGlyphs";
import type { AleFrame, AleSeries } from "../src/parser/aleQuality";
import { CHART_FONT, CHART_INK, setupChartCanvas, fmtPrecise as fmt } from "./panelWidgets";

export interface AlePanelState {
  /** Displacement variable; blank = MESH_DISPLACEMENT. */
  variable: string;
  /** Nodal vector fields the mesh carries, for the datalist. */
  vectors: string[];
  series?: AleSeries;
  progress?: { done: number; total: number; label: string };
  message?: string;
  historyNote?: string;
  /** Frame index on screen. */
  currentFrame?: number;
}

export interface AlePanelHandlers {
  onClose(): void;
  onScan(): void;
  onCancel(): void;
  onPickFrame(frameIndex: number): void;
  onWorst(): void;
  onSelectWorst(): void;
  onExport(): void;
}

export function renderAlePanel(container: HTMLElement, state: AlePanelState, h: AlePanelHandlers): void {
  container.textContent = "";
  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = t("ALE mesh quality");
  header.appendChild(title);
  const close = document.createElement("button");
  close.className = "meshsize-close";
  close.title = t("Close");
  close.innerHTML = glyph("x");
  close.addEventListener("click", () => h.onClose());
  header.appendChild(close);
  container.appendChild(header);

  const bar = document.createElement("div");
  bar.className = "series-toolbar";
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = t("Displacement");
  bar.appendChild(label);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "field-select";
  input.placeholder = "MESH_DISPLACEMENT";
  input.value = state.variable;
  input.setAttribute("list", "ale-vectors");
  input.addEventListener("input", () => (state.variable = input.value.trim()));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") h.onScan(); });
  bar.appendChild(input);
  const list = document.createElement("datalist");
  list.id = "ale-vectors";
  for (const v of state.vectors) {
    const o = document.createElement("option");
    o.value = v;
    list.appendChild(o);
  }
  bar.appendChild(list);
  container.appendChild(bar);

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const btn = (text: string, fn: () => void, disabled = false): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "panel-btn";
    b.textContent = text;
    b.disabled = disabled;
    b.addEventListener("click", fn);
    actions.appendChild(b);
    return b;
  };
  const scanning = !!state.progress;
  if (scanning) btn(t("Cancel"), () => h.onCancel());
  else btn(t("Scan all frames"), () => h.onScan());
  const series = state.series;
  const have = !!series && series.worstFrame !== undefined;
  btn(t("Go to worst frame"), () => h.onWorst(), !have);
  btn(t("Select worst elements"), () => h.onSelectWorst(), !have);
  btn(t("Export CSV"), () => h.onExport(), !series || series.frames.length === 0);
  container.appendChild(actions);

  const note = (text: string, error = false): void => {
    const el = document.createElement("div");
    el.className = "meshsize-summary";
    if (error) el.classList.add("flow-error");
    el.textContent = text;
    container.appendChild(el);
  };
  if (state.progress) note(`${t("Scanning")} ${state.progress.done}/${state.progress.total} ${state.progress.label}`);
  if (state.message) note(state.message, true);
  if (state.historyNote) note(state.historyNote);
  if (!series) {
    if (!state.progress && !state.message)
      note(t("Compares every element on the deformed mesh with its first-frame shape. Needs a time series with a nodal displacement."));
    return;
  }
  if (series.cancelled) note(t("Scan cancelled; showing the frames measured so far."));
  const measured = series.frames.filter((f) => f.minShapeRatio !== undefined);
  if (measured.length === 0) {
    note(t("No frame could be measured."), true);
  } else {
    const worst = series.worstFrame !== undefined ? series.frames[series.worstFrame] : undefined;
    const invertedFrames = measured.filter((f) => (f.inverted ?? 0) > 0).length;
    note(
      `${series.frames.length} ${t("frames")} · ${t("reference")} ${series.referenceLabel ?? "?"} · ` +
        (invertedFrames === 0 ? t("no inverted element") : `${invertedFrames} ${t("frame(s) with inverted elements")}`) +
        (worst ? ` · ${t("worst")} ${worst.label}: ${fmt(worst.minShapeRatio ?? 0)}` : "")
    );
    drawChart(container, series.frames, state.currentFrame, h);
  }
  container.appendChild(frameTable(series.frames, state.currentFrame, series.worstFrame, h));
}

function drawChart(container: HTMLElement, frames: AleFrame[], current: number | undefined, h: AlePanelHandlers): void {
  const canvas = document.createElement("canvas");
  canvas.className = "series-canvas";
  canvas.style.width = "100%";
  container.appendChild(canvas);
  const surface = setupChartCanvas(canvas, 120);
  if (!surface) return;
  const { ctx, w } = surface;
  const pts = frames.map((f, i) => ({ i, y: f.minShapeRatio }));
  const ys = pts.map((p) => p.y).filter((y): y is number => y !== undefined);
  const lo = Math.min(0, ...ys), hi = Math.max(1, ...ys);
  const padL = 34, padR = 8, padT = 8, padB = 16, H = 120;
  const X = (i: number): number => padL + (frames.length <= 1 ? 0 : (i / (frames.length - 1)) * (w - padL - padR));
  const Y = (v: number): number => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  ctx.font = CHART_FONT;
  ctx.fillStyle = CHART_INK;
  ctx.strokeStyle = CHART_INK;
  ctx.lineWidth = 1;
  // zero line: a flat or inverted element sits at or below it
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(w - padR, Y(0)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText(fmt(hi), 2, padT + 8);
  ctx.fillText(fmt(lo), 2, H - padB);
  ctx.strokeStyle = "#4da3ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (p.y === undefined) { pen = false; continue; }
    if (pen) ctx.lineTo(X(p.i), Y(p.y)); else ctx.moveTo(X(p.i), Y(p.y));
    pen = true;
  }
  ctx.stroke();
  for (const p of pts) {
    if (p.y === undefined) continue;
    ctx.fillStyle = (frames[p.i].inverted ?? 0) > 0 ? "#ff5a5a" : "#4da3ff";
    ctx.beginPath(); ctx.arc(X(p.i), Y(p.y), p.i === current ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
  }
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let best = 0, bd = Infinity;
    frames.forEach((_, i) => { const d = Math.abs(X(i) - x); if (d < bd) { bd = d; best = i; } });
    h.onPickFrame(frames[best].frameIndex);
  });
}

function frameTable(frames: AleFrame[], current: number | undefined, worst: number | undefined, h: AlePanelHandlers): HTMLElement {
  const table = document.createElement("table");
  table.className = "meshsize-table";
  const head = document.createElement("tr");
  for (const c of [t("Frame"), t("Min shape"), t("Min measure"), t("Inverted")]) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  table.appendChild(head);
  frames.forEach((f, i) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    if (f.frameIndex === current) tr.style.fontWeight = "600";
    const cells = f.error
      ? [f.label, f.error, "", ""]
      : [f.label + (i === worst ? " ★" : ""), fmt(f.minShapeRatio ?? 0), fmt(f.minMeasureRatio ?? 0), String(f.inverted ?? 0)];
    cells.forEach((text, k) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (k === 3 && (f.inverted ?? 0) > 0) td.style.color = "#ff5a5a";
      if (f.error && k === 1) td.colSpan = 3;
      if (!(f.error && k > 1)) tr.appendChild(td);
    });
    tr.addEventListener("click", () => h.onPickFrame(f.frameIndex));
    table.appendChild(tr);
  });
  return table;
}
