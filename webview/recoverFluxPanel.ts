/**
 * The Recovered flux panel (roadmap item 45, viewer half) — a per-area traction / flux recovered
 * from the nodal reactions on a SubModelPart's faces, shown in the Field panel as a DERIVED field.
 *
 * Pure DOM in the `.meshsize-*` / `.series-toolbar` chrome the other analysis panels share. Like
 * Flow balance it does not compute: the host runs `recoverBoundaryFlux` (the core behind MCP
 * `mesh_recover_flux`) and `main.ts` feeds the answer back. The recovered field never enters the
 * model, so it is never saved, exported or edited.
 */

import { t } from "../src/parser/i18n/runtime";
import { glyph } from "../src/uiGlyphs";
import { fmtPrecise as fmt } from "./panelWidgets";

export interface RecoverFluxReport {
  output: string;
  faces: number;
  nodes: number;
  area: number;
  reactionSum: number[];
  integral: number[];
  integralError: number;
  iterations: number;
  nodesWithoutLoad: number;
  message: string;
}

export interface RecoverFluxPanelState {
  /** SubModelPart paths. */
  parts: string[];
  /** Nodal fields (any width) that can hold nodal loads. */
  loads: string[];
  part: string;
  variable: string;
  /** Blank = `<variable>_RECOVERED`. */
  output: string;
  busy: boolean;
  summary?: string;
  isError?: boolean;
  report?: RecoverFluxReport;
}

export interface RecoverFluxPanelHandlers {
  onClose(): void;
  onCompute(): void;
  onClear(): void;
}

export function renderRecoverFluxPanel(container: HTMLElement, state: RecoverFluxPanelState, handlers: RecoverFluxPanelHandlers): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = t("Recovered flux");
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = t("Close");
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  const note = (text: string, error = false): HTMLElement => {
    const el = document.createElement("div");
    el.className = "meshsize-summary";
    if (error) el.classList.add("flow-error");
    el.textContent = text;
    return el;
  };

  if (state.loads.length === 0) {
    container.appendChild(note(t("This mesh has no Nodal field to recover a flux from (for example REACTION).")));
    return;
  }
  if (state.parts.length === 0) {
    container.appendChild(note(t("This mesh has no SubModelParts. Recovery needs a SubModelPart of surface Conditions.")));
    return;
  }

  const row = (labelText: string, control: HTMLElement): void => {
    const bar = document.createElement("div");
    bar.className = "series-toolbar";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;
    bar.appendChild(label);
    bar.appendChild(control);
    container.appendChild(bar);
  };
  const select = (options: string[], value: string, blank: string, onChange: (v: string) => void, id: string): HTMLSelectElement => {
    const el = document.createElement("select");
    el.className = "field-select";
    el.id = id;
    for (const o of ["", ...options]) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o === "" ? blank : o;
      if (o === value) opt.selected = true;
      el.appendChild(opt);
    }
    el.addEventListener("change", () => onChange(el.value));
    return el;
  };

  row(t("Faces"), select(state.parts, state.part, t("Choose…"), (v) => { state.part = v; }, "recover-part"));
  row(t("Reactions"), select(state.loads, state.variable, t("Choose…"), (v) => { state.variable = v; }, "recover-variable"));
  const out = document.createElement("input");
  out.type = "text";
  out.id = "recover-output";
  out.className = "field-select";
  out.value = state.output;
  out.placeholder = t("<VARIABLE>_RECOVERED");
  out.title = t("Name of the derived field; it must not be the name of an existing Nodal field");
  out.addEventListener("input", () => { state.output = out.value; });
  row(t("Output"), out);

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const compute = document.createElement("button");
  compute.className = "panel-btn";
  compute.id = "recover-compute";
  compute.textContent = state.busy ? t("Computing…") : t("Compute");
  compute.disabled = state.busy;
  compute.addEventListener("click", () => handlers.onCompute());
  actions.appendChild(compute);
  const clear = document.createElement("button");
  clear.className = "panel-btn";
  clear.id = "recover-clear";
  clear.textContent = t("Clear");
  clear.disabled = !state.report;
  clear.addEventListener("click", () => handlers.onClear());
  actions.appendChild(clear);
  container.appendChild(actions);

  if (state.summary && !state.report) container.appendChild(note(state.summary, state.isError));
  const r = state.report;
  if (r) {
    const list = (v: number[]): string => v.map((x) => fmt(x)).join(", ");
    const lines = [
      `${r.output}: ${r.faces} ${t("face(s)")}, ${r.nodes} ${t("node(s)")}, ${t("area")} ${fmt(r.area)}`,
      `${t("Reaction sum")}: ${list(r.reactionSum)}`,
      `${t("Integral of the recovered field")}: ${list(r.integral)} (${t("relative difference")} ${r.integralError.toExponential(1)})`,
    ];
    if (r.nodesWithoutLoad > 0) lines.push(`${r.nodesWithoutLoad} ${t("node(s) had no value and carry zero load")}`);
    lines.push(t("Derived field: shown in the Field panel, never saved or exported."));
    for (const l of lines) container.appendChild(note(l));
  }
}
