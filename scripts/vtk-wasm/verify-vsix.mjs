#!/usr/bin/env node
// Verify that a packaged .vsix carries the VTK-wasm renderer runtime intact
// (roadmap item 18, Phase 3): every file in extension/media/vtk-wasm/ matches
// the shipped provenance manifest byte for byte, the licence notices are
// present, and the glue AS SHIPPED contains no dynamic-code site (so the
// webview never needs 'unsafe-eval'). Prints the package sizes.
//
//   node scripts/vtk-wasm/verify-vsix.mjs path/to/extension.vsix
//
// Reuses the extension's own dependency-free ZIP reader (src/parser/zip.ts)
// and glue scanner (src/parser/render/vtkWasmGlue.ts) through loadTs.

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadTs } from "./loadTs.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: verify-vsix.mjs <extension.vsix>");
  process.exit(2);
}
const { readZip } = await loadTs("src/parser/zip.ts");
const { scanDynamicCode } = await loadTs("src/parser/render/vtkWasmGlue.ts");
const entries = new Map(readZip(readFileSync(file)).map((e) => [e.name, e.data]));
const PREFIX = "extension/media/vtk-wasm/";
const problems = [];
const manifestBuf = entries.get(`${PREFIX}vtk-wasm-assets.json`);
if (!manifestBuf) problems.push("vtk-wasm-assets.json missing");
let unpacked = 0;
if (manifestBuf) {
  const manifest = JSON.parse(Buffer.from(manifestBuf).toString("utf8"));
  for (const [name, want] of Object.entries(manifest.files)) {
    const data = entries.get(PREFIX + name);
    if (!data) {
      problems.push(`${name}: missing`);
      continue;
    }
    unpacked += data.length;
    const sha = createHash("sha256").update(data).digest("hex");
    if (data.length !== want.bytes || sha !== want.sha256) problems.push(`${name}: ${data.length} bytes sha256 ${sha}`);
  }
  for (const req of ["vtkWebAssembly.mjs", "vtkWebAssembly.wasm", "LICENSE.vtk.txt", "THIRD_PARTY_NOTICES.md"]) {
    if (!manifest.files[req]) problems.push(`${req}: not in manifest`);
  }
  const glue = entries.get(`${PREFIX}vtkWebAssembly.mjs`);
  if (glue) {
    const sites = scanDynamicCode(Buffer.from(glue).toString("utf8"));
    if (sites.length) problems.push(`glue has ${sites.length} dynamic-code site(s)`);
  }
}
const summary = {
  vsix: file,
  vsixBytes: statSync(file).size,
  vtkWasmUnpackedBytes: unpacked,
  entries: entries.size,
  ok: problems.length === 0,
  problems,
};
console.log(JSON.stringify(summary, null, 2));
if (problems.length) process.exit(1);
