import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// `webview/dropdownMenu.ts` runs in the webview and touches the DOM only inside
// `setupDropdown()`. mesh's test runner has no DOM, so pin the behaviours that
// make it CAD's dropdown by reading its source rather than importing it.
const SRC = fs.readFileSync(path.resolve(__dirname, "..", "..", "webview", "dropdownMenu.ts"), "utf8");

test("dropdownMenu: one menu open at a time", () => {
  assert.match(SRC, /for \(const other of registry\) if \(other !== handle\) other\.close\(\)/);
});

test("dropdownMenu: outside pointerdown dismisses in the capture phase and is swallowed", () => {
  assert.match(SRC, /addEventListener\(\s*"pointerdown"[\s\S]*?true \/\/ capture/);
  assert.match(SRC, /e\.stopPropagation\(\);\s*closeAllDropdowns\(\)/);
});

test("dropdownMenu: Escape closes and returns focus to the trigger", () => {
  assert.match(SRC, /e\.key !== "Escape"/);
  assert.match(SRC, /closeAllDropdowns\(\);\s*handle\.trigger\.focus\(\)/);
});

test("dropdownMenu: arrow keys, Home and End move between items on trigger and panel", () => {
  for (const k of ["ArrowDown", "ArrowUp", "Home", "End"]) assert.ok(SRC.includes(`"${k}"`), k);
  assert.match(SRC, /panel\.addEventListener\("keydown", navigateByArrow\)/);
  assert.match(SRC, /trigger\.addEventListener\("keydown", navigateByArrow\)/);
});
