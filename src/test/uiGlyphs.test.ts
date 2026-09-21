import { test } from "node:test";
import assert from "node:assert";
import { UI_GLYPHS, glyph, type UiGlyphId } from "../uiGlyphs";

// Invariants for the HAND-AUTHORED src/uiGlyphs.ts. Unlike toolbarIcons.ts nothing
// post-processes these, so the contract the chrome CSS relies on is asserted here:
// theme-tinted (currentColor only), sized by CSS (no width/height on the root),
// and scalable (a viewBox).

const ids = Object.keys(UI_GLYPHS) as UiGlyphId[];

test("every glyph is a currentColor SVG with a viewBox and no fixed size", () => {
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const svg = UI_GLYPHS[id];
    assert.match(svg, /^<svg [^>]*viewBox="0 0 24 24"/, `${id}: viewBox`);
    const root = svg.slice(0, svg.indexOf(">") + 1);
    assert.doesNotMatch(root, /\swidth=|\sheight=/, `${id}: root must not carry a width/height`);
    assert.match(root, /stroke="currentColor"/, `${id}: stroke must follow the theme`);
    assert.match(svg, /aria-hidden="true"/, `${id}: decorative`);
    assert.ok(svg.endsWith("</svg>"), `${id}: closed`);
  }
});

test("never hardcodes a colour", () => {
  for (const id of ids) {
    const s = UI_GLYPHS[id];
    assert.doesNotMatch(s, /#[0-9a-fA-F]{3,8}\b|rgb\(|\b(black|white)\b/, `${id}: literal colour`);
    // Any fill is either off or the theme colour.
    for (const m of s.matchAll(/fill="([^"]*)"/g)) {
      assert.ok(m[1] === "none" || m[1] === "currentColor", `${id}: fill="${m[1]}"`);
    }
  }
});

test("glyph() wraps one glyph in the .ui-glyph span the CSS sizes", () => {
  assert.strictEqual(glyph("chevronDown"), `<span class="ui-glyph">${UI_GLYPHS.chevronDown}</span>`);
});

test("carries the glyphs the chrome markup and CAD-Preview's set both need", () => {
  for (const id of ["chevronDown", "listTree", "layers", "sliders", "braces", "undo", "redo", "trash", "more", "info"] as const) {
    assert.ok(id in UI_GLYPHS, id);
  }
});
