import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { runStreamlinesInWorker } from "../streamlineWorkerClient";
import { MdpaModel } from "../parser/types";

const BAR = `Begin Nodes
1 0 0 0
2 4 0 0
3 4 1 0
4 0 1 0
5 0 0 1
6 4 0 1
7 4 1 1
8 0 1 1
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements
Begin NodalData V
1 0 (1,0,0)
2 0 (1,0,0)
3 0 (1,0,0)
4 0 (1,0,0)
5 0 (1,0,0)
6 0 (1,0,0)
7 0 (1,0,0)
8 0 (1,0,0)
End NodalData
`;

const model = (): MdpaModel => {
  const r = parseMdpa(BAR) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

test("worker runner traces off-thread and streams per-seed progress", async () => {
  const m = model();
  const progress: [number, number][] = [];
  const r = await runStreamlinesInWorker(
    m,
    { variable: "V", seeds: { kind: "line", from: [0.5, 0.2, 0.5], to: [0.5, 0.8, 0.5], count: 4 } },
    { onProgress: (done, total) => progress.push([done, total]) }
  );
  assert.equal(r.lines.length, 4);
  assert.equal(r.cancelled, false);
  assert.deepEqual(progress[progress.length - 1], [4, 4]);
  assert.ok(progress.every(([d, t]) => t === 4 && d >= 1 && d <= 4));
  // The structured-clone round trip must preserve the typed arrays.
  assert.ok(r.lines[0].points instanceof Float64Array);
  assert.ok(r.lines[0].speed instanceof Float64Array);
  assert.ok(r.lines[0].velocity instanceof Float64Array);
  assert.ok(Array.isArray(r.seeds) && r.seeds.length === 4);
});

test("worker runner resolves the partial result when the signal aborts", async () => {
  const m = model();
  const abort = new AbortController();
  const run = runStreamlinesInWorker(
    m,
    {
      variable: "V",
      seeds: { kind: "line", from: [0.5, 0.05, 0.5], to: [0.5, 0.95, 0.5], count: 2000 },
      maxSeeds: 5000,
    },
    {
      signal: abort.signal,
      onProgress: (done) => {
        if (done >= 2) abort.abort();
      },
    }
  );
  const r = await run;
  assert.equal(r.cancelled, true);
  assert.ok(r.lines.length < 2000, "the run stopped early with what it had");
});

test("worker runner resolves cancelled for a pre-aborted signal and rejects refusals", async () => {
  const m = model();
  const abort = new AbortController();
  abort.abort();
  const r = await runStreamlinesInWorker(
    m,
    { variable: "V", seeds: { kind: "points", points: [[0.5, 0.5, 0.5]] } },
    { signal: abort.signal }
  );
  assert.equal(r.cancelled, true);
  assert.equal(r.lines.length, 0);
  await assert.rejects(
    runStreamlinesInWorker(m, { variable: "NOPE", seeds: { kind: "points", points: [[0, 0, 0]] } }),
    /Nodal vector fields: V/
  );
});
