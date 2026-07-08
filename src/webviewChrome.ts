// Shared, static webview chrome markup used by both custom-editor providers
// (mdpaEditorProvider + vtkEditorProvider) so the sidebar structure stays in one
// place and cannot drift between them. The sidebar has no interpolated content —
// `#stats` and `#outline` are filled at runtime by the webview — so a plain
// constant string is enough.

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
          <p class="sb-placeholder">No modifiers yet — coming soon.</p>
        </div>
      </section>
    </aside>`;
