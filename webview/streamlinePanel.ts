/**
 * The Streamlines panel — trace steady streamlines of a Nodal vector field
 * through the CURRENT frame, draw them over the mesh, and export them.
 *
 * Pure DOM in the `.meshsize-*` / `.series-toolbar` chrome the other analysis
 * panels share. Like the Field integrals and Line probe panels it does not
 * compute: the trace runs on the host (`meshAnalysis` kind `streamlines`) and
 * `main.ts` feeds the answer back. The form lives in `StreamlineForm` (text, so
 * a half-typed value survives a re-render) and every decision about it is in
 * `src/parser/streamlineForm.ts`, where it is unit-tested.
 *
 * Inputs write straight into the shared form object and do NOT re-render — only
 * a result, a seed-kind change or a busy flip does — so typing is never
 * interrupted and a resize or reply cannot eat a draft.
 */

import { glyph } from "../src/uiGlyphs";
import type { StreamDirection, StreamSeedKind, StreamlineForm } from "../src/parser/streamlineForm";

export interface StreamlinePanelState {
  form: StreamlineForm;
  /** Nodal fields with 2 or 3 components. */
  variables: string[];
  /** SubModelPart paths, for seeding from a part. */
  parts: string[];
  busy: boolean;
  /** True while the drawn overlay exists (enables Clear and Export). */
  hasResult: boolean;
  /** True while a viewport click adds a seed point. */
  picking: boolean;
  /** How the last trace ended, or why it could not run. */
  summary?: string;
  isError?: boolean;
}

export interface StreamlinePanelHandlers {
  onClose(): void;
  onSeedKind(kind: StreamSeedKind): void;
  onTrace(): void;
  onClear(): void;
  onExport(): void;
  onTogglePick(): void;
}

const SEED_LABELS: Record<StreamSeedKind, string> = {
  points: "Points",
  line: "Line",
  plane: "Plane",
  part: "SubModelPart",
};

export function renderStreamlinePanel(
  container: HTMLElement,
  state: StreamlinePanelState,
  handlers: StreamlinePanelHandlers
): void {
  container.textContent = "";
  const form = state.form;

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Streamlines";
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
    if (error) el.classList.add("streamline-error");
    el.textContent = text;
    return el;
  };

  if (state.variables.length === 0) {
    container.appendChild(
      note(
        "This mesh has no Nodal vector field to trace. Streamlines need a 2- or 3-component " +
          "field on the nodes — an Elemental field must be moved to them first with Average field."
      )
    );
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

  const select = (options: { value: string; label: string }[], value: string, onChange: (v: string) => void, title?: string): HTMLSelectElement => {
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
    "Field",
    select(
      state.variables.map((v) => ({ value: v, label: v })),
      form.variable,
      (v) => { form.variable = v; },
      "The Nodal vector field to follow"
    )
  );

  row(
    "Seeds",
    select(
      (Object.keys(SEED_LABELS) as StreamSeedKind[]).map((k) => ({ value: k, label: SEED_LABELS[k] })),
      form.seedKind,
      (v) => handlers.onSeedKind(v as StreamSeedKind),
      "Where the streamlines start"
    )
  );

  switch (form.seedKind) {
    case "points": {
      const area = document.createElement("textarea");
      area.className = "field-select streamline-points";
      area.rows = 3;
      area.value = form.points;
      area.placeholder = "x y z — one seed per line";
      area.title = "One seed point per line, as x y z";
      area.addEventListener("input", () => { form.points = area.value; });
      area.dataset.streamlineField = "points";
      row("Points", area);
      const pick = document.createElement("button");
      pick.className = "panel-btn";
      pick.textContent = state.picking ? "Stop picking" : "Pick seeds";
      pick.title = "While on, each click on the mesh adds the nearest node as a seed point";
      if (state.picking) pick.classList.add("active");
      pick.addEventListener("click", () => handlers.onTogglePick());
      const bar = document.createElement("div");
      bar.className = "meshsize-actions";
      bar.appendChild(pick);
      container.appendChild(bar);
      break;
    }
    case "line":
      row("From", text(form.lineFrom, (v) => { form.lineFrom = v; }, "x y z"));
      row("To", text(form.lineTo, (v) => { form.lineTo = v; }, "x y z"));
      row("Count", text(form.lineCount, (v) => { form.lineCount = v; }, "10", "Equidistant seeds, both ends included"));
      break;
    case "plane":
      row("Origin", text(form.planeOrigin, (v) => { form.planeOrigin = v; }, "x y z"));
      row("U", text(form.planeU, (v) => { form.planeU = v; }, "x y z", "First in-plane edge vector, from the origin"));
      row("V", text(form.planeV, (v) => { form.planeV = v; }, "x y z", "Second in-plane edge vector, from the origin"));
      row("Nu × Nv", text(`${form.planeNu} ${form.planeNv}`, (v) => {
        const [a, b] = v.trim().split(/[\s,x×]+/);
        form.planeNu = a ?? "";
        form.planeNv = b ?? "";
      }, "5 5", "Seeds along U and along V"));
      break;
    case "part":
      row(
        "Part",
        select(
          [{ value: "", label: state.parts.length ? "Choose…" : "No SubModelParts" }, ...state.parts.map((p) => ({ value: p, label: p }))],
          form.part,
          (v) => { form.part = v; },
          "Seed from the nodes of this part and its children"
        )
      );
      break;
  }

  row(
    "Direction",
    select(
      [
        { value: "forward", label: "Forward" },
        { value: "backward", label: "Backward" },
        { value: "both", label: "Both" },
      ],
      form.direction,
      (v) => { form.direction = v as StreamDirection; },
      "Both traces two lines per seed"
    )
  );
  row("Max steps", text(form.maxSteps, (v) => { form.maxSteps = v; }, "2000", "Steps per line (blank = 2000)"));
  row("Max length", text(form.maxLength, (v) => { form.maxLength = v; }, "5 × diagonal", "Arc length per line, in mesh units (blank = five bounding-box diagonals)"));
  row("Step", text(form.stepFraction, (v) => { form.stepFraction = v; }, "0.25", "Step as a fraction of the containing cell (blank = 0.25)"));

  const actions = document.createElement("div");
  actions.className = "meshsize-actions";
  const trace = document.createElement("button");
  trace.className = "panel-btn";
  trace.textContent = state.busy ? "Tracing…" : "Trace";
  trace.disabled = state.busy;
  trace.addEventListener("click", () => handlers.onTrace());
  actions.appendChild(trace);
  const clear = document.createElement("button");
  clear.className = "panel-btn";
  clear.textContent = "Clear";
  clear.disabled = !state.hasResult;
  clear.addEventListener("click", () => handlers.onClear());
  actions.appendChild(clear);
  const exp = document.createElement("button");
  exp.className = "panel-btn";
  exp.textContent = "Export…";
  exp.title = "Write the streamlines as line cells (.vtu, .vtp, .vtk …)";
  exp.disabled = state.busy;
  exp.addEventListener("click", () => handlers.onExport());
  actions.appendChild(exp);
  container.appendChild(actions);

  if (state.summary) container.appendChild(note(state.summary, state.isError));
}
