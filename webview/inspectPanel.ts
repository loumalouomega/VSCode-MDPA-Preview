// Floating panel for the Inspect toolbar mode: shows what a click on the mesh
// resolved to (src/parser/pickResolve.ts) — the owning entity (Element/
// Condition/Geometry) and/or the nearest node, each with its block/SubModelPart
// membership and every field value defined at it — plus a two-click distance
// Measure mode. Pure DOM, mirrors qualityPanel.ts/panelWidgets.ts.

import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { fmt } from "./panelWidgets";

export interface InspectFieldValue {
  variable: string;
  value: number | [number, number, number];
}

export interface InspectEntityInfo {
  kind: "Element" | "Condition" | "Geometry";
  id: number;
  blockName?: string;
  smpPaths: string[];
  fields: InspectFieldValue[];
}

export interface InspectNodeInfo {
  id: number;
  coords: [number, number, number];
  smpPaths: string[];
  fields: InspectFieldValue[];
}

export interface InspectSelection {
  entity?: InspectEntityInfo;
  node?: InspectNodeInfo;
}

export interface MeasureResult {
  aId: number;
  bId: number;
  distance: number;
  delta: [number, number, number];
}

export interface InspectPanelState {
  selection?: InspectSelection;
  measuring: boolean;
  /** How many points the in-progress measurement has picked so far (0/1). */
  measurePending: number;
  measureResult?: MeasureResult;
}

export interface InspectPanelHandlers {
  onClose(): void;
  onFrame(): void;
  onToggleMeasure(): void;
}

function fmtValue(v: number | [number, number, number]): string {
  return Array.isArray(v) ? `(${v.map(fmt).join(", ")})` : fmt(v);
}

function section(title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "inspect-section";
  el.textContent = title;
  return el;
}

function row(label: string, value: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "inspect-row";
  const l = document.createElement("span");
  l.className = "inspect-row-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "inspect-row-value";
  v.textContent = value;
  el.appendChild(l);
  el.appendChild(v);
  return el;
}

function fieldsTable(fields: InspectFieldValue[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "inspect-fields";
  if (fields.length === 0) {
    const none = document.createElement("div");
    none.className = "inspect-summary";
    none.textContent = "No field data.";
    wrap.appendChild(none);
    return wrap;
  }
  for (const f of fields) {
    wrap.appendChild(row(f.variable, fmtValue(f.value)));
  }
  return wrap;
}

function smpList(paths: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "inspect-summary";
  wrap.textContent = paths.length ? `Member of: ${paths.join(", ")}` : "Not part of any SubModelPart.";
  return wrap;
}

export function renderInspectPanel(
  container: HTMLElement,
  state: InspectPanelState,
  handlers: InspectPanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "field-header";
  const title = document.createElement("div");
  title.className = "field-title";
  title.textContent = "Inspect";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  // --- Measure toggle (available with or without a current selection) ---
  const measureRow = document.createElement("div");
  measureRow.className = "inspect-actions";
  const measureBtn = document.createElement("button");
  measureBtn.className = "field-mode-btn";
  measureBtn.classList.toggle("active", state.measuring);
  measureBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.measure}</span> Measure`;
  measureBtn.title = "Click two nodes to measure the distance between them";
  measureBtn.addEventListener("click", () => handlers.onToggleMeasure());
  measureRow.appendChild(measureBtn);
  container.appendChild(measureRow);

  if (state.measuring) {
    const hint = document.createElement("div");
    hint.className = "inspect-summary";
    hint.textContent =
      state.measurePending === 0
        ? "Click a first node."
        : "Click a second node.";
    container.appendChild(hint);
  }

  if (state.measureResult) {
    const r = state.measureResult;
    container.appendChild(section(`Distance: node ${r.aId} → node ${r.bId}`));
    container.appendChild(row("Distance", fmt(r.distance)));
    container.appendChild(row("Δx, Δy, Δz", fmtValue(r.delta)));
  }

  const sel = state.selection;
  if (!sel || (!sel.entity && !sel.node)) {
    const hint = document.createElement("div");
    hint.className = "inspect-summary";
    hint.textContent = "Click a node, element, or condition on the mesh to inspect it.";
    container.appendChild(hint);
    return;
  }

  if (sel.entity) {
    const e = sel.entity;
    container.appendChild(section(`${e.kind} ${e.id}`));
    if (e.blockName) container.appendChild(row("Block", e.blockName));
    container.appendChild(smpList(e.smpPaths));
    container.appendChild(fieldsTable(e.fields));
  }

  if (sel.node) {
    const n = sel.node;
    container.appendChild(section(`Nearest node ${n.id}`));
    container.appendChild(row("Coords", fmtValue(n.coords)));
    container.appendChild(smpList(n.smpPaths));
    container.appendChild(fieldsTable(n.fields));
  }

  const frameBtn = document.createElement("button");
  frameBtn.className = "inspect-frame-btn";
  frameBtn.textContent = "Frame";
  frameBtn.addEventListener("click", () => handlers.onFrame());
  container.appendChild(frameBtn);
}
