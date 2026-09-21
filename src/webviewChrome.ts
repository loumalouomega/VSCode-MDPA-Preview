// Shared, static webview chrome markup used by both custom-editor providers
// (mdpaEditorProvider + vtkEditorProvider) so the sidebar structure stays in one
// place and cannot drift between them. The sidebar has no interpolated content —
// `#stats` and `#outline` are filled at runtime by the webview — so a plain
// constant string is enough.

import { TOOLBAR_ICONS } from "./toolbarIcons";
import { glyph, type UiGlyphId } from "./uiGlyphs";
import {
  EXPORT_FORMAT_LABELS,
  EXPORT_MENU_GROUPS,
} from "./parser/writers/meshWriter";

const ic = (id: keyof typeof TOOLBAR_ICONS): string =>
  `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;

// Grouped rather than one flat list: with the meshio++ formats there are ~30
// targets, and EXPORT_MENU_GROUPS also drops the alias extensions (.nas/.fem/
// .tec/.dato/.xmf) that would otherwise repeat their primary format.
const exportItems = EXPORT_MENU_GROUPS.map(
  (group) =>
    `<div class="file-menu-subgroup-label">${group.label}</div>\n        ` +
    group.extensions
      .map(
        (ext) =>
          `<button type="button" class="file-menu-item file-menu-sub" data-menu="export" data-format="${ext}">` +
          `${EXPORT_FORMAT_LABELS[ext]} (${ext})</button>`
      )
      .join("\n        ")
).join("\n        ");

/**
 * The "File" menu: a dropdown trigger plus a hidden popup with Open / Save /
 * Save As, an Export list (one item per exportable format) and the Problem
 * (zip) group (Save problem… / Load problem… archive the mesh + edit recipe +
 * case + generated files as one zip).
 * Items carry `data-menu` (+ `data-format` for exports); click handling and the
 * open/close toggle live in `webview/fileMenu.ts`. Lives inside `MENUBAR_HTML`
 * (below); styled in `webview/style.css` (`#file-menu*`).
 */
export const FILE_MENU_HTML = `<div id="file-menu">
        <button type="button" id="file-menu-btn" title="File menu" aria-haspopup="true" aria-expanded="false">
          ${glyph("home")}<span class="file-menu-label">File</span>${glyph("chevronDown")}
        </button>
        <div id="file-menu-popup" class="hidden" role="menu">
          <button type="button" class="file-menu-item" data-menu="open" role="menuitem">${ic("open")}<span>Open…</span></button>
          <button type="button" class="file-menu-item" data-menu="reload" role="menuitem" title="Re-read the file from disk; applied operations are re-applied to it">${ic("reload")}<span>Reload from disk</span></button>
          <button type="button" class="file-menu-item" data-menu="save" role="menuitem">${ic("save")}<span>Save</span></button>
          <button type="button" class="file-menu-item" data-menu="saveAs" role="menuitem">${ic("saveAs")}<span>Save As…</span></button>
          <div class="file-menu-sep"></div>
          <div class="file-menu-group-label">${ic("export")}<span>Export as</span></div>
          ${exportItems}
          <div class="file-menu-sep"></div>
          <div class="file-menu-group-label">${ic("problemtype")}<span>Problem (zip)</span></div>
          <button type="button" class="file-menu-item file-menu-sub" data-menu="saveProblem" role="menuitem">${ic("save")}<span>Save problem…</span></button>
          <button type="button" class="file-menu-item file-menu-sub" data-menu="loadProblem" role="menuitem">${ic("open")}<span>Load problem…</span></button>
        </div>
      </div>`;

/**
 * The in-flow menu bar: a full-width 34px strip at the very top of the editor
 * (it pushes the layout down rather than floating over the canvas), holding
 * the File pill on the left, the scene-theme picker (which `webview/main.ts`
 * reparents into the nav card's Appearance group at startup) and, pushed to the
 * right, the document chip — which file this is, its format, and whether the
 * source file holds what is on screen. The chip is fed by the `documentInfo`
 * message (`src/documentInfo.ts`), so it ships `hidden` and stays empty until
 * the first one arrives; the dirty dot is a role=img span, not a button.
 * Rendered by both providers as the first child of `#app`; styled by
 * `#menubar*` / `#doc-chip*` in `webview/style.css`.
 */
export const MENUBAR_HTML = `<div id="menubar">
      ${FILE_MENU_HTML}
      <select id="theme-select" title="Scene theme">
        <option value="auto">Auto</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="scientific">Scientific</option>
      </select>
      <div id="doc-chip" hidden>
        <span id="doc-chip-dirty" class="ui-dot" role="img" aria-label="Edits not yet saved into the source file" title="Edits not yet saved into the source file" hidden></span>
        <span id="doc-chip-name"></span>
        <span id="doc-chip-format" class="ui-badge"></span>
        <span id="doc-chip-unsaved"></span>
      </div>
    </div>`;

/**
 * The full-width status bar: the last child of `#app`, after `#main`, so it
 * takes a row off the bottom of the viewport and everything anchored to that
 * edge (the timeline bar, the nav card, the toast) rises with it by layout, not
 * by arithmetic. Left to right: engine activity (under the sidebar's own
 * width, so the facts start where the canvas does), model counts, timeline
 * frame, and the last pick pushed right. Every fact cell ships `hidden` and is
 * shown by `webview/statusBar.ts` only when it has something to say; facts
 * only, never a verdict. Engine state is INFERRED from calls — see the header
 * of `src/statusStats.ts` for exactly which signals exist.
 */
export const STATUSBAR_HTML = `<div id="statusbar">
      <span id="engine-status" data-tone="idle" title="Which WebAssembly engines this session has used (meshio++, MMG, Pyodide). They load on first use, so opening a plain .mdpa legitimately reads idle.">
        <span id="engine-status-dot" class="ui-dot" aria-hidden="true"></span>
        <span id="engine-status-text" class="ui-num">Engines idle</span>
      </span>
      <span id="sb-count-model" class="ui-num" title="Nodes, elements and conditions in the loaded model" hidden></span>
      <span id="sb-count-frame" class="ui-num" title="Position on the timeline" hidden></span>
      <span id="sb-cursor" class="ui-num" title="The last entity and node picked in Inspect mode" hidden></span>
    </div>`;

/**
 * The **Advanced** toolbar button and its dropdown.
 *
 * A home for operations that are real but not everyday, so the toolbar does not
 * grow a button per niche feature. The button itself is an ordinary
 * `#toolbar` ghost button (plus `.tb-menu` for the chevron/open styling); the popup is a sibling of the
 * toolbar (not a child) because the toolbar is a flat flex row, and it is
 * anchored under it by `#advanced-popup` in style.css.
 *
 * Shared by both providers and the screenshot harness — `webview/main.ts` wires
 * the toggle and dispatches each item's `data-action` through the same handler
 * as a real toolbar button, so an entry here behaves exactly like one.
 */
export const ADVANCED_BUTTON_HTML = `<button data-action="advanced" class="tb-menu" title="More operations" aria-haspopup="true" aria-expanded="false">${glyph("sliders")} Advanced ${glyph("chevronDown")}</button>`;

/**
 * Every Advanced/View menu ACTION that a Command-Palette entry drives.
 *
 * The parity rule was stated in comments and enforced by nobody, so six
 * features — Face normals, Field integrals, Data table, Lighting, Camera
 * bookmarks and Record — shipped reachable only from a dropdown, discoverable
 * as a gap only by hand-diffing this file against the manifest. Declaring the
 * mapping here, next to the markup it describes, lets
 * `src/test/packageContributes.test.ts` assert both halves: every command named
 * is declared, and every non-checkbox menu item appears as a key.
 *
 * Checkbox items (`role="menuitemcheckbox"`: Grid, Edges, the layout rows) are
 * display toggles and deliberately absent — `nodeIds` is the one that has a
 * command, for historical reasons, and having one does no harm.
 */
export const MENU_ACTION_COMMANDS: Readonly<Record<string, string>> = {
  // Reached by the generic `uiAction` message.
  normals: "kratos.mdpa.faceNormals",
  integrals: "kratos.mdpa.fieldIntegrals",
  dataTable: "kratos.mdpa.dataTable",
  lighting: "kratos.mdpa.lighting",
  bookmarks: "kratos.mdpa.cameraBookmarks",
  record: "kratos.mdpa.record",
  // Older entries, each with its own dedicated message.
  meshSize: "kratos.mdpa.meshSize",
  spheres: "kratos.mdpa.sphereGlyphs",
  beams: "kratos.mdpa.beamGlyphs",
  exportSkin: "kratos.mesh.exportSkin",
  nodeIds: "kratos.mdpa.toggleNodeIds",
  screenshot: "kratos.mdpa.screenshot",
};

export const ADVANCED_MENU_HTML = `<div id="advanced-popup" class="hidden" role="menu">
        <button type="button" class="file-menu-item" data-action="meshSize" role="menuitem" title="Mesh size (nodal / element) + box-whisker">${ic("meshSize")}<span>Mesh Size</span></button>
        <button type="button" class="file-menu-item" data-action="spheres" role="menuitem" title="Render one-node (particle) elements as spheres sized by RADIUS">${ic("spheres")}<span>Spheres…</span></button>
        <button type="button" class="file-menu-item" data-action="beams" role="menuitem" title="Render line (1D) elements as tubes sized by their CROSS_AREA section">${ic("beam")}<span>Beams…</span></button>
        <button type="button" class="file-menu-item" data-action="normals" role="menuitem" title="Draw face normals — an inverted element points its arrow against its neighbours">${ic("normals")}<span>Face normals</span></button>
        <button type="button" class="file-menu-item" data-action="integrals" role="menuitem" title="Cell-measure-weighted total and mean of every cell field, per mesh and per region">${ic("average")}<span>Field integrals…</span></button>
        <button type="button" class="file-menu-item" data-action="dataTable" role="menuitem" title="Browse every node/element value as a table, and export it as CSV or XLSX">${ic("info")}<span>Data table…</span></button>
        <button type="button" class="file-menu-item" data-action="exportSkin" role="menuitem" title="Export the boundary skin of the volume cells as an independent mesh file">${ic("crop")}<span>Export skin…</span></button>
        <div class="file-menu-sep"></div>
        <button type="button" class="file-menu-item" data-action="lighting" role="menuitem" title="Specular / ambient / diffuse + backface culling">${ic("lighting")}<span>Lighting…</span></button>
        <button type="button" class="file-menu-item" data-action="bookmarks" role="menuitem" title="Save and restore named camera views">${ic("bookmark")}<span>Camera Bookmarks…</span></button>
      </div>`;

/**
 * The **View** toolbar dropdown (reference View ▾ menu): the display toggles —
 * Wireframe / Node IDs / Grid as checkable items (their checked state is the
 * shared `.active` class, shown as a reserved ✓ column) — plus the one-shot
 * Screenshot… item. Items carry the same `data-action` the old toolbar
 * buttons did, so host commands (`kratos.mdpa.toggleNodeIds`, …) and
 * `dispatchToolbarAction` are unchanged. Wired like the Advanced menu in
 * `webview/main.ts`: checkable items keep the menu open, one-shots close it.
 */
export const VIEW_BUTTON_HTML = `<button data-action="viewMenu" class="tb-menu" title="View options" aria-haspopup="true" aria-expanded="false">${glyph("eye")} View ${glyph("chevronDown")}</button>`;

export const VIEW_MENU_HTML = `<div id="view-popup" class="hidden" role="menu">
        <button type="button" class="file-menu-item" data-action="nodeIds" role="menuitemcheckbox" title="Toggle node ids">${ic("nodeIds")}<span>Node IDs</span></button>
        <button type="button" class="file-menu-item" data-action="grid" role="menuitemcheckbox" title="Toggle background grid">${ic("grid")}<span>Grid</span></button>
        <button type="button" class="file-menu-item active" data-action="edges" role="menuitemcheckbox" title="Toggle mesh edge lines — off so a transparent mesh reads as surfaces">${ic("wireframe")}<span>Edges</span></button>
        <div class="file-menu-sep"></div>
        <button type="button" class="file-menu-item active" data-action="layout:1x1" role="menuitemcheckbox" title="One viewport">${ic("grid")}<span>Layout: Single</span></button>
        <button type="button" class="file-menu-item" data-action="layout:1x2" role="menuitemcheckbox" title="Two viewports side by side, each with its own camera">${ic("grid")}<span>Layout: Side by side</span></button>
        <button type="button" class="file-menu-item" data-action="layout:2x1" role="menuitemcheckbox" title="Two viewports stacked, each with its own camera">${ic("grid")}<span>Layout: Stacked</span></button>
        <button type="button" class="file-menu-item" data-action="layout:2x2" role="menuitemcheckbox" title="Four viewports, each with its own camera">${ic("grid")}<span>Layout: Quad</span></button>
        <div class="file-menu-sep"></div>
        <button type="button" class="file-menu-item" data-action="screenshot" role="menuitem" title="Save the current view as a PNG">${ic("screenshot")}<span>Screenshot…</span></button>
        <button type="button" class="file-menu-item" data-action="record" role="menuitem" title="Record the view as a video or a PNG sequence — a time-series playthrough, or a camera turntable">${ic("screenshot")}<span>Record…</span></button>
      </div>`;

/**
 * The main viewport toolbar. Identical between both providers (only
 * `webview/main.ts`'s `dispatchToolbarAction` differs in which buttons do
 * anything for a given model), so it lives here once rather than as two
 * copies that could silently drift. The leading glyphs are `uiGlyphs` (15 px,
 * CSS-sized); the two menu triggers end in a chevron glyph, and a `.tb-div`
 * hairline separates them from the plain actions. Every `button[data-action]`
 * must stay a direct child of `#toolbar`.
 */
export const TOOLBAR_HTML = `<button data-action="reset" title="Reset camera">${glyph("rotateCcw")} Reset</button>
        <button data-action="pan" title="Toggle pan mode">${glyph("move")} Pan</button>
        <button data-action="quality" title="Compute mesh quality">${glyph("activity")} Quality</button>
        <button data-action="field" title="Visualize field data">${glyph("palette")} Field</button>
        <button data-action="find" title="Find entity by ID">${glyph("search")} Find</button>
        <button data-action="inspect" title="Click a node/element/condition to inspect its data">${glyph("crosshair")} Inspect</button>
        <span class="tb-div" aria-hidden="true"></span>
        ${VIEW_BUTTON_HTML}
        ${ADVANCED_BUTTON_HTML}`;

/**
 * The full-screen loading overlay: the brand mark, a determinate progress bar
 * driven by the host's `progress` messages, and a label. Shown/hidden by
 * `showLoading`/`hideLoading` in `webview/main.ts`; styled by `#loading*` in
 * `webview/style.css`.
 *
 * The mark is the raw icon rather than `ic()`, because `.toolbar-icon` forces
 * `1em` and this one is displayed large. Its slow rotation is the second
 * animation the design system permits — see principle 3 in
 * `doc/ui-design-system.md`, which had to be amended for it.
 */
export const LOADING_HTML = `<div id="loading">
    <div id="loading-inner">
      <div id="loading-logo">${TOOLBAR_ICONS.loading}</div>
      <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
      <div id="loading-label">Reading file…</div>
    </div>
  </div>`;

/**
 * The Clip controls — the nav dock's **Clip** cluster (`webview/main.ts` adopts
 * the provider-rendered `#cut-panel`'s children node by node into the dock and
 * its ⋯ popover, via `NavControls.addDockItem`; the emptied `#cut-panel` stays
 * behind as a hidden holder). Axis presets (X/Y/Z/Free, an inset segmented track
 * built on the hidden-radio recipe) plus a **Free** mode exposing raw
 * normal-vector inputs for an oblique cut, the position slider, Flip, the Off/On
 * toggle and the live position readout (`.ui-num`). Dock: toggle, axes, slider,
 * readout. Popover: Flip and `#cut-free-inputs` (hidden unless Free is selected,
 * toggled by `webview/main.ts`'s cut-axis change handler). Shared like
 * `TOOLBAR_HTML` so the two providers and the screenshot harness can't drift.
 * Every id here is wired by id from `main.ts` — moving a node keeps its wiring.
 */
export const CUT_PANEL_HTML = `<button type="button" id="cut-toggle" class="nav-pill" title="Toggle clipping">Off</button>
        <div id="cut-axes" class="nav-segments nav-clip-axes" role="group" aria-label="Clip axis">
          <label class="nav-seg nav-step-btn" title="Clip along X"><input type="radio" name="cut-axis" value="0"><span>X</span></label>
          <label class="nav-seg nav-step-btn" title="Clip along Y"><input type="radio" name="cut-axis" value="1"><span>Y</span></label>
          <label class="nav-seg nav-step-btn" title="Clip along Z"><input type="radio" name="cut-axis" value="2" checked><span>Z</span></label>
          <label class="nav-seg nav-step-btn" title="Clip along an arbitrary normal"><input type="radio" name="cut-axis" value="free"><span>Free</span></label>
        </div>
        <input type="range" id="cut-slider" min="0" max="100" value="50" step="0.5" title="Clip plane position">
        <span id="cut-position" class="ui-num"></span>
        <button type="button" id="cut-flip" class="nav-pill" title="Flip the clipped side">Flip</button>
        <span id="cut-free-inputs" class="hidden">
          <input type="number" id="cut-normal-x" value="0" step="0.1" title="Normal X" aria-label="Clip normal X" class="cut-normal-input">
          <input type="number" id="cut-normal-y" value="0" step="0.1" title="Normal Y" aria-label="Clip normal Y" class="cut-normal-input">
          <input type="number" id="cut-normal-z" value="1" step="0.1" title="Normal Z" aria-label="Clip normal Z" class="cut-normal-input">
        </span>`;

/**
 * The embedded Flowgraph pane: a drag handle plus a pane holding a small header
 * (title + a split-orientation toggle) and the <iframe> that embeds the
 * Flowgraph node editor (served from a localhost port by src/flowgraphServer.ts).
 * Both start hidden; `webview/flowgraphPane.ts` reveals them when the Flowgraph
 * problemtype is selected and sets the iframe src from the host's
 * `flowgraphReady` message. Styled by `#flowgraph-*` in `webview/style.css`.
 */
export const FLOWGRAPH_PANE_HTML = `<button type="button" id="flowgraph-restore" class="hidden" title="Show the Flowgraph editor">${ic("ptFlowgraph")}<span>Flowgraph</span></button>
      <div id="flowgraph-resizer" class="hidden" title="Drag to resize the Flowgraph pane"></div>
      <div id="flowgraph-pane" class="hidden">
        <div id="flowgraph-header">
          <span class="flowgraph-title">${ic("ptFlowgraph")}<span>Flowgraph</span></span>
          <span class="flowgraph-header-actions">
            <button type="button" id="flowgraph-orient" title="Toggle split orientation">${ic("grid")}</button>
            <button type="button" id="flowgraph-hide" title="Hide the Flowgraph editor">${ic("close")}</button>
          </span>
        </div>
        <iframe id="flowgraph-frame" title="Flowgraph node editor" src="about:blank"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-popups"></iframe>
      </div>`;

/**
 * A sidebar section header in CAD-Preview's shape: a chevron BUTTON (the only
 * collapse control — the header itself is not clickable, because headers carry
 * their own action buttons), a 22px icon tile, the title, then optional
 * `.panel-icon-btn` actions. `.sb-section-header` stays as the JS/CSS hook;
 * `webview/sidebar.ts` wires the chevron and keeps `aria-expanded` + `title` in
 * step with the section's `.collapsed` class.
 */
const sectionHeader = (
  icon: UiGlyphId,
  title: string,
  o: { actions?: string; expanded?: boolean } = {}
): string => {
  const expanded = o.expanded ?? true;
  return `<div class="sb-section-header panel-header">
          <button type="button" class="panel-chevron" aria-expanded="${expanded}" title="${expanded ? "Collapse section" : "Expand section"}">${glyph("chevronDown")}</button>
          <span class="panel-icon" aria-hidden="true">${glyph(icon)}</span>
          <span class="panel-title">${title}</span>${o.actions ?? ""}
        </div>`;
};

/**
 * The left sidebar. Top level holds the sections that EDIT the model — Layers,
 * Edit, Variables, Mesh Modification and Problemtype; the read-only /
 * diagnostic ones (Information) are folded into one collapsed `#advanced-group`
 * card, the split rule CAD-Preview's sidebar uses. `#stats` and `#outline` keep
 * their ids so `renderStats()` and `renderOutline()` fill them unchanged.
 * Collapse wiring lives in `webview/sidebar.ts` (`initSidebarSections`), the
 * group's "n of m" availability badge in the same module; styling in
 * `webview/style.css` (`.sb-section*`, `.panel-*`). The Problemtype section
 * starts `hidden` — it is revealed by `webview/problemtype.ts` when the host
 * posts a `ptCatalog` message (any mesh preview: the VTK provider owns a
 * PtController too, converting non-.mdpa sources on Generate).
 */
export const SIDEBAR_HTML = `<aside id="sidebar">
      <section class="sb-section" data-section="layers">
        ${sectionHeader("layers", "Layers")}
        <div class="sb-section-body"><div id="outline"></div></div>
      </section>
      <section class="sb-section" data-section="edit">
        ${sectionHeader("sliders", "Edit", {
          actions: `<div class="panel-actions">
            <button type="button" id="edit-undo" class="panel-icon-btn" title="Undo" disabled>${glyph("undo")}</button>
            <button type="button" id="edit-redo" class="panel-icon-btn" title="Redo" disabled>${glyph("redo")}</button>
            <button type="button" id="edit-clear" class="panel-icon-btn" title="Clear all operations" disabled>${glyph("trash")}</button>
          </div>`,
        })}
        <div class="sb-section-body">
          <button type="button" id="edit-reapply" class="sb-action hidden" title="Re-run the operations that were skipped when the file was re-read">${ic("reload")}<span>Re-apply skipped operations</span></button>
          <button type="button" id="edit-remove-orphans" class="sb-action" title="Remove nodes referenced by no cell">${ic("orphan")}<span>Remove orphan nodes</span></button>
          <div class="edit-form collapsed">
            <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("merge")}<span>Merge coincident nodes</span></button>
            <div class="edit-form-row">
              <label class="edit-field"><span>tol</span><input type="text" id="merge-tol" class="edit-num edit-num-wide" value="1e-6"></label>
              <button type="button" class="edit-apply" data-op="mergeNodes" title="Apply merge">${ic("check")}</button>
            </div>
          </div>
          <div class="edit-form collapsed">
            <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("scale")}<span>Scale</span></button>
            <div class="edit-form-row">
              <label class="edit-field"><span>x</span><input type="number" id="scale-x" class="edit-num" value="1" step="0.1"></label>
              <label class="edit-field"><span>y</span><input type="number" id="scale-y" class="edit-num" value="1" step="0.1"></label>
              <label class="edit-field"><span>z</span><input type="number" id="scale-z" class="edit-num" value="1" step="0.1"></label>
              <button type="button" class="edit-apply" data-op="scale" title="Apply scale">${ic("check")}</button>
            </div>
          </div>
          <div class="edit-form collapsed">
            <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("translate")}<span>Translate</span></button>
            <div class="edit-form-row">
              <label class="edit-field"><span>x</span><input type="number" id="trans-x" class="edit-num" value="0" step="0.1"></label>
              <label class="edit-field"><span>y</span><input type="number" id="trans-y" class="edit-num" value="0" step="0.1"></label>
              <label class="edit-field"><span>z</span><input type="number" id="trans-z" class="edit-num" value="0" step="0.1"></label>
              <button type="button" class="edit-apply" data-op="translate" title="Apply translation">${ic("check")}</button>
            </div>
          </div>
          <div class="edit-form collapsed">
            <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("rotate")}<span>Rotate</span></button>
            <div class="edit-form-row">
              <label class="edit-field"><span>axis</span><select id="rot-axis" class="edit-sel"><option value="x">X</option><option value="y">Y</option><option value="z" selected>Z</option></select></label>
              <label class="edit-field"><span>deg</span><input type="number" id="rot-angle" class="edit-num" value="90" step="15"></label>
            </div>
            <div class="edit-form-row">
              <span class="edit-row-label">center</span>
              <label class="edit-field"><span>x</span><input type="number" id="rot-cx" class="edit-num" value="0" step="0.1"></label>
              <label class="edit-field"><span>y</span><input type="number" id="rot-cy" class="edit-num" value="0" step="0.1"></label>
              <label class="edit-field"><span>z</span><input type="number" id="rot-cz" class="edit-num" value="0" step="0.1"></label>
              <button type="button" class="edit-apply" data-op="rotate" title="Apply rotation">${ic("check")}</button>
            </div>
          </div>
          <div id="edit-history"></div>
          <div class="edit-form edit-queue-block">
            <label class="edit-check"><input type="checkbox" id="edit-queue-mode"><span>Queue operations for one apply</span></label>
            <div class="edit-queue-list" id="edit-queue-list"></div>
            <!-- Mirrors the queue's emptiness so setMeshModProgress's existing
                 data-gate mechanism keeps this button disabled at rest without
                 needing any change to that shared function. -->
            <input type="hidden" id="edit-queue-gate" disabled>
            <div class="edit-form-row">
              <button type="button" class="edit-apply edit-apply-mmg" data-op="batch" data-gate="edit-queue-gate"
                id="edit-apply-batch" disabled
                title="Apply every queued step as one sequence" data-run-title="Applying queued steps…">
                <span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span><span>Apply queued steps</span>
              </button>
              <button type="button" id="edit-queue-clear" class="panel-icon-btn" title="Discard the queue">${ic("close")}</button>
            </div>
            <div class="edit-progress hidden" id="batch-progress">
              <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
              <div class="edit-progress-msg"></div>
            </div>
          </div>
          <div class="edit-recipe">
            <button type="button" id="edit-save-ops" class="sb-action" title="Save the applied operations to a JSON recipe">${ic("save")}<span>Save operations…</span></button>
            <button type="button" id="edit-load-ops" class="sb-action" title="Load and replay an operations recipe">${ic("open")}<span>Load operations…</span></button>
          </div>
        </div>
      </section>
      <section class="sb-section" data-section="variables">
        ${sectionHeader("variable", "Variables")}
        <div class="sb-section-body">
          <p class="sb-placeholder" id="var-hint">Define a named variable — distance to a surface, or a formula over existing fields and coordinates — then compute it and view it on the mesh. Once computed it is an ordinary field, usable in any other formula here (including the Remesh sizing formula below).</p>
          <div id="var-list"></div>
          <button type="button" id="var-add" class="edit-addrow" title="Define a new variable">+ Add variable</button>
        </div>
      </section>
      <section class="sb-section" data-section="mesh-mod">
        ${sectionHeader("wrench", "Mesh Modification")}
        <div class="sb-section-body">
          <div class="sb-subsection collapsed" data-subsection="topology">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catTopology")}<span>Element order &amp; topology</span></button>
            <div class="sb-subsection-body">
              <button type="button" id="mesh-mod-quadratic" class="sb-action" title="Insert mid-edge nodes to make the mesh quadratic">${ic("quadratic")}<span>Convert Linear → Quadratic</span></button>
              <button type="button" id="mesh-mod-linearize" class="sb-action" title="Drop mid-side nodes back to a linear mesh (the inverse of Linear → Quadratic)">${ic("quadratic")}<span>Quadratic → Linear</span></button>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("refine")}<span>Refine</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>where</span><select id="refine-select" class="edit-num"><option value="all">whole mesh</option><option value="field">marked by a field</option><option value="part">a SubModelPart</option></select></label>
                  <label class="edit-field"><span>levels</span><input type="number" id="refine-levels" class="edit-num" value="1" min="1" max="4" step="1"></label>
                </div>
                <div class="edit-form-row hidden" id="refine-field-row">
                  <label class="edit-field"><span>field</span><select id="refine-variable" class="edit-num"></select></label>
                  <label class="edit-field"><span>is</span><select id="refine-compare" class="edit-num"><option value="&gt;">&gt;</option><option value="&gt;=">&ge;</option><option value="&lt;">&lt;</option><option value="&lt;=">&le;</option><option value="==">=</option><option value="!=">&ne;</option></select></label>
                  <label class="edit-field"><span>value</span><input type="number" id="refine-value" class="edit-num" value="0.5" step="0.1"></label>
                </div>
                <div class="edit-form-row hidden" id="refine-part-row">
                  <label class="edit-field"><span>part</span><select id="refine-part" class="edit-num"></select></label>
                </div>
                <div class="edit-form-row">
                  <button type="button" class="edit-apply" data-op="refine" title="Split cells into same-type children; a selection is closed so no hanging node is left">${ic("check")}</button>
                </div>
              </div>
              <div class="edit-form collapsed" id="repair-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("normals")}<span>Repair surface</span></button>
                <div class="edit-form-row">
                  <label class="edit-check" title="Make neighbouring faces agree on winding."><input type="checkbox" id="repair-orientation" checked><span>fix winding</span></label>
                  <label class="edit-check" title="Orient each closed component so its normals point out. Does not infer nested cavities."><input type="checkbox" id="repair-outward" checked><span>orient outward</span></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-check" title="Triangulate bounded holes. The new faces join the block they fill and are listed in a Repair_Fill SubModelPart; they carry no element field values."><input type="checkbox" id="repair-fill" checked><span>fill holes</span></label>
                  <label class="edit-check" title="Split a vertex where two fans of faces touch at a single point. Non-manifold EDGES are counted, never split."><input type="checkbox" id="repair-split" checked><span>split non-manifold vertices</span></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Holes with more boundary edges than this are left open."><span>max hole edges</span><input type="number" id="repair-maxhole" class="edit-num" value="10" min="3" step="1"></label>
                  <label class="edit-field" title="Weld points closer than this first; 0 leaves the points alone."><span>weld</span><input type="number" id="repair-weld" class="edit-num" value="0" min="0" step="any"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="repairSurface" title="Repair the surface mesh (see Advanced ▸ Face normals to preview the defects)" data-run-title="Repair the surface mesh"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="repair-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <button type="button" id="mesh-mod-simplexify" class="sb-action" title="Split hex/wedge/pyramid/quad cells into tetrahedra/triangles">${ic("simplexify")}<span>Simplexify</span></button>
            </div>
          </div>
          <div class="sb-subsection collapsed" data-subsection="remeshing">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catRemeshing")}<span>Remeshing (MMG)</span></button>
            <div class="sb-subsection-body">
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("remesh")}<span>Remesh (MMG)</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>mode</span><select id="remesh-mode" class="edit-sel edit-sel-mid">
                    <option value="factor" selected>size ×</option>
                    <option value="hsiz">uniform</option>
                    <option value="optimize">optimize</option>
                    <option value="expr">size = ƒ(h)</option>
                    <option value="aniso">anisotropic</option>
                  </select></label>
                  <label class="edit-field" id="remesh-value-field"><span id="remesh-value-label">factor</span><input type="number" id="remesh-value" class="edit-num edit-num-wide" value="0.5" step="0.1"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="remesh" title="Run the MMG remesher" data-run-title="Run the MMG remesher"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-expr hidden" id="remesh-expr-block">
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Fills the formula box below with a starting point. A boundary-layer-style grading needs a distance variable d plus the mean/min/max globals of the mesh size h and the maxAbs global of d — compute d first in the Variables sidebar section (e.g. Distance to a surface, named d), write the mesh size to the mesh, and add Global reduction rows named mean_h, min_h and max_h (of NODAL_H) and maxabs_d (maxAbs of d), which then become usable here by name like any other variable."><span>preset</span><select id="remesh-preset" class="edit-sel edit-sel-grow">
                      <option value="" selected>— choose a preset —</option>
                      <option value="0.5*h">Uniform: half the current size (0.5*h)</option>
                      <option value="clamp(0.85*mean_h*(abs(d)/maxabs_d), 0.85*min_h, 1.15*max_h)" data-auto-vars="1">Boundary layer (adds missing variables)</option>
                      <option value="clamp(0.3/max(abs(curvature_mean), 0.000001), 0.5*min, 1.5*max)" data-auto-curvature="1" title="Element size = 0.3 x the local radius of curvature (about 20 elements per full turn), bounded to 0.5x the smallest and 1.5x the largest current element size. Computes the mean curvature first if the mesh has none — a SURFACE mesh only.">Curvature-adaptive surface (computes curvature)</option>
                    </select></label>
                  </div>
                  <label class="edit-expr-field" title="Per-node target size, evaluated at every node.&#10;Variables: h (nodal size NODAL_H), x y z (coords), mean std min max median q1 q3 iqr (global NODAL_H stats), plus every existing Nodal field on the mesh by name — e.g. a variable computed in the Variables sidebar section.&#10;Functions: min max clamp abs sqrt sin cos tan exp log pow floor ceil round; constants pi e.&#10;e.g. clamp(0.5*h, mean-1.5*std, mean+1.5*std) — or, with a distance variable d, its maxabs_d global and the mean_h/min_h/max_h globals, clamp(0.85*mean_h*(abs(d)/maxabs_d), 0.85*min_h, 1.15*max_h)">
                    <span>size = </span>
                    <input type="text" id="remesh-sizeexpr" class="edit-expr-input" value="0.5*h" spellcheck="false" placeholder="0.5*h">
                  </label>
                  <div class="edit-expr-error hidden" id="remesh-sizeexpr-error"></div>
                  <div class="edit-form collapsed edit-subform" id="remesh-sizeparts-form">
                    <button type="button" class="edit-form-title"><span class="sb-chevron"></span><span>Per-part sizing</span></button>
                    <div id="remesh-sizeparts"></div>
                    <button type="button" id="remesh-sizeparts-add" class="edit-addrow" title="Add a per-SubModelPart size override">+ Add override</button>
                  </div>
                </div>
                <div class="edit-expr hidden" id="remesh-aniso-block">
                  <label class="edit-field edit-field-grow" title="Scalar nodal field whose Hessian drives the tensor metric — adapt the mesh to the curvature of this solution. The Hessian is computed inline; hmin/hmax below clamp the resulting sizes."><span>field</span><select id="remesh-aniso-variable" class="edit-sel edit-sel-grow"></select></label>
                  <label class="edit-field" title="Forwarded to BOTH internal gradient passes of the inline Hessian."><span>method</span><select id="remesh-aniso-method" class="edit-sel">
                    <option value="green-gauss" selected>green-gauss</option>
                    <option value="least-squares">least-squares</option>
                  </select></label>
                </div>
                <div class="edit-form collapsed edit-subform" id="remesh-freeze-form">
                  <button type="button" class="edit-form-title"><span class="sb-chevron"></span><span>Frozen entities &amp; local sizes</span></button>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Comma-separated EntityBlock names MMG must leave untouched."><span>freeze blocks</span><input type="text" id="remesh-frozen-blocks" class="edit-text" placeholder="BlockA, BlockB" spellcheck="false"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Comma-separated SubModelPart paths (subtree included) MMG must leave untouched."><span>freeze parts</span><input type="text" id="remesh-frozen-parts" class="edit-text" placeholder="Inlet, Wall/Outer" spellcheck="false"></label>
                  </div>
                  <div id="remesh-localsizes"></div>
                  <button type="button" id="remesh-localsizes-add" class="edit-addrow" title="Add a per-block / per-part hmin/hmax/hausd bound">+ Add local bound</button>
                </div>
                <div class="edit-progress hidden" id="remesh-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
                <div class="edit-form collapsed edit-subform">
                  <button type="button" class="edit-form-title"><span class="sb-chevron"></span><span>Advanced</span></button>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>hmin</span><input type="text" id="remesh-hmin" class="edit-num" placeholder="auto"></label>
                    <label class="edit-field"><span>hmax</span><input type="text" id="remesh-hmax" class="edit-num" placeholder="auto"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>hausd</span><input type="text" id="remesh-hausd" class="edit-num" placeholder="auto"></label>
                    <label class="edit-field"><span>hgrad</span><input type="text" id="remesh-hgrad" class="edit-num" placeholder="auto"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>angle</span><input type="text" id="remesh-angle" class="edit-num" placeholder="45°"></label>
                    <label class="edit-field"><span>module</span><select id="remesh-module" class="edit-sel">
                      <option value="auto" selected>auto</option>
                      <option value="mmg3d">volume</option>
                      <option value="mmgs">surface</option>
                      <option value="mmg2d">planar</option>
                    </select></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-check" title="Keep the surface geometry untouched (IPARAM_nosurf)"><input type="checkbox" id="remesh-nosurf"><span>keep surface</span></label>
                    <label class="edit-check" title="No point insertion/removal (IPARAM_noinsert)"><input type="checkbox" id="remesh-noinsert"><span>no insert</span></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-check" title="No edge/face swapping (IPARAM_noswap)"><input type="checkbox" id="remesh-noswap"><span>no swap</span></label>
                    <label class="edit-check" title="No point relocation (IPARAM_nomove)"><input type="checkbox" id="remesh-nomove"><span>no move</span></label>
                  </div>
                </div>
              </div>
              <div class="edit-form collapsed" id="ls-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("levelset")}<span>Level-set split (MMG)</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>field</span><select id="ls-variable" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field"><span>iso</span><input type="number" id="ls-isovalue" class="edit-num edit-num-wide" value="0" step="0.1"></label>
                  <label class="edit-check" title="Split boundary surfaces only, not the volume domains (IPARAM_isosurf, mmg3d)"><input type="checkbox" id="ls-isosurf"><span>surface only</span></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="levelset" title="Discretize the isovalue as a mesh boundary" data-run-title="Discretize the isovalue as a mesh boundary" data-gate="ls-variable"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-form collapsed edit-subform" id="ls-materials-form">
                  <button type="button" class="edit-form-title"><span class="sb-chevron"></span><span>Materials &amp; base references</span></button>
                  <div class="edit-form-row">
                    <label class="edit-check edit-field-grow" title="Return each split cell to its ORIGINAL block and SubModelParts, with the side carried by the generated MMG_Domain_Inside/_Outside parts. Without this, every domain cell collapses into MMG_Domain_Inside/_Outside blocks and all block identity is lost."><input type="checkbox" id="ls-keep-materials"><span>keep materials</span></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Comma-separated EntityBlock names the level set must not cut. Implies 'keep materials'."><span>no-split blocks</span><input type="text" id="ls-nosplit-blocks" class="edit-text" placeholder="BlockA, BlockB" spellcheck="false"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Comma-separated SubModelPart paths (subtree included) the level set must not cut. Implies 'keep materials'."><span>no-split parts</span><input type="text" id="ls-nosplit-parts" class="edit-text" placeholder="Steel, Frame/Inner" spellcheck="false"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Comma-separated BOUNDARY block names. A split domain survives only if it touches one of them; the rest are deleted. Enables rmc at 1e-5 if you leave rmc blank."><span>base ref blocks</span><input type="text" id="ls-baseref-blocks" class="edit-text" placeholder="Skin" spellcheck="false"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Comma-separated SubModelPart paths naming BOUNDARY entities. A split domain survives only if it touches one of them."><span>base ref parts</span><input type="text" id="ls-baseref-parts" class="edit-text" placeholder="Wall, Inlet" spellcheck="false"></label>
                  </div>
                </div>
                <div class="edit-progress hidden" id="ls-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
                <div class="edit-form collapsed edit-subform">
                  <button type="button" class="edit-form-title"><span class="sb-chevron"></span><span>Advanced</span></button>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>hmin</span><input type="text" id="ls-hmin" class="edit-num" placeholder="auto"></label>
                    <label class="edit-field"><span>hmax</span><input type="text" id="ls-hmax" class="edit-num" placeholder="auto"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>hausd</span><input type="text" id="ls-hausd" class="edit-num" placeholder="auto"></label>
                    <label class="edit-field"><span>hgrad</span><input type="text" id="ls-hgrad" class="edit-num" placeholder="auto"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field edit-field-grow" title="Delete split components whose volume fraction of the mesh is below this (DPARAM_rmc) — the small parasitic blobs an SDF distance + level-set chain leaves behind. Between 0 and 1; MMG's own default when enabled is 1e-5. Not available with 'surface only'."><span>rmc</span><input type="text" id="ls-rmc" class="edit-num" placeholder="off"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>module</span><select id="ls-module" class="edit-sel">
                      <option value="auto" selected>auto</option>
                      <option value="mmg3d">volume</option>
                      <option value="mmgs">surface</option>
                      <option value="mmg2d">planar</option>
                    </select></label>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="sb-subsection collapsed" data-subsection="smoothing">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catSmoothing")}<span>Smoothing &amp; renumbering</span></button>
            <div class="sb-subsection-body">
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("smooth")}<span>Smooth</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>method</span><select id="smooth-method" class="edit-sel edit-sel-mid">
                    <option value="taubin" selected>taubin</option>
                    <option value="laplacian">laplacian</option>
                    <option value="odt">odt (tets only)</option>
                  </select></label>
                  <label class="edit-field"><span>iters</span><input type="number" id="smooth-iterations" class="edit-num" value="10" min="1" step="1"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="smooth" title="Relax node positions" data-run-title="Relax node positions"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="smooth-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
                <div class="edit-form collapsed edit-subform">
                  <button type="button" class="edit-form-title"><span class="sb-chevron"></span><span>Advanced</span></button>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>lambda</span><input type="text" id="smooth-lambda" class="edit-num" placeholder="auto"></label>
                    <label class="edit-field"><span>mu</span><input type="text" id="smooth-mu" class="edit-num" value="-0.34" placeholder="-0.34"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-field"><span>feature °</span><input type="number" id="smooth-angle" class="edit-num" value="30" step="5"></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-check" title="Pin boundary nodes (IPARAM equivalent: fixBoundary)"><input type="checkbox" id="smooth-fixboundary" checked><span>fix boundary</span></label>
                    <label class="edit-check" title="Pin nodes on sharp edges"><input type="checkbox" id="smooth-features" checked><span>keep features</span></label>
                  </div>
                  <div class="edit-form-row">
                    <label class="edit-check" title="Reject a move that would invert a cell"><input type="checkbox" id="smooth-guard" checked><span>guard inversion</span></label>
                  </div>
                </div>
              </div>
              <div class="edit-form collapsed" id="sw-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("sdf")}<span>Shrinkwrap…</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>target file</span><input type="text" id="sw-path" class="edit-text" placeholder="Choose a surface mesh…" readonly></label>
                  <button type="button" id="sw-browse" class="panel-icon-btn" title="Choose the triangle surface to project onto">${ic("open")}</button>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Or project onto a SubModelPart already in THIS mesh, or onto its own exterior skin. Picking one here clears the file above, and vice versa."><span>or SubModelPart / skin</span><select id="sw-target" class="edit-sel edit-sel-grow"><option value="">— none —</option></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Stand off from the target along its normal; negative goes to the other side. A non-zero offset needs a closed target to mean the same side everywhere."><span>offset</span><input type="number" id="sw-offset" class="edit-num" value="0" step="any"></label>
                  <label class="edit-field" title="Nodes farther than this from the target stay where they are. 0 = unlimited."><span>max dist</span><input type="number" id="sw-maxdist" class="edit-num" value="0" min="0" step="any"></label>
                  <label class="edit-field" title="x' = x + blend × (projection − x). 1 lands on the target; 0.5 goes half way. Not clamped, so a value above 1 overshoots."><span>blend</span><input type="number" id="sw-blend" class="edit-num" value="1" step="0.1"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Only the nodes of this SubModelPart (and its subtree) may move."><span>move only</span><select id="sw-move" class="edit-sel edit-sel-grow"><option value="">— all nodes —</option></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="The nodes of this SubModelPart (and its subtree) are held in place."><span>keep fixed</span><select id="sw-pin" class="edit-sel edit-sel-grow"><option value="">— none —</option></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-check" title="Also write the distance each node was from the target BEFORE the move as SHRINKWRAP_DISTANCE (a gap where a node was not queried)."><input type="checkbox" id="sw-record"><span>write distance field</span></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="shrinkwrap" title="Project the nodes onto the target — a projection, not a collision-free fit; the message reports any cell it folds over" data-run-title="Project the nodes onto the target surface"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="sw-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed" id="sob-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("smooth")}<span>Sobolev deformation</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="A nodal field holding a raw displacement per node (2 or 3 components). It is smoothed through the mesh's own finite-element operators, then applied."><span>displacement</span><select id="sob-variable" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="The filter's cutoff wavelength, in mesh units. Short wavelengths are suppressed, long ones pass. 0 applies the displacement unfiltered."><span>length scale</span><input type="number" id="sob-length" class="edit-num" value="0.5" min="0" step="any"></label>
                  <label class="edit-check" title="Also pin every node on a boundary face of the top-dimensional cells."><input type="checkbox" id="sob-boundary"><span>pin boundary</span></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="The nodes of this SubModelPart (and its subtree) do not move."><span>pin part</span><select id="sob-fixed" class="edit-sel edit-sel-grow"><option value="">— none —</option></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Conjugate-gradient iteration cap. If it is reached first the last iterate is kept and the message says the solve did not converge."><span>max iter</span><input type="number" id="sob-iter" class="edit-num" value="128" min="1" step="1"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="sobolevDeform" title="Smooth the displacement field and move the nodes by it (linear triangles or tetrahedra only)" data-run-title="Apply the smoothed displacement"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="sob-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("reorder")}<span>Reorder nodes (storage order)</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>method</span><select id="reorder-method" class="edit-sel edit-sel-grow">
                    <option value="rcm" selected>bandwidth (RCM)</option>
                    <option value="morton">locality (Morton)</option>
                    <option value="hilbert">locality (Hilbert)</option>
                  </select></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="reorder" title="Reorder the nodes in storage order — the ids are unchanged" data-run-title="Reorder the nodes in storage order — the ids are unchanged"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="reorder-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("renumber")}<span>Renumber (compact ids)</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>ids</span><select id="renumber-target" class="edit-sel edit-sel-grow">
                    <option value="all" selected>nodes + entities</option>
                    <option value="nodes">nodes only</option>
                    <option value="entities">elements / conditions / geometries</option>
                  </select></label>
                  <label class="edit-field"><span>from</span><input type="number" id="renumber-start" class="edit-num" value="1" min="1" step="1"></label>
                  <button type="button" class="edit-apply" data-op="renumber" title="Compact ids into a gapless run — each entity kind numbered independently, as Kratos does">${ic("check")}</button>
                </div>
              </div>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("partition")}<span>Partition</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>parts</span><input type="number" id="partition-nparts" class="edit-num" value="2" min="1" step="1"></label>
                  <label class="edit-check"><input type="checkbox" id="partition-createparts"><span>as SubModelParts</span></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="partition" title="Split the mesh into balanced parts (Hilbert curve — no KaHIP in this build)" data-run-title="Split the mesh into balanced parts"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="partition-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="sb-subsection collapsed" data-subsection="selection">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catSelection")}<span>Selection &amp; combination</span></button>
            <div class="sb-subsection-body">
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("crop")}<span>Crop</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>by</span><select id="crop-kind" class="edit-sel edit-sel-mid">
                    <option value="bbox" selected>box</option>
                    <option value="plane">plane</option>
                  </select></label>
                  <label class="edit-field"><span>keep</span><select id="crop-mode" class="edit-sel edit-sel-mid">
                    <option value="all" selected>all nodes in</option>
                    <option value="any">any node in</option>
                  </select></label>
                </div>
                <div class="edit-form-row" id="crop-bbox-row">
                  <span class="edit-row-label">min</span>
                  <input type="number" id="crop-lo-x" class="edit-num" value="0" step="0.1">
                  <input type="number" id="crop-lo-y" class="edit-num" value="0" step="0.1">
                  <input type="number" id="crop-lo-z" class="edit-num" value="0" step="0.1">
                </div>
                <div class="edit-form-row" id="crop-bbox-row2">
                  <span class="edit-row-label">max</span>
                  <input type="number" id="crop-hi-x" class="edit-num" value="1" step="0.1">
                  <input type="number" id="crop-hi-y" class="edit-num" value="1" step="0.1">
                  <input type="number" id="crop-hi-z" class="edit-num" value="1" step="0.1">
                </div>
                <div class="edit-form-row hidden" id="crop-plane-row">
                  <span class="edit-row-label">point</span>
                  <input type="number" id="crop-point-x" class="edit-num" value="0" step="0.1">
                  <input type="number" id="crop-point-y" class="edit-num" value="0" step="0.1">
                  <input type="number" id="crop-point-z" class="edit-num" value="0" step="0.1">
                </div>
                <div class="edit-form-row hidden" id="crop-plane-row2">
                  <span class="edit-row-label">normal</span>
                  <input type="number" id="crop-normal-x" class="edit-num" value="1" step="0.1">
                  <input type="number" id="crop-normal-y" class="edit-num" value="0" step="0.1">
                  <input type="number" id="crop-normal-z" class="edit-num" value="0" step="0.1">
                </div>
                <div class="edit-form-row">
                  <button type="button" class="edit-apply" data-op="crop" title="Keep only the cells inside the box/plane">${ic("check")}</button>
                </div>
              </div>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("mergeMesh")}<span>Merge mesh…</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>files</span><input type="text" id="merge-path" class="edit-text" placeholder="Choose one or more files…" readonly></label>
                  <button type="button" id="merge-browse" class="panel-icon-btn" title="Choose the mesh file(s) to merge in">${ic("open")}</button>
                </div>
                <div class="edit-form-row">
                  <label class="edit-check"><input type="checkbox" id="merge-weld"><span>weld coincident nodes</span></label>
                  <label class="edit-field"><span>tol</span><input type="number" id="merge-tolerance" class="edit-num" value="0.000001" step="0.000001"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>name</span><input type="text" id="merge-name" class="edit-text" placeholder="MergedMesh"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="mergeMesh" title="Merge in the chosen file" data-run-title="Merge in the chosen file"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="mergeMesh-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="sb-subsection collapsed" data-subsection="fields">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catFields")}<span>Fields</span></button>
            <div class="sb-subsection-body">
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("fieldCalc")}<span>Field calculator</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>at</span><select id="calc-location" class="edit-sel edit-sel-mid">
                    <option value="Nodal" selected>nodes</option>
                    <option value="Elemental">elements</option>
                    <option value="Conditional">conditions</option>
                  </select></label>
                  <label class="edit-field edit-field-grow"><span>output</span><input type="text" id="calc-output" class="edit-text" placeholder="SPEED"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-expr-field edit-field-grow" title="Variables: x,y,z plus every existing field at the chosen location (a vector field's components as NAME_X/NAME_Y/NAME_Z). Functions: min max clamp abs sqrt sin cos tan exp log pow floor ceil round; constants pi e.">
                    <span>=</span>
                    <input type="text" id="calc-expr" class="edit-expr-input" placeholder="sqrt(VELOCITY_X^2+VELOCITY_Y^2)" spellcheck="false">
                  </label>
                  <button type="button" class="edit-apply" data-op="fieldCalc" title="Compute the output field">${ic("check")}</button>
                </div>
                <div class="edit-expr-error hidden" id="calc-expr-error"></div>
              </div>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("average")}<span>Average field</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>field</span><input type="text" id="avg-variable" class="edit-text" placeholder="TEMPERATURE"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field"><span>direction</span><select id="avg-direction" class="edit-sel edit-sel-grow">
                    <option value="nodalToElemental" selected>nodal → elemental</option>
                    <option value="elementalToNodal">elemental → nodal</option>
                  </select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field"><span>on</span><select id="avg-target" class="edit-sel edit-sel-mid">
                    <option value="Elements" selected>Elements</option>
                    <option value="Conditions">Conditions</option>
                  </select></label>
                  <button type="button" class="edit-apply" data-op="averageField" title="Average the field to the other location">${ic("check")}</button>
                </div>
              </div>
              <div class="edit-form collapsed" id="fm-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("edit")}<span>Manage fields</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>field</span><select id="fm-field" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Letters, digits and underscores; the mesh writers emit the name verbatim."><span>new name</span><input type="text" id="fm-newname" class="edit-text" placeholder="TEMPERATURE_OLD"></label>
                  <button type="button" class="edit-apply" data-op="renameField" title="Rename the selected field (a global reduction reading it follows the new name)">${ic("check")}</button>
                </div>
                <div class="edit-form-row">
                  <label class="edit-check" title="Only relevant when the new name is already taken at that location."><input type="checkbox" id="fm-overwrite"><span>overwrite if taken</span></label>
                </div>
                <div class="edit-form-row">
                  <button type="button" class="edit-apply" data-op="dropFields" title="Remove the selected field from the mesh">${ic("close")}<span>Drop</span></button>
                  <button type="button" class="edit-apply" data-op="keepFields" title="Remove every OTHER field at this location">${ic("check")}<span>Keep only</span></button>
                </div>
              </div>
              <div class="edit-form collapsed" id="cond-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("fieldCalc")}<span>Condition field</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>field</span><select id="cond-field" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="clamp: min(max(x, lo), hi). normalize: affine map of the field's own range onto [lo, hi]. standardize: zero mean, unit standard deviation (statistics over the finite values)."><span>mode</span><select id="cond-mode" class="edit-sel edit-sel-mid">
                    <option value="normalize" selected>normalize</option>
                    <option value="clamp">clamp</option>
                    <option value="standardize">standardize</option>
                  </select></label>
                  <label class="edit-field" id="cond-lo-field"><span>lo</span><input type="number" id="cond-lo" class="edit-num" value="0" step="any"></label>
                  <label class="edit-field" id="cond-hi-field"><span>hi</span><input type="number" id="cond-hi" class="edit-num" value="1" step="any"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="component: each column on its own statistics. magnitude: statistics over each row's length, whole rows rescaled so direction is kept (a scalar always uses component)."><span>scope</span><select id="cond-scope" class="edit-sel edit-sel-mid">
                    <option value="component" selected>component</option>
                    <option value="magnitude">magnitude</option>
                  </select></label>
                  <label class="edit-field" title="What a non-finite value does. ignore leaves it and excludes it from the statistics; replace writes the value below; fail refuses the operation."><span>NaN</span><select id="cond-nan" class="edit-sel edit-sel-mid">
                    <option value="ignore" selected>ignore</option>
                    <option value="replace">replace</option>
                    <option value="fail">fail</option>
                  </select></label>
                  <label class="edit-field" id="cond-nanvalue-field"><span>with</span><input type="number" id="cond-nanvalue" class="edit-num" value="0" step="any"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Blank overwrites the field in place; a name keeps the original and writes the result beside it."><span>output</span><input type="text" id="cond-output" class="edit-text" placeholder="in place"></label>
                  <button type="button" class="edit-apply" data-op="conditionField" title="Condition the field's values">${ic("check")}</button>
                </div>
              </div>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("fieldCalc")}<span>Field gradient</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>field</span><select id="grad-variable" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field"><span>operator</span><select id="grad-operator" class="edit-sel edit-sel-mid">
                    <option value="gradient" selected>gradient</option>
                    <option value="divergence">divergence</option>
                    <option value="curl">curl</option>
                  </select></label>
                  <label class="edit-field edit-field-grow"><span>output</span><input type="text" id="grad-output" class="edit-text" placeholder="auto"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Green-Gauss integrates over the cell's own faces and is exact for a linear field on any cell. Least-squares fits over the node-sharing neighbours and is smoother on an irregular mesh."><span>method</span><select id="grad-method" class="edit-sel edit-sel-grow">
                    <option value="green-gauss" selected>green-gauss</option>
                    <option value="least-squares">least-squares</option>
                  </select></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="fieldGradient" title="Differentiate the nodal field" data-run-title="Differentiate the nodal field"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="grad-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed" id="hessian-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("fieldHessian")}<span>Field Hessian</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>field</span><select id="hess-variable" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="The Hessian is defined for a SCALAR field, and is the flattened row-major 3x3 second-derivative matrix (9 components). A field that is at most linear has an exactly zero Hessian everywhere."><span>output</span><input type="text" id="hess-output" class="edit-text" placeholder="auto"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Forwarded to BOTH internal gradient passes — the Hessian is a composition of two gradients, so this is an approximate curvature estimate on an irregular mesh."><span>method</span><select id="hess-method" class="edit-sel edit-sel-grow">
                    <option value="green-gauss" selected>green-gauss</option>
                    <option value="least-squares">least-squares</option>
                  </select></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="fieldHessian" title="Differentiate the nodal field twice" data-run-title="Differentiate the nodal field twice"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="hess-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed" id="curv-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("fieldHessian")}<span>Surface curvature</span></button>
                <div class="edit-form-row">
                  <label class="edit-check" title="Mean curvature H: 1/R on a sphere of radius R. The SIGN follows the winding — a surface wound inside-out reads -1/R."><input type="checkbox" id="curv-mean" checked><span>mean</span></label>
                  <label class="edit-check" title="Gaussian curvature K: 1/R² on a sphere. Independent of the winding."><input type="checkbox" id="curv-gauss" checked><span>Gaussian</span></label>
                  <label class="edit-check" title="The two principal curvatures k1 ≥ k2, written as two scalar fields."><input type="checkbox" id="curv-principal"><span>principal</span></label>
                  <label class="edit-check" title="Also write the per-node dual area the curvatures were divided by."><input type="checkbox" id="curv-area"><span>area</span></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="mixed-voronoi is exact for a well-shaped triangulation; barycentric is more forgiving of obtuse triangles."><span>dual area</span><select id="curv-dual" class="edit-sel edit-sel-mid">
                    <option value="mixed-voronoi" selected>mixed-voronoi</option>
                    <option value="barycentric">barycentric</option>
                  </select></label>
                  <label class="edit-check" title="Boundary nodes of an open surface have no curvature and are left as gaps unless this is on."><input type="checkbox" id="curv-boundary"><span>boundary nodes</span></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Fields are named <prefix>_MEAN, _GAUSSIAN, _AREA, _K1 and _K2. They are ordinary nodal fields: colour by them in the Field panel, or use them in a remesh size formula."><span>prefix</span><input type="text" id="curv-prefix" class="edit-text" placeholder="CURVATURE"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="curvature" title="Measure the surface curvature (a surface mesh only)" data-run-title="Measure the surface curvature"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="curv-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed" id="errest-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("estimateError")}<span>Error estimate</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>field</span><select id="errest-variable" class="edit-sel edit-sel-grow"></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="How to turn the indicator into a 0/1 &quot;refine me&quot; flag, attached as a second Elemental field. absolute thresholds the indicator; fraction marks that share of cells, worst first; dorfler marks the smallest set holding that share of the total error."><span>marking</span><select id="errest-marking" class="edit-sel edit-sel-mid">
                    <option value="none" selected>none</option>
                    <option value="absolute">absolute</option>
                    <option value="fraction">fraction</option>
                    <option value="dorfler">dorfler</option>
                  </select></label>
                  <label class="edit-field" id="errest-value-field" title="A threshold for absolute; a fraction in (0, 1] for fraction and dorfler."><span>value</span><input type="number" id="errest-value" class="edit-num" value="0.5" step="0.05" min="0"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Zienkiewicz-Zhu: sqrt(measure * sum((recovered - raw gradient)^2)) per cell. A field the mesh represents exactly — anything linear — has zero error, so a near-zero result means the mesh already resolves the solution."><span>output</span><input type="text" id="errest-output" class="edit-text" placeholder="auto"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="estimateError" title="Estimate the approximation error of the nodal field" data-run-title="Estimate the approximation error of the nodal field"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="errest-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed" id="sdf-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("sdf")}<span>Distance to surface…</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>surface file</span><input type="text" id="sdf-path" class="edit-text" placeholder="Choose a surface mesh…" readonly></label>
                  <button type="button" id="sdf-browse" class="panel-icon-btn" title="Choose the surface mesh to measure distance to">${ic("open")}</button>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Or measure distance to a SubModelPart already in THIS mesh — e.g. an existing skin/boundary group — or to the mesh's own exterior skin (the surface Advanced ▸ Export skin… writes; needs volume cells) instead of an external file. Picking one here clears the file above, and vice versa."><span>or SubModelPart / skin</span><select id="sdf-part" class="edit-sel edit-sel-grow"><option value="">— none —</option></select></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="pseudonormal is the fast angle-weighted inside test; winding is the robust generalized winding number, slower but tolerant of small holes; none returns unsigned distance. The surface must be CLOSED for the sign to mean anything."><span>sign</span><select id="sdf-sign" class="edit-sel edit-sel-mid">
                    <option value="pseudonormal" selected>pseudonormal</option>
                    <option value="winding">winding</option>
                    <option value="none">unsigned</option>
                  </select></label>
                  <label class="edit-field" title="Compute exact values only within this distance of the surface, clamping beyond it. 0 = no band."><span>band</span><input type="number" id="sdf-band" class="edit-num" value="0" min="0" step="0.1"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Negative is inside. Feed this field to the Level-set split (MMG) operation to cut the mesh along the surface."><span>output</span><input type="text" id="sdf-output" class="edit-text" placeholder="SDF_DISTANCE"></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="sdfDistance" title="Measure the signed distance from every node to the surface" data-run-title="Measure the signed distance from every node to the surface"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="sdf-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
              <div class="edit-form collapsed" id="xfer-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("transferField")}<span>Transfer fields…</span></button>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow"><span>source</span><input type="text" id="xfer-path" class="edit-text" placeholder="Choose the mesh to take fields from…" readonly></label>
                  <button type="button" id="xfer-browse" class="panel-icon-btn" title="Choose the mesh whose fields are transferred onto this one">${ic("open")}</button>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field edit-field-grow" title="Comma-separated. Leave empty to transfer every field the source carries."><span>fields</span><input type="text" id="xfer-arrays" class="edit-text" placeholder="all"></label>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Mass-preserving: over the region the two meshes share, the measure-weighted sum is equal on both sides. Nodal data is transferred by a cell round trip, so it is SMOOTHED rather than resampled."><span>on clash</span><select id="xfer-conflict" class="edit-sel edit-sel-grow">
                    <option value="overwrite" selected>overwrite</option>
                    <option value="suffix">suffix</option>
                    <option value="error">error</option>
                  </select></label>
                  <button type="button" class="edit-apply edit-apply-mmg" data-op="transferField" title="Transfer the source mesh's fields onto this one" data-run-title="Transfer the source mesh's fields onto this one"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
                </div>
                <div class="edit-progress hidden" id="xfer-progress">
                  <div class="edit-progress-track"><div class="edit-progress-bar"></div></div>
                  <div class="edit-progress-msg"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="sb-subsection collapsed" data-subsection="spheres">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catSpheres")}<span>Sphere elements</span></button>
            <div class="sb-subsection-body">
              <div class="edit-form collapsed" id="radius-form">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("spheres")}<span>Set element radius</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>mode</span><select id="radius-mode" class="edit-sel edit-sel-mid">
                    <option value="absolute" selected>set to</option>
                    <option value="multiply">scale ×</option>
                  </select></label>
                  <label class="edit-field"><span>value</span><input type="number" id="radius-value" class="edit-num edit-num-wide" value="1" step="0.1" min="0"></label>
                  <button type="button" class="edit-apply" data-op="setElementRadius" title="Set the RADIUS of the sphere (one-node) elements">${ic("check")}</button>
                </div>
                <div class="edit-form-row">
                  <label class="edit-field" title="Limit the change to one SubModelPart and its subtree"><span>part</span><select id="radius-target" class="edit-sel edit-sel-grow"></select></label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section class="sb-section" data-section="problemtype" id="pt-section" hidden>
        ${sectionHeader("workflow", "Problemtype")}
        <div class="sb-section-body">
          <div class="edit-form-row">
            <label class="edit-field"><span>type</span><select id="pt-select" class="edit-sel edit-sel-grow"></select></label>
          </div>
          <div id="pt-body" class="hidden">
            <div id="pt-forms"></div>
            <div id="pt-assignments"></div>
            <div id="pt-materials"></div>
            <div id="pt-output"></div>
            <div class="pt-actions">
              <button type="button" id="pt-generate" class="sb-action" title="Write ProjectParameters.json, the materials file and MainKratos.py next to the mdpa">${ic("generateCase")}<span>Generate case files</span></button>
              <button type="button" id="pt-run" class="sb-action panel-primary-btn" title="Generate the case files and run MainKratos.py in a terminal">${ic("runCase")}<span>Run case</span></button>
              <button type="button" id="pt-open-results" class="sb-action" title="Open the vtk_output results in the VTK preview">${ic("results")}<span>Open results</span></button>
            </div>
            <div id="pt-status" class="pt-status"></div>
          </div>
        </div>
      </section>
      <!-- Advanced: the read-only / diagnostic sections, folded behind one
           collapsed group so the sidebar's top level holds only what EDITS the
           model (the split rule CAD-Preview's sidebar uses). Each child keeps
           its own chevron; the count badge is kept truthful by
           webview/sidebar.ts's setupAdvancedGroupCount. -->
      <section class="sb-section sb-group collapsed" id="advanced-group" data-section="advanced">
        <div id="advanced-header" class="sb-section-header panel-header">
          <button type="button" class="panel-chevron" aria-expanded="false" title="Expand section">${glyph("chevronDown")}</button>
          <span class="panel-icon" aria-hidden="true">${glyph("layers")}</span>
          <span id="advanced-title" class="panel-title">Advanced</span>
          <span id="advanced-count" class="ui-num" title="Sections available for this document"></span>
        </div>
        <div id="advanced-body" class="sb-section-body">
          <div class="advanced-subhead">Analysis</div>
          <section class="sb-section" data-section="information">
            ${sectionHeader("info", "Information")}
            <div class="sb-section-body"><div id="stats"></div></div>
          </section>
        </div>
      </section>
    </aside>`;

// ---- The document skeleton ---------------------------------------------------

/**
 * A nonce for the CSP's `script-src` and the `<script>` tag that must match it.
 * Lives here rather than in the providers so the two cannot drift, and so the
 * skeleton below is self-contained.
 */
export function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Everything the skeleton needs, as already-resolved strings.
 *
 * Deliberately NOT a `vscode.Webview`: this module is vscode-free (the webview
 * bundle and the screenshot harness both import from it), and a structural
 * `{ asWebviewUri }` would buy nothing, since resolving a media file still needs
 * `vscode.Uri.joinPath` at the call site. `previewHtml.ts` does that resolution.
 */
export interface PreviewHtmlOptions {
  /** `media/webview.js`, as a webview-safe URI. */
  scriptUri: string;
  /** `media/design-system.css` — must be linked BEFORE styleUri. */
  designSystemUri: string;
  /** `media/style.css`, as a webview-safe URI. */
  styleUri: string;
  /** `webview.cspSource`. */
  cspSource: string;
  /** From `getNonce()`; appears in both the CSP and the `<script>` tag. */
  nonce: string;
  /** Browser-tab title, the only difference between the two providers. */
  title: string;
  /** The persisted scene theme, as `data-theme`. */
  theme: string;
  /**
   * MDPA only — the Flowgraph split orientation. Omitted for the VTK provider
   * and the empty panel, where the attribute is absent entirely rather than
   * defaulted, because neither can host a Flowgraph pane.
   */
  flowgraphOrientation?: string;
  /**
   * Start with the chrome visible and no mesh, instead of behind the loading
   * overlay. An attribute rather than a message: a host round-trip would flash
   * the spinner first, and a new message case would touch both providers'
   * switches for the benefit of a launcher that loads nothing.
   */
  startEmpty?: boolean;
}

/**
 * The full `<html>` document for a mesh preview — the one skeleton behind the
 * MDPA provider, the VTK provider and the standalone empty panel.
 *
 * The `#app` wrapper ships hidden and `LOADING_HTML` covers the viewport until
 * the webview's `hideLoading()` runs, which normally happens on the first
 * `model` / `vtkFrame` / `error` message. `startEmpty` is the exception: with no
 * file there is no such message, so the flag tells `webview/main.ts` to unhide
 * immediately (see its `dataset.startEmpty` check).
 */
export function buildPreviewHtml(o: PreviewHtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${o.cspSource} https: data:`,
    `style-src ${o.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${o.nonce}'`,
    `worker-src blob:`,
    // The embedded Flowgraph editor is served from a localhost port (or an
    // https tunnel under Remote/Codespaces) resolved via asExternalUri *after*
    // this CSP is baked, so frame-src is scoped by scheme/host rather than the
    // exact port. The iframe document has its own (absent) CSP, so flowgraph's
    // jQuery/CDN/eval load unaffected. The VTK provider and the empty panel
    // carry the same clause so the shared chrome behaves identically.
    `frame-src http://localhost:* http://127.0.0.1:* https:`,
    `child-src blob:`,
  ].join("; ");

  const orientationAttr =
    o.flowgraphOrientation === undefined
      ? ""
      : ` data-flowgraph-orientation="${o.flowgraphOrientation}"`;
  const startEmptyAttr = o.startEmpty ? ` data-start-empty="1"` : "";
  const emptyHint = o.startEmpty ? EMPTY_HINT_HTML : "";

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${o.designSystemUri}" rel="stylesheet" />
  <link href="${o.styleUri}" rel="stylesheet" />
  <title>${o.title}</title>
</head>
<body data-theme="${o.theme}"${orientationAttr}${startEmptyAttr}>
  ${LOADING_HTML}
  <div id="app" style="display:none">
    ${MENUBAR_HTML}
    <div id="main">
    ${SIDEBAR_HTML}
    <div id="sidebar-resizer" role="separator" aria-orientation="vertical" tabindex="0" title="Drag or press ArrowLeft/ArrowRight to resize the sidebar"></div>
    <div id="viewport">
      <div id="vtk-sub">
      <div id="cut-panel" class="hidden">${CUT_PANEL_HTML}
      </div>
      <div id="toolbar">${TOOLBAR_HTML}
      </div>
      ${VIEW_MENU_HTML}
      ${ADVANCED_MENU_HTML}
      <div id="find-bar">
        <select id="find-type">
          <option>Node</option>
          <option>Element</option>
          <option>Condition</option>
          <option>Geometry</option>
        </select>
        <input id="find-id" type="number" min="1" placeholder="ID" />
        <button id="find-go">Go</button>
        <button id="find-close" title="Close">${ic("close")}</button>
        <span id="find-status"></span>
      </div>
      <div id="render-root"></div>${emptyHint}
      </div>
      ${FLOWGRAPH_PANE_HTML}
    </div>
    </div>
    ${STATUSBAR_HTML}
  </div>
  <script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

/**
 * The standalone panel's "nothing loaded yet" overlay. Emitted only under
 * `startEmpty`, so a real preview never carries it — there is no state in which
 * a file-backed panel should show it, and leaving it out entirely is cheaper
 * than a class the webview would have to remember to remove.
 */
const EMPTY_HINT_HTML = `
      <div id="empty-hint">
        <div class="empty-hint-title">No mesh loaded</div>
        <p>Open a mesh to explore it here.</p>
        <button type="button" id="empty-hint-open">${ic("open")}<span>Open Mesh File…</span></button>
        <p class="empty-hint-note">Also in the <strong>File</strong> menu, top left.</p>
      </div>`;
