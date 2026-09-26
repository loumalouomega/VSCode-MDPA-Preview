#!/usr/bin/env node
// Launch desktop VS Code with ONLY the probe extension, in an isolated
// user-data/extensions dir, wait for it to write its results and quit.
//
//   node scripts/vtk-wasm/probe-extension/run.mjs [--code /usr/share/code/code] [--windowed]
//
// By default Chromium's headless Ozone platform is requested so no window
// appears; --windowed drops that flag (use it if headless Ozone refuses to
// start). Every VSCODE_* variable is stripped from the environment: with
// VSCODE_IPC_HOOK_CLI set, a launch silently hands off to the running
// instance instead of starting a new one.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProbe } from "./build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const ci = argv.indexOf("--code");
const codeBin = ci >= 0 ? argv[ci + 1] : "/usr/share/code/code";
const windowed = argv.includes("--windowed");

const { out: extDir } = await buildProbe();
const work = join(ROOT, "out", "vtk-wasm", "probe-run");
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "folder"), { recursive: true });
const resultFile = join(work, "result.json");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VSCODE_") && k !== "ELECTRON_RUN_AS_NODE"));
env.VTKWASM_PROBE_OUT = resultFile;

const args = [
  "--user-data-dir", join(work, "user-data"),
  "--extensions-dir", join(work, "extensions"),
  `--extensionDevelopmentPath=${extDir}`,
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--new-window",
  ...(windowed ? [] : ["--ozone-platform=headless"]),
  join(work, "folder"),
];
console.log(`launching ${codeBin} ${windowed ? "(windowed)" : "(headless ozone)"}`);
const child = spawn(codeBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const deadline = Date.now() + 6 * 60_000;
while (!existsSync(resultFile) && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 1500));
if (child.exitCode === null) child.kill("SIGTERM");
writeFileSync(join(work, "code.log"), log);
if (!existsSync(resultFile)) {
  console.error(`no result (exit ${child.exitCode}); log tail:\n${log.slice(-3000)}`);
  process.exit(1);
}
const res = JSON.parse(readFileSync(resultFile, "utf8"));
const dest = join(ROOT, "out", "vtk-wasm-eval", "results", "g1-5-vscode-webview.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(res, null, 2));
console.log(JSON.stringify({ vscode: res.vscode, electron: res.electron, chrome: res.chrome }, null, 0));
for (const [name, v] of Object.entries(res.variants)) {
  console.log(`${name.padEnd(28)} ok=${v.ok} jspi=${v.jspi?.Suspending} lit=${v.litPixels ?? "-"} error=${(v.error ?? "").slice(0, 90)} violations=${JSON.stringify((v.violations ?? []).map((x) => x.directive + ":" + (x.blocked || "").slice(0, 40)))}`);
}
console.log(`-> ${dest}`);
