import { test } from "node:test";
import assert from "node:assert";

import { buildPreviewHtml, getNonce, PreviewHtmlOptions } from "../webviewChrome";

const base: PreviewHtmlOptions = {
  scriptUri: "vscode-webview://x/media/webview.js",
  designSystemUri: "vscode-webview://x/media/design-system.css",
  styleUri: "vscode-webview://x/media/style.css",
  cspSource: "vscode-webview://x",
  nonce: "TESTNONCE0123456789",
  title: "MDPA Preview",
  theme: "auto",
};

test("the nonce appears in both the CSP and the script tag", () => {
  // They must match or the bundle is blocked and the preview is a blank page.
  const html = buildPreviewHtml(base);
  assert.ok(html.includes(`script-src 'nonce-${base.nonce}'`));
  assert.ok(html.includes(`<script nonce="${base.nonce}"`));
});

test("a fresh nonce is 32 url-safe chars and does not repeat", () => {
  const a = getNonce();
  assert.match(a, /^[A-Za-z0-9]{32}$/);
  assert.notStrictEqual(a, getNonce());
});

test("the shell carries the chrome, the script and the loading overlay", () => {
  const html = buildPreviewHtml(base);
  for (const id of ["menubar", "sidebar", "toolbar", "render-root", "loading", "app"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes(`<title>MDPA Preview</title>`));
  assert.ok(html.includes(`data-theme="auto"`));
  assert.ok(html.includes(`<div id="app" style="display:none">`));
});

test("flowgraphOrientation is absent, not defaulted, when not asked for", () => {
  // The VTK provider and the empty panel cannot host a Flowgraph pane, so the
  // attribute must not appear at all rather than carry a meaningless default.
  assert.ok(!buildPreviewHtml(base).includes("data-flowgraph-orientation"));
  assert.ok(
    buildPreviewHtml({ ...base, flowgraphOrientation: "vertical" }).includes(
      `data-flowgraph-orientation="vertical"`
    )
  );
});

test("startEmpty toggles both the attribute and the hint", () => {
  const plain = buildPreviewHtml(base);
  assert.ok(!plain.includes("data-start-empty"));
  assert.ok(!plain.includes("empty-hint"), "a file-backed preview carries no hint markup");

  const empty = buildPreviewHtml({ ...base, startEmpty: true });
  assert.ok(empty.includes(`data-start-empty="1"`));
  assert.ok(empty.includes(`id="empty-hint"`));
  // webview/main.ts binds this button by id; renaming it silently breaks the
  // only action the standalone panel has.
  assert.ok(empty.includes(`id="empty-hint-open"`));
});

test("the MDPA and VTK documents differ ONLY by title and orientation", () => {
  // The anti-drift guard that justifies hoisting getHtml out of the two
  // providers: they were byte-identical apart from these two, and must stay so.
  const mdpa = buildPreviewHtml({
    ...base,
    title: "MDPA Preview",
    flowgraphOrientation: "horizontal",
  });
  const vtk = buildPreviewHtml({ ...base, title: "VTK Preview" });
  const normalize = (s: string): string =>
    s
      .replace(/<title>[^<]*<\/title>/, "<title>T</title>")
      .replace(/ data-flowgraph-orientation="[^"]*"/, "");
  assert.strictEqual(normalize(mdpa), normalize(vtk));
});

test("the CSP is scoped to the webview source and forbids everything else", () => {
  const html = buildPreviewHtml(base);
  assert.ok(html.includes(`default-src 'none'`));
  assert.ok(html.includes(`style-src ${base.cspSource} 'unsafe-inline'`));
  // Flowgraph resolves its port after this CSP is baked, so frame-src is scoped
  // by scheme/host rather than an exact port.
  assert.ok(html.includes(`frame-src http://localhost:* http://127.0.0.1:* https:`));
  // No connect-src: webview/videoRecord.ts relies on blob.arrayBuffer() rather
  // than fetch() precisely because of this.
  assert.ok(!html.includes("connect-src"));
});
