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
const { smoothModel } = require(path.join(ROOT, "out", "parser", "smoothMesh"));
const { reorderModel } = require(path.join(ROOT, "out", "parser", "reorderMesh"));
const { partitionModel } = require(path.join(ROOT, "out", "parser", "partitionMesh"));
const { refineModel } = require(path.join(ROOT, "out", "parser", "refineMesh"));
const { simplexifyModel } = require(path.join(ROOT, "out", "parser", "simplexify"));
const { cropModel } = require(path.join(ROOT, "out", "parser", "cropMesh"));
const { fieldCalcModel, averageField } = require(path.join(ROOT, "out", "parser", "fieldCalc"));
const { mergeManyModels } = require(path.join(ROOT, "out", "parser", "mergeMesh"));
const { renumberModel } = require(path.join(ROOT, "out", "parser", "renumberMesh"));
const { linearToQuadratic } = require(path.join(ROOT, "out", "parser", "linearToQuadratic"));
const { linearize } = require(path.join(ROOT, "out", "parser", "linearize"));
const { translateCoords } = require(path.join(ROOT, "out", "parser", "transformCoords"));
const { hessianFieldModel } = require(path.join(ROOT, "out", "parser", "hessianField"));
const { estimateErrorModel } = require(path.join(ROOT, "out", "parser", "errorEstimate"));
const { sdfFieldModel } = require(path.join(ROOT, "out", "parser", "sdfField"));
const { transferFieldModel } = require(path.join(ROOT, "out", "parser", "transferField"));
const { hexGrid, jitteredPlane, sideBySide, boxSurface } = await import("./opFixtures.mjs");

/**
 * One scene per "additional mesh operation", for the per-operation
 * documentation screenshots (capture-op.mjs). Each returns the model the shot
 * should render plus the op-history label to show in the Edit section.
 *
 * Where the effect is geometric it is staged as a **before/after pair** in one
 * view (sideBySide) — a lone "after" of, say, a smoothed sheet is just a flat
 * sheet and demonstrates nothing. Where the effect is a new FIELD (partition,
 * fieldCalc, averageField) the single result is right, and capture-op.mjs
 * opens the Field panel on that variable instead.
 */
async function buildOpScene(op) {
  switch (op) {
    case "smooth": {
      const before = jitteredPlane(14, 14, 1, 0.45);
      const after = (await smoothModel(before, { method: "taubin", iterations: 20 })).model;
      return { model: sideBySide(before, after), label: "Smooth" };
    }
    case "reorder": {
      // Small enough that the node-id labels capture-op.mjs turns on stay legible.
      const before = hexGrid(3, 3, 1);
      const after = (await reorderModel(before, "rcm")).model;
      return { model: after, label: "Reorder nodes" };
    }
    case "partition": {
      const model = hexGrid(6, 6, 3);
      return { model: (await partitionModel(model, { nparts: 4 })).model, label: "Partition" };
    }
    case "refine": {
      const before = hexGrid(2, 2, 2);
      return { model: sideBySide(before, refineModel(before, 1).model), label: "Refine" };
    }
    case "linearize": {
      // Start linear, raise to quadratic, then drop back — the pair shows the
      // mid-side nodes the operation removes.
      const quadratic = linearToQuadratic(hexGrid(2, 2, 2)).model;
      return {
        model: sideBySide(quadratic, linearize(quadratic).model),
        label: "Quadratic → Linear",
      };
    }
    case "simplexify": {
      const before = hexGrid(2, 2, 2);
      return { model: sideBySide(before, simplexifyModel(before).model), label: "Simplexify" };
    }
    case "crop": {
      // Literal bounds (not derived from the model) so capture-op.mjs can put
      // the very same numbers into the Crop form — the shot has to show the
      // parameters that produced the result standing next to it.
      return {
        model: cropModel(hexGrid(8, 8, 4), {
          kind: "bbox",
          lo: [-1, -1, -1],
          hi: [4.5, 8.5, 5],
          mode: "all",
        }).model,
        label: "Crop",
      };
    }
    case "fieldCalc": {
      const model = hexGrid(8, 8, 4);
      return {
        model: fieldCalcModel(model, {
          expr: "sqrt(x^2 + y^2 + z^2)",
          location: "Nodal",
          output: "RADIAL_DISTANCE",
        }).model,
        label: "Field calculator",
      };
    }
    case "averageField": {
      // A nodal field first, then averaged onto the elements — the elemental
      // result is what the shot colours by.
      const nodal = fieldCalcModel(hexGrid(8, 8, 4), {
        expr: "sqrt(x^2 + y^2 + z^2)",
        location: "Nodal",
        output: "RADIAL_DISTANCE",
      }).model;
      return {
        model: averageField(nodal, {
          variable: "RADIAL_DISTANCE",
          direction: "nodalToElemental",
          target: "Elements",
        }).model,
        label: "Average field",
      };
    }
    case "fieldHessian": {
      // A quadratic field, because a LINEAR one has an exactly zero Hessian —
      // a correct result that would render as a uniform block and show nothing.
      const nodal = fieldCalcModel(hexGrid(8, 8, 4), {
        expr: "x^2 + 0.5*y^2",
        location: "Nodal",
        output: "TEMP",
      }).model;
      return {
        model: (await hessianFieldModel(nodal, { variable: "TEMP" })).model,
        label: "Field Hessian (second derivative)",
      };
    }
    case "estimateError": {
      // Same reasoning: a field the mesh represents exactly has zero error, so
      // the scene needs curvature for the indicator to have anything to show.
      const nodal = fieldCalcModel(hexGrid(8, 8, 4), {
        expr: "sin(x) * cos(y)",
        location: "Nodal",
        output: "TEMP",
      }).model;
      return {
        model: (
          await estimateErrorModel(nodal, {
            variable: "TEMP",
            marking: "fraction",
            markingValue: 0.3,
          })
        ).model,
        label: "Error estimate (Zienkiewicz-Zhu)",
      };
    }
    case "sdfDistance": {
      // A sphere-ish closed surface cutting through the block, so the field has
      // both signs — the whole point of a SIGNED distance.
      const model = hexGrid(10, 10, 6);
      return {
        model: (await sdfFieldModel(model, boxSurface(4.5, 4.5, 2.5, 2.6))).model,
        label: "Signed distance to a surface",
      };
    }
    case "transferField": {
      // Source and target are DIFFERENT discretizations, which is the case the
      // operation exists for — transferring between identical meshes would
      // demonstrate nothing.
      const source = fieldCalcModel(hexGrid(12, 12, 6, 0.66), {
        expr: "sqrt(x^2 + y^2 + z^2)",
        location: "Elemental",
        output: "DENSITY",
      }).model;
      const target = hexGrid(6, 6, 3, 1.32);
      return {
        model: (await transferFieldModel(target, source, {})).model,
        label: "Transfer fields from another mesh",
      };
    }
    case "mergeMesh": {
      // Two sources in ONE operation, which is what the op does now — each
      // lands as its own SubModelPart, so the outline shows them apart.
      const base = hexGrid(4, 4, 2);
      const beam = translateCoords(hexGrid(3, 3, 2), 5.5, 1, 0);
      const column = translateCoords(hexGrid(2, 2, 4), 10.5, 1, 0);
      return {
        model: mergeManyModels(base, [
          { model: beam, name: "beam" },
          { model: column, name: "column" },
        ]).model,
        label: "Merge mesh",
      };
    }
    case "renumber": {
      // Crop first so the surviving ids are genuinely gappy — a renumber of an
      // already-consecutive mesh is a noop and shows nothing.
      const cropped = cropModel(hexGrid(6, 6, 2), {
        kind: "bbox",
        lo: [2.5, -1, -1],
        hi: [99, 99, 99],
        mode: "all",
      }).model;
      return {
        model: renumberModel(cropped, { target: "all" }).model,
        label: "Renumber (compact ids)",
      };
    }
    default:
      throw new Error(`Unknown HARNESS_OP "${op}"`);
  }
}

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

// VS Code Dark Modern values for every --vscode-* variable style.css and
// design-system.css use.
const THEME_VARS = `
  --vscode-sideBar-background: #181818;
  --vscode-sideBar-border: #2b2b2b;
  --vscode-sideBarSectionHeader-foreground: #cccccc;
  --vscode-editorWidget-border: #454545;
  --vscode-editorGroupHeader-tabsBackground: #181818;
  --vscode-inputValidation-infoBackground: #063b49;
  --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
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
  const { SIDEBAR_HTML, MENUBAR_HTML, ADVANCED_MENU_HTML, VIEW_MENU_HTML, TOOLBAR_HTML, CUT_PANEL_HTML } = await loadChrome();

  // HARNESS_SCENE=spheres swaps in the particle mesh from issue #63, with a
  // radius authored onto it, so the Spheres panel + glyphs can be captured.
  // Anything else keeps the default structural scene.
  const scene = process.env.HARNESS_SCENE ?? "problemtype";
  let model;
  // HARNESS_SCENE=op + HARNESS_OP=<name> builds a synthetic before/after (or
  // field-carrying) scene for one of the additional mesh operations — see
  // buildOpScene above and capture-op.mjs.
  let opLabel;
  if (scene === "op") {
    const built = await buildOpScene(process.env.HARNESS_OP ?? "");
    model = built.model;
    opLabel = built.label;
  } else if (scene === "spheres") {
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

  const fileName =
    scene === "op"
      ? "example.mdpa"
      : scene === "spheres"
        ? "DCBmodel_PD_solid.e"
        : "double_arch.mdpa";
  // An op scene shows the operation already applied, so the Edit history lists
  // it — the same state the user would be looking at right after clicking Apply.
  const opState = opLabel
    ? { type: "opState", ops: [{ op: process.env.HARNESS_OP, label: opLabel }], cursor: 1, canUndo: true, canRedo: false }
    : { type: "opState", ops: [], cursor: 0, canUndo: false, canRedo: false };

  const messages = [
    { type: "model", model, fileName },
    opState,
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
  <link href="../../media/design-system.css" rel="stylesheet" />
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
    ${MENUBAR_HTML}
    <div id="main">
    ${SIDEBAR_HTML.replace('<aside id="sidebar">', '<aside id="sidebar" style="width:320px">')}
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
    <div id="viewport">
      <div id="cut-panel" class="hidden">${CUT_PANEL_HTML}
      </div>
      <div id="toolbar">${TOOLBAR_HTML}
      </div>
      ${VIEW_MENU_HTML}
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
