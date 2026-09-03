import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PaneViewState,
  clonePaneFieldState,
  clonePaneViewState,
  defaultPaneClipState,
  defaultPaneFieldState,
  defaultPaneViewState,
  paneLabel,
  reconcilePaneStates,
} from "../parser/paneView";

test("default field state starts on contour with no overrides", () => {
  const s = defaultPaneFieldState("Rainbow");
  assert.equal(s.colormap, "Rainbow");
  assert.deepEqual([...s.modes], ["contour"]);
  assert.equal(s.component, "mag");
  assert.equal(s.rangeOverride, undefined);
  assert.equal(s.thresholdRange, undefined);
  assert.equal(s.thresholdRule, "all");
});

test("default clip state is an inactive Z plane at mid-extent", () => {
  const c = defaultPaneClipState();
  assert.equal(c.active, false);
  assert.equal(c.axis, 2);
  assert.equal(c.t, 0.5);
  assert.deepEqual(c.freeNormal, [0, 0, 1]);
});

// The reason this module exists: a `{...state}` spread shares the Set and the
// arrays, so two panes would silently move together.
test("cloning a field state shares no mutable member", () => {
  const a = defaultPaneFieldState("Viridis");
  a.isoValues = [1, 2];
  a.rangeOverride = [0, 10];
  a.thresholdRange = [1, 5];
  const b = clonePaneFieldState(a);

  b.modes.add("quiver");
  b.isoValues.push(3);
  b.rangeOverride![1] = 99;
  b.thresholdRange![0] = -1;

  assert.deepEqual([...a.modes], ["contour"]);
  assert.deepEqual(a.isoValues, [1, 2]);
  assert.deepEqual(a.rangeOverride, [0, 10]);
  assert.deepEqual(a.thresholdRange, [1, 5]);
});

test("cloning a view state shares no clip member", () => {
  const a = defaultPaneViewState("Viridis");
  const b = clonePaneViewState(a);
  b.clip.freeNormal[0] = 5;
  b.clip.active = true;
  assert.deepEqual(a.clip.freeNormal, [0, 0, 1]);
  assert.equal(a.clip.active, false);
});

function marked(key: string): PaneViewState {
  const s = defaultPaneViewState("Rainbow");
  s.field.selectedKey = key;
  return s;
}

test("growing a layout seeds every new pane from the focused one", () => {
  const prev = [marked("A")];
  const next = reconcilePaneStates(prev, 0, 4, "Rainbow");
  assert.equal(next.length, 4);
  for (const p of next) assert.equal(p.field.selectedKey, "A");
  // Seeded, not aliased.
  next[1].field.modes.add("iso");
  assert.deepEqual([...next[0].field.modes], ["contour"]);
  assert.notEqual(next[0], next[1]);
});

test("shrinking a layout keeps the focused pane as pane 0", () => {
  const prev = [marked("A"), marked("B"), marked("C"), marked("D")];
  const next = reconcilePaneStates(prev, 2, 2, "Rainbow");
  assert.equal(next.length, 2);
  assert.equal(next[0].field.selectedKey, "C");
  assert.equal(next[1].field.selectedKey, "C");
});

test("reconcile never returns the previous objects, so a discarded pane cannot alias a kept one", () => {
  const prev = [marked("A"), marked("B")];
  const next = reconcilePaneStates(prev, 1, 1, "Rainbow");
  assert.equal(next[0].field.selectedKey, "B");
  assert.notEqual(next[0], prev[1]);
  assert.notEqual(next[0].field.modes, prev[1].field.modes);
});

// focusedPaneIndex() degrades to 0 when the interactor reports a renderer that
// is not a pane, so an out-of-range index must not throw here either.
test("an out-of-range keep index falls back to pane 0", () => {
  const prev = [marked("A"), marked("B")];
  assert.equal(reconcilePaneStates(prev, 7, 2, "Rainbow")[0].field.selectedKey, "A");
  assert.equal(reconcilePaneStates([], 0, 2, "Turbo")[0].field.colormap, "Turbo");
});

test("paneLabel is absent in a single-pane layout", () => {
  assert.equal(paneLabel(0, 1), undefined);
  assert.equal(paneLabel(1, 4), "Pane 2 of 4");
});
