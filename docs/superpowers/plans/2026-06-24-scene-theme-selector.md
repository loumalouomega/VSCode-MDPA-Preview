# Scene Theme Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-preset scene theme selector (Auto / Dark / Light / Scientific) to the toolbar that re-colors the VTK.js background and mesh layer palette, persisting the choice across sessions via VS Code `globalState`.

**Architecture:** A new `webview/themes.ts` file owns all theme data. The webview reads the persisted theme name from a `data-theme` attribute injected on `<body>` by the extension host, applies it at startup, and re-applies it whenever the user changes the `<select>` in the toolbar, posting a `setTheme` message back to the host for persistence. The HTML chrome (sidebar, panels) already follows VS Code's CSS variables and is untouched.

**Tech Stack:** TypeScript, VTK.js (renderer.setBackground), VS Code API (globalState, Webview postMessage), DOM.

## Global Constraints

- Build: `npm run compile` (dev), `npm run typecheck` (type-check only) — never `tsc` to emit.
- esbuild owns all emit; tsc is only for type-checking.
- Webview code lives in `webview/`; extension host code lives in `src/`.
- The only unit-testable code in this project is the parser (`src/parser/`). Webview and host glue is verified with build checks + manual install.
- Theme names are one of: `"auto"`, `"dark"`, `"light"`, `"scientific"`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `webview/themes.ts` | Create | `RGB` type, `SceneTheme` interface, three named theme presets, `getThemePalette(name)`, `getThemeBackground(name)` |
| `webview/main.ts` | Modify | Import `RGB`/helpers from `themes.ts`; add `paletteIndex` to `Layer`; update `addLayer` + call sites; add `currentTheme` state; `applyTheme()`; theme select handler; startup init |
| `webview/outline.ts` | Modify | Set `data-layer-id` on `.outline-swatch` elements so `applyTheme` can update swatch colors without re-rendering the outline |
| `webview/style.css` | Modify | `#toolbar select` rule to match existing button appearance |
| `src/mdpaEditorProvider.ts` | Modify | Pass `savedTheme` to `getHtml`; inject `data-theme` on `<body>`; add `<select>` to toolbar HTML; handle `setTheme` message → `globalState.update` |

---

### Task 1: Create `webview/themes.ts`

**Files:**
- Create: `webview/themes.ts`

**Interfaces:**
- Produces:
  - `RGB = [number, number, number]`
  - `SceneTheme = { background: RGB; palette: RGB[] }`
  - `getThemePalette(name: string): RGB[]` — returns palette for name; falls back to dark for unknown names including `"auto"`
  - `getThemeBackground(name: string): RGB | null` — returns `null` for `"auto"`, concrete RGB for others

- [ ] **Step 1: Create the file**

```typescript
// webview/themes.ts
export type RGB = [number, number, number];

export interface SceneTheme {
  background: RGB;
  palette: RGB[];
}

const DARK_PALETTE: RGB[] = [
  [0.26, 0.59, 0.98],
  [0.96, 0.62, 0.10],
  [0.20, 0.73, 0.40],
  [0.91, 0.30, 0.24],
  [0.61, 0.35, 0.71],
  [0.10, 0.74, 0.74],
  [0.85, 0.65, 0.13],
  [0.55, 0.55, 0.60],
];

const LIGHT_PALETTE: RGB[] = [
  [0.15, 0.45, 0.80],
  [0.80, 0.45, 0.05],
  [0.10, 0.55, 0.25],
  [0.75, 0.15, 0.10],
  [0.45, 0.20, 0.58],
  [0.05, 0.55, 0.55],
  [0.65, 0.48, 0.05],
  [0.38, 0.38, 0.42],
];

const SCIENTIFIC_PALETTE: RGB[] = [
  [0.40, 0.76, 0.65],
  [0.99, 0.55, 0.38],
  [0.55, 0.63, 0.80],
  [0.91, 0.54, 0.76],
  [0.65, 0.85, 0.33],
  [1.00, 0.85, 0.18],
  [0.90, 0.77, 0.58],
  [0.70, 0.70, 0.70],
];

const NAMED_THEMES: Record<string, SceneTheme> = {
  dark:       { background: [0.118, 0.118, 0.118], palette: DARK_PALETTE },
  light:      { background: [0.941, 0.941, 0.941], palette: LIGHT_PALETTE },
  scientific: { background: [1.0,   1.0,   1.0  ], palette: SCIENTIFIC_PALETTE },
};

/** Returns the palette for `name`. Falls back to dark for unknown names including "auto". */
export function getThemePalette(name: string): RGB[] {
  return (NAMED_THEMES[name] ?? NAMED_THEMES.dark).palette;
}

/**
 * Returns the background RGB for `name`, or null for "auto".
 * Callers must call readThemeBackground() themselves when null is returned.
 */
export function getThemeBackground(name: string): RGB | null {
  if (name === "auto") return null;
  return (NAMED_THEMES[name] ?? NAMED_THEMES.dark).background;
}
```

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add webview/themes.ts
git commit -m "feat: add scene theme preset definitions"
```

---

### Task 2: Extend `Layer`, update `addLayer`, tag outline swatches

**Files:**
- Modify: `webview/main.ts`
- Modify: `webview/outline.ts`

**Interfaces:**
- Consumes: `RGB`, `getThemePalette` from `webview/themes.ts`
- Produces (for Task 3):
  - `Layer` now has `paletteIndex: number` (`-1` for special non-palette layers)
  - `addLayer(id, cells, color, visible, paletteIndex?: number): boolean` — `paletteIndex` defaults to `-1`
  - `.outline-swatch[data-layer-id="<layerId>"]` selectable via `document.querySelector`

- [ ] **Step 1: Update `webview/main.ts` — imports, `RGB` removal, `Layer` interface**

At the top of `webview/main.ts`, replace the local `RGB` type and import from `themes.ts`:

Remove this line:
```typescript
type RGB = [number, number, number];
```

Replace the existing `PALETTE` constant:
```typescript
const PALETTE: RGB[] = [
  [0.26, 0.59, 0.98],
  // ...
];
```

With an import at the top of the file (alongside existing imports):
```typescript
import { RGB, getThemePalette, getThemeBackground } from "./themes";
```

Then update the `Layer` interface to add `paletteIndex`:
```typescript
interface Layer {
  id: string;
  actor: any;
  color: RGB;
  paletteIndex: number;
  visible: boolean;
  built: boolean;
  pendingCells?: Cell[];
}
```

- [ ] **Step 2: Update `addLayer` signature and body**

Change the `addLayer` function signature and layer construction line:

```typescript
function addLayer(id: string, cells: Cell[], color: RGB, visible: boolean, paletteIndex = -1): boolean {
  if (!prepared) return false;

  const actor = vtkActor.newInstance();
  const prop = actor.getProperty();
  prop.setColor(color[0], color[1], color[2]);
  prop.setEdgeVisibility(true);
  prop.setEdgeColor(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5);
  prop.setPointSize(6);
  prop.setLineWidth(1.5);
  actor.setVisibility(false);

  const layer: Layer = { id, actor, color, paletteIndex, visible, built: false, pendingCells: cells };

  if (visible) {
    if (!buildLayerGeometry(layer)) return false;
  }

  actor.setVisibility(visible);
  renderer.addActor(actor);
  actors.push(actor);
  layers.set(id, layer);
  return true;
}
```

- [ ] **Step 3: Update `buildScene` — replace `PALETTE[colorIdx]` with `nextColorEntry`**

Inside `buildScene()`, replace the `colorIdx` bookkeeping for blocks. Find this section:

```typescript
let colorIdx = 0;
const blockNodes: OutlineNode[] = [];

for (const block of model.blocks) {
  const color = PALETTE[colorIdx % PALETTE.length];
  colorIdx++;
```

Replace with:

```typescript
let colorIdx = 0;
const palette = getThemePalette(currentTheme);
const nextColorEntry = (): [RGB, number] => {
  const idx = colorIdx++;
  return [palette[idx % palette.length], idx];
};
const blockNodes: OutlineNode[] = [];

for (const block of model.blocks) {
  const [color, paletteIndex] = nextColorEntry();
```

Then update the `addLayer` call for blocks (find `const created = addLayer(id, cells, color, visible);` inside the block loop and add `paletteIndex`):

```typescript
const created = addLayer(id, cells, color, visible, paletteIndex);
```

- [ ] **Step 4: Update `buildPartLayer` to accept and pass `paletteIndex`**

Change the `nextColor` parameter type from `() => RGB` to `() => [RGB, number]`:

```typescript
function buildPartLayer(
  part: SubModelPart,
  elementById: Map<number, Cell>,
  conditionById: Map<number, Cell>,
  geometryById: Map<number, Cell>,
  nextColor: () => [RGB, number]
): OutlineNode {
```

Inside `buildPartLayer`, replace:
```typescript
const color = nextColor();
const id = `smp:${part.path}`;
const created = addLayer(id, cells, color, false);
```

With:
```typescript
const [color, paletteIndex] = nextColor();
const id = `smp:${part.path}`;
const created = addLayer(id, cells, color, false, paletteIndex);
```

Also update the recursive call to `buildPartLayer` inside itself (the `children` map at the bottom):
```typescript
children: part.children.map((child) =>
  buildPartLayer(child, elementById, conditionById, geometryById, nextColor)
),
```
This line is unchanged — `nextColor` is already the right type, just passed through.

Finally, update the call site in `buildScene()`:
```typescript
const partNodes: OutlineNode[] = model.subModelParts.map((p) =>
  buildPartLayer(p, elementById, conditionById, geometryById, nextColorEntry)
);
```

- [ ] **Step 5: Add `data-layer-id` to outline swatches in `webview/outline.ts`**

Inside `buildNode`, find the swatch creation block:

```typescript
if (node.color) {
  const swatch = document.createElement("span");
  swatch.className = "outline-swatch";
  swatch.style.background = rgbToCss(node.color);
  row.appendChild(swatch);
}
```

Replace with:

```typescript
if (node.color) {
  const swatch = document.createElement("span");
  swatch.className = "outline-swatch";
  swatch.style.background = rgbToCss(node.color);
  if (node.layerId) swatch.dataset.layerId = node.layerId;
  row.appendChild(swatch);
}
```

- [ ] **Step 6: Type-check**

```bash
npm run typecheck
```

Expected: no errors. (If you see `currentTheme` is not defined, that's expected — it's added in Task 3. Add a temporary `const currentTheme = "auto";` at module scope just for this check, then remove it before committing.)

- [ ] **Step 7: Commit**

```bash
git add webview/main.ts webview/outline.ts
git commit -m "feat: add paletteIndex to Layer and tag outline swatches for theme sync"
```

---

### Task 3: Add `currentTheme` state, `applyTheme()`, and select handler in `webview/main.ts`

**Files:**
- Modify: `webview/main.ts`

**Interfaces:**
- Consumes: `getThemePalette`, `getThemeBackground` from `webview/themes.ts`; `readThemeBackground()` already exists in `main.ts`
- Produces: `applyTheme(name: string): void` (used by startup init and the select handler)

- [ ] **Step 1: Add `currentTheme` state variable (near the other state variables)**

In the `// --- State ---` section of `main.ts` (around line 113 where `model`, `layers`, etc. are declared), add:

```typescript
let currentTheme: string = document.body.dataset.theme ?? "auto";
```

- [ ] **Step 2: Implement `applyTheme()`**

Add this function after `resetCamera()` (or near the other interaction helpers):

```typescript
function applyTheme(name: string): void {
  currentTheme = name;

  const bg = getThemeBackground(name) ?? readThemeBackground();
  renderer.setBackground(bg[0], bg[1], bg[2]);

  const palette = getThemePalette(name);
  for (const [id, layer] of layers) {
    if (id === QUALITY_HIGHLIGHT_ID || id === FIND_HIGHLIGHT_ID) continue;
    if (layer.paletteIndex < 0) continue;
    const color = palette[layer.paletteIndex % palette.length];
    layer.color = color;
    const prop = layer.actor.getProperty();
    prop.setColor(color[0], color[1], color[2]);
    prop.setEdgeColor(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5);
    const swatch = document.querySelector<HTMLElement>(
      `.outline-swatch[data-layer-id="${CSS.escape(id)}"]`
    );
    if (swatch) {
      swatch.style.background =
        `rgb(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)})`;
    }
  }

  renderWindow.render();
}
```

- [ ] **Step 3: Apply theme at startup**

Immediately after the VTK setup block (after `grw.resize()` / `new ResizeObserver(...)` lines — around line 106–110 in the original), add:

```typescript
applyTheme(currentTheme);
```

This is a no-op for `auto` (re-reads the same CSS color) but corrects the background for `dark`, `light`, and `scientific` before the first render.

- [ ] **Step 4: Wire the theme select**

In the IIFE at the bottom that wires the find-bar controls (around line 581), add another wiring block after it:

```typescript
((): void => {
  const themeSelectEl = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (!themeSelectEl) return;
  themeSelectEl.value = currentTheme;
  themeSelectEl.addEventListener("change", () => {
    const name = themeSelectEl.value;
    applyTheme(name);
    vscode.postMessage({ type: "setTheme", theme: name });
  });
})();
```

- [ ] **Step 5: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add webview/main.ts
git commit -m "feat: implement applyTheme and scene theme select handler"
```

---

### Task 4: Extension host persistence + HTML toolbar + CSS

**Files:**
- Modify: `src/mdpaEditorProvider.ts`
- Modify: `webview/style.css`

**Interfaces:**
- Consumes: `setTheme` message `{ type: "setTheme", theme: string }` from webview
- Produces: `data-theme="<name>"` injected on `<body>`; `<select id="theme-select">` in toolbar HTML; persisted value in `context.globalState`

- [ ] **Step 1: Update `getHtml` signature to accept `savedTheme`**

Change the method signature from:
```typescript
private getHtml(webview: vscode.Webview): string {
```
To:
```typescript
private getHtml(webview: vscode.Webview, savedTheme: string): string {
```

- [ ] **Step 2: Inject `data-theme` on `<body>` and add `<select>` to toolbar**

Inside `getHtml`, change the `<body>` opening tag from:
```html
<body>
```
To:
```html
<body data-theme="${savedTheme}">
```

Inside the toolbar `<div id="toolbar">`, add the select as the last child (after the Find button):
```html
<button data-action="find" title="Find entity by ID">Find</button>
<select id="theme-select" title="Scene theme">
  <option value="auto">Auto</option>
  <option value="dark">Dark</option>
  <option value="light">Light</option>
  <option value="scientific">Scientific</option>
</select>
```

- [ ] **Step 3: Read `globalState` and pass to `getHtml` in `resolveCustomEditor`**

In `resolveCustomEditor`, find the line:
```typescript
webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
```

Replace with:
```typescript
const savedTheme = this.context.globalState.get<string>("sceneTheme", "auto");
webviewPanel.webview.html = this.getHtml(webviewPanel.webview, savedTheme);
```

- [ ] **Step 4: Handle `setTheme` message in `onDidReceiveMessage`**

Find the existing message handler:
```typescript
const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
  if (msg?.type === "ready") {
    void postModel();
  }
});
```

Replace with:
```typescript
const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
  if (msg?.type === "ready") {
    void postModel();
  } else if (msg?.type === "setTheme") {
    void this.context.globalState.update("sceneTheme", msg.theme);
  }
});
```

- [ ] **Step 5: Add `#toolbar select` CSS rule to `webview/style.css`**

Append to `webview/style.css` after the last `#toolbar button:hover` rule (around line 76):

```css
#toolbar select {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  background: var(--vscode-button-secondaryBackground, rgba(90, 93, 94, 0.31));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: 3px;
  padding: 3px 6px;
  cursor: pointer;
}
```

- [ ] **Step 6: Type-check and build**

```bash
npm run typecheck && npm run compile
```

Expected: no errors, build succeeds, `dist/extension.js` and `media/webview.js` updated.

- [ ] **Step 7: Install and manually verify**

```bash
npm run install-ext
```

Then in VS Code (reload window after install):
1. Open `example/bunny_test_mesh.mdpa` — the theme select dropdown appears in the toolbar after the Find button.
2. Select **Light** — background turns near-white, mesh colors deepen. Outline swatches update to match.
3. Select **Scientific** — background turns white, palette switches to ColorBrewer Set2 (muted greens/oranges).
4. Select **Dark** — background turns `#1e1e1e`, palette returns to the original bright set.
5. Select **Auto** — background reads from VS Code's current editor background color.
6. With theme set to Light, close the editor tab and re-open the file — the Light theme is restored (persistence).
7. Open the Quality panel and use "Highlight bad" — red overlay is unaffected by theme changes.
8. Use Find to locate an entity — yellow highlight is unaffected by theme changes.

- [ ] **Step 8: Commit**

```bash
git add src/mdpaEditorProvider.ts webview/style.css
git commit -m "feat: wire scene theme selector to host persistence and toolbar UI"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Four presets: Auto / Dark / Light / Scientific | Task 1 |
| Toolbar `<select>` | Task 4 |
| VTK background updates on theme change | Task 3 (`applyTheme → renderer.setBackground`) |
| Mesh layer palette re-colors on theme change | Task 3 (`applyTheme → prop.setColor`) |
| Outline swatch colors sync | Tasks 2 + 3 |
| `paletteIndex` on `Layer` for stable re-coloring | Task 2 |
| Special layers (quality/find highlights) untouched | Task 3 (explicit skip in `applyTheme`) |
| Persist choice via `globalState` | Task 4 |
| Persist across sessions: inject `data-theme` on `<body>` | Task 4 |
| Read persisted theme at webview startup | Task 3 (`currentTheme = document.body.dataset.theme`) |
| Auto reads VS Code CSS background | Task 3 (`getThemeBackground("auto") ?? readThemeBackground()`) |
| `buildScene` uses current theme's palette for new layers | Task 2 (uses `getThemePalette(currentTheme)`) |

**Placeholder scan:** No TBDs, no "implement later", no vague steps. All code is complete.

**Type consistency:**
- `RGB` defined in `themes.ts`, imported in `main.ts`. `outline.ts` uses compatible inline `[number, number, number]` — no import needed.
- `Layer.paletteIndex` added in Task 2, consumed in Task 3 `applyTheme`.
- `addLayer(... paletteIndex = -1)` defined in Task 2, called with explicit index in Task 2 (`buildScene`/`buildPartLayer`), called without (defaulting to -1) for special layers in existing `setQualityHighlight`/`locateEntity`.
- `getThemePalette`, `getThemeBackground` defined in Task 1, imported and used in Tasks 2–3.
- `"setTheme"` message sent in Task 3, handled in Task 4.
- `data-theme` injected in Task 4, read in Task 3 (`document.body.dataset.theme`).
