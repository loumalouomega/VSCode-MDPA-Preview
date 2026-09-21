# Shared UI design system (CAD-Preview ↔ MDPA-Preview ↔ KKSS)

The written, canonical description of "the look" shared by the Kratos preview family: extracted from CAD-Preview (the visual reference) and extended where MDPA-Preview has surfaces CAD-Preview lacks. Materialised as [`webview/design-system.css`](https://github.com/loumalouomega/VSCode-MDPA-Preview/blob/master/webview/design-system.css) — a static, dependency-free stylesheet + token file written so CAD-Preview and KKSS can adopt the identical file verbatim.

## Principles

1. **VS Code theme tokens are the only colour source.** Every colour is `var(--vscode-*, <dark-fallback>)`; hardcoded hex appears only as the fallback, plus the handful of scene-side constants CAD-Preview already hardcodes (orientation-cube faces, axis arrows, quality band colours).
2. **Borders, not shadows.** Floating surfaces are `editorWidget-background` + a 1 px `editorWidget-border`. The *only* box-shadow in the system belongs to dropdown menus.
3. **No decorative motion.** Hover/active states switch instantly. Exactly two animations are permitted, both of them status rather than ornament: the indeterminate progress sweep, and the mark on a **full-screen loading overlay** — allowed because a blocking screen is a state, not chrome, and because when the host cannot report a total there is otherwise nothing on screen saying the extension is alive. Overlay motion must be *slow, single-axis and linear* (MDPA-Preview turns its logo once every three seconds) so it reads as working rather than as decoration, and must be disabled under `prefers-reduced-motion: reduce` — as must any motion added later.
4. **`font: inherit` on every control** so buttons/inputs/selects never fall back to the browser default font.
5. **Two active-state idioms, never mixed** (documented in CAD-Preview's stylesheet):
   - **mode-on** ("this mode is enabled"): `inputValidation-infoBackground` + 1 px `focusBorder` outline. Used for toggles: Pan, Wireframe, Clip, Find, Inspect, Grid, Ortho, menu triggers with a live mode.
   - **selected-1-of-N** ("this option is the current one"): plain primary `button-background` fill. Used for segments: rotate steps, clip axes, field modes, display modes, tabs.

## Tokens (`design-system.css` `:root`)

| Token | Value | Role |
|---|---|---|
| `--ds-font` | `var(--vscode-font-family, sans-serif)` | the one font stack |
| `--ds-font-size-xs/sm/md/lg/xl` | 9 / 10 / 11 / 12 / 13 px | the whole type scale; weight is default or **600**, never 700 |
| `--ds-radius-sm/-/md/menu/card` | 2 / 3 / 4 / 5 / 6 px | 3 px is the default for every button/input/select; 5 px = dropdown panels; 6 px = the nav card |
| `--ds-fg` / `--ds-bg` | `foreground` / `editor-background` | base text/canvas |
| `--ds-widget-bg` / `--ds-widget-border` | `editorWidget-background` / `editorWidget-border` | floating surfaces (nav card, status pill, panels) |
| `--ds-sidebar-bg` / `--ds-sidebar-border` / `--ds-section-header-fg` | `sideBar-background` / `sideBar-border` / `sideBarSectionHeader-foreground` | the sidebar column |
| `--ds-primary` / `--ds-primary-fg` / `--ds-primary-hover` | `button-background` / `button-foreground` / `button-hoverBackground` | primary buttons, selected-1-of-N |
| `--ds-secondary` / `--ds-secondary-fg` / `--ds-secondary-hover` | `button-secondary*` | secondary buttons, unselected segments |
| `--ds-mode-on-bg` / `--ds-focus` | `inputValidation-infoBackground` / `focusBorder` | the mode-on idiom |
| `--ds-input-bg` / `--ds-input-border` / `--ds-input-fg` | `input-*` | text/number inputs, selects; focus = border-color swap, no outline ring |
| `--ds-menu-bg` / `--ds-menu-border` / `--ds-menu-fg` / `--ds-menu-sel-bg` / `--ds-menu-sel-fg` | `menu-*` | dropdown panels and item hover |
| `--ds-hover` / `--ds-toolbar-hover` / `--ds-list-sel-bg` / `--ds-list-sel-fg` | `list-hoverBackground` / `toolbar-hoverBackground` / `list-activeSelection*` | rows, ghost buttons, tree selection |
| `--ds-track` / `--ds-thumb` | `scrollbarSlider-background` / `progressBar-background` | the slider recipe |
| `--ds-error` / `--ds-warning` | `errorForeground` / `editorWarning-foreground` | inline errors / warnings |
| `--ds-shadow-menu` | `0 2px 8px rgba(0, 0, 0, 0.36)` | dropdowns only |
| `--ds-header-bg` / `--ds-header-border` | `editorGroupHeader-tabsBackground` / `editorWidget-border` | the 34 px menubar strip and the 24 px status bar |

## Component recipes

- **Menubar**: in-flow, full-width, 34 px, `--ds-header-bg`, 1 px bottom `--ds-header-border`, 13 px. The File trigger is CAD's **bordered pill** (`glyph("home")` · label · `glyph("chevronDown")`, 1 px `--ds-widget-border`, radius 5, `padding: 3px 10px`). Right-aligned (`margin-left: auto`, never `space-between`, which would re-centre the pill when the chip appears) is the **document chip** `#doc-chip`: an unsaved dot (`.ui-dot`) · file name · format badge (`.ui-badge`, the router's extension — `mdpa`, `post.msh`) · "N unsaved edits" (mono, muted). It ships `hidden` and is filled by the `documentInfo` host→webview message (`src/documentInfo.ts`), posted by both providers on `ready` and whenever the op list or save point moves, de-duplicated by serialisation. **Dirty is not VS Code's tab dot**: the dot is a one-way latch cleared only by a save or revert, while the chip counts the operations that differ from what the source file holds (`unsavedEditCount`, by record identity) — undoing back to the save point clears it at once, undoing past it counts what the file has and the view lacks.
- **Status bar**: `#statusbar`, the last child of `#app` after `#main` (so the viewport, timeline bar, nav card and toast all rise by layout, not arithmetic). 24 px (`--ui-statusbar-h`), 10 px muted text on `--ds-header-bg`, 1 px top border. Cells left→right: `#engine-status` (a dot with `data-tone` idle/loading/ready + text, exactly as wide as the sidebar via `--side-width`, which `sidebarResize.ts` keeps current), `#sb-count-model` ("12,345 nodes · 6,789 elements · 42 conditions", zero kinds omitted), `#sb-count-frame` ("frame 3 / 12 · step 0.25", only for multi-frame data), and a right-aligned `#sb-cursor` (the last **Inspect** pick, "element 45 · Triangle2D3 · node 123 (x, y, z)"; empty while the Inspect panel is closed). Every fact cell ships `hidden` and shows only when it has text; wording is pure (`src/statusStats.ts`, en-US digit grouping, facts never verdicts).
- **Engine status** (`engineActivity.ts` → `engineStatus` message → `#engine-status`): idle → loading → ready per engine, INFERRED from calls exactly like CAD's kernel status. Real signals only: `loadMeshio()` (meshio++), the MMG runner call in `operations.ts` (remesh / level-set, worker or in-process) and Pyodide's memoised init. "Ready" means "a call has succeeded this session", not "an instance is resident" — meshio++ is a fresh instance per call and each MMG run is its own worker. Engines nothing signals are left out (the Flowgraph editor is a forked process, not WASM), so a plain `.mdpa` open reads "Engines idle".
- **Toolbar button**: primary fill, radius 3, `padding: 4px 10px`, icon (1 em `currentColor` SVG) + label; hover `--ds-primary-hover`; mode-on idiom when it owns a live mode.
- **Dropdown panel**: `min-width: 200px`, radius **5**, `--ds-menu-bg` + 1 px `--ds-menu-border`, `--ds-shadow-menu`, `padding: 4px`; items radius 3, `padding: 6px 12px`, `gap: 8px`, hover `--ds-menu-sel-bg`/`-fg`; separators 1 px `margin: 4px 6px`; checkable items reserve a `✓` column (`::before`, `width: 1em`, opacity 0 → 1). One wiring: opening a menu closes the others, Escape closes all, clicks inside don't dismiss, one-shot items close themselves.
- **Sidebar**: `--ds-sidebar-bg`, right border `--ds-sidebar-border`; section headers 11 px / 600 / uppercase / `letter-spacing: 0.05em` / `--ds-section-header-fg`, hairline separators. Section header = a chevron **button** (`.panel-chevron`, one `chevronDown` glyph rotated off `aria-expanded`) · a 22 px `.panel-icon` tile · `.panel-title` · optional 24 px `.panel-icon-btn` actions; a collapsed header drops its bottom border. The sections that edit the model stay top-level; read-only ones sit in one collapsed `#advanced-group` card with an `n of m` badge. Default width 272 px, resizable.
- **Tree/list row**: 22–24 px tall; hover `--ds-hover`; selection `--ds-list-sel-bg`/`-fg`; chevron 10 px opacity 0.7; count badge 10 px opacity 0.55; row action buttons are ghost (18×18, `line-height: 1`, opacity ~0.5 rest → 1 + `--ds-toolbar-hover` on hover).
- **Form row**: label column 72 px / 10 px / opacity 0.7; control `font: inherit`, `--ds-input-bg` + 1 px `--ds-input-border`, radius 3, `padding: 1px 3px`; focus = `border-color: --ds-focus`, `outline: none`. Inline-editable fields are invisible until hover/focus (transparent border → input border → focus border).
- **Slider**: `appearance: none`; track 3 px, radius 2, `--ds-track`; thumb 12 px round `--ds-thumb`; disabled thumb falls back to the track colour. (Webkit-only — VS Code webviews and Electron are Chromium.)
- **Floating panel** *(MDPA extension — CAD has no floating panels)*: `--ds-widget-bg` (falls back to editor background) + 1 px border, radius 4, `padding: 10px 12px`, **no shadow**; header = sidebar section-header typography + a ghost close button (the `close` SVG at 1 em, 13 px font-size, opacity 0.7 → 1).
- **Toast** (`#message`, was the "status pill"): CAD's `#status` — bottom-centre over the canvas (`left: 50%` of `#vtk-sub`), radius 8, `--ui-elev-2`, `--ds-widget-bg` + 1 px border, `padding: 6px 12px`, 12 px; `.error` recolors to `--ds-error`. Lifted clear of the nav card (`bottom: var(--nav-bottom) + 144px`, `--nav-bottom` being what `syncNavOffset()` sets for the card, which itself clears the 36 px timeline bar). Inline feedback beats toasts whenever the webview owns the flow.
- **Progress**: indeterminate sweep on a 2–3 px track (`--ds-track` base, `--ds-thumb` bar); cancellable runs pair it with a play→stop button swap (MDPA extension).
- **Nav card**: bottom-center, radius 6, `--ds-widget-bg` + border, `padding: 8px 14px`; collapse chevron `⌄`/`⌃` (ghost, 13 px); groups are vertical stacks captioned 10 px / 600 / uppercase / `letter-spacing: 0.06em` / opacity 0.7; D-pads are 3×3 grids of **24 px** secondary-filled cells; active step segment = selected-1-of-N idiom.

## Layout rules

- Orientation cube: **top-left**, ~96 px, 10 px margin. Uniform blue faces `#2b6cb0`, border `#1a4a7a`, bold white labels RIGHT/LEFT/TOP/BOTTOM/FRONT/BACK; axis arrows X `#ff3653`, Y `#8adb00`, Z `#2c8fff`.
- Nav controls: bottom-center. Toolbar: top-right. Toast: bottom-center, above the nav card. Status bar: full width, below everything. The 36 px timeline bar sits at the bottom of the viewport, i.e. directly above the status bar.
- Sidebar: left column; viewport fills the rest. The resize sash is invisible (6 px hit area over the sidebar's border) and shows a hover/focus border.
- z-ladder (low→high): canvas overlays (5) → floating bars/pills (10–12) → toolbar (15) → menubar (20) → floating panels (20–22) → dropdowns (30) → loading overlay (100).

## Interaction vocabulary (glossary)

Canonical verbs, with MDPA's current names mapped:

| Canonical | CAD-Preview | MDPA-Preview today | Notes |
|---|---|---|---|
| `Fit` | Fit | Fit | reframe in place |
| `Ctr` | Ctr | Ctr | re-center focal point |
| `Clip` | Clip | **Cut Plane** | rename pending Tier-1 approval |
| `Ortho` / `Persp` | Persp↔Ortho toggle | Parallel Projection menu check | adopt the flip-label toggle |
| `Export…` | Export… | Export as ▸ (inline formats) | MDPA keeps the inline format list (36 formats) |
| `Save/Load Preprocess…` | Save/Load Preprocess… | Save/Load problem… | MDPA keeps "problem" (Kratos domain term, shipped `.kratosproblem.zip` format) |
| `BACK` | BACK | **REAR** | cube face; rename pending Tier-1 approval |
| `Isolate` | ⊙ Isolate | — (per-layer checkboxes) | no MDPA equivalent planned |
| View snaps `1–6`, `i` | — | 1–6, i | MDPA extension; candidate for upstreaming to CAD |

## KKSS adoption notes

KKSS consumes both siblings as unmodified submodules, copies their stylesheets verbatim at build time, and gates the build on `tools/check-theme-vars.mjs`: **every `--vscode-*` variable referenced must be defined in its `app/renderer/theme/vscode-vars.css`.** Adopting this design system adds these variables to that contract (Dark Modern values in parentheses):

`--vscode-sideBar-background` (#181818\*), `--vscode-sideBar-border` (#2b2b2b\*), `--vscode-sideBarSectionHeader-foreground` (#cccccc), `--vscode-editorWidget-border` (#454545), `--vscode-editorGroupHeader-tabsBackground` (#181818\*), `--vscode-inputValidation-infoBackground` (#063b49), `--vscode-scrollbarSlider-background` (rgba(121,121,121,0.4)), `--vscode-list-activeSelectionBackground` (#04395e), `--vscode-list-activeSelectionForeground` (#ffffff), `--vscode-menubar-selectionBackground` (rgba(90,93,94,0.31)). \* classic Dark+ uses #252526/#3c3c3c — match whichever family `vscode-vars.css` follows.

KKSS integration steps on the next submodule bump: add `mesh/media/design-system.css` to the `copies` array in `esbuild.mjs`'s `copyArtifacts()`, add one `<link>` before `style.css` in the mesh page template (`tools/webviewMarkup.ts` / `gen-webview-html.mjs`), extend `check-theme-vars.mjs` to scan the new file, and add the variables above.

## Hoisting proposal (not yet executed)

Today the file lives in this repo and is adopted by **verbatim copy** — the same convention the three repos already use for the icon pipeline (`build-toolbar-icons.mjs` is copied verbatim) and that KKSS uses for whole stylesheets. Copying keeps each repo self-contained and has **no licence consequence** (each copy is licensed under its host repo's terms; CSS tokens/recipes of this kind are far below any threshold of originality concern between projects with the same author).

The alternative is a shared npm package (e.g. `@kratos-multiphysics/ui-design-system`) that each repo lists as a devDependency and copies into its media/ at build time (KKSS already does exactly this with `xterm.css`). **Licence consequence:** the package must be permissively licensed (MIT or Apache-2.0) to be consumable by GPL-2.0-or-later CAD-Preview *and* AGPL-3.0 MDPA/KKSS — publishing it under either GPL flavour would wall off one consumer. Recommendation: stay with verbatim copy until the file stabilises across both extensions, then publish MIT if drift becomes a maintenance problem.
