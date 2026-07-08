---
name: verify
description: Drive this VS Code extension end-to-end in headless code-server + Playwright to verify preview changes at the real UI surface
---

# Verifying the extension end-to-end (headless)

The runtime surface is a VS Code custom editor + webview. Verify by installing
the packaged extension into **code-server** and driving it with
**playwright-core** against the cached Chromium.

## Recipe (all steps confirmed working)

1. **Package the .vsix** — the repo's Node 18 breaks `vsce` (undici needs the
   `File` global). Use the VS Code server's bundled Node 24 instead:
   ```bash
   ~/.vscode-server/cli/servers/Stable-*/server/node \
     ./node_modules/@vscode/vsce/vsce package -o /tmp/ext.vsix
   ```
   Pass `--no-dependencies` (the repo's `.vscodeignore` + that flag keep the
   package at ~250 KB / 11 files).
2. **Install + launch code-server** (`/usr/bin/code-server`):
   - **Must unset `VSCODE_IPC_HOOK_CLI`** — otherwise code-server silently
     opens the folder in the existing VS Code instance and exits 0.
   - Keep auth enabled (random `PASSWORD` env), bind 127.0.0.1 only.
   ```bash
   code-server --install-extension /tmp/ext.vsix --force
   env -u VSCODE_IPC_HOOK_CLI PASSWORD=<random> \
     code-server --bind-addr 127.0.0.1:8199 --disable-workspace-trust <samples-dir>
   ```
   Run unsandboxed (the sandbox kills the listener) and in the background.
3. **Drive with playwright-core** (npm-install it in a scratch dir; browser at
   `~/.cache/ms-playwright/chromium-*/chrome-linux/chrome`, launch args
   `--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader` — WebGL
   works, the vtk.js scene really renders):
   - Login page: fill `input[type=password]`, Enter, wait for
     `.monaco-workbench`, then ~6 s settle.
   - Open a file: `Ctrl+P` → type name → Enter; then `F1` → `>Open VTK
     Preview` → Enter (works for binary files too via the tab-URI fallback).
   - The webview lives in a nested iframe: scan `page.frames()` for `#stats`
     (sidebar stats), `#outline` (layer checkboxes), `#timeline-bar`.
     Read `#stats` innerText for node/element counts; screenshot the page.

## Gotchas

- Volume-only meshes (pure tet/hex blocks) open with the mesh layer
  **unchecked by default** (intended: surfaces/lines visible, volumes hidden)
  — an empty viewport is not a parse failure; check `#stats` and toggle the
  layer checkbox.
- First frame keeps the default camera; click the nav panel's **Fit** button
  before judging a screenshot.
- Sample meshes for every supported format can be generated with a small
  Node script (see `example/` for committed ones covering all formats).
