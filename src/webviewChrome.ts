// Shared, static webview chrome markup used by both custom-editor providers
// (mdpaEditorProvider + vtkEditorProvider) so the sidebar structure stays in one
// place and cannot drift between them. The sidebar has no interpolated content —
// `#stats` and `#outline` are filled at runtime by the webview — so a plain
// constant string is enough.

import { TOOLBAR_ICONS } from "./toolbarIcons";
import {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
} from "./parser/writers/meshWriter";

const ic = (id: keyof typeof TOOLBAR_ICONS): string =>
  `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;

const exportItems = EXPORTABLE_EXTENSIONS.map(
  (ext) =>
    `<button type="button" class="file-menu-item file-menu-sub" data-menu="export" data-format="${ext}">` +
    `${EXPORT_FORMAT_LABELS[ext]} (${ext})</button>`
).join("\n        ");

/**
 * The "File" (Home) menu: a top-left dropdown trigger plus a hidden popup with
 * Open / Save / Save As and an Export list (one item per exportable format).
 * Items carry `data-menu` (+ `data-format` for exports); click handling and the
 * open/close toggle live in `webview/fileMenu.ts`. Rendered by both providers
 * at the top of `#viewport`; styled in `webview/style.css` (`#file-menu*`).
 */
export const FILE_MENU_HTML = `<div id="file-menu">
        <button type="button" id="file-menu-btn" title="File menu" aria-haspopup="true" aria-expanded="false">
          ${ic("fileMenu")}<span class="file-menu-label">File</span><span class="file-menu-caret">▾</span>
        </button>
        <div id="file-menu-popup" class="hidden" role="menu">
          <button type="button" class="file-menu-item" data-menu="open" role="menuitem">${ic("open")}<span>Open…</span></button>
          <button type="button" class="file-menu-item" data-menu="save" role="menuitem">${ic("save")}<span>Save</span></button>
          <button type="button" class="file-menu-item" data-menu="saveAs" role="menuitem">${ic("saveAs")}<span>Save As…</span></button>
          <div class="file-menu-sep"></div>
          <div class="file-menu-group-label">${ic("export")}<span>Export as</span></div>
          ${exportItems}
        </div>
      </div>`;

/**
 * The left sidebar: four collapsible sections (Information, Layers, Edit,
 * Mesh Modification). `#stats` and `#outline` keep their ids so `renderStats()`
 * and `renderOutline()` fill them unchanged. Collapse wiring lives in
 * `webview/sidebar.ts` (`initSidebarSections`); styling in `webview/style.css`
 * (`.sb-section*`).
 */
export const SIDEBAR_HTML = `<aside id="sidebar">
      <section class="sb-section" data-section="information">
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Information
        </button>
        <div class="sb-section-body"><div id="stats"></div></div>
      </section>
      <section class="sb-section" data-section="layers">
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Layers
        </button>
        <div class="sb-section-body"><div id="outline"></div></div>
      </section>
      <section class="sb-section" data-section="edit">
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Edit
        </button>
        <div class="sb-section-body">
          <p class="sb-placeholder">No edits yet — coming soon.</p>
        </div>
      </section>
      <section class="sb-section" data-section="mesh-mod">
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Mesh Modification
        </button>
        <div class="sb-section-body">
          <button type="button" id="mesh-mod-quadratic" class="sb-action" title="Insert mid-edge nodes to make the mesh quadratic">${ic("quadratic")}<span>Convert Linear → Quadratic</span></button>
        </div>
      </section>
      <section class="sb-section" data-section="problemtype">
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Problemtype
        </button>
        <div class="sb-section-body">
          <p class="sb-placeholder">No problemtype yet — coming soon.</p>
        </div>
      </section>
    </aside>`;
