import assert from "node:assert/strict";
import test from "node:test";

import { MeshAnalysisMessage, runMeshAnalysis } from "../meshAnalysis";
import { probeAlongPath } from "../parser/pathProbe";
import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";

const model = (t: string): MdpaModel => {
  const r = parseMdpa(t) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

/** Two triangles over the unit square with T = x + 2y. */
const SQUARE =
  "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\n2 0 1 3 4\nEnd Elements\n" +
  "Begin NodalData T\n1 0 0\n2 0 1\n3 0 3\n4 0 2\nEnd NodalData\n";

const msg = (kind: string, extra: Record<string, unknown> = {}): MeshAnalysisMessage => ({
  type: "meshAnalysis",
  kind,
  ...extra,
} as MeshAnalysisMessage);

test("the probe analysis matches a direct probeAlongPath call for the same endpoints", async () => {
  const m = model(SQUARE);
  const direct = await probeAlongPath(m, { points: [[0, 0, 0], [1, 1, 0]], samples: 5, variable: "T" });
  const r = await runMeshAnalysis(msg("probe", { points: [[0, 0, 0], [1, 1, 0]], samples: 5, variable: "T", seq: 7 }), m);
  assert.equal(r.type, "meshAnalysisResult");
  assert.equal(r.kind, "probe");
  assert.equal(r.seq, 7, "the seq echo is what a stale-reply guard keys on");
  const probe = r.probe as typeof direct;
  assert.equal(probe.rows.length, direct.rows.length);
  for (let i = 0; i < probe.rows.length; i++) {
    assert.ok(Math.abs(probe.rows[i].values[0]! - direct.rows[i].values[0]!) < 1e-12);
    assert.ok(Math.abs(probe.rows[i].distance - direct.rows[i].distance) < 1e-12);
  }
  assert.equal(probe.columns.join(","), direct.columns.join(","));
});

test("a path leaving the mesh is a null-gap on the reply, never a fabricated value", async () => {
  const r = await runMeshAnalysis(msg("probe", { points: [[0.5, 0.5, 0], [3, 0.5, 0]], samples: 6, variable: "T" }), model(SQUARE));
  const probe = r.probe as { rows: { values: (number | null)[] }[]; covered: number; uncovered: number };
  assert.ok(probe.covered > 0 && probe.uncovered > 0);
  assert.ok(probe.rows[probe.rows.length - 1].values[0] === null);
});

test("a sample between the two endpoints is exact for a linear field", async () => {
  const r = await runMeshAnalysis(msg("probe", { points: [[0, 0, 0], [1, 1, 0]], samples: 3, variable: "T" }), model(SQUARE));
  const probe = r.probe as { rows: { values: (number | null)[] }[] };
  assert.ok(Math.abs(probe.rows[1].values[0]! - 1.5) < 1e-6, "T(0.5,0.5) = 1.5");
});

test("refusals and the no-model case arrive as a `message`, never an exception", async () => {
  const noModel = await runMeshAnalysis(msg("probe", { points: [[0, 0, 0], [1, 1, 0]], variable: "T" }), undefined);
  assert.match(String(noModel.message), /No mesh is loaded/);
  const noPoints = await runMeshAnalysis(msg("probe", { variable: "T" }), model(SQUARE));
  assert.match(String(noPoints.message), /at least two path points/);
  const noVariable = await runMeshAnalysis(msg("probe", { points: [[0, 0, 0], [1, 1, 0]] }), model(SQUARE));
  assert.match(String(noVariable.message), /Pick a field/);
  const unknownField = await runMeshAnalysis(msg("probe", { points: [[0, 0, 0], [1, 1, 0]], variable: "NOPE" }), model(SQUARE));
  assert.match(String(unknownField.message), /No nodal field/);
  const outOfRange = await runMeshAnalysis(msg("probe", { points: [[0, 0, 0], [1, 1, 0]], samples: 1, variable: "T" }), model(SQUARE));
  assert.match(String(outOfRange.message), /samples/);
});
