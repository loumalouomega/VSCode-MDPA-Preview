// Captures one documentation screenshot per "additional mesh operation"
// (Smooth, Reorder, Partition, Refine, Quadratic → Linear, Simplexify, Crop,
// Field calculator, Average field, Merge mesh) from the webview harness.
//
// One script rather than ten: every shot is the same staging with different
// parameters, so the differences live in the OPS table below — scene name,
// which sidebar subcategory/form to open, whether to colour by a field, and
// whether node ids help. The scene models themselves come from
// build-harness.mjs's buildOpScene (HARNESS_SCENE=op HARNESS_OP=<name>).
//
// One-time setup (playwright is deliberately NOT a repo dependency):
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && npx playwright-core install chromium
// Then from the repo root:
//   npm run compile && npm run build:tests
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-op.mjs           # all ops
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots/capture-op.mjs partition # just one
//
// Output: images/op-<name>.png (3360×2000 = 1680×1000 @2x, dark theme),
// matching the other feature screenshots.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `form` is the `data-op` of the operation's Apply button (the form is found
 * via .closest(".edit-form")); `button` is an id for the param-less operations
 * that are plain buttons instead of forms. `field` colours the result by a
 * produced variable — the whole point of the shot for the field-producing ops.
 * `inputs` fills the form's controls with the parameters buildOpScene actually
 * used, so the visible form matches the visible result instead of showing the
 * defaults next to a mesh produced with different numbers.
 */
const OPS = [
  {
    op: "smooth",
    sub: "smoothing",
    form: "smooth",
    pair: true,
    inputs: { "#smooth-method": "taubin", "#smooth-iterations": "20" },
  },
  {
    op: "reorder",
    sub: "smoothing",
    form: "reorder",
    nodeIds: true,
    inputs: { "#reorder-method": "rcm" },
  },
  {
    op: "partition",
    sub: "smoothing",
    form: "partition",
    field: "Elemental:PARTITION_INDEX",
    inputs: { "#partition-nparts": "4" },
  },
  {
    op: "refine",
    sub: "topology",
    form: "refine",
    pair: true,
    wireframe: true,
    inputs: { "#refine-levels": "1" },
  },
  { op: "linearize", sub: "topology", button: "mesh-mod-linearize", pair: true, nodeIds: true },
  { op: "simplexify", sub: "topology", button: "mesh-mod-simplexify", pair: true, wireframe: true },
  {
    op: "crop",
    sub: "selection",
    form: "crop",
    inputs: {
      "#crop-kind": "bbox",
      "#crop-mode": "all",
      "#crop-lo-x": "-1", "#crop-lo-y": "-1", "#crop-lo-z": "-1",
      "#crop-hi-x": "4.5", "#crop-hi-y": "8.5", "#crop-hi-z": "5",
    },
  },
  {
    op: "fieldCalc",
    sub: "fields",
    form: "fieldCalc",
    field: "Nodal:RADIAL_DISTANCE",
    inputs: {
      "#calc-location": "Nodal",
      "#calc-output": "RADIAL_DISTANCE",
      "#calc-expr": "sqrt(x^2 + y^2 + z^2)",
    },
  },
  {
    op: "averageField",
    sub: "fields",
    form: "averageField",
    field: "Elemental:RADIAL_DISTANCE",
    inputs: {
      "#avg-variable": "RADIAL_DISTANCE",
      "#avg-direction": "nodalToElemental",
      "#avg-target": "Elements",
    },
  },
  {
    op: "mergeMesh",
    sub: "selection",
    form: "mergeMesh",
    inputs: { "#merge-path": "block_3x3x2.mdpa", "#merge-name": "MergedMesh" },
  },
];

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

async function captureOne(chromium, spec) {
  // Rebuild the harness for this operation's scene (synchronous: the next
  // page.goto must see the new harness-data.js, not the previous op's).
  execFileSync("node", [path.join(ROOT, "scripts", "screenshots", "build-harness.mjs")], {
    env: { ...process.env, HARNESS_SCENE: "op", HARNESS_OP: spec.op },
    stdio: "pipe",
  });

  const page = await chromium.newPage({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // finally, not a trailing close(): stageAndShoot throws on a failed
  // validation, and a leaked page would keep the whole batch's tabs alive.
  try {
    await stageAndShoot(page, spec, errors);
  } finally {
    await page.close();
  }
}

/** Drives the harness page into the operation's staged state, then shoots it. */
async function stageAndShoot(page, spec, errors) {
  await page.goto(`file://${path.join(ROOT, "out", "screenshot-harness", "index.html")}`);
  await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
  await page.waitForTimeout(3500);

  // Sidebar: collapse Problemtype (irrelevant here), open the operation's
  // subcategory and its own form, so the shot pairs the result with the
  // controls that produced it.
  await page.evaluate((s) => {
    document
      .querySelector('.sb-section[data-section="problemtype"] .sb-section-header')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector(`.sb-subsection[data-subsection="${s.sub}"] .sb-subsection-header`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (s.form) {
      document
        .querySelector(`[data-op="${s.form}"]`)
        ?.closest(".edit-form")
        ?.querySelector(".edit-form-title")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    for (const [selector, value] of Object.entries(s.inputs ?? {})) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`missing input ${selector}`);
      el.value = value;
      // `input` drives the live validators (e.g. the field-calculator formula),
      // `change` the selects.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, spec);
  await page.waitForTimeout(300);

  if (spec.nodeIds || spec.wireframe) {
    await page.evaluate((s) => {
      for (const action of [s.nodeIds ? "nodeIds" : null, s.wireframe ? "wireframe" : null]) {
        if (!action) continue;
        document
          .querySelector(`[data-action="${action}"]`)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    }, spec);
    await page.waitForTimeout(400);
  }

  // Field-producing operations: open the Field panel on the variable the
  // operation just created and colour the mesh by it.
  if (spec.field) {
    await page.evaluate((key) => {
      document
        .querySelector('#toolbar button[data-action="field"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const sel = document.querySelector("#field-panel select.field-select");
      if (sel) {
        sel.value = key;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, spec.field);
    await page.waitForTimeout(900);
  }

  // Tilt to a three-quarter view: every scene here is a 3D grid, and the
  // default straight-on camera flattens a hex mesh into a square outline.
  // The rotate buttons auto-repeat from mousedown, so pair each with a mouseup.
  await page.evaluate(() => {
    const nav = document.getElementById("nav-controls");
    [...(nav?.querySelectorAll("button.nav-step-btn") ?? [])]
      .find((b) => b.textContent?.trim() === "45°")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (const label of ["Rotate left", "Rotate up"]) {
      const btn = nav?.querySelector(`button[aria-label="${label}"]`);
      btn?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    [...document.querySelectorAll("#nav-controls button")]
      .find((b) => b.textContent?.trim() === "Fit")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1200);

  // Read back what actually rendered, so a silent failure cannot pass as a shot.
  const state = await page.evaluate((s) => {
    const panel = document.getElementById("field-panel");
    return {
      nodes: document.querySelector("#stats")?.textContent?.match(/Nodes\s*([\d,]+)/)?.[1],
      layers: [...document.querySelectorAll("#outline .outline-label")].map((l) =>
        l.textContent?.trim()
      ),
      historyRows: [...document.querySelectorAll(".edit-op-label")].map((r) => r.textContent),
      formOpen: s.form
        ? !document.querySelector(`[data-op="${s.form}"]`)?.closest(".edit-form")?.classList.contains("collapsed")
        : null,
      fieldPanelVar:
        panel && getComputedStyle(panel).display !== "none"
          ? panel.querySelector("select.field-select")?.value
          : null,
    };
  }, spec);

  // Validate BEFORE writing anything. These PNGs are committed documentation,
  // so a run that staged the wrong thing must leave NO file rather than a
  // plausible-looking but wrong one — a stale-but-correct image from an earlier
  // run beats a fresh misleading one. Every problem is collected so one run
  // reports everything that drifted, not just the first thing.
  const problems = [];
  if (errors.length) problems.push(`page errors — ${errors.join(" | ")}`);
  if (spec.form && !state.formOpen) {
    problems.push(`the "${spec.form}" form did not open (renamed data-op or subcategory?)`);
  }
  if (spec.field && state.fieldPanelVar !== spec.field) {
    problems.push(
      `expected the Field panel on ${spec.field}, got ${JSON.stringify(state.fieldPanelVar)}`
    );
  }
  if (state.historyRows.length !== 1) {
    problems.push(`expected one history row, got ${JSON.stringify(state.historyRows)}`);
  }
  // The before/after ops depend on build-harness.mjs still staging a pair; if
  // buildOpScene stops doing that the shot silently becomes a single mesh.
  if (spec.pair && !(state.layers.includes("Before") && state.layers.includes("After"))) {
    problems.push(`expected Before/After layers, got ${JSON.stringify(state.layers)}`);
  }
  if (problems.length > 0) {
    throw new Error(`${spec.op}: ${problems.join("; ")}`);
  }

  const out = path.join(ROOT, "images", `op-${spec.op}.png`);
  await page.screenshot({ path: out });
  console.log(`${spec.op}: ${JSON.stringify(state)}\n  → ${out}`);
}

async function main() {
  const only = process.argv[2];
  const specs = only ? OPS.filter((s) => s.op === only) : OPS;
  if (specs.length === 0) {
    throw new Error(`Unknown operation "${only}". Known: ${OPS.map((s) => s.op).join(", ")}`);
  }
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    for (const spec of specs) await captureOne(browser, spec);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
