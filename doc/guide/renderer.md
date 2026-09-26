# Rendering Backend (Experimental)

The preview draws meshes with **vtk.js**. Version 4.8.0 adds an **experimental** second renderer, **VTK-wasm**: the VTK C++ rendering engine compiled to WebAssembly and shipped inside the extension. It draws the same scene through the same panels, and you can switch between the two with one setting.

vtk.js is and remains the default renderer. VTK-wasm is an **experimental, opt-in** alternative: it draws the same features, with the differences listed below, and it falls back to vtk.js on any host where it cannot start.

## Turning it on

Set **`kratos.preview.renderer`** to `vtkwasm`, in Settings (search for *Kratos renderer*) or in `settings.json`:

```json
{
  "kratos.preview.renderer": "vtkwasm"
}
```

The setting applies to previews opened **after** the change. Close and reopen a preview to switch it. Set it back to `vtkjs` (the default) to return to vtk.js.

## When it falls back to vtk.js

If VTK-wasm cannot start, the preview renders with vtk.js anyway and says why in the status line the first time a mesh is drawn:

| Message | Cause |
|---|---|
| *its runtime is not included in this installation* | A development build made without `npm run vtkwasm:prepare`, or a package built with `KRATOS_VTK_WASM=skip`. |
| *this host lacks WebAssembly JSPI (WebAssembly.Suspending)* | The browser hosting the webview does not support WebAssembly JavaScript Promise Integration. Current VS Code desktop builds do; a code-server session in another browser may not. |
| *WebGL2 is unavailable* | The webview has no WebGL2 context, for example with hardware acceleration disabled. |
| *it failed to start* | The runtime failed to load or compile. The message carries the reason. |
| *it did not start within the time limit* | Start-up took longer than 60 seconds. |

A fallback affects that preview only. Nothing is written back to the setting.

## What is different

Everything the preview offers works with either renderer: layers, opacity, wireframe and edges, fields and their overlays, glyphs, clipping, split views, picking, measuring, selection, screenshots and recordings. The differences are in how some things look:

- **Orientation cube.** The cube is VTK's annotated cube, with its face labels drawn as 3D text rather than textures.
- **Grid axes.** VTK's cube axes label one set of edges on the outer silhouette, with text sized in screen units.
- **Scalar bar.** VTK's scalar bar lays out its labels and title differently from vtk.js's.
- **Picking near edges.** VTK-wasm first picks the exact cell under the pointer and falls back to vtk.js's tolerance only when that misses. A click squarely on a surface therefore always resolves the cell you see, while a click just off an edge or a line is still forgiving.
- **Translucency.** Both renderers use order-independent translucency. Under VTK-wasm a translucent wireframe lying exactly on an opaque surface is hidden by that surface, for example the dimmed mesh under a contour at reduced model opacity. Depth peeling, which would draw it, is not available in WebGL2.

## Security and size

The runtime needs one Content Security Policy (CSP) relaxation, and only when VTK-wasm is selected: `'wasm-unsafe-eval'`, which allows compiling WebAssembly, and `connect-src` scoped to the extension's own files, so the runtime can load its `.wasm`. JavaScript `eval` stays blocked. The upstream JavaScript glue is rewritten at build time so it needs no `eval`, and every build checks the rewritten glue against a pinned checksum. With vtk.js selected, the policy is exactly what it was before.

Shipping the runtime adds about 13 MB to the packaged extension. It is downloaded by commit from Kitware's VTK-wasm distribution and verified file by file, and its licences are reproduced in `media/vtk-wasm/THIRD_PARTY_NOTICES.md`.
