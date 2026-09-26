// Throwaway probe extension for roadmap item 18 gates G0.6 + G1.5: runs
// VTK-wasm inside a REAL VS Code webview (vscode-webview:// origin, service
// worker resource loading, the actual Electron/Chromium) under each CSP
// variant, writes the results to $VTKWASM_PROBE_OUT, then quits VS Code.
//
// Not part of the shipped extension: built into out/vtk-wasm/probe-ext/ by
// build.mjs and launched by run.mjs with an isolated --user-data-dir.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function nonce() {
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

function runVariant(ctx, variant, template) {
  return new Promise((resolve) => {
    const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel("vtkwasmProbe", `probe ${variant.name}`, vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [media],
    });
    const w = panel.webview;
    const n = nonce();
    const csp = variant.csp(template, w.cspSource, n);
    const base = w.asWebviewUri(media).toString();
    const cfg = { base, glue: `${base}/${variant.glue}`, name: variant.name };
    const probeUri = w.asWebviewUri(vscode.Uri.joinPath(media, "probe.js"));
    w.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body data-cfg='${JSON.stringify(cfg)}'>
<script nonce="${n}" src="${probeUri}"></script></body></html>`;
    const timer = setTimeout(() => {
      panel.dispose();
      resolve({ csp, timeout: true });
    }, 90_000);
    w.onDidReceiveMessage((m) => {
      clearTimeout(timer);
      panel.dispose();
      resolve({ csp, ...m });
    });
  });
}

exports.activate = async function activate(ctx) {
  const out = process.env.VTKWASM_PROBE_OUT;
  if (!out) return;
  const template = JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, "csp-template.json"), "utf8"));
  const shipped = (t, src, n) => t.csp.replaceAll("__CSP_SOURCE__", src).replaceAll("__NONCE__", n);
  // V1 = the candidate minimum: + 'wasm-unsafe-eval' in script-src, + connect-src for the .wasm/.json fetches.
  const v1 = (t, src, n) => shipped(t, src, n).replace(`script-src 'nonce-${n}'`, `script-src 'nonce-${n}' 'wasm-unsafe-eval'`) + `; connect-src ${src}`;
  const variants = [
    { name: "V0-shipped", glue: "vtkWebAssembly.mjs", csp: shipped },
    { name: "V1-minimal", glue: "vtkWebAssembly.mjs", csp: v1 },
    { name: "V2-minimal+scriptSrcSource", glue: "vtkWebAssembly.mjs", csp: (t, s, n) => v1(t, s, n).replace(`'wasm-unsafe-eval'`, `'wasm-unsafe-eval' ${s}`) },
    { name: "V3-unpatched-under-V1", glue: "vtkWebAssembly.orig.mjs", csp: v1 },
    { name: "V4-unpatched+unsafe-eval", glue: "vtkWebAssembly.orig.mjs", csp: (t, s, n) => v1(t, s, n).replace(`'wasm-unsafe-eval'`, `'wasm-unsafe-eval' 'unsafe-eval'`) },
  ];
  const results = {
    date: new Date().toISOString(),
    vscode: vscode.version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    variants: {},
  };
  for (const v of variants) results.variants[v.name] = await runVariant(ctx, v, template);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  await vscode.commands.executeCommand("workbench.action.quit");
};

exports.deactivate = function deactivate() {};
