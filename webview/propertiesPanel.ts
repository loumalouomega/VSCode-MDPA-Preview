// Floating panel for the Properties editor: every `Begin Properties <id>`
// set with its variables, editable in place through the property ops
// (propertyOps.ts). Two authoring shapes, deliberately both exposed:
// editing a shared set in place, and clone-and-reassign. Beams' CROSS_AREA
// resolves through these sets (beamElements.ts), so an edit re-renders with
// no extra wiring. Pure DOM, mirrors selectionPanel.ts.

import { glyph } from "../src/uiGlyphs";
import { PropertySet, PropertyValue, formatPropertyValue } from "../src/parser/propertiesParser";

export interface PropertyPanelState {
  /** Plain floats: the tagged records are re-serialized over postMessage, so
   *  variables/tables come through JSON as their parsed shape. */
  sets: PropertySet[];
}

export interface PropertyPanelHandlers {
  onClose(): void;
  /** setProperty — one variable of one set, value already coerced. */
  onSetValue(propertyId: number, name: string, value: unknown): void;
  onCreateSet(): void;
  onCloneSet(propertyId: number): void;
  onDeleteSet(propertyId: number): void;
  onAssignSet(propertyId: number, partPath: string): void;
  /** The named SubModelPart subtree paths for the Assign dropdown. */
  partPaths?: string[];
}

function headerRow(container: HTMLElement, title: string, onClose: () => void): void {
  const header = document.createElement("div");
  header.className = "field-header";
  const titleEl = document.createElement("div");
  titleEl.className = "field-title";
  titleEl.textContent = title;
  header.appendChild(titleEl);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = glyph("x");
  closeBtn.addEventListener("click", onClose);
  header.appendChild(closeBtn);
  container.appendChild(header);
}

/** One set row: id, its variables (editable inline), Clone/Delete/Assign. */
function setRow(model: PropertySet, handlers: PropertyPanelHandlers, partPaths: string[], hasAnyBlock: boolean): HTMLElement {
  const card = document.createElement("div");
  card.className = "prop-set";

  const head = document.createElement("div");
  head.className = "prop-set-head";
  const label = document.createElement("span");
  label.className = "prop-set-name";
  label.textContent = `Properties ${model.id}`;
  head.appendChild(label);
  const cloneBtn = document.createElement("button");
  cloneBtn.className = "panel-icon-btn";
  cloneBtn.title = "Clone this set to a fresh id (leaves blocks alone; assign selectively afterwards)";
  cloneBtn.textContent = "Clone";
  cloneBtn.addEventListener("click", () => handlers.onCloneSet(model.id));
  head.appendChild(cloneBtn);
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "panel-icon-btn";
  deleteBtn.title = "Delete this set (refused while any block still references it)";
  deleteBtn.innerHTML = glyph("x");
  deleteBtn.addEventListener("click", () => handlers.onDeleteSet(model.id));
  head.appendChild(deleteBtn);
  card.appendChild(head);

  for (const key of Object.keys(model.variables)) {
    const v: PropertyValue = model.variables[key];
    const row = document.createElement("div");
    row.className = "prop-var-row";
    const name = document.createElement("span");
    name.className = "prop-var-name";
    name.textContent = key;
    name.title = formatPropertyValue(v);
    row.appendChild(name);
    const valueInput = document.createElement("input");
    valueInput.className = "edit-text";
    valueInput.spellcheck = false;
    valueInput.title = "Set a new value (a number, True/False, or text as-is)";
    const current =
      v.kind === "number" ? String(v.value)
      : v.kind === "bool" ? (v.value ? "True" : "False")
      : v.kind === "vector" ? `[${v.values.join(",")}]`
      : v.kind === "matrix" ? v.rows.map((r) => `[${r.join(",")}]`).join(" ")
      : v.value;
    valueInput.value = current;
    valueInput.setAttribute("data-prop-id", String(model.id));
    valueInput.setAttribute("data-prop-name", key);
    valueInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitValue(valueInput, handlers);
    });
    valueInput.addEventListener("blur", () => commitValue(valueInput, handlers));
    row.appendChild(valueInput);
    card.appendChild(row);
  }

  const assignRow = document.createElement("div");
  assignRow.className = "prop-assign-row";
  const assignSel = document.createElement("select");
  assignSel.className = "edit-sel";
  assignSel.title = "Assign this set to a SubModelPart's entities by rewriting their propertyIds rows";
  const a0 = document.createElement("option");
  a0.value = "";
  a0.textContent = hasAnyBlock ? "Assign to SubModelPart…" : "no property-bearing blocks yet";
  a0.disabled = !hasAnyBlock;
  assignSel.appendChild(a0);
  for (const p of partPaths) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    assignSel.appendChild(o);
  }
  assignSel.addEventListener("change", () => {
    if (assignSel.value) {
      handlers.onAssignSet(model.id, assignSel.value);
      assignSel.selectedIndex = 0;
    }
  });
  assignRow.appendChild(assignSel);
  card.appendChild(assignRow);
  return card;
}

function commitValue(input: HTMLInputElement, handlers: PropertyPanelHandlers): void {
  const propertyId = Number(input.getAttribute("data-prop-id"));
  const name = input.getAttribute("data-prop-name") ?? "";
  const text = input.value.trim();
  if (!text) return; // blank = leave as-is
  let value: unknown;
  if (/^(true|false)$/i.test(text)) value = /^true$/i.test(text);
  else if (text !== "" && Number.isFinite(Number(text))) value = Number(text);
  else if (text.startsWith("[") && text.endsWith("]")) {
    if (text.startsWith("[[")) {
      const rows = text
        .split(")")
        .map((r) => r.replace(/[\[\(\)]/g, "").trim())
        .filter(Boolean)
        .map((r) => r.split(",").map((n) => Number(n.trim())));
      value = rows;
    } else {
      value = text.slice(1, -1).split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
    }
  } else value = text;
  handlers.onSetValue(propertyId, name, value);
}

export function renderPropertyPanel(
  container: HTMLElement,
  state: PropertyPanelState,
  handlers: PropertyPanelHandlers
): void {
  container.textContent = "";
  headerRow(container, "Properties", handlers.onClose);
  if (state.sets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inspect-summary";
    empty.textContent = "This mesh declares no Properties blocks. Create one to author values (for example a beam CROSS_AREA) and assign it to a SubModelPart.";
    container.appendChild(empty);
  }
  for (const s of state.sets) {
    container.appendChild(setRow(s, handlers, handlers.partPaths ?? [], (handlers.partPaths?.length ?? 0) > 0));
  }
  const footer = document.createElement("div");
  footer.className = "inspect-actions";
  const createBtn = document.createElement("button");
  createBtn.className = "panel-btn";
  createBtn.textContent = "New Properties block";
  createBtn.title = "Append an empty Properties block (its id is one past the largest)";
  createBtn.addEventListener("click", () => handlers.onCreateSet());
  footer.appendChild(createBtn);
  container.appendChild(footer);
}
