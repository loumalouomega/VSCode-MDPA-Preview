#!/usr/bin/env node
// Regenerates ../src/toolbarIcons.ts from svg-ui/*.svg (each produced by
// `make ui` from the matching tikz-ui/*.tex — see icons/README.md). Pure
// Node, no LaTeX dependency: as long as svg-ui/*.svg is up to date (it's
// committed), this can be re-run standalone.
//
// Per-icon post-processing on the raw pdftocairo -svg output:
//   - strips the XML prolog and the fixed width/height (viewBox stays, so
//     CSS controls the rendered size)
//   - literal black (`rgb(0%, 0%, 0%)`) stroke/fill → `currentColor`, so the
//     icon's color follows the surrounding element's `color` (and therefore
//     VS Code's theme) instead of being stuck black
//   - literal gray shading fills (from a TikZ `gray!N` fill) → `currentColor`
//     at a proportional `fill-opacity` (N% gray = (100-N)/100 opacity), so
//     shaded regions scale with the theme's foreground color instead of
//     staying a fixed gray, and relative shading between an icon's own faces
//     (e.g. the box's front/top/side) is preserved rather than flattened
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG_DIR = path.join(HERE, "svg-ui");
const OUT_FILE = path.join(HERE, "..", "src", "toolbarIcons.ts");

function postProcess(svg) {
  let out = svg
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/(<svg\b[^>]*?)\swidth="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?)\sheight="[^"]*"/, "$1")
    .trim();

  // Pure black → currentColor (covers both `stroke="..."` and `fill="..."`).
  out = out.replace(/(stroke|fill)="rgb\(0%, 0%, 0%\)"/g, '$1="currentColor"');

  // Any other gray shade rgb(X%, X%, X%) → currentColor at proportional opacity.
  // pdftocairo always emits `fill="rgb(...)" fill-opacity="1"` as a pair, so
  // the match consumes both — otherwise the original `fill-opacity="1"` is
  // left trailing right after our replacement and silently wins over it.
  out = out.replace(/fill="rgb\((\d+(?:\.\d+)?)%, \1%, \1%\)" fill-opacity="1"/g, (_m, pct) => {
    const p = Number(pct);
    if (p === 0 || p === 100) return `fill="rgb(${pct}%, ${pct}%, ${pct}%)" fill-opacity="1"`; // pure black/white, untouched
    const opacity = ((100 - p) / 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return `fill="currentColor" fill-opacity="${opacity}"`;
  });

  return out;
}

const files = readdirSync(SVG_DIR).filter((f) => f.endsWith(".svg")).sort();
if (files.length === 0) {
  console.error(`No .svg files found in ${SVG_DIR} — run 'make ui' first.`);
  process.exit(1);
}

const ids = files.map((f) => f.replace(/\.svg$/, ""));
const entries = files.map((f) => {
  const id = f.replace(/\.svg$/, "");
  const raw = readFileSync(path.join(SVG_DIR, f), "utf8");
  return [id, postProcess(raw)];
});

const banner = `/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   cd icons && make ts
 * Source: icons/tikz-ui/*.tex → icons/svg-ui/*.svg → icons/build-toolbar-icons.mjs
 * See icons/README.md for the full pipeline and how to edit an icon's design.
 *
 * Monochrome, theme-adaptive toolbar/panel icons: each value is inline SVG
 * markup using \`currentColor\` (and \`currentColor\` + \`fill-opacity\` for
 * shaded regions) instead of hardcoded colors, so wrapping the icon in an
 * element with a \`color\` (VS Code already sets one on toolbar buttons) tints
 * it automatically for both light and dark themes — no separate light/dark
 * assets needed.
 */
`;

const typeDecl = `export type ToolbarIconId =\n  | ${ids.map((id) => `"${id}"`).join("\n  | ")};\n\n`;

const recordBody = entries
  .map(([id, svg]) => `  ${id}: ${JSON.stringify(svg)},`)
  .join("\n");

const content =
  banner +
  typeDecl +
  `export const TOOLBAR_ICONS: Record<ToolbarIconId, string> = {\n${recordBody}\n};\n`;

writeFileSync(OUT_FILE, content);
console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${ids.length} icons)`);
