// Floating panel for the Selection toolbar mode: named selection SETS over
// Entities/Conditions/Geometries (independent id spaces), seeded either by
// explicit picks (Ctrl+click in the viewport, box select) or by a predicate
// that re-resolves against every model change — which is how a selection
// "survives applicable edits through correspondence" (src/parser/selectionCore.ts).
// Also: Isolate/Hide/Restore, and the two selection-driven routes — a new
// SubModelPart (an ordinary, undoable applyOp) and an export. Pure DOM,
// mirrors inspectPanel.ts.

import { glyph } from "../src/uiGlyphs";
import { fmt } from "./panelWidgets";
import { SelectionSet, describeSeed } from "../src/parser/selectionCore";

export type SelectionMode = "single" | "box" | "lasso";

export interface SelectionPanelState {
  sets: SelectionSet[];
  /** Which set picks / isolate / hide act on. */
  activeIndex: number;
  mode: SelectionMode;
  isolate: boolean;
  /** Named SubModelPart paths for the "Put in SubModelPart" input dropdown. */
  partPaths: string[];
  /** Nodal/Elemental field variable names for the field seed's name box. */
  fieldNames: string[];
}

export interface SelectionPanelHandlers {
  onClose(): void;
  onSetActive(index: number): void;
  /** Switches the gesture mode in main.ts (the mode drives the pointer
   *  handling and which overlay the next gesture draws). */
  onSetMode(mode: SelectionMode): void;
  /** Creates a new set seeded by a predicate built in the panel row. */
  onAddSeed(kind: string, params: Record<string, unknown>): void;
  /** Left-click "frame the active set's first highlight" (Frame button). */
  onFrame(): void;
  /** Creates a SubModelPart from the ACTIVE set via an ordinary applyOp. */
  onNewSubModelPart(name: string, parentPath: string): void;
  onExportActive(): void;
  onIsolate(): void;
  onHide(): void;
  onRestore(): void;
  /** DELETE the active set's entities via the deleteEntities op. */
  onDeleteActive(): void;
  onClearActive(): void;
  onDelete(index: number): void;
}

function section(title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "inspect-section";
  el.textContent = title;
  return el;
}

function smallBtn(label: string, title: string, handler: () => void, danger = false): HTMLElement {
  const b = document.createElement("button");
  b.className = "panel-btn" + (danger ? " danger" : "");
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", handler);
  return b;
}

export function renderSelectionPanel(
  container: HTMLElement,
  state: SelectionPanelState,
  handlers: SelectionPanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "field-header";
  const title = document.createElement("div");
  title.className = "field-title";
  title.textContent = "Selection";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  // Gesture mode: the design system's segmented track (1 of N), so the three
  // modes read as one mutually-exclusive choice rather than three toggles.
  const modeRow = document.createElement("div");
  modeRow.className = "ui-segments";
  for (const [m, label, title] of [
    ["single", "Single", "Ctrl+click toggles entities in the active set"],
    ["box", "Box", "Drag a rectangle over the mesh to union the entities inside (Ctrl+click still toggles singles)"],
    ["lasso", "Lasso", "Click points around a region; click the first point or press Enter to close, Escape cancels"],
  ] as const) {
    const seg = document.createElement("button");
    seg.className = "ui-seg";
    seg.classList.toggle("active", state.mode === m);
    seg.textContent = label;
    seg.title = title;
    seg.addEventListener("click", () => handlers.onSetMode(m));
    modeRow.appendChild(seg);
  }
  container.appendChild(modeRow);

  const active = state.sets[state.activeIndex];
  const countLine = (s: SelectionSet): string => {
    const c = s.kinds;
    return `${c.Elements.length} elem / ${c.Conditions.length} cond / ${c.Geometries.length} geom`;
  };

  // --- set list ---
  for (let i = 0; i < state.sets.length; i++) {
    const s = state.sets[i];
    const row = document.createElement("div");
    row.className = "sel-set-row";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "sel-active";
    radio.checked = i === state.activeIndex;
    radio.title = "Make this the active set (picks, isolate and hide act on it)";
    radio.addEventListener("change", () => handlers.onSetActive(i));
    row.appendChild(radio);
    const label = document.createElement("span");
    label.className = "sel-set-name";
    label.textContent = `${s.name} — ${describeSeed(s.seed)} — ${s.kinds.Elements.length + s.kinds.Conditions.length + s.kinds.Geometries.length}`;
    label.title = countLine(s);
    row.appendChild(label);
    const del = document.createElement("button");
    del.className = "panel-icon-btn";
    del.title = "Delete this set";
    del.innerHTML = glyph("x");
    del.addEventListener("click", () => handlers.onDelete(i));
    row.appendChild(del);
    container.appendChild(row);
  }

  if (state.sets.length === 0) {
    const hint = document.createElement("div");
    hint.className = "inspect-summary";
    hint.textContent = "Ctrl+click entities on the mesh to fill a set, or seed one below. A field seed re-resolves against every new frame, so it follows the timeline.";
    container.appendChild(hint);
  }

  if (!active) return;

  // active-set actions
  const actions = document.createElement("div");
  actions.className = "inspect-actions";
  const frameBtn = document.createElement("button");
  frameBtn.className = "panel-btn";
  frameBtn.innerHTML = `<span class="ui-glyph">${glyph("maximize")}</span> Frame`;
  frameBtn.title = "Frame the selection";
  frameBtn.addEventListener("click", () => handlers.onFrame());
  actions.appendChild(frameBtn);
  actions.appendChild(smallBtn("New SubModelPart", "Create a SubModelPart holding the selection (an ordinary, undoable operation)", () => {
    const nameInput = document.getElementById("sel-smp-name") as HTMLInputElement | null;
    const parent = document.getElementById("sel-smp-parent") as HTMLSelectElement | null;
    const name = (nameInput?.value ?? "").trim();
    if (!name) {
      nameInput?.focus();
      return;
    }
    handlers.onNewSubModelPart(name, parent?.value ?? "");
  }));
  actions.appendChild(smallBtn("Export", "Export the selection as its own mesh file (original ids preserved)", () => handlers.onExportActive()));
  actions.appendChild(smallBtn("Delete entities", "DELETE the selected entities as one undoable edit — conditions on the surviving region stay, constraints vanish with their nodes, fields and SubModelParts follow, orphan nodes are cleaned up", () => handlers.onDeleteActive(), true));
  actions.appendChild(smallBtn("Clear", "Empty the active set (it keeps its seed)", () => handlers.onClearActive()));
  container.appendChild(actions);

  const subRow = document.createElement("div");
  subRow.className = "inspect-actions";
  const subInput = document.createElement("input");
  subInput.type = "text";
  subInput.id = "sel-smp-name";
  subInput.className = "edit-text";
  subInput.placeholder = "SubModelPart name";
  subInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const parent = document.getElementById("sel-smp-parent") as HTMLSelectElement | null;
      const name = subInput.value.trim();
      if (name) handlers.onNewSubModelPart(name, parent?.value ?? "");
    }
  });
  subRow.appendChild(subInput);
  const parentSel = document.createElement("select");
  parentSel.id = "sel-smp-parent";
  parentSel.className = "edit-sel";
  parentSel.title = "Parent SubModelPart (none = top level)";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "— top level —";
  parentSel.appendChild(optNone);
  for (const p of state.partPaths) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    parentSel.appendChild(o);
  }
  subRow.appendChild(parentSel);
  container.appendChild(subRow);

  // visibility actions
  const visActions = document.createElement("div");
  visActions.className = "inspect-actions";
  const isolateBtn = document.createElement("button");
  isolateBtn.className = "panel-btn";
  isolateBtn.classList.toggle("active", state.isolate);
  isolateBtn.textContent = "Isolate";
  isolateBtn.title = "Show only the selection: every block layer the selection does not touch is suppressed";
  isolateBtn.addEventListener("click", () => handlers.onIsolate());
  visActions.appendChild(isolateBtn);
  visActions.appendChild(smallBtn("Hide", "Suppress every block layer the selection touches (block granularity)", () => handlers.onHide()));
  visActions.appendChild(smallBtn("Restore", "Undo every Isolate/Hide suppression", () => handlers.onRestore()));
  container.appendChild(visActions);

  // --- seed builder ---
  container.appendChild(section("Seed a new set from"));
  const seedRow = document.createElement("div");
  seedRow.className = "inspect-actions";
  const kindSel = document.createElement("select");
  kindSel.id = "sel-seed-kind";
  kindSel.className = "edit-sel";
  for (const [v, t] of [["part", "SubModelPart"], ["field", "Field range"], ["quality", "Quality metric"], ["property", "Property id"]] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    kindSel.appendChild(o);
  }
  seedRow.appendChild(kindSel);
  const partSel = document.createElement("select");
  partSel.id = "sel-seed-part";
  partSel.className = "edit-sel";
  for (const p of state.partPaths) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    partSel.appendChild(o);
  }
  seedRow.appendChild(partSel);
  const fieldSel = document.createElement("select");
  fieldSel.id = "sel-seed-field";
  fieldSel.className = "edit-sel";
  for (const f of state.fieldNames) {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    fieldSel.appendChild(o);
  }
  seedRow.appendChild(fieldSel);
  const qualitySel = document.createElement("select");
  qualitySel.id = "sel-seed-quality";
  qualitySel.className = "edit-sel";
  qualitySel.title = "meshQuality's per-element metrics";
  for (const m of [["edgeRatio", "Aspect / Edge ratio"], ["minAngle", "Min angle"], ["maxAngle", "Max angle"], ["gradation", "Size gradation"]] as const) {
    const o = document.createElement("option");
    o.value = m[0];
    o.textContent = m[1];
    qualitySel.appendChild(o);
  }
  seedRow.appendChild(qualitySel);
  const propInput = document.createElement("input");
  propInput.type = "number";
  propInput.id = "sel-seed-prop";
  propInput.className = "edit-num";
  propInput.placeholder = "property id";
  seedRow.appendChild(propInput);
  const loInput = document.createElement("input");
  loInput.type = "number";
  loInput.id = "sel-seed-lo";
  loInput.className = "edit-num";
  loInput.placeholder = "min";
  seedRow.appendChild(loInput);
  const hiInput = document.createElement("input");
  hiInput.type = "number";
  hiInput.id = "sel-seed-hi";
  hiInput.className = "edit-num";
  hiInput.placeholder = "max";
  seedRow.appendChild(hiInput);
  const anyCheck = document.createElement("input");
  anyCheck.type = "checkbox";
  anyCheck.id = "sel-seed-any";
  anyCheck.title = 'Any node in range (default: every node in range)';
  const anyLabel = document.createElement("label");
  anyLabel.appendChild(anyCheck);
  anyLabel.appendChild(document.createTextNode("any"));
  seedRow.appendChild(anyLabel);
  container.appendChild(seedRow);

  const confirmRow = document.createElement("div");
  confirmRow.className = "inspect-actions";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "sel-seed-name";
  nameInput.className = "edit-text";
  nameInput.placeholder = "set name";
  confirmRow.appendChild(nameInput);
  const go = document.createElement("button");
  go.className = "panel-btn";
  go.textContent = "Add set";
  go.title = "Resolve the seed against the CURRENT model and add it";
  go.addEventListener("click", () => {
    const kindSel = document.getElementById("sel-seed-kind") as HTMLSelectElement;
    const name = ((document.getElementById("sel-seed-name") as HTMLInputElement)?.value ?? "").trim() || "Set " + (state.sets.length + 1);
    const kind = kindSel.value;
    if (kind === "part") {
      const path = (document.getElementById("sel-seed-part") as HTMLSelectElement)?.value ?? "";
      if (path) handlers.onAddSeed("part", { kind: "part", path });
      return;
    }
    if (kind === "field") {
      const lo = Number((document.getElementById("sel-seed-lo") as HTMLInputElement)?.value ?? Number.NaN);
      const hi = Number((document.getElementById("sel-seed-hi") as HTMLInputElement)?.value ?? Number.NaN);
      const any = Boolean((document.getElementById("sel-seed-any") as HTMLInputElement)?.checked);
      const variable = (document.getElementById("sel-seed-field") as HTMLSelectElement)?.value ?? "";
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || !variable) return;
      handlers.onAddSeed("field", { kind: "field", variable, blockKind: "Nodal", lo, hi, rule: any ? "any" : "all" });
      return;
    }
    if (kind === "property") {
      const id = Number((document.getElementById("sel-seed-prop") as HTMLInputElement)?.value ?? Number.NaN);
      if (!Number.isInteger(id) || id <= 0) return;
      handlers.onAddSeed("property", { kind: "property", propertyId: id });
    }
    if (kind === "quality") {
      const metric = (document.getElementById("sel-seed-quality") as HTMLSelectElement)?.value ?? "";
      if (metric) handlers.onAddSeed("quality", { kind: "quality", metric });
    }
  });
  confirmRow.appendChild(go);
  container.appendChild(confirmRow);

  // The seed row shows only the inputs the chosen kind reads.
  const syncSeedVisibility = (): void => {
    const kind = kindSel.value;
    partSel.style.display = kind === "part" ? "" : "none";
    fieldSel.style.display = kind === "field" ? "" : "none";
    loInput.style.display = kind === "field" ? "" : "none";
    hiInput.style.display = kind === "field" ? "" : "none";
    anyLabel.style.display = kind === "field" ? "" : "none";
    qualitySel.style.display = kind === "quality" ? "" : "none";
    propInput.style.display = kind === "property" ? "" : "none";
  };
  kindSel.addEventListener("change", syncSeedVisibility);
  syncSeedVisibility();
}

/** The set list's one-line count summary (used by main.ts's toasts). */
export function selectionCountsLine(s: SelectionSet): string {
  const t = s.kinds.Elements.length + s.kinds.Conditions.length + s.kinds.Geometries.length;
  return `${t} (${fmt(s.kinds.Elements.length)} elem, ${fmt(s.kinds.Conditions.length)} cond, ${fmt(s.kinds.Geometries.length)} geom)`;
}
