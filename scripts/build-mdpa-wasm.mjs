#!/usr/bin/env node
/**
 * Build the `mdpa-core` Rust/WASM crate into `src/parser/wasm/mdpa-core/`
 * (roadmap item 87).
 *
 * Requires:
 *   - Rust toolchain with `wasm32-unknown-unknown` target
 *   - `wasm-bindgen-cli` matching the `wasm-bindgen` version in Cargo.toml
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CRATE_DIR = path.join(REPO_ROOT, "crates", "mdpa-core");
const OUT_DIR = path.join(REPO_ROOT, "src", "parser", "wasm", "mdpa-core");
const WASM_IN = path.join(
  CRATE_DIR,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "mdpa_core.wasm"
);

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${path.join(process.env.HOME || "", ".cargo", "bin")}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

const t0 = performance.now();
run("cargo", [
  "build",
  "--manifest-path",
  path.join(CRATE_DIR, "Cargo.toml"),
  "--target",
  "wasm32-unknown-unknown",
  "--release",
]);

fs.mkdirSync(OUT_DIR, { recursive: true });
run("wasm-bindgen", [
  "--target",
  "nodejs",
  "--out-dir",
  OUT_DIR,
  "--out-name",
  "mdpa_core",
  WASM_IN,
]);

const wasmOut = path.join(OUT_DIR, "mdpa_core_bg.wasm");
const sizeKb = (fs.statSync(wasmOut).size / 1024).toFixed(1);
console.log(
  `[mdpa-core] built ${path.relative(REPO_ROOT, wasmOut)} (${sizeKb} KB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`
);
