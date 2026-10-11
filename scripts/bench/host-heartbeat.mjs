#!/usr/bin/env node
/**
 * Host-heartbeat benchmark (roadmap item 2): how long does the extension host's
 * event loop stall while the same work runs in-process versus in its worker?
 *
 *   npm run compile && npm run build:tests
 *   node scripts/bench/host-heartbeat.mjs [--nodes 30] [--steps 8] [--reps 3]
 *        [--json out.json] [--check] [--max-stall-ms 50] [--strict]
 *
 * Node-level, single machine, software only: it measures the stall of the Node
 * main thread (perf_hooks.monitorEventLoopDelay), which is what a VS Code
 * extension host is. It is NOT a measurement inside VS Code, Remote-SSH or an
 * embedding such as KKSS; those stay pending. Deliberately not part of
 * `npm test` — timing on shared CI is flaky.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPasses, judgeCase, summarizeRuns } from "./heartbeatStats.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const N = Number(opt("nodes", process.env.BENCH_NODES ?? 30));
const STEPS = Number(opt("steps", process.env.BENCH_STEPS ?? 8));
const REPS = Number(opt("reps", process.env.BENCH_REPS ?? 3));
const MAX_STALL = Number(opt("max-stall-ms", 50));

function load(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return undefined;
  return require(file);
}

const mdpaWriterMod = load("out/parser/writers/mdpaWriter.js");
const jobMod = load("out/seriesScanJob.js");
const clientMod = load("out/seriesScanWorkerClient.js");
const analysisClient = load("out/analysisWorkerClient.js");
const mdpaParser = load("out/parser/mdpaParser.js");
const skinMod = load("out/parser/extractSkin.js");
const probeMod = load("out/parser/pathProbe.js");
const watertightMod = load("out/parser/watertight.js");
const fileGroupMod = load("out/parser/vtkFileGroup.js");
const formatsMod = load("out/parser/meshFormats.js");
if (!mdpaParser || !jobMod || !fileGroupMod || !formatsMod || !probeMod || !watertightMod || !skinMod) {
  console.error("Compiled output missing: run `npm run compile && npm run build:tests` first.");
  process.exit(2);
}
const workersBuilt = (name) => fs.existsSync(path.join(root, "dist", name));

/** A N^3 hexahedral block along +x with PRESSURE, VELOCITY and Inlet/Outlet quad parts. */
function blockMdpa(n, step) {
  const at = (i, j, k) => 1 + i + (n + 1) * (j + (n + 1) * k);
  const out = ["Begin Properties 1", "End Properties", "Begin Nodes"];
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) out.push(`${at(i, j, k)} ${i} ${j} ${k}`);
  out.push("End Nodes", "Begin Elements Element3D8N");
  let e = 1;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    out.push(`${e++} 1 ${at(i, j, k)} ${at(i + 1, j, k)} ${at(i + 1, j + 1, k)} ${at(i, j + 1, k)} ${at(i, j, k + 1)} ${at(i + 1, j, k + 1)} ${at(i + 1, j + 1, k + 1)} ${at(i, j + 1, k + 1)}`);
  }
  out.push("End Elements", "Begin Conditions SurfaceCondition3D4N");
  const faces = { 10: 0, 11: n };
  const condIds = { 10: [], 11: [] };
  let c = 1;
  for (const [tag, x] of Object.entries(faces)) {
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) {
      out.push(`${c} 1 ${at(x, j, k)} ${at(x, j + 1, k)} ${at(x, j + 1, k + 1)} ${at(x, j, k + 1)}`);
      condIds[tag].push(c++);
    }
  }
  out.push("End Conditions");
  out.push("Begin NodalData PRESSURE");
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) out.push(`${at(i, j, k)} 0 ${(10 * step - i).toFixed(3)}`);
  out.push("End NodalData", "Begin NodalData VELOCITY");
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) out.push(`${at(i, j, k)} 0 [3] (${step},0,0)`);
  out.push("End NodalData");
  for (const [name, tag, x] of [["Inlet", 10, 0], ["Outlet", 11, n]]) {
    out.push(`Begin SubModelPart ${name}`, " Begin SubModelPartNodes");
    for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) out.push(` ${at(x, j, k)}`);
    out.push(" End SubModelPartNodes", " Begin SubModelPartConditions");
    for (const id of condIds[tag]) out.push(` ${id}`);
    out.push(" End SubModelPartConditions", "End SubModelPart");
  }
  return out.join("\n") + "\n";
}

/** One timed run: event-loop delay histogram + wall time + RSS growth. */
async function measure(fn) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  const rss0 = process.resourceUsage().maxRSS;
  h.enable();
  const t0 = performance.now();
  await fn();
  const wallMs = performance.now() - t0;
  // Let the loop turn once more so a stall that ended with the work is recorded.
  await new Promise((r) => setTimeout(r, 10));
  h.disable();
  const ms = (ns) => ns / 1e6;
  return {
    wallMs,
    p50Ms: ms(h.percentile(50)),
    p99Ms: ms(h.percentile(99)),
    maxStallMs: ms(h.max),
    rssDeltaMb: Math.max(0, process.resourceUsage().maxRSS - rss0) / 1024,
  };
}

async function repeat(fn) {
  await fn(); // warm-up: module load, JIT, worker file cache
  const runs = [];
  for (let i = 0; i < REPS; i++) runs.push(await measure(fn));
  return summarizeRuns(runs);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-"));
  try {
    console.error(`Generating ${STEPS} steps of ${(N + 1) ** 3} nodes in ${dir} ...`);
    for (let s = 1; s <= STEPS; s++) fs.writeFileSync(path.join(dir, `Bench_0_${s}.mdpa`), blockMdpa(N, s));
    const found = fileGroupMod.findGroupForFile(
      fileGroupMod.groupVtkFiles(fs.readdirSync(dir), formatsMod.TIMELINE_EXTENSIONS),
      "Bench_0_1.mdpa"
    );
    if (!found) throw new Error("benchmark series was not discovered as a group");
    const source = { kind: "group", group: jobMod.serializeGroup(found.group), dir, rank: found.rank, mdpa: true };

    const flowSpec = { sections: [{ name: "in", part: "Inlet" }, { name: "out", part: "Outlet" }] };
    const fieldScan = { kind: "field", spec: { kind: "Nodal", variable: "PRESSURE", entityId: 1 } };
    const flowScan = { kind: "flow", spec: flowSpec };

    const model = await mdpaParser.parseMdpaFile(path.join(dir, "Bench_0_1.mdpa"));
    const skin = skinMod.extractSkinModel(model).model;
    const probeParams = { points: [[0, 0.5, 0.5], [N, 0.5, 0.5]], samples: 20000, variable: "PRESSURE" };

    const hasSeriesWorker = workersBuilt("seriesScanWorker.js") && clientMod;
    const hasAnalysisWorker = workersBuilt("analysisWorker.js") && analysisClient;
    const cases = [
      {
        name: "series field scan",
        inProcess: () => jobMod.runSeriesScan(jobMod.stepsForSource(source), fieldScan),
        worker: hasSeriesWorker && (() => clientMod.runSeriesScanInWorker(source, fieldScan)),
      },
      {
        name: "series flow-balance scan",
        inProcess: () => jobMod.runSeriesScan(jobMod.stepsForSource(source), flowScan),
        worker: hasSeriesWorker && (() => clientMod.runSeriesScanInWorker(source, flowScan)),
      },
      {
        name: "line probe",
        inProcess: () => probeMod.probeAlongPath(model, probeParams),
        worker: hasAnalysisWorker && (() => analysisClient.runProbeInWorker(model, probeParams)),
      },
      {
        name: "watertight (skin)",
        inProcess: () => watertightMod.watertightReport(skin),
        worker: hasAnalysisWorker && (() => analysisClient.runWatertightInWorker(skin)),
      },
    ];

    const rows = [];
    const verdicts = [];
    for (const c of cases) {
      console.error(`Measuring ${c.name} ...`);
      const baseline = await repeat(c.inProcess);
      const worker = c.worker ? await repeat(c.worker) : undefined;
      rows.push({ name: c.name, mode: "in-process", ...baseline });
      if (worker) rows.push({ name: c.name, mode: "worker", ...worker });
      verdicts.push(judgeCase(c.name, baseline, worker, { maxStallMs: MAX_STALL }));
    }

    const machine = `Node ${process.version}, ${os.cpus().length} CPUs, ${os.platform()}/${os.arch()}`;
    const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a");
    console.log(`Host-heartbeat benchmark — ${machine}`);
    console.log(`Node, single machine, software only. ${STEPS} steps x ${(N + 1) ** 3} nodes, ${REPS} reps (median). Worker wall time includes the structured clone of the input.\n`);
    console.log("| case | mode | wall ms | p99 ms | max stall ms | ΔRSS MB |");
    console.log("| --- | --- | ---: | ---: | ---: | ---: |");
    for (const r of rows) console.log(`| ${r.name} | ${r.mode} | ${f(r.wallMs)} | ${f(r.p99Ms)} | ${f(r.maxStallMs)} | ${f(r.rssDeltaMb)} |`);
    console.log("");
    for (const v of verdicts) console.log(`- ${v.name}: **${v.verdict}** — ${v.reason}`);

    const json = opt("json", undefined);
    if (json) fs.writeFileSync(json, JSON.stringify({ machine, nodes: (N + 1) ** 3, steps: STEPS, reps: REPS, rows, verdicts }, null, 2));
    if (flag("check") && !checkPasses(verdicts, { strict: flag("strict") })) {
      console.error("\n--check failed.");
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
