import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutFloatingPanels,
  MIN_STRIP_WIDTH,
  DEFAULT_VIEWPORT,
  type LayoutViewport,
  type PanelInput,
  type PanelPlacement,
} from "../parser/panelLayout";

const card = (over: Partial<PanelInput> = {}): PanelInput => ({
  id: "selection",
  role: "card",
  visible: true,
  naturalWidth: 300,
  naturalHeight: 180,
  minHeight: 80,
  ...over,
});

const strip = (id: string, over: Partial<PanelInput> = {}): PanelInput => ({
  id,
  role: "strip",
  visible: true,
  naturalWidth: 1056,
  naturalHeight: 110,
  minHeight: 60,
  ...over,
});

const viewport = (over: Partial<LayoutViewport> = {}): LayoutViewport => ({ ...DEFAULT_VIEWPORT, ...over });

const byId = (r: PanelPlacement[], id: string): PanelPlacement => {
  const p = r.find((x) => x.id === id);
  assert.ok(p, `no placement for ${id}`);
  return p;
};

/** True when two rectangles share any area. */
const overlaps = (a: PanelPlacement, b: PanelPlacement): boolean =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.bottom < b.bottom + b.height && b.bottom < a.bottom + a.height;

test("the strips sit beside the card when the width allows", () => {
  const r = layoutFloatingPanels([card(), strip("probe"), strip("series")], viewport({ width: 1680 }));
  const sel = byId(r, "selection");
  const probe = byId(r, "probe");
  const series = byId(r, "series");

  // The card keeps the left edge; the strips start at its right edge.
  const v = viewport({ width: 1680 });
  const cardRight = 8 + 300;
  assert.equal(sel.left, 8);
  assert.equal(sel.width, 300);
  assert.equal(probe.left, cardRight + v.gap);
  assert.equal(probe.width, v.width - v.leftInset - v.rightInset - 300 - v.gap);
  // The strips end at the Inspect panel's left edge.
  assert.equal(probe.left + probe.width, v.width - v.rightInset);
  assert.equal(series.left, probe.left);
  assert.equal(series.width, probe.width);

  // All three share the floor: the card is the left column, the strips the right.
  assert.equal(sel.bottom, 60);
  assert.equal(probe.bottom, 60);
  // Within the strip column the second panel stacks above the first.
  assert.ok(series.bottom >= probe.bottom + probe.height);

  for (const a of [sel, probe, series]) for (const b of [sel, probe, series]) if (a !== b) assert.equal(overlaps(a, b), false);
});

test("the strips move below the card when the width runs out", () => {
  const narrow = viewport({ width: 8 + 300 + 8 + MIN_STRIP_WIDTH - 10, height: 800 });
  const r = layoutFloatingPanels([card(), strip("probe")], narrow);
  const sel = byId(r, "selection");
  const probe = byId(r, "probe");

  assert.equal(probe.stacked, true);
  assert.equal(sel.stacked, false);
  // The card is above the strip: the strip takes the floor.
  assert.equal(probe.bottom, narrow.floor);
  assert.ok(sel.bottom >= probe.bottom + probe.height);
  assert.equal(probe.left, 8);
  // Stacked, the strip takes the whole row: nothing is beside it to stop at.
  assert.equal(probe.width, narrow.width - 8);
  assert.equal(overlaps(sel, probe), false);
});

test("a closed panel contributes nothing", () => {
  const r = layoutFloatingPanels([card({ visible: false }), strip("probe")], viewport());
  assert.equal(byId(r, "selection").visible, false);
  assert.equal(byId(r, "selection").height, 0);
  assert.equal(byId(r, "probe").visible, true);
  // With no card, the strip takes the whole row.
  assert.equal(byId(r, "probe").left, 8);
  assert.equal(byId(r, "probe").width, viewport().width - 8 - viewport().rightInset);
});

test("the two strips never overlap each other", () => {
  const r = layoutFloatingPanels([strip("probe"), strip("series", { naturalHeight: 132 })], viewport());
  const probe = byId(r, "probe");
  const series = byId(r, "series");
  assert.equal(overlaps(probe, series), false);
  assert.equal(series.bottom, probe.bottom + probe.height + viewport().gap);
});

test("a tall card is shortened rather than covered", () => {
  const r = layoutFloatingPanels([card({ naturalHeight: 900 }), strip("probe")], viewport({ height: 800, maxHeight: 480 }));
  const sel = byId(r, "selection");
  const probe = byId(r, "probe");
  assert.ok(sel.height <= 480, `the card was ${sel.height} tall`);
  assert.equal(sel.clamped, true);
  assert.equal(overlaps(sel, probe), false);
  // The card's top stays inside the viewport.
  assert.ok(sel.top >= 0, `the card's top was ${sel.top}`);
});

test("nothing is placed outside the viewport", () => {
  for (const size of [
    { width: 1680, height: 1000 },
    { width: 1280, height: 700 },
    { width: 1000, height: 650 },
    { width: 700, height: 500 },
    { width: 480, height: 400 },
  ]) {
    const v = viewport(size);
    const r = layoutFloatingPanels([card({ naturalHeight: 600 }), strip("probe"), strip("series")], v);
    for (const p of r) {
      if (!p.visible) continue;
      assert.ok(p.left >= 0, `left ${p.left} at ${size.width}x${size.height}`);
      assert.ok(p.top >= -0.5, `top ${p.top} at ${size.width}x${size.height}`);
      assert.ok(p.bottom >= -0.5, `bottom ${p.bottom} at ${size.width}x${size.height}`);
      assert.ok(p.left + p.width <= v.width + 0.5, `right ${p.left + p.width} at ${size.width}x${size.height}`);
    }
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        if (!r[i].visible || !r[j].visible) continue;
        assert.equal(overlaps(r[i], r[j]), false, `${r[i].id} overlaps ${r[j].id} at ${size.width}x${size.height}`);
      }
    }
  }
});

test("the cluster clears the nav dock's floor", () => {
  const v = viewport();
  const r = layoutFloatingPanels([card(), strip("probe")], v);
  for (const p of r) {
    if (!p.visible) continue;
    assert.ok(p.bottom >= v.floor - 0.5, `${p.id} starts below the floor (${p.bottom} < ${v.floor})`);
  }
});

test("a strip is never narrower than the minimum it needs", () => {
  const v = viewport({ width: 8 + 300 + 8 + MIN_STRIP_WIDTH - 1 });
  const r = layoutFloatingPanels([card(), strip("probe")], v);
  // Below the minimum the strip stacks rather than shrinking to nothing.
  assert.equal(byId(r, "probe").stacked, true);
  assert.ok(byId(r, "probe").width >= MIN_STRIP_WIDTH);
});

test("the card keeps its width on a narrow viewport, and the strip goes under it", () => {
  // The viewport is too narrow for the card AND the right-hand Inspect panel
  // side by side. The card keeps its 300px — a squeezed form is unusable —
  // and the strip takes the row below it.
  const v = viewport({ width: 500, height: 600 });
  const r = layoutFloatingPanels([card(), strip("probe")], v);
  const sel = byId(r, "selection");
  const probe = byId(r, "probe");
  assert.equal(sel.width, 300);
  assert.equal(probe.stacked, true);
  assert.equal(probe.left, v.leftInset);
  assert.equal(probe.width, v.width - v.leftInset);
  // The strip is under the card, and the card is above it.
  assert.ok(probe.bottom + probe.height <= sel.bottom + 0.5);
  assert.equal(overlaps(sel, probe), false);
});

test("a card wider than the viewport is clamped to it", () => {
  const v = viewport({ width: 260 });
  const r = layoutFloatingPanels([card(), strip("probe")], v);
  const sel = byId(r, "selection");
  const probe = byId(r, "probe");
  assert.ok(sel.width <= v.width - v.leftInset, `the card was ${sel.width} wide in a ${v.width}px viewport`);
  assert.ok(sel.left + sel.width <= v.width + 0.5);
  assert.equal(overlaps(sel, probe), false);
  assert.ok(probe.left + probe.width <= v.width + 0.5);
});

test("the strip column ends at the Inspect panel's left edge", () => {
  const v = viewport({ width: 1680 });
  const r = layoutFloatingPanels([card(), strip("probe"), strip("series")], v);
  for (const id of ["probe", "series"]) {
    const p = byId(r, id);
    assert.equal(p.left + p.width, v.width - v.rightInset);
  }
});
