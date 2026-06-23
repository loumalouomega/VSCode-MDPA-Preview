# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile        # dev build (includes source maps)
npm run package        # production build (minified, no source maps)
npm run typecheck      # type-check only — never use tsc to emit shipped code
npm test               # compile tests then run with Node's built-in test runner
npm run install-ext    # build + copy into ~/.vscode-server/extensions/ (bash install.sh)
```

**esbuild owns all emit** — `tsc` is only for type-checking and test compilation. Do not run `tsc` to build the extension.

To run a single test file:
```bash
npm run build:tests && node --test out/test/mdpaParser.test.js
```

## Architecture

The extension has two completely separate runtimes that communicate only via `postMessage`:

### Extension host (Node.js, `src/`)
- `extension.ts` — registers the custom editor (`kratos.mdpaPreview`) and three commands.
- `mdpaEditorProvider.ts` — resolves custom editors: parses the document text, serves the webview HTML, and re-parses on change (debounced 250 ms). Tracks the active panel so window-level commands (`resetCamera`, `toggleNodeIds`) can reach it.
- `src/parser/mdpaParser.ts` — tolerant line-oriented state-machine. Uses a `stack: Frame[]` to handle nested `Begin`/`End` blocks. Merges repeated `Begin Elements <Name>` blocks into one `EntityBlock` so split files form a single layer. Emits non-fatal `MdpaDiagnostic` entries rather than throwing.
- `src/parser/geometryMap.ts` — maps Kratos type names (e.g. `Element2D3N`, `Triangle2D3`) to VTK cell type ids. Primary lookup: `(dimension, nodeCount)`; fallback: `(family-word, nodeCount)`. The table mirrors `kratos/input_output/vtk_definition.cpp`.
- `src/parser/types.ts` — the shared data model (`MdpaModel`, `EntityBlock`, `SubModelPart`, etc.). Intentionally free of `vscode` and DOM imports so it can be used in both runtimes and in plain Node tests.

### Webview (browser IIFE, `webview/`)
- `webview/main.ts` — entry point. Owns the VTK.js scene. On receiving a `model` message it calls `buildScene()`, which creates one `vtkActor` layer per `EntityBlock` (visible) and one per `SubModelPart` (hidden by default). Node-id labels are capped at 1 000 nodes.
- `webview/meshBuilder.ts` — converts `MdpaModel` nodes + `Cell[]` into `vtkPolyData`. Handles point clouds (no cell type) as vertex cells.
- `webview/outline.ts` — renders the sidebar tree of checkboxes (toggle layer visibility) and labels (frame/zoom to layer).

### Build outputs
| Path | Contents |
|---|---|
| `dist/extension.js` | Extension host bundle (CJS, Node 18 target) |
| `media/webview.js` | Webview bundle (IIFE, ES2021, browser) |
| `media/style.css` | Copied from `webview/style.css` by esbuild plugin |

`media/` is the only allowed `localResourceRoots` for the webview.

### Message protocol (extension host ↔ webview)

| Direction | `type` | Payload |
|---|---|---|
| host → webview | `model` | `{ model: MdpaModel, fileName: string }` |
| host → webview | `error` | `{ message: string }` |
| host → webview | `resetCamera` | — |
| host → webview | `toggleNodeIds` | — |
| webview → host | `ready` | — (triggers initial parse) |

### Packaging & CI
- `.github/workflows/package.yml` builds a `.vsix` on every `v*` tag push and creates a GitHub Release with it attached. Uses `./node_modules/.bin/vsce` (not `npx vsce`) to ensure the `@vscode/vsce` version from `devDependencies` is used.
- `vscode:prepublish` runs the production esbuild before `vsce package`.
