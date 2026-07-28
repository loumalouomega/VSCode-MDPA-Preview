// Floating panel for the Mesh-size action: a nodal/element field-like colour
// toggle (reusing the contour colormap), a box-and-whisker plot of the element
// size distribution with small/large-element highlight controls, and a
// "Write to mesh" action that persists NODAL_H / ELEMENT_H into the model.
// Pure DOM + Canvas 2D — mirrors qualityPanel.ts (no charting lib; the webview
// CSP forbids CDN scripts).

import { BoxStats, MeshSizeResult } from "../src/parser/meshSize";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { colormapRow, fmt, legend, sectionLabel } from "./panelWidgets";

export type MeshSizeColor = "none" | "nodal" | "element";
export type MeshSizeWriteTarget = "nodal" | "element" | "both";

export interface MeshSizePanelState {
  color: MeshSizeColor;
  colormap: string;
  showSmall: boolean;
  showBig: boolean;
}

export interface MeshSizePanelHandlers {
  onClose(): void;
  onColor(c: MeshSizeColor): void;
  onColormap(name: string): void;
  onToggleSmall(): void;
  onToggleBig(): void;
  onFrame(which: "small" | "big"): void;
  onWrite(target: MeshSizeWriteTarget): void;
}

// Small = blue, big = red (must match the overlay colours in main.ts).
const SMALL_COLOR = "#3a72f2";
const BIG_COLOR = "#e04030";

export function renderMeshSizePanel(
  container: HTMLElement,
  result: MeshSizeResult,
  state: MeshSizePanelState,
  handlers: MeshSizePanelHandlers
): void {
  container.textContent = "";

  // --- header ---
  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Mesh Size";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  const summary = document.createElement("div");
  summary.className = "meshsize-summary";
  const typeStr = result.elementTypes.join(", ") || "—";
  summary.textContent = `${result.analyzedCount.toLocaleString()} / ${result.elementCount.toLocaleString()} elements · ${typeStr}`;
  container.appendChild(summary);

  if (result.analyzedCount === 0) {
    const empty = document.createElement("div");
    empty.className = "meshsize-summary";
    empty.textContent = "No line/surface/volume elements to measure.";
    container.appendChild(empty);
    return;
  }

  // --- colour-by toggle (field-like) ---
  container.appendChild(sectionLabel("Colour by"));
  const colorRow = document.createElement("div");
  colorRow.className = "meshsize-modes";
  const colorButtons: { key: MeshSizeColor; label: string }[] = [
    { key: "none", label: "None" },
    { key: "nodal", label: "Nodal (NODAL_H)" },
    { key: "element", label: "Element (ELEMENT_H)" },
  ];
  for (const b of colorButtons) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    btn.textContent = b.label;
    btn.classList.toggle("active", state.color === b.key);
    btn.addEventListener("click", () => handlers.onColor(b.key));
    colorRow.appendChild(btn);
  }
  container.appendChild(colorRow);

  if (state.color !== "none") {
    const stats = state.color === "nodal" ? result.nodalStats : result.elementStats;
    container.appendChild(colormapRow(state.colormap, handlers.onColormap));
    container.appendChild(legend(state.colormap, stats.min, stats.max));
  }

  // --- element-size box-and-whisker ---
  container.appendChild(sectionLabel("Element size distribution"));
  const range = document.createElement("div");
  range.className = "meshsize-range";
  const s = result.elementStats;
  range.textContent = `min ${fmt(s.min)} · median ${fmt(s.median)} · max ${fmt(s.max)}`;
  container.appendChild(range);

  const canvas = document.createElement("canvas");
  canvas.className = "meshsize-box";
  container.appendChild(canvas);
  requestAnimationFrame(() =>
    drawBoxWhisker(canvas, result.elementStats, result.smallElementIds.length, result.bigElementIds.length)
  );

  // --- highlight controls ---
  const actions = document.createElement("div");
  actions.className = "meshsize-actions";

  const small = document.createElement("button");
  small.className = "meshsize-highlight-btn small";
  small.textContent = `Smallest (${result.smallElementIds.length})`;
  small.disabled = result.smallElementIds.length === 0;
  small.classList.toggle("active", state.showSmall);
  small.addEventListener("click", () => handlers.onToggleSmall());
  actions.appendChild(small);

  const big = document.createElement("button");
  big.className = "meshsize-highlight-btn big";
  big.textContent = `Largest (${result.bigElementIds.length})`;
  big.disabled = result.bigElementIds.length === 0;
  big.classList.toggle("active", state.showBig);
  big.addEventListener("click", () => handlers.onToggleBig());
  actions.appendChild(big);
  container.appendChild(actions);

  const frames = document.createElement("div");
  frames.className = "meshsize-actions";
  const frameSmall = document.createElement("button");
  frameSmall.textContent = "Frame smallest";
  frameSmall.disabled = result.smallElementIds.length === 0;
  frameSmall.addEventListener("click", () => handlers.onFrame("small"));
  frames.appendChild(frameSmall);
  const frameBig = document.createElement("button");
  frameBig.textContent = "Frame largest";
  frameBig.disabled = result.bigElementIds.length === 0;
  frameBig.addEventListener("click", () => handlers.onFrame("big"));
  frames.appendChild(frameBig);
  container.appendChild(frames);

  // --- write to mesh ---
  container.appendChild(sectionLabel("Write to mesh"));
  const writeNote = document.createElement("div");
  writeNote.className = "meshsize-summary";
  writeNote.textContent = "Append the size field(s) to the mesh (persists on Save).";
  container.appendChild(writeNote);
  const writeRow = document.createElement("div");
  writeRow.className = "meshsize-modes";
  const writes: { target: MeshSizeWriteTarget; label: string }[] = [
    { target: "nodal", label: "NODAL_H" },
    { target: "element", label: "ELEMENT_H" },
    { target: "both", label: "Both" },
  ];
  for (const w of writes) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    btn.textContent = w.label;
    btn.addEventListener("click", () => handlers.onWrite(w.target));
    writeRow.appendChild(btn);
  }
  container.appendChild(writeRow);
}

// Horizontal box-and-whisker over the element-size domain [min, max]. IQR
// outliers beyond the whiskers are marked with a coloured dot at each extreme.
function drawBoxWhisker(canvas: HTMLCanvasElement, stats: BoxStats, smallCount: number, bigCount: number): void {
  const cssW = canvas.clientWidth || 300;
  const cssH = 74;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const padL = 8;
  const padR = 8;
  const axisH = 14;
  const plotW = cssW - padL - padR;
  const cy = (cssH - axisH) / 2 + 4;
  const boxH = 26;

  const d0 = stats.min;
  const d1 = stats.max;
  const span = d1 - d0 || 1;
  const x = (v: number) => padL + ((v - d0) / span) * plotW;

  const stroke = "rgba(150,150,150,0.95)";
  const fill = "rgba(120,140,200,0.25)";
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;

  // Whisker line + caps.
  ctx.beginPath();
  ctx.moveTo(x(stats.whiskerLo), cy);
  ctx.lineTo(x(stats.q1), cy);
  ctx.moveTo(x(stats.q3), cy);
  ctx.lineTo(x(stats.whiskerHi), cy);
  ctx.moveTo(x(stats.whiskerLo), cy - boxH / 3);
  ctx.lineTo(x(stats.whiskerLo), cy + boxH / 3);
  ctx.moveTo(x(stats.whiskerHi), cy - boxH / 3);
  ctx.lineTo(x(stats.whiskerHi), cy + boxH / 3);
  ctx.stroke();

  // Box (Q1..Q3).
  ctx.fillStyle = fill;
  ctx.fillRect(x(stats.q1), cy - boxH / 2, Math.max(1, x(stats.q3) - x(stats.q1)), boxH);
  ctx.strokeRect(x(stats.q1), cy - boxH / 2, Math.max(1, x(stats.q3) - x(stats.q1)), boxH);

  // Median.
  ctx.beginPath();
  ctx.moveTo(x(stats.median), cy - boxH / 2);
  ctx.lineTo(x(stats.median), cy + boxH / 2);
  ctx.stroke();

  // Outlier dots at the extremes.
  const dot = (vx: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(vx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  };
  if (smallCount > 0) dot(x(stats.min), SMALL_COLOR);
  if (bigCount > 0) dot(x(stats.max), BIG_COLOR);

  // Axis labels.
  ctx.fillStyle = "rgba(150,150,150,0.9)";
  ctx.font = "9px var(--vscode-font-family, sans-serif)";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(fmt(stats.min), padL, cssH);
  ctx.textAlign = "right";
  ctx.fillText(fmt(stats.max), cssW - padR, cssH);
}
