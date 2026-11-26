/**
 * Static icon validation (roadmap item 86, rasteriser-free half): every icon id
 * a built-in names exists, and no icon or UI glyph is structurally blank.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TOOLBAR_ICONS } from "../toolbarIcons";
import { UI_GLYPHS } from "../uiGlyphs";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";

const known = new Set(Object.keys(TOOLBAR_ICONS));

test("every icon id a built-in names is a real toolbar icon", () => {
  const missing: string[] = [];
  for (const { decl } of BUILTIN_PROBLEMTYPES) {
    const use = (where: string, id: string | undefined): void => {
      if (id && !known.has(id)) missing.push(`${decl.id} ${where}: ${id}`);
    };
    use("decl", decl.icon);
    for (const s of decl.sections) use(`section ${s.id}`, s.icon);
    for (const c of decl.conditions) use(`condition ${c.id}`, c.icon);
    for (const c of decl.collections ?? []) use(`collection ${c.id}`, (c as { icon?: string }).icon);
  }
  assert.deepEqual(missing, []);
});

const DRAWING = /<(path|circle|ellipse|rect|line|polyline|polygon)\b/;

test("no toolbar icon or UI glyph is structurally blank", () => {
  const blank: string[] = [];
  const all = [...Object.entries(TOOLBAR_ICONS), ...Object.entries(UI_GLYPHS)] as [string, string][];
  for (const [id, svg] of all) {
    if (!DRAWING.test(svg)) blank.push(`${id}: no drawing element`);
    if (/\sd=""/.test(svg)) blank.push(`${id}: empty path data`);
    if (/<path\b[^>]*\sd="\s*[Mm]?\s*"/.test(svg)) blank.push(`${id}: path without segments`);
  }
  assert.deepEqual(blank, []);
});
