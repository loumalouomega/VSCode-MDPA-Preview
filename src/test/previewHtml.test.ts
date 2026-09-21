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

test("sidebar section headers are CAD-shaped: a chevron button, an icon tile, a title", () => {
  const html = buildPreviewHtml(base);
  // The chevron is its own <button>, not a click target on the whole header —
  // webview/sidebar.ts wires it by class, so a stale page would leave every
  // section inert.
  assert.ok(html.includes(`class="panel-chevron"`));
  assert.ok(html.includes(`class="panel-icon"`));
  assert.ok(html.includes(`class="panel-title"`));
  // The old whole-header <button> is gone; `.sb-section-header` survives as the hook.
  assert.ok(!/<button[^>]*class="sb-section-header/.test(html));
  const headers = html.match(/class="sb-section-header panel-header"/g) ?? [];
  // Layers, Edit, Variables, Mesh Modification, Problemtype, Information,
  // plus the Advanced group's own header.
  assert.strictEqual(headers.length, 7);
  assert.ok(html.includes(`id="advanced-header" class="sb-section-header panel-header"`));
  for (const section of ["layers", "edit", "variables", "mesh-mod", "problemtype", "information"]) {
    assert.ok(html.includes(`data-section="${section}"`), `missing section ${section}`);
  }
});

test("Edit's undo/redo/clear live in its header as icon buttons and keep their ids", () => {
  const html = buildPreviewHtml(base);
  const header = html.slice(html.indexOf(`data-section="edit"`), html.indexOf(`<div class="sb-section-body">`, html.indexOf(`data-section="edit"`)));
  for (const id of ["edit-undo", "edit-redo", "edit-clear"]) {
    assert.match(header, new RegExp(`<button[^>]*id="${id}"[^>]*class="panel-icon-btn"[^>]*disabled`), `${id} not a disabled panel-icon-btn in the header`);
  }
});

test("the read-only Information section sits in the collapsed Advanced group", () => {
  const html = buildPreviewHtml(base);
  const group = html.indexOf(`id="advanced-group"`);
  assert.ok(group > 0, "no #advanced-group");
  // Starts collapsed, with its own chevron reflecting that.
  assert.match(html.slice(group - 60, group), /sb-group collapsed/);
  assert.ok(html.includes(`id="advanced-count"`));
  assert.ok(html.includes(`class="advanced-subhead"`));
  // #stats (renderStats' target) is inside the group, not at the top level.
  assert.ok(html.indexOf(`id="stats"`) > group);
  // The editing sections come first.
  assert.ok(html.indexOf(`data-section="layers"`) < group);
  assert.ok(html.indexOf(`data-section="problemtype"`) < group);
});

test("the sidebar resizer is a focusable separator", () => {
  const html = buildPreviewHtml(base);
  assert.match(html, /id="sidebar-resizer" role="separator" aria-orientation="vertical" tabindex="0"/);
});

test("the File trigger is CAD's pill: home glyph, label, chevron, and keeps its ids", () => {
  const html = buildPreviewHtml(base);
  for (const id of ["file-menu", "file-menu-btn", "file-menu-popup", "theme-select"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const btn = html.slice(html.indexOf(`id="file-menu-btn"`), html.indexOf(`id="file-menu-popup"`));
  assert.ok(btn.includes("ui-glyph"), "File trigger carries uiGlyphs, not the TikZ icon");
  assert.ok(btn.includes(`class="file-menu-label">File</span>`));
});

test("the menubar carries a hidden document chip with CAD's structure", () => {
  const html = buildPreviewHtml(base);
  const menubar = html.slice(html.indexOf(`id="menubar"`), html.indexOf(`id="main"`));
  // Shipped hidden: the first documentInfo unhides it, so an unrouted or
  // still-loading document shows no empty pill.
  assert.match(menubar, /<div id="doc-chip" hidden>/);
  assert.match(menubar, /id="doc-chip-dirty" class="ui-dot" role="img"[^>]*hidden/);
  assert.ok(menubar.includes(`id="doc-chip-name"`));
  assert.ok(menubar.includes(`id="doc-chip-format" class="ui-badge"`));
  assert.ok(menubar.includes(`id="doc-chip-unsaved"`));
});

test("the status bar is the LAST child of #app, after #main, with every fact cell hidden", () => {
  const html = buildPreviewHtml(base);
  const bar = html.indexOf(`id="statusbar"`);
  assert.ok(bar > html.indexOf(`id="main"`), "status bar must follow #main");
  assert.ok(bar > html.indexOf(`id="render-root"`), "status bar must follow the viewport");
  // Nothing but the script tag may follow it inside the document.
  const tail = html.slice(bar);
  assert.ok(!tail.includes(`id="viewport"`) && !tail.includes(`id="sidebar"`));
  assert.match(html, /id="engine-status" data-tone="idle"/);
  assert.ok(html.includes(`id="engine-status-dot"`) && html.includes(`id="engine-status-text"`));
  for (const id of ["sb-count-model", "sb-count-frame", "sb-cursor"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), `#${id} must ship hidden`);
  }
});

test("#toolbar is one container: every data-action button is inside it, with glyphs and a divider", () => {
  const html = buildPreviewHtml(base);
  const start = html.indexOf(`<div id="toolbar">`);
  // The popups are SIBLINGS that follow the toolbar's closing tag.
  const end = html.indexOf(`id="view-popup"`);
  assert.ok(start > -1 && end > start);
  const toolbar = html.slice(start, end);
  for (const a of ["reset", "pan", "quality", "field", "find", "inspect", "viewMenu", "advanced"]) {
    assert.ok(toolbar.includes(`<button data-action="${a}"`), `#toolbar lacks button[data-action=${a}]`);
  }
  // Every leading glyph is a uiGlyph (15px in CSS), not the TikZ menu-item set.
  assert.ok(!toolbar.includes("toolbar-icon"), "toolbar buttons use uiGlyphs, not TikZ icons");
  // The hairline sits between the plain actions and the two menu triggers.
  const div = toolbar.indexOf(`class="tb-div"`);
  assert.ok(div > toolbar.indexOf(`data-action="inspect"`) && div < toolbar.indexOf(`data-action="viewMenu"`));
  // Menu triggers: a real chevron glyph and the tb-menu hook, not the text "▾".
  for (const a of ["viewMenu", "advanced"]) {
    const btn = toolbar.slice(toolbar.indexOf(`data-action="${a}"`)).split("</button>")[0];
    assert.ok(btn.includes(`class="tb-menu"`), `${a} must carry .tb-menu`);
    assert.ok(btn.includes(`aria-haspopup="true"`) && btn.includes(`aria-expanded="false"`));
    assert.ok(btn.endsWith("</span>") || /<\/span>\s*$/.test(btn), `${a} ends with the chevron glyph`);
    assert.ok(!btn.includes("▾"));
  }
  assert.equal((toolbar.match(/data-action="/g) ?? []).length, 8, "the toolbar holds exactly the 8 buttons");
});

test("the View and Advanced popups are menus of buttons the JS dispatches by data-action", () => {
  const html = buildPreviewHtml(base);
  for (const id of ["view-popup", "advanced-popup"]) {
    assert.match(html, new RegExp(`<div id="${id}" class="hidden" role="menu">`));
  }
  const view = html.slice(html.indexOf(`id="view-popup"`), html.indexOf(`id="advanced-popup"`));
  // Checkable items keep the menu open; the ✓ column hangs off role=menuitemcheckbox.
  assert.match(view, /data-action="edges" role="menuitemcheckbox"/);
  assert.match(view, /data-action="screenshot" role="menuitem"/);
});

test("the Clip controls keep every id the cut logic wires, in dock-then-popover order", () => {
  const html = buildPreviewHtml(base);
  const start = html.indexOf(`<div id="cut-panel"`);
  const end = html.indexOf(`<div id="toolbar">`);
  assert.ok(start > -1 && end > start);
  const cut = html.slice(start, end);
  const order = ["cut-toggle", "cut-axes", "cut-slider", "cut-position", "cut-flip", "cut-free-inputs", "cut-normal-x", "cut-normal-y", "cut-normal-z"];
  let at = -1;
  for (const id of order) {
    const i = cut.indexOf(`id="${id}"`);
    assert.ok(i > at, `#${id} missing or out of order`);
    at = i;
  }
  // Four axis radios in ONE group (X / Y / Z / Free), Z preselected — the hidden-radio segment recipe.
  assert.equal((cut.match(/<input type="radio" name="cut-axis"/g) ?? []).length, 4);
  assert.match(cut, /value="2" checked/);
  assert.match(cut, /value="free"/);
  // The Free normal inputs ship hidden; the readout is a .ui-num cell.
  assert.match(cut, /id="cut-free-inputs" class="hidden"/);
  assert.match(cut, /id="cut-position" class="ui-num"/);
  // The old card's captioned wrapper rows are gone (the dock has no column groups).
  assert.ok(!cut.includes("nav-row"));
});
