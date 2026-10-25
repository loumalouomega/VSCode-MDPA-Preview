// Floating panel for Advanced ▸ Volume view (roadmap item 22 D): shows a dense
// regular lattice as a volume with an editable opacity curve, three orthogonal
// slices, or iso surfaces. Pure DOM; mirrors beamPanel.ts / spherePanel.ts.

import { t } from "../src/parser/i18n/runtime";
import {
  insertOpacityPoint,
  normalizeOpacityPoints,
  OPACITY_PRESETS,
  removeOpacityPoint,
  type OpacityPoint,
} from "../src/parser/render/opacityTransfer";
import { glyph } from "../src/uiGlyphs";
import { colormapRow, fmt, sectionLabel, setupChartCanvas } from "./panelWidgets";

export type VolumeViewMode = "off" | "volume" | "slices" | "contour";

export interface VolumePanelState {
  scalar: string;
  mode: VolumeViewMode;
  colormap: string;
  opacity: OpacityPoint[];
  /** Slice index and visibility per axis. */
  slice: [number, number, number];
  sliceOn: [boolean, boolean, boolean];
  isoValues: number[];
}

export interface VolumePanelInfo {
  scalars: { name: string; range: [number, number] }[];
  dims: [number, number, number];
}

export interface VolumePanelHandlers {
  onClose(): void;
  onScalar(name: string): void;
  onMode(mode: VolumeViewMode): void;
  onColormap(name: string): void;
  onOpacity(points: OpacityPoint[]): void;
  onSlice(axis: number, index: number): void;
  onSliceVisible(axis: number, on: boolean): void;
  onIsoValues(values: number[]): void;
}

const MODES: [VolumeViewMode, string][] = [
  ["off", "Surface"],
  ["volume", "Volume"],
  ["slices", "Slices"],
  ["contour", "Iso"],
];

const CURVE_W = 240;
const CURVE_H = 84;
const GRAB = 9;

export function renderVolumePanel(
  container: HTMLElement,
  info: VolumePanelInfo | undefined,
  state: VolumePanelState,
  handlers: VolumePanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = t("Volume view");
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = t("Close");
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  if (!info) {
    const none = document.createElement("div");
    none.className = "meshsize-summary";
    none.textContent =
      "This mesh is not a dense regular lattice with a nodal scalar, so there is nothing to draw as a volume. " +
      "A .vti file or a sampled grid (Advanced ▸ Sample to grid…) is.";
    container.appendChild(none);
    return;
  }

  const summary = document.createElement("div");
  summary.className = "meshsize-summary";
  summary.textContent = `${info.dims[0]} × ${info.dims[1]} × ${info.dims[2]} lattice, ${info.scalars.length} scalar${info.scalars.length === 1 ? "" : "s"}. Display only: the mesh itself is unchanged.`;
  container.appendChild(summary);

  // --- scalar ---
  const sRow = document.createElement("div");
  sRow.className = "field-row";
  const sl = document.createElement("label");
  sl.className = "field-label";
  sl.textContent = t("Scalar");
  sRow.appendChild(sl);
  const sel = document.createElement("select");
  sel.className = "field-select";
  for (const s of info.scalars) {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = s.name;
    o.selected = s.name === state.scalar;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => handlers.onScalar(sel.value));
  sRow.appendChild(sel);
  container.appendChild(sRow);
  const range = info.scalars.find((s) => s.name === state.scalar)?.range ?? [0, 1];

  // --- mode ---
  container.appendChild(sectionLabel("Show as"));
  const modes = document.createElement("div");
  modes.className = "meshsize-modes";
  for (const [id, label] of MODES) {
    const b = document.createElement("button");
    b.className = "meshsize-mode-btn";
    b.textContent = label;
    b.classList.toggle("active", state.mode === id);
    b.addEventListener("click", () => handlers.onMode(id));
    modes.appendChild(b);
  }
  container.appendChild(modes);

  if (state.mode === "off") return;
  container.appendChild(colormapRow(state.colormap, handlers.onColormap));

  if (state.mode === "volume") renderOpacityEditor(container, state, range, handlers);
  if (state.mode === "slices") renderSliceRows(container, info, state, handlers);
  if (state.mode === "contour") renderIsoRows(container, state, range, handlers);
}

function renderOpacityEditor(
  container: HTMLElement,
  state: VolumePanelState,
  range: [number, number],
  handlers: VolumePanelHandlers
): void {
  container.appendChild(sectionLabel("Opacity"));
  const presets = document.createElement("select");
  presets.className = "field-select";
  const custom = document.createElement("option");
  custom.textContent = t("Preset…");
  custom.value = "";
  presets.appendChild(custom);
  for (const p of OPACITY_PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    presets.appendChild(o);
  }
  presets.addEventListener("change", () => {
    const p = OPACITY_PRESETS.find((x) => x.id === presets.value);
    if (p) handlers.onOpacity(p.points.map((q) => ({ ...q })));
  });
  container.appendChild(presets);

  const canvas = document.createElement("canvas");
  canvas.className = "volume-curve";
  canvas.style.width = `${CURVE_W}px`;
  canvas.title = t("Click to add a point, drag to move it, double-click a point to remove it");
  container.appendChild(canvas);
  const pts = normalizeOpacityPoints(state.opacity);
  const toPx = (p: OpacityPoint): [number, number] => [p.x * (CURVE_W - 12) + 6, (1 - p.a) * (CURVE_H - 12) + 6];
  const fromPx = (x: number, y: number): OpacityPoint => ({
    x: Math.min(1, Math.max(0, (x - 6) / (CURVE_W - 12))),
    a: Math.min(1, Math.max(0, 1 - (y - 6) / (CURVE_H - 12))),
  });
  const draw = (current: OpacityPoint[]): void => {
    const c = setupChartCanvas(canvas, CURVE_H, CURVE_W);
    if (!c) return;
    const { ctx } = c;
    ctx.clearRect(0, 0, CURVE_W, CURVE_H);
    ctx.strokeStyle = "rgba(128,128,128,0.5)";
    ctx.strokeRect(6, 6, CURVE_W - 12, CURVE_H - 12);
    ctx.strokeStyle = "#4da3ff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    current.forEach((p, i) => {
      const [x, y] = toPx(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = "#4da3ff";
    for (const p of current) {
      const [x, y] = toPx(p);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  draw(pts);
  const hit = (x: number, y: number, current: OpacityPoint[]): number => {
    let best = -1;
    let bd = GRAB * GRAB;
    current.forEach((p, i) => {
      const [px, py] = toPx(p);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  let drag = -1;
  let working = pts;
  const local = (e: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener("pointerdown", (e) => {
    const [x, y] = local(e);
    drag = hit(x, y, working);
    if (drag < 0) {
      const p = fromPx(x, y);
      working = insertOpacityPoint(working, p.x, p.a);
      drag = hit(x, y, working);
      handlers.onOpacity(working);
    }
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag < 0) return;
    const [x, y] = local(e);
    const p = fromPx(x, y);
    const last = working.length - 1;
    const moved = working.map((q, i) =>
      i === drag ? { x: drag === 0 ? 0 : drag === last ? 1 : p.x, a: p.a } : { ...q }
    );
    working = moved;
    draw(working);
    handlers.onOpacity(working);
  });
  const end = (): void => {
    drag = -1;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("dblclick", (e) => {
    const [x, y] = local(e);
    const i = hit(x, y, working);
    if (i > 0 && i < working.length - 1) {
      working = removeOpacityPoint(working, i);
      handlers.onOpacity(working);
    }
  });
  const hint = document.createElement("div");
  hint.className = "meshsize-summary";
  hint.textContent = `x: ${fmt(range[0])} … ${fmt(range[1])}, y: opacity`;
  container.appendChild(hint);
}

function renderSliceRows(
  container: HTMLElement,
  info: VolumePanelInfo,
  state: VolumePanelState,
  handlers: VolumePanelHandlers
): void {
  container.appendChild(sectionLabel("Slices"));
  ["X", "Y", "Z"].forEach((name, axis) => {
    const row = document.createElement("div");
    row.className = "field-row";
    const label = document.createElement("label");
    label.className = "edit-check";
    const ck = document.createElement("input");
    ck.type = "checkbox";
    ck.checked = state.sliceOn[axis];
    ck.addEventListener("change", () => handlers.onSliceVisible(axis, ck.checked));
    label.appendChild(ck);
    label.appendChild(document.createTextNode(name));
    row.appendChild(label);
    const input = document.createElement("input");
    input.type = "range";
    input.className = "field-slider";
    input.min = "0";
    input.max = String(info.dims[axis] - 1);
    input.step = "1";
    input.value = String(state.slice[axis]);
    const val = document.createElement("span");
    val.className = "field-slider-value";
    val.textContent = input.value;
    input.addEventListener("input", () => {
      val.textContent = input.value;
      handlers.onSlice(axis, Number(input.value));
    });
    row.appendChild(input);
    row.appendChild(val);
    container.appendChild(row);
  });
}

function renderIsoRows(
  container: HTMLElement,
  state: VolumePanelState,
  range: [number, number],
  handlers: VolumePanelHandlers
): void {
  container.appendChild(sectionLabel("Iso values"));
  state.isoValues.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "field-row";
    const input = document.createElement("input");
    input.type = "range";
    input.className = "field-slider";
    const span = range[1] - range[0] || 1;
    input.min = String(range[0]);
    input.max = String(range[1]);
    input.step = String(span / 200);
    input.value = String(v);
    const val = document.createElement("span");
    val.className = "field-slider-value";
    val.textContent = fmt(v);
    input.addEventListener("input", () => {
      val.textContent = fmt(Number(input.value));
      const next = [...state.isoValues];
      next[i] = Number(input.value);
      handlers.onIsoValues(next);
    });
    row.appendChild(input);
    row.appendChild(val);
    if (state.isoValues.length > 1) {
      const rm = document.createElement("button");
      rm.className = "panel-icon-btn";
      rm.title = t("Remove");
      rm.innerHTML = glyph("x");
      rm.addEventListener("click", () => handlers.onIsoValues(state.isoValues.filter((_, j) => j !== i)));
      row.appendChild(rm);
    }
    container.appendChild(row);
  });
  if (state.isoValues.length < 4) {
    const add = document.createElement("button");
    add.className = "panel-btn";
    add.textContent = t("Add iso value");
    add.addEventListener("click", () => handlers.onIsoValues([...state.isoValues, (range[0] + range[1]) / 2]));
    container.appendChild(add);
  }
}
