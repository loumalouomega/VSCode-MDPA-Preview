import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addPoint, canPlot, clampInput, formatValue, hitPoint, makeScale, movePoint, niceTicks, nudgePoint,
  plotExtent, plotPoints, removePoint,
} from "../problemtype/materialTablePlot";
import { rowsToText, textToRows } from "../problemtype/materialTables";

const rows = (text: string) => textToRows(text).rows;
const BOX = { left: 10, top: 10, width: 200, height: 100 };

test("only rows that parse are drawable, and keep their grid position", () => {
  const r = rows("0,1; hot; 2,5; 3,");
  assert.deepEqual(plotPoints(r), [{ index: 0, x: 0, y: 1 }, { index: 2, x: 2, y: 5 }]);
  assert.equal(canPlot(r), true);
  assert.equal(canPlot(rows("1,2")), false);
  assert.equal(canPlot(rows("")), false);
});

test("the extent pads the data and survives a flat or empty table", () => {
  const e = plotExtent(plotPoints(rows("0,0; 10,100")));
  assert.deepEqual([e.xmin, e.xmax, e.ymin, e.ymax], [-0.6, 10.6, -6, 106]);
  const flat = plotExtent(plotPoints(rows("1,5; 2,5")));
  assert.ok(flat.ymax > flat.ymin, "a constant output still has a span");
  assert.deepEqual(plotExtent([]), { xmin: 0, xmax: 1, ymin: 0, ymax: 1 });
});

test("ticks are round and inside the range", () => {
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(293.15, 373.15, 4), [300, 320, 340, 360]);
  for (const t of niceTicks(0.0001, 0.0009, 4)) assert.ok(t >= 0.0001 && t <= 0.0009);
  assert.deepEqual(niceTicks(3, 3), [3]);
});

test("scales round-trip, y points up, and the pointer clamps to the box", () => {
  const e = { xmin: 0, xmax: 10, ymin: 0, ymax: 100 };
  const s = makeScale(e, BOX);
  assert.deepEqual(s.toPx(0, 0), [10, 110]);
  assert.deepEqual(s.toPx(10, 100), [210, 10]);
  const [x, y] = s.fromPx(...s.toPx(3.5, 42));
  assert.ok(Math.abs(x - 3.5) < 1e-9 && Math.abs(y - 42) < 1e-9);
  assert.deepEqual(s.fromPx(-50, 500), [0, 0]);
  assert.deepEqual(s.fromPx(900, -9), [10, 100]);
});

test("hit testing picks the nearest point within the radius", () => {
  const r = rows("0,0; 5,50; 10,100");
  const pts = plotPoints(r);
  const s = makeScale({ xmin: 0, xmax: 10, ymin: 0, ymax: 100 }, BOX);
  const [px, py] = s.toPx(5, 50);
  assert.equal(hitPoint(pts, s, px + 3, py - 2, 8), 1);
  assert.equal(hitPoint(pts, s, px + 40, py, 8), undefined);
});

test("a drag keeps the input column strictly increasing and leaves the output free", () => {
  const r = rows("0,1; 5,2; 10,3");
  const moved = movePoint(r, 1, 7, 9, 10);
  assert.equal(rowsToText(moved), "0,1; 7,9; 10,3");
  const pastNext = movePoint(r, 1, 99, 2, 10);
  const xs = plotPoints(pastNext).map((p) => p.x);
  assert.ok(xs[1] > xs[0] && xs[1] < xs[2], `clamped between neighbours: ${xs}`);
  const pastPrev = movePoint(r, 1, -99, 2, 10);
  const ys = plotPoints(pastPrev).map((p) => p.x);
  assert.ok(ys[1] > ys[0]);
  // The outer points are free on their open side.
  assert.equal(plotPoints(movePoint(r, 2, 50, 3, 10))[2].x, 50);
  assert.equal(plotPoints(movePoint(r, 0, -50, 1, 10))[0].x, -50);
  // The input rows are not mutated.
  assert.equal(rowsToText(r), "0,1; 5,2; 10,3");
});

test("a drag skips malformed rows when finding neighbours and never moves them", () => {
  const r = rows("0,1; hot; 10,3");
  assert.equal(clampInput(r, 0, 99, 10) < 10, true);
  assert.equal(rowsToText(movePoint(r, 1, 3, 3, 10)), rowsToText(r), "a malformed row is not a point");
});

test("values written back are rounded so a drag leaves tidy text", () => {
  assert.equal(formatValue(0.1 + 0.2), "0.3");
  assert.equal(formatValue(293.1500000001), "293.15");
  assert.equal(Number(formatValue(1.23456789e-4)), 0.000123457);
  const out = movePoint(rows("0,0; 1,1"), 1, 0.7777777777, 0.3333333333, 1);
  assert.equal(rowsToText(out), "0,0; 0.777778,0.333333");
});

test("keyboard nudges move by data steps and stay ordered", () => {
  const r = rows("0,1; 5,2; 10,3");
  assert.equal(rowsToText(nudgePoint(r, 1, 1, 0, 0.5, 0.1)), "0,1; 5.5,2; 10,3");
  assert.equal(rowsToText(nudgePoint(r, 1, 0, -2, 0.5, 0.1)), "0,1; 5,1.8; 10,3");
  const edge = plotPoints(nudgePoint(r, 1, 1000, 0, 1, 1))[1].x;
  assert.ok(edge < 10, "cannot cross the next point");
});

test("adding inserts in input order, refuses a duplicate input and removing keeps one row", () => {
  const r = rows("0,1; 10,3");
  const a = addPoint(r, 4, 2);
  assert.equal(a.inserted, 1);
  assert.equal(rowsToText(a.rows), "0,1; 4,2; 10,3");
  assert.equal(rowsToText(addPoint(r, 20, 9).rows), "0,1; 10,3; 20,9");
  assert.equal(rowsToText(addPoint(r, -3, 0).rows), "-3,0; 0,1; 10,3");
  const dup = addPoint(r, 10, 5);
  assert.equal(dup.inserted, undefined);
  assert.equal(rowsToText(dup.rows), "0,1; 10,3");
  assert.equal(rowsToText(removePoint(r, 0)), "10,3");
  assert.deepEqual(removePoint([{ input: "1", output: "2" }], 0), [{ input: "", output: "" }]);
  // Added to a table with a malformed row, the malformed row stays where it was.
  assert.equal(rowsToText(addPoint(rows("0,1; hot; 10,3"), 5, 2).rows), "0,1; hot,; 5,2; 10,3");
});
