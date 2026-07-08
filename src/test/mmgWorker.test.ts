import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { runMmgInWorker } from "../mmgWorkerClient";

const CUBE = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements
`;

test("worker runner remeshes off-thread and streams progress lines", async () => {
  const m = parseMdpa(CUBE);
  const lines: string[] = [];
  const r = await runMmgInWorker(
    "remesh",
    m,
    { mode: "factor", factor: 0.5 },
    { onProgress: (message) => lines.push(message) }
  );
  assert.ok(!r.noop, r.message);
  assert.ok(r.model.nodeCount > m.nodeCount);
  // The structured-clone round trip must preserve the typed arrays.
  assert.ok(r.model.coords instanceof Float32Array);
  assert.ok(r.model.blocks[0].connectivity instanceof Int32Array);
  // Progress carried both our stage messages and MMG's own phase output.
  assert.ok(lines.some((l) => l.includes("Preparing")), lines.join("\n"));
  assert.ok(lines.some((l) => /PHASE/.test(l)), lines.join("\n"));
});

test("worker runner rejects with 'cancelled' when the signal aborts", async () => {
  const m = parseMdpa(CUBE);
  const abort = new AbortController();
  const run = runMmgInWorker("remesh", m, { mode: "factor", factor: 0.2 }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(run, /cancelled/);
});
