// Floating panel for the Spheres action: turns one-node (particle) cells into
// true sphere glyphs, sized by the mesh's RADIUS field or by a constant when it
// has none. Pure DOM — mirrors meshSizePanel.ts / qualityPanel.ts.
//
// The constant is not a cosmetic default. A real peridynamics file (issue #63)
// routinely declares SPHERE elements and no radius at all, so without it there
// is nothing to draw; "Write to mesh" then turns the chosen constant into a
// real RADIUS field that exports and round-trips.

import { SphereStats } from "../src/parser/sphereElements";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { colormapRow, fmt, legend, sectionLabel } from "./panelWidgets";

export interface SpherePanelState {
  enabled: boolean;
  /** Multiplier on every particle's radius. */
  scale: number;
  /** Sphere tessellation (theta = phi). */
  resolution: number;
  /** Radius used for particles the mesh gives none. */
  constant: number;
  /** Colour the glyphs by radius rather than flat. */
  colorByRadius: boolean;
  colormap: string;
}

/**
 * The particle counts/range (from the shared sphereStats) plus the suggested
 * constant. Extending SphereStats rather than restating it keeps the panel and
 * the MCP report describing the mesh in exactly the same terms.
 */
export interface SpherePanelInfo extends SphereStats {
  /** The suggested constant (half the nearest-neighbour spacing). */
  suggested: number;
}

export interface SpherePanelHandlers {
  onClose(): void;
  onToggle(): void;
  onScale(v: number): void;
  onResolution(v: number): void;
  onConstant(v: number): void;
  onColorByRadius(): void;
  onColormap(name: string): void;
  onWrite(): void;
  onFrame(): void;
}

/** Above this many glyphs a fine tessellation starts to cost real frame time. */
const BUSY_GLYPHS = 50_000;

const RESOLUTIONS = [8, 16, 32, 48];

export function renderSpherePanel(
  container: HTMLElement,
  info: SpherePanelInfo,
  state: SpherePanelState,
  handlers: SpherePanelHandlers
): void {
  container.textContent = "";

  // --- header ---
  const header = document.createElement("div");
  header.className = "meshsize-header";
  const title = document.createElement("div");
  title.className = "meshsize-title";
  title.textContent = "Spheres";
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
    empty.textContent = "No one-node (particle) elements in this mesh.";
    container.appendChild(empty);
    return;
  }

  // --- where the radii come from ---
  const summary = document.createElement("div");
  summary.className = "meshsize-summary";
  summary.textContent =
    info.withRadius > 0
      ? `RADIUS field — ${info.withRadius.toLocaleString()} of ${info.cells.toLocaleString()} particles ` +
        `(${fmt(info.radiusMin)} … ${fmt(info.radiusMax)})`
      : `No RADIUS field — ${info.cells.toLocaleString()} particles drawn at the constant below`;
  container.appendChild(summary);

  // --- show/hide ---
  const toggleRow = document.createElement("div");
  toggleRow.className = "meshsize-modes";
  const toggle = document.createElement("button");
  toggle.className = "meshsize-mode-btn";
  toggle.textContent = "Show spheres";
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
    numberRow("Scale", state.scale, 0.05, handlers.onScale, "Multiplier on every particle's radius")
  );

  const constRow = numberRow(
    "Constant radius",
    state.constant,
    Math.max(1e-9, info.suggested / 10),
    handlers.onConstant,
    info.withRadius > 0
      ? "Used for particles the RADIUS field does not cover"
      : "Used for every particle (this mesh declares no radius)"
  );
  container.appendChild(constRow);

  const hint = document.createElement("div");
  hint.className = "meshsize-summary";
  hint.textContent = `Suggested ${fmt(info.suggested)} — half the nearest-neighbour spacing.`;
  container.appendChild(hint);

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

  if (info.cells > BUSY_GLYPHS && state.resolution >= 32) {
    const warn = document.createElement("div");
    warn.className = "meshsize-summary";
    warn.textContent =
      `${info.cells.toLocaleString()} glyphs at this detail may be slow — try 8 or 16.`;
    container.appendChild(warn);
  }

  // --- colour ---
  if (info.withRadius > 0) {
    container.appendChild(sectionLabel("Colour"));
    const colorRow = document.createElement("div");
    colorRow.className = "meshsize-modes";
    const byRadius = document.createElement("button");
    byRadius.className = "meshsize-mode-btn";
    byRadius.textContent = "By radius";
    byRadius.classList.toggle("active", state.colorByRadius);
    byRadius.addEventListener("click", () => handlers.onColorByRadius());
    colorRow.appendChild(byRadius);
    container.appendChild(colorRow);

    if (state.colorByRadius) {
      container.appendChild(colormapRow(state.colormap, handlers.onColormap));
      container.appendChild(legend(state.colormap, info.radiusMin, info.radiusMax));
    }
  }

  // --- persist ---
  container.appendChild(sectionLabel("Write to mesh"));
  const writeNote = document.createElement("div");
  writeNote.className = "meshsize-summary";
  writeNote.textContent =
    "Store the constant as a RADIUS field on every particle (undoable; persists on Save/Export).";
  container.appendChild(writeNote);
  const writeRow = document.createElement("div");
  writeRow.className = "meshsize-modes";
  const write = document.createElement("button");
  write.className = "meshsize-mode-btn";
  write.textContent = `Write RADIUS = ${fmt(state.constant)}`;
  write.addEventListener("click", () => handlers.onWrite());
  writeRow.appendChild(write);
  container.appendChild(writeRow);
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
    // A zero or negative radius/scale draws nothing at all; refuse rather than
    // let the viewport go blank with no explanation.
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
