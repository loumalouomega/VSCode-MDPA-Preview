// Pure helpers behind scripts/staged/check-staged-mcp.mjs (roadmap item 7, the
// KKSS "embedded artifact matrix" increment). Nothing here touches the disk or
// spawns a process, so src/test/stagedArtifacts.test.ts can pin the rules.
import { builtinModules } from "node:module";

/**
 * Files a staged distribution must carry, relative to the stage root (which
 * holds `dist/` and `package.json`, the layout of the installed extension).
 * The server reads `<dist>/../package.json` for its version, the workers and
 * the MMG wasm sit beside the bundle, and the kernel tree keeps its
 * `src/` <- `dist/` relative layout under `dist/meshio/`.
 */
export const REQUIRED_ARTIFACTS = [
  "package.json",
  "dist/mcpServer.js",
  "dist/mmgWorker.js",
  "dist/oracleOpWorker.js",
  "dist/derivedWorker.js",
  "dist/meshioReadWorker.js",
  "dist/meshioWriteWorker.js",
  "dist/mmg-core.wasm",
  "dist/meshio/package.json",
  "dist/meshio/src/index.mjs",
  "dist/meshio/dist/meshioplusplus_wasm.mjs",
  "dist/meshio/dist/meshioplusplus_wasm.wasm",
  "dist/meshio/dist/meshioplusplus_wasm_mt.mjs",
  "dist/meshio/dist/meshioplusplus_wasm_mt.wasm",
];

/** The subset of REQUIRED_ARTIFACTS a case can remove, by a short name. */
export const REMOVABLE = {
  meshio: (p) => p.startsWith("dist/meshio/"),
  "mmg-wasm": (p) => p === "dist/mmg-core.wasm",
  "mmg-worker": (p) => p === "dist/mmgWorker.js",
  "oracle-worker": (p) => p === "dist/oracleOpWorker.js",
  "derived-worker": (p) => p === "dist/derivedWorker.js",
  "read-worker": (p) => p === "dist/meshioReadWorker.js",
  "write-worker": (p) => p === "dist/meshioWriteWorker.js",
};

/** Required artifacts absent from a staged file list (posix, stage-relative). */
export function missingArtifacts(files, required = REQUIRED_ARTIFACTS) {
  const have = new Set(files.map((f) => f.replace(/\\/g, "/")));
  return required.filter((r) => !have.has(r));
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** `lodash/fp` -> `lodash`, `@scope/pkg/sub` -> `@scope/pkg`. */
function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Bare (package) `require("x")` specifiers left in a bundle. Node builtins and
 * relative paths are not packages. The result is the PACKAGE name, deduplicated
 * and sorted; whether each is acceptable is `unexpectedRequires`' job.
 */
export function bareRequires(bundleText) {
  const found = new Set();
  const re = /\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(bundleText))) {
    const spec = m[2];
    if (spec.startsWith(".") || spec.startsWith("/") || BUILTINS.has(spec)) continue;
    found.add(packageOf(spec));
  }
  return [...found].sort();
}

/**
 * Packages a staged bundle may still name, each with the reason it is not a
 * dependency on the checkout. `pyodide` is loaded lazily and only for `.py`
 * problemtypes (the loader locates its own siblings, so it is never bundled).
 * `ajv`/`ajv-formats` only appear inside code-GENERATION strings of the bundled
 * JSON-schema validator; the run itself proves nothing resolves them.
 */
export const ALLOWED_BARE_REQUIRES = {
  pyodide: "lazy; only loaded for .py problemtypes (dist/pyodide in the extension)",
  ajv: "string inside the bundled validator's code generator",
  "ajv-formats": "string inside the bundled validator's code generator",
};

export function unexpectedRequires(bundleText, allowed = ALLOWED_BARE_REQUIRES) {
  return bareRequires(bundleText).filter((p) => !(p in allowed));
}

/** Absolute paths (from a resolution log) that point into `root`. */
export function pathsUnder(root, paths) {
  const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return paths.filter((p) => p.replace(/\\/g, "/").startsWith(prefix));
}

/**
 * Newline-delimited JSON-RPC framing, the MCP stdio transport. `push(chunk)`
 * returns the complete messages the chunk finished; a partial line waits for
 * the next chunk. A line that is not JSON is reported, not thrown, because a
 * stray write to stdout is exactly the defect the staged run exists to catch.
 */
export function createFramer() {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const messages = [];
      const malformed = [];
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line)); } catch { malformed.push(line); }
      }
      return { messages, malformed };
    },
    pendingBytes: () => pending.length,
  };
}

/**
 * Compare two JSON-like values with a numeric tolerance. Returns the list of
 * differences as `path: reason`, empty when they agree. Numbers match within
 * `abs + rel*|b|`; keys listed in `ignore` (by leaf name) are skipped, which is
 * how a run id or an elapsed time stays out of an agreement check.
 */
export function diffInvariants(a, b, { abs = 1e-9, rel = 1e-9, ignore = [] } = {}) {
  const out = [];
  const skip = new Set(ignore);
  const walk = (x, y, path) => {
    if (typeof x === "number" && typeof y === "number") {
      if (Number.isNaN(x) && Number.isNaN(y)) return;
      if (!(Math.abs(x - y) <= abs + rel * Math.abs(y))) out.push(`${path}: ${x} != ${y}`);
      return;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) return out.push(`${path}: array vs non-array`);
      if (x.length !== y.length) return out.push(`${path}: length ${x.length} != ${y.length}`);
      x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`));
      return;
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) {
        if (skip.has(k)) continue;
        if (!(k in x)) out.push(`${path}.${k}: missing on the left`);
        else if (!(k in y)) out.push(`${path}.${k}: missing on the right`);
        else walk(x[k], y[k], `${path}.${k}`);
      }
      return;
    }
    if (x !== y) out.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
  };
  walk(a, b, "$");
  return out;
}

/** PASS / FAIL / UNVERIFIED: a skipped runtime must never read as a pass. */
export function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    pass: count("PASS"), fail: count("FAIL"), unverified: count("UNVERIFIED"),
    ok: count("FAIL") === 0,
    // A run in which nothing was actually verified is not a success either.
    verified: count("PASS") > 0,
  };
}
