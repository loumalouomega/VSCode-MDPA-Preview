/** ALE mesh quality over time (roadmap item 46): a fold at frame k is reported exactly. Pure, no wasm. */
import assert from "node:assert/strict";
import test from "node:test";

import { aleQualitySeries } from "../parser/aleQuality";
import type { SeriesStep } from "../parser/fieldSeries";
import { parseMdpa } from "../parser/mdpaParser";
import type { MdpaModel } from "../parser/types";

const TRIS = `Begin Nodes
1 0 0 0
2 1 0 0
3 0.5 1 0
4 0.5 -1 0
End Nodes
Begin Elements Element2D3N
10 1 1 2 3
11 1 2 1 4
End Elements
`;

const TET = `Begin Nodes
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
End Nodes
Begin Elements Element3D4N
7 1 1 2 3 4
End Elements
`;

function withDisplacement(src: string, d: Record<number, number[]>): MdpaModel {
  const m = parseMdpa(src);
  const ids = Array.from(m.nodeIds);
  return { ...m, fields: [{ kind: "Nodal", variable: "MESH_DISPLACEMENT", components: 3, ids: Int32Array.from(ids), values: Float64Array.from(ids.flatMap((id) => d[id] ?? [0, 0, 0])) }] };
}

const series = (src: string, frames: Record<number, number[]>[]): SeriesStep[] =>
  frames.map((d, i) => ({ label: `t${i}`, frameIndex: i, load: async () => withDisplacement(src, d) }));

test("a synthetic series that folds one triangle at frame 2 reports exactly that element and frame", async () => {
  const r = await aleQualitySeries(series(TRIS, [{}, { 3: [0, -0.2, 0] }, { 3: [0, -1.5, 0] }, { 3: [0, -1.2, 0] }]));
  assert.deepEqual(r.frames.map((f) => f.inverted), [0, 0, 1, 1]);
  assert.deepEqual(r.frames[2].invertedIds, [10]);
  assert.equal(r.frames[2].worstElementId, 10);
  assert.ok(r.frames[1].minShapeRatio! > 0 && r.frames[1].minShapeRatio! <= 1 + 1e-12);
  assert.ok(r.frames[2].minMeasureRatio! < 0);
  assert.equal(r.worstFrame, 2);
  assert.equal(r.referenceLabel, "t0");
});

test("a rigid translation or uniform scaling leaves quality ratios at 1; a tet flipped through its base is inverted", async () => {
  const ok = await aleQualitySeries(series(TET, [{}, { 1: [5, 5, 5], 2: [5, 5, 5], 3: [5, 5, 5], 4: [5, 5, 5] }]));
  assert.ok(Math.abs(ok.frames[1].minShapeRatio! - 1) < 1e-9 && ok.frames[1].inverted === 0);
  const flip = await aleQualitySeries(series(TET, [{}, { 4: [0, 0, -2] }]));
  assert.equal(flip.frames[1].inverted, 1);
  assert.deepEqual(flip.frames[1].invertedIds, [7]);
  assert.ok(flip.frames[1].minShapeRatio! < 0);
});

test("a missing field is a per-frame error and a changed element set is not compared by position", async () => {
  const steps = series(TRIS, [{}, {}]);
  steps.push({ label: "bad", frameIndex: 2, load: async () => parseMdpa(TRIS) });
  steps.push({ label: "other", frameIndex: 3, load: async () => withDisplacement(TET, {}) });
  const r = await aleQualitySeries(steps);
  assert.match(r.frames[2].error!, /MESH_DISPLACEMENT/);
  assert.match(r.frames[3].error!, /topology changed/);
  assert.equal(r.frames[1].inverted, 0);
});
