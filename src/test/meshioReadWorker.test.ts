/**
 * Roadmap item 2, eighth increment: meshio++ reads in a cancellable worker.
 * Real wasm, no skip guard. The runner is reset in `after()` so no later test in
 * this process sees a worker.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseMdpa } from "../parser/mdpaParser";
import { parseMeshFile, readMeshMetadata, readMeshTimeSteps } from "../parser/meshFileParser";
import {
  configureMeshioReadRunner,
  readMeshioInProcess,
  readMeshioMetadata,
  readMeshioModel,
  readMeshioTimeValues,
} from "../parser/meshio";
import type { MeshioInputFile } from "../parser/meshio";
import { writeMeshioInProcess } from "../parser/writers/meshWriter";
import { createMeshioReadWorkerRunner } from "../meshioReadWorkerClient";
import { tetBar } from "./fixtures/shapes";

const FIXTURE = path.resolve(__dirname, "../../src/test/fixtures/openfoam-inplace/case");
const runner = createMeshioReadWorkerRunner();

after(() => configureMeshioReadRunner(readMeshioInProcess));

/** A `.msh` for `n` hexes of the shared tetBar fixture, written by meshio++ itself. */
async function mshBytes(n: number): Promise<MeshioInputFile[]> {
  const { result } = await writeMeshioInProcess(tetBar(n), ".msh", { stem: "bar" });
  return [{ name: "bar.msh", data: result.data }];
}

test("a worker read equals the in-process read (gmsh .msh): model, fields, diagnostics", async () => {
  const files = await mshBytes(4);
  const a = await readMeshioInProcess({ kind: "model", mainName: "bar.msh", files, ext: ".msh" });
  const b = await runner({ kind: "model", mainName: "bar.msh", files, ext: ".msh" });
  assert.equal(b.nodeCount, a.nodeCount);
  assert.deepEqual(b.blocks, a.blocks);
  assert.deepEqual(b.diagnostics, a.diagnostics);
  assert.deepEqual(Array.from(b.coords), Array.from(a.coords));
});

test("time values and metadata cross the thread unchanged", async () => {
  const files = await mshBytes(2);
  const job = { mainName: "bar.msh", files, ext: ".msh" } as const;
  assert.deepEqual(await runner({ kind: "timeValues", ...job }), await readMeshioInProcess({ kind: "timeValues", ...job }));
  const md = await runner({ kind: "metadata", ...job });
  const md0 = await readMeshioInProcess({ kind: "metadata", ...job });
  assert.deepEqual(md, md0);
});

test("a pre-aborted signal rejects 'cancelled' without spawning", async () => {
  const abort = new AbortController();
  abort.abort();
  const files = await mshBytes(1);
  await assert.rejects(runner({ kind: "model", mainName: "bar.msh", files, ext: ".msh" }, abort.signal), /cancelled/);
});

test("aborting mid-read rejects 'cancelled' while the host event loop keeps ticking", async () => {
  const files = await mshBytes(2000);
  const abort = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const started = runner({ kind: "model", mainName: "bar.msh", files, ext: ".msh" }, abort.signal);
  setTimeout(() => abort.abort(), 80);
  await assert.rejects(started, /cancelled/);
  clearInterval(timer);
  assert.ok(ticks > 0, `the host kept servicing timers while the worker read (${ticks} ticks)`);
});

test("a reader failure rejects with the reader's own message", async () => {
  const bad: MeshioInputFile[] = [{ name: "bad.msh", data: new TextEncoder().encode("not a mesh") }];
  await assert.rejects(runner({ kind: "model", mainName: "bad.msh", files: bad, ext: ".msh" }), /Could not read "bad.msh"/);
});

test("readMeshioModel/TimeValues/Metadata dispatch through the installed runner and forward the signal", async () => {
  const files = await mshBytes(2);
  const seen: string[] = [];
  configureMeshioReadRunner((async (job: { kind: string }, signal?: AbortSignal) => {
    seen.push(`${job.kind}:${signal ? "signal" : "none"}`);
    return readMeshioInProcess(job as never, signal);
  }) as never);
  const abort = new AbortController();
  await readMeshioModel("bar.msh", files, ".msh", undefined, undefined, undefined, { signal: abort.signal });
  await readMeshioTimeValues("bar.msh", files, ".msh");
  await readMeshioMetadata("bar.msh", files, ".msh");
  configureMeshioReadRunner(readMeshioInProcess);
  assert.deepEqual(seen, ["model:signal", "timeValues:none", "metadata:none"]);
});

test("a function augment stays in-process even with a runner installed", async () => {
  const files = await mshBytes(1);
  let calls = 0;
  configureMeshioReadRunner((async () => {
    calls++;
    throw new Error("must not be used");
  }) as never);
  try {
    const m = await readMeshioModel("bar.msh", files, ".msh", undefined, undefined, () => undefined);
    assert.ok(m.nodeCount > 0);
    assert.equal(calls, 0);
  } finally {
    configureMeshioReadRunner(readMeshioInProcess);
  }
});

test("parseMeshFile through the worker equals the default for an OpenFOAM case (fields, patch dictionaries, dimensions)", async () => {
  const marker = path.join(FIXTURE, "case.foam");
  const a = await parseMeshFile(marker);
  configureMeshioReadRunner(runner);
  try {
    const b = await parseMeshFile(marker);
    assert.equal(b.nodeCount, a.nodeCount);
    assert.deepEqual(b.blocks, a.blocks);
    assert.deepEqual(b.fields, a.fields);
    assert.deepEqual(b.source, a.source);
    assert.deepEqual(b.diagnostics, a.diagnostics);
    assert.deepEqual(b.subModelParts, a.subModelParts);
    assert.ok(b.fields.some((f) => f.variable === "p"), "the 0/p field made it through the data augment");
    assert.match(b.source?.openfoam?.patchDictionaries?.bottom ?? "", /neighbourPatch top;/);
  } finally {
    configureMeshioReadRunner(readMeshioInProcess);
  }
});

test("parseMeshFile with a time step and the time/metadata probes work through the worker", async () => {
  const marker = path.join(FIXTURE, "case.foam");
  const a = await parseMeshFile(marker, undefined, { timeStep: 2 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  const msh = path.join(dir, "bar.msh");
  fs.writeFileSync(msh, (await mshBytes(3))[0].data);
  const steps0 = await readMeshTimeSteps(msh);
  const meta0 = await readMeshMetadata(msh);
  configureMeshioReadRunner(runner);
  try {
    const b = await parseMeshFile(marker, undefined, { timeStep: 2 });
    assert.deepEqual(b.fields, a.fields);
    assert.deepEqual(await readMeshTimeSteps(msh), steps0);
    assert.deepEqual((await readMeshMetadata(msh)).metadata, meta0.metadata);
  } finally {
    configureMeshioReadRunner(readMeshioInProcess);
  }
});

test("parseMeshFile({signal}) rejects 'cancelled' before any work, and a mid-read abort stops a worker read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  const msh = path.join(dir, "bar.msh");
  fs.writeFileSync(msh, (await mshBytes(2000))[0].data);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(parseMeshFile(msh, undefined, { signal: pre.signal }), /cancelled/);
  configureMeshioReadRunner(runner);
  try {
    const abort = new AbortController();
    const p = parseMeshFile(msh, undefined, { signal: abort.signal });
    setTimeout(() => abort.abort(), 80);
    await assert.rejects(p, /cancelled/);
  } finally {
    configureMeshioReadRunner(readMeshioInProcess);
  }
});
