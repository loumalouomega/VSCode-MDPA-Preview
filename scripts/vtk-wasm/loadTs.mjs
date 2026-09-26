// Load a pure src/** TypeScript module from a script without `npm run
// build:tests`: bundle it on the fly with esbuild (already a devDependency)
// into a CJS temp file and require it. Generalizes the loadChrome() trick in
// scripts/spike/realCsp.mjs, so the build scripts under scripts/vtk-wasm/ run
// on a bare checkout after `npm ci` and cannot drift from the tested module.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

/** @param {string} relPath repo-relative path to a .ts module */
export async function loadTs(relPath) {
  const esbuild = require("esbuild");
  const outDir = join(ROOT, "out", "vtk-wasm", "ts-cache");
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `${basename(relPath, ".ts")}.cjs`);
  await esbuild.build({
    entryPoints: [join(ROOT, relPath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile,
    logLevel: "warning",
  });
  delete require.cache[outfile];
  return require(outfile);
}
