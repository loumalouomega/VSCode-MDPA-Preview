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
import type { FlowBalance } from "../src/parser/flowBalance";
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
}

export interface FlowBalancePanelHandlers {
  onClose(): void;
  onCompute(): void;
  onExport(): void;
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
  container.appendChild(table);

  container.appendChild(note(`Imbalance: ${r.imbalanceNote}.`));
  for (const w of r.warnings) container.appendChild(note(w, true));
}
