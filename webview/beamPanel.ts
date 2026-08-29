// Floating panel for the Beams action: turns line cells into true tube glyphs,
// sized by the mesh's CROSS_AREA (from the cell's Properties, or an Elemental
// field) or by a constant when it has none. Pure DOM — mirrors spherePanel.ts,
// down to reusing the .meshsize-* chrome.
//
// The one structural difference from the sphere panel is the "Line conditions"
// toggle, and it is not a nicety. A 2D boundary skin is made of exactly the
// same line cells as a beam and routinely references the same Properties id as
// the part it bounds, so the rendering is limited to Elements by default and
// conditions are opt-in. See beamElements.ts for the gate itself.
//
// There is no "Write to mesh" button, unlike the sphere panel. A beam's section
// belongs in the mdpa Properties block, and the writer copies Properties
// verbatim from the source text — so an operation could only write it as an
// Elemental field, creating a second source of truth that Kratos itself would
// not read. The constant stays a viewing aid.

import { BeamStats } from "../src/parser/beamElements";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { colormapRow, fmt, legend, sectionLabel } from "./panelWidgets";

export interface BeamPanelState {
  enabled: boolean;
  /** Multiplier on every tube's RADIUS — never on its length. */
  thickness: number;
  /** Cylinder tessellation. */
  resolution: number;
  /** Radius used for line cells the mesh gives no section. */
  constant: number;
  /** Also draw line Conditions/Geometries, not just Elements. */
  includeConditions: boolean;
  /** Colour the tubes by section radius rather than flat. */
  colorBySection: boolean;
  colormap: string;
}

/**
 * The line-cell counts/range (from the shared beamStats) plus the suggested
 * constant. Extending BeamStats rather than restating it keeps the panel and
 * the MCP report describing the mesh in exactly the same terms.
 */
export interface BeamPanelInfo extends BeamStats {
  /** The suggested constant (a twentieth of the median element length). */
  suggested: number;
}

export interface BeamPanelHandlers {
  onClose(): void;
  onToggle(): void;
  onThickness(v: number): void;
  onResolution(v: number): void;
  onConstant(v: number): void;
  onIncludeConditions(): void;
  onColorBySection(): void;
  onColormap(name: string): void;
  onFrame(): void;
}

/** Above this many glyphs a fine tessellation starts to cost real frame time. */
const BUSY_GLYPHS = 50_000;

const RESOLUTIONS = [6, 8, 12, 24];

export function renderBeamPanel(
  container: HTMLElement,
  info: BeamPanelInfo,
  state: BeamPanelState,
  handlers: BeamPanelHandlers
): void {
  container.textContent = "";

  // --- header ---
  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Beams";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "meshsize-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  if (info.cells === 0) {
    const empty = document.createElement("div");
    empty.className = "meshsize-summary";
    empty.textContent = "No line (1D) cells in this mesh.";
    container.appendChild(empty);
    return;
  }

  // --- where the sections come from ---
  const summary = document.createElement("div");
  summary.className = "meshsize-summary";
  summary.textContent =
    info.withSection > 0
      ? `CROSS_AREA — ${info.withSection.toLocaleString()} of ${info.cells.toLocaleString()} line cells ` +
        `(radius ${fmt(info.radiusMin)} … ${fmt(info.radiusMax)})`
      : `No CROSS_AREA — ${info.cells.toLocaleString()} line cells drawn at the constant below`;
  container.appendChild(summary);

  if (info.withSection > 0 && info.elementsWithSection === 0) {
    // The mesh resolves sections, but only on conditions — i.e. it looks like a
    // boundary skin sharing a part's Properties. Say so, rather than leaving
    // the user wondering why nothing turned on by itself.
    const note = document.createElement("div");
    note.className = "meshsize-summary";
    note.textContent =
      "Only line conditions carry a section here, so this is most likely a boundary, " +
      "not a set of structural members. Enable “Line conditions” to draw them anyway.";
    container.appendChild(note);
  }

  // --- show/hide ---
  const toggleRow = document.createElement("div");
  toggleRow.className = "meshsize-modes";
  const toggle = document.createElement("button");
  toggle.className = "meshsize-mode-btn";
  toggle.textContent = "Show beams";
  toggle.classList.toggle("active", state.enabled);
  toggle.addEventListener("click", () => handlers.onToggle());
  toggleRow.appendChild(toggle);
  const frame = document.createElement("button");
  frame.className = "meshsize-mode-btn";
  frame.textContent = "Frame";
  frame.addEventListener("click", () => handlers.onFrame());
  toggleRow.appendChild(frame);
  container.appendChild(toggleRow);

  // --- size controls ---
  container.appendChild(sectionLabel("Size"));

  container.appendChild(
    numberRow(
      "Thickness",
      state.thickness,
      0.05,
      handlers.onThickness,
      "Multiplier on every tube's radius. The length always stays the element's own."
    )
  );

  container.appendChild(
    numberRow(
      "Constant radius",
      state.constant,
      Math.max(1e-9, info.suggested / 10),
      handlers.onConstant,
      info.withSection > 0
        ? "Used for line cells with no CROSS_AREA"
        : "Used for every line cell (this mesh declares no section)"
    )
  );

  const hint = document.createElement("div");
  hint.className = "meshsize-summary";
  hint.textContent = `Suggested ${fmt(info.suggested)} — a twentieth of the median element length.`;
  container.appendChild(hint);

  // --- what to draw ---
  container.appendChild(sectionLabel("Include"));
  const kindRow = document.createElement("div");
  kindRow.className = "meshsize-modes";
  const conds = document.createElement("button");
  conds.className = "meshsize-mode-btn";
  conds.textContent = "Line conditions";
  conds.title =
    "Also draw line Conditions and Geometries. Off by default: a 2D boundary is made " +
    "of the same line cells as a beam, and often shares its Properties.";
  conds.classList.toggle("active", state.includeConditions);
  conds.addEventListener("click", () => handlers.onIncludeConditions());
  kindRow.appendChild(conds);
  container.appendChild(kindRow);

  // --- tessellation ---
  container.appendChild(sectionLabel("Detail"));
  const resRow = document.createElement("div");
  resRow.className = "meshsize-modes";
  for (const r of RESOLUTIONS) {
    const btn = document.createElement("button");
    btn.className = "meshsize-mode-btn";
    btn.textContent = String(r);
    btn.classList.toggle("active", state.resolution === r);
    btn.addEventListener("click", () => handlers.onResolution(r));
    resRow.appendChild(btn);
  }
  container.appendChild(resRow);

  if (info.cells > BUSY_GLYPHS && state.resolution >= 12) {
    const warn = document.createElement("div");
    warn.className = "meshsize-summary";
    warn.textContent =
      `${info.cells.toLocaleString()} glyphs at this detail may be slow — try 6 or 8.`;
    container.appendChild(warn);
  }

  // --- colour ---
  if (info.withSection > 0 && info.radiusMax > info.radiusMin) {
    container.appendChild(sectionLabel("Colour"));
    const colorRow = document.createElement("div");
    colorRow.className = "meshsize-modes";
    const bySection = document.createElement("button");
    bySection.className = "meshsize-mode-btn";
    bySection.textContent = "By section";
    bySection.classList.toggle("active", state.colorBySection);
    bySection.addEventListener("click", () => handlers.onColorBySection());
    colorRow.appendChild(bySection);
    container.appendChild(colorRow);

    if (state.colorBySection) {
      container.appendChild(colormapRow(state.colormap, handlers.onColormap));
      container.appendChild(legend(state.colormap, info.radiusMin, info.radiusMax));
    }
  }

  // --- the limit worth stating ---
  const note = document.createElement("div");
  note.className = "meshsize-summary";
  note.textContent =
    "Tubes are circular: a section area alone cannot orient a non-circular profile.";
  container.appendChild(note);
}

function numberRow(
  label: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
  title?: string
): HTMLElement {
  const row = document.createElement("div");
  row.className = "field-row";
  const l = document.createElement("label");
  l.className = "field-label";
  l.textContent = label;
  if (title) l.title = title;
  row.appendChild(l);
  const input = document.createElement("input");
  input.type = "number";
  input.className = "field-select";
  input.min = "0";
  input.step = String(step);
  input.value = String(value);
  if (title) input.title = title;
  const commit = (): void => {
    const v = Number(input.value);
    // A zero or negative radius/thickness draws nothing at all; refuse rather
    // than let the tubes vanish with no explanation.
    if (Number.isFinite(v) && v > 0) onChange(v);
    else input.value = String(value);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") commit();
  });
  row.appendChild(input);
  return row;
}
