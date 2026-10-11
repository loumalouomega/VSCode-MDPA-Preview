/**
 * The multi-file series scans in a worker (roadmap item 2): the worker result
 * must equal the in-process scan, progress must stream per step, a cooperative
 * cancel must return the PARTIAL series, and the host must keep ticking while a
 * scan runs. Step files are MDPA filename series written to a temp dir.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeMdpa } from "../parser/writers/mdpaWriter";
import { flowDuct } from "./fixtures/shapes";
import { groupVtkFiles, findGroupForFile } from "../parser/vtkFileGroup";
import { TIMELINE_EXTENSIONS } from "../parser/meshFormats";
import {
  deserializeGroup,
  runSeriesScan,
  serializeGroup,
  stepsForSource,
} from "../seriesScanJob";
import type { SeriesScan, SeriesScanSource } from "../seriesScanJob";
import { runSeriesScanInWorker, SERIES_SCAN_KILLED } from "../seriesScanWorkerClient";
import { createSeriesScanController } from "../seriesScanHost";
import type { FieldSeries } from "../parser/fieldSeries";
import type { FlowSeries } from "../parser/flowBalance";

const STEPS = 6;

/** `Duct_0_<n>.mdpa`, n = 1..STEPS; inlet speed n, a pressure ramp, one step with a missing field. */
function makeSeries(steps = STEPS): { dir: string; source: SeriesScanSource } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "series-scan-"));
  for (let n = 1; n <= steps; n++) {
    const m = flowDuct({ velocity: () => [n, 0, 0], pressure: (x) => 10 * n - x });
    fs.writeFileSync(path.join(dir, `Duct_0_${n}.mdpa`), writeMdpa(m));
  }
  const found = findGroupForFile(groupVtkFiles(fs.readdirSync(dir), TIMELINE_EXTENSIONS), "Duct_0_1.mdpa");
  assert.ok(found && found.group.steps.length === steps, "the temp series is discovered as one group");
  return { dir, source: { kind: "group", group: serializeGroup(found.group), dir, rank: found.rank, mdpa: true } };
}

const FIELD: SeriesScan = { kind: "field", spec: { kind: "Nodal", variable: "PRESSURE", entityId: 1 } };
const FLOW: SeriesScan = {
  kind: "flow",
  spec: { sections: [{ name: "in", part: "Inlet" }, { name: "out", part: "Outlet" }] },
};

test("a serialized group survives structured clone and rebuilds its Map", () => {
  const { source } = makeSeries();
  assert.equal(source.kind, "group");
  if (source.kind !== "group") return;
  const cloned = structuredClone(source.group);
  const g = deserializeGroup(cloned);
  assert.ok(g.fileMap instanceof Map && g.fileMap.size >= STEPS);
  assert.deepEqual(stepsForSource(source).map((s) => s.label), g.steps);
});

test("worker field scan equals the in-process scan, step labels and values included", async () => {
  const { source } = makeSeries();
  const direct = (await runSeriesScan(stepsForSource(source), FIELD)) as FieldSeries;
  const viaWorker = (await runSeriesScanInWorker(source, FIELD)) as FieldSeries;
  assert.deepEqual(viaWorker, direct);
  assert.equal(viaWorker.present, STEPS);
});

test("worker flow scan equals the in-process scan", async () => {
  const { source } = makeSeries();
  const direct = (await runSeriesScan(stepsForSource(source), FLOW)) as FlowSeries;
  const viaWorker = (await runSeriesScanInWorker(source, FLOW)) as FlowSeries;
  assert.deepEqual(viaWorker, direct);
  assert.equal(viaWorker.rows.length, STEPS);
  assert.ok(viaWorker.rows.every((r) => r.result), "every step balanced");
  // Inlet speed grows with the step, so the inlet flux does too.
  const influx = viaWorker.rows.map((r) => r.result!.sections[0].flux!);
  assert.ok(influx.every((f, i) => i === 0 || Math.abs(f) > Math.abs(influx[i - 1])));
});

test("progress streams once per step, then a closing report", async () => {
  const { source } = makeSeries();
  const seen: number[] = [];
  await runSeriesScanInWorker(source, FIELD, { onProgress: (done) => seen.push(done) });
  assert.deepEqual(seen.slice(0, STEPS), [0, 1, 2, 3, 4, 5]);
  assert.equal(seen[seen.length - 1], STEPS);
});

test("a step that fails to parse is recorded and skipped, never fatal", async () => {
  const { dir, source } = makeSeries();
  fs.writeFileSync(path.join(dir, "Duct_0_3.mdpa"), "this is not a mesh \u0000");
  const series = (await runSeriesScanInWorker(source, FIELD)) as FieldSeries;
  assert.equal(series.labels.length, STEPS);
  assert.ok(series.present < STEPS, "the broken step is not counted as present");
  assert.equal(series.cancelled, false);
});

test("cooperative cancel resolves the partial series", async () => {
  // Long enough that the worker cannot finish before the abort round-trips.
  const { source } = makeSeries(60);
  const abort = new AbortController();
  const series = (await runSeriesScanInWorker(source, FIELD, {
    signal: abort.signal,
    onProgress: (done) => { if (done === 2) abort.abort(); },
  })) as FieldSeries;
  assert.equal(series.cancelled, true);
  assert.ok(series.labels.length >= 3 && series.labels.length < 60, `partial, got ${series.labels.length}`);
});

test("a pre-aborted scan stops at the first step with an empty partial", async () => {
  const { source } = makeSeries();
  const abort = new AbortController();
  abort.abort();
  const series = (await runSeriesScanInWorker(source, FIELD, { signal: abort.signal })) as FieldSeries;
  assert.equal(series.cancelled, true);
  assert.equal(series.labels.length, 0);
});

test("kill terminates the worker at once and rejects as cancelled", async () => {
  const { source } = makeSeries();
  const kill = new AbortController();
  kill.abort();
  await assert.rejects(runSeriesScanInWorker(source, FIELD, { kill: kill.signal }), new RegExp(SERIES_SCAN_KILLED));
});

test("the host keeps ticking while a worker scan runs", async () => {
  const { source } = makeSeries();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 2);
  try {
    await runSeriesScanInWorker(source, FLOW);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, "the event loop turned during the scan");
});

test("controller: validates raw input, refuses a second scan, posts progress/result with a history note", async () => {
  const { source } = makeSeries();
  const posted: Record<string, unknown>[] = [];
  const c = createSeriesScanController({ post: (m) => posted.push(m), appliedCount: () => 2 });

  await c.field({ kind: "Bogus", variable: "T", entityId: 1 }, () => ({ source }));
  assert.match(String(posted.pop()!.message), /Invalid time-series request/);
  await c.field({ kind: "Nodal", variable: "PRESSURE", entityId: 1 }, () => undefined);
  assert.match(String(posted.pop()!.message), /no time series to plot/);
  await c.flow({ flow: { sections: "x" } }, () => ({ source }));
  assert.match(String(posted.pop()!.message), /Choose the sections/);

  const first = c.field({ kind: "Nodal", variable: "PRESSURE", entityId: 1 }, () => ({ source }));
  await c.field({ kind: "Nodal", variable: "PRESSURE", entityId: 1 }, () => ({ source }));
  assert.match(String(posted.find((m) => m.message)?.message), /already running/);
  await first;
  const result = posted.find((m) => m.type === "fieldSeriesResult" && m.series);
  assert.ok(result, "the first scan still completes");
  assert.match(String(result!.historyNote), /2 edit operation/);
  assert.ok(posted.some((m) => m.type === "fieldSeriesProgress"));
});

test("controller: dispose kills the worker and posts nothing afterwards", async () => {
  const { source } = makeSeries();
  const posted: Record<string, unknown>[] = [];
  const c = createSeriesScanController({ post: (m) => posted.push(m), appliedCount: () => 0 });
  const run = c.flow({ flow: FLOW.spec }, () => ({ source }));
  c.dispose();
  await run;
  assert.deepEqual(posted, []);
});

test("controller: an in-process steps input (resampled timeline) scans without a worker", async () => {
  const { source } = makeSeries();
  const posted: Record<string, unknown>[] = [];
  const c = createSeriesScanController({
    post: (m) => posted.push(m),
    appliedCount: () => 0,
    runInWorker: async () => { throw new Error("must not use the worker"); },
  });
  await c.flow({ flow: FLOW.spec }, () => ({ steps: stepsForSource(source) }));
  const res = posted.find((m) => m.type === "flowSeriesResult")!;
  assert.equal((res.series as FlowSeries).rows.length, STEPS);
});
