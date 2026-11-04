// Captures images/meshio181-derive.png: one torus surface, its convex hull and
// a surface reconstructed from the torus' vertices alone (meshio++ 18.1.0
// `convexHull` / `reconstructSurface`, the same cores as `mesh_derive`), side
// by side in the webview harness. The three meshes are built with the REAL
// compiled modules and written to a temporary .mdpa (it keeps the SubModelParts the outline shows) that HARNESS_MESH loads.
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-meshio181.mjs
//
// Output: images/meshio181-derive.png (3360×2000 = 1680×1000 @2x, dark theme).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = (p) => require(path.join(ROOT, "out", p));

function resolvePlaywright() {
  for (const c of ["playwright-core", path.join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error("playwright-core not found — install it and pass NODE_PATH (see the header comment).");
}

const rename = (m) => m;

async function buildFixture() {
  const { generateMesh } = out("parser/kernelMeshes.js");
  const { deriveMesh } = out("parser/deriveMesh.js");
  const { translateCoords } = out("parser/transformCoords.js");
  const { mergeModels } = out("parser/mergeMesh.js");
  const { writeMeshFileAsync } = out("parser/writers/meshWriter.js");

  const torus = (await generateMesh({ kind: "generate", shape: "torus", params: { majorRadius: 1, minorRadius: 0.3, nu: 40, nv: 14 } })).model;
  const hull = (await deriveMesh(torus, { kind: "convexHull" })).model;
  const cloud = { ...torus, blocks: [], fields: [], subModelParts: [] };
  const surf = (await deriveMesh(cloud, { kind: "reconstructSurface", options: { resolution: 56 } })).model;
  console.log(`torus ${torus.nodeCount} nodes; hull ${hull.nodeCount}; reconstructed ${surf.nodeCount}`);

  const width = torus.bounds.max[0] - torus.bounds.min[0];
  const place = (m, name, i) => translateCoords(rename(m, name), i * width * 1.25, 0, 0);
  let merged = mergeModels(torus, place(hull, "Hull", 1), { name: "Hull" }).model;
  merged = mergeModels(merged, place(surf, "Reconstructed", 2), { name: "Reconstructed" }).model;

  const file = path.join(os.tmpdir(), "meshio181-demo.mdpa");
  const res = await writeMeshFileAsync(merged, ".mdpa", {});
  fs.writeFileSync(file, res.data);
  return file;
}

async function main() {
  const file = await buildFixture();
  execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
    env: { ...process.env, HARNESS_MESH: file },
    stdio: "pipe",
  });
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(pathToFileURL(path.join(ROOT, "out", "screenshot-harness", "index.html")).href);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(4000);
  // Tilt for a three-quarter view, then fit.
  for (let i = 0; i < 3; i++) await page.click('button[aria-label="Rotate left"]').catch(() => {});
  await page.evaluate(() => document.getElementById("nav-fit")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(2000);
  const layers = await page.evaluate(() => [...document.querySelectorAll("#outline label, #outline .outline-label")].map((n) => n.textContent?.trim()).filter(Boolean));
  console.log("outline:", layers.join(" | "));
  if (!layers.some((l) => /Hull/.test(l)) || !layers.some((l) => /Reconstructed/.test(l))) throw new Error("the three meshes did not all reach the outline — refusing to write a misleading shot");
  const target = path.join(ROOT, "images", "meshio181-derive.png");
  await page.screenshot({ path: target });
  console.log(`Wrote ${target}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
