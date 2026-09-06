// Shared, static webview chrome markup used by both custom-editor providers
// (mdpaEditorProvider + vtkEditorProvider) so the sidebar structure stays in one
// place and cannot drift between them. The sidebar has no interpolated content —
// `#stats` and `#outline` are filled at runtime by the webview — so a plain
// constant string is enough.

import { TOOLBAR_ICONS } from "./toolbarIcons";
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
          ${ic("fileMenu")}<span class="file-menu-label">File</span><span class="file-menu-caret">▾</span>
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
 * the File menu on the left and the scene-theme picker on the right — the
 * reference top-chrome layout. Rendered by both providers as the first child
 * of `#app`; styled by `#menubar*` in `webview/style.css`.
 */
export const MENUBAR_HTML = `<div id="menubar">
      ${FILE_MENU_HTML}
      <span class="menubar-spacer"></span>
      <select id="theme-select" title="Scene theme">
        <option value="auto">Auto</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="scientific">Scientific</option>
      </select>
    </div>`;

/**
 * The **Advanced** toolbar button and its dropdown.
 *
 * A home for operations that are real but not everyday, so the toolbar does not
 * grow a button per niche feature. The button itself is an ordinary
 * `#toolbar button` so it looks like the rest; the popup is a sibling of the
 * toolbar (not a child) because the toolbar is a flat flex row, and it is
 * anchored under it by `#advanced-popup` in style.css.
 *
 * Shared by both providers and the screenshot harness — `webview/main.ts` wires
 * the toggle and dispatches each item's `data-action` through the same handler
 * as a real toolbar button, so an entry here behaves exactly like one.
 */
export const ADVANCED_BUTTON_HTML = `<button data-action="advanced" title="More operations" aria-haspopup="true" aria-expanded="false">${ic("advanced")} Advanced ▾</button>`;

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
export const VIEW_BUTTON_HTML = `<button data-action="viewMenu" title="View options" aria-haspopup="true" aria-expanded="false">${ic("view")} View ▾</button>`;

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
 * copies that could silently drift — see `TOOLBAR_ICONS` for the icon set.
 */
export const TOOLBAR_HTML = `<button data-action="reset" title="Reset camera">${ic("reset")} Reset</button>
        <button data-action="pan" title="Toggle pan mode">${ic("pan")} Pan</button>
        <button data-action="quality" title="Compute mesh quality">${ic("quality")} Quality</button>
        <button data-action="field" title="Visualize field data">${ic("field")} Field</button>
        <button data-action="find" title="Find entity by ID">${ic("find")} Find</button>
        <button data-action="inspect" title="Click a node/element/condition to inspect its data">${ic("inspect")} Inspect</button>
        ${VIEW_BUTTON_HTML}
        ${ADVANCED_BUTTON_HTML}`;

/**
 * The Clip controls — the nav card's **Clip** group content (`webview/main.ts`
 * reparents the provider-rendered `#cut-panel` into the card via
 * `NavControls.addGroup`, matching the reference view-controls bar). Axis
 * presets (X/Y/Z, styled as segments via the hidden-radio recipe) plus a
 * **Free** mode exposing raw normal-vector inputs for an oblique cut, the
 * position slider, Flip, the Off/On toggle and the live position readout.
 * `#cut-free-inputs` stays hidden unless Free is selected (toggled by
 * `webview/main.ts`'s cut-axis change handler); shared like `TOOLBAR_HTML` so
 * the two providers and the screenshot harness can't drift.
 */
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

export const CUT_PANEL_HTML = `<div class="nav-clip-axes">
          <label class="nav-btn nav-step-btn" title="Clip along X"><input type="radio" name="cut-axis" value="0"><span>X</span></label>
          <label class="nav-btn nav-step-btn" title="Clip along Y"><input type="radio" name="cut-axis" value="1"><span>Y</span></label>
          <label class="nav-btn nav-step-btn" title="Clip along Z"><input type="radio" name="cut-axis" value="2" checked><span>Z</span></label>
          <label class="nav-btn nav-step-btn" title="Clip along an arbitrary normal"><input type="radio" name="cut-axis" value="free"><span>Free</span></label>
        </div>
        <span id="cut-free-inputs" class="hidden">
          <input type="number" id="cut-normal-x" value="0" step="0.1" title="Normal X" class="cut-normal-input">
          <input type="number" id="cut-normal-y" value="0" step="0.1" title="Normal Y" class="cut-normal-input">
          <input type="number" id="cut-normal-z" value="1" step="0.1" title="Normal Z" class="cut-normal-input">
        </span>
        <input type="range" id="cut-slider" min="0" max="100" value="50" step="0.5" title="Clip plane position">
        <div class="nav-row">
          <button type="button" id="cut-flip" class="nav-btn nav-step-btn" title="Flip the clipped side">Flip</button>
          <button type="button" id="cut-toggle" class="nav-btn nav-step-btn" title="Toggle clipping">Off</button>
        </div>
        <span id="cut-position"></span>`;

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
 * The left sidebar: five collapsible sections (Information, Layers, Edit,
 * Mesh Modification, Problemtype). `#stats` and `#outline` keep their ids so
 * `renderStats()` and `renderOutline()` fill them unchanged. Collapse wiring
 * lives in `webview/sidebar.ts` (`initSidebarSections`); styling in
 * `webview/style.css` (`.sb-section*`). The Problemtype section starts
 * `hidden` — it is revealed by `webview/problemtype.ts` when the host posts
 * a `ptCatalog` message (any mesh preview: the VTK provider owns a
 * PtController too, converting non-.mdpa sources on Generate).
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
          <div class="edit-controls">
            <button type="button" id="edit-undo" class="edit-ctrl" title="Undo" disabled>${ic("undo")}</button>
            <button type="button" id="edit-redo" class="edit-ctrl" title="Redo" disabled>${ic("redo")}</button>
            <button type="button" id="edit-clear" class="edit-ctrl edit-clear" title="Clear all operations" disabled>Clear</button>
          </div>
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
              <button type="button" id="edit-queue-clear" title="Discard the queue">${ic("close")}</button>
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
      <section class="sb-section" data-section="mesh-mod">
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Mesh Modification
        </button>
        <div class="sb-section-body">
          <div class="sb-subsection collapsed" data-subsection="topology">
            <button type="button" class="sb-subsection-header" aria-expanded="false"><span class="sb-chevron"></span>${ic("catTopology")}<span>Element order &amp; topology</span></button>
            <div class="sb-subsection-body">
              <button type="button" id="mesh-mod-quadratic" class="sb-action" title="Insert mid-edge nodes to make the mesh quadratic">${ic("quadratic")}<span>Convert Linear → Quadratic</span></button>
              <button type="button" id="mesh-mod-linearize" class="sb-action" title="Drop mid-side nodes back to a linear mesh (the inverse of Linear → Quadratic)">${ic("quadratic")}<span>Quadratic → Linear</span></button>
              <div class="edit-form collapsed">
                <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("refine")}<span>Refine (uniform subdivision)</span></button>
                <div class="edit-form-row">
                  <label class="edit-field"><span>levels</span><input type="number" id="refine-levels" class="edit-num" value="1" min="1" max="4" step="1"></label>
                  <button type="button" class="edit-apply" data-op="refine" title="Split every cell into same-type children">${ic("check")}</button>
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
                  <label class="edit-expr-field" title="Per-node target size, evaluated at every node.&#10;Variables: h (nodal size NODAL_H), x y z (coords), mean std min max median q1 q3 iqr (global NODAL_H stats).&#10;Functions: min max clamp abs sqrt sin cos tan exp log pow floor ceil round; constants pi e.&#10;e.g. clamp(0.5*h, mean-1.5*std, mean+1.5*std)">
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
                  <button type="button" id="merge-browse" title="Choose the mesh file(s) to merge in">${ic("open")}</button>
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
                  <label class="edit-field edit-field-grow"><span>surface</span><input type="text" id="sdf-path" class="edit-text" placeholder="Choose a surface mesh…" readonly></label>
                  <button type="button" id="sdf-browse" title="Choose the surface mesh to measure distance to">${ic("open")}</button>
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
                  <button type="button" id="xfer-browse" title="Choose the mesh whose fields are transferred onto this one">${ic("open")}</button>
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
        <button type="button" class="sb-section-header" aria-expanded="true">
          <span class="sb-chevron"></span>Problemtype
        </button>
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
              <button type="button" id="pt-run" class="sb-action" title="Generate the case files and run MainKratos.py in a terminal">${ic("runCase")}<span>Run case</span></button>
              <button type="button" id="pt-open-results" class="sb-action" title="Open the vtk_output results in the VTK preview">${ic("results")}<span>Open results</span></button>
            </div>
            <div id="pt-status" class="pt-status"></div>
          </div>
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
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
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
