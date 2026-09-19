// Extracts the REAL, shipped Content-Security-Policy string from
// src/webviewChrome.ts's buildPreviewHtml — the same function
// src/previewHtml.ts calls for the actual MDPA/VTK preview panels — rather
// than hand-copying the directive list into the spike (which could silently
// drift from the shipped policy the moment either changes).
//
// This is zero-touch: it calls the real function and regexes the <meta> tag
// back out of its own output. It throws loudly if that tag disappears,
// mirroring scripts/screenshots/capture-split-fields.mjs's "fail rather than
// silently test nothing" precedent — a spike run against no CSP at all is
// exactly the gap this whole exercise exists to close (see the harness,
// which has no CSP meta at all).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "out", "spike");
const require = createRequire(import.meta.url);

async function loadChrome() {
  const esbuild = require(join(ROOT, "node_modules", "esbuild"));
  mkdirSync(OUT_DIR, { recursive: true });
  const entry = join(OUT_DIR, "chrome-entry.ts");
  writeFileSync(
    entry,
    `export * from "${join(ROOT, "src", "webviewChrome").replace(/\\/g, "/")}";`
  );
  const outfile = join(OUT_DIR, "webviewChrome.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  delete require.cache[require.resolve(outfile)];
  return require(outfile);
}

/**
 * Returns the exact CSP directive string buildPreviewHtml emits today, with
 * cspSource/nonce substituted for the given values.
 */
export async function shippedCsp(cspSource, nonce) {
  const { buildPreviewHtml } = await loadChrome();
  const html = buildPreviewHtml({
    cspSource,
    nonce,
    styleUri: "x",
    designSystemUri: "x",
    scriptUri: "x",
    title: "spike",
    theme: "dark",
  });
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!m) {
    throw new Error(
      "buildPreviewHtml no longer emits a Content-Security-Policy <meta> tag " +
      "— the spike would silently test against no CSP at all, exactly the " +
      "gap this scaffold exists to close. Update realCsp.mjs before proceeding."
    );
  }
  return m[1];
}
