#!/usr/bin/env node
// Assemble the licence notices that ship beside the VTK-wasm binary
// (roadmap item 18, Phase 3). Run once per re-pin; the OUTPUT is committed
// under scripts/vtk-wasm/licenses/ so packaging is offline and reproducible.
//
//   node scripts/vtk-wasm/collect-licenses.mjs
//
// Sources, each pinned by commit in scripts/vtk-wasm/manifest.json's
// `licenses` section:
//   - VTK's own Copyright.txt (BSD-3-Clause) at the commit that stamped the
//     pinned nightly (9.7.20260920 = VTK master eec5cc24, "VTK Nightly Date
//     Stamp", 2026-09-20).
//   - Every VTK ThirdParty module's licence files, found the way VTK itself
//     declares them: `LICENSE_FILES` + `SPDX_LICENSE_IDENTIFIER` +
//     `SPDX_COPYRIGHT_TEXT` in ThirdParty/<lib>/CMakeLists.txt. The pinned
//     build compiles only a SUBSET (its invoker registry has no XDMF, HDF5,
//     NetCDF, Exodus, CGNS, IOSS, PROJ, SQLite, TIFF, PNG or JPEG readers),
//     but the tarball ships no manifest of which, so every module's notice is
//     reproduced: over-inclusion cannot omit one that is present.
//   - Emscripten's own licence and the system libraries it links into every
//     binary (musl, libc++, libc++abi, compiler-rt, libunwind).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "licenses");
const MANIFEST = join(HERE, "manifest.json");

const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
const VTK = m.licenses?.vtkCommit;
const EMSDK = m.licenses?.emscriptenCommit;
if (!VTK || !EMSDK) throw new Error("manifest.licenses.{vtkCommit,emscriptenCommit} must be set");

const raw = (repo, sha, path) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Values of a CMake keyword argument, up to the next ALL_CAPS keyword. */
function field(cmake, key) {
  const i = cmake.indexOf(key);
  if (i < 0) return [];
  const out = [];
  for (const t of cmake.slice(i + key.length).matchAll(/"([^"]*)"|([^\s")]+)/g)) {
    if (t[2] !== undefined && /^[A-Z_]+$/.test(t[2])) break;
    if (t[0] === ")") break;
    out.push(t[1] ?? t[2]);
  }
  return out;
}

const listing = await (await fetch(`https://api.github.com/repos/Kitware/VTK/contents/ThirdParty?ref=${VTK}`)).json();
const libs = listing.filter((e) => e.type === "dir").map((e) => e.name).sort();

const provenance = { vtkCommit: VTK, emscriptenCommit: EMSDK, files: {} };
const sections = [];
for (const lib of libs) {
  let cmake;
  try {
    cmake = await get(raw("Kitware/VTK", VTK, `ThirdParty/${lib}/CMakeLists.txt`));
  } catch {
    continue;
  }
  const files = field(cmake, "LICENSE_FILES");
  if (!files.length) continue;
  const spdx = (cmake.match(/SPDX_LICENSE_IDENTIFIER\s+"([^"]+)"/) ?? [])[1] ?? "unspecified";
  const copyright = (cmake.match(/SPDX_COPYRIGHT_TEXT\s+"([^"]+)"/) ?? [])[1] ?? "";
  const texts = [];
  for (const f of files) {
    if (f === "public-domain") {
      texts.push("(public domain)");
      continue;
    }
    const path = `ThirdParty/${lib}/${f}`;
    const text = await get(raw("Kitware/VTK", VTK, path));
    provenance.files[`vtk:${path}`] = sha256(text);
    texts.push(`--- ${f} ---\n${text.trim()}`);
  }
  sections.push(`## ${lib} — ${spdx}\n\n${copyright ? `${copyright}\n\n` : ""}\`\`\`\n${texts.join("\n\n")}\n\`\`\``);
}

const EMS_FILES = [
  ["Emscripten (runtime and JavaScript glue)", "LICENSE"],
  ["musl libc", "system/lib/libc/musl/COPYRIGHT"],
  ["libc++", "system/lib/libcxx/LICENSE.TXT"],
  ["libc++abi", "system/lib/libcxxabi/LICENSE.TXT"],
  ["compiler-rt", "system/lib/compiler-rt/LICENSE.TXT"],
  ["libunwind", "system/lib/libunwind/LICENSE.TXT"],
];
const emsSections = [];
for (const [label, path] of EMS_FILES) {
  const text = await get(raw("emscripten-core/emscripten", EMSDK, path));
  provenance.files[`emscripten:${path}`] = sha256(text);
  emsSections.push(`## ${label}\n\n\`\`\`\n${text.trim()}\n\`\`\``);
}

const vtkCopyright = await get(raw("Kitware/VTK", VTK, "Copyright.txt"));
provenance.files["vtk:Copyright.txt"] = sha256(vtkCopyright);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "LICENSE.vtk.txt"), vtkCopyright);
writeFileSync(
  join(OUT, "THIRD_PARTY_NOTICES.md"),
  `# Third-party notices — VTK-wasm renderer runtime\n\n` +
    `\`vtkWebAssembly.wasm\` / \`vtkWebAssembly.mjs\` are VTK ${m.candidates["latest-9.7.20260920"].vtkVersion} compiled to WebAssembly by Kitware (https://github.com/Kitware/vtk-wasm, dist commit ${m.commit}). ` +
    `VTK itself is BSD-3-Clause (LICENSE.vtk.txt). The glue module is patched by this extension to remove two dynamic-code factories (src/parser/render/vtkWasmGlue.ts); the binary is unmodified.\n\n` +
    `The build compiles a subset of VTK's third-party modules. Because the published tarball carries no list of which, the notice of EVERY module VTK ${VTK.slice(0, 8)} declares is reproduced below, followed by the Emscripten runtime libraries linked into every Emscripten binary.\n\n` +
    `# VTK third-party modules\n\n${sections.join("\n\n")}\n\n# Emscripten runtime\n\n${emsSections.join("\n\n")}\n`
);
writeFileSync(join(OUT, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
console.log(`${sections.length} VTK third-party notices + ${emsSections.length} Emscripten notices -> ${OUT}`);
