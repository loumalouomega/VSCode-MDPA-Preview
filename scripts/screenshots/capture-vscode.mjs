// Captures the documentation screenshots that show the preview INSIDE a real
// VS Code window — tab bar, Explorer, activity bar and all.
//
// The harness scripts (capture*.mjs) render the webview on its own; these
// shots deliberately include the editor chrome around it, so they need a real
// extension host. code-server is the cheapest one that runs headless: install
// the packaged .vsix into it, open the sample workspace and drive the workbench
// with playwright-core.
//
// This script only DRIVES the window. Launching code-server, installing the
// extension and preparing the sample workspace are separate steps (below)
// because they are slow and only needed once.
//
// One-time setup:
//   # 1. code-server (any 4.x). Extract the .deb if you cannot sudo install it:
//   dpkg-deb -x code-server_*.deb /tmp/cs && /tmp/cs/usr/lib/code-server/bin/code-server --version
//   # 2. A DARK workbench — the shots are Dark Modern, like the harness.
//   `hotExit.exit: none` also stops code-server restoring the previous
//   session's tabs when the page is reloaded between shots.
//   cat > ~/.local/share/code-server/User/settings.json <<'JSON'
//   { "workbench.colorTheme": "Default Dark Modern", "workbench.startupEditor": "none",
//     "hotExit.exit": "none", "chat.commandCenter.enabled": false,
//     "editor.minimap.enabled": false }
//   JSON
//   # 3. Package the extension. vsce needs a modern Node for undici:
//   /tmp/cs/usr/lib/code-server/lib/node ./node_modules/@vscode/vsce/vsce package \
//     --no-dependencies -o /tmp/ext.vsix
//   # 4. Install it, and open a copy of example/ as the workspace:
//   /tmp/cs/usr/lib/code-server/bin/code-server --install-extension /tmp/ext.vsix --force
//   cp -r example /tmp/shot-workspace
//   # 5. playwright (deliberately NOT a repo dependency), as for the harness:
//   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
//
// Then from the repo root:
//   NODE_PATH=/tmp/pw/node_modules CS_URL=http://127.0.0.1:8199 CS_PASSWORD=<pw> \
//   node scripts/screenshots/capture-vscode.mjs                       # every shot
//   ... node scripts/screenshots/capture-vscode.mjs preview-overview field-contour
//
// Output: images/<name>.png (3360×2000 = 1680×1000 @2x), the same framing as the
// existing window screenshots.
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const URL_BASE = process.env.CS_URL ?? "http://127.0.0.1:8199";
const PASSWORD = process.env.CS_PASSWORD ?? "shotpw1234";
/** The sample workspace code-server was launched on. */
const FOLDER = process.env.CS_FOLDER ?? "/tmp/shot-workspace";
/** Chromium renders WebGL through SwiftShader, so no GPU is required. */
const CHROMIUM_ARGS = ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
/** Settle time after anything that re-renders the vtk.js scene. */
const RENDER_SETTLE = 3000;
/** MMG runs the wasm core in a worker thread; the level-set split is the slow one. */
const LONG_SETTLE = 90000;

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

/**
 * One entry per shot, in the order they are taken. `file` is relative to the
 * sample workspace; `command` is the palette TITLE (the palette filters on
 * titles, not command ids). `setup` drives the preview frame exactly as a user
 * would — click a toolbar button, open a section, fill a form — so the shot
 * shows real state rather than a pose.
 */
const SHOTS = [
  {
    // README hero: the default view, nothing open but the layers.
    name: "preview-overview",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    closeTextTab: true,
    async setup() {
      await this.threeQuarter();
    },
  },
  {
    // The File menu, which now carries Import Mesh / Reload and collapsible
    // export categories instead of one flat format list.
    name: "file-menu",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#file-menu-btn');
      await this.expect("#file-menu-popup");
    },
  },
  {
    // The Edit section with real operations applied, so the history list is
    // populated rather than showing "No operations applied."
    name: "edit-history",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.section("edit");
      await this.formOp("scale");
      await this.applyOp("scale");
      await this.formOp("translate");
      await this.applyOp("translate");
      await this.expect("#edit-history > *");
      await this.section("edit");
      await this.threeQuarter();
    },
  },
  {
    // Mesh Modification's six subcategories, with Refine opened inside one.
    name: "mesh-operations",
    file: "MDPA/double_arch.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.collapse("variables");
      await this.collapse("edit");
      await this.subsection("mesh-mod", "topology");
      await this.formOp("refine");
      await this.section("mesh-mod");
      await this.threeQuarter();
    },
  },
  {
    name: "outline-layers",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.section("layers");
      await this.threeQuarter();
    },
  },
  {
    // The full mesh hidden and one SubModelPart left, in its layer colour.
    name: "outline-isolate",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.uncheckLayer("TotalLagrangianElem");
      await this.checkLayer("CONTACT_Contact_Auto1");
      await this.threeQuarter();
    },
  },
  {
    name: "quality-panel",
    file: "MDPA/double_arch.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#toolbar button[data-action="quality"]');
      await this.expect("#quality-panel", 90000);
      await this.expect("#quality-panel canvas.quality-hist", 30000);
      const charts = await this.frame.locator("#quality-panel canvas.quality-hist").count();
      if (charts < 3) throw new Error(`quality panel rendered only ${charts} histograms`);
      // The panel floats over the left of the viewport, so back off until the
      // mesh sits clear of it instead of hiding behind the histograms.
      await this.click("#nav-zoom-out");
      await this.click("#nav-zoom-out");
      await this.settle(4000);
    },
  },
  {
    name: "field-contour",
    file: "VTK/Main_0_2.vtk",
    command: "Open VTK Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#toolbar button[data-action="field"]');
      await this.expect("#field-panel");
      // Contour is on by default; the shot is the coloured mesh beside it.
      await this.fieldMode("Contour");
      await this.click("#nav-zoom-out");
      await this.settle(2500);
    },
  },
  {
    name: "field-isosurface",
    file: "VTK/Main_0_2.vtk",
    command: "Open VTK Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#toolbar button[data-action="field"]');
      await this.expect("#field-panel");
      await this.fieldMode("Isosurface");
    },
  },
  {
    // The background grid, toggled from View ▾ (it is a checkbox there now).
    name: "grid",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#toolbar button[data-action="viewMenu"]');
      await this.click('#view-popup [data-action="grid"]');
      await this.expect('#view-popup [data-action="grid"].active', 15000);
    },
  },
  {
    // The orientation cube plus the navigation dock.
    name: "navigation",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.threeQuarter();
    },
  },
  {
    name: "find-entity",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#toolbar button[data-action="find"]');
      await this.choose("#find-type", "Element");
      await this.fill("#find-id", "1200");
      await this.click("#find-go");
      await this.expect("#find-bar.visible");
      const status = await this.frame.locator("#find-status").innerText();
      if (status.trim()) throw new Error(`find failed: ${status.trim()}`);
      await this.settle(1500);
    },
  },
  {
    // Linear → Quadratic applied, so the mid-node layer and the history row
    // are both real.
    name: "meshmod-quadratic",
    file: "MDPA/double_arch_hexa_coarse.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.subsection("mesh-mod", "topology");
      await this.click("#mesh-mod-quadratic");
      await this.expect("#edit-history > *");
      await this.section("edit");
      await this.threeQuarter();
    },
  },
  {
    // The Remesh (MMG) form with its Advanced tuning sub-form expanded. The
    // form is the subject, so nothing is run.
    name: "mmg-remesh",
    file: "MDPA/double_arch.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.subsection("mesh-mod", "remeshing");
      await this.formOp("remesh");
      await this.click("#remesh-freeze-form .edit-form-title").catch(() => {});
      await this.expect("#remesh-form");
      await this.section("mesh-mod");
      await this.threeQuarter();
    },
  },
  {
    // A real level-set split on the tet bunny: inside / outside / interface.
    name: "levelset-split",
    file: "MDPA/bunny_test_mesh.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.subsection("mesh-mod", "remeshing");
      await this.formOp("levelset");
      await this.click('[data-op="levelset"]');
      await this.settle(LONG_SETTLE);
      // MMG rewrites the outline into inside / outside / interface parts.
      await this.frame
        .locator("#outline .outline-label", { hasText: "MMG" })
        .first()
        .waitFor({ state: "visible", timeout: 30000 })
        .catch(() => {
          throw new Error("MMG parts never appeared in the outline");
        });
      await this.section("layers");
      await this.threeQuarter();
    },
  },
  {
    // Advanced ▸ Face normals on the same mesh.
    name: "face-normals",
    file: "MDPA/double_arch.mdpa",
    command: "Open MDPA Preview",
    async setup() {
      await this.threeQuarter();
      await this.click('#toolbar button[data-action="advanced"]');
      await this.click('#advanced-popup [data-action="normals"]');
      // No panel: the item draws the arrow field straight into the scene.
      await this.settle(4000);
    },
  },
  {
    // The timeline bar: Main_0_*.vtk are discovered as one time series.
    name: "timeline",
    file: "VTK/Main_0_4.vtk",
    command: "Open VTK Preview",
    async setup() {
      await this.threeQuarter();
    },
  },
  {
    name: "multiblock",
    file: "VTK-XML/multiblock/scene.vtm",
    command: "Open VTK Preview",
    async setup() {
      await this.threeQuarter();
    },
  },
  {
    name: "surface-mesh",
    file: "Geometry/hut.obj",
    command: "Open VTK Preview",
    async setup() {
      // Three-quarter already tips the camera off dead-on, which is what this
      // one needs: two flat g-groups seen edge-on are just one square.
      await this.threeQuarter();
    },
  },
];

/**
 * Everything a shot's `setup` can do to the preview frame.
 *
 * Every action dispatches DOM events inside the frame rather than using
 * playwright's real mouse: the webview sits two iframes deep inside VS Code's
 * own webview host, and a hit test from the top-level page lands on the HOST
 * iframe instead of the element, so `locator.click()` times out with
 * "iframe … intercepts pointer events". An in-frame `el.click()` runs the same
 * listeners a user's click would, and cannot miss.
 *
 * Each step also settles on its own: the outline menus and the export dropdowns
 * dismiss on a scroll event, so scrolling and clicking in one go would close
 * what the click just opened.
 */
function makeDriver(page, frame) {
  const wait = (ms) => page.waitForTimeout(ms);

  /** Resolves `selector` inside the frame, failing with a useful message. */
  const find = (selector) =>
    frame.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      el.scrollIntoView({ block: "center" });
      return true;
    }, selector);

  /** Clicks the first match, optionally only when its text contains `text`. */
  const click = (selector, text) =>
    frame.evaluate(
      ({ sel, want }) => {
        const el = [...document.querySelectorAll(sel)].find((e) =>
          want ? e.textContent.includes(want) : true
        );
        if (!el) throw new Error(`no element for ${sel}${want ? ` containing "${want}"` : ""}`);
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      },
      { sel: selector, want: text }
    );

  return {
    frame,
    /**
     * Waits for `selector` to become visible, or throws. Panels in this preview
     * open asynchronously — the Quality one round-trips to the extension host
     * and walks every element — so a shot can otherwise be written showing
     * nothing at all, which is a plausible-looking picture of the wrong thing.
     */
    async expect(selector, timeout = 30000) {
      await frame
        .locator(selector)
        .first()
        .waitFor({ state: "visible", timeout })
        .catch(() => {
          throw new Error(`${selector} never became visible`);
        });
      await wait(500);
    },
    async click(selector, text) {
      await find(selector);
      await wait(400);
      await click(selector, text);
      await wait(700);
    },
    async fill(selector, value) {
      await find(selector);
      await frame.evaluate((sel) => {
        const el = document.querySelector(sel);
        el.value = "";
        el.focus();
      }, selector);
      await wait(200);
      await frame.evaluate(
        ({ sel, val }) => {
          const el = document.querySelector(sel);
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { sel: selector, val: value }
      );
      await wait(500);
    },
    /** Picks a <select> option by its visible label, falling back to the value. */
    async choose(selector, labelOrValue) {
      await find(selector);
      const ok = await frame.evaluate(
        ({ sel, want }) => {
          const el = document.querySelector(sel);
          const byLabel = [...el.options].find((o) => o.textContent.trim() === want);
          const opt = byLabel ?? [...el.options].find((o) => o.value === want);
          if (!opt) return false;
          el.value = opt.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        { sel: selector, want: labelOrValue }
      );
      if (!ok) throw new Error(`no option "${labelOrValue}" in ${selector}`);
      await wait(600);
    },
    /** Scrolls a section into view so its body is on screen. */
    async section(name) {
      await frame.evaluate((sel) => {
        const el = document.querySelector(sel);
        el?.scrollIntoView({ block: "start" });
      }, `.sb-section[data-section="${name}"]`);
      await wait(700);
    },
    /** Collapses a section, so the ones below it get the room. */
    async collapse(name) {
      await click(
        `.sb-section[data-section="${name}"] .sb-section-header .panel-chevron`
      ).catch(() => {});
      await wait(400);
    },
    /** Opens one Mesh Modification subcategory (topology, remeshing, ...). */
    async subsection(sectionName, key) {
      const selector = `.sb-section[data-section="${sectionName}"] .sb-subsection[data-subsection="${key}"] .sb-subsection-header`;
      if (!(await frame.evaluate((sel) => !!document.querySelector(sel), selector))) {
        throw new Error(`no subsection ${key}`);
      }
      await find(selector);
      await wait(500);
      await click(selector);
      await wait(500);
    },
    /** Expands an operation form by its Apply button's data-op. */
    async formOp(op) {
      const opened = await frame.evaluate((sel) => {
        const apply = document.querySelector(sel);
        const form = apply?.closest(".edit-form");
        const title = form?.querySelector(".edit-form-title");
        if (!title) return false;
        title.scrollIntoView({ block: "center" });
        title.click();
        return true;
      }, `[data-op="${op}"]`);
      if (!opened) throw new Error(`no form for op ${op}`);
      await wait(600);
    },
    /** Clicks an operation's Apply button. */
    async applyOp(op) {
      await this.click(`[data-op="${op}"]`);
      await wait(1800);
    },
    /**
     * Field panel: the modes are independent toggle BUTTONS, and choosing a
     * variable applies immediately — there is no Apply button.
     */
    /**
     * Turns exactly one Field mode on, everything else off.
     *
     * The panel's modes are independent toggles, and Contour is ON the moment
     * it opens on a mesh with fields — so asking for "Isosurface" without
     * switching Contour off yields a contour-coloured solid with the iso
     * surface buried inside it, instead of the wireframe + green plane the
     * guide describes. (The old UI had an exclusive mode select, which is why
     * the committed shot looks the way it does.)
     */
    async fieldMode(label) {
      // #field-panel exists from page load (display:none until a toolbar
      // click), so waiting for the container proves nothing — wait for a mode
      // button, which only appears once the panel has rendered against the
      // mesh's actual fields.
      await this.expect("#field-panel .field-mode-btn");
      await frame.evaluate((want) => {
        for (const b of document.querySelectorAll("#field-panel .field-mode-btn")) {
          const on = b.textContent.includes(want);
          if (on === b.classList.contains("active")) continue;
          b.scrollIntoView({ block: "center" });
          b.click();
        }
      }, label);
      await frame
        .locator("#field-panel .field-mode-btn.active", { hasText: label })
        .first()
        .waitFor({ state: "visible", timeout: 20000 })
        .catch(() => {
          throw new Error(`${label} mode never became active`);
        });
      // Exactly one mode may be active — otherwise the shot shows a blend.
      const active = await frame.evaluate(() =>
        [...document.querySelectorAll("#field-panel .field-mode-btn.active")].map((b) =>
          b.textContent.trim()
        )
      );
      if (active.length !== 1) throw new Error(`expected one field mode, got ${JSON.stringify(active)}`);
      await this.settle();
    },
    /** Ticks / unticks an outline layer row by its visible label prefix. */
    async setLayer(label, on) {
      const changed = await frame.evaluate(
        ({ want, wanted }) => {
          const row = [...document.querySelectorAll("#outline .outline-row")].find((r) =>
            r.querySelector(".outline-label")?.textContent.includes(want)
          );
          const box = row?.querySelector('input[type="checkbox"]');
          if (!box) return "missing";
          if (box.checked === wanted) return "unchanged";
          row.scrollIntoView({ block: "center" });
          box.click();
          return "changed";
        },
        { want: label, wanted: on }
      );
      if (changed === "missing") throw new Error(`no layer row for ${label}`);
      await wait(900);
    },
    checkLayer(label) {
      return this.setLayer(label, true);
    },
    uncheckLayer(label) {
      return this.setLayer(label, false);
    },
    /**
     * Recreates the committed camera: a small front-facing tilt, not a strong
     * isometric orbit. The old shots keep FRONT as the dominant cube face while
     * exposing just enough top/side surface to read the mesh in 3D.
     *
     * One 15° step down and two to the left preserve the front-face label while
     * revealing the beam's left end and top, the slight perspective in the
     * committed overview. Larger turns make the arch read edge-on.
     */
    async threeQuarter() {
      await this.click("#nav-reset");
      await this.settle(2500);
      await this.click("#nav-more");
      await click('#nav-more-popup .nav-step-btn', "15");
      await wait(300);
      await click('#nav-more-popup button[title="Rotate down"]');
      for (let i = 0; i < 2; i++) await click('#nav-more-popup button[title="Rotate left"]');
      await wait(600);
      // Toggle the popover shut again — left open it covers the mesh.
      await this.click("#nav-more");
      await this.settle();
      await this.fit();
    },
    /** Fits the camera with the original one-step margin around the model. */
    async fit() {
      await this.click("#nav-fit");
      await this.settle();
      await this.click("#nav-zoom-out");
      await this.settle(1500);
    },
    settle: (ms = RENDER_SETTLE) => wait(ms),
  };
}

/** Hides the Chat view if code-server/Code opened it; it is not part of the preview. */
async function closeSecondarySidebar(page) {
  const visible = await page
    .locator(".part.auxiliarybar")
    .isVisible()
    .catch(() => false);
  if (!visible) return;
  await page.keyboard.press("Control+Alt+KeyB");
  await page.waitForTimeout(1800);
}

/**
 * Runs a palette command by typing its title after `>`.
 *
 * Used instead of key chords (`Ctrl+K W`): a chord left half-armed when the page
 * reloaded mid-sequence swallows the next keystroke, which then leaves the next
 * quick open typing into an editor instead of its own input box.
 */
async function runCommand(page, title) {
  await page.keyboard.press("Control+P");
  await page.waitForTimeout(800);
  await page.keyboard.type(`>${title}`, { delay: 25 });
  await page.waitForTimeout(1500);
  const selected = await page
    .locator(".quick-input-list .monaco-list-row.focused")
    .first()
    .innerText()
    .catch(() => "");
  if (!selected.replace(/\s+/g, "").includes(title.replace(/\s+/g, ""))) {
    await page.keyboard.press("Escape");
    throw new Error(`command palette selected "${selected.trim()}", not "${title}"`);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1600);
}

/**
 * Puts the workbench back to one folder, no editors, no Chat, no Welcome.
 *
 * Closing all editors matters: without it each shot inherits the previous shot's
 * tab strip, and — worse — the preview command acts on the stale active editor
 * instead of the file this shot is about. Verified by tab count, because the
 * palette command can silently no-op when focus is elsewhere.
 */
async function resetWorkbench(page) {
  await closeSecondarySidebar(page);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runCommand(page, "View: Close All Editors");
    const tabs = await page.locator(".tabs-container .tab").count().catch(() => -1);
    if (tabs === 0) return;
    console.warn(`  ${tabs} tab(s) left after close-all (attempt ${attempt})`);
    // Custom preview tabs can survive the palette command. Use the tab's own
    // close action (which is present even when its icon is not painted); fall
    // back to the keyboard shortcut if a workbench version omits that action.
    for (let i = 0; i < tabs; i++) {
      const last = page.locator(".tabs-container .tab").last();
      if (!(await last.count().catch(() => 0))) break;
      const close = last.locator('.tab-actions [aria-label^="Close"]').first();
      if (await close.count().catch(() => 0)) {
        await close.click().catch(() => {});
      } else {
        await last.click().catch(() => {});
        await page.keyboard.press("Control+W").catch(() => {});
      }
      await page.waitForTimeout(350);
    }
    const remaining = await page.locator(".tabs-container .tab").count().catch(() => -1);
    if (remaining === 0) return;
    const details = await page.locator(".tabs-container .tab").evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute("aria-label"),
        actions: [...el.querySelectorAll(".tab-actions button, .tab-actions [role=button]")].map(
          (button) => ({ label: button.getAttribute("aria-label"), title: button.getAttribute("title") })
        ),
      }))
    );
    console.warn("  remaining editor tabs:", JSON.stringify(details));
  }
  throw new Error("could not close all editors");
}

/**
 * Opens `relPath` in the text editor through quick open.
 *
 * Quick open's fuzzy rank is not reliable here: `MDPA/double_arch.mdpa` can rank
 * `double_arch_hexa_coarse.mdpa` above the exact hit, and Enter would then open
 * the wrong file without a word. So read the highlighted row and only commit when
 * it really is the file asked for.
 */
async function openFileInEditor(page, relPath) {
  const wanted = path.basename(relPath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.keyboard.press("Control+P");
    await page.waitForTimeout(900);
    await page.keyboard.type(relPath, { delay: 20 });
    await page.waitForTimeout(2200);
    // Quick open marks the row Enter will take with .focused (there is no
    // aria-selected on these rows).
    const highlighted = await page
      .locator(".quick-input-list .monaco-list-row.focused")
      .first()
      .innerText()
      .catch(() => "");
    // Whitespace-free: labels can wrap mid-name ("Main_0_2\n.vtk").
    if (highlighted.replace(/\s+/g, "").includes(wanted)) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2200);
      // The preview command acts on the ACTIVE editor, so confirm the text tab
      // really is this file — otherwise the shot silently shows the last file.
      // Tab labels wrap mid-name ("Main_0_2\n.vtk"), so compare whitespace-free.
      const active = await page
        .locator(".tabs-container .tab.active")
        .first()
        .innerText()
        .catch(() => "");
      const flat = active.replace(/\s+/g, "");
      if (flat.includes(wanted)) return;
      console.warn(`  active tab is "${flat}", not ${wanted} (attempt ${attempt})`);
      await runCommand(page, "View: Close All Editors");
      continue;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    console.warn(
      `  quick open highlighted "${highlighted.trim()}", not ${wanted} (attempt ${attempt})`
    );
  }
  throw new Error(`quick open never offered ${wanted}`);
}

/** Logs in, tidies the workbench, and hands back an `open` for each shot. */
async function openWorkbench(page) {
  await page.goto(`${URL_BASE}/?folder=${FOLDER}`, { waitUntil: "domcontentloaded" });
  const password = page.locator("input[type=password]");
  if (await password.count()) {
    await password.fill(PASSWORD);
    await password.press("Enter");
  }
  await page.waitForSelector(".monaco-workbench", { timeout: 90000 });
  await page.waitForTimeout(7000);

  // The Chat view and the Welcome tab are code-server/Code additions, not part
  // of the preview: neither belongs in a documentation shot.
  await resetWorkbench(page);

  /** Opens `file` in the provider behind `command`, and returns its driver. */
  async function open(shot) {
    const wanted = path.basename(shot.file);
    await openFileInEditor(page, shot.file);
    await runCommand(page, shot.command);

    // The webview is a nested iframe; wait for its menubar to appear.
    const deadline = Date.now() + 60000;
    let frame = null;
    while (Date.now() < deadline && !frame) {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        if (await f.evaluate(() => !!document.querySelector("#menubar")).catch(() => false)) {
          frame = f;
          break;
        }
      }
      if (!frame) await page.waitForTimeout(500);
    }
    if (!frame) throw new Error(`preview webview never appeared for ${shot.file}`);
    await page.waitForTimeout(8000); // vtk.js building the scene

    // The document chip names what the preview actually loaded — the only
    // honest check that quick open picked the file this shot is about.
    const chip = await frame.locator("#doc-chip-name").innerText().catch(() => "");
    if (chip.trim() !== wanted) {
      throw new Error(`preview opened "${chip || "(none)"}", expected "${wanted}"`);
    }

    if (shot.closeTextTab) {
      // One tab only, matching the committed hero shot. This has to happen
      // AFTER the provider opened: "Open MDPA Preview" reads the active
      // editor, so closing the text tab first leaves it with nothing to open.
      // The text tab is the first one; click it, then close it.
      await page.locator(".tabs-container .tab").first().click();
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+W");
      await page.waitForTimeout(2500);
    }

    return makeDriver(page, frame);
  }

  return { open };
}

async function main() {
  const wanted = process.argv.slice(2);
  const shots = wanted.length ? SHOTS.filter((s) => wanted.includes(s.name)) : SHOTS;
  if (!shots.length) throw new Error(`no shot matched ${wanted.join(", ")}`);

  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  const { open } = await openWorkbench(page);
  let failed = 0;

  for (const shot of shots) {
    console.log(`### ${shot.name} (${shot.file})`);
    try {
      // A fresh workbench per shot: the previous shot's panels and applied
      // operations would otherwise leak into this one.
      await page.goto(`${URL_BASE}/?folder=${FOLDER}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".monaco-workbench", { timeout: 90000 });
      await page.waitForTimeout(6000);
      await resetWorkbench(page);

      const driver = await open(shot);
      await shot.setup.call(driver);
      await driver.settle();

      const out = path.join(ROOT, "images", `${shot.name}.png`);
      // Park the pointer over the Explorer: a button left hovered paints its
      // title tooltip into the shot.
      await page.mouse.move(120, 400);
      await page.waitForTimeout(700);
      await page.screenshot({ path: out });
      console.log(`Wrote ${out}`);
    } catch (err) {
      failed++;
      console.error(`!!! ${shot.name} FAILED: ${err.message}`);
    }
  }

  await browser.close();
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
