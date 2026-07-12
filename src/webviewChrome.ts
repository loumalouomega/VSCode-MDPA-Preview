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
 * Open / Save / Save As, an Export list (one item per exportable format) and
 * the Problem (zip) group (Save problem… / Load problem… archive the mesh +
 * edit recipe + case + generated files as one zip).
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
          <div class="file-menu-sep"></div>
          <div class="file-menu-group-label">${ic("problemtype")}<span>Problem (zip)</span></div>
          <button type="button" class="file-menu-item file-menu-sub" data-menu="saveProblem" role="menuitem">${ic("save")}<span>Save problem…</span></button>
          <button type="button" class="file-menu-item file-menu-sub" data-menu="loadProblem" role="menuitem">${ic("open")}<span>Load problem…</span></button>
        </div>
      </div>`;

/**
 * The left sidebar: five collapsible sections (Information, Layers, Edit,
 * Mesh Modification, Problemtype). `#stats` and `#outline` keep their ids so
 * `renderStats()` and `renderOutline()` fill them unchanged. Collapse wiring
 * lives in `webview/sidebar.ts` (`initSidebarSections`); styling in
 * `webview/style.css` (`.sb-section*`). The Problemtype section starts
 * `hidden` — it only applies to MDPA previews, so it is revealed by
 * `webview/problemtype.ts` when the host posts a `ptCatalog` message.
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
          <button type="button" id="mesh-mod-quadratic" class="sb-action" title="Insert mid-edge nodes to make the mesh quadratic">${ic("quadratic")}<span>Convert Linear → Quadratic</span></button>
          <div class="edit-form collapsed">
            <button type="button" class="edit-form-title"><span class="sb-chevron"></span>${ic("remesh")}<span>Remesh (MMG)</span></button>
            <div class="edit-form-row">
              <label class="edit-field"><span>mode</span><select id="remesh-mode" class="edit-sel edit-sel-mid">
                <option value="factor" selected>size ×</option>
                <option value="hsiz">uniform</option>
                <option value="optimize">optimize</option>
              </select></label>
              <label class="edit-field"><span id="remesh-value-label">factor</span><input type="number" id="remesh-value" class="edit-num edit-num-wide" value="0.5" step="0.1"></label>
              <button type="button" class="edit-apply edit-apply-mmg" data-op="remesh" title="Run the MMG remesher"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
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
              <button type="button" class="edit-apply edit-apply-mmg" data-op="levelset" title="Discretize the isovalue as a mesh boundary"><span class="apply-play">${ic("play")}</span><span class="apply-stop">${ic("stop")}</span></button>
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
