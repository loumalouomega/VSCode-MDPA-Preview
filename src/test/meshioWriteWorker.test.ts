import { test, after } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { configureMeshioWriteRunner, writeMeshFileAsync, writeMeshioInProcess } from "../parser/writers/meshWriter";
import { createMeshioWriteWorkerRunner } from "../meshioWriteWorkerClient";

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

const runner = createMeshioWriteWorkerRunner();

after(() => configureMeshioWriteRunner(writeMeshioInProcess));

test("a worker write is byte-identical to the in-process write (binary gmsh)", async () => {
  const m = parseMdpa(CUBE);
  const a = await writeMeshioInProcess(m, ".msh", { stem: "cube" });
  const b = await runner(m, ".msh", { stem: "cube" });
  assert.ok(b.result.data instanceof Uint8Array);
  assert.deepEqual(Buffer.from(b.result.data), Buffer.from(a.result.data));
  assert.deepEqual(b.diagnostics, a.diagnostics);
});

test("companion files cross the thread (XDMF writes a sibling .h5)", async () => {
  const m = parseMdpa(CUBE);
  const a = await writeMeshioInProcess(m, ".xdmf", { stem: "cube" });
  const b = await runner(m, ".xdmf", { stem: "cube" });
  assert.ok(b.result.companions.length > 0);
  assert.deepEqual(b.result.companions.map((c) => c.name), a.result.companions.map((c) => c.name));
  assert.equal(b.result.companions[0].data.length, a.result.companions[0].data.length);
});

test("a refusal rejects with the writer's own message", async () => {
  const m = parseMdpa(CUBE);
  await assert.rejects(runner(m, ".nope", {}), /cannot write/);
});

test("a pre-aborted signal rejects 'cancelled' without spawning", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runner(parseMdpa(CUBE), ".msh", { signal: abort.signal }), /cancelled/);
});

test("aborting mid-write rejects 'cancelled' while the event loop keeps ticking", async () => {
  const abort = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const run = runner(parseMdpa(CUBE), ".msh", { stem: "cube", signal: abort.signal });
    abort.abort();
    await assert.rejects(run, /cancelled/);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
  }
});

test("writeMeshFileAsync through the worker runner matches the default and forwards warnings", async () => {
  const m = parseMdpa(CUBE);
  configureMeshioWriteRunner(writeMeshioInProcess);
  const w1: string[] = [];
  const a = await writeMeshFileAsync(m, ".xdmf", { name: "cube", onWarning: (x) => w1.push(x) });
  configureMeshioWriteRunner(runner);
  const w2: string[] = [];
  const b = await writeMeshFileAsync(m, ".xdmf", { name: "cube", onWarning: (x) => w2.push(x) });
  assert.deepEqual(w2, w1);
  assert.equal(b.companions.length, a.companions.length);
  assert.equal(b.data.length, a.data.length);
});

test("writeMeshFileAsync maps an abort to a 'cancelled' rejection and writes nothing", async () => {
  configureMeshioWriteRunner(runner);
  const abort = new AbortController();
  const run = writeMeshFileAsync(parseMdpa(CUBE), ".msh", { name: "cube", signal: abort.signal });
  abort.abort();
  await assert.rejects(run, /cancelled/);
});
