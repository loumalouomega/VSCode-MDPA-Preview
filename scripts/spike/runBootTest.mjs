#!/usr/bin/env node
// Drives boot-shipped.html and boot-augmented.html in headless Chromium and
// reports whether @kitware/vtk-wasm actually boots under each CSP — kill-
// switch G1. Mirrors scripts/screenshots/capture.mjs's launch pattern
// (playwright-core resolved from NODE_PATH, --use-angle=swiftshader).
//
// Prereqs (documented, not automated, matching capture.mjs's own precedent):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   NODE_PATH=/tmp/pw/node_modules npx playwright-core install chromium
//
// Usage:
//   node scripts/spike/serve-spike.mjs &        # in one terminal
//   NODE_PATH=/tmp/pw/node_modules node scripts/spike/runBootTest.mjs

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "..", "out", "spike", "results");
const PORT = Number(process.env.SPIKE_PORT) || 7317;

function resolvePlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req("playwright-core");
  } catch {
    throw new Error(
      "playwright-core not found. Install it out-of-tree and set NODE_PATH:\n" +
      "  mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core\n" +
      "  NODE_PATH=/tmp/pw/node_modules npx playwright-core install chromium\n" +
      "  NODE_PATH=/tmp/pw/node_modules node scripts/spike/runBootTest.mjs"
    );
  }
}

async function runOne(browser, page_, name) {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const consoleLines = [];
  page.on("console", (msg) => consoleLines.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/${name}`, { waitUntil: "load" });
  // Wait for window.__SPIKE_RESULT__ to be set, or time out — this is a
  // network+wasm-instantiate operation (~80 MB), not instantaneous.
  let result;
  try {
    result = await page.waitForFunction(() => window.__SPIKE_RESULT__, { timeout: 30000 })
      .then((h) => h.jsonValue());
  } catch {
    result = { ok: false, reason: "timeout-30s" };
  }
  const logText = await page.locator("#log").textContent().catch(() => "(no #log element)");
  await page.close();
  return { name, result, log: logText, console: consoleLines };
}

async function main() {
  const { chromium } = resolvePlaywright();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  const outcomes = [];
  for (const name of ["boot-shipped.html", "boot-augmented.html"]) {
    console.log(`\n=== ${name} ===`);
    const r = await runOne(browser, null, name);
    console.log(r.log);
    if (r.console.length) console.log("console:\n  " + r.console.join("\n  "));
    outcomes.push(r);
  }
  await browser.close();

  writeFileSync(join(RESULTS_DIR, "g1-boot-test.json"), JSON.stringify(outcomes, null, 2));
  console.log(`\nwrote ${join(RESULTS_DIR, "g1-boot-test.json")}`);

  const shipped = outcomes.find((o) => o.name === "boot-shipped.html");
  const augmented = outcomes.find((o) => o.name === "boot-augmented.html");
  console.log("\n--- G1 VERDICT ---");
  console.log("shipped CSP  boots:", shipped.result.ok === true);
  console.log("augmented CSP boots:", augmented.result.ok === true);
  if (!augmented.result.ok) {
    console.log("KILL SWITCH G1: even the augmented CSP could not boot vtk-wasm. See log above.");
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
