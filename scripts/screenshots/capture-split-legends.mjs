// Verifies per-pane legend burn-in through a REAL production path: a 2-frame
// PNG-sequence recording in a 1x2 split, analyzed from the `recordFrame`
// bytes the webview posts to the (stubbed) host. The recording's
// `decorateCapture` shares `splitLegendPlacements` with the screenshot path,
// so this exercises the new per-pane specs and `drawLegendInRect` end to end.
//
// Why recordings and not View ▾ → Screenshot…: that route awaits
// `captureNextImage()`, which never resolves under software GL (SwiftShader),
// while the recorder's synchronous render→copy is deterministic there — the
// same reason the record-panel harness does real WebM. The screenshot path
// itself is a thin decode/draw/encode wrapper over the identical placements.
//
// It FAILS rather than passing vacuously: a baseline recording with no field
// overlays is taken first, so lit-mesh pixels cannot impersonate legend text —
// only pixels the legends added count. The two panes also use different
// colormaps (Rainbow vs Viridis), so equal legend boxes would fail the
// color-distance check even if both halves gained white pixels.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   HARNESS_SCENE=panefields node scripts/screenshots/build-harness.mjs
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-split-legends.mjs
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolvePlaywright() {
  for (const candidate of [
    "playwright-core",
    path.join(process.env.NODE_PATH ?? "", "playwright-core"),
  ]) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error(
    "playwright-core not found — install it and pass NODE_PATH (see the header comment)."
  );
}

async function main() {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    for (const name of ["edit", "mesh-mod", "problemtype"]) {
      document
        .querySelector(`.sb-section[data-section="${name}"] .sb-section-header`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });

  // The floating field panel overlaps the toolbar's View ▾ button once it is
  // open, so Playwright's hit-tested clicks cannot reach it afterwards —
  // dispatch plain clicks instead (the toggle/pick handlers are ordinary
  // click listeners).
  const menuClick = async (action) => {
    await page.evaluate(() => {
      document.querySelector('#toolbar button[data-action="viewMenu"]').click();
    });
    await page.waitForTimeout(200);
    await page.evaluate((a) => {
      document.querySelector(`#view-popup [data-action="${a}"]`).click();
    }, action);
    await page.waitForTimeout(300);
  };

  await menuClick("layout:1x2");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  const canvas = await page.$eval("#render-root canvas", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const focusPane = async (fx) => {
    await page.mouse.move(canvas.x + canvas.width * fx, canvas.y + canvas.height * 0.5);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const pickVariable = async (variable) => {
    const value = await page.$eval(
      "#field-panel select",
      (sel, name) =>
        [...sel.options].find((o) => o.textContent.startsWith(`${name} (`))?.value ?? "",
      variable
    );
    if (!value) throw new Error(`no ${variable} option in the field panel`);
    await page.selectOption("#field-panel select", value);
    await page.waitForTimeout(600);
  };
  const pickColormap = async (name) => {
    const ok = await page.$eval(
      "#field-panel",
      (panel, cm) => {
        const sel = [...panel.querySelectorAll("select")].find((s) =>
          [...s.options].some((o) => o.value === cm)
        );
        if (!sel) return false;
        sel.value = cm;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      name
    );
    if (!ok) throw new Error(`no ${name} colormap option in the field panel`);
    await page.waitForTimeout(600);
  };
  const ensureScalarBarOff = async () => {
    const off = await page.$eval("#field-panel", (panel) => {
      const label = [...panel.querySelectorAll("label")].find((l) =>
        l.textContent.includes("Show scalar bar in scene")
      );
      const ck = label?.querySelector("input[type=checkbox]");
      if (ck && ck.checked) ck.click();
      return !ck || !ck.checked;
    });
    if (!off) throw new Error("could not switch the in-scene scalar bar off");
    await page.waitForTimeout(300);
  };
  const clickPanelButton = async (text) => {
    const ok = await page.$eval(
      "#record-panel",
      (panel, label) => {
        const btn = [...panel.querySelectorAll("button")].find((b) =>
          b.textContent.includes(label)
        );
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      },
      text
    );
    if (!ok) throw new Error(`record panel has no enabled "${text}" button`);
    await page.waitForTimeout(300);
  };
  // A 2-frame PNG turntable recording; returns the first frame's PNG bytes.
  const recordOne = async () => {
    await page.evaluate(() => {
      window.SENT_MESSAGES = [];
    });
    await menuClick("record");
    await page.waitForTimeout(400);
    await clickPanelButton("Turntable");
    await clickPanelButton("PNG frames");
    await page.$eval("#record-panel", (panel) => {
      const row = [...panel.querySelectorAll(".field-row")].find((r) =>
        r.textContent.includes("Frames")
      );
      const input = row?.querySelector("input");
      if (!input) return;
      input.value = "2";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    await clickPanelButton("Record");
    await page.waitForFunction(
      () => (window.SENT_MESSAGES ?? []).some((m) => m.type === "recordFramesDone"),
      { timeout: 120000 }
    );
    return page.evaluate(
      () => window.SENT_MESSAGES.filter((m) => m.type === "recordFrame").map((m) => m.data)[0]
    );
  };
  // Counts near-white pixels (legend titles + tick labels) and the mean bar
  // color inside each pane half's legend box, using the production geometry.
  const analyze = async (dataUrl) =>
    page.evaluate((data) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = src;
        });
      return load(data).then((img) => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const W = c.width;
        const H = c.height;
        const paneW = W / 2;
        const barW = Math.max(16, Math.round(paneW * 0.014));
        const barH = Math.min(H * 0.4, 260);
        const margin = Math.round(paneW * 0.02) + 8;
        const halves = [];
        for (const hx1 of [paneW, W]) {
          const x0 = Math.max(0, Math.floor(hx1 - margin - barW - 130));
          const x1 = Math.min(W, Math.ceil(hx1 - margin + 2));
          const y0 = Math.max(0, Math.floor(H - margin - barH - 48));
          const y1 = Math.min(H, Math.ceil(H - margin + 2));
          const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          let white = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] >= 200 && d[i + 1] >= 200 && d[i + 2] >= 200) white++;
          }
          const bx0 = Math.floor(hx1 - margin - barW);
          const bx1 = Math.ceil(hx1 - margin);
          const by0 = Math.floor(H - margin - barH);
          const by1 = Math.ceil(H - margin);
          const b = ctx.getImageData(bx0, by0, bx1 - bx0, by1 - by0).data;
          let r = 0;
          let g = 0;
          let bl = 0;
          const n = b.length / 4;
          for (let i = 0; i < b.length; i += 4) {
            r += b[i];
            g += b[i + 1];
            bl += b[i + 2];
          }
          halves.push({ white, mean: [r / n, g / n, bl / n] });
        }
        return { W, H, halves };
      });
    }, dataUrl);

  // Baseline first: no field overlays, so no legend may be burned in.
  const base = await analyze(await recordOne());
  console.log("baseline:", JSON.stringify(base.halves));

  await page.click('#toolbar button[data-action="field"]');
  await page.waitForTimeout(400);
  await focusPane(0.25);
  await pickVariable("TEMPERATURE");
  await ensureScalarBarOff();
  await focusPane(0.75);
  await pickVariable("PRESSURE");
  await pickColormap("Viridis");
  await ensureScalarBarOff();
  // End on a canvas press so nothing panel-side is left mid-edit; the latch
  // this leaves behind is irrelevant to the capture, which reads pane state.
  await focusPane(0.75);

  const shot = await analyze(await recordOne());
  console.log("legends:", JSON.stringify(shot.halves));

  const gained = shot.halves.map((h, i) => h.white - base.halves[i].white);
  console.log("white pixels gained per half:", gained);
  if (gained[0] < 100) {
    throw new Error(
      `left pane gained ${gained[0]} legend pixels — the TEMPERATURE legend is missing`
    );
  }
  if (gained[1] < 100) {
    throw new Error(
      `right pane gained ${gained[1]} legend pixels — the PRESSURE legend is missing`
    );
  }
  const [l, r] = shot.halves;
  const dist = Math.hypot(l.mean[0] - r.mean[0], l.mean[1] - r.mean[1], l.mean[2] - r.mean[2]);
  console.log("mean bar-color distance:", dist.toFixed(1));
  if (dist < 25) {
    throw new Error(
      `legend bars are indistinguishable (${dist.toFixed(1)}) — both panes may share one spec`
    );
  }
  console.log("OK: each split pane burned in its own field legend");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
