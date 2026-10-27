// Floating panel for the Inspect toolbar mode: shows what a click on the mesh
// resolved to (src/parser/pickResolve.ts) — the owning entity (Element/
// Condition/Geometry) and/or the nearest node, each with its block/SubModelPart
// membership and every field value defined at it — plus a two-click distance
// Measure mode. Pure DOM, mirrors qualityPanel.ts/panelWidgets.ts.

import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { glyph } from "../src/uiGlyphs";
import { fmt } from "./panelWidgets";
import { t } from "../src/parser/i18n/runtime";

export interface InspectFieldValue {
  variable: string;
  value: number | [number, number, number];
}

export interface InspectEntityInfo {
  kind: "Element" | "Condition" | "Geometry";
  id: number;
  blockName?: string;
  /** Set when this Element is one of the tetrahedra a read polyhedron was decomposed into. */
  polyhedron?: { index: number; children: number };
  smpPaths: string[];
  fields: InspectFieldValue[];
}

export interface InspectNodeInfo {
  id: number;
  coords: [number, number, number];
  smpPaths: string[];
  fields: InspectFieldValue[];
  /** One line per multi-point constraint that names this node. */
  constraints?: string[];
}

export interface InspectSelection {
  entity?: InspectEntityInfo;
  node?: InspectNodeInfo;
}

export interface MeasureResult {
  aId: number;
  bId: number;
  /** Distance between the first two picks. */
  distance: number;
  delta: [number, number, number];
  /** Angle mode: the third pick, the angle AT the second pick (degrees) and the a-b-c path length. */
  cId?: number;
  angle?: number;
  pathLength?: number;
}

export interface InspectPanelState {
  selection?: InspectSelection;
  measuring: boolean;
  /** How many points the in-progress measurement has picked so far (0/1). */
  measurePending: number;
  /** Angle mode: three picks, reporting the angle at the middle one. */
  measureAngle?: boolean;
  /** Points on the probe polyline once its panel is open (2+ means further picks extend it). */
  probeCount?: number;
  measureResult?: MeasureResult;
  probing: boolean;
  /** How many points the in-progress probe line has picked so far (0/1). */
  probePending: number;
  /** Whether a time series exists to plot against — knowable only in main.ts,
   *  and false in the MDPA preview, which has no timeline at all. */
  canPlotSeries?: boolean;
}

export interface InspectPanelHandlers {
  onClose(): void;
  onFrame(): void;
  onToggleMeasure(): void;
  /** Switch Measure between two picks (distance) and three (angle at the middle one). */
  onToggleMeasureAngle?(): void;
  /** Probe line: two picks the way Measure takes them, then the
   *  distance-versus-value plot (webview/probePanel.ts) opens on the pair. */
  onToggleProbe(): void;
  /** Plot this section's entity over the time series. Absent when there is
   *  none to plot — the button is then omitted rather than shown disabled,
   *  since in the MDPA preview it could never become live. */
  onPlotOverTime?(target: "entity" | "node",variable?:string): void;
  /** Keep this field at this entity as a named monitor of the owning case. Offered
   *  beside Plot, under the same condition: it needs a time series to follow. */
  onSaveMonitor?(target: "entity" | "node", variable: string): void;
  /** Keep a nodal field at this node's coordinates (survives remeshing) as a monitor. */
  onSavePointMonitor?(variable: string): void;
  /** Keep a regional quantity of a SubModelPart ("" = the whole mesh) as a monitor. */
  onSaveRegionMonitor?(path: string): void;
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

function fieldsTable(fields: InspectFieldValue[],plot?:(variable:string)=>void,monitor?:(variable:string)=>void,pointMonitor?:(variable:string)=>void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "inspect-fields";
  if (fields.length === 0) {
    const none = document.createElement("div");
    none.className = "inspect-summary";
    none.textContent = t("No field data.");
    wrap.appendChild(none);
    return wrap;
  }
  for (const f of fields) {
    const line=row(f.variable,fmtValue(f.value));
    if(plot){const button=document.createElement("button");button.type="button";button.className="panel-btn";button.textContent=t("Plot");button.setAttribute("aria-label",t("Plot {v} over time",{v:f.variable}));button.addEventListener("click",()=>plot(f.variable));line.appendChild(button);}
    if(monitor){const button=document.createElement("button");button.type="button";button.className="panel-btn inspect-monitor-btn";button.textContent=t("Monitor");button.title=t("Save as a monitor of the case");button.setAttribute("aria-label",`Save ${f.variable} at this entity as a monitor`);button.addEventListener("click",()=>monitor(f.variable));line.appendChild(button);}
    if(pointMonitor){const button=document.createElement("button");button.type="button";button.className="panel-btn inspect-point-monitor-btn";button.textContent=t("At point");button.title=t("Save this field at these coordinates as a monitor");button.setAttribute("aria-label",`Save ${f.variable} at these coordinates as a monitor`);button.addEventListener("click",()=>pointMonitor(f.variable));line.appendChild(button);}
    wrap.appendChild(line);
  }
  return wrap;
}

function smpList(paths: string[], regionMonitor?: (path: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "inspect-summary";
  wrap.textContent = paths.length ? t("Member of: {parts}", { parts: paths.join(", ") }) : t("Not part of any SubModelPart.");
  if (regionMonitor) {
    for (const path of paths) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "panel-btn inspect-region-monitor-btn";
      button.textContent = t("Monitor region");
      button.title = t("Save a quantity over this SubModelPart as a monitor");
      button.setAttribute("aria-label", `Save a regional monitor of ${path}`);
      button.addEventListener("click", () => regionMonitor(path));
      wrap.appendChild(button);
    }
  }
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
  title.textContent = t("Inspect");
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = t("Close");
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  // --- Measure toggle (available with or without a current selection) ---
  const measureRow = document.createElement("div");
  measureRow.className = "inspect-actions";
  const measureBtn = document.createElement("button");
  measureBtn.className = "panel-btn";
  measureBtn.classList.toggle("active", state.measuring);
  measureBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.measure}</span> Measure`;
  measureBtn.title = t("Click two nodes to measure the distance between them");
  measureBtn.addEventListener("click", () => handlers.onToggleMeasure());
  measureRow.appendChild(measureBtn);
  if (state.measuring && handlers.onToggleMeasureAngle) {
    const angleBtn = document.createElement("button");
    angleBtn.className = "panel-btn";
    angleBtn.classList.toggle("active", !!state.measureAngle);
    angleBtn.textContent = t("Angle");
    angleBtn.title = t("Pick three nodes: reports the angle at the second one");
    angleBtn.addEventListener("click", () => handlers.onToggleMeasureAngle?.());
    measureRow.appendChild(angleBtn);
  }
  const probeBtn = document.createElement("button");
  probeBtn.className = "panel-btn";
  probeBtn.classList.toggle("active", state.probing);
  probeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.measure}</span> Probe line`;
  probeBtn.title = t("Click two nodes, then plot the field value along the line between them");
  probeBtn.addEventListener("click", () => handlers.onToggleProbe());
  measureRow.appendChild(probeBtn);
  container.appendChild(measureRow);

  if (state.measuring || state.probing) {
    const hint = document.createElement("div");
    hint.className = "inspect-summary";
    const pending = state.measuring ? state.measurePending : state.probePending;
    const ordinal = ["first", "second", "third"];
    if (state.measuring) {
      const total = state.measureAngle ? 3 : 2;
      hint.textContent = t("Click a {n} node.", { n: ordinal[Math.min(pending, total - 1)] });
    } else if ((state.probeCount ?? 0) >= 2) {
      hint.textContent = t("Click more nodes to extend the probe line.");
    } else {
      hint.textContent = pending === 0 ? "Click a first node for the probe line." : "Click a second node — the profile plot opens.";
    }
    container.appendChild(hint);
  }

  if (state.measureResult) {
    const r = state.measureResult;
    container.appendChild(section(r.cId !== undefined ? `Angle: node ${r.aId} → ${r.bId} → ${r.cId}` : `Distance: node ${r.aId} → node ${r.bId}`));
    if (r.angle !== undefined) container.appendChild(row("Angle at node " + r.bId, `${fmt(r.angle)}°`));
    container.appendChild(row(r.cId !== undefined ? "Distance a–b" : "Distance", fmt(r.distance)));
    if (r.pathLength !== undefined) container.appendChild(row("Path a–b–c", fmt(r.pathLength)));
    container.appendChild(row("Δx, Δy, Δz", fmtValue(r.delta)));
  }

  const sel = state.selection;
  if (!sel || (!sel.entity && !sel.node)) {
    const hint = document.createElement("div");
    hint.className = "inspect-summary";
    hint.textContent = t("Click a node, element, or condition on the mesh to inspect it.");
    container.appendChild(hint);
    return;
  }

  // One pick fills BOTH sections, and "plot the displacement" means the node
  // while "plot the stress" means the element — so the button belongs to a
  // section, not to the panel. It is omitted where it could do nothing: no
  // timeline, or no field values at that entity to plot.
  const plotBtn = (target: "entity" | "node", fieldCount: number): HTMLElement | undefined => {
    if (!state.canPlotSeries || !handlers.onPlotOverTime || fieldCount === 0) return undefined;
    const btn = document.createElement("button");
    btn.className = "inspect-plot-btn";
    btn.textContent = t("Plot over time");
    btn.title = t("Read this value at every step of the time series");
    btn.addEventListener("click", () => handlers.onPlotOverTime?.(target));
    return btn;
  };

  if (sel.entity) {
    const e = sel.entity;
    container.appendChild(section(`${e.kind} ${e.id}`));
    if (e.blockName) container.appendChild(row("Block", e.blockName));
    if (e.polyhedron) container.appendChild(row(t("Polyhedron"), t("#{n} (decomposed into {k} tetrahedra)", { n: String(e.polyhedron.index + 1), k: String(e.polyhedron.children) })));
    container.appendChild(smpList(e.smpPaths,state.canPlotSeries?handlers.onSaveRegionMonitor:undefined));
    container.appendChild(fieldsTable(e.fields,state.canPlotSeries?variable=>handlers.onPlotOverTime?.("entity",variable):undefined,state.canPlotSeries&&handlers.onSaveMonitor?variable=>handlers.onSaveMonitor?.("entity",variable):undefined));
    const btn = plotBtn("entity", e.fields.length);
    if (btn) container.appendChild(btn);
  }

  if (sel.node) {
    const n = sel.node;
    container.appendChild(section(`Nearest node ${n.id}`));
    container.appendChild(row("Coords", fmtValue(n.coords)));
    container.appendChild(smpList(n.smpPaths,state.canPlotSeries?handlers.onSaveRegionMonitor:undefined));
    for (const line of n.constraints ?? []) container.appendChild(row(t("Constraint"), line));
    container.appendChild(fieldsTable(n.fields,state.canPlotSeries?variable=>handlers.onPlotOverTime?.("node",variable):undefined,state.canPlotSeries&&handlers.onSaveMonitor?variable=>handlers.onSaveMonitor?.("node",variable):undefined,state.canPlotSeries&&handlers.onSavePointMonitor?variable=>handlers.onSavePointMonitor?.(variable):undefined));
    const btn = plotBtn("node", n.fields.length);
    if (btn) container.appendChild(btn);
  }

  const frameBtn = document.createElement("button");
  frameBtn.className = "inspect-frame-btn";
  frameBtn.textContent = t("Frame");
  frameBtn.addEventListener("click", () => handlers.onFrame());
  container.appendChild(frameBtn);
}
