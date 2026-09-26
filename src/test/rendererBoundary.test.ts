import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// The renderer boundary (roadmap item 18, webview/render/backend.ts): the
// webview reaches a rendering library ONLY through its backend. vtk.js may be
// imported under webview/render/vtkjs/ and nowhere else in the webview; the
// VTK-wasm backend's own code lives under webview/render/vtkwasm/. A stray
// import anywhere else would quietly re-couple main.ts to one backend.
const ROOT = path.resolve(__dirname, "..", "..");
const WEBVIEW = path.join(ROOT, "webview");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?["'](@kitware\/vtk(?:\.js|-wasm)[^"']*)["']/g;

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of src.matchAll(IMPORT)) found.push(m[1]);
  // require("@kitware/vtk.js/...") would dodge the import regex.
  for (const m of src.matchAll(/require\(\s*["'](@kitware\/vtk(?:\.js|-wasm)[^"']*)["']\s*\)/g)) found.push(m[1]);
  return found;
}

test("vtk.js is imported only under webview/render/vtkjs/", () => {
  const offenders: string[] = [];
  for (const file of walk(WEBVIEW)) {
    const rel = path.relative(WEBVIEW, file).split(path.sep).join("/");
    for (const spec of importsOf(file)) {
      if (spec.startsWith("@kitware/vtk.js") && !rel.startsWith("render/vtkjs/")) offenders.push(`${rel}: ${spec}`);
      if (spec.startsWith("@kitware/vtk-wasm") && !rel.startsWith("render/vtkwasm/")) offenders.push(`${rel}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the boundary actually carries the vtk.js backend (the check is not vacuous)", () => {
  const vtkjs = walk(path.join(WEBVIEW, "render", "vtkjs")).flatMap(importsOf);
  assert.ok(vtkjs.some((s) => s.startsWith("@kitware/vtk.js/")), "no vtk.js import found under render/vtkjs/");
  const main = fs.readFileSync(path.join(WEBVIEW, "main.ts"), "utf8");
  assert.ok(main.includes('from "./render/backend"'), "main.ts must reach the renderer through render/backend.ts");
});
