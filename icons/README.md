# Icon sources

This directory holds the TikZ-drawn toolbar/panel icon set for MDPA-Preview.
It shares its visual language and build pipeline with the sibling project
[CAD-Preview](../../CAD-Preview/icons) — three icons (`wireframe`, `close`,
`warning`) are copied verbatim from there so the two extensions look identical.

All sources use the same `tikzpicture` options (`line width=1.3pt, line
cap=round, line join=round, >=Stealth, x=1mm,y=1mm`), canvas coordinates
roughly -13..13, `fill=black`/default strokes, and `fill=gray!N` only for
shaded faces.

## Pipeline

`tikz-ui/<id>.tex` → `pdflatex` → `pdftocairo -svg` → `svg-ui/<id>.svg`
→ `build-toolbar-icons.mjs` → generated `../src/toolbarIcons.ts`.

The codegen post-processes each raw SVG:
- strips the XML prolog and the fixed `width`/`height` (keeps `viewBox`, so CSS
  controls the rendered size — see `.toolbar-icon` in `webview/style.css`)
- literal black (`rgb(0%, 0%, 0%)`) stroke/fill → `currentColor`, so the icon
  tracks whatever `color` the surrounding element has (theme-aware) instead of
  being stuck black
- literal gray shading fills (from a TikZ `gray!N` fill) → `currentColor` at a
  proportional `fill-opacity` — `N`% gray becomes `(100-N)/100` opacity, so an
  icon's relative face shading is preserved rather than flattened

```bash
cd icons
make ui         # tikz-ui/*.tex → svg-ui/*.svg (needs pdflatex + pdftocairo)
make ts         # (re-)runs `make ui`, then regenerates ../src/toolbarIcons.ts
node build-toolbar-icons.mjs   # re-run codegen alone, no LaTeX needed,
                                # as long as svg-ui/*.svg is already current
make clean
```

`svg-ui/*.svg` previews are committed so anyone can regenerate
`toolbarIcons.ts` with plain Node (`npm run build:icons`) without a TeX install,
unless they're also changing a `.tex` source's actual drawing.

**Never hand-edit `src/toolbarIcons.ts`** — it's regenerated wholesale by
`make ts` and any manual edit will be silently lost. To change an icon: edit
its `tikz-ui/<id>.tex`, run `make ts`, done.

To add a new toolbar icon: create `tikz-ui/<newId>.tex`, run `make ts` (the
script picks up every `.svg` in `svg-ui/` automatically), then import
`TOOLBAR_ICONS.newId` where you need it. `src/test/toolbarIcons.test.ts`
enforces the generated file's invariants — run `npm test` after regenerating.

## Icons

| id | drawing | used for |
|---|---|---|
| `reset` | circular refresh arrow | Reset camera |
| `pan` | hand silhouette | Toggle pan mode |
| `cut` | box bisected by a shaded clip plane | Toggle clip plane |
| `wireframe` | isometric cube, edges only (*from CAD-Preview*) | Toggle wireframe |
| `nodeIds` | node dot with "#" | Toggle node ids |
| `quality` | triangle with angle arc | Compute mesh quality |
| `field` | horizontal colormap bar | Visualize field data |
| `grid` | 3×3 grid of squares | Toggle background grid |
| `find` | magnifier | Find entity by ID |
| `screenshot` | camera body + lens | Save screenshot |
| `close` | X (*from CAD-Preview*) | Close panels / find bar |
| `warning` | triangle + exclamation (*from CAD-Preview*) | Quality criteria not satisfied |
| `check` | checkmark | Quality criteria satisfied |
