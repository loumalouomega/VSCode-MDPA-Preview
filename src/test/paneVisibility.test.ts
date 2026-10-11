import assert from "node:assert/strict";
import test from "node:test";

import {
  describePaneScope,
  isPartlyHidden,
  paneDraws,
  reconcilePaneHidden,
  setPaneHidden,
  validatePaneHidden,
} from "../parser/paneVisibility";

test("a layer with no scope draws in every pane", () => {
  for (let i = 0; i < 4; i++) assert.equal(paneDraws(undefined, i), true);
  assert.equal(paneDraws([1], 0), true);
  assert.equal(paneDraws([1], 1), false);
});

test("setPaneHidden keeps the list sorted and unique, and collapses empty to undefined", () => {
  let h = setPaneHidden(undefined, 2, true);
  assert.deepEqual(h, [2]);
  h = setPaneHidden(h, 0, true);
  assert.deepEqual(h, [0, 2]);
  assert.deepEqual(setPaneHidden(h, 2, true), [0, 2], "hiding twice is idempotent");
  h = setPaneHidden(h, 0, false);
  assert.deepEqual(h, [2]);
  assert.equal(setPaneHidden(h, 2, false), undefined, "showing the last hidden pane clears the scope");
  assert.equal(setPaneHidden(undefined, 1, false), undefined);
});

test("setPaneHidden never mutates its input and ignores nonsense indices", () => {
  const input = [1];
  const out = setPaneHidden(input, 3, true);
  assert.deepEqual(input, [1]);
  assert.deepEqual(out, [1, 3]);
  assert.deepEqual(setPaneHidden(input, -1, true), [1]);
  assert.deepEqual(setPaneHidden(input, 1.5, true), [1]);
  assert.equal(setPaneHidden(undefined, Number.NaN, true), undefined);
});

test("isPartlyHidden only counts panes that exist in the layout", () => {
  assert.equal(isPartlyHidden(undefined, 2), false);
  assert.equal(isPartlyHidden([3], 2), false);
  assert.equal(isPartlyHidden([1], 2), true);
});

test("a layout switch seeds every pane from the kept pane's answer", () => {
  // Kept pane hides the layer -> the whole new layout hides it, then panes diverge.
  assert.deepEqual(reconcilePaneHidden([0, 2], 2, 4), [0, 1, 2, 3]);
  assert.deepEqual(reconcilePaneHidden([1], 1, 2), [0, 1]);
  // Kept pane shows it -> the layer is shown everywhere, even if another pane hid it.
  assert.equal(reconcilePaneHidden([1], 0, 4), undefined);
  assert.equal(reconcilePaneHidden(undefined, 0, 2), undefined);
  assert.equal(reconcilePaneHidden([0], 0, 0), undefined);
});

test("validatePaneHidden keeps valid unique indices and counts what it dropped", () => {
  assert.deepEqual(validatePaneHidden([2, 0, 2]), { hidden: [0, 2], dropped: 0 });
  assert.deepEqual(validatePaneHidden([-1, 4, 1.5, "1", null, 1]), { hidden: [1], dropped: 5 });
  assert.deepEqual(validatePaneHidden("nope"), { hidden: undefined, dropped: 1 });
  assert.deepEqual(validatePaneHidden(undefined), { hidden: undefined, dropped: 0 });
  assert.deepEqual(validatePaneHidden([], 4), { hidden: undefined, dropped: 0 });
  assert.deepEqual(validatePaneHidden([1, 2], 2), { hidden: [1], dropped: 1 }, "maxPanes bounds the index");
});

test("describePaneScope speaks in 1-based pane numbers", () => {
  assert.equal(describePaneScope(undefined, 2), "Shown in every pane");
  assert.equal(describePaneScope([1], 2), "Hidden in pane 2");
  assert.equal(describePaneScope([1, 2], 4), "Hidden in panes 2, 3");
  assert.equal(describePaneScope([0, 1], 2), "Hidden in every pane");
  assert.equal(describePaneScope([3], 2), "Shown in every pane", "a pane that no longer exists is not reported");
});
