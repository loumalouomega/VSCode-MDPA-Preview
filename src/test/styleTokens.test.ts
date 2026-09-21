import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// webview/style.css speaks the `--ui-*` token language (design-system.css): every
// font size, radius and animation goes through a token, so a redesign is an edit
// to one file rather than a hunt through 3,700 lines. Nothing here can render the
// stylesheet, so pin the invariants by reading it.
const CSS = fs
  .readFileSync(path.resolve(__dirname, "..", "..", "webview", "style.css"), "utf8")
  // Comments quote literal values on purpose; only declarations count.
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("style.css: no literal font-size — every size is a --ui-fs-* token", () => {
  const hits = CSS.match(/font-size:\s*[\d.]+(px|em|rem)/g) ?? [];
  assert.deepStrictEqual(hits, []);
});

test("style.css: no literal border-radius except circles (50%)", () => {
  const hits = (CSS.match(/border-radius:\s*[\d.]+px/g) ?? []).filter((h) => !h.includes("50%"));
  assert.deepStrictEqual(hits, []);
});

test("style.css: no transitions (cad has none; the harness compares captures moments apart)", () => {
  assert.doesNotMatch(CSS, /^\s*transition:/m);
});

test("style.css: the three sanctioned animations keep a reduced-motion rule", () => {
  const anims = [...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(anims, ["edit-progress-slide", "loading-turn", "var-row-flash"]);
  // One block per animation.
  assert.strictEqual((CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? []).length, anims.length);
});

test("design-system.css: --ds-border exists so `var(--ds-border, …)` never falls through", () => {
  const ds = fs.readFileSync(path.resolve(__dirname, "..", "..", "webview", "design-system.css"), "utf8");
  assert.match(ds, /--ds-border:\s*var\(--ds-widget-border\)/);
});
