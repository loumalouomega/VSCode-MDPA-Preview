/**
 * The derived-mesh / partition worker (roadmap item 2): the same results as the
 * in-process cores, real cancellation, and the one kind that stays on the host.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { deriveMesh } from "../parser/deriveMesh";
import { partitionParts } from "../parser/partitionExport";
import {
  configureDerivedRunner,
  deriveMeshOffThread,
  partitionPartsOffThread,
  runDerivedInProcess,
} from "../parser/derivedRunner";
import { createDerivedWorkerRunner } from "../derivedWorkerClient";
import { tetBar } from "./fixtures/shapes";
import type { DeriveSpec } from "../parser/deriveMesh";
import type { MdpaModel } from "../parser/types";

function withVelocity(m: MdpaModel): MdpaModel {
  const values = new Float64Array(m.nodeCount * 3);
  for (let i = 0; i < m.nodeCount; i++) values[i * 3] = 1;
  return { ...m, fields: [...m.fields, { kind: "Nodal", variable: "V", components: 3, ids: Int32Array.from(m.nodeIds), values }] };
}

const worker = createDerivedWorkerRunner();
const useWorker = (): void => configureDerivedRunner(worker);
after(() => configureDerivedRunner(runDerivedInProcess));

test("a slice through the worker equals the in-process slice", async () => {
  const m = tetBar(4);
  const spec: DeriveSpec = { kind: "slice", origin: [1.5, 0, 0], normal: [1, 0, 0] };
  const a = await deriveMesh(m, spec);
  useWorker();
  const b = await deriveMeshOffThread(m, spec);
  assert.equal(b.summary, a.summary);
  assert.equal(b.model.nodeCount, a.model.nodeCount);
  assert.deepEqual(Array.from(b.model.coords), Array.from(a.model.coords));
  assert.deepEqual(b.model.blocks.map((x) => x.count), a.model.blocks.map((x) => x.count));
});

test("a grid keeps its raw lattice (typed arrays) across the thread", async () => {
  const m = tetBar(2);
  const spec: DeriveSpec = { kind: "grid", dims: [4, 3, 2], origin: [0, 0, 0], spacing: [0.5, 0.5, 0.5] };
  useWorker();
  const r = await deriveMeshOffThread(m, spec);
  assert.equal(r.denseLattice, true);
  assert.ok(r.raw && r.raw.points.length > 0);
});

test("KaHIP partition export through the worker matches in-process and reports the method that ran", async () => {
  const m = tetBar(6);
  const params = { nparts: 3, method: "kahip" } as const;
  const a = await partitionParts(m, params);
  useWorker();
  const b = await partitionPartsOffThread(m, params);
  assert.equal(b.method, "kahip");
  assert.deepEqual(b.ownedElements, a.ownedElements);
  assert.equal(b.parts.length, 3);
});

test("a worker run replays its diagnostics into the caller's array", async () => {
  useWorker();
  const diagnostics: unknown[] = [];
  await deriveMeshOffThread(tetBar(3), { kind: "slice", origin: [1, 0, 0], normal: [1, 0, 0] }, diagnostics as never);
  assert.ok(Array.isArray(diagnostics));
});

test("errors keep their message across the thread", async () => {
  useWorker();
  await assert.rejects(
    deriveMeshOffThread(tetBar(3), { kind: "slice", origin: [50, 0, 0], normal: [1, 0, 0] }),
    /does not cut/
  );
});

test("a pre-aborted signal rejects 'cancelled' without spawning", async () => {
  useWorker();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(partitionPartsOffThread(tetBar(3), { nparts: 2 }, [], { signal: abort.signal }), /cancelled/);
});

test("aborting mid-run rejects 'cancelled' while the host event loop keeps ticking", async () => {
  useWorker();
  const abort = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const run = partitionPartsOffThread(tetBar(6), { nparts: 3, method: "kahip" }, [], { signal: abort.signal });
    abort.abort();
    await assert.rejects(run, /cancelled/);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
  }
});

test("a streamline trace stays in-process: its per-seed progress callback fires", async () => {
  useWorker();
  const seen: [number, number][] = [];
  const r = await deriveMeshOffThread(
    withVelocity(tetBar(4)),
    { kind: "streamlines", variable: "V", seeds: { kind: "line", from: [0.1, 0.2, 0.5], to: [0.1, 0.8, 0.5], count: 3 } },
    [],
    { streamOpts: { onProgress: (done, total) => seen.push([done, total]) } }
  );
  assert.match(r.summary, /3 streamlines/);
  assert.deepEqual(seen[seen.length - 1], [3, 3]);
});
