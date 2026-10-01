/**
 * The Flow balance panel — signed flux through named SubModelPart boundaries,
 * area-weighted pressure on them, the net and imbalance across them and an
 * optional pressure drop, for the CURRENT frame.
 *
 * Pure DOM in the `.meshsize-*` / `.series-toolbar` chrome the other analysis
 * panels share. Like the Streamlines and Field integrals panels it does not
 * compute: the numbers come from the host (`meshAnalysis` kind `flowBalance`,
 * the same core MCP `mesh_flow_balance` calls) and `main.ts` feeds them back.
 * The form lives in `FlowBalanceForm` (text, so a half-typed value survives a
 * re-render) and every decision about it is in `src/parser/flowBalanceForm.ts`.
 *
 * Inputs write straight into the shared form object and do NOT re-render — only
 * a result, a row add/remove or a busy flip does — so typing is never
 * interrupted and a reply cannot eat a draft.
 */

import { glyph } from "../src/uiGlyphs";
import type { FlowBalance, FlowSeries } from "../src/parser/flowBalance";
import { flowSectionLabel, type FlowBalanceForm } from "../src/parser/flowBalanceForm";
import { fmtPrecise as fmt } from "./panelWidgets";

export interface FlowBalancePanelState {
  form: FlowBalanceForm;
  /** Nodal fields with 2 or 3 components. */
  vectors: string[];
  /** Nodal scalar fields. */
  scalars: string[];
  /** SubModelPart paths. */
  parts: string[];
  busy: boolean;
  /** The last answer; undefined until the first Compute. */
  result?: FlowBalance;
  /** Why the last request could not run, or the one-line summary. */
  summary?: string;
  isError?: boolean;
  /** The whole-series answer; undefined until the first All-steps run. */
  series?: FlowSeries;
  /** Set while a series scan is in flight. */
  seriesProgress?: { done: number; total: number; label: string };
  /** Why the last series scan could not run. */
  seriesMessage?: string;
  /** Set when edits are applied: the scan reads the files as they are on disk. */
  seriesHistoryNote?: string;
}

export interface FlowBalancePanelHandlers {
  onClose(): void;
  onCompute(): void;
  onExport(): void;
  onSeries(): void;
  onSeriesCancel(): void;
  onPickStep(frameIndex: number): void;
  onExportSeries(): void;
  /** A row was added or removed — the section list changed shape. */
  onRows(): void;
}

const num = (v: number | null): string => (v === null ? "n/a" : fmt(v));

export function renderFlowBalancePanel(
  container: HTMLElement,
  state: FlowBalancePanelState,
  handlers: FlowBalancePanelHandlers
): void {
  container.textContent = "";
  const form = state.form;

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Flow balance";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
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

  if (state.vectors.length === 0 && state.scalars.length === 0) {
    container.appendChild(
      note(
        "This mesh has no Nodal velocity or pressure field. The flow balance reads a 2- or 3-component " +
          "Nodal vector and a Nodal scalar; an Elemental field must be moved to the nodes first with Average field."
      )
    );
    return;
  }
  if (state.parts.length === 0) {
    container.appendChild(note("This mesh has no SubModelParts. A section is a SubModelPart of surface (3D) or line (2D) Conditions."));
    return;
  }

  const row = (labelText: string, ...controls: HTMLElement[]): HTMLElement => {
    const bar = document.createElement("div");
    bar.className = "series-toolbar";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = labelText;
    bar.appendChild(label);
    for (const c of controls) bar.appendChild(c);
    container.appendChild(bar);
    return bar;
  };

  const select = (
    options: { value: string; label: string }[],
    value: string,
    onChange: (v: string) => void,
    title?: string
  ): HTMLSelectElement => {
    const el = document.createElement("select");
    el.className = "field-select";
    if (title) el.title = title;
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      el.appendChild(opt);
    }
    el.addEventListener("change", () => onChange(el.value));
    return el;
  };

  const text = (value: string, onInput: (v: string) => void, placeholder: string, title?: string): HTMLInputElement => {
    const el = document.createElement("input");
    el.type = "text";
    el.className = "field-select";
    el.value = value;
    el.placeholder = placeholder;
    if (title) el.title = title;
    el.addEventListener("input", () => onInput(el.value));
    return el;
  };

  row(
    "Velocity",
    select(
      [{ value: "", label: "(none — pressure only)" }, ...state.vectors.map((v) => ({ value: v, label: v }))],
      form.velocity,
      (v) => { form.velocity = v; },
      "The Nodal vector field whose flux is integrated"
    )
  );
  row(
    "Pressure",
    select(
      [{ value: "", label: "(none)" }, ...state.scalars.map((v) => ({ value: v, label: v }))],
      form.pressure,
      (v) => { form.pressure = v; },
      "The Nodal scalar whose area-weighted mean is reported, in its own units"
    )
  );
  row(
    "Normal",
    select(
      [
        { value: "outward", label: "Outward from the domain" },
        { value: "winding", label: "As wound in the file" },
      ],
      form.orientation,
      (v) => { form.orientation = v === "winding" ? "winding" : "outward"; },
      "Outward flips each facet away from the Element it belongs to and skips facets it cannot orient; winding trusts the Conditions' node order"
    )
  );
  row("Density", text(form.density, (v) => { form.density = v; }, "blank = no mass flux", "Explicit density for a mass flux; never inferred"));
  row("P density", text(form.pressureDensity, (v) => { form.pressureDensity = v; }, "blank = field units", "Explicit density (kg/m³) to also report pressure means/drop in Pa; only converts a kinematic-pressure field, otherwise reported unavailable"));

  row(
    "P ref",
    select(
      [
        { value: "", label: "(unstated)" },
        { value: "gauge", label: "gauge" },
        { value: "absolute", label: "absolute" },
      ],
      form.pressureReference,
      (v) => { form.pressureReference = v === "gauge" ? "gauge" : v === "absolute" ? "absolute" : ""; },
      "Label for a converted pressure; never inferred"
    )
  );

  // Sections: one row per boundary, with a remove button.
  const sectionLabel = document.createElement("div");
  sectionLabel.className = "meshsize-section";
  sectionLabel.textContent = "Sections";
  container.appendChild(sectionLabel);
  form.sections.forEach((s, i) => {
    const partSel = select(
      [{ value: "", label: "Choose…" }, ...state.parts.map((p) => ({ value: p, label: p }))],
      s.part,
      (v) => {
        s.part = v;
        // The Drop choices are the sections' labels, which just changed.
        handlers.onRows();
      },
      "A SubModelPart whose Conditions (and those of its children) form this section"
    );
    const name = text(s.name, (v) => { s.name = v; }, "name", "Label in the result (blank = the part's path)");
    name.style.maxWidth = "80px";
    const remove = document.createElement("button");
    remove.className = "panel-btn";
    remove.textContent = "✕";
    remove.title = "Remove this section";
    remove.disabled = form.sections.length <= 1;
    remove.addEventListener("click", () => {
      form.sections.splice(i, 1);
      handlers.onRows();
    });
    row(`#${i + 1}`, partSel, name, remove);
  });
  const addBar = document.createElement("div");
  addBar.className = "meshsize-actions";
  const add = document.createElement("button");
  add.className = "panel-btn";
  add.textContent = "Add section";
  add.addEventListener("click", () => {
    form.sections.push({ name: "", part: "" });
    handlers.onRows();
  });
  addBar.appendChild(add);
  container.appendChild(addBar);

  // Pressure drop between two of the sections above, by label. A name typed
  // into a section row cannot re-render (that would steal its focus), so the
  // options are also refreshed whenever a Drop select is focused or pressed.
  const labelsNow = (): string[] => form.sections.filter((s) => s.part !== "").map(flowSectionLabel);
  const dropSelect = (get: () => string, set: (v: string) => void, title: string): HTMLSelectElement => {
    const sel = select([{ value: "", label: "(none)" }], get(), set, title);
    const fill = (): void => {
      const keep = get();
      sel.textContent = "";
      for (const l of ["", ...labelsNow()]) {
        const opt = document.createElement("option");
        opt.value = l;
        opt.textContent = l === "" ? "(none)" : l;
        if (l === keep) opt.selected = true;
        sel.appendChild(opt);
      }
    };
    fill();
    sel.addEventListener("focus", fill);
    sel.addEventListener("mousedown", fill);
    return sel;
  };
  row(
    "Drop",
    dropSelect(() => form.dropFrom, (v) => { form.dropFrom = v; }, "Pressure drop = mean pressure(From) − mean pressure(To)"),
    dropSelect(() => form.dropTo, (v) => { form.dropTo = v; }, "…minus the mean pressure on this section")
  );

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const compute = document.createElement("button");
  compute.className = "panel-btn";
  compute.textContent = state.busy ? "Computing…" : "Compute";
  compute.disabled = state.busy;
  compute.addEventListener("click", () => handlers.onCompute());
  actions.appendChild(compute);
  const exp = document.createElement("button");
  exp.className = "panel-btn";
  exp.textContent = "Export CSV";
  exp.title = "Save the table below as CSV";
  exp.disabled = state.busy || !state.result;
  exp.addEventListener("click", () => handlers.onExport());
  actions.appendChild(exp);
  container.appendChild(actions);

  if (state.summary && (state.isError || !state.result)) container.appendChild(note(state.summary, state.isError));

  // The whole series at once. The scan walks the files on disk one model at
  // a time (like Plot over time); a failing step is recorded and skipped, and
  // picking a row jumps the 3D view to that step.
  const seriesLabel = document.createElement("div");
  seriesLabel.className = "meshsize-section";
  seriesLabel.textContent = "All steps";
  container.appendChild(seriesLabel);
  const seriesActions = document.createElement("div");
  seriesActions.className = "meshsize-actions";
  const runSeries = document.createElement("button");
  runSeries.className = "panel-btn";
  runSeries.textContent = state.seriesProgress ? "Scanning…" : "All steps";
  runSeries.disabled = !!state.seriesProgress;
  runSeries.title = "Balance every step of the time series";
  runSeries.addEventListener("click", () => handlers.onSeries());
  seriesActions.appendChild(runSeries);
  if (state.seriesProgress) {
    const cancel = document.createElement("button");
    cancel.className = "panel-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => handlers.onSeriesCancel());
    seriesActions.appendChild(cancel);
  }
  const exportSeries = document.createElement("button");
  exportSeries.className = "panel-btn";
  exportSeries.textContent = "Export series CSV";
  exportSeries.title = "Save the per-step table as CSV";
  exportSeries.disabled = !state.series;
  exportSeries.addEventListener("click", () => handlers.onExportSeries());
  seriesActions.appendChild(exportSeries);
  container.appendChild(seriesActions);
  if (state.seriesProgress && state.seriesProgress.total > 0) {
    container.appendChild(note(`Step ${state.seriesProgress.done + 1} of ${state.seriesProgress.total}: ${state.seriesProgress.label}`));
  }
  if (state.seriesMessage) container.appendChild(note(state.seriesMessage, true));
  if (state.seriesHistoryNote) container.appendChild(note(state.seriesHistoryNote, true));
  const series = state.series;
  if (series) {
    const stable = series.rows.filter((x) => x.result).length;
    container.appendChild(note(`${stable} of ${series.rows.length} steps balanced${series.cancelled ? " (cancelled — partial)" : ""}; pick a row to show that step.`));
    const stable2 = document.createElement("table");
    stable2.className = "meshsize-table";
    const head2 = document.createElement("tr");
    const cols = ["step", ...series.rows.flatMap((x) => x.result?.sections.map((s) => s.name) ?? []).filter((v, i, a) => a.indexOf(v) === i)];
    for (const h of [...cols, "net", "Δp"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head2.appendChild(th);
    }
    stable2.appendChild(head2);
    for (const rowData of series.rows) {
      const tr = document.createElement("tr");
      if (rowData.error) tr.className = "meshsize-row-strong";
      const stepCell = document.createElement("td");
      stepCell.textContent = rowData.label;
      stepCell.title = rowData.error ?? "";
      tr.appendChild(stepCell);
      for (const name of cols.slice(1)) {
        const td = document.createElement("td");
        const sec = rowData.result?.sections.find((s) => s.name === name);
        td.textContent = sec ? num(sec.flux) : "";
        td.title = sec ? sec.name : (rowData.error ?? "");
        tr.appendChild(td);
      }
      const netCell = document.createElement("td");
      netCell.textContent = num(rowData.result?.netFlux ?? null);
      tr.appendChild(netCell);
      const dropCell = document.createElement("td");
      dropCell.textContent = num(rowData.result?.pressureDrop?.value ?? null);
      tr.appendChild(dropCell);
      if (!rowData.error && rowData.result) {
        tr.style.cursor = "pointer";
        tr.title = "Show this step";
        tr.addEventListener("click", () => handlers.onPickStep(rowData.frameIndex));
      }
      stable2.appendChild(tr);
    }
    container.appendChild(stable2);
  }
  const r = state.result;
  if (!r) return;

  container.appendChild(
    note(
      "Flux is positive OUT of the domain, so an inlet reads negative." +
        (r.dimension === 2 ? " 2D: per unit depth, not a volume flow rate." : "")
    )
  );

  const table = document.createElement("table");
  table.className = "meshsize-table";
  const head = document.createElement("tr");
  for (const h of ["section", "flux", "area", "mean p"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  const line = (cells: string[], strong: boolean): void => {
    const tr = document.createElement("tr");
    if (strong) tr.className = "meshsize-row-strong";
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      // The columns are fixed-width; the title keeps a clipped value recoverable.
      td.title = c;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  };
  for (const s of r.sections) {
    line([s.name, num(s.flux), fmt(s.area), num(s.meanPressure)], false);
    if (r.density !== undefined && s.massFlux !== null) line([`${s.name} (mass)`, num(s.massFlux), "", ""], false);
  }
  line(["net", num(r.netFlux), "", ""], true);
  line(["imbalance", r.imbalance === null ? "n/a" : `${(100 * r.imbalance).toPrecision(3)} %`, "", ""], true);
  if (r.pressureDrop) line([`Δp ${r.pressureDrop.from} → ${r.pressureDrop.to}`, "", "", num(r.pressureDrop.value)], true);
  if (r.pressureConversion) {
    const c = r.pressureConversion;
    const converted = c.means.flatMap((m) => (m.value === null ? [] : [`${m.section}: ${fmt(m.value)}`])).join(", ");
    line([`in Pa (× ${fmt(c.density)} kg/m³)`, converted || "n/a", "", c.drop === null ? "n/a" : fmt(c.drop)], true);
  }
  container.appendChild(table);

  if (r.pressureUnit) container.appendChild(note(`Pressure in ${r.pressureUnit}${r.pressureConversion ? `; ${r.pressureConversion.note}` : "."}`));
  container.appendChild(note(`Imbalance: ${r.imbalanceNote}.`));
  for (const w of r.warnings) container.appendChild(note(w, true));


}