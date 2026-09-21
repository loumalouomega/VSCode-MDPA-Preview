import assert from "node:assert/strict";
import test from "node:test";

import { probeAlongPath, probeToCsv, samplePolyline } from "../parser/pathProbe";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";

const model = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/** Two triangles over the unit square with T = x + 2y and V = (x, y, 0). */
const SQUARE =
  "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\n2 0 1 3 4\nEnd Elements\n" +
  "Begin NodalData T\n1 0 0\n2 0 1\n3 0 3\n4 0 2\nEnd NodalData\n" +
  "Begin NodalData V\n1 0 (0,0,0)\n2 0 (1,0,0)\n3 0 (1,1,0)\n4 0 (0,1,0)\nEnd NodalData\n";

test("a straight line through a linear field reproduces it exactly, with distance as the abscissa", async () => {
  const r = await probeAlongPath(model(SQUARE), { points: [[0, 0, 0], [1, 1, 0]], samples: 5, variable: "T" });
  assert.equal(r.rows.length, 5);
  assert.ok(Math.abs(r.length - Math.SQRT2) < 1e-12);
  for (const row of r.rows) {
    const t = row.distance / Math.SQRT2;
    assert.ok(Math.abs(row.values[0]! - 3 * t) < 1e-6, `T(${t}) = ${row.values[0]}`);
  }
  assert.equal(r.covered, 5);
  assert.deepEqual(r.columns, ["T"]);
});

test("a vector field probes every component, named like the data table's columns", async () => {
  const r = await probeAlongPath(model(SQUARE), { points: [[0.25, 0.5, 0], [0.75, 0.5, 0]], samples: 3, variable: "V" });
  assert.deepEqual(r.columns, ["V_X", "V_Y", "V_Z"]);
  assert.ok(Math.abs(r.rows[1].values[0]! - 0.5) < 1e-6 && Math.abs(r.rows[1].values[1]! - 0.5) < 1e-6);
});

test("a path that leaves the domain shows GAPS, never a fabricated flat stretch", async () => {
  const r = await probeAlongPath(model(SQUARE), { points: [[0.5, 0.5, 0], [3, 0.5, 0]], samples: 6, variable: "T" });
  assert.ok(r.covered > 0 && r.uncovered > 0);
  assert.equal(r.rows[0].values[0] !== null, true);
  assert.equal(r.rows[5].values[0], null);
  const csv = probeToCsv(r);
  assert.match(csv.split("\n")[0], /^distance,x,y,z,T$/);
  assert.match(csv.trimEnd().split("\n").pop()!, /,$/, "a gap is an empty CSV cell");
});

test("a node with no value uncovers the samples in the cells that touch it", async () => {
  const m = model(SQUARE);
  const t = m.fields.find((f) => f.variable === "T")!;
  const holed: MdpaModel = { ...m, fields: [{ ...t, ids: t.ids.filter((id) => id !== 3), values: Float64Array.from(t.values.filter((_, i) => t.ids[i] !== 3)) }, ...m.fields.filter((f) => f !== t)] };
  const r = await probeAlongPath(holed, { points: [[0.9, 0.05, 0], [0.9, 0.95, 0]], samples: 4, variable: "T" });
  assert.ok(r.uncovered > 0, "cells touching node 3 are uncovered");
});

test("refusals: a cell field, an unknown field, a degenerate or malformed path, bad sample counts", async () => {
  const m = model(SQUARE + "Begin ElementalData C\n1 5\n2 7\nEnd ElementalData\n");
  await assert.rejects(probeAlongPath(m, { points: [[0, 0, 0], [1, 1, 0]], variable: "C" }), /NODAL field.*Average field/);
  await assert.rejects(probeAlongPath(m, { points: [[0, 0, 0], [1, 1, 0]], variable: "NOPE" }), /No nodal field/);
  assert.throws(() => samplePolyline([[0, 0, 0]], 5), /at least two/);
  assert.throws(() => samplePolyline([[0, 0, 0], [0, 0, 0]], 5), /zero length/);
  assert.throws(() => samplePolyline([[0, 0, 0], [1, 0, NaN]], 5), /finite/);
  assert.throws(() => samplePolyline([[0, 0, 0], [1, 0, 0]], 1), /samples/);
  assert.throws(() => samplePolyline([[0, 0, 0], [1, 0, 0]], 2.5), /samples/);
});

test("a multi-segment path is sampled by arclength across its corners", () => {
  const s = samplePolyline([[0, 0, 0], [1, 0, 0], [1, 2, 0]], 4);
  assert.deepEqual(s.distances.map((d) => +d.toFixed(9)), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(s.positions).map((v) => +v.toFixed(9)), [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 2, 0]);
});
