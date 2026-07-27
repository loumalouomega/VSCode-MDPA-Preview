// Builds a standalone webview harness for documentation screenshots.
//
// The real preview runs inside a VS Code webview; this harness loads the exact
// same bundle (media/webview.js + media/style.css) in a plain page, stubs
// acquireVsCodeApi, defines the --vscode-* theme variables (Dark Modern), and
// posts the same messages the extension host would (model / opState /
// ptCatalog / ptCase). The result renders the true UI — vtk.js scene included —
// without VS Code.
//
// Usage (from the repo root):
//   npm run compile && npm run build:tests
//   node scripts/screenshots/build-harness.mjs      # → out/screenshot-harness/
//   node scripts/screenshots/capture.mjs            # → images/problemtype.png
//
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "out", "screenshot-harness");

const { parseMdpaFile } = require(path.join(ROOT, "out", "parser", "mdpaParser"));
const { parseMeshFile } = require(path.join(ROOT, "out", "parser", "meshFileParser"));
const { setElementRadius } = require(path.join(ROOT, "out", "parser", "setElementRadius"));
const { BUILTIN_PROBLEMTYPES } = require(path.join(ROOT, "out", "problemtype", "builtins"));
const { defaultCaseState } = require(path.join(ROOT, "out", "problemtype", "api"));

// SIDEBAR_HTML / FILE_MENU_HTML live in a vscode-free module that isn't part of
// the test build — bundle it on the fly with the repo's esbuild.
async function loadChrome() {
  const esbuild = require(path.join(ROOT, "node_modules", "esbuild"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entry = path.join(OUT_DIR, "chrome-entry.ts");
  fs.writeFileSync(
    entry,
    `export * from "${path.join(ROOT, "src", "webviewChrome").replace(/\\/g, "/")}";
export { TOOLBAR_ICONS } from "${path.join(ROOT, "src", "toolbarIcons").replace(/\\/g, "/")}";`
  );
  const outfile = path.join(OUT_DIR, "webviewChrome.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

/** JSON.stringify replacer tagging typed arrays so the page can revive them. */
function replacer(_key, value) {
  for (const T of [Int32Array, Float32Array, Float64Array, Uint8Array]) {
    if (value instanceof T) return { __ta: T.name, data: Array.from(value) };
  }
  return value;
}

// VS Code Dark Modern values for every --vscode-* variable style.css uses.
const THEME_VARS = `
  --vscode-font-family: system-ui, "Ubuntu", "Droid Sans", sans-serif;
  --vscode-font-size: 13px;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-editor-background: #1f1f1f;
  --vscode-editorWidget-background: #202020;
  --vscode-editorCodeLens-foreground: #999999;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-errorForeground: #f85149;
  --vscode-focusBorder: #0078d4;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-foreground: #cccccc;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-menu-background: #1f1f1f;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-border: #454545;
  --vscode-menu-selectionBackground: #0078d4;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-separatorBackground: #454545;
  --vscode-panel-border: #2b2b2b;
  --vscode-progressBar-background: #0078d4;
  --vscode-progressBar-foreground: #0078d4;
  --vscode-sash-hoverBorder: #0078d4;
  --vscode-textLink-foreground: #4daafc;
  --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { SIDEBAR_HTML, FILE_MENU_HTML, ADVANCED_BUTTON_HTML, ADVANCED_MENU_HTML, TOOLBAR_ICONS } =
    await loadChrome();
  const icon = (id) => `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
  // Same toolbar markup as mdpaEditorProvider.getHtml().
  const TOOLBAR_HTML = `
        <button data-action="reset" title="Reset camera">${icon("reset")} Reset</button>
        <button data-action="pan" title="Toggle pan mode">${icon("pan")} Pan</button>
        <button data-action="cut" title="Toggle clip plane">${icon("cut")} Cut Plane</button>
        <button data-action="wireframe" title="Toggle wireframe">${icon("wireframe")} Wireframe</button>
        <button data-action="nodeIds" title="Toggle node ids">${icon("nodeIds")} Node IDs</button>
        <button data-action="quality" title="Compute mesh quality">${icon("quality")} Quality</button>
        <button data-action="meshSize" title="Mesh size (nodal / element) + box-whisker">${icon("meshSize")} Mesh Size</button>
        ${ADVANCED_BUTTON_HTML}
        <button data-action="field" title="Visualize field data">${icon("field")} Field</button>
        <button data-action="grid" title="Toggle background grid">${icon("grid")} Grid</button>
        <button data-action="find" title="Find entity by ID">${icon("find")} Find</button>
        <button data-action="screenshot" title="Save screenshot as PNG">${icon("screenshot")}</button>
        <select id="theme-select" title="Scene theme">
          <option value="auto">Auto</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="scientific">Scientific</option>
        </select>`;

  // HARNESS_SCENE=spheres swaps in the particle mesh from issue #63, with a
  // radius authored onto it, so the Spheres panel + glyphs can be captured.
  // Anything else keeps the default structural scene.
  const scene = process.env.HARNESS_SCENE ?? "problemtype";
  let model;
  if (scene === "spheres") {
    const particles = await parseMeshFile(
      path.join(ROOT, "src", "test", "fixtures", "exodus", "DCBmodel_PD_solid.e")
    );
    // The real file carries no radius; author one so the shot shows the
    // radius-driven path rather than only the constant fallback. HARNESS_VARY
    // grades it by x so colour-by-radius has something to show.
    // HARNESS_RADIUS=none keeps the file exactly as shipped (no radius at
    // all) — the real issue-#63 case, which exercises the constant fallback.
    model =
      process.env.HARNESS_RADIUS === "none"
        ? particles
        : setElementRadius(particles, 0.13, "absolute").model;
    if (process.env.HARNESS_VARY) {
      const f = model.fields.find((x) => x.variable === "RADIUS");
      const idx = new Map();
      for (let i = 0; i < model.nodeIds.length; i++) idx.set(model.nodeIds[i], i);
      const block = model.blocks.find((b) => b.vtkCellType === 1);
      for (let c = 0; c < block.count; c++) {
        const i = idx.get(block.connectivity[c]);
        const t = (model.coords[i * 3] - model.bounds.min[0]) /
          (model.bounds.max[0] - model.bounds.min[0] || 1);
        f.values[c] = 0.04 + 0.1 * t;
      }
    }
  } else {
    model = await parseMdpaFile(path.join(ROOT, "example", "MDPA", "double_arch.mdpa"));
  }

  // A representative structural case: domain + support + loads + material.
  const structural = BUILTIN_PROBLEMTYPES.find((p) => p.decl.id === "structural");
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts_Parts_Auto1", values: {} },
    {
      conditionId: "displacement",
      smpPath: "DISPLACEMENT_Displacement_Auto1",
      values: { value: [0, 0, 0], constrained: true },
    },
    { conditionId: "selfWeight", smpPath: "Parts_Parts_Auto1", values: {} },
    { conditionId: "surfacePressure", smpPath: "CONTACT_Contact_Auto1", values: { value: 1000 } },
  ];
  state.materials = [
    { smpPath: "Parts_Parts_Auto1", lawId: "linear_elastic_3d", values: {} },
  ];

  const messages = [
    {
      type: "model",
      model,
      fileName: scene === "spheres" ? "DCBmodel_PD_solid.e" : "double_arch.mdpa",
    },
    { type: "opState", ops: [], cursor: 0, canUndo: false, canRedo: false },
    {
      type: "ptCatalog",
      problemtypes: BUILTIN_PROBLEMTYPES.map((p) => ({ decl: p.decl, source: p.source })),
    },
    { type: "ptCase", state },
  ];
  fs.writeFileSync(
    path.join(OUT_DIR, "harness-data.js"),
    `window.HARNESS_MESSAGES = ${JSON.stringify(messages, replacer)};\n`
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>:root { ${THEME_VARS} }</style>
  <link href="../../media/style.css" rel="stylesheet" />
  <title>MDPA Preview harness</title>
  <script>
    // VS Code webview API stub — the harness only renders, it never round-trips.
    function acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
  </script>
</head>
<body data-theme="dark">
  <div id="loading">
    <div id="loading-inner">
      <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
      <div id="loading-label">Reading file…</div>
    </div>
  </div>
  <div id="app" style="display:none">
    ${SIDEBAR_HTML.replace('<aside id="sidebar">', '<aside id="sidebar" style="width:320px">')}
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
    <div id="viewport">
      ${FILE_MENU_HTML}
      <div id="cut-panel" class="hidden">
        <span style="opacity:0.7;font-size:11px">Axis</span>
        <label><input type="radio" name="cut-axis" value="0"> X</label>
        <label><input type="radio" name="cut-axis" value="1"> Y</label>
        <label><input type="radio" name="cut-axis" value="2" checked> Z</label>
        <button id="cut-flip">Flip</button>
        <input type="range" id="cut-slider" min="0" max="100" value="50" step="0.5">
        <span id="cut-position"></span>
      </div>
      <div id="toolbar">${TOOLBAR_HTML}
      </div>
      ${ADVANCED_MENU_HTML}
      <div id="find-bar">
        <select id="find-type"><option>Node</option></select>
        <input id="find-id" type="number" min="1" placeholder="ID" />
        <button id="find-go">Go</button>
        <button id="find-close" title="Close">x</button>
        <span id="find-status"></span>
      </div>
      <div id="render-root"></div>
    </div>
  </div>
  <script src="../../media/webview.js"></script>
  <script src="./harness-data.js"></script>
  <script>
    (function () {
      function revive(value) {
        if (value && typeof value === "object") {
          if (value.__ta) return new self[value.__ta](value.data);
          if (Array.isArray(value)) return value.map(revive);
          const out = {};
          for (const key of Object.keys(value)) out[key] = revive(value[key]);
          return out;
        }
        return value;
      }
      for (const msg of window.HARNESS_MESSAGES) window.postMessage(revive(msg), "*");
    })();
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);
  console.log(`Harness written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
