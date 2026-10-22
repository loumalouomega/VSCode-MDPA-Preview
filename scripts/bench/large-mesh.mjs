#!/usr/bin/env node
/**
 * Large-mesh benchmark (roadmap item 7): a synthetic hexahedral block with
 * nodal fields, measured through the parts of the preview path that scale with
 * mesh size: the .mdpa parse, the model-to-wire conversion with its posted
 * size, and the level-of-detail surface.
 *
 *   npm run compile && npm run build:tests
 *   node scripts/bench/large-mesh.mjs [--n 100] [--fields 6] [--reps 3] [--json out.json] [--check] [--strict] [--env "label"]
 *
 * `--n` is the number of cells per axis (100 gives 1M hexahedra). Node-level,
 * single machine: NOT a measurement inside VS Code, Remote-SSH, the webview
 * delivery path or a packaged VSIX. Deliberately not part of `npm test`.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v8 from "node:v8";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGETS, judgeMeshCase, largeMeshPasses, summarizeMeshRuns } from "./largeMeshStats.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const N = Number(opt("n", 100));
const FIELDS = Number(opt("fields", 6));
const REPS = Number(opt("reps", 3));
const load = (rel) => { const f = path.join(root, rel); return fs.existsSync(f) ? require(f) : undefined; };
const wire = load("out/parser/modelWire.js");
const lod = load("out/parser/lodSurface.js");
const mdpa = load("out/parser/mdpaParser.js");
const builder = load("out/parser/modelBuilder.js");
if (!wire || !lod || !mdpa || !builder) {
  console.error("Missing compiled output: run `npm run compile && npm run build:tests` first.");
  process.exit(2);
}

function buildModel(n, nFields) {
  const idx = (i, j, k) => i + j * (n + 1) + k * (n + 1) * (n + 1);
  const np = (n + 1) ** 3;
  const coords = new Float32Array(np * 3);
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const p = idx(i, j, k) * 3; coords[p] = i; coords[p + 1] = j; coords[p + 2] = k;
  }
  const nc = n ** 3;
  const connectivity = new Int32Array(nc * 8);
  const entityIds = new Int32Array(nc);
  let c = 0;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++, c++) {
    const q = [idx(i, j, k), idx(i + 1, j, k), idx(i + 1, j + 1, k), idx(i, j + 1, k), idx(i, j, k + 1), idx(i + 1, j, k + 1), idx(i + 1, j + 1, k + 1), idx(i, j + 1, k + 1)];
    for (let m = 0; m < 8; m++) connectivity[c * 8 + m] = q[m] + 1;
    entityIds[c] = c + 1;
  }
  const blocks = [{ kind: "Elements", name: "Hexahedra3D8", vtkCellType: 12, count: nc, stride: 8, entityIds, connectivity }];
  const fields = [];
  for (let f = 0; f < nFields; f++) {
    const comps = f % 2 === 0 ? 1 : 3;
    const ids = new Int32Array(np); const values = new Float64Array(np * comps);
    for (let p = 0; p < np; p++) { ids[p] = p + 1; for (let m = 0; m < comps; m++) values[p * comps + m] = Math.sin(p * 0.001 + f + m); }
    fields.push({ kind: "Nodal", variable: `FIELD_${f}`, components: comps, ids, values });
  }
  return builder.finalizeModel({ nodeCount: np, coords, blocks, fields, diagnostics: [] });
}

const wallOf = async (fn) => { const t0 = performance.now(); const extra = await fn(); return { wallMs: performance.now() - t0, maxStallMs: 0, extra }; };
const repeat = async (fn) => { const runs = []; for (let i = 0; i < REPS; i++) runs.push(await wallOf(fn)); return summarizeMeshRuns(runs); };
const serializedBytes = (m) => v8.serialize(m).length;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "large-mesh-"));
const model = buildModel(N, FIELDS);
const fieldRows = model.fields.reduce((s, f) => s + f.ids.length, 0);
const geometryBytes = model.coords.byteLength + model.nodeIds.byteLength + model.blocks.reduce((s, b) => s + b.connectivity.byteLength + b.entityIds.byteLength, 0);
const modelMb = (geometryBytes + model.fields.reduce((s, f) => s + f.ids.byteLength + f.values.byteLength, 0)) / 1048576;
const results = {};

results["wire-eager"] = await repeat(async () => {
  const w = wire.toWireModel(model);
  return { fieldRows, geometryBytes, postedBytes: serializedBytes(w) };
});

results["lod"] = await repeat(async () => {
  const r = await lod.lodSurface(model);
  return { sourceFaces: r.sourceFaces, keptFaces: r.keptFaces };
});

// Parse cost of the same block as .mdpa text (nodes + hexahedra only), after the model above.
const text = path.join(scratch, "big.mdpa");
{
  const fd = fs.openSync(text, "w");
  const np = model.nodeIds.length;
  fs.writeSync(fd, "Begin Nodes\n");
  for (let s = 0; s < np; s += 50000) {
    let chunk = "";
    for (let p = s; p < Math.min(np, s + 50000); p++) chunk += `${p + 1} ${model.coords[p * 3]} ${model.coords[p * 3 + 1]} ${model.coords[p * 3 + 2]}\n`;
    fs.writeSync(fd, chunk);
  }
  fs.writeSync(fd, "End Nodes\nBegin Elements Element3D8N\n");
  const b = model.blocks[0];
  for (let s = 0; s < b.count; s += 50000) {
    let chunk = "";
    for (let c = s; c < Math.min(b.count, s + 50000); c++) chunk += `${c + 1} 0 ${Array.from(b.connectivity.subarray(c * 8, c * 8 + 8)).join(" ")}\n`;
    fs.writeSync(fd, chunk);
  }
  fs.writeSync(fd, "End Elements\n");
  fs.closeSync(fd);
}
results["parse"] = await repeat(async () => {
  const m = await mdpa.parseMdpaFile(text);
  return { nodes: m.nodeIds.length, fileMb: fs.statSync(text).size / 1048576 };
});
fs.rmSync(scratch, { recursive: true, force: true });

const peakRssMb = process.resourceUsage().maxRSS / 1024;
results["memory"] = { wallMs: 0, maxStallMs: 0, extra: { peakRssMb, modelMb } };

const verdicts = Object.keys(results).filter((k) => k !== "parse").map((k) => judgeMeshCase(k, results[k], DEFAULT_BUDGETS));
console.log(`large-mesh: ${N}^3 = ${(N ** 3).toLocaleString("en-US")} hexahedra, ${model.nodeIds.length.toLocaleString("en-US")} nodes, ${FIELDS} fields, model ${modelMb.toFixed(0)} MB ${opt("env", "") ? `[${opt("env")}]` : ""}`);
for (const [k, r] of Object.entries(results)) console.log(`  ${k.padEnd(11)} wall ${r.wallMs.toFixed(0).padStart(7)} ms`, JSON.stringify(r.extra));
for (const v of verdicts) console.log(`  [${v.verdict}] ${v.name}: ${v.reason}`);
if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify({ n: N, fields: FIELDS, results, verdicts }, null, 2));
if (flag("check") && !largeMeshPasses(verdicts, { strict: flag("strict") })) process.exit(1);
