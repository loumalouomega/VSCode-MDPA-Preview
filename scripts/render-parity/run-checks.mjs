#!/usr/bin/env node
// Run every existing Chromium smoke check against the CURRENT media/webview.js,
// each against the harness it expects (roadmap item 18: the per-step gate of
// the renderer-boundary refactor, alongside capture.mjs + compare.mjs).
//
//   npm run compile && npm run build:tests
//   NODE_PATH=<playwright-core dir> node scripts/render-parity/run-checks.mjs
//
// Order matters and is why this runner exists: check-selection reads whatever
// out/screenshot-harness/ currently holds, and check-filename-timeline leaves a
// one-triangle PLY harness behind — run after it, the box-select check fails
// for a reason that has nothing to do with the code under test. So every check
// that does not build its own harness gets the one it needs rebuilt first.
// capture-record-panel.mjs is deliberately not here: it overwrites a committed
// screenshot and asserts only that the panel rendered.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SHOTS = join(ROOT, "scripts", "screenshots");

const CHECKS = [
  { name: "check-selection", harness: {} },
  { name: "check-tier2-forms" },
  { name: "capture-split-legends", harness: { HARNESS_SCENE: "panefields" } },
  { name: "check-filename-timeline" },
];

function run(script, env = {}) {
  return spawnSync(process.execPath, [join(SHOTS, script)], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300_000 });
}

let failed = 0;
for (const c of CHECKS) {
  if (c.harness) {
    const b = run("build-harness.mjs", c.harness);
    if (b.status !== 0) {
      console.log(`FAIL ${c.name}: harness build failed\n${b.stderr}`);
      failed++;
      continue;
    }
  }
  const r = run(`${c.name}.mjs`);
  const tail = `${r.stdout}${r.stderr}`.trim().split("\n").slice(-2).join(" / ");
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: ${tail.slice(0, 220)}`);
}
process.exitCode = failed ? 1 : 0;
