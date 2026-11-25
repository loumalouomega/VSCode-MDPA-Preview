// Chromium smoke check for the shared-node conflict badges on condition cards
// (roadmap item 81).
//
// The badge is built by `webview/problemtype.ts` from a `ptPreflight` finding,
// after the cards render — a path `node:test` cannot reach. This drives the
// REAL webview bundle in the screenshot harness and checks that:
//   - both partner cards get a badge and an unrelated card does not;
//   - the badge names the other condition/part and the generated process order;
//   - clicking it selects the shared nodes through the preflight target handler;
//   - a form rebuild re-applies the badge from the last report;
//   - removing a partner and posting a new report clears both.
//
// Run (playwright is deliberately not a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/check-conflict-badges.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
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

execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], { stdio: "pipe" });

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await page.waitForSelector('#pt-assignments .pt-assign[data-condition-id="displacement"]', { timeout: 30000 });
await page.waitForTimeout(1000);

/** Delivers a host message to the webview exactly as the VS Code bridge would. */
const deliver = (data) =>
  page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);

/** Opens the card's group/panel if the harness left one collapsed (idempotent). */
async function reveal(conditionId, smpPath) {
  await page.evaluate(
    ([c, p]) => {
      const card = [...document.querySelectorAll(".pt-assign[data-condition-id]")].find(
        (x) => x.dataset.conditionId === c && x.dataset.smpPath === p
      );
      if (!card) throw new Error(`no card ${c} / ${p}`);
      const group = card.closest(".pt-group");
      if (group?.classList.contains("collapsed")) group.querySelector(".pt-group-header")?.click();
      const form = card.closest(".edit-form.pt-card");
      if (form?.classList.contains("collapsed")) form.querySelector(".edit-form-title")?.click();
    },
    [conditionId, smpPath]
  );
}

/** Badge text and title of one card. */
const badgesOf = (conditionId, smpPath) =>
  page.evaluate(
    ([c, p]) => {
      const card = [...document.querySelectorAll(".pt-assign[data-condition-id]")].find(
        (x) => x.dataset.conditionId === c && x.dataset.smpPath === p
      );
      if (!card) return undefined;
      return [...card.querySelectorAll(".pt-conflict-badge")].map((b) => ({
        text: b.getAttribute("aria-label"),
        title: b.getAttribute("title"),
      }));
    },
    [conditionId, smpPath]
  );

const displacement = ["displacement", "DISPLACEMENT_Displacement_Auto1"];
const selfWeight = ["selfWeight", "Parts_Parts_Auto1"];
const pressure = ["surfacePressure", "CONTACT_Contact_Auto1"];

// The harness default structural case already has one card per condition. The
// finding is synthetic: the host side is pinned by nodeConflicts.test.ts.
const conflict = {
  severity: "warning",
  code: "condition-shared-nodes",
  message:
    '"Displacement" on "DISPLACEMENT_Displacement_Auto1" and "Self weight" on "Parts_Parts_Auto1" both fix DISPLACEMENT on 12 shared node(s) with different values (0 vs 1) — "Self weight" on "Parts_Parts_Auto1" is applied later and wins.',
  target: {
    smpPath: displacement[1],
    conditionId: displacement[0],
    relatedConditionId: selfWeight[0],
    relatedSmpPath: selfWeight[1],
    sharedNodeCount: 12,
    appliedOrder: 1,
    relatedAppliedOrder: 4,
    valuesDiffer: true,
    entityIds: [1, 2, 3],
    nodeIds: [1, 2, 3],
  },
};

await deliver({ type: "ptPreflight", active: true, counts: { error: 0, warning: 1, info: 0 }, findings: [conflict] });
await page.waitForTimeout(100);

await reveal(...displacement);
await reveal(...selfWeight);
assert.equal((await badgesOf(...displacement))?.length, 1, "the earlier card has one badge");
assert.equal((await badgesOf(...selfWeight))?.length, 1, "the later card has one badge");
assert.equal((await badgesOf(...pressure))?.length ?? 0, 0, "an unrelated card has no badge");

const earlier = (await badgesOf(...displacement))[0];
const later = (await badgesOf(...selfWeight))[0];
assert.match(earlier.text, /Shares 12 nodes with Self weight on Parts_Parts_Auto1/);
assert.match(earlier.text, /process 1, overwritten by process 4/);
assert.match(later.text, /Shares 12 nodes with Displacement on DISPLACEMENT_Displacement_Auto1/);
assert.match(later.text, /process 4, wins over process 1/);
assert.match(earlier.title, /applied later and wins/);

// Keep a visual record of the two partner badges before the clearing steps.
await page.locator("#pt-assignments").screenshot({
  path: path.join(ROOT, "out", "screenshot-harness", "conflict-badges.png"),
});

// Clicking the badge pushes the shared node ids through the existing handler.
await page.locator(".pt-assign[data-condition-id=\"displacement\"] .pt-conflict-badge").click();
await page.waitForTimeout(400);
const selection = await page.evaluate(() => ({
  visible: getComputedStyle(document.getElementById("selection-panel")).display !== "none",
  text: document.getElementById("selection-panel")?.innerText ?? "",
}));
assert.equal(selection.visible, true, "the Selection panel opens");
assert.match(selection.text, /Preflight/, "the shared nodes land in a set named Preflight");

// A form rebuild must re-use the last report instead of losing the badge.
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".pt-assign[data-condition-id]")].find(
    (x) => x.dataset.conditionId === "surfacePressure"
  );
  card?.querySelector(".pt-assign-del")?.click();
});
await page.waitForTimeout(200);
assert.equal((await badgesOf(...displacement))?.length, 1, "a rebuild keeps the earlier badge");
assert.equal((await badgesOf(...selfWeight))?.length, 1, "a rebuild keeps the later badge");
assert.equal(await badgesOf(...pressure), undefined, "the removed third card is gone");

// Removing one partner leaves the other card's stale badge until the next
// report; the report then clears it. This is the acceptance rule for item 81.
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".pt-assign[data-condition-id]")].find(
    (x) => x.dataset.conditionId === "selfWeight"
  );
  card?.querySelector(".pt-assign-del")?.click();
});
await page.waitForTimeout(200);
assert.equal(await badgesOf(...selfWeight), undefined, "the removed partner is gone");
await deliver({ type: "ptPreflight", active: true, counts: { error: 0, warning: 0, info: 0 }, findings: [] });
await page.waitForTimeout(100);
assert.equal((await badgesOf(...displacement))?.length, 0, "a new empty report clears the partner badge");

await browser.close();
assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
console.log("check-conflict-badges: ok");
