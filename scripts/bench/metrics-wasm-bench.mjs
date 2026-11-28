#!/usr/bin/env node
/**
 * Benchmark for roadmap item 87, Phase 2: solver element-quality metrics,
 * TypeScript vs the Rust/WASM kernels, on a structured mesh of ~1M tets plus
 * ~200k hexes. Median of 3 runs each (first run of each warms the JIT/WASM).
 *
 * Usage: npm run build:tests && node scripts/bench/metrics-wasm-bench.mjs
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const em = require(path.join(root, "out/parser/elementMetrics.js"));
const wasm = require(path.join(root, "out/parser/mdpaWasm.js"));
if (!wasm.loadMdpaWasm()?.WasmMetricsMesh) {
  console.error("mdpa-core WASM (with WasmMetricsMesh) is not built: npm run build:mdpa-wasm");
  process.exit(2);
}

const nx = 60, ny = 60, nz = 59;
const id = (i, j, k) => 1 + i + nx * (j + ny * k);
const nodeIds = new Int32Array(nx * ny * nz);
const coords = new Float32Array(nx * ny * nz * 3);
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const n = id(i, j, k) - 1;
  nodeIds[n] = n + 1;
  coords.set([i * 0.1 + 0.01 * Math.sin(j + k), j * 0.1 + 0.01 * Math.cos(i + k), k * 0.1], n * 3);
}
const tets = [], hexes = [];
for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
  const n = [id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k), id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1)];
  if ((i + j + k) % 5 === 0) { hexes.push(...n); continue; }
  for (const t of [[0, 1, 2, 5], [0, 2, 3, 7], [0, 4, 5, 7], [6, 5, 2, 7], [0, 5, 2, 7]]) tets.push(...t.map((x) => n[x]));
}
const mk = (name, type, conn, stride) => {
  const count = conn.length / stride;
  return { kind: "Elements", name, vtkCellType: type, count, stride, entityIds: Int32Array.from({ length: count }, (_, i) => i + 1), propertyIds: new Int32Array(count), connectivity: Int32Array.from(conn) };
};
const model = { nodeCount: nodeIds.length, nodeIds, coords, blocks: [mk("T", 10, tets, 4), mk("H", 12, hexes, 8)], subModelParts: [], meta: [], fields: [], diagnostics: [], is3D: true, bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
const cells = model.blocks[0].count + model.blocks[1].count;

const time = (f) => { const t = performance.now(); const r = f(); return [performance.now() - t, r]; };
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const run = (f) => { f(); const ts = []; let r; for (let i = 0; i < 3; i++) { const [t, v] = time(f); ts.push(t); r = v; } return [med(ts), r]; };
const [tTs, rTs] = run(() => em.computeSolverMetricsTs(model));
const [tWasm, rWasm] = run(() => em.computeSolverMetrics(model));
const same = JSON.stringify(rTs.map((m) => m.key)) === JSON.stringify(rWasm.map((m) => m.key));
console.log(JSON.stringify({ cells, tsMs: Math.round(tTs), wasmMs: Math.round(tWasm), speedup: +(tTs / tWasm).toFixed(2), sameKeys: same }, null, 2));
