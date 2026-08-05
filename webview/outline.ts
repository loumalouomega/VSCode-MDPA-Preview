// Renders the ModelPart / SubModelPart outline as a tree of toggleable layers.
// Pure DOM, no framework. Each node with a `layerId` gets a visibility checkbox
// (the requested activate/deactivate of a layer) and a clickable label that
// frames that layer in the 3D view. SubModelPart rows additionally carry an
// export button (`exportPath`) that deploys a per-part format dropdown.

export interface OutlineNode {
  label: string;
  count?: number;
  /** Present when this row maps to a renderable layer/actor. */
  layerId?: string;
  visible?: boolean;
  /** RGB in 0..1 for the layer swatch. */
  color?: [number, number, number];
  /** Current opacity 0..1 (default 1) — prefills the opacity popover slider. */
  opacity?: number;
  /** True for non-toggleable section headers (e.g. "Mesh", "SubModelParts"). */
  section?: boolean;
  /** SubModelPart path — when set, the row gets an "export this part" button. */
  exportPath?: string;
  /** Recursive entity counts — when set, the row gets an info dropdown button. */
  counts?: OutlineCounts;
  children?: OutlineNode[];
}

/** Recursive (subtree) entity counts shown in a SubModelPart's info dropdown. */
export interface OutlineCounts {
  nodes: number;
  conditions: number;
  elements: number;
  geometries: number;
  subModelParts: number;
}

export interface OutlineHandlers {
  onToggle(layerId: string, visible: boolean): void;
  onFocus(layerId: string): void;
  /** Export the SubModelPart at `path` to `ext` (e.g. ".mdpa"). */
  onExport?(path: string, ext: string): void;
  /** Delete the SubModelPart at `path` (its X button in the tree). */
  onDelete?(path: string): void;
  /** Rename the SubModelPart at `path` to `newName` (its pen button). */
  onRename?(path: string, newName: string): void;
  /** Set the layer's opacity (0..1), live as the popover slider is dragged. */
  onOpacity?(layerId: string, opacity: number): void;
  /** Create an empty child SubModelPart under `parentPath` ("" = top level). */
  onCreateChild?(parentPath: string, name: string): void;
  /** Reparent the SubModelPart at `path` under `newParentPath` ("" = top level). */
  onMove?(path: string, newParentPath: string): void;
  /** Merge the part at `sourcePath` INTO the one at `targetPath`. */
  onMerge?(sourcePath: string, targetPath: string): void;
}

/** Chrome for the per-part export/info/rename/delete/opacity buttons (inline SVG icons). */
export interface OutlineExportUI {
  icon: string;
  /** X icon for the per-part delete button. */
  deleteIcon?: string;
  /** Info icon for the per-part counts dropdown. */
  infoIcon?: string;
  /** Pen icon for the per-part rename button. */
  renameIcon?: string;
  /** Opacity icon for the per-layer opacity popover — any row with a layerId. */
  opacityIcon?: string;
  /** Tree icon for the per-part organize menu (new child / move / merge). */
  organizeIcon?: string;
  /**
   * Every SubModelPart path in the model, so the organize menu can offer move
   * and merge destinations without the outline having to walk the tree itself.
   */
  allPaths?: string[];
  /** `group` heads a labelled section in the dropdown (see EXPORT_MENU_GROUPS). */
  formats: { ext: string; label: string; group?: string }[];
}

function rgbToCss(c: [number, number, number]): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])})`;
}

// At most one export dropdown is open at a time.
let activeMenu: { el: HTMLElement; anchor: HTMLElement; cleanup: () => void } | null =
  null;

function closeExportMenu(): void {
  if (!activeMenu) return;
  activeMenu.cleanup();
  activeMenu.el.remove();
  activeMenu = null;
}

function openExportMenu(
  anchor: HTMLElement,
  exportPath: string,
  ui: OutlineExportUI,
  handlers: OutlineHandlers
): void {
  const menu = document.createElement("div");
  menu.className = "outline-export-menu";
  menu.setAttribute("role", "menu");
  let group: string | undefined;
  for (const fmt of ui.formats) {
    const { ext, label } = fmt;
    // ~30 formats: head each section so the list stays scannable.
    if (fmt.group && fmt.group !== group) {
      group = fmt.group;
      const head = document.createElement("div");
      head.className = "outline-export-group";
      head.textContent = group;
      menu.appendChild(head);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "outline-export-item";
    item.textContent = `${label} (${ext})`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExportMenu();
      handlers.onExport?.(exportPath, ext);
    });
    menu.appendChild(item);
  }
  showMenu(anchor, menu);
}

/** Opens a read-only counts popup for a SubModelPart under `anchor`. */
function openInfoMenu(anchor: HTMLElement, counts: OutlineCounts): void {
  const menu = document.createElement("div");
  menu.className = "outline-export-menu outline-info-menu";
  menu.setAttribute("role", "menu");
  const rows: [string, number][] = [
    ["Nodes", counts.nodes],
    ["Conditions", counts.conditions],
    ["Elements", counts.elements],
    ["Geometries", counts.geometries],
    ["SubModelParts", counts.subModelParts],
  ];
  for (const [label, value] of rows) {
    const item = document.createElement("div");
    item.className = "outline-info-item";
    const name = document.createElement("span");
    name.className = "outline-info-name";
    name.textContent = label;
    const num = document.createElement("span");
    num.className = "outline-info-value";
    num.textContent = String(value);
    item.append(name, num);
    menu.appendChild(item);
  }
  showMenu(anchor, menu);
}

/** Opens a live opacity slider for a layer under `anchor`. */
function openOpacityMenu(
  anchor: HTMLElement,
  layerId: string,
  current: number,
  onOpacity: (layerId: string, opacity: number) => void
): void {
  const menu = document.createElement("div");
  menu.className = "outline-export-menu outline-opacity-menu";
  menu.setAttribute("role", "menu");
  const row = document.createElement("div");
  row.className = "outline-opacity-row";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(current * 100));
  const valEl = document.createElement("span");
  valEl.className = "outline-opacity-value";
  valEl.textContent = `${Math.round(current * 100)}%`;
  slider.addEventListener("input", () => {
    const v = Number(slider.value) / 100;
    valEl.textContent = `${Math.round(v * 100)}%`;
    onOpacity(layerId, v);
  });
  slider.addEventListener("click", (e) => e.stopPropagation());
  row.append(slider, valEl);
  menu.appendChild(row);
  showMenu(anchor, menu);
}

/**
 * Opens the per-part tree menu: create a child, move the part, merge it away.
 *
 * One dropdown rather than three more buttons on an already-crowded row — the
 * same reasoning that put ~30 export formats behind a single icon.
 */
function openOrganizeMenu(
  anchor: HTMLElement,
  path: string,
  ui: OutlineExportUI,
  handlers: OutlineHandlers
): void {
  const menu = document.createElement("div");
  menu.className = "outline-export-menu outline-organize-menu";
  menu.setAttribute("role", "menu");

  const group = (label: string): void => {
    const head = document.createElement("div");
    head.className = "outline-export-group";
    head.textContent = label;
    menu.appendChild(head);
  };
  const item = (label: string, onPick: () => void): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "outline-export-item";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExportMenu();
      onPick();
    });
    menu.appendChild(b);
  };

  if (handlers.onCreateChild) {
    group("New child");
    const row = document.createElement("div");
    row.className = "outline-organize-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "outline-label-input";
    input.placeholder = "name…";
    // The same no-native-prompts convention as the inline rename input.
    const commit = (): void => {
      const name = input.value.trim();
      if (!name) return;
      closeExportMenu();
      handlers.onCreateChild?.(path, name);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") closeExportMenu();
      e.stopPropagation();
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(input);
    menu.appendChild(row);
    setTimeout(() => input.focus(), 0);
  }

  // A part cannot move into (or merge with) itself or its own subtree — the
  // core refuses both, but offering them would just invite a warning toast.
  const others = (ui.allPaths ?? []).filter(
    (p) => p !== path && !p.startsWith(`${path}/`)
  );

  if (handlers.onMove) {
    group("Move under");
    // "" is the top level; only offered when the part is not already there.
    if (path.includes("/")) item("(top level)", () => handlers.onMove?.(path, ""));
    for (const dest of others) {
      if (dest === parentPathOf(path)) continue; // already there
      item(dest, () => handlers.onMove?.(path, dest));
    }
  }

  if (handlers.onMerge && others.length > 0) {
    group("Merge into");
    for (const dest of others) item(dest, () => handlers.onMerge?.(path, dest));
  }

  showMenu(anchor, menu);
}

/** The path of `path`'s parent, or "" when it is top level. */
function parentPathOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Positions `menu` under `anchor`, wires dismissal, and records it as active. */
function showMenu(anchor: HTMLElement, menu: HTMLElement): void {
  closeExportMenu();
  document.body.appendChild(menu);

  // Position under the button; nudge left if it would overflow the viewport.
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 2}px`;
  const width = menu.offsetWidth;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  menu.style.left = `${Math.max(8, left)}px`;

  const onDocClick = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) closeExportMenu();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") closeExportMenu();
  };
  // Any scroll/resize invalidates the fixed position — just dismiss.
  const onScroll = (): void => closeExportMenu();
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onScroll);
  window.addEventListener("scroll", onScroll, true);

  activeMenu = {
    el: menu,
    anchor,
    cleanup: () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    },
  };
}

export function renderOutline(
  container: HTMLElement,
  roots: OutlineNode[],
  handlers: OutlineHandlers,
  exportUI?: OutlineExportUI
): void {
  closeExportMenu();
  container.textContent = "";
  for (const node of roots) {
    container.appendChild(buildNode(node, 0, handlers, exportUI));
  }
}

function buildNode(
  node: OutlineNode,
  depth: number,
  handlers: OutlineHandlers,
  exportUI?: OutlineExportUI
): HTMLElement {
  const wrapper = document.createElement("div");

  const row = document.createElement("div");
  row.className = node.section ? "outline-row outline-section" : "outline-row";
  row.style.paddingLeft = `${depth * 14}px`;

  if (node.layerId) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = node.visible ?? true;
    checkbox.title = "Show / hide layer";
    checkbox.addEventListener("change", () =>
      handlers.onToggle(node.layerId!, checkbox.checked)
    );
    row.appendChild(checkbox);

    if (node.color) {
      const swatch = document.createElement("span");
      swatch.className = "outline-swatch";
      swatch.style.background = rgbToCss(node.color);
      if (node.layerId) swatch.dataset.layerId = node.layerId;
      row.appendChild(swatch);
    }
  }

  const label = document.createElement("span");
  label.className = "outline-label";
  label.textContent = node.label;
  if (node.layerId) {
    label.title = "Click to frame in view";
    label.addEventListener("click", () => handlers.onFocus(node.layerId!));
  }
  row.appendChild(label);

  if (node.count !== undefined) {
    const count = document.createElement("span");
    count.className = "outline-count";
    count.textContent = `(${node.count})`;
    row.appendChild(count);
  }

  if (node.layerId && exportUI?.opacityIcon && handlers.onOpacity) {
    const layerId = node.layerId;
    const onOpacity = handlers.onOpacity;
    const op = document.createElement("button");
    op.type = "button";
    op.className = "outline-opacity-btn";
    op.title = "Layer opacity…";
    op.setAttribute("aria-haspopup", "true");
    op.innerHTML = `<span class="toolbar-icon">${exportUI.opacityIcon}</span>`;
    op.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasThis = activeMenu?.anchor === op;
      closeExportMenu();
      if (!wasThis) openOpacityMenu(op, layerId, node.opacity ?? 1, onOpacity);
    });
    row.appendChild(op);
  }

  if (node.exportPath && exportUI && handlers.onExport) {
    const path = node.exportPath;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "outline-export-btn";
    btn.title = "Export this SubModelPart…";
    btn.setAttribute("aria-haspopup", "true");
    btn.innerHTML = `<span class="toolbar-icon">${exportUI.icon}</span>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clicking the button whose menu is open toggles it shut; otherwise
      // (re)open for this button.
      const wasThis = activeMenu?.anchor === btn;
      closeExportMenu();
      if (!wasThis) openExportMenu(btn, path, exportUI, handlers);
    });
    row.appendChild(btn);
  }

  if (node.exportPath && exportUI?.renameIcon && handlers.onRename) {
    const path = node.exportPath;
    const onRename = handlers.onRename;

    // Turns the label into an inline text field; Enter commits, Escape cancels.
    const beginRename = (): void => {
      if (row.querySelector(".outline-label-input")) return;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "outline-label-input";
      input.value = node.label;
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
        if (commit && val && val !== node.label) onRename(path, val);
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("click", (ev) => ev.stopPropagation());
    };

    const pen = document.createElement("button");
    pen.type = "button";
    pen.className = "outline-rename-btn";
    pen.title = "Rename this SubModelPart";
    pen.innerHTML = `<span class="toolbar-icon">${exportUI.renameIcon}</span>`;
    pen.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExportMenu();
      beginRename();
    });
    row.appendChild(pen);
  }

  if (node.counts && exportUI?.infoIcon) {
    const counts = node.counts;
    const info = document.createElement("button");
    info.type = "button";
    info.className = "outline-info-btn";
    info.title = "SubModelPart counts…";
    info.setAttribute("aria-haspopup", "true");
    info.innerHTML = `<span class="toolbar-icon">${exportUI.infoIcon}</span>`;
    info.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasThis = activeMenu?.anchor === info;
      closeExportMenu();
      if (!wasThis) openInfoMenu(info, counts);
    });
    row.appendChild(info);
  }

  if (
    node.exportPath &&
    exportUI?.organizeIcon &&
    (handlers.onCreateChild || handlers.onMove || handlers.onMerge)
  ) {
    const path = node.exportPath;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "outline-organize-btn";
    btn.title = "Create a child, move or merge this SubModelPart";
    btn.innerHTML = `<span class="toolbar-icon">${exportUI.organizeIcon}</span>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasThis = activeMenu?.anchor === btn;
      closeExportMenu();
      if (!wasThis) openOrganizeMenu(btn, path, exportUI, handlers);
    });
    row.appendChild(btn);
  }

  if (node.exportPath && exportUI?.deleteIcon && handlers.onDelete) {
    const path = node.exportPath;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "outline-delete-btn";
    del.title = "Delete this SubModelPart";
    del.innerHTML = `<span class="toolbar-icon">${exportUI.deleteIcon}</span>`;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      closeExportMenu();
      handlers.onDelete?.(path);
    });
    row.appendChild(del);
  }

  wrapper.appendChild(row);

  if (node.children) {
    for (const child of node.children) {
      wrapper.appendChild(buildNode(child, depth + 1, handlers, exportUI));
    }
  }

  return wrapper;
}
