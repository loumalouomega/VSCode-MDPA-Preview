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
    layerPaneHidden: {},
    selections: [],
    panels: [],
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
  const picks = { name: "picks", seed: { kind: "explicit" as const }, kinds: { Elements: [1], Conditions: [], Geometries: [] } };
  const hot = { name: "hot", seed: { kind: "field" as const, variable: "T", blockKind: "Nodal" as const, lo: 0, hi: 1, component: 2 as const, rule: "any" as const }, kinds: { Elements: [], Conditions: [], Geometries: [] } };
  v.selections = [picks, hot];
  const out = serializeViewState(v);
  const back = out.bookmarks as { state: { position: number[] } }[];
  back[0].state.position[0] = 99;
  assert.equal(v.bookmarks[0].state.position[0], 1);
  const sel = out.selections as { name: string; seed: Record<string, unknown>; kinds?: { Elements: number[] } }[];
  sel[0].kinds!.Elements.push(42);
  (sel[1].seed as { hi: number }).hi = 7;
  assert.deepEqual(v.selections[0].kinds.Elements, [1], "the id snapshot is copied");
  assert.equal(v.selections[1].seed.kind === "field" ? v.selections[1].seed.hi : undefined, 1, "the seed is copied");
  // A predicate seed keeps exactly the keys it was authored with, so a
  // serialize → parse → serialize round trip is stable.
  const fresh = serializeViewState(v).selections as { seed: Record<string, unknown> }[];
  assert.deepEqual(fresh[1].seed, { kind: "field", variable: "T", blockKind: "Nodal", lo: 0, hi: 1, component: 2, rule: "any" });
});

test("per-pane layer visibility round-trips, and is absent from the file when unused", () => {
  const v = { ...sample(), layerPaneHidden: { "block:Elements:Tri": [1], "smp:Inlet": [0, 2] } };
  const back = parseViewSidecar(serializeViewSidecar([], undefined, v));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.view?.layerPaneHidden, { "block:Elements:Tri": [1], "smp:Inlet": [0, 2] });
  const plain = serializeViewState(sample());
  assert.equal("layerPaneHidden" in plain, false, "a sidecar nobody scoped stays as older versions wrote it");
  assert.ok(!isEmptyViewState({ ...emptyViewState(), layerPaneHidden: { a: [1] } }), "a scope alone is worth writing");
});

test("layerPaneHidden reads are tolerant per entry", () => {
  const r = validateViewState({
    layerPaneHidden: { good: [1, 0, 1], mixed: [2, -1, "x", 9], empty: [], notArray: 3 },
  });
  assert.deepEqual(r.view.layerPaneHidden, { good: [0, 1], mixed: [2] });
  assert.equal(r.warnings.filter((w) => /mixed/.test(w)).length, 1);
  assert.equal(r.warnings.filter((w) => /notArray/.test(w)).length, 1);
  assert.deepEqual(validateViewState({ layerPaneHidden: [1] }).view.layerPaneHidden, {});
  assert.match(validateViewState({ layerPaneHidden: [1] }).warnings.join(" "), /layerPaneHidden is malformed/);
});

test("prune drops pane scopes of vanished layers and panes the saved layout lacks", () => {
  const v = { ...sample(), paneLayout: "2x1" as const, layerPaneHidden: { "smp:Inlet": [1, 3], "block:gone": [0], "smp:Wall": [3] } };
  const { view, dropped } = pruneViewState(v, {
    fieldKeys: new Set(["Nodal:TEMP"]),
    layerIds: new Set(["smp:Inlet", "smp:Wall", "block:Elements:Tri"]),
  });
  assert.deepEqual(view.layerPaneHidden, { "smp:Inlet": [1] }, "pane 4 does not exist in 2x1; an emptied scope is removed");
  assert.equal(dropped.length, 1, "the vanished layer is reported");
  assert.deepEqual(v.layerPaneHidden["smp:Inlet"], [1, 3], "input is not mutated");
});

test("the compared-run identity round-trips, reads tolerantly and is absent when unlinked", () => {
  const v = { ...sample(), link: { peers: ["../run2/out.vtu"], settings: { camera: true, field: false, range: true, clip: true, time: true, timeMethod: "nearest" as const, timeTolerance: 0.5, paneScope: "all" as const, timeOffset: 5, timeScale: 1000 } } };
  const back = parseViewSidecar(serializeViewSidecar([], undefined, v));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.view?.link, v.link);
  assert.equal("link" in serializeViewState(sample()), false);
  assert.ok(!isEmptyViewState({ ...emptyViewState(), link: v.link }));
  const bad = validateViewState({ link: { peers: [1, "ok.vtu"], settings: { timeMethod: "weird" } } });
  assert.deepEqual(bad.view.link?.peers, ["ok.vtu"]);
  assert.equal(bad.view.link?.settings.timeMethod, "exact");
  assert.equal(validateViewState({ link: "x" }).view.link, undefined);
});

test("selection sets round-trip through the sidecar and carry over a prune untouched", () => {
  const picks = { name: "picked", seed: { kind: "explicit" as const }, kinds: { Elements: [7, 3], Conditions: [], Geometries: [1] } };
  const seeded = { name: "hot", seed: { kind: "field" as const, variable: "TEMP", blockKind: "Nodal" as const, lo: 10, hi: 20, rule: "all" as const }, kinds: { Elements: [] as number[], Conditions: [] as number[], Geometries: [] as number[] } };
  const v = { ...sample(), selections: [picks, seeded] };
  const back = parseViewSidecar(serializeViewSidecar([], undefined, v));
  assert.deepEqual(back.warnings, []);
  // The explicit snapshot survives; the predicate keeps its seed only.
  assert.deepEqual(back.view?.selections[0].kinds, { Elements: [3, 7], Conditions: [], Geometries: [1] });
  assert.equal("kinds" in (serializeViewState(v).selections as object[])[1], false, "a predicate set writes its definition, not its answer");
  assert.deepEqual(back.view?.selections[1].seed, seeded.seed);
  assert.deepEqual(back.view?.selections[1].kinds, { Elements: [], Conditions: [], Geometries: [] }, "the live set re-resolves its ids on open");
  // A sidecar with only selection sets is still worth writing.
  assert.ok(!isEmptyViewState({ ...emptyViewState(), selections: [picks] }));
  assert.equal("selections" in serializeViewState(sample()), false);
  // `refreshSelection` owns the refresh rule, so prune passes sets straight through.
  const { view, dropped } = pruneViewState(v, { fieldKeys: new Set(["Nodal:TEMP"]), layerIds: new Set(["smp:Inlet", "block:Elements:Tri"]) });
  assert.deepEqual(view.selections, v.selections);
  assert.equal(dropped.length, 0);
});

test("selection set reads are tolerant per entry", () => {
  const ok = { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [2, 2, 9, "x", -1], Conditions: [5], Geometries: [] } };
  const r = validateViewState({
    selections: [ok, { name: "  ", seed: { kind: "part", path: "Inlet" } }, { name: "bad seed", seed: { kind: "nope" } }, 4, { name: "gone", seed: { kind: "explicit" } }, ok],
  });
  assert.deepEqual(r.view.selections.map((s) => s.name), ["picks", "picks (2)"]);
  assert.deepEqual(r.view.selections[0].kinds.Elements, [2, 9]);
  assert.deepEqual(r.view.selections[0].kinds.Conditions, [5]);
  assert.equal(validateViewState({ selections: "x" }).view.selections.length, 0);
  assert.equal(validateViewState({ selections: {} }).warnings[0], "View sidecar selections are not an array — ignored.");
});

test("a persisted predicate set's stale snapshot is not read back", () => {
  const r = validateViewState({
    selections: [{ name: "stale", seed: { kind: "part", path: "Inlet" }, kinds: { Elements: [99], Conditions: [], Geometries: [] } }],
  });
  assert.deepEqual(r.view.selections[0].kinds, { Elements: [], Conditions: [], Geometries: [] });
  assert.deepEqual(r.warnings, []);
});

test("open panels round-trip, and no key is written when none are open", () => {
  const v = { ...sample(), panels: ["link", "quality", "quality", "nope", 7] as never };
  const back = parseViewSidecar(serializeViewSidecar([], undefined, v));
  // Deduplicated, in PANEL_IDS order, unknown entries dropped with warnings.
  assert.deepEqual(back.view?.panels, ["quality", "link"]);
  assert.equal(back.warnings.filter((w) => /unknown — dropped/.test(w)).length, 2, "both the unknown id and the non-string are named");
  assert.equal(back.warnings.filter((w) => /repeated — opened once/.test(w)).length, 1);
  assert.equal("panels" in serializeViewState(sample()), false, "a sidecar with no open panels stays as older versions wrote it");
  assert.ok(!isEmptyViewState({ ...emptyViewState(), panels: ["quality"] }), "an open panel alone is worth writing");
  assert.deepEqual(validateViewState({ panels: "x" }).view.panels, []);
  assert.deepEqual(validateViewState({ panels: 3 }).warnings.length, 1);
});

test("a pane's compare peer round-trips and reads tolerantly", () => {
  const v = sample();
  v.panes[0].comparePeer = "../run2/other.vtu";
  const back = parseViewSidecar(serializeViewSidecar([], undefined, v));
  assert.deepEqual(back.warnings, []);
  assert.equal(back.view?.panes[0].comparePeer, "../run2/other.vtu");
  // A pane without a peer writes no key; prune carries the peer through.
  const plainPanes = serializeViewState(sample()).panes as Record<string, unknown>[];
  assert.equal("comparePeer" in plainPanes[0], false);
  const { view } = pruneViewState(v, { fieldKeys: new Set(["Nodal:TEMP"]) });
  assert.equal(view.panes[0].comparePeer, "../run2/other.vtu");
  const bad = validateViewState({ panes: [{ comparePeer: 7 }] });
  assert.equal(bad.view.panes[0].comparePeer, undefined);
  assert.equal(bad.warnings.filter((w) => /comparePeer/.test(w)).length, 1);
});
