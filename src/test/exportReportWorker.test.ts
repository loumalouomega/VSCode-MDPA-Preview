import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { EXPORT_REFERENCES } from "../parser/exportReferences";
import {
  collectMeasurements, referenceModel, roundTrip, validateMeasurement,
  writerJobs, WriterMeasurement,
} from "./exportReportMatrix";
import { runMeasurementWorker } from "./exportReportWorkerClient";

function measurement(key: string): WriterMeasurement {
  return {
    key,
    entry: { references: Object.fromEntries(Object.keys(EXPORT_REFERENCES).map((id) => [id, { unmeasured: "fixture" }])) },
    references: Object.fromEntries(Object.keys(EXPORT_REFERENCES).map((id) => [id, { error: "fixture" }])),
  };
}

function worker(t: TestContext, code: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kratos-report-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "worker.js");
  fs.writeFileSync(file, code);
  return file;
}

test("fidelity coordinator visits every writer/reference exactly once, sequentially", async () => {
  const jobs = writerJobs();
  const visited: string[] = [];
  let active = 0;
  let peak = 0;
  const results = await collectMeasurements(jobs, async (key) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    visited.push(key);
    active--;
    return measurement(key);
  });
  assert.equal(peak, 1);
  assert.deepEqual(visited, jobs.map((j) => j.key));
  assert.deepEqual(results.map((r) => r.key), visited);
  for (const result of results) assert.deepEqual(Object.keys(result.references), Object.keys(EXPORT_REFERENCES));
});

test("fidelity coordinator rejects duplicate writers, malformed results and incomplete coverage", async () => {
  const jobs = writerJobs().slice(0, 2);
  await assert.rejects(collectMeasurements([jobs[0], jobs[0]], async (key) => measurement(key)), /Duplicate/);
  await assert.rejects(collectMeasurements(jobs, async () => ({ nonsense: true })), /malformed result/);
  const partial = measurement(jobs[0].key);
  delete partial.references.hex;
  assert.throws(() => validateMeasurement(partial, jobs[0].key), /missing references/);
  const missingObservation = measurement(jobs[0].key);
  missingObservation.entry.references.hex = { base: {}, fields: {} };
  assert.throws(() => validateMeasurement(missingObservation, jobs[0].key), /malformed reference hex/);
  const invalidObservation = measurement(jobs[0].key);
  invalidObservation.references.hex.observations = [{ id: "nodes", status: "unverified" as never }];
  assert.throws(() => validateMeasurement(invalidObservation, jobs[0].key), /malformed reference hex/);
  await assert.rejects(collectMeasurements(jobs, async () => measurement("wrong-writer")), /malformed result/);
  const visited: string[] = [];
  await assert.rejects(collectMeasurements(jobs, async (key) => {
    visited.push(key);
    throw new Error("worker crashed");
  }), /worker crashed/);
  assert.deepEqual(visited, [jobs[0].key]);
});

test("fidelity worker client waits for exit even after receiving a result", async (t) => {
  const file = worker(t, `
    process.send({ ready: true }, () => {
      setTimeout(() => process.exit(0), 150);
    });
  `);
  const started = Date.now();
  assert.deepEqual(await runMeasurementWorker(file, "fixture"), { ready: true });
  assert.ok(Date.now() - started >= 150);
});

test("fidelity worker client reports failed loads, nonzero exits, signals and missing replies", async (t) => {
  const file = worker(t, "process.exit(0)");
  await assert.rejects(runMeasurementWorker(`${file}.missing`, "load-failure"), /load-failure: exited with code 1/);
  await assert.rejects(runMeasurementWorker(file, "missing-reply"), /missing-reply: exited without a result/);
  fs.writeFileSync(file, "process.send({ ready: true }, () => process.exit(7))");
  await assert.rejects(runMeasurementWorker(file, "failed-after-reply"), /failed-after-reply: exited with code 7/);
  fs.writeFileSync(file, "process.kill(process.pid, 'SIGKILL')");
  await assert.rejects(runMeasurementWorker(file, "killed"), /killed: (terminated by SIGKILL|exited with code)/);
});

test("fidelity measurement worker refuses unknown writers", async () => {
  await assert.rejects(
    runMeasurementWorker(path.join(__dirname, "exportReportWorker.js"), "not-a-writer"),
    /not-a-writer: exited with code 1[\s\S]*Invalid export fidelity worker request/
  );
});

test("fidelity worker client kills a timed-out worker and rejects multiple replies", async (t) => {
  const file = worker(t, "setInterval(() => {}, 1000)");
  await assert.rejects(runMeasurementWorker(file, "hung", 300), /hung: timed out after 300 ms/);
  fs.writeFileSync(file, "process.send({ first: true }, () => process.send({ second: true }, () => process.exit(0)))");
  await assert.rejects(runMeasurementWorker(file, "duplicate"), /duplicate: sent more than one result/);
});

test("fidelity round trips remove their disk scratch directory on success and failure", async () => {
  const success = await roundTrip(referenceModel(), ".mdpa");
  assert.ok(success.reread);
  assert.equal(fs.existsSync(path.dirname(success.file)), false);
  const failure = await roundTrip(referenceModel(), ".not-a-format");
  assert.ok(failure.error);
  assert.equal(fs.existsSync(path.dirname(failure.file)), false);
});
