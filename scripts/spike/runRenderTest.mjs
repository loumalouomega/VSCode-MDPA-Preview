#!/usr/bin/env node
// Drives render.html (kill-switch G3, minimal). See buildRenderPage.mjs.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "..", "out", "spike", "results");
const PORT = Number(process.env.SPIKE_PORT) || 7317;

function resolvePlaywright() {
  return createRequire(import.meta.url)("playwright-core");
}

async function main() {
  const { chromium } = resolvePlaywright();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/render.html`, { waitUntil: "load" });
  const result = await page.waitForFunction(() => window.__SPIKE_RESULT__, { timeout: 30000 })
    .then((h) => h.jsonValue())
    .catch(() => ({ ok: false, reason: "timeout-30s" }));
  const logText = await page.locator("#log").textContent().catch(() => "");
  console.log(logText);
  await page.screenshot({ path: join(RESULTS_DIR, "g3-render.png") });
  await browser.close();

  writeFileSync(join(RESULTS_DIR, "g3-render-test.json"), JSON.stringify({ result, console: consoleLines }, null, 2));
  console.log(`\nwrote ${join(RESULTS_DIR, "g3-render-test.json")}`);
  console.log(`wrote ${join(RESULTS_DIR, "g3-render.png")}`);
  console.log("\n--- G3 (minimal) VERDICT ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
