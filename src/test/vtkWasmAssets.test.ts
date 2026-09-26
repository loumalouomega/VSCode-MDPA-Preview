import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Packaging invariants for the VTK-wasm renderer runtime (roadmap item 18,
// Phase 3). The binary is not in git (it is fetched by pinned commit and
// hash-gated by scripts/vtk-wasm/prepare-assets.mjs), so what is pinned here is
// everything that decides whether a .vsix can carry it correctly.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const manifest = JSON.parse(read("scripts/vtk-wasm/manifest.json"));

test("the manifest pins the selected build by commit, file by file, with its patched glue and licence sources", () => {
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  const sel = manifest.candidates[manifest.selected];
  assert.ok(sel, `selected candidate ${manifest.selected} exists`);
  assert.match(sel.sha256, /^[0-9a-f]{64}$/);
  for (const f of ["vtkWebAssembly.mjs", "vtkWebAssembly.wasm"]) {
    assert.match(sel.files[f]?.sha256 ?? "", /^[0-9a-f]{64}$/, `${f} pinned`);
  }
  const glue = sel.glue?.vtkWebAssembly;
  assert.ok(glue, "patched glue recorded");
  assert.equal(glue.inputSha256, sel.files["vtkWebAssembly.mjs"].sha256);
  assert.match(glue.outputSha256, /^[0-9a-f]{64}$/);
  assert.ok(glue.patches.includes("emval-create-invoker@1"));
  assert.match(manifest.licenses.vtkCommit, /^[0-9a-f]{40}$/);
  assert.match(manifest.licenses.emscriptenCommit, /^[0-9a-f]{40}$/);
});

test("licence notices are committed with provenance for every file they reproduce", () => {
  const notices = read("scripts/vtk-wasm/licenses/THIRD_PARTY_NOTICES.md");
  assert.ok(read("scripts/vtk-wasm/licenses/LICENSE.vtk.txt").includes("Visualization Toolkit"));
  for (const lib of ["freetype", "zlib", "expat", "lz4", "fmt", "nlohmannjson", "Emscripten", "musl libc", "libc++"]) {
    assert.ok(notices.includes(`## ${lib}`), `notice for ${lib}`);
  }
  const prov = JSON.parse(read("scripts/vtk-wasm/licenses/provenance.json"));
  assert.equal(prov.vtkCommit, manifest.licenses.vtkCommit);
  assert.ok(Object.keys(prov.files).length > 40);
});

test(".vscodeignore ships media/vtk-wasm/ (media/** is included; nothing re-excludes the runtime)", () => {
  const lines = read(".vscodeignore")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const l of lines) {
    assert.ok(!/^media(\/|\*\*)/.test(l) || l.startsWith("!"), `.vscodeignore must not exclude media/: ${l}`);
    assert.ok(!/vtk-wasm|\*\.wasm|\*\.mjs/.test(l), `.vscodeignore must not exclude the VTK-wasm runtime: ${l}`);
  }
});

test("the build wires the prepare step", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["vtkwasm:prepare"], "node scripts/vtk-wasm/prepare-assets.mjs");
  const esb = read("esbuild.js");
  assert.ok(esb.includes("copyVtkWasmPlugin") && esb.includes("plugins: [copyStylePlugin, copyVtkWasmPlugin]"));
  assert.ok(read(".github/workflows/package.yml").includes("verify-vsix.mjs"));
});
