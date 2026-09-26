#!/usr/bin/env node
// Patch the pinned VTK-wasm glue so it needs no 'unsafe-eval' (roadmap item
// 18, Phase 1). The rewrite itself lives in src/parser/render/vtkWasmGlue.ts
// (unit- and differential-tested); this script only does the I/O and the
// gates around it:
//
//   1. the input glue's sha256 must equal the manifest's pinned file hash;
//   2. patchGlue() must apply every needle exactly once;
//   3. `node --check` must accept the output (it is still valid JS);
//   4. scanDynamicCode() must find ZERO sites in the output;
//   5. the output sha256 is recorded in the manifest the first time
//      (--record) and verified on every later run, so any change to the
//      patch logic surfaces as a deliberate manifest update.
//
//   node scripts/vtk-wasm/patch-glue.mjs --candidate rel-9.7.0 [--build vtkWebAssembly] [--out dir] [--record]
//
// Default output: out/vtk-wasm/prepared-eval/<candidate>/ (patched .mjs plus
// a copy of the untouched .wasm), which is what the evaluation pages load as
// `--glue patched`.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./loadTs.mjs";
import { MANIFEST_PATH, readManifest, sha256 } from "./fetch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

export async function patchCandidate({ candidate, build = "vtkWebAssembly", outDir, record = false }) {
  const m = readManifest();
  const spec = m.candidates[candidate];
  if (!spec) throw new Error(`unknown candidate ${candidate}`);
  const glueName = `${build}.mjs`;
  const pinned = spec.files[glueName];
  if (!pinned) throw new Error(`${candidate} has no pinned ${glueName}`);
  const srcDir = join(ROOT, "out", "vtk-wasm", candidate);
  const src = readFileSync(join(srcDir, glueName));
  if (sha256(src) !== pinned.sha256) {
    throw new Error(`${candidate}/${glueName}: sha256 ${sha256(src)} does not match the pin ${pinned.sha256} — run fetch.mjs`);
  }

  const { patchGlue, scanDynamicCode } = await loadTs("src/parser/render/vtkWasmGlue.ts");
  const before = scanDynamicCode(src.toString("utf8")).length;
  const { output, variant, applied } = patchGlue(src.toString("utf8"));
  const after = scanDynamicCode(output).length;
  if (after !== 0) throw new Error(`dynamic code survives: ${after} sites`);

  const dest = outDir ?? join(ROOT, "out", "vtk-wasm", "prepared-eval", candidate);
  mkdirSync(dest, { recursive: true });
  const outFile = join(dest, glueName);
  writeFileSync(outFile, output);
  execFileSync(process.execPath, ["--check", outFile], { stdio: "pipe" });
  const outSha = sha256(Buffer.from(output));

  spec.glue ??= {};
  const key = `${build}`;
  const prev = spec.glue[key];
  if (prev && prev.outputSha256 !== outSha) {
    throw new Error(
      `${candidate}/${glueName}: patched output sha256 ${outSha} differs from the recorded ${prev.outputSha256}. ` +
        "The patch logic or needles changed — review, then re-record deliberately with --record after deleting the old entry."
    );
  }
  if (!prev) {
    if (!record) throw new Error(`${candidate}/${glueName}: no recorded patched-output hash yet — run once with --record`);
    spec.glue[key] = { variant, patches: applied, inputSha256: pinned.sha256, outputSha256: outSha, outputBytes: Buffer.byteLength(output) };
    writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
  }

  const wasmName = `${build}.wasm`;
  copyFileSync(join(srcDir, wasmName), join(dest, wasmName));
  return { candidate, build, variant, applied, dynamicSitesBefore: before, dynamicSitesAfter: after, outputSha256: outSha, outFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  patchCandidate({
    candidate: arg(argv, "candidate", "rel-9.7.0"),
    build: arg(argv, "build", "vtkWebAssembly"),
    outDir: arg(argv, "out", undefined),
    record: argv.includes("--record"),
  })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.message || e);
      process.exit(1);
    });
}
