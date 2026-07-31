# Shared UI design system (CAD-Preview ↔ MDPA-Preview ↔ KKSS)

The written, canonical description of "the look" shared by the Kratos preview family: extracted
from CAD-Preview (the visual reference) and extended where MDPA-Preview has surfaces CAD-Preview
lacks. Materialised as [`webview/design-system.css`](https://github.com/loumalouomega/VSCode-MDPA-Preview/blob/master/webview/design-system.css)
— a static, dependency-free stylesheet + token file written so CAD-Preview and KKSS can adopt the
identical file verbatim.

## Principles

1. **VS Code theme tokens are the only colour source.** Every colour is
   `var(--vscode-*, <dark-fallback>)`; hardcoded hex appears only as the fallback, plus the handful
   of scene-side constants CAD-Preview already hardcodes (orientation-cube faces, axis arrows,
   quality band colours).
2. **Borders, not shadows.** Floating surfaces are `editorWidget-background` + a 1 px
   `editorWidget-border`. The *only* box-shadow in the system belongs to dropdown menus.
3. **No decorative motion.** Hover/active states switch instantly. The only animation is the
   indeterminate progress sweep.
4. **`font: inherit` on every control** so buttons/inputs/selects never fall back to the browser
   default font.
5. **Two active-state idioms, never mixed** (documented in CAD-Preview's stylesheet):
   - **mode-on** ("this mode is enabled"): `inputValidation-infoBackground` + 1 px `focusBorder`
     outline. Used for toggles: Pan, Wireframe, Clip, Find, Inspect, Grid, Ortho, menu triggers
     with a live mode.
   - **selected-1-of-N** ("this option is the current one"): plain primary `button-background`
     fill. Used for segments: rotate steps, clip axes, field modes, display modes, tabs.

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
| `--ds-header-bg` / `--ds-header-border` | `editorGroupHeader-tabsBackground` / `editorWidget-border` | the (future) 34 px menubar strip |

## Component recipes

- **Menubar** *(CAD; MDPA pending Tier-2 approval)*: in-flow, full-width, 34 px,
  `--ds-header-bg`, 1 px bottom `--ds-header-border`, 13 px; triggers are ghost buttons
  (`padding: 4px 10px`, hover `--ds-toolbar-hover`), label `File ▾` (text caret).
- **Toolbar button**: primary fill, radius 3, `padding: 4px 10px`, icon (1 em `currentColor`
  SVG) + label; hover `--ds-primary-hover`; mode-on idiom when it owns a live mode.
- **Dropdown panel**: `min-width: 200px`, radius **5**, `--ds-menu-bg` + 1 px `--ds-menu-border`,
  `--ds-shadow-menu`, `padding: 4px`; items radius 3, `padding: 6px 12px`, `gap: 8px`, hover
  `--ds-menu-sel-bg`/`-fg`; separators 1 px `margin: 4px 6px`; checkable items reserve a `✓`
  column (`::before`, `width: 1em`, opacity 0 → 1). One wiring: opening a menu closes the others,
  Escape closes all, clicks inside don't dismiss, one-shot items close themselves.
- **Sidebar**: `--ds-sidebar-bg`, right border `--ds-sidebar-border`; section headers 11 px / 600 /
  uppercase / `letter-spacing: 0.05em` / `--ds-section-header-fg`, hairline separators. MDPA
  extension: sections collapse (text chevron `▾`/`▸`) and the sidebar is resizable — CAD may adopt
  both later.
- **Tree/list row**: 22–24 px tall; hover `--ds-hover`; selection `--ds-list-sel-bg`/`-fg`;
  chevron 10 px opacity 0.7; count badge 10 px opacity 0.55; row action buttons are ghost
  (18×18, `line-height: 1`, opacity ~0.5 rest → 1 + `--ds-toolbar-hover` on hover).
- **Form row**: label column 72 px / 10 px / opacity 0.7; control `font: inherit`,
  `--ds-input-bg` + 1 px `--ds-input-border`, radius 3, `padding: 1px 3px`; focus =
  `border-color: --ds-focus`, `outline: none`. Inline-editable fields are invisible until
  hover/focus (transparent border → input border → focus border).
- **Slider**: `appearance: none`; track 3 px, radius 2, `--ds-track`; thumb 12 px round
  `--ds-thumb`; disabled thumb falls back to the track colour. (Webkit-only — VS Code webviews
  and Electron are Chromium.)
- **Floating panel** *(MDPA extension — CAD has no floating panels)*: `--ds-widget-bg` (falls back
  to editor background) + 1 px border, radius 4, `padding: 10px 12px`, **no shadow**; header =
  sidebar section-header typography + a ghost close button (the `close` SVG at 1 em, 13 px
  font-size, opacity 0.7 → 1).
- **Status pill**: bottom-center, `--ds-widget-bg`, radius 4, `padding: 6px 12px`, 12 px; errors
  recolor to `--ds-error`. Inline feedback beats toasts whenever the webview owns the flow.
- **Progress**: indeterminate sweep on a 2–3 px track (`--ds-track` base, `--ds-thumb` bar);
  cancellable runs pair it with a play→stop button swap (MDPA extension).
- **Nav card**: bottom-center, radius 6, `--ds-widget-bg` + border, `padding: 8px 14px`; collapse
  chevron `⌄`/`⌃` (ghost, 13 px); groups are vertical stacks captioned 10 px / 600 / uppercase /
  `letter-spacing: 0.06em` / opacity 0.7; D-pads are 3×3 grids of **24 px** secondary-filled cells;
  active step segment = selected-1-of-N idiom.

## Layout rules

- Orientation cube: **top-left**, ~96 px, 10 px margin. Uniform blue faces `#2b6cb0`, border
  `#1a4a7a`, bold white labels RIGHT/LEFT/TOP/BOTTOM/FRONT/BACK; axis arrows X `#ff3653`,
  Y `#8adb00`, Z `#2c8fff`.
- Nav controls: bottom-center. Toolbar: top-right. Status pill: bottom-center (above nav card
  zone is fine; CAD uses `bottom: 16px`).
- Sidebar: left column; viewport fills the rest. MDPA: 5 px resize sash between them.
- z-ladder (low→high): canvas overlays (5) → floating bars/pills (10–12) → toolbar (15) →
  menubar (20) → floating panels (20–22) → dropdowns (30) → loading overlay (100).

## Interaction vocabulary (glossary)

Canonical verbs, with MDPA's current names mapped:

| Canonical | CAD-Preview | MDPA-Preview today | Notes |
|---|---|---|---|
| `Fit` | Fit | Fit | reframe in place |
| `Ctr` | Ctr | Ctr | re-center focal point |
| `Clip` | Clip | **Cut Plane** | rename pending Tier-2 approval |
| `Ortho` / `Persp` | Persp↔Ortho toggle | Parallel Projection menu check | adopt the flip-label toggle |
| `Export…` | Export… | Export as ▸ (inline formats) | MDPA keeps the inline format list (36 formats) |
| `Save/Load Preprocess…` | Save/Load Preprocess… | Save/Load problem… | MDPA keeps "problem" (Kratos domain term, shipped `.kratosproblem.zip` format) |
| `BACK` | BACK | **REAR** | cube face; rename pending Tier-2 approval |
| `Isolate` | ⊙ Isolate | — (per-layer checkboxes) | no MDPA equivalent planned |
| View snaps `1–6`, `i` | — | 1–6, i | MDPA extension; candidate for upstreaming to CAD |

## KKSS adoption notes

KKSS consumes both siblings as unmodified submodules, copies their stylesheets verbatim at build
time, and gates the build on `tools/check-theme-vars.mjs`: **every `--vscode-*` variable referenced
must be defined in its `app/renderer/theme/vscode-vars.css`.** Adopting this design system adds
these variables to that contract (Dark Modern values in parentheses):

`--vscode-sideBar-background` (#181818\*), `--vscode-sideBar-border` (#2b2b2b\*),
`--vscode-sideBarSectionHeader-foreground` (#cccccc), `--vscode-editorWidget-border` (#454545),
`--vscode-editorGroupHeader-tabsBackground` (#181818\*), `--vscode-inputValidation-infoBackground`
(#063b49), `--vscode-scrollbarSlider-background` (rgba(121,121,121,0.4)),
`--vscode-list-activeSelectionBackground` (#04395e), `--vscode-list-activeSelectionForeground`
(#ffffff), `--vscode-menubar-selectionBackground` (rgba(90,93,94,0.31)).
\* classic Dark+ uses #252526/#3c3c3c — match whichever family `vscode-vars.css` follows.

KKSS integration steps on the next submodule bump: add `mesh/media/design-system.css` to the
`copies` array in `esbuild.mjs`'s `copyArtifacts()`, add one `<link>` before `style.css` in the
mesh page template (`tools/webviewMarkup.ts` / `gen-webview-html.mjs`), extend
`check-theme-vars.mjs` to scan the new file, and add the variables above.

## Hoisting proposal (not yet executed)

Today the file lives in this repo and is adopted by **verbatim copy** — the same convention the
three repos already use for the icon pipeline (`build-toolbar-icons.mjs` is copied verbatim) and
that KKSS uses for whole stylesheets. Copying keeps each repo self-contained and has **no licence
consequence** (each copy is licensed under its host repo's terms; CSS tokens/recipes of this kind
are far below any threshold of originality concern between projects with the same author).

The alternative is a shared npm package (e.g. `@kratos-multiphysics/ui-design-system`) that each
repo lists as a devDependency and copies into its media/ at build time (KKSS already does exactly
this with `xterm.css`). **Licence consequence:** the package must be permissively licensed
(MIT or Apache-2.0) to be consumable by GPL-2.0-or-later CAD-Preview *and* AGPL-3.0 MDPA/KKSS —
publishing it under either GPL flavour would wall off one consumer. Recommendation: stay with
verbatim copy until the file stabilises across both extensions, then publish MIT if drift becomes
a maintenance problem.
