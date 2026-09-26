#!/usr/bin/env node
// Compare two render-parity captures (out/render-parity/<A>/ vs <B>/), scene
// by scene: pixel statistics computed in a blank Chromium page (no image
// library dependency), plus a sidecar diff. Exits non-zero when any scene
// exceeds the budget.
//
//   NODE_PATH=<playwright-core dir> node scripts/render-parity/compare.mjs vtkjs-pre step-s1 \
//     [--max-channel 0] [--max-fraction 0] [--threshold 24] [--diff-images]
//
// Defaults demand an exact match (Phase 2: the vtk.js backend must be
// pixel-identical). Phase 5 passes the VTK-wasm tolerances explicitly.
// --diff-images writes <scene>.diff.png (differing pixels in magenta over a
// dimmed copy of A) into out/render-parity/<B>/.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

function resolvePlaywright() {
  for (const c of ["playwright-core", join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — pass NODE_PATH");
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

export async function comparePngs(page, a, b, { threshold = 24, diffImage = false } = {}) {
  return page.evaluate(
    async ({ a, b, threshold, diffImage }) => {
      const load = (b64) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
      }
      const w = ia.width,
        h = ia.height;
      const px = (img) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const da = px(ia),
        db = px(ib);
      let differing = 0,
        overThreshold = 0,
        maxChannel = 0,
        sumAbs = 0;
      const mask = diffImage ? new Uint8ClampedArray(da.length) : null;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d > 0) differing++;
        if (d > threshold) overThreshold++;
        if (d > maxChannel) maxChannel = d;
        sumAbs += d;
        if (mask) {
          if (d > 0) mask.set([255, 0, 255, 255], i);
          else mask.set([da[i] * 0.35, da[i + 1] * 0.35, da[i + 2] * 0.35, 255], i);
        }
      }
      let diffPng;
      if (mask) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").putImageData(new ImageData(mask, w, h), 0, 0);
        diffPng = c.toDataURL("image/png").split(",")[1];
      }
      const n = w * h;
      return { w, h, differing, overThreshold, fractionOver: overThreshold / n, maxChannel, meanAbs: sumAbs / n, diffPng };
    },
    { a: a.toString("base64"), b: b.toString("base64"), threshold, diffImage }
  );
}

async function main() {
  const argv = process.argv.slice(2).filter((x, i, all) => !x.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
  const flags = process.argv.slice(2);
  const [la, lb] = argv;
  if (!la || !lb) throw new Error("usage: compare.mjs <labelA> <labelB> [--max-channel n] [--max-fraction f] [--threshold t] [--diff-images]");
  const maxChannel = Number(arg(flags, "max-channel", "0"));
  const maxFraction = Number(arg(flags, "max-fraction", "0"));
  const threshold = Number(arg(flags, "threshold", "24"));
  const diffImages = flags.includes("--diff-images");
  const da = join(ROOT, "out", "render-parity", la);
  const db = join(ROOT, "out", "render-parity", lb);
  const scenes = readdirSync(da).filter((f) => f.endsWith(".png") && !f.endsWith(".diff.png")).map((f) => f.slice(0, -4)).sort();
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  let failures = 0;
  const report = {};
  for (const s of scenes) {
    const pb = join(db, `${s}.png`);
    if (!existsSync(pb)) {
      console.log(`${s.padEnd(24)} MISSING in ${lb}`);
      failures++;
      continue;
    }
    const r = await comparePngs(page, readFileSync(join(da, `${s}.png`)), readFileSync(pb), { threshold, diffImage: diffImages });
    const sa = JSON.parse(readFileSync(join(da, `${s}.json`), "utf8"));
    const sb = JSON.parse(readFileSync(join(db, `${s}.json`), "utf8"));
    const sidecarEqual = JSON.stringify({ ...sa, consoleErrors: undefined }) === JSON.stringify({ ...sb, consoleErrors: undefined });
    const ok = !r.sizeMismatch && r.maxChannel <= maxChannel && r.fractionOver <= maxFraction && (maxChannel > 0 || sidecarEqual);
    if (!ok) failures++;
    if (r.diffPng && r.differing > 0) writeFileSync(join(db, `${s}.diff.png`), Buffer.from(r.diffPng, "base64"));
    delete r.diffPng;
    report[s] = { ...r, sidecarEqual, ok };
    console.log(
      `${s.padEnd(24)} ${ok ? "OK  " : "FAIL"} ${r.sizeMismatch ? `size ${r.sizeMismatch}` : `diff=${r.differing} maxCh=${r.maxChannel} over=${(r.fractionOver * 100).toFixed(3)}%`}${sidecarEqual ? "" : " sidecar-differs"}`
    );
  }
  await browser.close();
  writeFileSync(join(db, `compare-vs-${la}.json`), JSON.stringify({ a: la, b: lb, maxChannel, maxFraction, threshold, report }, null, 2));
  console.log(`${scenes.length - failures}/${scenes.length} within budget`);
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
