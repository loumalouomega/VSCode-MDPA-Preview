# UI audit — MDPA-Preview vs. CAD-Preview

Phase 1 deliverable of the UI-unification task. CAD-Preview (`../CAD-Preview`, GPL-2.0-or-later,
Three.js) is the **visual reference**; VSCode-MDPA-Preview (AGPL-3.0-or-later, VTK.js) is the
**restyle target**. KKSS (AGPL-3.0-only, Electron) consumes both as unmodified git submodules and
constrains what a shared design system may look like (see [KKSS constraints](#kkss-constraints)).

Verdicts: **align** = adopt CAD-Preview's treatment · **keep** = MDPA-Preview's treatment stays
(reason given) · **extend** = no CAD-Preview equivalent exists, so the design language is extended
rather than a second one invented.

Items marked **⚠ approval** fall under the agreed stop-list (moving a feature between
toolbar/menu/sidebar, renaming a user-visible label, changing a keybinding or `package.json`
contribution, altering sidebar section structure) and will not be executed without explicit sign-off.

## Corrections to the task brief

Four assumptions in the brief turned out to be stale — recorded here so nobody re-litigates them:

1. **MDPA's nav panel already matches CAD's more than assumed.** It offers rotate 15°/45°/90°
   (default 45°, same as CAD), uses the labels `Fit` / `Ctr` (not "Center"), and *is* collapsible
   (`▾`/`▴` toggle). The remaining divergence is cosmetic (cell size, button fill, glyph choice)
   plus CAD's three extra groups (Clip / Appearance / Display).
2. **CAD's clip is capped.** `src/webview/clipCap.ts` implements a stencil-buffer solid cap; the
   README's "uncapped" predates it. Both extensions cap — MDPA additionally colors the cap by the
   active contour field.
3. **MDPA's screenshot button is not `📷`.** It renders the generated `screenshot` TikZ SVG,
   icon-only. The README text is the only place the emoji appears.
4. **The icon systems are already one system.** Both repos share the identical
   TikZ → `pdflatex` → `pdftocairo` → `currentColor`-SVG pipeline, the same visual language
   (`line width=1.3pt`, Stealth arrows, 1 mm grid), the same `.toolbar-icon svg { width:1em }`
   convention — and three icons (`wireframe`, `close`, `warning`) are already copied verbatim
   between them. "Pick one system" is done; what remains is policy alignment on Unicode glyphs
   (both already use text `▾ ▸ ↑ ← → ↓ + −`; CAD documents this as deliberate).

---

## Side-by-side audit

### 1. Top chrome

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Menu bar | **In-flow full-width 34 px `#menubar`** at the very top (pushes the layout down): `editorGroupHeader-tabsBackground`, 1 px `editorWidget-border` bottom border, 13 px font. Holds the ghost-styled `File ▾` trigger (transparent, `toolbar-hoverBackground` on hover/open). | **No menu bar.** `File ▾` is a floating button absolutely positioned top-left *inside* the viewport (`top:8px; left:8px; z-index:11`), styled like a secondary toolbar button. |
| Toolbar | Floats top-right over the canvas (`top:42px; right:8px`), **solid primary-blue pills** (`button-background` #0e639c fallback, white text/icons): 3 one-shot buttons (`Fit`, `Tree`, `FE Mesh`) + 4 dropdown triggers (`View ▾`, `Select ▾`, `Measure ▾`, `Markup ▾`). Mode-on triggers get `inputValidation-infoBackground` + `focusBorder` outline + a 6 px corner dot. | Floats top-right (`top:8px; right:8px`), **secondary-styled** buttons (`button-secondaryBackground`) with icon + text label: Reset, Pan, Cut Plane, Wireframe, Node IDs, Quality, Field, Grid, Find, Inspect, Advanced ▾, screenshot (icon-only), and a scene-theme `<select>` (Auto/Dark/Light/Scientific). `.active` = filled primary. |
| Dropdown recipe | One shared `.tb-menu-wrap`/`.tb-dropdown` pattern (`dropdownMenu.ts`, one implementation): radius **5 px**, `menu-*` tokens, `0 2px 8px rgba(0,0,0,0.36)` shadow (the only shadow in the stylesheet), items `padding:6px 12px`, hover = `menu-selectionBackground`, checkable items reserve a `✓` column, opening one closes the others, Escape closes all, clicks inside don't dismiss. | Two ad-hoc popups (`#file-menu-popup` radius 4 px, `#advanced-popup` radius 4 px) plus three body-attached outline popovers (export/info/opacity, `z-index:30`), each with its own wiring; items `padding:4px 8px`, hover = `menu-selectionBackground`. No checkable-item convention. |

**Verdict: align.** Adopt the menubar strip (**⚠ approval** — it moves `File ▾` out of the viewport
overlay into a real bar and changes the layout flow; also decides where the theme `<select>` lives),
the primary-pill toolbar treatment, the two-idiom active convention, and one shared dropdown
recipe/wiring for all five popups. Whether toggles like Grid/Wireframe/Node IDs/Screenshot regroup
into a CAD-style `View ▾` dropdown is **⚠ approval** (toolbar→menu move). MDPA keeps more one-shot
toolbar buttons than CAD regardless — it simply has more viewer features (extension).

### 2. File operations

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Menu items | `Open…`, `Save`, `Save As…`, `Export…`, `Save Preprocess…`, `Load Preprocess…` — flat list, icon left, no separators, no shortcut hints. Export shows a host-side QuickPick of formats (then a unit pick). | `Open…`, `Save`, `Save As…`, separator, `EXPORT AS` group with ~36 formats inline in 7 labelled subgroups (Kratos/VTK/Surface/Solvers/HDF5-netCDF/Fields/Figures), separator, `PROBLEM (ZIP)` group: `Save problem…` / `Load problem…`. |
| Archive naming | "Preprocess" — `<base>.preprocess.zip`, filter "Preprocess Archive". | "Problem" — `<stem>.kratosproblem.zip`, filter "Problem archive". |
| Keybindings | 7 chords, **all scoped** `when: activeCustomEditorId == 'cad-preview.mesh'`: Ctrl+O Open, Ctrl+S Save, Ctrl+Shift+S Save As, Ctrl+E Export, Ctrl+Alt+S Save Preprocess, Ctrl+Alt+O Load Preprocess, Ctrl+Alt+P Screenshot (⌘ variants on mac). Palette entries hidden unless the tab is focused. | **`contributes.keybindings` absent entirely.** All ops reachable via palette commands (`kratos.mesh.*`, `kratos.problem.*`) and the webview File menu. |
| Save semantics | Save never writes the CAD file — it flushes sidecars. | Save re-serialises the mesh to its own format and overwrites (one-time warning). |
| Default filenames | `<sourceStem>.<ext>` in the source directory; screenshot `<stem>.png`. | Same convention (`<stem><ext>`, `<stem>_skin<ext>`, `<stem>.png`, `<stem>.kratosproblem.zip`). |

**Verdict: align the chrome, keep the semantics.** Menu ordering/labels already match for
Open/Save/Save As; the archive pair should mirror CAD's position (after export) — already true.
**Keep** MDPA's inline grouped export list (36 formats; CAD's flat-QuickPick model doesn't scale —
this is a documented extension) and **keep** the "problem" domain naming (`.kratosproblem.zip` is
Kratos vocabulary and a shipped file format; renaming would be a functional change).
**Align** keybindings by adding the same seven chords scoped
`when: activeCustomEditorId == 'kratos.mdpaPreview' || activeCustomEditorId == 'kratos.vtkPreview'`
— **⚠ approval** (new `package.json` contribution). Mapping: Ctrl+Alt+S/O → Save/Load problem.

### 3. Sidebar

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Frame | Fixed **220 px**, no resizer, `sideBar-background` (#252526 fallback) + `sideBar-border` right border — visually a distinct column. Hidden until first model. | **280 px, resizable 160–640** via a 5 px drag handle (`sash-hoverBorder` highlight). Background = editor background (no distinct column tint). |
| Sections | 5 stacked panels (Components / Parts / Edits / FE Mesh / Mass Properties), **always expanded**, flex-sized; header right side holds *action buttons* (ghost `↶ ↷ 🗑 Clear`, primary `+ New`, `▶ Generate`…), not a collapse affordance. | 5 collapsible sections (Information / Layers / Edit / Mesh Modification / Problemtype) + 6 collapsible sub-categories inside Mesh Modification; pure-CSS triangle chevron rotates on collapse. No header-side actions (actions live in the body). |
| Header type | `11px / 600 / uppercase / letter-spacing 0.05em`, `sideBarSectionHeader-foreground` (#bbb), `border-bottom: 1px solid sideBar-border`, padding `6px 8px`. | `11px / 600 / uppercase / letter-spacing 0.04em`, `--vscode-foreground` at opacity 0.7, section `border-bottom: panel-border`, padding `8px 10px`. |

**Verdict: align tokens/typography, keep structure.** Switch the sidebar to `sideBar-background` /
`sideBar-border` / `sideBarSectionHeader-foreground`, letter-spacing 0.05em, CAD header padding.
**Keep** collapsibility (MDPA's sidebar holds ~20 forms across 11 collapsibles — always-expanded is
not viable; documented extension) and **keep** the resizer (strict superset; CAD could adopt it
later). Swapping the CSS-triangle chevron for CAD's text `▾`/`▸` is cosmetic and included.
Any change to *which* sections exist or their order is **⚠ approval** (none proposed).

### 4. Tree rows (Layers outline vs. Components/Parts)

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Row | 22–24 px tall; text chevron `▾`/`▸` (10 px, opacity 0.7); label; count badge (10 px, opacity 0.55); **eye toggle `👁`/`🙈`** (emoji, 18×18 ghost button, opacity 0.5→1); selection = `list-activeSelectionBackground/-Foreground`; hover = `list-hoverBackground`. Inline-editable name/size inputs are invisible until hover/focus (transparent border → `input-border` on hover → `focusBorder` + `input-background` on focus). | ~20 px rows; **checkbox** visibility toggle; 10×10 color swatch; label (underline on hover = "click to frame"); `(count)` at opacity 0.55; five hover-revealed action buttons (opacity 0→0.7→1): opacity-popover, export, rename, info, delete. Rename swaps the label for an inline input (Enter/Escape/blur). |

**Verdict: align metrics and colors, flag the toggle idiom.** Adopt row height, `list-*`
hover/selection tokens, badge/chevron styling. The **checkbox → eye-toggle** swap is an
interaction-grammar change (**⚠ approval**): checkboxes scan better for MDPA's many-layer lists and
are the current muscle memory; eyes are CAD's grammar. Recommendation: adopt the eye (reference
wins; KKSS then shows one idiom), but it needs sign-off. MDPA's five per-row actions have no CAD
equivalent — keep as an extension, restyled to CAD's ghost-button recipe (18×18, opacity 0.5 rest).
MDPA's rename-in-place already matches CAD's inline-edit idiom; align its focus treatment (border
color, not outline).

### 5. Orientation cube

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Position / size | **Top-left**, 96 px, 10 px margin (scissor viewport on the main canvas). | **Bottom-left**, 15% of viewport clamped 80–160 px (`vtkOrientationMarkerWidget`). |
| Faces | Uniform **medium blue `#2b6cb0`**, 6 px darker border `#1a4a7a`, **bold white** labels RIGHT / LEFT / TOP / BOTTOM / FRONT / **BACK**. | Per-face dark hexes (X± `#7a1e1e`/`#4a1010`, Y± `#1e6b1e`/`#104010`, Z± `#1e3d7a`/`#102050`), white bold labels …FRONT / **REAR**, edge color `#080808`. |
| Axes | Three ArrowHelpers, X `#ff3653` / Y `#8adb00` / Z `#2c8fff`, length 1.3. | `vtkAxesActor`, X `rgb(220,50,50)` / Y `rgb(50,200,50)` / Z `rgb(50,100,255)`, with X/Y/Z letter labels. |
| Click | Face → snap camera (both). | Face → `snapCamera` (both). |

**Verdict: align.** Move to top-left (`Corners.TOP_LEFT`), uniform `#2b6cb0` faces with the darker
edge, label REAR → BACK (**⚠ approval** — user-visible label), match axis-arrow colors to CAD's
three hexes. Hardcoded hex is acceptable here because CAD already hardcodes these (agreed carve-out).
MDPA keeps its letter-labelled axes actor (slightly richer than CAD's bare arrows — harmless).

### 6. Navigation panel

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Container | Bottom-center; radius 6; `editorWidget-background` + `editorWidget-border`; **no shadow**; padding `8px 14px`; collapse via ghost `⌄`/`⌃` (13 px). | Bottom-center; radius 6; `editorWidget-background` + `panel-border`; `0 2px 10px` shadow; padding `8px 12px`; collapse via `▾`/`▴`; lifts to `bottom:44px` above the timeline. |
| Groups | ROTATE (15°/45°/90° segments + D-pad) · PAN (D-pad) · ZOOM (+/−) · VIEW (`Fit` `Ctr`) · **CLIP** · **APPEARANCE** · **DISPLAY**. | ROTATE (15°/45°/90° pills + D-pad, auto-repeat) · PAN · ZOOM (auto-repeat) · VIEW (`Fit` `Ctr`). |
| Cells | 24 px grid cells, **filled** `button-secondaryBackground`, hover `button-hoverBackground`; active segment = filled primary blue. Captions `10px/600/uppercase/0.06em/op-0.7`. | 22 px cells, **transparent** glyph buttons (fill only on `:active`); active step = accent-colored bold *text*, not a filled segment. Captions `9px/uppercase/0.05em/op-0.5`. |

**Verdict: align cosmetics; group moves are ⚠ approval.** Adopt 24 px filled cells, CAD hover/active
treatment (active step = filled primary segment), `⌄`/`⌃` collapse glyphs, CAD caption type, drop the
shadow for the border-only look. MDPA's auto-repeat on hold is a keep (superset). Moving Cut Plane
into the bar as a CLIP group, or building an APPEARANCE group, moves features between homes —
**⚠ approval**, listed under structural work. A DISPLAY group is not proposed (MDPA's per-layer
representation model doesn't reduce to five global modes).

### 7. Clipping

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Name / home | **"Clip"** group inside the nav bar. | **"Cut Plane"** toolbar toggle + a panel below the toolbar (top-right). |
| Controls | X/Y/Z segmented (X default), offset slider −100…100, `Off`/`On` toggle button. No free normal, no flip. | X/Y/Z/**Free** radios (Z default) with nx/ny/nz inputs, **Flip**, slider with position readout. |
| Cap | Stencil-buffer solid cap (README stale). | CPU-computed cap + intersection edge lines, recolorable by the active contour field. |

**Verdict: align vocabulary and control styling, keep capability.** Rename "Cut Plane" → "Clip"
(**⚠ approval** — label rename, touches the toolbar button, the command title
`kratos.mdpa.*`-adjacent strings stay untouched), restyle X/Y/Z as CAD segments. **Keep** Free
normal, Flip, the position readout and the field-colored cap (extensions — state them in the design
spec so CAD can adopt the vocabulary later). The home (nav-bar group vs. toolbar+panel) is
**⚠ approval** under item 6.

### 8. Appearance / rendering controls

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Where | One APPEARANCE nav group: background color swatch (22×22), model-opacity slider, `Persp`/`Ortho` toggle button, Units select (display-only mm/cm/m/in/ft). | Scattered: scene-theme `<select>` in the toolbar; **Advanced ▾** holds Parallel Projection (toggle), Lighting… (specular/ambient/diffuse/backface panel), Camera Bookmarks…; per-layer opacity popovers in the outline. |

**Verdict: partial align.** Adopt CAD's `Persp`/`Ortho` toggle-button idiom (one button, label
flips, mode-on treatment) in place of the checkable "Parallel Projection" menu row — where it lives
is part of the item-6 decision. MDPA's theme select is *functionally different* from CAD's
background swatch (it swaps full scene themes incl. Scientific) — **keep**. Lighting, bookmarks and
per-layer opacity have no CAD counterpart — **extend** (restyle only). A model-opacity global slider
and Units are CAD-domain features MDPA doesn't have; not in scope (no feature additions).

### 9. Floating panels & forms

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Panels | None float — everything is a sidebar panel. Elevation language: `editorWidget-background` + 1 px border, shadow **only** on dropdowns. | 7 floating panels (Quality, Mesh Size, Spheres, Field, Inspect, Lighting, Bookmarks) sharing one box recipe but **three duplicated header/close CSS families** (`.quality-*`, `.meshsize-*`, `.field-*` — byte-identical rules). All carry `0 2px 8px` shadows. |
| Form rows | `.meshing-field`: label column **72 px / 10 px / opacity 0.7**, control fills; inputs `font: inherit`, `input-background`, focus = **border-color change, no outline**; `width:0; flex:1; min-width:28px` so labels can't blow out rows. | `.edit-form-row`: inline 11 px labels at opacity 0.6–0.8, fixed em widths, focus = 1 px `focusBorder` **outline**. Field panel uses a 64 px label column. |
| Sliders | One custom recipe (`.meshing-slider`): 3 px `scrollbarSlider-background` track, 12 px round `progressBar-background` thumb, webkit-only. | Native sliders; single `accent-color` on the timeline scrub. |
| Buttons | Primary (`button-background`) / secondary (`button-secondaryBackground`) / ghost (transparent, opacity 0.85, hover `toolbar-hoverBackground`) with documented disabled opacities. | Mostly secondary + `.edit-apply` primary; ghost only implicitly (outline row buttons). |

**Verdict: extend CAD's language with a panel recipe; align everything inside.** Floating panels
stay (MDPA's analysis panels have no sidebar home), but: merge the three header/close families into
**one** `.panel-*` recipe using CAD's section-header typography and a single close style; drop
panel shadows in favor of `editorWidget` border-only (shadow stays exclusive to dropdowns, per CAD);
adopt the 72 px/10 px label-column form recipe, `font: inherit`, focus-as-border-color; adopt the
slider recipe globally (cut slider, field sliders, opacity popover, timeline); adopt the
three-tier button hierarchy and CAD's two `.active` idioms everywhere (mode-on = info-background +
focus outline: Pan, Wireframe, Cut/Clip, Find, Inspect, Grid…; 1-of-N = filled primary: field-mode
buttons, axis segments, rotate steps…).

### 10. Typography, spacing, radii, motion

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Type scale | 9 / 10 / 11 / 12 / 13 px; weight **600 only**; `line-height:1` on icon buttons. | 9–12 px + **16 px** close buttons + 11.5/10.5 oddballs; weights 600 and one 700. |
| Radii | 2 / **3 (default)** / 4 / 5 (dropdowns) / 6 (nav card) / 50%. | 2 / 3 / 4 / 6 — dropdowns at 4, several 2 px controls. |
| Elevation | Borders, not shadows (1 shadow total). | 5 distinct shadow variants. |
| Motion | **No transitions**; one progress keyframe. | Several transitions (chevrons, hover opacities) + progress keyframes. |

**Verdict: align.** Normalize to CAD's scale: close buttons drop to icon-sized (the `close` SVG at
1em, not 16 px text), 11.5/10.5 px collapse into the ladder, the lone 700 weight becomes 600,
dropdowns go to radius 5, shadows come off everything except dropdowns, decorative transitions go
(hover states switch instantly, as in CAD). This tier is where most of the "feel" difference lives.

### 11. Icons

Already one system (see correction #4). Remaining actions: adopt CAD's explicit policy note on
Unicode glyphs (chevrons/arrows/± stay text); replace the two remaining ad-hoc text glyphs that CAD
would draw as icons or leave alone deliberately — `⟲` (range reset) and `✕` (size-part row delete;
the outline delete already uses the `close` SVG) — either by generating TikZ icons or documenting
them as accepted text glyphs. MDPA's 74-icon set is a superset of CAD's 41; no consolidation needed.
The eye emoji question is covered in item 4.

### 12. Status, errors, loading

| | CAD-Preview | MDPA-Preview |
|---|---|---|
| Status | One **bottom-center pill** `#status` (`editorWidget-background`, radius 4, 12 px, padding `6px 12px`); errors recolor it `errorForeground`. Inline always; toasts only for host-only flows. | Bottom-**left** bare text `#message` (11 px, opacity 0.7, no pill); full-cover `#loading` overlay with determinate 4 px bar; per-form indeterminate `.edit-progress` bars with play→stop cancel; `#pt-status` line; host toasts for save/export results. |
| Progress | One 2 px indeterminate sweep (FE Mesh panel). | 3 px indeterminate sweep + streamed log line + cancel (superset). |

**Verdict: align the pill, keep the machinery.** Restyle `#message` into CAD's bottom-center pill
recipe (position change is inside the viewport, not a feature move). **Keep** the loading overlay
(MDPA parses multi-hundred-MB files with real progress fractions — CAD has nothing comparable) and
the cancellable op-progress bars (superset; align bar color/track to the shared recipe). Host toasts
for completed saves stay (they carry file paths; CAD uses its pill because its webview owns the
flow — different plumbing, same information).

### 13. Screenshot flow

Both: capture → save dialog defaulting to `<stem>.png` in the source directory, "PNG Image" filter.
CAD triggers via View ▾ menu item + Ctrl+Alt+P; MDPA via an icon-only toolbar button + palette
command. **Verdict: already aligned behaviorally**; trigger placement follows the item-1 toolbar
decision; Ctrl+Alt+P joins the item-2 keybinding set. MDPA's legend burn-in on screenshots is a keep.

### 14. Keyboard

CAD: seven scoped chords in `package.json`; inside the webview only Escape. MDPA: no contributions;
webview keys `1`–`6` (±X/±Y/±Z), `i` (isometric), Escape/Enter conventions. **Verdict:** align by
adding the chords (**⚠ approval**, item 2); **keep** `1`–`6`/`i` as a documented design-language
extension (CAD has no view-snap keys; these are the kind of thing the shared spec should offer
upstream rather than delete here).

### 15. MDPA-only surfaces (no CAD equivalent — extend)

Timeline bar, Find bar, Inspect panel, Quality panel, Field panel, Mesh Size panel, Spheres panel,
Problemtype section, Flowgraph split pane, Advanced ▸ Mesh Size/Face normals/Export skin. All are
**extensions**: they get the shared recipes (panel chrome, forms, sliders, buttons, dropdowns) and
zero structural change. The design-system spec (Phase 2) must describe each recipe generically
enough that these panels are "more of the same", not exceptions.

### 16. CAD-only surfaces (out of scope)

Parts/Components/Edits/Variables/Mass Properties panels, selection/measure/markup modes, display
modes, drag-and-drop open, unit conversion. No MDPA counterpart is being built — they matter only as
recipe sources.

---

## KKSS constraints

- KKSS copies `mesh/media/style.css` **verbatim** at build time and generates its HTML from
  `webviewChrome.ts` exports — every chrome change here flows into KKSS by submodule bump, except
  the toolbar/cut-panel/find-bar block it hand-replicates in `tools/webviewMarkup.ts` (must be
  updated there when those blocks change).
- Its `check-theme-vars.mjs` build guard **fails on any `--vscode-*` variable not defined in its
  dark-only `vscode-vars.css`**. The audit's token changes introduce at least:
  `--vscode-sideBar-background`, `--vscode-sideBar-border`, `--vscode-sideBarSectionHeader-foreground`,
  `--vscode-editorWidget-border`, `--vscode-editorGroupHeader-tabsBackground`,
  `--vscode-inputValidation-infoBackground`, `--vscode-scrollbarSlider-background`,
  `--vscode-list-activeSelectionBackground`, `--vscode-list-activeSelectionForeground`,
  `--vscode-menubar-selectionBackground`. Each must be added to KKSS's `vscode-vars.css` when it
  bumps the submodule — the design-system doc will carry this list.
- KKSS's strict CSP means the shared design system must be a **static, dependency-free CSS file**
  (linked, never injected; no preprocessor). That is exactly the planned
  `webview/design-system.css` shape.
- **License:** a shared *npm package* consumable by GPL-2.0-or-later CAD-Preview and the two AGPL
  repos must itself be permissively licensed (MIT/Apache-2.0). The zero-friction alternative — and
  KKSS's existing idiom — is verbatim file copying between repos, which needs no relicensing. The
  Phase 2 proposal will present both with this trade-off stated.

---

## Prioritised work list

### Tier 1 — high impact, low risk, no approvals needed (pure cosmetics)

1. **Tokens/typography/spacing pass**, materialized as `webview/design-system.css`: CAD's type
   scale (weight-600-only, no 16 px closes), radius scale (3 default / 5 dropdowns / 6 nav card),
   `sideBar-*` + `editorWidget-*` tokens, borders-over-shadows, drop decorative transitions,
   `font: inherit` on all controls. Ship the KKSS var-list alongside.
2. **Merge the three floating-panel header/close families** into one `.panel-*` recipe.
3. **CAD slider recipe** globally (cut slider, field sliders, opacity popover, timeline scrub).
4. **Button hierarchy** (primary/secondary/ghost) + CAD's **two `.active` idioms** (mode-on vs.
   selected-1-of-N).
5. **One dropdown recipe + one wiring** for File popup, Advanced popup and the outline popovers
   (radius 5, `menu-*` tokens, checkable-✓ column, open-one-closes-others).
6. **Orientation cube**: top-left, uniform `#2b6cb0` faces, CAD axis-arrow colors. (Label
   REAR → BACK is Tier 2 — it's a visible label.)
7. **Nav-controls cosmetics**: 24 px filled cells, `⌄`/`⌃`, caption type, active step = filled
   segment, border-only elevation.
8. **Status pill**: restyle `#message` to CAD's bottom-center pill.

### Tier 2 — structural / user-visible; each item ⚠ needs explicit approval

9. **In-flow 34 px menubar** hosting `File ▾` (and deciding the theme-select home).
10. **Toolbar regrouping** to CAD grammar: primary pills; optionally fold Grid / Wireframe /
    Node IDs / Screenshot… into a `View ▾` dropdown.
11. **Keybindings contribution**: Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+E / Ctrl+Alt+S /
    Ctrl+Alt+O / Ctrl+Alt+P scoped to the two custom-editor viewTypes.
12. **Vocabulary renames**: "Cut Plane" → "Clip", cube "REAR" → "BACK" (full glossary lands in the
    Phase 2 design-system doc).
13. **CLIP / APPEARANCE groups in the nav bar** (vs. today's toolbar-panel and Advanced-menu homes).

### Tier 3 — long tail

14. Outline-row grammar: eye toggle vs. checkbox, `list-activeSelection*` selection colors,
    ghost-button treatment for the five row actions.
15. Loading-overlay ↔ status-pill harmonization; audit which host toasts could become pill lines.
16. Side effects of the `sideBar-background` switch (popover contrast, swatch borders, focus rings).
17. Phase 4 visual harness (`scripts/ui-shots/`, contact sheet under `doc/ui-comparison/`) and the
    Phase 2 shared-package proposal (permissive-licensed package vs. KKSS-style verbatim copy).
