// Chromium smoke check for the operation queue (roadmap item 5, slice D):
// reorder/edit rows, saveQueue/loadQueue messages and queueLoaded staging.
//
// `webview/opQueue.ts` needs a DOM, and the queue state core already has
// Node coverage (`src/test/opQueueCore.test.ts`) — but the row buttons, the
// inline JSON editor and the host message shapes only exist in the real
// bundle, where a wrong element id fails silently. This script drives the
// REAL webview bundle in the screenshot harness and asserts on
// `window.SENT_MESSAGES` plus the rendered rows.
//
// Setup and run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-op-queue.mjs
// Chromium comes from PLAYWRIGHT_EXE when set (a cached ms-playwright
// build), else playwright-core's own bundled resolution.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const c of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — see the header comment.");
}

execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
  env: { ...process.env },
  stdio: "pipe",
});

const { chromium } = resolvePlaywright();
const launchOpts = { args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] };
if (process.env.PLAYWRIGHT_EXE) launchOpts.executablePath = process.env.PLAYWRIGHT_EXE;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForTimeout(3500);

const lastSent = () =>
  page.evaluate(() => (window.SENT_MESSAGES ?? []).slice(-1)[0]);

// Queue mode on, then stage two steps: removeOrphanNodes + translate(dx=1).
await page.evaluate(() => {
  document.getElementById("edit-queue-mode").checked = true;
  document.getElementById("edit-queue-mode").dispatchEvent(new Event("change", { bubbles: true }));
  document.getElementById("trans-x").value = "1";
  document.querySelector('.edit-apply[data-op="translate"]').click();
  document.getElementById("edit-remove-orphans").click();
});
let rows = await page.evaluate(() => [...document.querySelectorAll("#edit-queue-list .edit-op-label")].map((e) => e.textContent));
assert.equal(rows.length, 2, `two staged rows, got ${JSON.stringify(rows)}`);

// Reorder: move the second row up; translate must now come second.
await page.evaluate(() => {
  const list = [...document.querySelectorAll("#edit-queue-list .edit-queue-row")];
  list[1].querySelector('button[title="Move step earlier"]').click();
});
rows = await page.evaluate(() => [...document.querySelectorAll("#edit-queue-list .edit-op-label")].map((e) => e.textContent));
assert.match(rows[0], /Remove orphan/, `reorder moved the row up, got ${JSON.stringify(rows)}`);

// Edit: change the translate step's dx to 2 through the inline JSON editor.
await page.evaluate(() => {
  const list = [...document.querySelectorAll("#edit-queue-list .edit-queue-row")];
  const idx = list.findIndex((r) => r.textContent.includes("Translate"));
  const edit = list[idx].querySelector('button[title="Edit step parameters as JSON"]');
  edit.click();
  const area = document.querySelector(".edit-queue-json");
  const msg = JSON.parse(area.value);
  msg.dx = 2;
  area.value = JSON.stringify(msg);
  document.querySelector(".edit-queue-editbar .panel-btn").click();
});
rows = await page.evaluate(() => [...document.querySelectorAll("#edit-queue-list .edit-op-label")].map((e) => e.textContent));
assert.match(rows.find((r) => r.includes("Translate")), /dx: 2/, `edit applied, got ${JSON.stringify(rows)}`);

// Save posts the queue in row order with the edited value.
await page.evaluate(() => document.getElementById("edit-queue-save").click());
const saved = await lastSent();
assert.equal(saved?.type, "saveQueue");
assert.equal(saved?.ops.length, 2);
assert.equal(saved?.ops[1].op, "translate");
assert.equal(saved?.ops[1].dx, 2);

// Load asks the host; the host's queueLoaded reply appends.
await page.evaluate(() => document.getElementById("edit-queue-load").click());
assert.equal((await lastSent())?.type, "loadQueue");
await page.evaluate(() => window.postMessage({ type: "queueLoaded", ops: [{ op: "scale", sx: 1, sy: 1, sz: 1 }] }, "*"));
await page.waitForTimeout(300);
rows = await page.evaluate(() => [...document.querySelectorAll("#edit-queue-list .edit-op-label")].map((e) => e.textContent));
assert.equal(rows.length, 3, `loaded recipe appended, got ${JSON.stringify(rows)}`);

// Invalid JSON in the editor is an inline error, and the step survives.
await page.evaluate(() => {
  const list = [...document.querySelectorAll("#edit-queue-list .edit-queue-row")];
  list[0].querySelector('button[title="Edit step parameters as JSON"]').click();
  document.querySelector(".edit-queue-json").value = "nope{";
  document.querySelector(".edit-queue-editbar .panel-btn").click();
});
const errVisible = await page.evaluate(() => {
  const err = document.querySelector(".edit-queue-error");
  return err && !err.hidden && err.textContent.length > 0;
});
assert.ok(errVisible, "invalid JSON shows an inline error");
rows = await page.evaluate(() => [...document.querySelectorAll("#edit-queue-list .edit-op-label")].map((e) => e.textContent));
assert.equal(rows.length, 3, "failed edit keeps all rows");

await browser.close();
assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
console.log("check-op-queue: all assertions passed");
