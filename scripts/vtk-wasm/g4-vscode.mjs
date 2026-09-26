#!/usr/bin/env node
// G4, real host (roadmap item 18, Phase 4): install a PACKAGED .vsix into an
// isolated desktop VS Code profile with `kratos.preview.renderer: vtkwasm`,
// open a mesh, and inspect the preview webview over the Chrome DevTools
// Protocol. It checks what only the real host can show: that the webview's
// CSP is the vtkwasm one (wasm-unsafe-eval, never unsafe-eval), that the
// VTK-wasm backend — not the fallback — drew the mesh from the extension's
// own resource URIs, and that the preview's console stayed clean.
//
//   ./node_modules/.bin/vsce package -o out/g4.vsix
//   NODE_PATH=<dir with playwright-core> node scripts/vtk-wasm/g4-vscode.mjs [--vsix out/g4.vsix] [--code /usr/share/code/code] [--windowed]
//
// Every VSCODE_* variable is stripped (a launch would otherwise hand off to a
// running instance), and headless Ozone is requested unless --windowed.

import { spawn, spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pixels of the mesh's default blue in a PNG, decoded here (8-bit RGB/RGBA,
 * non-interlaced — what a Chromium screenshot is) rather than in a page,
 * where the webview's CSP would refuse the image.
 */
function countMeshBlue(png) {
  let off = 8;
  let w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let n = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const r = cur[x * bpp], g = cur[x * bpp + 1], bl = cur[x * bpp + 2];
      if (bl > 150 && r < 120 && g > 90 && g < 200) n++;
    }
    cur.copy(prev);
  }
  return n;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const codeBin = opt("code", "/usr/share/code/code");
const vsix = resolve(ROOT, opt("vsix", "out/g4.vsix"));
const windowed = argv.includes("--windowed");
const PORT = 9333 + Math.floor(Math.random() * 500);

function playwright() {
  for (const c of ["playwright-core", join(process.env.NODE_PATH ?? "", "playwright-core")]) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found — npm-install it somewhere and pass NODE_PATH");
}

const work = join(ROOT, "out", "vtk-wasm", "g4-vscode");
rmSync(work, { recursive: true, force: true });
const userData = join(work, "user-data");
const extensions = join(work, "extensions");
const folder = join(work, "folder");
mkdirSync(join(userData, "User"), { recursive: true });
mkdirSync(folder, { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "kratos.preview.renderer": "vtkwasm",
    "kratos.showWhatsNew": false,
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    // Headless Ozone opens a tiny window by default; the preview's webview is
    // only created once its editor is actually visible.
    "window.newWindowDimensions": "maximized",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "chat.commandCenter.enabled": false,
    // .mdpa opens as text by default; the preview is the editor under test.
    "workbench.editorAssociations": { "*.mdpa": "kratos.mdpaPreview" },
  })
);
const mesh = join(folder, "double_arch.mdpa");
copyFileSync(join(ROOT, "example", "MDPA", "double_arch.mdpa"), mesh);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VSCODE_") && k !== "ELECTRON_RUN_AS_NODE"));

// The Electron binary would launch the app; installing goes through the CLI
// wrapper next to it.
const cliBin = join(dirname(codeBin), "bin", "code");
console.log(`installing ${vsix}`);
const inst = spawnSync(cliBin, ["--user-data-dir", userData, "--extensions-dir", extensions, "--install-extension", vsix], { env, encoding: "utf8" });
if (inst.status !== 0) throw new Error(`install failed:\n${inst.stdout}\n${inst.stderr}`);

const args = [
  "--user-data-dir", userData,
  "--extensions-dir", extensions,
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--new-window",
  `--remote-debugging-port=${PORT}`,
  ...(windowed ? [] : ["--ozone-platform=headless", "--ozone-override-screen-size=1600,1000"]),
  folder,
  mesh,
];
console.log(`launching ${codeBin} (CDP port ${PORT})`);
const child = spawn(codeBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const { chromium } = playwright();
let browser;
for (let i = 0; i < 60 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined);
}
console.log(browser ? "attached over CDP" : "CDP attach failed");
if (!browser) throw new Error(`could not attach over CDP; log tail:\n${log.slice(-2000)}`);

// A webview is an out-of-process iframe with its own DevTools target, which
// Playwright's page.frames() does not list over connectOverCDP. So targets
// are read from /json/list and evaluated in over their own WebSocket; the
// preview document is the same-origin nested iframe inside the webview host.
class Target {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method === "Runtime.consoleAPICalled") {
        this.console.push(`${m.params.type}: ${m.params.args.map((x) => x.value ?? x.description ?? "").join(" ").slice(0, 300)}`);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.console.push(`exception: ${m.params.exceptionDetails.exception?.description?.slice(0, 300)}`);
      } else if (m.method === "Log.entryAdded") {
        this.console.push(`${m.params.entry.level}: ${m.params.entry.text.slice(0, 300)}`);
      }
    };
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  }
  close() {
    this.ws.close();
  }
}

const PROBE = `(() => {
  const docs = [document];
  for (const f of document.querySelectorAll("iframe")) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
  for (const d of docs) {
    const root = d.getElementById("render-root");
    if (!root) continue;
    const app = d.getElementById("app");
    const canvas = root.querySelector("canvas");
    return {
      renderer: d.body.dataset.renderer ?? "vtkjs",
      base: d.body.dataset.vtkWasmBase ?? "",
      loaded: !!app && app.style.display !== "none",
      canvas: canvas?.id ?? null,
      canvasSize: canvas ? [canvas.width, canvas.height] : null,
      stats: d.getElementById("stats")?.innerText?.slice(0, 200) ?? "",
      message: d.getElementById("message")?.textContent ?? "",
      csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
    };
  }
  return null;
})()`;

// The file is restored as text before the extension registers its editor
// (the preview is an "option" editor), so the preview is opened the way a
// user would: the command palette's "Open MDPA Preview" on the active file.
{
  const wb = browser.contexts().flatMap((c) => c.pages())[0];
  await new Promise((r) => setTimeout(r, 8000));
  await wb.keyboard.press("F1");
  await new Promise((r) => setTimeout(r, 800));
  await wb.keyboard.type("Open MDPA Preview");
  await new Promise((r) => setTimeout(r, 1200));
  await wb.keyboard.press("Enter");
  console.log("ran: Open MDPA Preview");
}

let target;
let state;
const seen = new Set();
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !state) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
  for (const t of list.filter((x) => x.url.startsWith("vscode-webview://") && x.webSocketDebuggerUrl)) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      console.log(`webview target ${t.type} ${t.url.slice(0, 90)}`);
    }
    const tg = new Target(t.webSocketDebuggerUrl);
    try {
      await tg.open();
      const s = await tg.eval(PROBE);
      if (s?.loaded && s.stats) {
        await tg.send("Runtime.enable");
        await tg.send("Log.enable");
        target = tg;
        state = s;
        break;
      }
    } catch {
      /* not ready */
    }
    tg.close();
  }
  if (!state) await new Promise((r) => setTimeout(r, 2000));
}
if (!state) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
  console.log(`targets: ${JSON.stringify(list.map((t) => `${t.type} ${t.url.slice(0, 100)}`))}`);
  await browser.contexts().flatMap((c) => c.pages())[0]?.screenshot({ path: join(ROOT, "out", "vtk-wasm-eval", "g4-vscode-fail.png") }).catch(() => {});
  child.kill("SIGTERM");
  throw new Error(`no loaded preview webview; log tail:\n${log.slice(-3000)}`);
}
// Let the page settle, then read what is ON SCREEN from a compositor
// screenshot of the workbench: the WebGL drawing buffer is not preserved, so
// reading the canvas from outside a draw would see a cleared buffer.
await new Promise((r) => setTimeout(r, 3000));
const workbench = browser.contexts().flatMap((c) => c.pages())[0];
const shot = join(ROOT, "out", "vtk-wasm-eval", "g4-vscode.png");
const png = await workbench.screenshot({ path: shot });
const lit = countMeshBlue(png);
// Exercise the backend once more with the console attached: a render after a
// resize, then read anything the page logged.
await target.eval(`(() => { for (const f of [window, ...[...document.querySelectorAll("iframe")].map((i) => i.contentWindow)]) { try { f.dispatchEvent(new Event("resize")); } catch {} } })()`);
await new Promise((r) => setTimeout(r, 1500));
const consoleLines = target.console;
target.close();

const script = /script-src ([^;]*)/.exec(state.csp)?.[1] ?? "";
const checks = {
  rendererAttribute: state.renderer === "vtkwasm",
  baseIsWebviewResource: /^(https:\/\/file\+\.vscode-resource|vscode-webview-resource|https:\/\/[^/]*vscode-cdn)/.test(state.base) || state.base.includes("vscode-resource"),
  cspWasmOnly: script.includes("'wasm-unsafe-eval'") && !script.includes("'unsafe-eval'"),
  cspConnectScoped: /connect-src [^;]+/.test(state.csp),
  backendIsWasm: state.canvas === "vtk-wasm-canvas",
  noFallbackMessage: !/unavailable/.test(state.message),
  meshDrawn: lit > 1000,
  noCspViolationsLogged: !consoleLines.some((l) => /Content Security Policy/i.test(l)),
  noErrorsLogged: !consoleLines.some((l) => l.startsWith("error:") && /webview|VTK|wasm/i.test(l)),
};
const version = spawnSync(cliBin, ["--version"], { env, encoding: "utf8" }).stdout.split("\n")[0];
const result = { date: new Date().toISOString(), vscode: version, vsix, checks, state, lit, console: consoleLines.slice(-40), screenshot: shot };
mkdirSync(join(ROOT, "out", "vtk-wasm-eval", "results"), { recursive: true });
writeFileSync(join(ROOT, "out", "vtk-wasm-eval", "results", "g4-vscode.json"), JSON.stringify(result, null, 2));
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"}  ${k}`);
console.log(JSON.stringify({ vscode: version, canvas: state.canvas, canvasSize: state.canvasSize, lit, message: state.message, stats: state.stats.split("\n")[0] }));
await browser.close().catch(() => {});
child.kill("SIGTERM");
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
