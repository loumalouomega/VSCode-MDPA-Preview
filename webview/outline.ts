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
  /** True for non-toggleable section headers (e.g. "Mesh", "SubModelParts"). */
  section?: boolean;
  /** SubModelPart path — when set, the row gets an "export this part" button. */
  exportPath?: string;
  children?: OutlineNode[];
}

export interface OutlineHandlers {
  onToggle(layerId: string, visible: boolean): void;
  onFocus(layerId: string): void;
  /** Export the SubModelPart at `path` to `ext` (e.g. ".mdpa"). */
  onExport?(path: string, ext: string): void;
}

/** Chrome for the per-part export dropdown (SVG icon + the format list). */
export interface OutlineExportUI {
  icon: string;
  formats: { ext: string; label: string }[];
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
  closeExportMenu();

  const menu = document.createElement("div");
  menu.className = "outline-export-menu";
  menu.setAttribute("role", "menu");
  for (const { ext, label } of ui.formats) {
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

  wrapper.appendChild(row);

  if (node.children) {
    for (const child of node.children) {
      wrapper.appendChild(buildNode(child, depth + 1, handlers, exportUI));
    }
  }

  return wrapper;
}
