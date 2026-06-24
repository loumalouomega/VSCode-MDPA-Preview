# Scene Theme Selector — Design Spec
**Date:** 2026-06-24  
**Status:** Approved

## Problem

The VTK.js 3D viewport background and mesh layer palette are fixed at startup. Switching VS Code between dark and light themes does not update the 3D scene. There is no way to force a specific look (e.g. white background for screenshots in papers).

The HTML chrome (sidebar, panels, toolbar) already follows VS Code's theme via CSS variables and needs no changes.

## Goal

Add a theme selector to the toolbar that lets the user switch the 3D scene between four named presets. The choice persists across sessions via `context.globalState`.

## Non-Goals

- Theming the HTML sidebar/panels/toolbar (already handled by VS Code CSS variables).
- Custom color pickers.
- Per-workspace theme overrides (globalState is per-user, which is sufficient).

---

## Architecture

### Data flow

1. On editor open, the extension host reads `context.globalState.get("sceneTheme", "auto")` and injects the value as `data-theme="<name>"` on `<body>` in `getHtml()`.
2. The webview reads `document.body.dataset.theme` before VTK initializes — no flash-of-wrong-theme.
3. The `<select>` in the toolbar is initialized to the same value.
4. On `change`, the webview:
   a. Calls `applyTheme(name)` — sets VTK background, re-colors all layer actors in palette order.
   b. Posts `{ type: "setTheme", theme: name }` to the extension host.
5. The host stores it: `context.globalState.update("sceneTheme", name)`.

### Layer palette index tracking

Each `Layer` object gains a `paletteIndex: number` field (set at creation time, same increment as the current `colorIdx`). `applyTheme()` iterates all layers, skips `quality:highlight` and `find:highlight`, and re-colors each actor using `newPalette[layer.paletteIndex % 8]`. The `layer.color` field is also updated so it stays consistent with subsequent operations (e.g. outline swatches).

### Outline swatch sync

Each `.outline-swatch` DOM element has its `style.background` set to `rgb(r,g,b)` by `renderOutline()`. After `applyTheme()` re-colors the actors, it also queries all `.outline-swatch[data-layer-id]` elements and updates their background to match the new color. `renderOutline()` will be updated to set `data-layer-id` on each swatch so `applyTheme()` can look them up without re-rendering the entire outline.

### Theme-invariant colors

`QUALITY_HIGHLIGHT_COLOR` (red) and `FIND_HIGHLIGHT_COLOR` (yellow) are not affected by theme switching. `applyTheme()` explicitly skips layers whose id is `QUALITY_HIGHLIGHT_ID` or `FIND_HIGHLIGHT_ID`.

---

## Theme Definitions

Four presets defined in a new `webview/themes.ts` module:

| Name | Background | Palette character |
|---|---|---|
| `auto` | Read from VS Code CSS (`--vscode-editor-background`) at load | Bright saturated (same as current) |
| `dark` | `#1e1e1e` | Bright saturated (current `PALETTE`) |
| `light` | `#f0f0f0` | Muted deeper hues, visible on light |
| `scientific` | `#ffffff` | ColorBrewer Set2 — colorblind-safe |

Each preset is typed as:
```ts
interface SceneTheme {
  background: RGB;   // [r, g, b] in 0–1 range
  palette: RGB[];    // 8 colors, same indexing as current PALETTE
}
```

`auto` is special: its background is computed at runtime by parsing the CSS computed style of `document.body`; its palette is identical to `dark`.

### Palettes

**dark / auto** — current PALETTE (bright, saturated, dark-background optimized):
```
[0.26, 0.59, 0.98], [0.96, 0.62, 0.10], [0.20, 0.73, 0.40], [0.91, 0.30, 0.24],
[0.61, 0.35, 0.71], [0.10, 0.74, 0.74], [0.85, 0.65, 0.13], [0.55, 0.55, 0.60]
```

**light** — muted deeper hues, legible on near-white:
```
[0.15, 0.45, 0.80], [0.80, 0.45, 0.05], [0.10, 0.55, 0.25], [0.75, 0.15, 0.10],
[0.45, 0.20, 0.58], [0.05, 0.55, 0.55], [0.65, 0.48, 0.05], [0.38, 0.38, 0.42]
```

**scientific** — ColorBrewer Set2 (colorblind-safe, 8 colors):
```
[0.40, 0.76, 0.65], [0.99, 0.55, 0.38], [0.55, 0.63, 0.80], [0.91, 0.54, 0.76],
[0.65, 0.85, 0.33], [1.00, 0.85, 0.18], [0.90, 0.77, 0.58], [0.70, 0.70, 0.70]
```

---

## UI

A `<select id="theme-select">` is added at the end of `<div id="toolbar">` in the HTML template inside `mdpaEditorProvider.ts`:

```html
<select id="theme-select" title="Scene theme">
  <option value="auto">Auto</option>
  <option value="dark">Dark</option>
  <option value="light">Light</option>
  <option value="scientific">Scientific</option>
</select>
```

One new CSS rule in `webview/style.css` mirrors the existing button appearance:

```css
#toolbar select {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  background: var(--vscode-button-secondaryBackground, rgba(90,93,94,0.31));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: 3px;
  padding: 3px 6px;
  cursor: pointer;
}
```

---

## File Changeset

| File | Nature of change |
|---|---|
| `webview/themes.ts` | **New.** Exports `SceneTheme` interface, four preset objects, and `getTheme(name)` helper. |
| `webview/main.ts` | Read `data-theme` from body at startup; initialize `<select>`; add `applyTheme(name)` that sets VTK background + re-colors layer actors; handle `change` on the select; remove inline `PALETTE` constant (moved to themes.ts). |
| `webview/style.css` | Add `#toolbar select` rule. |
| `src/mdpaEditorProvider.ts` | In `getHtml()`: read `globalState`, inject `data-theme` on `<body>`, add `<select>` to toolbar HTML. In `onDidReceiveMessage`: handle `setTheme` → `globalState.update`. |

No changes to: `extension.ts`, `mdpaParser.ts`, `geometryMap.ts`, `types.ts`, `meshQuality.ts`, `meshBuilder.ts`, `outline.ts`, `qualityPanel.ts`, `package.json`, `esbuild.js`.

---

## Testing

- Manual: open a `.mdpa` file, switch through all four themes, verify background and layer colors update immediately.
- Close and re-open the file; verify the last chosen theme is restored.
- Switch VS Code to light theme while `auto` is selected; verify the background matches (requires reloading the webview since `auto` reads CSS at load time — this is acceptable and matches current behavior).
- Verify quality highlight (red) and find highlight (yellow) are unaffected by theme switching.

No new unit tests required — this is pure presentation logic with no parsing or computation.
