/**
 * Reopenable view state (viewState.ts): tolerant reads, the Set/array
 * conversion, and "refresh by definition" pruning.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defaultPaneClipState, defaultPaneFieldState } from "../parser/paneView";
import { parseViewSidecar, serializeViewSidecar } from "../parser/userLayers";
import {
  ViewState,
  emptyViewState,
  fieldToSaved,
  isEmptyViewState,
  pruneViewState,
  savedToField,
  serializeViewState,
  validateViewState,
} from "../parser/viewState";

const cam = { position: [1, 2, 3], focalPoint: [0, 0, 0], viewUp: [0, 1, 0], parallelScale: 4 };

function sample(): ViewState {
  const field = fieldToSaved({ ...defaultPaneFieldState("Viridis"), selectedKey: "Nodal:TEMP", rangeOverride: [1, 2], isoValues: [0.5] });
  field.modes = ["contour", "iso"];
  return {
    bookmarks: [{ name: "front", state: cam as never }],
    paneLayout: "2x1",
    fieldPanel: true,
    panes: [{ field, clip: { ...defaultPaneClipState(), active: true, t: 0.75 }, camera: cam as never }],
    layerVisibility: { "block:Elements:Tri": false },
    layerOpacity: { "smp:Inlet": 0.5 },
  };
}

test("absent view is the silent empty state", () => {
  const r = validateViewState(undefined);
  assert.deepEqual(r.warnings, []);
  assert.ok(isEmptyViewState(r.view));
});

test("a view state round-trips through the sidecar document", () => {
  const text = serializeViewSidecar([], undefined, sample());
  const back = parseViewSidecar(text);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.view, sample());
  // Nothing worth writing means no key at all.
  assert.equal(JSON.parse(serializeViewSidecar([], undefined, emptyViewState())).view, undefined);
});

test("modes survive as an array and rebuild as a fresh Set", () => {
  const saved = sample().panes[0].field;
  const a = savedToField(saved);
  const b = savedToField(saved);
  assert.ok(a.modes instanceof Set);
  assert.deepEqual([...a.modes], ["contour", "iso"]);
  a.modes.add("quiver");
  a.isoValues.push(9);
  assert.equal(b.modes.has("quiver"), false);
  assert.deepEqual(b.isoValues, [0.5]);
});

test("malformed entries are dropped per entry with warnings", () => {
  const { view, warnings } = validateViewState({
    bookmarks: [{ name: "ok", state: cam }, { name: "bad", state: { position: 1 } }, { name: "ok", state: cam }, 5],
    paneLayout: "3x3",
    panes: [{ field: { selectedKey: 7, modes: ["contour", "nope"], bands: 99999, scale: -1 }, clip: { axis: "diag", t: 9, freeNormal: [0, 0, 0] }, camera: { position: [] } }, "x"],
    layerVisibility: { a: true, b: "yes" },
    layerOpacity: { a: 2, b: "x", c: -1 },
  });
  assert.deepEqual(view.bookmarks.map((b) => b.name), ["ok"]);
  assert.equal(view.paneLayout, undefined);
  assert.equal(view.panes.length, 2);
  const f = view.panes[0].field;
  assert.equal(f.selectedKey, "");
  assert.deepEqual(f.modes, ["contour"]);
  assert.equal(f.bands, 256);
  assert.equal(f.scale, 1);
  const c = view.panes[0].clip;
  assert.equal(c.axis, 2);
  assert.equal(c.t, 1);
  assert.deepEqual(c.freeNormal, [0, 0, 1]);
  assert.equal(view.panes[0].camera, undefined);
  assert.deepEqual(view.layerVisibility, { a: true });
  assert.deepEqual(view.layerOpacity, { a: 1, c: 0 });
  assert.ok(warnings.length >= 8);
});

test("non-object view and wrong container types degrade, never throw", () => {
  assert.ok(isEmptyViewState(validateViewState("x").view));
  const r = validateViewState({ bookmarks: {}, panes: 3, layerVisibility: [], layerOpacity: 1 });
  assert.ok(isEmptyViewState(r.view));
  assert.equal(r.warnings.length, 4);
});

test("pane and bookmark counts are capped", () => {
  const panes = Array.from({ length: 9 }, () => ({}));
  assert.equal(validateViewState({ panes }).view.panes.length, 4);
  const bookmarks = Array.from({ length: 150 }, (_, i) => ({ name: `b${i}`, state: cam }));
  assert.equal(validateViewState({ bookmarks }).view.bookmarks.length, 100);
});

test("prune drops vanished fields and layers, keeps presentation choices, and reports", () => {
  const v = sample();
  v.panes[0].field.deformKey = "Nodal:DISP";
  v.panes[0].field.thresholdRange = [0, 1];
  v.panes[0].field.colormap = "Viridis";
  const { view, dropped } = pruneViewState(v, {
    fieldKeys: new Set(["Nodal:PRESSURE"]),
    layerIds: new Set(["smp:Inlet"]),
  });
  const f = view.panes[0].field;
  assert.equal(f.selectedKey, "");
  assert.equal(f.deformKey, "");
  assert.equal(f.rangeOverride, undefined);
  assert.equal(f.thresholdRange, undefined);
  assert.deepEqual(f.isoValues, []);
  assert.equal(f.colormap, "Viridis");
  assert.deepEqual(view.layerVisibility, {});
  assert.deepEqual(view.layerOpacity, { "smp:Inlet": 0.5 });
  assert.equal(dropped.length, 3);
  // Input is not mutated.
  assert.equal(v.panes[0].field.selectedKey, "Nodal:TEMP");
  assert.equal(v.layerVisibility["block:Elements:Tri"], false);
});

test("prune without layer ids leaves layer settings alone; matching fields survive", () => {
  const v = sample();
  const { view, dropped } = pruneViewState(v, { fieldKeys: new Set(["Nodal:TEMP"]) });
  assert.deepEqual(dropped, []);
  assert.deepEqual(view, v);
});

test("serializeViewState output shares no references with its input", () => {
  const v = sample();
  const out = serializeViewState(v) as { bookmarks: { state: { position: number[] } }[] };
  out.bookmarks[0].state.position[0] = 99;
  assert.equal(v.bookmarks[0].state.position[0], 1);
});
