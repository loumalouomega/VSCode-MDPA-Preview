import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import { loadMeshio, loadMeshioFull } from "../parser/meshio";

/** The compiled loader, for a worker thread (this file runs from out/test/). */
const MESHIO_MODULE = path.join(__dirname, "..", "parser", "meshio.js");

/** The thread count of this process; /proc is the cheap way to read it. */
function threadCount(): number {
  const match = fs.readFileSync("/proc/self/status", "utf8").match(/^Threads:\s+(\d+)/m);
  return Number(match![1]);
}

test("the host thread gets the sequential build, the full artifact too", async () => {
  assert.equal((await loadMeshio()).parallelBackend(), "seq");
  assert.equal((await loadMeshioFull()).parallelBackend(), "seq");
});

test("a worker that runs one operation gets the threaded build", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const meshio = require(${JSON.stringify(MESHIO_MODULE)});
     meshio.markSingleOperationThread();
     meshio.loadMeshio().then(
       (m) => parentPort.postMessage(m.parallelBackend()),
       (e) => parentPort.postMessage("error: " + e.message),
     );`,
    { eval: true },
  );
  const backend = await new Promise<unknown>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();
  assert.equal(backend, "openmp");
});

test(
  "in-process instances do not keep threads alive",
  { skip: process.platform !== "linux" && "reads the thread count from /proc" },
  async () => {
    // V8 and libuv start their own threads lazily: warm them up first.
    await loadMeshio();
    const before = threadCount();
    for (let i = 0; i < 12; i++) await loadMeshio();
    assert.ok(threadCount() - before <= 2, `threads grew from ${before} to ${threadCount()}`);
  },
);
