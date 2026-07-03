# Development

The extension is written in TypeScript and bundled with
[esbuild](https://esbuild.github.io/). It has two completely separate runtimes
— the **extension host** (Node.js, `src/`) and the **webview** (browser IIFE,
`webview/`) — that communicate only via `postMessage`.

## Build & test

Clone the [repository](https://github.com/loumalouomega/VSCode-MDPA-Preview)
and install dependencies with `npm install`, then:

```bash
npm run compile      # dev build — bundle extension (dist/) and webview (media/)
npm run watch        # rebuild on change
npm run package      # production build (minified, no source maps)
npm test             # parser unit tests (node:test) against repo fixtures
npm run typecheck    # tsc --noEmit
```

::: warning esbuild owns all emit
`tsc` is only for type-checking and test compilation. Do **not** run `tsc` to
build the extension.
:::

Press **F5** in VS Code to launch an Extension Development Host, then open any
`.mdpa` file (for example the fixtures under `example/`).

To run a single test file:

```bash
npm run build:tests && node --test out/test/mdpaParser.test.js
```

## Source layout

| Path | Purpose |
|------|---------|
| `src/extension.ts` | Activation, command + custom-editor registration |
| `src/mdpaEditorProvider.ts` | Custom editor for `.mdpa`: parses the document, hosts the webview |
| `src/vtkEditorProvider.ts` | Custom editor for `.vtk`: discovers sibling files, manages timeline, merges subparts |
| `src/parser/` | `mdpaParser`, `vtkLegacyParser` (ASCII VTK → `MdpaModel`), `vtkFileGroup` (filename grammar → timeline tree), `geometryMap`, `meshQuality`, `isoSurface`, `types` |
| `webview/` | `main.ts` (VTK scene), `meshBuilder.ts`, `outline.ts`, `timeline.ts` (VTK playback bar), `qualityPanel.ts`, `fieldPanel.ts`, `fieldData.ts`, `fieldRender.ts`, `quiver.ts`, `colormaps.ts`, `orientationCube.ts` (cube + axis arrows), `navControls.ts` (orbit/pan/zoom/fit/center panel), `gridAxes.ts`, `style.css` |
| `syntaxes/` | TextMate grammar for highlighting |

The Kratos type name → VTK cell-type table mirrors the core
`kratos/input_output/vtk_definition.cpp` and
`kratos/sources/kratos_application.cpp`.

## Build outputs

| Path | Contents |
|------|----------|
| `dist/extension.js` | Extension host bundle (CJS, Node 18 target) |
| `media/webview.js` | Webview bundle (IIFE, ES2021, browser) |
| `media/style.css` | Copied from `webview/style.css` by an esbuild plugin |

`media/` is the only allowed `localResourceRoots` for the webview.

## Contributing

Issues and pull requests are welcome on
[GitHub](https://github.com/loumalouomega/VSCode-MDPA-Preview). The extension is
released under the [MIT License](https://github.com/loumalouomega/VSCode-MDPA-Preview/blob/master/LICENSE).
