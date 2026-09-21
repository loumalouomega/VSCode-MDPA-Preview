import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// `webview/navControls.ts` needs a DOM (it builds the dock lazily), which mesh's
// node test runner does not have. As with dropdownMenu.test.ts, pin what makes it
// CAD's dock by reading the source; the pure maths is tested in navMath.test.ts.
const WEBVIEW = path.resolve(__dirname, "..", "..", "webview");
const NAV = fs.readFileSync(path.join(WEBVIEW, "navControls.ts"), "utf8");
const CSS = fs.readFileSync(path.join(WEBVIEW, "style.css"), "utf8");
const MAIN = fs.readFileSync(path.join(WEBVIEW, "main.ts"), "utf8");

test("navControls: every id the rest of the app and the capture scripts look up survives", () => {
  for (const id of ["nav-controls", "nav-body", "nav-reset", "nav-fit", "nav-zoom-in", "nav-zoom-out", "nav-more", "nav-more-popup", "nav-center", "nav-collapse"]) {
    assert.ok(NAV.includes(`"${id}"`), `navControls.ts lost #${id}`);
  }
  for (const id of ["nav-ortho", "nav-opacity", "nav-display-shaded", "nav-display-wire", "nav-display-edges"]) {
    assert.ok(MAIN.includes(`"${id}"`), `main.ts lost #${id}`);
  }
});

test("navControls: the dock is one row - nav | display | clip | projection | more - collapse chevron last by order", () => {
  const body = NAV.slice(NAV.indexOf("body.appendChild(this.buildNavIcons())"));
  const pos = (s: string): number => body.indexOf(s);
  assert.ok(pos("buildNavIcons") < pos('slot("display"'));
  assert.ok(pos('slot("display"') < pos("buildClipGroup"));
  assert.ok(pos("buildClipGroup") < pos('slot("projection"'));
  assert.ok(pos('slot("projection"') < pos("buildMore"));
  assert.match(CSS, /\.nav-collapse-btn\s*\{[^}]*order:\s*2/);
  assert.match(CSS, /#nav-controls\.collapsed \.nav-collapse-btn svg\s*\{[^}]*rotate\(180deg\)/);
  assert.match(CSS, /#nav-controls\.collapsed #nav-body\s*\{[^}]*display:\s*none/);
});

test("navControls: the row wraps rather than clipping, and is capped to the canvas", () => {
  assert.match(CSS, /#nav-body\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(CSS, /#nav-body\s*\{[^}]*width:\s*max-content/);
  assert.match(CSS, /#nav-controls\s*\{[^}]*max-width:\s*calc\(100% - 2 \* var\(--ui-s-5\)\)/);
  assert.ok(!/#nav-body\s*\{[^}]*nowrap/.test(CSS), "the dock row must never be nowrap");
  assert.ok(!/#nav-body\s*\{[^}]*overflow-x/.test(CSS), "the dock row must never scroll sideways");
});

test("navControls: the popover is a shared setupDropdown that opens upward from the dock", () => {
  assert.match(NAV, /setupDropdown\(trigger, pop\)/);
  assert.match(CSS, /#nav-more-popup\s*\{[^}]*bottom:\s*calc\(100% \+ var\(--ui-s-2\)\)/);
  assert.match(CSS, /#nav-more-wrap\s*\{\s*position:\s*static/);
  // Collapsing closes it (its trigger would keep a stale aria-expanded otherwise).
  assert.match(NAV, /if \(collapsed\) this\.more\?\.close\(\)/);
});

test("navControls: the toast follows the dock's measured height, not a hardcoded card height", () => {
  assert.match(NAV, /new ResizeObserver\(\(\) => this\.publishHeight\(\)\)/);
  assert.match(NAV, /setProperty\("--nav-height"/);
  assert.match(CSS, /#message\s*\{[^}]*bottom:\s*calc\(var\(--nav-bottom, 8px\) \+ var\(--nav-height, 46px\)/);
  assert.ok(!/#message\s*\{[^}]*144px/.test(CSS), "the fixed 144px card height is gone");
});

test("navControls: press-and-hold buttons stay keyboard-operable", () => {
  // Enter/Space raise a click with detail 0 and no mousedown.
  assert.match(NAV, /e\.detail === 0/);
});
