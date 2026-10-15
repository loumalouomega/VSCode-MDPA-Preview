#!/usr/bin/env node
/**
 * Plot budget benchmark (roadmap item 9): million-row table read, history
 * extraction through the persistent cache (cold / hashed hit / stat-shortcut
 * hit) and worker cancellation latency.
 *
 *   npm run compile && npm run build:tests
 *   node scripts/bench/plot-budget.mjs [--rows 1000000] [--nodes 20000] [--steps 12] [--reps 3]
 *        [--json out.json] [--check] [--strict] [--env "label"]
 *
 * Node-level, single machine: it measures the Node main thread (what a VS Code
 * extension host is) and a worker. It is NOT a measurement inside VS Code,
 * Remote-SSH, the webview delivery path or a packaged VSIX; those stay
 * pending. Deliberately not part of `npm test` (timing on shared CI is flaky).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGETS, judgePlotCase, judgeStatShortcut, plotBudgetPasses, summarizePlotRuns } from "./plotBudgetStats.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const ROWS = Number(opt("rows", 1_000_000));
const NODES = Number(opt("nodes", 60000));
const STEPS = Number(opt("steps", 12));
const REPS = Number(opt("reps", 3));
const load = (rel) => { const f = path.join(root, rel); return fs.existsSync(f) ? require(f) : undefined; };
const sources = load("out/parser/plot/sources.js");
const cacheMod = load("out/parser/plot/persistentCache.js");
const clientMod = load("out/plotWorkerClient.js");
const recipeMod = load("out/parser/plot/recipe.js");
if (!sources || !cacheMod || !clientMod || !recipeMod || !fs.existsSync(path.join(root, "out/plotWorker.js"))) {
  console.error("Missing compiled output: run `npm run compile && npm run build:tests` first.");
  process.exit(2);
}

// Child mode: one table case in a fresh process so the RSS high-water mark is that case's own.
if (opt("child")) {
  const recipe = recipeMod.emptyPlotRecipe({ id: "t", type: "table", path: opt("csv") });
  recipe.series.push({ id: "s", source: "t", name: "a vs t", x: "c0", y: "c1" });
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  const t0 = performance.now(); let points = 0;
  if (opt("child") === "worker") {
    const session = new clientMod.PlotWorkerSession();
    try { points = (await session.run({ recipe })).series[0].points.length; } finally { await session.dispose(); }
  } else if (opt("child") === "inProcess") points = (await sources.collectPlot(recipe)).series[0].points.length;
  const wallMs = performance.now() - t0; h.disable();
  console.log(JSON.stringify({ wallMs, maxStallMs: h.max / 1e6, peakRssMb: process.resourceUsage().maxRSS / 1024, points }));
  process.exit(0);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "plot-budget-"));

async function measure(fn) {
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  let peak = process.memoryUsage().rss; const base = peak;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const t0 = performance.now();
  let extra;
  try { extra = await fn(); } finally { clearInterval(timer); h.disable(); }
  const wallMs = performance.now() - t0;
  peak = Math.max(peak, process.memoryUsage().rss);
  return { wallMs, maxStallMs: h.max / 1e6, peakRssMb: (peak - base) / 1048576, extra };
}
const repeat = async (fn, setup) => { const runs = []; for (let i = 0; i < REPS; i++) { await setup?.(); runs.push(await measure(fn)); } return summarizePlotRuns(runs); };

// --- fixtures ---------------------------------------------------------------
const csv = path.join(scratch, "big.csv");
{
  const fd = fs.openSync(csv, "w");
  fs.writeSync(fd, "t,a,b,c,d,e,f,g\n");
  for (let start = 0; start < ROWS; start += 50000) {
    let chunk = "";
    for (let i = start; i < Math.min(ROWS, start + 50000); i++) chunk += `${i},${i * 0.5},${i % 97},${Math.sin(i)},${i * 2},${i % 13},${i / 7},${i * 3}\n`;
    fs.writeSync(fd, chunk);
  }
  fs.closeSync(fd);
}
const fileMb = fs.statSync(csv).size / 1048576;
const histDir = path.join(scratch, "series"); fs.mkdirSync(histDir);
for (let s = 0; s < STEPS; s++) {
  let t = "Begin Nodes\n";
  for (let n = 1; n <= NODES; n++) t += `${n} ${n} 0 0\n`;
  t += "End Nodes\nBegin Elements Element2D2N\n";
  for (let n = 1; n < NODES; n++) t += `${n} 0 ${n} ${n + 1}\n`;
  t += `End Elements\nBegin NodalData TEMP\n`;
  for (let n = 1; n <= NODES; n++) t += `${n} 0 ${(n * (s + 1)) % 101}\n`;
  t += "End NodalData\n";
  fs.writeFileSync(path.join(histDir, `Run_0_${s}.mdpa`), t);
}
await new Promise((r) => setTimeout(r, 50));
const tableSource = { id: "t", type: "table", path: csv };
const history = { id: "h", type: "history", path: path.join(histDir, "Run_0_0.mdpa"), kind: "Nodal", entityId: Math.floor(NODES / 2), variable: "TEMP" };
const results = {};

// --- table: the real plotting route (recipe -> dataset), in-process vs worker, one fresh process per run ---
const { spawnSync } = await import("node:child_process");
const childRow = (mode) => {
  const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", mode, "--csv", csv], { encoding: "utf8", maxBuffer: 1 << 20 });
  if (out.status !== 0) throw new Error(`child ${mode} failed: ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split("\n").pop());
};
const baselineRss = childRow("none").peakRssMb; // empty process: node + loaded modules
const tableCase = (mode) => { const runs = []; for (let i = 0; i < REPS; i++) { const r = childRow(mode); runs.push({ ...r, peakRssMb: Math.max(0, r.peakRssMb - baselineRss) }); } const row = summarizePlotRuns(runs); row.extra = { fileMb }; return row; };
results.tableInProcess = tableCase("inProcess");
results.tableWorker = tableCase("worker");

// --- history: cold / hashed hit / stat-shortcut hit ------------------------
const cacheDir = path.join(scratch, "cache");
const settle = { statSettleMs: 10 };
const histCase = (opts) => repeat(async () => { const c = new cacheMod.PersistentPlotCache(cacheDir, opts); await sources.loadPlotSource(history, { persistent: c }); return { ...c.counters }; });
results.historyCold = await repeat(async () => { fs.rmSync(cacheDir, { recursive: true, force: true }); const c = new cacheMod.PersistentPlotCache(cacheDir, settle); await sources.loadPlotSource(history, { persistent: c }); return { ...c.counters }; });
await histCase(settle); // warm both the entry and the stat manifest
results.historyHashedHit = await histCase({ statFastPath: false });
results.historyStatHit = await histCase(settle);

const cancelRecipe = recipeMod.emptyPlotRecipe(tableSource);
cancelRecipe.series.push({ id: "s", source: "t", name: "a vs t", x: "c0", y: "c1" });
// --- cancellation latency ---------------------------------------------------
results.cancel = await repeat(async () => {
  const session = new clientMod.PlotWorkerSession(), ac = new AbortController();
  const run = session.run({ recipe: cancelRecipe }, { signal: ac.signal }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 20));
  const t0 = performance.now(); ac.abort(); await run; const ms = performance.now() - t0;
  await session.dispose();
  return { abortToSettleMs: ms };
}).then((row) => ({ ...row, wallMs: row.extra?.abortToSettleMs ?? row.wallMs }));

const verdicts = [
  judgePlotCase("table-worker", results.tableWorker),
  judgePlotCase("table-memory", results.tableInProcess),
  judgePlotCase("cancel", results.cancel),
  judgeStatShortcut(results.historyHashedHit, results.historyStatHit),
];
const env = opt("env", `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? "?"} x${os.cpus().length}, node ${process.version}`);
const report = { env, rows: ROWS, fileMb: Number(fileMb.toFixed(1)), nodes: NODES, steps: STEPS, reps: REPS, budgets: DEFAULT_BUDGETS, results, verdicts, notMeasured: ["VS Code extension host", "Remote-SSH / network filesystems", "webview delivery", "packaged VSIX"] };
const f = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");
console.log(`env: ${env}\nrows ${ROWS} (${f(fileMb)} MiB), history ${STEPS} steps x ${NODES} nodes, ${REPS} reps (medians)`);
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(18)} wall ${f(v.wallMs).padStart(9)} ms  stall ${f(v.maxStallMs).padStart(8)} ms  rss+ ${f(v.peakRssMb).padStart(8)} MB`);
for (const v of verdicts) console.log(`${v.verdict.toUpperCase().padEnd(12)} ${v.name}: ${v.reason}`);
console.log(`not measured: ${report.notMeasured.join(", ")}`);
if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify(report, null, 2));
fs.rmSync(scratch, { recursive: true, force: true });
if (flag("check") && !plotBudgetPasses(verdicts, { strict: flag("strict") })) process.exit(1);
