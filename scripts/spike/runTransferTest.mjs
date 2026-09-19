#!/usr/bin/env node
// Drives transfer.html (kill-switch G2). See buildTransferPage.mjs.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "..", "out", "spike", "results");
const PORT = Number(process.env.SPIKE_PORT) || 7317;

function resolvePlaywright() {
  const req = createRequire(import.meta.url);
  return req("playwright-core");
}

async function main() {
  const { chromium } = resolvePlaywright();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/transfer.html`, { waitUntil: "load" });
  const result = await page.waitForFunction(() => window.__SPIKE_RESULT__, { timeout: 60000 })
    .then((h) => h.jsonValue())
    .catch(() => ({ ok: false, reason: "timeout-60s" }));
  const logText = await page.locator("#log").textContent().catch(() => "");
  console.log(logText);
  await browser.close();

  writeFileSync(join(RESULTS_DIR, "g2-transfer-test.json"), JSON.stringify({ result, console: consoleLines }, null, 2));
  console.log(`\nwrote ${join(RESULTS_DIR, "g2-transfer-test.json")}`);
  console.log("\n--- G2 VERDICT ---");
  console.log("ok:", result.ok);
  if (result.ok) {
    const largest = result.sizes[result.sizes.length - 1];
    console.log(`largest tested: ${largest.n.toExponential(0)} points, ${(largest.bytesIn/1048576).toFixed(1)} MB, ${largest.transferMs.toFixed(1)} ms, ${largest.mbPerSec.toFixed(0)} MB/s, roundTrip=${largest.roundTripOk}`);
    console.log("view-invalidation contract observed:", JSON.stringify(result.invalidation));
  } else {
    console.log("KILL SWITCH G2:", result.reason);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
