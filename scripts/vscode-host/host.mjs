// Shared helper: install the packaged .vsix into an isolated code-server and
// drive it with playwright-core (roadmap items 1, 2, 7, 17, 19).
//   NODE_PATH=<dir with playwright-core> node scripts/vscode-host/<check>.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);

export function chromePath() {
  const base = join(homedir(), ".cache", "ms-playwright");
  const d = readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().pop();
  return join(base, d, "chrome-linux64", "chrome");
}

export async function startHost({ workspace, port = 8199, vsix = join(ROOT, "out/host/ext.vsix"), settings = {} }) {
  const work = join(ROOT, "out", "host", "profile");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "data", "User"), { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("VSCODE_")) delete env[k];
  const common = ["--user-data-dir", join(work, "data"), "--extensions-dir", join(work, "ext")];
  const r = spawnSync("code-server", [...common, "--install-extension", vsix, "--force"], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error("install failed: " + r.stderr);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(work, "data", "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "security.workspace.trust.enabled": false,
    "files.autoSave": "off", "workbench.tips.enabled": false, "update.mode": "none",
    "telemetry.telemetryLevel": "off", ...settings }));
  const password = randomBytes(8).toString("hex");
  const proc = spawn("code-server", [...common, "--bind-addr", `127.0.0.1:${port}`, "--disable-workspace-trust", workspace],
    { env: { ...env, PASSWORD: password }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try { const res = await fetch(`http://127.0.0.1:${port}/healthz`); if (res.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: chromePath(),
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill("input[type=password]", password); await page.keyboard.press("Enter");
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(6000);
  return { page, browser, proc, consoleLines, log: () => log,
    async stop() { await browser.close(); proc.kill("SIGTERM"); } };
}

export async function palette(page, text) {
  await page.keyboard.press("F1");
  await page.waitForSelector(".quick-input-widget", { state: "visible" });
  await page.keyboard.type(">" + text); await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
}

export async function openFile(page, name) {
  await page.keyboard.press("Control+P");
  await page.waitForSelector(".quick-input-widget", { state: "visible" });
  await page.keyboard.type(name); await page.waitForTimeout(700);
  await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
}

/** Find the preview webview frame (nested iframe) containing selector. */
export async function webviewFrame(page, selector = "#stats", timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      try { if (await f.$(selector)) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error("webview frame not found: " + selector);
}
