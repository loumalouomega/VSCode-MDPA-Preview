import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultPaneClipState, defaultPaneFieldState } from "../parser/paneView";
import { emptyViewState, serializeViewState } from "../parser/viewState";
import { toTemplate, parseViewTemplate, applyViewTemplate, isValidTemplateName } from "../parser/viewTemplate";
import { discoverViewTemplates, writeViewTemplate, viewTemplateDirs } from "../viewTemplatesIO";

function sampleView() {
  const v = emptyViewState();
  const field = defaultPaneFieldState("Viridis");
  field.selectedKey = "Nodal:TEMPERATURE";
  field.rangeOverride = [10, 90];
  const saved = { ...field, modes: ["contour" as const] };
  v.paneLayout = "1x1" as never;
  v.panes = [{ field: saved, clip: defaultPaneClipState(), comparePeer: "other/run.vtu" }];
  v.selections = [{ name: "S", seed: { kind: "explicit" } } as never];
  v.link = { peers: ["x.vtu"] } as never;
  v.layerVisibility = { "block:Elements:Q": false };
  return v;
}

test("a template drops file-specific parts and keeps presentation", () => {
  const t = toTemplate(sampleView(), "Temperature contour");
  assert.equal("link" in t.view, false);
  assert.equal("selections" in t.view, false);
  const pane = (t.view.panes as { field: { colormap: string; rangeOverride?: unknown }; comparePeer?: string }[])[0];
  assert.equal(pane.field.colormap, "Viridis");
  assert.equal(pane.field.rangeOverride, undefined);
  assert.equal(pane.comparePeer, undefined);
  assert.deepEqual(t.view.layerVisibility, { "block:Elements:Q": false });
});

test("keepRanges keeps the typed range", () => {
  const t = toTemplate(sampleView(), "Fixed range", { keepRanges: true });
  const pane = (t.view.panes as { field: { rangeOverride?: number[] } }[])[0];
  assert.deepEqual(pane.field.rangeOverride, [10, 90]);
});

test("applying names the missing field and layer and applies the rest", () => {
  const t = toTemplate(sampleView(), "T");
  const ok = applyViewTemplate(t, { fieldKeys: new Set(["Nodal:TEMPERATURE"]), layerIds: new Set(["block:Elements:Q"]) });
  assert.deepEqual(ok.unmatched, []);
  assert.equal(ok.view.panes[0].field.selectedKey, "Nodal:TEMPERATURE");
  const miss = applyViewTemplate(t, { fieldKeys: new Set(), layerIds: new Set() });
  assert.ok(miss.unmatched.some((m) => m.includes("Nodal:TEMPERATURE")));
  assert.equal(miss.view.panes[0].field.colormap, "Viridis");
});

test("parse is tolerant: bad JSON, wrong shape and a newer version give no template", () => {
  assert.equal(parseViewTemplate("{").template, undefined);
  assert.equal(parseViewTemplate("{}").template, undefined);
  assert.equal(parseViewTemplate(JSON.stringify({ version: 9, name: "x", view: {} })).template, undefined);
  assert.ok(parseViewTemplate(JSON.stringify({ version: 1, name: "x", view: {} })).template);
});

test("names are restricted like file names", () => {
  assert.ok(isValidTemplateName("Sweep A-1"));
  assert.ok(!isValidTemplateName("../x"));
  assert.ok(!isValidTemplateName(""));
  assert.throws(() => toTemplate(emptyViewState(), "a/b"));
});

test("templates round trip through the views folder and recipe scans never see them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vtpl-"));
  const dir = viewTemplateDirs([root], [".kratos/recipes"])[0];
  const t = toTemplate(sampleView(), "Sweep row");
  const file = writeViewTemplate(dir, t);
  assert.throws(() => writeViewTemplate(dir, t), /already exists/);
  writeViewTemplate(dir, t, true);
  fs.writeFileSync(path.join(dir, "broken.json"), "nope");
  const found = discoverViewTemplates([root], [".kratos/recipes"]);
  assert.deepEqual(found.templates.map((x) => x.name), ["Sweep row"]);
  assert.equal(found.templates[0].file, file);
  assert.equal(found.problems.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((n) => n.endsWith(".json")), []);
  void serializeViewState;
});
