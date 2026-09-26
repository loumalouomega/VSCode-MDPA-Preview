#!/usr/bin/env node
// G0.3 (static half): check src/parser/render/vtkWasmApiUsage.ts against the
// pinned build's types/*.json method table, and emit the table the loader
// would read as vtk-methods.json in directory mode.
//
//   node scripts/vtk-wasm/audit-usage.mjs [--candidate latest-9.7.20260920] [--write-table]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./loadTs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const argv = process.argv.slice(2);
const i = argv.indexOf("--candidate");
const candidate = i >= 0 ? argv[i + 1] : "latest-9.7.20260920";

export async function auditUsage(candidate) {
  const typesDir = join(ROOT, "out", "vtk-wasm", candidate, "types");
  const manifests = readdirSync(typesDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(typesDir, f), "utf8")));
  const mt = await loadTs("src/parser/render/vtkWasmMethodTable.ts");
  const { VTK_WASM_API_USAGE, VTK_WASM_BOOL_PARAM_METHODS } = await loadTs("src/parser/render/vtkWasmApiUsage.ts");
  const table = mt.buildMethodTable(manifests);
  const { resolved, problems } = mt.classifyUsage(table, VTK_WASM_API_USAGE);
  for (const p of mt.boolParamProblems(manifests, VTK_WASM_API_USAGE, VTK_WASM_BOOL_PARAM_METHODS)) {
    const [problem, rest] = p.split(": ");
    const [cls, method] = rest.split("::");
    problems.push({ entry: { cls, method }, problem });
  }
  return { table, mt, resolved, problems, suspending: mt.suspendingMethods(table), classes: Object.keys(table).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await auditUsage(candidate);
  const summary = {
    candidate,
    classes: r.classes,
    usageEntries: r.resolved.length + r.problems.length,
    resolved: r.resolved.length,
    problems: r.problems.map((p) => `${p.problem}: ${p.entry.cls}::${p.entry.method}`),
    suspendingMethods: r.suspending,
  };
  const outDir = join(ROOT, "out", "vtk-wasm-eval", "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `g0-3-usage-${candidate}.json`), JSON.stringify({ ...summary, resolvedDetail: r.resolved }, null, 2));
  if (argv.includes("--write-table")) {
    const f = join(ROOT, "out", "vtk-wasm", candidate, "vtk-methods.json");
    writeFileSync(f, r.mt.serializeMethodTable(r.table));
    console.log(`method table -> ${f}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (r.problems.length) process.exitCode = 1;
}
