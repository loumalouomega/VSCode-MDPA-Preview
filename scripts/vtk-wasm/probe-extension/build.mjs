#!/usr/bin/env node
// Assemble the throwaway probe extension (G0.6 + G1.5) into out/vtk-wasm/probe-ext/.
// The CSP template comes from the REAL buildPreviewHtml (src/webviewChrome.ts)
// with placeholder cspSource/nonce, so V0 is byte-for-byte the shipped policy.
//
//   node scripts/vtk-wasm/probe-extension/build.mjs [--candidate latest-9.7.20260920]

import { copyFileSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "../loadTs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const i = argv.indexOf("--candidate");
const candidate = i >= 0 ? argv[i + 1] : "latest-9.7.20260920";
const OUT = join(ROOT, "out", "vtk-wasm", "probe-ext");

export async function buildProbe() {
  const { buildPreviewHtml } = await loadTs("src/webviewChrome.ts");
  const html = buildPreviewHtml({ scriptUri: "s", designSystemUri: "d", styleUri: "c", cspSource: "__CSP_SOURCE__", nonce: "__NONCE__", title: "t", theme: "dark" });
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!m) throw new Error("no CSP meta in buildPreviewHtml output");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "media"), { recursive: true });
  writeFileSync(
    join(OUT, "package.json"),
    JSON.stringify({ name: "vtkwasm-probe", publisher: "kratos-dev", version: "0.0.1", engines: { vscode: "^1.100.0" }, main: "./extension.js", activationEvents: ["onStartupFinished"] }, null, 2)
  );
  writeFileSync(join(OUT, "csp-template.json"), JSON.stringify({ csp: m[1] }, null, 2));
  copyFileSync(join(HERE, "extension.js"), join(OUT, "extension.js"));
  copyFileSync(join(HERE, "probe.js"), join(OUT, "media", "probe.js"));
  copyFileSync(join(ROOT, "out", "vtk-wasm", "prepared-eval", candidate, "vtkWebAssembly.mjs"), join(OUT, "media", "vtkWebAssembly.mjs"));
  copyFileSync(join(ROOT, "out", "vtk-wasm", candidate, "vtkWebAssembly.mjs"), join(OUT, "media", "vtkWebAssembly.orig.mjs"));
  linkSync(join(ROOT, "out", "vtk-wasm", candidate, "vtkWebAssembly.wasm"), join(OUT, "media", "vtkWebAssembly.wasm"));
  return { out: OUT, shippedCsp: m[1] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await buildProbe();
  console.log(JSON.stringify(r, null, 2));
}
