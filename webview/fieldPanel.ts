// Floating panel for field visualization: a variable selector, a set of
// independently-toggleable mode buttons (contour, quiver, isosurface, deformed
// shape — combinable), a colormap dropdown with a live legend, and the
// mode-specific controls (isosurface value slider, quiver scale, deformation
// field + scale). Pure DOM — mirrors qualityPanel.ts.

import { FieldInfo } from "./fieldData";
import { COLORMAPS, gradientCss } from "./colormaps";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";

export type FieldMode = "contour" | "quiver" | "iso" | "deformed";

export interface FieldPanelState {
  infos: FieldInfo[];
  selectedKey: string;
  /** The set of currently-active modes (combinable). */
  modes: Set<FieldMode>;
  colormap: string;
  isoValue: number;
  scale: number; // quiver arrow scale
  /** The vector field driving the deformation (own selector, may differ from the coloring field). */
  deformKey: string;
  deformScale: number;
  hasVolume: boolean; // mesh has volume cells (isosurface produces surfaces, else iso-lines)
}

export interface FieldPanelHandlers {
  onClose(): void;
  onSelectVariable(key: string): void;
  onToggleMode(mode: FieldMode): void;
  onSelectColormap(name: string): void;
  onIsoValue(v: number): void;
  onScale(v: number): void;
  onSelectDeformField(key: string): void;
  onDeformScale(v: number): void;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(2);
  return v.toFixed(3);
}

function selectedInfo(state: FieldPanelState): FieldInfo | undefined {
  return state.infos.find((i) => i.key === state.selectedKey);
}

function vectorInfos(state: FieldPanelState): FieldInfo[] {
  return state.infos.filter((i) => i.isVector);
}

export function renderFieldPanel(
  container: HTMLElement,
  state: FieldPanelState,
  handlers: FieldPanelHandlers
): void {
  container.textContent = "";

  // --- header ---
  const header = document.createElement("div");
  header.className = "field-header";
  const title = document.createElement("div");
  title.className = "field-title";
  title.textContent = "Field";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  if (state.infos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "field-summary";
    empty.textContent =
      "No NodalData / ElementalData / ConditionalData blocks in this file.";
    container.appendChild(empty);
    return;
  }

  const info = selectedInfo(state);

  // --- variable dropdown ---
  container.appendChild(labeledRow("Variable", buildVariableSelect(state, handlers)));

  // --- mode selector (multi-toggle) ---
  container.appendChild(labeledRow("Modes", buildModeSelect(state, info, handlers)));
  const hint = document.createElement("div");
  hint.className = "field-summary field-modes-hint";
  hint.textContent = "Toggle any combination.";
  container.appendChild(hint);

  // --- colormap dropdown + legend (used by contour / quiver) ---
  if (info && (state.modes.has("contour") || state.modes.has("quiver"))) {
    container.appendChild(labeledRow("Colormap", buildColormapSelect(state, handlers)));
    container.appendChild(buildLegend(state, info));
  }

  // --- iso controls ---
  if (info && !info.isVector && state.modes.has("iso")) {
    if (!state.hasVolume) {
      const note = document.createElement("div");
      note.className = "field-summary";
      note.textContent = "2D / surface mesh: showing iso-lines.";
      container.appendChild(note);
    }
    container.appendChild(buildIsoSlider(state, info, handlers));
  }

  // --- quiver controls ---
  if (info && info.isVector && state.modes.has("quiver")) {
    container.appendChild(buildScaleSlider(state, handlers));
  }

  // --- deformed-shape controls ---
  if (state.modes.has("deformed")) {
    container.appendChild(buildDeformControls(state, handlers));
  }
}

function labeledRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = label;
  row.appendChild(l);
  row.appendChild(control);
  return row;
}

function buildVariableSelect(state: FieldPanelState, handlers: FieldPanelHandlers): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "field-select";
  for (const info of state.infos) {
    const opt = document.createElement("option");
    opt.value = info.key;
    const tag = info.isVector ? "vec" : "scalar";
    opt.textContent = `${info.field.variable} (${info.field.kind}, ${tag})`;
    if (info.key === state.selectedKey) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => handlers.onSelectVariable(sel.value));
  return sel;
}

const MODE_ICON: Record<FieldMode, string> = {
  contour: TOOLBAR_ICONS.fieldContour,
  quiver: TOOLBAR_ICONS.fieldQuiver,
  iso: TOOLBAR_ICONS.fieldIso,
  deformed: TOOLBAR_ICONS.fieldDeformed,
};

function buildModeSelect(
  state: FieldPanelState,
  info: FieldInfo | undefined,
  handlers: FieldPanelHandlers
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-modes";
  const hasVector = vectorInfos(state).length > 0;
  const modes: { mode: FieldMode; label: string; enabled: boolean; title: string }[] = [
    { mode: "contour", label: "Contour", enabled: !!info, title: "Color map on the mesh" },
    {
      mode: "quiver",
      label: "Quiver",
      enabled: !!info?.isVector,
      title: info?.isVector ? "Vector arrows" : "Requires a vector field",
    },
    {
      mode: "iso",
      label: "Isosurface",
      enabled: !!info && !info.isVector,
      title: info && !info.isVector ? "Scalar isosurface" : "Requires a scalar field",
    },
    {
      mode: "deformed",
      label: "Deformed",
      enabled: hasVector,
      title: hasVector ? "Warp the geometry by a vector field" : "Requires a vector field",
    },
  ];
  for (const m of modes) {
    const btn = document.createElement("button");
    btn.className = "field-mode-btn";
    btn.innerHTML = `<span class="toolbar-icon">${MODE_ICON[m.mode]}</span> ${m.label}`;
    btn.title = m.title;
    btn.disabled = !m.enabled;
    btn.classList.toggle("active", state.modes.has(m.mode) && m.enabled);
    btn.addEventListener("click", () => {
      if (m.enabled) handlers.onToggleMode(m.mode);
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function buildColormapSelect(state: FieldPanelState, handlers: FieldPanelHandlers): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "field-select";
  for (const cm of COLORMAPS) {
    const opt = document.createElement("option");
    opt.value = cm.name;
    opt.textContent = cm.name;
    if (cm.name === state.colormap) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => handlers.onSelectColormap(sel.value));
  return sel;
}

function buildLegend(state: FieldPanelState, info: FieldInfo): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-legend";
  const bar = document.createElement("div");
  bar.className = "field-legend-gradient";
  bar.style.background = gradientCss(state.colormap);
  wrap.appendChild(bar);
  const labels = document.createElement("div");
  labels.className = "field-legend-labels";
  const mid = (info.scalarMin + info.scalarMax) / 2;
  for (const v of [info.scalarMin, mid, info.scalarMax]) {
    const span = document.createElement("span");
    span.textContent = fmt(v);
    labels.appendChild(span);
  }
  wrap.appendChild(labels);
  return wrap;
}

function buildIsoSlider(
  state: FieldPanelState,
  info: FieldInfo,
  handlers: FieldPanelHandlers
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = "Iso value";
  wrap.appendChild(l);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "field-slider";
  slider.min = String(info.scalarMin);
  slider.max = String(info.scalarMax);
  slider.step = String((info.scalarMax - info.scalarMin) / 200 || 1);
  slider.value = String(state.isoValue);
  const valEl = document.createElement("span");
  valEl.className = "field-slider-value";
  valEl.textContent = fmt(state.isoValue);
  slider.addEventListener("input", () => {
    valEl.textContent = fmt(Number(slider.value));
    handlers.onIsoValue(Number(slider.value));
  });
  wrap.appendChild(slider);
  wrap.appendChild(valEl);
  return wrap;
}

function buildScaleSlider(state: FieldPanelState, handlers: FieldPanelHandlers): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = "Arrow scale";
  wrap.appendChild(l);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "field-slider";
  // Logarithmic-ish multiplier 0.1 .. 10 mapped linearly on the slider.
  slider.min = "0.1";
  slider.max = "10";
  slider.step = "0.1";
  slider.value = String(state.scale);
  const valEl = document.createElement("span");
  valEl.className = "field-slider-value";
  valEl.textContent = `${state.scale.toFixed(1)}×`;
  slider.addEventListener("input", () => {
    valEl.textContent = `${Number(slider.value).toFixed(1)}×`;
    handlers.onScale(Number(slider.value));
  });
  wrap.appendChild(slider);
  wrap.appendChild(valEl);
  return wrap;
}

// Deformation: a vector-field selector (its own, independent of the coloring
// field) plus a warp-scale slider.
function buildDeformControls(state: FieldPanelState, handlers: FieldPanelHandlers): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-subform";

  const vecs = vectorInfos(state);
  if (vecs.length === 0) {
    const note = document.createElement("div");
    note.className = "field-summary";
    note.textContent = "No vector field to deform by.";
    wrap.appendChild(note);
    return wrap;
  }

  const sel = document.createElement("select");
  sel.className = "field-select";
  for (const info of vecs) {
    const opt = document.createElement("option");
    opt.value = info.key;
    opt.textContent = `${info.field.variable} (${info.field.kind})`;
    if (info.key === state.deformKey) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => handlers.onSelectDeformField(sel.value));
  wrap.appendChild(labeledRow("Deform by", sel));

  const row = document.createElement("div");
  row.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = "Warp scale";
  row.appendChild(l);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "field-slider";
  slider.min = "0";
  slider.max = "10";
  slider.step = "0.1";
  slider.value = String(state.deformScale);
  const valEl = document.createElement("span");
  valEl.className = "field-slider-value";
  valEl.textContent = `${state.deformScale.toFixed(1)}×`;
  slider.addEventListener("input", () => {
    valEl.textContent = `${Number(slider.value).toFixed(1)}×`;
    handlers.onDeformScale(Number(slider.value));
  });
  row.appendChild(slider);
  row.appendChild(valEl);
  wrap.appendChild(row);
  return wrap;
}
