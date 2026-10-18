#!/usr/bin/env node
// Measures what the virtual wind tunnel really costs, against what its plan estimated
// (roadmap item 21). The estimate in src/problemtype/windTunnel/estimate.ts was fitted on two
// runs before the wall snap and the refinement regions existed, and its peak memory came from
// ONE process. Each case here runs in a FRESH child process with the same worker runners the
// extension host installs (MMG, the meshio++ oracles, meshio++ read and write), so the peak
// resident set the child reports (`process.resourceUsage().maxRSS`, which covers its worker
// threads) is the figure a user's host would see, and the snap and the regions are ON.
//
// Usage (after `npm run compile && npm run build:tests`):
//   node scripts/verify-fluid/estimate-refit.mjs --plan                 # the candidate grid, plan numbers only (fast)
//   node scripts/verify-fluid/estimate-refit.mjs --run [--cases a,b] [--out file.json]
//   node scripts/verify-fluid/estimate-refit.mjs --fit file.json        # fit the three estimate constants to a result file
//
// A case that the plan refuses (above the tetrahedra limit) is recorded as such, never run.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = fileURLToPath(import.meta.url);
const out = (p) => require(path.join(ROOT, "out", p));

/** A sharp L x W x H box surface, outward wound: the snap's worst case (the same one windTunnelSnap.test.ts uses). */
function boxSurface(L, W, H) {
  const { parseMdpa } = out("parser/mdpaParser.js");
  const v = [[0, 0, 0], [L, 0, 0], [L, W, 0], [0, W, 0], [0, 0, H], [L, 0, H], [L, W, H], [0, W, H]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2]];
  let s = "Begin Nodes\n" + v.map((p, i) => `${i + 1} ${p.join(" ")}`).join("\n") + "\nEnd Nodes\n";
  s += "Begin Conditions SurfaceCondition3D3N\n" + f.map((t, i) => `${i + 1} 0 ${t.map((x) => x + 1).join(" ")}`).join("\n") + "\nEnd Conditions\n";
  const r = parseMdpa(s);
  return r.model ?? r;
}

function body(kind) {
  if (kind === "box") return boxSurface(2, 1, 1);
  const { icosphere } = require(path.join(ROOT, "out", "test", "fixtures", "shapes.js"));
  return icosphere(0.5, kind === "sphere2" ? 2 : 1);
}

const TUNNEL = { upstream: 1.5, downstream: 3, side: 2, top: 2, bottom: 2 };

/** A wake-and-body refinement region: the shapes a user reaches for first. */
const REGION = (size) => [{ shape: "box", min: [1.2, -0.8, -0.8], max: [3.2, 1.8, 1.8], size, growth: 0.3 }];

/**
 * The cases: a sharp box (the snap's work) and a smooth sphere, over a ladder of surface sizes, some with a region.
 * `mesh` is the wizard's mesh block; `maxTetrahedra` is lifted so the plan never refuses a case here.
 */
const CASES = [
  { id: "box-s0.30", body: "box", mesh: { surfaceSize: 0.3, farSize: 1.5, firstHeight: 0.04, growth: 1.3, maxAspect: 10 } },
  { id: "box-s0.20", body: "box", mesh: { surfaceSize: 0.2, farSize: 1.5, firstHeight: 0.02, growth: 1.3, maxAspect: 10 } },
  { id: "box-s0.20-region", body: "box", mesh: { surfaceSize: 0.2, farSize: 1.5, firstHeight: 0.02, growth: 1.3, maxAspect: 10 }, regions: 0.15 },
  { id: "box-s0.14", body: "box", mesh: { surfaceSize: 0.14, farSize: 1.5, firstHeight: 0.02, growth: 1.3, maxAspect: 10 } },
  { id: "box-s0.10", body: "box", mesh: { surfaceSize: 0.1, farSize: 1.5, firstHeight: 0.015, growth: 1.3, maxAspect: 10 } },
  { id: "box-s0.10-region", body: "box", mesh: { surfaceSize: 0.1, farSize: 1.5, firstHeight: 0.015, growth: 1.3, maxAspect: 10 }, regions: 0.08 },
  { id: "box-s0.07", body: "box", mesh: { surfaceSize: 0.07, farSize: 1.5, firstHeight: 0.01, growth: 1.3, maxAspect: 10 } },
  { id: "box-s0.05-region", body: "box", mesh: { surfaceSize: 0.05, farSize: 1.5, firstHeight: 0.01, growth: 1.3, maxAspect: 10 }, regions: 0.04 },
  { id: "box-s0.035", body: "box", mesh: { surfaceSize: 0.035, farSize: 1.5, firstHeight: 0.008, growth: 1.3, maxAspect: 10 } },
  { id: "sphere-s0.10", body: "sphere", mesh: { surfaceSize: 0.1, farSize: 1.5, firstHeight: 0.02, growth: 1.3, maxAspect: 10 } },
  { id: "sphere-s0.07-region", body: "sphere2", mesh: { surfaceSize: 0.07, farSize: 1.5, firstHeight: 0.02, growth: 1.3, maxAspect: 10 }, regions: 0.06 },
];

function planFor(c) {
  const { planWindTunnel } = out("problemtype/windTunnel/plan.js");
  const params = {
    flow: { speed: 10 },
    tunnel: TUNNEL,
    mesh: { ...c.mesh, fit: 0.004, wakeLength: 1, wakeSize: 0.5, maxTetrahedra: 1e12, ...(c.regions ? { regions: REGION(c.regions) } : {}) },
  };
  return planWindTunnel(params, body(c.body));
}

function args(argv) {
  const o = { plan: false, run: false, cases: "", out: "", fit: "", child: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") o.plan = true;
    else if (a === "--run") o.run = true;
    else if (a === "--cases") o.cases = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--fit") o.fit = argv[++i];
    else if (a === "--child") o.child = argv[++i];
    else throw new Error(`unknown flag "${a}"`);
  }
  return o;
}

/** The child: one case, workers installed as the extension host installs them, one JSON line on stdout. */
async function child(id) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown case ${id}`);
  const { configureMmgRunner, configureOracleRunner } = out("parser/operations.js");
  const { configureMeshioWriteRunner } = out("parser/writers/meshWriter.js");
  const { configureMeshioReadRunner } = out("parser/meshio.js");
  configureMmgRunner(out("mmgWorkerClient.js").createMmgWorkerRunner({ captureStdio: true }));
  configureOracleRunner(out("oracleOpWorkerClient.js").createOracleWorkerRunner({ captureStdio: true }));
  configureMeshioWriteRunner(out("meshioWriteWorkerClient.js").createMeshioWriteWorkerRunner({ captureStdio: true }));
  configureMeshioReadRunner(out("meshioReadWorkerClient.js").createMeshioReadWorkerRunner({ captureStdio: true }));
  const { runWindTunnel } = out("problemtype/windTunnel/run.js");
  const plan = planFor(c);
  if (plan.errors.length > 0) throw new Error(plan.errors.join("; "));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `vwt-refit-${id}-`));
  const t0 = Date.now();
  const r = await runWindTunnel(plan, { folder, stem: "t" });
  const wall = (Date.now() - t0) / 1000;
  const usage = process.resourceUsage();
  fs.rmSync(folder, { recursive: true, force: true });
  process.stdout.write(
    "RESULT " +
      JSON.stringify({
        id,
        planned: { tetrahedra: plan.estimate.expectedTetrahedra, ideal: plan.estimate.tetrahedra, seconds: plan.estimate.seconds, memoryMb: plan.estimate.memoryMb },
        measured: {
          tetrahedra: r.report.tetrahedra, nodes: r.report.nodes, seconds: wall, reportSeconds: r.report.seconds,
          peakRssMb: usage.maxRSS / 1024, snap: r.report.snap, inverted: r.report.check.inverted,
        },
      }) +
      "\n"
  );
}

function runCase(c) {
  const r = spawnSync(process.execPath, [SELF, "--child", c.id], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 3 * 3600 * 1000 });
  const line = String(r.stdout).split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) return { id: c.id, error: String(r.stderr).split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${r.status}` };
  return JSON.parse(line.slice(7));
}

/** Least squares through the origin in log space: y ~ k x^p, returning k and p. */
function powerFit(points) {
  const n = points.length;
  const lx = points.map(([x]) => Math.log(x));
  const ly = points.map(([, y]) => Math.log(y));
  const mx = lx.reduce((a, b) => a + b, 0) / n;
  const my = ly.reduce((a, b) => a + b, 0) / n;
  const p = lx.reduce((a, x, i) => a + (x - mx) * (ly[i] - my), 0) / lx.reduce((a, x) => a + (x - mx) ** 2, 0);
  return { p, k: Math.exp(my - p * mx) };
}

function fit(file) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8")).results.filter((r) => r.measured);
  const ratio = rows.map((r) => r.measured.tetrahedra / r.planned.ideal);
  const factor = Math.exp(ratio.reduce((a, b) => a + Math.log(b), 0) / ratio.length);
  const time = powerFit(rows.map((r) => [r.measured.tetrahedra, r.measured.seconds]));
  const mem = powerFit(rows.map((r) => [r.measured.tetrahedra, r.measured.peakRssMb]));
  const within = (est, got) => Math.max(est / got, got / est);
  const report = {
    cells: rows.length,
    MMG_CELL_FACTOR: +factor.toFixed(3),
    timeLaw: `seconds = ${time.k.toExponential(3)} * tets^${time.p.toFixed(3)}`,
    memoryLaw: `peakRssMb = ${mem.k.toExponential(3)} * tets^${mem.p.toFixed(3)}`,
    worstTetrahedraRatio: +Math.max(...rows.map((r) => within(r.planned.tetrahedra, r.measured.tetrahedra))).toFixed(2),
  };
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.child) return child(o.child);
  if (o.fit) return fit(o.fit);
  const selected = o.cases ? CASES.filter((c) => o.cases.split(",").includes(c.id)) : CASES;
  if (o.plan) {
    for (const c of selected) {
      const p = planFor(c);
      console.log(`${c.id}\tplanned ${Math.round(p.estimate.expectedTetrahedra)} tets\t${Math.round(p.estimate.seconds)} s\t${Math.round(p.estimate.memoryMb)} MB${p.errors.length ? `\tERRORS ${p.errors.join("; ")}` : ""}`);
    }
    return;
  }
  if (!o.run) throw new Error("pass --plan, --run or --fit FILE");
  const results = [];
  for (const c of selected) {
    const r = runCase(c);
    results.push(r);
    console.log(r.error ? `${c.id}: ERROR ${r.error}` : `${c.id}: ${r.measured.tetrahedra} tets (plan ${Math.round(r.planned.tetrahedra)}), ${r.measured.seconds.toFixed(0)} s (plan ${Math.round(r.planned.seconds)}), peak ${Math.round(r.measured.peakRssMb)} MB (plan ${Math.round(r.planned.memoryMb)}), snap ${r.measured.snap ? `${(r.measured.snap.before * 100).toFixed(2)}% -> ${(r.measured.snap.after * 100).toFixed(2)}%` : "none"}`);
  }
  const record = {
    date: new Date().toISOString().slice(0, 10),
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, totalMemGb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, platform: process.platform },
    note: "Each case in a fresh process with the extension's worker runners installed; peakRssMb is process.resourceUsage().maxRSS (workers included).",
    results,
  };
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(record, null, 2) + "\n");
  else console.log(JSON.stringify(record, null, 2));
}

await main();
