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
import { createAnalysisDispatcher, createStreamlineController } from "../analysisDispatch";
import {
  runFeatureEdgesInWorker,
  runFlowBalanceInWorker,
  runHausdorffInWorker,
  runPeriodicNodesInWorker,
  runQualityGateInWorker,
} from "../analysisWorkerClient";
import { featureEdges, hausdorff, periodicNodes, qualityGate } from "../parser/analysisOps";
import { flowBalance } from "../parser/flowBalance";
import { traceStreamlines } from "../parser/streamlines";
import { flowDuct } from "./fixtures/shapes";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

// ---- The analyses added by the third item-2 increment ---------------------

/** A square with two SubModelParts, so periodic matching has something to pair. */
const PERIODIC_SQUARE =
  "Begin Nodes\n10 0 0 0\n20 1 0 0\n30 1 1 0\n40 0 1 0\nEnd Nodes\nBegin Elements Element2D3N\n7 2 10 20 30\n8 2 10 30 40\nEnd Elements\n" +
  "Begin SubModelPart left\nBegin SubModelPartNodes\n10\n40\nEnd SubModelPartNodes\nEnd SubModelPart\n" +
  "Begin SubModelPart right\nBegin SubModelPartNodes\n20\n30\nEnd SubModelPartNodes\nEnd SubModelPart\n";
const FLOW_SPEC = { sections: [{ name: "in", part: "Inlet" }, { name: "out", part: "Outlet" }] };

test("quality gate, Hausdorff, periodic matching, feature edges and flow balance: the worker result equals the in-process core", async () => {
  const m = model(PERIODIC_SQUARE);
  assert.deepEqual(
    await runQualityGateInWorker(m, { require: "aspect_ratio <= 100" }),
    await qualityGate(m, "aspect_ratio <= 100")
  );
  const shifted = model(PERIODIC_SQUARE);
  shifted.coords = Float32Array.from(shifted.coords, (v, i) => (i % 3 === 2 ? v + 2 : v));
  assert.deepEqual(await runHausdorffInWorker(m, shifted, 1), await hausdorff(m, shifted, 1));
  const periodic = { slave: "left", master: "right", translate: [1, 0, 0] };
  assert.deepEqual(await runPeriodicNodesInWorker(m, periodic), await periodicNodes(m, periodic));
  assert.deepEqual(await runFeatureEdgesInWorker(m, { boundary: true }), await featureEdges(m, { boundary: true }));
  const duct = flowDuct({ velocity: () => [1, 0, 0] });
  assert.deepEqual(await runFlowBalanceInWorker(duct, FLOW_SPEC), flowBalance(duct, FLOW_SPEC));
});

test("a refusal in a new worker kind rejects with the core's own message", async () => {
  const m = model(PERIODIC_SQUARE);
  await assert.rejects(runQualityGateInWorker(m, { require: "not_a_metric >= 0" }));
  await assert.rejects(runPeriodicNodesInWorker(m, { slave: "left", master: "right", translate: [2, 0, 0] }));
  await assert.rejects(runFeatureEdgesInWorker(m, { featureAngle: 999 }), /Feature angle/);
});

test("every new worker kind rejects as cancelled on a pre-aborted signal", async () => {
  const m = model(PERIODIC_SQUARE);
  const abort = new AbortController();
  abort.abort();
  const opts = { signal: abort.signal };
  for (const run of [
    runQualityGateInWorker(m, {}, opts),
    runHausdorffInWorker(m, m, 0, opts),
    runPeriodicNodesInWorker(m, { slave: "left", master: "right", translate: [1, 0, 0] }, opts),
    runFeatureEdgesInWorker(m, {}, opts),
    runFlowBalanceInWorker(m, FLOW_SPEC, opts),
  ]) {
    await assert.rejects(run, new RegExp(PROBE_CANCELLED));
  }
});

test("runMeshAnalysis: the new worker kinds echo seq and flag a cancelled run instead of failing it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-worker-"));
  try {
    const other = path.join(dir, "other.mdpa");
    fs.writeFileSync(other, PERIODIC_SQUARE);
    const m = model(PERIODIC_SQUARE);
    const duct = flowDuct({ velocity: () => [1, 0, 0] });
    const runners = {
      qualityGateRunner: runQualityGateInWorker,
      hausdorffRunner: runHausdorffInWorker,
      periodicRunner: runPeriodicNodesInWorker,
      featureEdgesRunner: runFeatureEdgesInWorker,
      flowBalanceRunner: runFlowBalanceInWorker,
    };
    const requests: [string, Record<string, unknown>, MdpaModel][] = [
      ["qualityGate", { require: "aspect_ratio <= 100" }, m],
      ["hausdorff", { path: other, faceSamples: 0 }, m],
      ["periodicNodes", { slave: "left", master: "right", translate: [1, 0, 0] }, m],
      ["featureEdges", { featureAngle: 30 }, m],
      ["flowBalance", { flow: FLOW_SPEC }, duct],
    ];
    for (const [kind, extra, target] of requests) {
      const ok = await runMeshAnalysis({ type: "meshAnalysis", kind, seq: 21, ...extra } as unknown as MeshAnalysisMessage, target, runners);
      assert.equal(ok.seq, 21, kind);
      assert.equal(ok.message, undefined, kind);
      const abort = new AbortController();
      abort.abort();
      const cancelled = await runMeshAnalysis(
        { type: "meshAnalysis", kind, seq: 22, ...extra } as unknown as MeshAnalysisMessage, target, { ...runners, signal: abort.signal }
      );
      assert.equal(cancelled.cancelled, true, kind);
      assert.equal(cancelled.seq, 22, kind);
      assert.equal(cancelled.message, undefined, kind);
    }
    // A refusal keeps its tag too, so a delayed error is attributable.
    const refused = await runMeshAnalysis({ type: "meshAnalysis", kind: "hausdorff", seq: 23 } as unknown as MeshAnalysisMessage, m, runners);
    assert.equal(refused.seq, 23);
    assert.match(String(refused.message), /comparison mesh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the dispatcher handles the new kinds and supersedes each independently", async () => {
  const m = model(PERIODIC_SQUARE);
  const dispatcher = createAnalysisDispatcher();
  for (const kind of ["qualityGate", "hausdorff", "periodicNodes", "featureEdges", "flowBalance"]) {
    assert.ok(dispatcher.handles(kind), kind);
  }
  assert.ok(!dispatcher.handles("streamlines"), "streamlines keep their own partial-result controller");
  const gate = (seq: number): MeshAnalysisMessage =>
    ({ type: "meshAnalysis", kind: "qualityGate", require: "aspect_ratio <= 100", seq } as unknown as MeshAnalysisMessage);
  const first = dispatcher.run(gate(1), m);
  const edges = dispatcher.run({ type: "meshAnalysis", kind: "featureEdges", seq: 5 } as unknown as MeshAnalysisMessage, m);
  const second = dispatcher.run(gate(2), m);
  assert.equal(await first, undefined, "the superseded gate posts nothing");
  assert.equal((await second)?.seq, 2);
  assert.equal((await edges)?.seq, 5, "a gate never cancels the feature edges");
});

test("the streamline controller tags progress, lets a newer trace replace the older and posts a cancelled partial result", async () => {
  const flow = SQUARE.replace(
    "Begin NodalData T",
    "Begin NodalData V\n1 0 (1,0,0)\n2 0 (1,0,0)\n3 0 (1,0,0)\n4 0 (1,0,0)\nEnd NodalData\nBegin NodalData T"
  );
  const m = model(flow);
  const seeds = { kind: "points" as const, points: [[0.1, 0.5, 0], [0.2, 0.5, 0]] as [number, number, number][] };
  const request = (seq: number): MeshAnalysisMessage => ({ type: "meshAnalysis", kind: "streamlines", variable: "V", seeds, seq } as unknown as MeshAnalysisMessage);
  const posts: Record<string, unknown>[] = [];
  const controller = createStreamlineController(traceStreamlines);
  const a = controller.run(request(1), m, (r) => posts.push(r));
  const b = controller.run(request(2), m, (r) => posts.push(r));
  await Promise.all([a, b]);
  const finals = posts.filter((p) => p.type === "meshAnalysisResult");
  assert.equal(finals[finals.length - 1].seq, 2, "the newest request's reply arrives last");
  assert.ok(posts.some((p) => p.type === "streamlineProgress" && p.seq === 2));
  assert.ok(finals.every((p) => p.message === undefined), "a superseded trace is partial, never a failure");

  posts.length = 0;
  const c = controller.run(request(3), m, (r) => posts.push(r));
  controller.cancel();
  await c;
  const cancelled = posts.filter((p) => p.type === "meshAnalysisResult");
  assert.equal(cancelled.length, 1, "an explicit cancel still posts the (partial) result");
  assert.equal(cancelled[0].seq, 3);
});
