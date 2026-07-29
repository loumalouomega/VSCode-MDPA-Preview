// Floating panel for Advanced ▸ Camera Bookmarks…: named camera positions
// saved for this webview session (not persisted across a reload — see
// CLAUDE.md), plus a JSON textarea for cross-session/sharing via
// src/parser/cameraState.ts. Pure DOM, mirrors qualityPanel.ts.

import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import { CameraState, cameraStateToJson, parseCameraJson } from "../src/parser/cameraState";

export interface CameraBookmark {
  name: string;
  state: CameraState;
}

export interface BookmarksPanelState {
  bookmarks: CameraBookmark[];
  /** The current camera, used to prefill "Save" and the JSON textarea. */
  current: CameraState;
}

export interface BookmarksPanelHandlers {
  onClose(): void;
  onSave(name: string): void;
  onRestore(name: string): void;
  onDelete(name: string): void;
  /** Parses the textarea content; only called once it's a valid CameraState. */
  onApplyJson(state: CameraState): void;
}

export function renderBookmarksPanel(
  container: HTMLElement,
  state: BookmarksPanelState,
  handlers: BookmarksPanelHandlers
): void {
  container.textContent = "";

  const header = document.createElement("div");
  header.className = "field-header";
  const title = document.createElement("div");
  title.className = "field-title";
  title.textContent = "Camera Bookmarks";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.className = "field-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
  closeBtn.addEventListener("click", () => handlers.onClose());
  header.appendChild(closeBtn);
  container.appendChild(header);

  // --- Save current view ---
  const saveRow = document.createElement("div");
  saveRow.className = "field-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "field-range-input";
  nameInput.placeholder = "View name…";
  nameInput.style.flex = "1";
  const saveBtn = document.createElement("button");
  saveBtn.className = "field-range-reset";
  saveBtn.textContent = "Save";
  const commitSave = (): void => {
    const name = nameInput.value.trim();
    if (name) {
      handlers.onSave(name);
      nameInput.value = "";
    }
  };
  saveBtn.addEventListener("click", commitSave);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitSave();
  });
  saveRow.append(nameInput, saveBtn);
  container.appendChild(saveRow);

  // --- Saved list ---
  if (state.bookmarks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inspect-summary";
    empty.textContent = "No saved views yet — this list resets when the preview reloads.";
    container.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "inspect-fields";
    for (const bm of state.bookmarks) {
      const row = document.createElement("div");
      row.className = "inspect-row";
      const label = document.createElement("span");
      label.className = "inspect-row-label bookmark-label";
      label.textContent = bm.name;
      label.title = "Click to restore this view";
      label.addEventListener("click", () => handlers.onRestore(bm.name));
      const del = document.createElement("button");
      del.className = "outline-delete-btn bookmark-delete-btn";
      del.title = "Delete this view";
      del.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.close}</span>`;
      del.addEventListener("click", () => handlers.onDelete(bm.name));
      row.append(label, del);
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  // --- JSON textarea (copy for sharing, or paste + Apply) ---
  container.appendChild(section("Camera JSON"));
  const textarea = document.createElement("textarea");
  textarea.className = "bookmark-json";
  textarea.spellcheck = false;
  textarea.value = cameraStateToJson(state.current);
  container.appendChild(textarea);

  const jsonRow = document.createElement("div");
  jsonRow.className = "inspect-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "field-mode-btn";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    textarea.select();
    try {
      await navigator.clipboard.writeText(textarea.value);
    } catch {
      document.execCommand("copy");
    }
  });
  const applyBtn = document.createElement("button");
  applyBtn.className = "field-mode-btn";
  applyBtn.textContent = "Apply";
  const errEl = document.createElement("div");
  errEl.className = "inspect-summary bookmark-json-error";
  applyBtn.addEventListener("click", () => {
    const parsed = parseCameraJson(textarea.value);
    if (parsed) {
      errEl.textContent = "";
      handlers.onApplyJson(parsed);
    } else {
      errEl.textContent = "Not a valid camera JSON.";
    }
  });
  jsonRow.append(copyBtn, applyBtn);
  container.appendChild(jsonRow);
  container.appendChild(errEl);
}

function section(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "inspect-section";
  el.textContent = text;
  return el;
}
