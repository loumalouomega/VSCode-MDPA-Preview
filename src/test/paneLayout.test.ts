/**
 * paneLayout.ts — which part of the render window each split-view pane gets.
 *
 * The load-bearing property is that a layout TILES the window exactly: no gap
 * (a strip of nothing rendered) and no overlap (two cameras fighting over the
 * same pixels, where vtk.js would hand interaction to whichever renderer it
 * found first). Asserting rect literals would not catch a bad edit that keeps
 * the numbers plausible, so the tiling is checked by area arithmetic instead.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PANE_LAYOUTS,
  PANE_LAYOUT_LABELS,
  PaneViewport,
  isPaneLayout,
  paneCount,
  paneCssRect,
  paneViewports,
} from "../parser/paneLayout";

/** Area of the intersection of two rects — 0 when they do not overlap. */
function overlapArea(a: PaneViewport, b: PaneViewport): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function area(r: PaneViewport): number {
  return (r[2] - r[0]) * (r[3] - r[1]);
}

test("every layout tiles the unit square exactly", () => {
  for (const layout of PANE_LAYOUTS) {
    const rects = paneViewports(layout);
    // No gaps: the areas sum to the whole window...
    const total = rects.reduce((s, r) => s + area(r), 0);
    assert.equal(total, 1, `${layout} leaves a gap or spills over`);
    // ...and no overlaps, which the sum alone cannot prove.
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.equal(overlapArea(rects[i], rects[j]), 0, `${layout} panes ${i}/${j} overlap`);
      }
    }
    // Every rect is inside the window and non-degenerate.
    for (const r of rects) {
      assert.ok(r[0] >= 0 && r[1] >= 0 && r[2] <= 1 && r[3] <= 1, `${layout} rect out of bounds`);
      assert.ok(r[2] > r[0] && r[3] > r[1], `${layout} has a zero-size pane`);
    }
  }
});

test("paneCount agrees with the rects, and every layout is labelled", () => {
  for (const layout of PANE_LAYOUTS) {
    assert.equal(paneViewports(layout).length, paneCount(layout));
    assert.ok(PANE_LAYOUT_LABELS[layout], `${layout} has no menu label`);
  }
  assert.deepEqual(
    PANE_LAYOUTS.map(paneCount),
    [1, 2, 2, 4]
  );
});

test("index 0 is the top-left pane in every layout", () => {
  // Reading order vs vtk.js's bottom-left origin is the one thing here that is
  // easy to get backwards: the FIRST pane must have the highest top edge and
  // the lowest left edge.
  for (const layout of PANE_LAYOUTS) {
    const rects = paneViewports(layout);
    const top = Math.max(...rects.map((r) => r[3]));
    const left = Math.min(...rects.map((r) => r[0]));
    assert.equal(rects[0][3], top, `${layout} pane 0 is not the topmost`);
    assert.equal(rects[0][0], left, `${layout} pane 0 is not the leftmost`);
  }
  // Stacked in particular: the top pane leads, so it holds the HIGHER y range.
  assert.deepEqual(paneViewports("2x1"), [
    [0, 0.5, 1, 1],
    [0, 0, 1, 0.5],
  ]);
});

test("1x1 is the whole window", () => {
  assert.deepEqual(paneViewports("1x1"), [[0, 0, 1, 1]]);
});

test("the returned rects are copies, not the shared table", () => {
  const first = paneViewports("1x2");
  first[0][2] = 0.9;
  assert.deepEqual(paneViewports("1x2")[0], [0, 0, 0.5, 1]);
});

test("paneCssRect flips the origin for the DOM overlay", () => {
  // Bottom-left [0,0,1,0.5] is the BOTTOM half, so in CSS it starts at 50% down.
  assert.deepEqual(paneCssRect([0, 0, 1, 0.5]), { left: 0, top: 50, width: 100, height: 50 });
  // ...and the top half starts at 0.
  assert.deepEqual(paneCssRect([0, 0.5, 1, 1]), { left: 0, top: 0, width: 100, height: 50 });
  assert.deepEqual(paneCssRect([0.5, 0, 1, 1]), { left: 50, top: 0, width: 50, height: 100 });
});

test("isPaneLayout rejects anything not in the table", () => {
  assert.ok(isPaneLayout("2x2"));
  assert.ok(!isPaneLayout("3x3"));
  assert.ok(!isPaneLayout(""));
  assert.ok(!isPaneLayout(undefined));
});
