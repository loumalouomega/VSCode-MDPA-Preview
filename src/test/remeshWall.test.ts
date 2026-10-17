import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOpAsync, opRecordFromMessage, parseOpsJson, serializeOps } from "../parser/operations";
import { buildTunnelBackground, gradedAxis } from "../problemtype/windTunnel/backgroundMesh";

const axis = (a: number, b: number) => gradedAxis({ min: a, max: b, focusMin: a, focusMax: b, fine: 0.25, coarse: 0.25, growth: 1 });

async function box() {
  const m = buildTunnelBackground(axis(0, 2), axis(0, 2), axis(0, 2));
  const r = await applyOpAsync(m, { op: "fieldCalc", expr: "x", location: "Nodal", output: "d" });
  assert.ok(!r.noop, r.message ?? "");
  return r.model;
}

test("a wall remesh stretches the cells along the wall: thin across it, wide along it", async () => {
  const start = await box();
  const r = await applyOpAsync(start, {
    op: "remesh", mode: "wall", variable: "d", firstHeight: 0.04, growth: 1.3, tangentialSize: 0.3, maxAspect: 12, tangentialGrowth: 0.2, hmax: 0.5, hmin: 0.03, hausd: 0.05,
  });
  assert.ok(!r.noop, r.message ?? "");
  assert.match(r.message ?? "", /wall layer/);
  const m = r.model;
  const ix = new Map(Array.from(m.nodeIds, (id, i) => [id, i]));
  // Edge extent along x (across the wall x = 0) versus along y, for tets whose centroid is near the wall.
  let nearAcross = 0;
  let nearAlong = 0;
  let n = 0;
  for (const b of m.blocks) {
    if (b.stride !== 4) continue;
    for (let c = 0; c < b.count; c++) {
      const pts = [0, 1, 2, 3].map((k) => ix.get(b.connectivity[c * 4 + k])!);
      const xs = pts.map((i) => m.coords[3 * i]);
      const ys = pts.map((i) => m.coords[3 * i + 1]);
      const cx = xs.reduce((a, v) => a + v, 0) / 4;
      if (cx > 0.12) continue;
      nearAcross += Math.max(...xs) - Math.min(...xs);
      nearAlong += Math.max(...ys) - Math.min(...ys);
      n++;
    }
  }
  assert.ok(n > 20, "cells exist near the wall");
  assert.ok(nearAlong / n > 2 * (nearAcross / n), `cells are stretched along the wall (${(nearAlong / n).toFixed(3)} vs ${(nearAcross / n).toFixed(3)})`);
});

test("a wall remesh refuses what it cannot build a layer from", async () => {
  const start = await box();
  const noField = await applyOpAsync(start, { op: "remesh", mode: "wall", variable: "nope", firstHeight: 0.04 });
  assert.ok(noField.noop);
  assert.match(noField.message ?? "", /not a scalar nodal field/);
});

test("the wall record is validated, round-trips a recipe and rejects a bad value", () => {
  assert.equal(opRecordFromMessage({ op: "remesh", mode: "wall", variable: "d" }), undefined);
  assert.equal(opRecordFromMessage({ op: "remesh", mode: "wall", variable: "d", firstHeight: 0 }), undefined);
  assert.equal(opRecordFromMessage({ op: "remesh", mode: "wall", variable: "d", firstHeight: 0.01, growth: 0.5 }), undefined);
  const rec = opRecordFromMessage({ op: "remesh", mode: "wall", variable: "d", firstHeight: 0.01, growth: 1.2, maxAspect: 20, tangentialSize: 0.1, tangentialGrowth: 0.3 });
  assert.ok(rec);
  const text = serializeOps([rec!], "m.mdpa");
  const back = parseOpsJson(text);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.operations, [rec]);
});
