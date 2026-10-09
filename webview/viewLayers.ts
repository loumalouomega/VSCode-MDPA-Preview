// Sidebar section for user layers (roadmap item 4): named VIEW-ONLY groups,
// never SubModelParts. Pure DOM, mirrors selectionPanel.ts's row pattern but
// sidebar-embedded rather than floating. Membership is set at creation (blocks
// + parts + a selection snapshot) and never edited afterwards except by the
// prune-on-model-change rule in parser/userLayers.ts; deleting a layer never
// deletes entities, parts or fields.

import { glyph } from "../src/uiGlyphs";
import { UserLayer, describeUserLayer, layerColorToHex } from "../src/parser/userLayers";

export interface ViewLayersState {
  layers: UserLayer[];
  /** Block layer ids in the current model, for the creation form. */
  blockIds: string[];
  /** SubModelPart paths in the current model, for the creation form. */
  partPaths: string[];
  /** Selection set names + counts, for the creation form's snapshot import. */
  selectionNames: string[];
}

export interface ViewLayersHandlers {
  onCreate(name: string, blocks: string[], parts: string[], fromSelection: string | undefined): void;
  onRename(id: string, newName: string): void;
  onToggleVisible(id: string, visible: boolean): void;
  onLock(id: string, locked: boolean): void;
  onRecolour(id: string, hex: string): void;
  onMove(id: string, dir: -1 | 1): void;
  onDelete(id: string): void;
  onPromote(id: string): void;
}

function rowCountLine(l: UserLayer): string {
  return `${describeUserLayer(l)} — ${l.ids.Elements.length} elem / ${l.ids.Conditions.length} cond / ${l.ids.Geometries.length} geom`;
}

export function renderViewLayers(container: HTMLElement, state: ViewLayersState, handlers: ViewLayersHandlers): void {
  container.textContent = "";

  if (state.layers.length === 0) {
    const hint = document.createElement("div");
    hint.className = "inspect-summary";
    hint.textContent = "No view layers yet. Create one from blocks, parts or the active selection below.";
    container.appendChild(hint);
  }

  for (let i = 0; i < state.layers.length; i++) {
    const l = state.layers[i];
    const row = document.createElement("div");
    row.className = "vl-row";
    if (l.locked) row.classList.add("locked");

    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = l.visible;
    vis.title = l.visible ? `Hide view layer "${l.name}" (members stay in the mesh)` : `Show view layer "${l.name}"`;
    vis.addEventListener("change", () => handlers.onToggleVisible(l.id, vis.checked));
    row.appendChild(vis);

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "vl-swatch";
    swatch.value = layerColorToHex(l.color);
    swatch.title = `Recolour view layer "${l.name}" (view-only)`;
    swatch.addEventListener("change", () => handlers.onRecolour(l.id, swatch.value));
    row.appendChild(swatch);

    const label = document.createElement("span");
    label.className = "vl-name";
    label.textContent = l.name;
    label.title = `${rowCountLine(l)}${l.locked ? " — locked" : ""}`;
    row.appendChild(label);

    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "panel-icon-btn";
    lock.title = l.locked ? `Unlock "${l.name}"` : `Lock "${l.name}" (blocks rename, reorder, delete and promote)`;
    lock.innerHTML = glyph(l.locked ? "lock" : "unlock");
    lock.setAttribute("aria-pressed", String(l.locked));
    lock.addEventListener("click", () => handlers.onLock(l.id, !l.locked));
    row.appendChild(lock);

    const up = document.createElement("button");
    up.type = "button";
    up.className = "panel-icon-btn";
    up.title = `Move "${l.name}" up`;
    up.innerHTML = glyph("chevronUp");
    up.disabled = l.locked || i === 0;
    up.addEventListener("click", () => handlers.onMove(l.id, -1));
    row.appendChild(up);

    const down = document.createElement("button");
    down.type = "button";
    down.className = "panel-icon-btn";
    down.title = `Move "${l.name}" down`;
    down.innerHTML = glyph("chevronDown");
    down.disabled = l.locked || i === state.layers.length - 1;
    down.addEventListener("click", () => handlers.onMove(l.id, 1));
    row.appendChild(down);

    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "panel-btn";
    promote.textContent = "Promote";
    promote.title = `Create a real SubModelPart from "${l.name}" (undoable edit — the only way a view layer reaches the solver)`;
    promote.disabled = l.locked;
    promote.addEventListener("click", () => handlers.onPromote(l.id));
    row.appendChild(promote);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "panel-icon-btn";
    del.title = `Delete view layer "${l.name}" (members stay in the mesh)`;
    del.innerHTML = glyph("x");
    del.disabled = l.locked;
    del.addEventListener("click", () => handlers.onDelete(l.id));
    row.appendChild(del);

    // Inline rename: double-click the name, Enter commits, Escape cancels —
    // the same no-native-prompts convention as outline.ts's pen button.
    if (!l.locked) {
      label.style.cursor = "text";
      label.addEventListener("dblclick", () => {
        if (row.querySelector(".vl-rename")) return;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "vl-rename edit-text";
        input.value = l.name;
        label.style.display = "none";
        row.insertBefore(input, label);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit: boolean): void => {
          if (done) return;
          done = true;
          const val = input.value.trim();
          input.remove();
          label.style.display = "";
          if (commit && val && val !== l.name) handlers.onRename(l.id, val);
        };
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            finish(true);
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            finish(false);
          }
          ev.stopPropagation();
        });
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("click", (ev) => ev.stopPropagation());
      });
    }

    container.appendChild(row);
  }

  // --- creation form ---
  const form = document.createElement("div");
  form.className = "vl-create";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "vl-name";
  nameInput.className = "edit-text";
  nameInput.placeholder = "Layer name";
  nameInput.title = "View layer name (no / — that separator belongs to SubModelParts)";
  form.appendChild(nameInput);

  const blocksDetails = document.createElement("details");
  blocksDetails.className = "vl-pick";
  const blocksSummary = document.createElement("summary");
  blocksSummary.textContent = `Blocks (${state.blockIds.length})`;
  blocksDetails.appendChild(blocksSummary);
  const blocksBox = document.createElement("div");
  blocksBox.className = "vl-pick-box";
  for (const b of state.blockIds) {
    const lab = document.createElement("label");
    lab.className = "vl-pick-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = b;
    cb.className = "vl-block-cb";
    lab.append(cb, document.createTextNode(b));
    blocksBox.appendChild(lab);
  }
  if (state.blockIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inspect-summary";
    empty.textContent = "No blocks in the mesh.";
    blocksBox.appendChild(empty);
  }
  blocksDetails.appendChild(blocksBox);
  form.appendChild(blocksDetails);

  const partsDetails = document.createElement("details");
  partsDetails.className = "vl-pick";
  const partsSummary = document.createElement("summary");
  partsSummary.textContent = `SubModelParts (${state.partPaths.length})`;
  partsDetails.appendChild(partsSummary);
  const partsBox = document.createElement("div");
  partsBox.className = "vl-pick-box";
  for (const p of state.partPaths) {
    const lab = document.createElement("label");
    lab.className = "vl-pick-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p;
    cb.className = "vl-part-cb";
    lab.append(cb, document.createTextNode(p));
    partsBox.appendChild(lab);
  }
  if (state.partPaths.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inspect-summary";
    empty.textContent = "No SubModelParts in the mesh.";
    partsBox.appendChild(empty);
  }
  partsDetails.appendChild(partsBox);
  form.appendChild(partsDetails);

  const selRow = document.createElement("div");
  selRow.className = "vl-sel-row";
  const selSel = document.createElement("select");
  selSel.id = "vl-selection";
  selSel.className = "edit-sel";
  selSel.title = "Snapshot explicit ids from a selection set (frozen at creation, then pruned like any explicit pick)";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No selection snapshot";
  selSel.appendChild(none);
  for (const n of state.selectionNames) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    selSel.appendChild(o);
  }
  selRow.appendChild(selSel);
  form.appendChild(selRow);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "panel-btn";
  add.textContent = "Add view layer";
  add.title = "Create a view-only layer from the checked blocks/parts and the selection snapshot";
  add.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const blocks = Array.from(form.querySelectorAll<HTMLInputElement>(".vl-block-cb:checked")).map((c) => c.value);
    const parts = Array.from(form.querySelectorAll<HTMLInputElement>(".vl-part-cb:checked")).map((c) => c.value);
    const fromSelection = selSel.value || undefined;
    handlers.onCreate(name, blocks, parts, fromSelection);
  });
  form.appendChild(add);

  container.appendChild(form);
}
