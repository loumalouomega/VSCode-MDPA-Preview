import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RIBBON,
  DOCK_ONLY_ACTIONS,
  RIBBON_GROUPS,
  RIBBON_TABS,
  allRibbonItems,
  parseRibbonSetting,
  sanitizeRibbonTab,
} from "../parser/ribbonSpec";
import { ADVANCED_MENU_HTML, TOOLBAR_HTML, VIEW_MENU_HTML } from "../webviewChrome";
import { TOOLBAR_ICONS } from "../toolbarIcons";

test("ribbon is off by default", () => {
  assert.equal(DEFAULT_RIBBON, false);
  assert.equal(parseRibbonSetting(undefined), false);
  assert.equal(parseRibbonSetting("yes"), false);
  assert.equal(parseRibbonSetting(true), true);
});

test("every ribbon action exists as a toolbar/menu entry (or is a nav-dock action)", () => {
  const markup = TOOLBAR_HTML + VIEW_MENU_HTML + ADVANCED_MENU_HTML;
  for (const item of allRibbonItems()) {
    if (DOCK_ONLY_ACTIONS.includes(item.action)) continue;
    assert.ok(markup.includes(`data-action="${item.action}"`), `no markup for ${item.action}`);
  }
});

test("ribbon ids are unique per tab and icons resolve", () => {
  for (const t of RIBBON_TABS) {
    const seen = new Set<string>();
    for (const g of RIBBON_GROUPS[t]) for (const i of g.items) {
      assert.ok(!seen.has(i.action), `duplicate ${i.action} in ${t}`);
      seen.add(i.action);
      const [kind, id] = i.icon.split(":");
      if (kind === "ic") assert.ok(id in TOOLBAR_ICONS, `unknown icon ${i.icon}`);
    }
  }
});

test("sanitizeRibbonTab falls back to the default tab", () => {
  assert.equal(sanitizeRibbonTab("mesh"), "mesh");
  assert.equal(sanitizeRibbonTab("nope"), "view");
});
