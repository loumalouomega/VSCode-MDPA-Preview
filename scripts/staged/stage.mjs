// Stage the shipped runtime into a fresh directory OUTSIDE the repository, the
// way an embedding host (KKSS) or the installed extension lays it out:
//   <stage>/package.json   <stage>/dist/{mcpServer.js, *Worker.js, mmg-core.wasm, meshio/}
// Outside the repo matters: Node resolves `require("x")` by walking up from the
// requiring file, so a stage inside the checkout would find its node_modules and
// every "staged" run would quietly be a development run.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { REMOVABLE } from "./stagedCheck.mjs";

/** Not needed by the mesh MCP server; the extension ships them for other features. */
const NOT_STAGED = ["dist/flowgraph", "dist/pyodide", "dist/problemtypes"];

export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export function treeBytes(root) {
  return listFiles(root).reduce((n, f) => n + statSync(join(root, f)).size, 0);
}

/**
 * @param {{repo: string, without?: string[], prefix?: string}} o
 *   `without` names entries of REMOVABLE to leave out (the negative cases).
 * @returns {{root: string, files: string[], bytes: number, remove(): void}}
 */
export function stageDistribution({ repo, without = [], prefix = "kkss-staged-" }) {
  for (const w of without) if (!(w in REMOVABLE)) throw new Error(`unknown artifact "${w}" (known: ${Object.keys(REMOVABLE).join(", ")})`);
  if (!existsSync(join(repo, "dist", "mcpServer.js"))) {
    throw new Error("dist/mcpServer.js is missing — run `npm run package` (or `npm run compile`) first");
  }
  const root = mkdtempSync(join(tmpdir(), prefix));
  const drop = (rel) => NOT_STAGED.some((n) => rel === n || rel.startsWith(n + "/")) || rel.endsWith(".map") ||
    without.some((w) => REMOVABLE[w](rel));
  cpSync(join(repo, "dist"), join(root, "dist"), {
    recursive: true,
    filter: (src) => !drop(relative(repo, src).split(sep).join("/")),
  });
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  const files = listFiles(root);
  return { root, files, bytes: treeBytes(root), remove: () => rmSync(root, { recursive: true, force: true }) };
}

// CLI: node scripts/staged/stage.mjs [--without meshio,mmg-wasm] [--print]
if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const i = process.argv.indexOf("--without");
  const s = stageDistribution({ repo, without: i > 0 ? process.argv[i + 1].split(",") : [] });
  console.log(s.root);
  console.error(`${s.files.length} files, ${(s.bytes / 1e6).toFixed(1)} MB`);
}
