// Floating panel for field visualization: a variable selector, a set of
// independently-toggleable mode buttons (contour, quiver, isosurface, deformed
// shape, threshold — combinable), a colormap dropdown with a live legend, and
// the mode-specific controls (isosurface values, quiver scale, deformation
// field + scale, color-range / component / log / bands). Pure DOM — mirrors
// qualityPanel.ts. Scalar semantics (component selection, range, log/banded
// stops) are pure helpers from src/parser/fieldScalars.ts.

import { FieldInfo, rangeForComponent } from "./fieldData";
import { COLORMAPS, getColormap } from "./colormaps";
import { legendFromStops } from "./panelWidgets";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import {
  FieldComponent,
  canLogScale,
  componentLabel,
  effectiveRange,
  legendTicks,
  transformStops,
} from "../src/parser/fieldScalars";

export type FieldMode = "contour" | "quiver" | "iso" | "deformed";

export interface FieldPanelState {
  infos: FieldInfo[];
  selectedKey: string;
  /** The set of currently-active modes (combinable). */
  modes: Set<FieldMode>;
  colormap: string;
  /** Which scalar of a vector field drives contour/iso coloring. */
  component: FieldComponent;
  /** User-entered [min,max] override; undefined = use the field's data range. */
  rangeOverride?: [number, number];
  log: boolean;
  /** Discrete color bands; 0 = continuous. */
  bands: number;
  scalarBar: boolean;
  /** One or more iso values (evenly spaced by default; user-editable). */
  isoValues: number[];
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
  onSelectComponent(c: FieldComponent): void;
  onRangeOverride(range: [number, number] | undefined): void;
  onLog(v: boolean): void;
  onBands(n: number): void;
  onScalarBar(v: boolean): void;
  onIsoValues(values: number[]): void;
  onIsoCount(count: number): void;
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

// The component selector only applies to contour/iso (quiver always colors by
// magnitude); when neither of those modes is active, the legend/range must
// describe what's actually drawn — magnitude — even if a component was picked
// during an earlier contour session. Takes just the two fields it needs so
// main.ts can call it against its own `fieldState` without building a full
// FieldPanelState.
export function activeComponent(state: Pick<FieldPanelState, "modes" | "component">): FieldComponent {
  return state.modes.has("contour") || state.modes.has("iso") ? state.component : "mag";
}

/** The effective [min,max] the active coloring is stretched over. */
export function effectiveFieldRange(state: FieldPanelState, info: FieldInfo): [number, number] {
  const dataRange = rangeForComponent(info, info.isVector ? activeComponent(state) : "mag");
  return effectiveRange(dataRange, state.rangeOverride);
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

  const wantsColor = info && (state.modes.has("contour") || state.modes.has("quiver"));

  // --- vector component select (contour/iso only — quiver stays magnitude) ---
  if (info?.isVector && (state.modes.has("contour") || state.modes.has("iso"))) {
    container.appendChild(buildComponentSelect(state, handlers));
  }

  // --- colormap dropdown + range/log/bands + legend (used by contour / quiver) ---
  if (wantsColor && info) {
    container.appendChild(labeledRow("Colormap", buildColormapSelect(state, handlers)));
    container.appendChild(buildRangeControls(state, info, handlers));
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
    container.appendChild(buildIsoControls(state, info, handlers));
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

function buildComponentSelect(state: FieldPanelState, handlers: FieldPanelHandlers): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "field-select";
  const options: FieldComponent[] = ["mag", 0, 1, 2];
  for (const c of options) {
    const opt = document.createElement("option");
    opt.value = String(c);
    opt.textContent = componentLabel(c);
    if (c === state.component) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    const v = sel.value;
    handlers.onSelectComponent(v === "mag" ? "mag" : (Number(v) as FieldComponent));
  });
  return labeledRow("Component", sel);
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

// Editable min/max range (with a lock/reset toggle), log-scale checkbox
// (disabled when the effective range can't support it), band-count select,
// and an in-scene-scalar-bar checkbox.
function buildRangeControls(
  state: FieldPanelState,
  info: FieldInfo,
  handlers: FieldPanelHandlers
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-subform";

  const dataRange = rangeForComponent(info, info.isVector ? state.component : "mag");
  const [effMin, effMax] = effectiveFieldRange(state, info);

  const row = document.createElement("div");
  row.className = "field-row field-range-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = "Range";
  row.appendChild(l);

  const minInput = document.createElement("input");
  minInput.type = "number";
  minInput.className = "field-range-input";
  minInput.value = String(effMin);
  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.className = "field-range-input";
  maxInput.value = String(effMax);

  const commit = (): void => {
    const lo = Number(minInput.value);
    const hi = Number(maxInput.value);
    if (Number.isFinite(lo) && Number.isFinite(hi)) handlers.onRangeOverride([lo, hi]);
  };
  minInput.addEventListener("change", commit);
  maxInput.addEventListener("change", commit);
  row.appendChild(minInput);
  row.appendChild(maxInput);

  const resetBtn = document.createElement("button");
  resetBtn.className = "field-range-reset";
  resetBtn.title = "Reset to data range";
  resetBtn.textContent = "⟲";
  resetBtn.disabled = !state.rangeOverride;
  resetBtn.addEventListener("click", () => {
    minInput.value = String(dataRange[0]);
    maxInput.value = String(dataRange[1]);
    handlers.onRangeOverride(undefined);
  });
  row.appendChild(resetBtn);
  wrap.appendChild(row);

  // --- log scale + bands ---
  const optsRow = document.createElement("div");
  optsRow.className = "field-row field-scale-opts";

  const logLabel = document.createElement("label");
  logLabel.className = "edit-check";
  const logCk = document.createElement("input");
  logCk.type = "checkbox";
  logCk.checked = state.log;
  logCk.disabled = !canLogScale(effMin, effMax);
  logCk.addEventListener("change", () => handlers.onLog(logCk.checked));
  logLabel.appendChild(logCk);
  logLabel.appendChild(document.createTextNode("Log scale"));
  if (logCk.disabled) logLabel.title = "Requires a strictly positive range";
  optsRow.appendChild(logLabel);

  const bandsLabel = document.createElement("label");
  bandsLabel.className = "field-bands-label";
  bandsLabel.appendChild(document.createTextNode("Bands"));
  const bandsSel = document.createElement("select");
  bandsSel.className = "field-select field-bands-select";
  for (const n of [0, 5, 10, 20]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = n === 0 ? "Continuous" : String(n);
    if (n === state.bands) opt.selected = true;
    bandsSel.appendChild(opt);
  }
  bandsSel.addEventListener("change", () => handlers.onBands(Number(bandsSel.value)));
  bandsLabel.appendChild(bandsSel);
  optsRow.appendChild(bandsLabel);
  wrap.appendChild(optsRow);

  // --- in-scene scalar bar ---
  const barLabel = document.createElement("label");
  barLabel.className = "edit-check";
  const barCk = document.createElement("input");
  barCk.type = "checkbox";
  barCk.checked = state.scalarBar;
  barCk.addEventListener("change", () => handlers.onScalarBar(barCk.checked));
  barLabel.appendChild(barCk);
  barLabel.appendChild(document.createTextNode("Show scalar bar in scene"));
  wrap.appendChild(barLabel);

  return wrap;
}

function buildLegend(state: FieldPanelState, info: FieldInfo): HTMLElement {
  const [min, max] = effectiveFieldRange(state, info);
  const useLog = state.log && canLogScale(min, max);
  const stops = transformStops(getColormap(state.colormap).stops, {
    log: state.log,
    bands: state.bands,
    min,
    max,
  });
  return legendFromStops(stops, legendTicks(min, max, useLog));
}

function buildIsoControls(
  state: FieldPanelState,
  info: FieldInfo,
  handlers: FieldPanelHandlers
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-subform";

  const [min, max] = effectiveFieldRange(state, info);

  const countRow = document.createElement("div");
  countRow.className = "field-row";
  const cl = document.createElement("label");
  cl.className = "field-label";
  cl.textContent = "Count";
  countRow.appendChild(cl);
  const countInput = document.createElement("input");
  countInput.type = "number";
  countInput.className = "field-range-input";
  countInput.min = "1";
  countInput.max = "20";
  countInput.value = String(state.isoValues.length || 1);
  countInput.addEventListener("change", () => {
    const n = Math.max(1, Math.min(20, Math.round(Number(countInput.value)) || 1));
    handlers.onIsoCount(n);
  });
  countRow.appendChild(countInput);
  wrap.appendChild(countRow);

  const list = document.createElement("div");
  list.className = "field-iso-list";
  const values = state.isoValues.length ? state.isoValues : [(min + max) / 2];
  values.forEach((v, idx) => {
    const row = document.createElement("div");
    row.className = "field-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "field-slider";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String((max - min) / 200 || 1);
    slider.value = String(v);
    const valEl = document.createElement("span");
    valEl.className = "field-slider-value";
    valEl.textContent = fmt(v);
    slider.addEventListener("input", () => {
      valEl.textContent = fmt(Number(slider.value));
      const next = values.slice();
      next[idx] = Number(slider.value);
      handlers.onIsoValues(next);
    });
    row.appendChild(slider);
    row.appendChild(valEl);
    list.appendChild(row);
  });
  wrap.appendChild(list);
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
