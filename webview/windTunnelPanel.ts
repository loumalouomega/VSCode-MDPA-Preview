/**
 * The virtual wind tunnel wizard: five steps (Body, Tunnel, Flow, Mesh,
 * Generate) over one form, a live plan card under every step, and a build with
 * progress and Cancel.
 *
 * Pure DOM in the chrome the other floating panels share. Nothing is computed
 * here: the plan and the build come from the host (`windTunnelPlan` /
 * `windTunnelRun`, the functions MCP `wind_tunnel_plan` / `wind_tunnel_generate`
 * call), and what the form means is decided in
 * `src/problemtype/windTunnel/form.ts`, which `node:test` can reach.
 *
 * Inputs write straight into the form and do NOT re-render, so typing is never
 * interrupted; a step change, a plan, a progress tick or a result is what
 * re-renders.
 */

import { glyph } from "../src/uiGlyphs";
import { WIZARD_STEPS } from "../src/problemtype/windTunnel/form";
import type { WindTunnelForm } from "../src/problemtype/windTunnel/form";

/** The plan as the host sends it (`summarizePlan` plus the case notes). */
export interface WindTunnelPlanView {
  runnable: boolean;
  errors: string[];
  warnings: string[];
  mode: string;
  body: { triangles: number; size: number[]; surfaceArea: number; frontalArea: number; closed: boolean; problems: string[]; unitScale: number };
  tunnel: { min: number[]; max: number[]; blockage: number; volume: number; halfModel: boolean; ground: string };
  flow: { speed: number; density: number; viscosity: number; reynolds: number; regime: string; dynamicPressure: number };
  boundaryLayer: { firstHeight: number; layers: number; thickness: number; frictionVelocity: number; basis: string };
  sizes: { surface: number; far: number; core: number; wake: number; hausd: number };
  estimate: { expectedTetrahedra: number; nodes: number; memoryMb: number; seconds: number; limit: number; notes: string[] };
  reference: { area: number; length: number };
  steps: { id: string; label: string }[];
  case: string[];
}

export interface WindTunnelResultView {
  files: { mesh: string; body: string; recipe: string; caseState: string };
  report: {
    tetrahedra: number;
    nodes: number;
    seconds: number;
    wallFit?: { max: number; mean: number };
    firstLayer?: { requested: number; achieved: number; yPlus: number };
    check: { inverted: number; minAngle?: number; maxEdgeRatio?: number; unnamedBoundaryFaces: number; problems: string[] };
    warnings: string[];
  };
  problemtype: string;
  caseNotes: string[];
  generated?: { written?: string[] };
}

export interface WindTunnelPanelState {
  form: WindTunnelForm;
  step: number;
  plan?: WindTunnelPlanView;
  planError?: string;
  planning: boolean;
  building: boolean;
  progress?: { done: number; total: number; label: string };
  result?: WindTunnelResultView;
  resultError?: string;
}

export interface WindTunnelPanelHandlers {
  onClose(): void;
  onStep(index: number): void;
  /** A field changed: the host re-plans. */
  onChange(): void;
  onPickBody(): void;
  onPickFolder(): void;
  onGenerate(): void;
  onCancel(): void;
  onOpen(meshPath: string): void;
}

const FLUIDS: { id: string; label: string; density: string; viscosity: string }[] = [
  { id: "air", label: "Air, 20 °C", density: "1.204", viscosity: "1.825e-5" },
  { id: "water", label: "Water, 20 °C", density: "998.2", viscosity: "1.002e-3" },
];

const sig = (v: number, digits = 3): string => (Number.isFinite(v) ? String(+v.toPrecision(digits)) : "—");
const count = (v: number): string => Math.round(v).toLocaleString("en-US");

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function renderWindTunnelPanel(container: HTMLElement, state: WindTunnelPanelState, h: WindTunnelPanelHandlers): void {
  container.textContent = "";
  const form = state.form;
  const busy = state.building;

  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Virtual wind tunnel";
  header.appendChild(title);
  const close = document.createElement("button");
  close.className = "meshsize-close";
  close.title = "Close";
  close.innerHTML = glyph("x");
  close.addEventListener("click", () => h.onClose());
  header.appendChild(close);
  container.appendChild(header);

  // The steps.
  const steps = document.createElement("div");
  steps.className = "meshsize-modes";
  WIZARD_STEPS.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "meshsize-mode-btn" + (i === state.step ? " active" : "");
    b.textContent = `${i + 1} ${s.label}`;
    b.title = s.hint;
    b.disabled = busy;
    b.addEventListener("click", () => h.onStep(i));
    steps.appendChild(b);
  });
  container.appendChild(steps);
  const hint = document.createElement("div");
  hint.className = "meshsize-summary";
  hint.textContent = WIZARD_STEPS[state.step].hint;
  container.appendChild(hint);

  const row = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const bar = document.createElement("div");
    bar.className = "series-toolbar";
    const l = document.createElement("label");
    l.className = "field-label";
    l.textContent = label;
    bar.appendChild(l);
    for (const c of controls) bar.appendChild(c);
    container.appendChild(bar);
    return bar;
  };
  const text = (get: () => string, set: (v: string) => void, placeholder = "", title?: string, width?: string): HTMLInputElement => {
    const el = document.createElement("input");
    el.type = "text";
    el.className = "field-select";
    el.value = get();
    el.placeholder = placeholder;
    el.disabled = busy;
    if (title) el.title = title;
    if (width) el.style.maxWidth = width;
    el.addEventListener("input", () => {
      set(el.value);
      h.onChange();
    });
    return el;
  };
  const select = (options: { value: string; label: string }[], value: string, set: (v: string) => void, title?: string): HTMLSelectElement => {
    const el = document.createElement("select");
    el.className = "field-select";
    el.disabled = busy;
    if (title) el.title = title;
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      opt.selected = o.value === value;
      el.appendChild(opt);
    }
    el.addEventListener("change", () => {
      set(el.value);
      h.onChange();
    });
    return el;
  };
  const check = (get: () => boolean, set: (v: boolean) => void, title?: string): HTMLInputElement => {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.checked = get();
    el.disabled = busy;
    if (title) el.title = title;
    el.addEventListener("change", () => {
      set(el.checked);
      h.onChange();
    });
    return el;
  };
  const button = (label: string, onClick: () => void, opts: { disabled?: boolean; title?: string } = {}): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "panel-btn";
    b.textContent = label;
    b.disabled = opts.disabled === true;
    if (opts.title) b.title = opts.title;
    b.addEventListener("click", onClick);
    return b;
  };
  const note = (t: string, kind: "info" | "warn" | "error" = "info"): HTMLElement => {
    const el = document.createElement("div");
    el.className = "meshsize-summary" + (kind === "info" ? "" : kind === "warn" ? " wt-warn" : " flow-error");
    el.textContent = t;
    container.appendChild(el);
    return el;
  };
  const section = (t: string): void => {
    const el = document.createElement("div");
    el.className = "meshsize-section";
    el.textContent = t;
    container.appendChild(el);
  };

  const plan = state.plan;
  switch (WIZARD_STEPS[state.step].id) {
    case "body": {
      const browse = button("Browse…", () => h.onPickBody(), { disabled: busy });
      row("Body", text(() => form.bodyPath, (v) => { form.bodyPath = v; }, "STL, OBJ or PLY file", "The surface to test"), browse);
      row(
        "Unit",
        select(
          [
            { value: "m", label: "metres" },
            { value: "cm", label: "centimetres" },
            { value: "mm", label: "millimetres" },
            { value: "in", label: "inches" },
            { value: "ft", label: "feet" },
          ],
          form.unit,
          (v) => { form.unit = v; },
          "The unit the file was authored in"
        )
      );
      const rot = form.rotation.map((_, i) => text(() => form.rotation[i], (v) => { form.rotation[i] = v; }, ["x°", "y°", "z°"][i], "Degrees, applied about x, then y, then z", "56px"));
      row("Rotate", ...rot);
      note("The flow runs along +X and up is +Z: turn the body until its nose points at −X and its roof at +Z.");
      if (plan) {
        const b = plan.body;
        note(`Measured: ${sig(b.size[0])} × ${sig(b.size[1])} × ${sig(b.size[2])} m, ${count(b.triangles)} triangles, frontal area ${sig(b.frontalArea)} m².`);
        if (!b.closed) note(`The surface is not clean: ${b.problems.join("; ")}.`, "warn");
      }
      break;
    }
    case "tunnel": {
      row("Upstream", text(() => form.upstream, (v) => { form.upstream = v; }, "3", "Body lengths in front of the body"));
      row("Downstream", text(() => form.downstream, (v) => { form.downstream = v; }, "6", "Body lengths behind the body"));
      row("Sides", text(() => form.side, (v) => { form.side = v; }, "4", "Body widths to each side wall"));
      row("Top", text(() => form.top, (v) => { form.top = v; }, "5", "Body heights above the body"));
      row(
        "Floor",
        select(
          [
            { value: "free", label: "None (free air)" },
            { value: "slip", label: "Slip floor" },
            { value: "noslip", label: "No-slip floor" },
            { value: "moving", label: "Moving ground" },
          ],
          form.ground,
          (v) => { form.ground = v as WindTunnelForm["ground"]; },
          "Free air floats the body in the tunnel; the others put a floor under it. Moving ground moves at the stream speed."
        )
      );
      if (form.ground === "free") row("Below", text(() => form.bottom, (v) => { form.bottom = v; }, "5", "Body heights below a free-air body"));
      else row("Clearance", text(() => form.clearance, (v) => { form.clearance = v; }, "0", "Gap between the lowest point of the body and the floor, in metres"));
      row("Half model", check(() => form.halfModel, (v) => { form.halfModel = v; }, "Mesh only y ≥ 0 and close the cut with a symmetry plane; the body must be symmetric"));
      if (plan) {
        note(`Blockage ${(plan.tunnel.blockage * 100).toFixed(1)}%${plan.tunnel.blockage > 0.05 ? " — above 5%, the walls will speed the flow up" : ""}.`, plan.tunnel.blockage > 0.05 ? "warn" : "info");
      }
      break;
    }
    case "flow": {
      row("Speed", text(() => form.speed, (v) => { form.speed = v; }, "30", "Free-stream speed in m/s"));
      const preset = select(
        [{ value: "", label: "Custom…" }, ...FLUIDS.map((f) => ({ value: f.id, label: f.label }))],
        FLUIDS.find((f) => f.density === form.density && f.viscosity === form.viscosity)?.id ?? (form.density === "" && form.viscosity === "" ? "air" : ""),
        (v) => {
          const f = FLUIDS.find((x) => x.id === v);
          if (f) {
            form.density = f.density;
            form.viscosity = f.viscosity;
            h.onStep(state.step);
          }
        },
        "Air at 20 °C is the default"
      );
      row("Fluid", preset);
      row("Density", text(() => form.density, (v) => { form.density = v; }, "1.204", "kg/m³"));
      row("Viscosity", text(() => form.viscosity, (v) => { form.viscosity = v; }, "1.825e-5", "Dynamic viscosity in Pa·s"));
      row("Turbulence", text(() => form.turbulenceIntensity, (v) => { form.turbulenceIntensity = v; }, "0.01", "Free-stream intensity as a fraction; recorded for turbulence models"));
      if (plan) {
        note(`Re = ${plan.flow.reynolds.toExponential(2)} (${plan.flow.regime}), dynamic pressure ${sig(plan.flow.dynamicPressure)} Pa.`);
        if (plan.flow.regime === "turbulent") note("No turbulence model is applied: the wall law and the dynamic subscales stand in. Treat the forces as a first estimate.", "warn");
      }
      break;
    }
    case "mesh": {
      row(
        "Mesh",
        select(
          [
            { value: "bodyFitted", label: "Body-fitted (carve + wall layer)" },
            { value: "embedded", label: "Embedded (unfitted, distance)" },
          ],
          form.mode,
          (v) => { form.mode = v === "embedded" ? "embedded" : "bodyFitted"; },
          "Body-fitted follows the surface and resolves the boundary layer; embedded keeps the surface unfitted and writes the signed DISTANCE"
        )
      );
      row("Surface", text(() => form.surfaceSize, (v) => { form.surfaceSize = v; }, plan ? sig(plan.sizes.surface) : "L/80", "Cell size along the wall, metres"));
      row("Far field", text(() => form.farSize, (v) => { form.farSize = v; }, plan ? sig(plan.sizes.far) : "L/2", "Largest cell size, metres"));
      if (form.mode === "bodyFitted") {
        row("Target y+", text(() => form.yPlus, (v) => { form.yPlus = v; }, "50", "30–100 suits a wall function"));
        row("First height", text(() => form.firstHeight, (v) => { form.firstHeight = v; }, plan ? sig(plan.boundaryLayer.firstHeight) : "from y+", "Overrides the y+ estimate, metres"));
        row("Growth", text(() => form.growth, (v) => { form.growth = v; }, "1.2", "Layer growth ratio"));
        row("Max aspect", text(() => form.maxAspect, (v) => { form.maxAspect = v; }, "50", "Largest along/across cell ratio in the layer"));
      }
      row("Wake", text(() => form.wakeLength, (v) => { form.wakeLength = v; }, "2", "Refined wake length behind the body, in body lengths (0 = none)"));
      if (plan) {
        if (form.mode === "bodyFitted") {
          note(`First node row ${sig(plan.boundaryLayer.firstHeight * 1000)} mm (${plan.boundaryLayer.basis}); about ${plan.boundaryLayer.layers} layers across the boundary layer (${sig(plan.boundaryLayer.thickness * 1000)} mm).`);
        }
        note(`About ${count(plan.estimate.expectedTetrahedra)} tetrahedra, ${count(plan.estimate.memoryMb)} MB, ${duration(plan.estimate.seconds)}.`, plan.estimate.expectedTetrahedra > plan.estimate.limit ? "error" : "info");
      }
      break;
    }
    case "review": {
      const browse = button("Browse…", () => h.onPickFolder(), { disabled: busy });
      row("Folder", text(() => form.outputFolder, (v) => { form.outputFolder = v; }, "where the mesh and case go", "Created if missing"), browse);
      row("Name", text(() => form.stem, (v) => { form.stem = v; }, "tunnel", "File stem"));
      row("Solver files", check(() => form.generateCase, (v) => { form.generateCase = v; }, "Also write ProjectParameters.json, the materials and MainKratos.py"));
      row("Overwrite", check(() => form.overwrite, (v) => { form.overwrite = v; }, "Replace files of that name that already exist"));
      if (state.planning && !plan) note("Planning…");
      if (state.planError) note(state.planError, "error");
      if (plan) {
        section("Plan");
        note(
          `${plan.mode === "embedded" ? "Embedded" : "Body-fitted"} tunnel ${sig(plan.tunnel.max[0] - plan.tunnel.min[0])} × ${sig(plan.tunnel.max[1] - plan.tunnel.min[1])} × ${sig(plan.tunnel.max[2] - plan.tunnel.min[2])} m, blockage ${(plan.tunnel.blockage * 100).toFixed(1)}%.`
        );
        note(`Re = ${plan.flow.reynolds.toExponential(2)}; first node row ${sig(plan.boundaryLayer.firstHeight * 1000)} mm; about ${count(plan.estimate.expectedTetrahedra)} tetrahedra, ${count(plan.estimate.memoryMb)} MB, ${duration(plan.estimate.seconds)}.`);
        for (const w of plan.warnings) note(w, "warn");
        for (const e of plan.errors) note(e, "error");
        for (const c of plan.case) note(c);
      }
      break;
    }
  }

  // Build progress and result.
  if (state.building && state.progress) {
    const track = document.createElement("div");
    track.className = "wt-progress";
    const bar = document.createElement("div");
    bar.className = "wt-progress-bar";
    bar.style.width = `${Math.max(2, Math.round((100 * state.progress.done) / Math.max(1, state.progress.total)))}%`;
    track.appendChild(bar);
    container.appendChild(track);
    const msg = document.createElement("div");
    msg.className = "edit-progress-msg";
    msg.textContent = state.progress.label;
    container.appendChild(msg);
  }
  if (state.resultError) note(state.resultError, "error");
  if (state.result) {
    const r = state.result.report;
    section("Built");
    note(`${count(r.tetrahedra)} tetrahedra, ${count(r.nodes)} nodes in ${duration(r.seconds)}.`);
    if (r.wallFit) note(`Wall within ${(r.wallFit.max * 100).toFixed(2)}% of the body length of the surface (mean ${(r.wallFit.mean * 100).toFixed(3)}%).`);
    if (r.firstLayer) note(`First node row ${sig(r.firstLayer.achieved * 1000)} mm (asked ${sig(r.firstLayer.requested * 1000)} mm), y+ about ${sig(r.firstLayer.yPlus, 2)}.`);
    note(`Minimum angle ${r.check.minAngle === undefined ? "—" : sig(r.check.minAngle, 2) + "°"}, largest edge ratio ${r.check.maxEdgeRatio === undefined ? "—" : sig(r.check.maxEdgeRatio, 2)}; ${r.check.inverted} inverted.`);
    for (const w of r.warnings.slice(0, 6)) note(w, "warn");
    const open = button("Open the mesh", () => h.onOpen(state.result!.files.mesh), { title: "Opens the mesh with the case prepared in the Problemtype section" });
    const bar = document.createElement("div");
    bar.className = "meshsize-actions";
    bar.appendChild(open);
    container.appendChild(bar);
  }

  // Footer: Back / Next, and Generate on the last step.
  const footer = document.createElement("div");
  footer.className = "meshsize-actions";
  footer.appendChild(button("Back", () => h.onStep(state.step - 1), { disabled: busy || state.step === 0 }));
  if (state.step < WIZARD_STEPS.length - 1) {
    footer.appendChild(button("Next", () => h.onStep(state.step + 1), { disabled: busy }));
  } else if (busy) {
    footer.appendChild(button("Cancel", () => h.onCancel(), { title: "Stops between steps" }));
  } else {
    footer.appendChild(button("Generate", () => h.onGenerate(), { disabled: state.planning || (plan !== undefined && !plan.runnable), title: "Builds the mesh, the case and the report" }));
  }
  container.appendChild(footer);
}
