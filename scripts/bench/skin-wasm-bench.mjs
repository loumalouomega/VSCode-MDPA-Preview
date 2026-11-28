#!/usr/bin/env node
/**
 * Benchmark for roadmap item 87, Phase 2: boundary skin extraction,
 * TypeScript vs Rust/WASM, on a 1,009,490-tet structured mesh.
 *
 * Usage: npm run build:tests && node scripts/bench/skin-wasm-bench.mjs
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { extractSkinModel, extractSkinModelTs } = require(path.join(root, "out/parser/extractSkin.js"));
const wasm = require(path.join(root, "out/parser/mdpaWasm.js"));
if (!wasm.loadMdpaWasm()?.WasmSkinExtractor) {
  console.error("mdpa-core WASM (with WasmSkinExtractor) is not built: npm run build:mdpa-wasm");
  process.exit(2);
}

const nx = 60, ny = 60, nz = 59;
const id = (i, j, k) => 1 + i + nx * (j + ny * k);
const N = nx * ny * nz;
const nodeIds = new Int32Array(N);
const coords = new Float32Array(N * 3);
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const n = id(i, j, k) - 1;
  nodeIds[n] = n + 1;
  coords.set([i * 0.1, j * 0.1, k * 0.1], n * 3);
}
const conn = [];
for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
  const n = [id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k), id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1)];
  for (const t of [[0, 1, 2, 5], [0, 2, 3, 7], [0, 4, 5, 7], [6, 5, 2, 7], [0, 5, 2, 7]]) {
    for (const x of t) conn.push(n[x]);
  }
}
const count = conn.length / 4;
const model = {
  nodeCount: N,
  nodeIds,
  coords,
  blocks: [{
    kind: "Elements",
    name: "E",
    vtkCellType: 10,
    count,
    stride: 4,
    entityIds: Int32Array.from({ length: count }, (_, i) => i + 1),
    propertyIds: new Int32Array(count),
    connectivity: Int32Array.from(conn),
  }],
  subModelParts: [],
  meta: [],
  fields: [],
  diagnostics: [],
  is3D: true,
  bounds: { min: [0, 0, 0], max: [6, 6, 6] },
};

const time = (f) => { const t = performance.now(); const r = f(); return [performance.now() - t, r]; };
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const run = (f) => { f(); const ts = []; let r; for (let i = 0; i < 3; i++) { const [t, v] = time(f); ts.push(t); r = v; } return [med(ts), r]; };

const [tWasm, rWasm] = run(() => extractSkinModel(model));
const [tTs, rTs] = run(() => extractSkinModelTs(model));
console.log(JSON.stringify({
  cells: count,
  facesWasm: rWasm.faces,
  facesTs: rTs.faces,
  tsMs: Math.round(tTs),
  wasmMs: Math.round(tWasm),
  speedup: +(tTs / tWasm).toFixed(2),
}, null, 2));
