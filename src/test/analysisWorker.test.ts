import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { probeAlongPath } from "../parser/pathProbe";
import { MdpaModel } from "../parser/types";
import {
  ANALYSIS_CANCELLED as PROBE_CANCELLED,
  runIntegrateInWorker,
  runLodInWorker,
  runProbeInWorker,
  runWatertightInWorker,
} from "../analysisWorkerClient";
import { watertightReport } from "../parser/watertight";
import { integrateFields } from "../parser/fieldIntegrate";
import { lodSurface } from "../parser/lodSurface";
import { createAnalysisDispatcher } from "../analysisDispatch";
import { MeshAnalysisMessage, runMeshAnalysis } from "../meshAnalysis";

/** Two triangles over the unit square with T = x + 2y. */
const SQUARE =
  "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 1 1 0\n4 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\n2 0 1 3 4\nEnd Elements\n" +
  "Begin NodalData T\n1 0 0\n2 0 1\n3 0 3\n4 0 2\nEnd NodalData\n";

const model = (text: string = SQUARE): MdpaModel => {
  const r = parseMdpa(text) as unknown as { model?: MdpaModel };
  return (r.model ?? (r as unknown as MdpaModel)) as MdpaModel;
};

const PARAMS = { points: [[0, 0, 0], [1, 1, 0]] as [number, number, number][], samples: 5, variable: "T" };

test("the worker probe equals the in-process core, gaps included", async () => {
  const m = model();
  const direct = await probeAlongPath(m, PARAMS);
  const viaWorker = await runProbeInWorker(m, PARAMS);
  assert.deepEqual(viaWorker, direct);

  const leaving = { points: [[0.5, 0.5, 0], [3, 0.5, 0]] as [number, number, number][], samples: 6, variable: "T" };
  const out = await runProbeInWorker(m, leaving);
  assert.deepEqual(out, await probeAlongPath(m, leaving));
  assert.ok(out.uncovered > 0 && out.rows[out.rows.length - 1].values[0] === null, "a gap stays null, never 0");
});

test("refusals reject with the core's own message", async () => {
  const m = model();
  await assert.rejects(runProbeInWorker(m, { ...PARAMS, variable: "NOPE" }), /No nodal field/);
  await assert.rejects(runProbeInWorker(m, { ...PARAMS, samples: 1 }), /samples/);
});

test("a pre-aborted signal rejects as cancelled without spawning", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runProbeInWorker(model(), PARAMS, { signal: abort.signal }), new RegExp(PROBE_CANCELLED));
});

test("aborting mid-run rejects as cancelled and the host stays responsive meanwhile", async () => {
  const m = model();
  const abort = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 2);
  try {
    const run = runProbeInWorker(m, { ...PARAMS, samples: 100_000 }, { signal: abort.signal });
    const settled = run.then(() => "done", (e: Error) => e.message);
    setTimeout(() => abort.abort(), 30);
    const outcome = await settled;
    // Whichever side wins the race, a cancelled run is never reported as a failure.
    assert.ok(outcome === "done" || outcome === PROBE_CANCELLED, `unexpected outcome ${outcome}`);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, "the event loop kept turning while the worker ran");
});

test("runMeshAnalysis: a worker probe keeps its seq, and a cancelled one is flagged rather than failed", async () => {
  const m = model();
  const base = { type: "meshAnalysis", kind: "probe", ...PARAMS, seq: 11 } as unknown as MeshAnalysisMessage;
  const ok = await runMeshAnalysis(base, m, { probeRunner: runProbeInWorker });
  assert.equal(ok.seq, 11);
  assert.deepEqual(ok.probe, await probeAlongPath(m, PARAMS));

  const abort = new AbortController();
  abort.abort();
  const cancelled = await runMeshAnalysis({ ...base, seq: 12 }, m, { probeRunner: runProbeInWorker, signal: abort.signal } as never);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.seq, 12);
  assert.equal(cancelled.message, undefined);

  // A delayed failure is still attributable to its request.
  const failed = await runMeshAnalysis({ ...base, variable: "NOPE", seq: 13 } as never, m, { probeRunner: runProbeInWorker });
  assert.equal(failed.seq, 13);
  assert.match(String(failed.message), /No nodal field/);
});

const CELL_FIELD = SQUARE + "Begin ElementalData AREA\n1 2\n2 4\nEnd ElementalData\n";

test("watertight, integrate and lod: the worker result equals the in-process core", async () => {
  const m = model(CELL_FIELD);
  assert.deepEqual(await runWatertightInWorker(m), await watertightReport(m));
  assert.deepEqual(await runIntegrateInWorker(m, ["AREA"]), await integrateFields(m, ["AREA"]));
  assert.deepEqual(await runLodInWorker(m), await lodSurface(m));
});

test("an analysis refusal rejects with the core's own message", async () => {
  const m = model(CELL_FIELD);
  await assert.rejects(runIntegrateInWorker(m, ["T"]), /Nodal|averageField|Average/i);
});

test("every worker kind rejects as cancelled on a pre-aborted signal", async () => {
  const m = model(CELL_FIELD);
  const abort = new AbortController();
  abort.abort();
  const opts = { signal: abort.signal };
  for (const run of [runWatertightInWorker(m, opts), runIntegrateInWorker(m, [], opts), runLodInWorker(m, undefined, opts)]) {
    await assert.rejects(run, new RegExp(PROBE_CANCELLED));
  }
});

test("runMeshAnalysis: worker kinds echo seq, and a cancelled one is flagged rather than failed", async () => {
  const m = model(CELL_FIELD);
  const runners = { watertightRunner: runWatertightInWorker, integrateRunner: runIntegrateInWorker, lodRunner: runLodInWorker };
  for (const kind of ["watertight", "integrate", "lod"]) {
    const ok = await runMeshAnalysis({ type: "meshAnalysis", kind, variables: ["AREA"], seq: 3 } as unknown as MeshAnalysisMessage, m, runners);
    assert.equal(ok.seq, 3, kind);
    assert.equal(ok.message, undefined, kind);
    const abort = new AbortController();
    abort.abort();
    const cancelled = await runMeshAnalysis({ type: "meshAnalysis", kind, seq: 4 } as unknown as MeshAnalysisMessage, m, { ...runners, signal: abort.signal });
    assert.equal(cancelled.cancelled, true, kind);
    assert.equal(cancelled.seq, 4, kind);
    assert.equal(cancelled.message, undefined, kind);
  }
});

test("the dispatcher supersedes per kind: a newer probe drops the older reply, an integrate is untouched", async () => {
  const m = model(CELL_FIELD);
  const dispatcher = createAnalysisDispatcher();
  assert.ok(dispatcher.handles("probe") && dispatcher.handles("lod") && !dispatcher.handles("streamlines"));
  const probe = (seq: number): MeshAnalysisMessage => ({ type: "meshAnalysis", kind: "probe", ...PARAMS, seq } as unknown as MeshAnalysisMessage);
  const first = dispatcher.run(probe(1), m);
  const integral = dispatcher.run({ type: "meshAnalysis", kind: "integrate", variables: ["AREA"], seq: 9 } as unknown as MeshAnalysisMessage, m);
  const second = dispatcher.run(probe(2), m);
  assert.equal(await first, undefined, "the superseded probe posts nothing");
  assert.equal((await second)?.seq, 2);
  assert.equal((await integral)?.seq, 9, "a probe never cancels an integral");
  const pending = dispatcher.run(probe(3), m);
  dispatcher.cancel();
  assert.equal(await pending, undefined, "disposal cancels every kind");
});
