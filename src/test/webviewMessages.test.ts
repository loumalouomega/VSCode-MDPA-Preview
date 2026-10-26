import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildPreviewHtml, TOOLBAR_HTML, VIEW_MENU_HTML } from "../webviewChrome";
import { catalogueFor, localizeHtml, pickCatalogue, pseudoLocalize, shippedLocales } from "../parser/i18n/messages";

const base = {
  scriptUri: "s.js", designSystemUri: "d.css", styleUri: "c.css", cspSource: "x", nonce: "n",
  title: "T", theme: "dark",
};

test("English output is byte-identical with and without an explicit en/unknown locale", () => {
  const plain = buildPreviewHtml(base);
  assert.equal(buildPreviewHtml({ ...base, locale: "en" }).replace(' lang="en"', ""), plain.replace(' lang="en"', ""));
  assert.equal(buildPreviewHtml({ ...base, locale: "xx" }).includes("Reset"), true);
});

test("a shipped catalogue only names strings that exist in the chrome, and falls back per key", () => {
  const english = buildPreviewHtml(base);
  const dir = path.join(__dirname, "..", "..", "webview");
  const runtimeSrc = [dir, path.join(dir, "plots")].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(d, f), "utf8"))).concat(fs.readFileSync(path.join(__dirname, "..", "..", "src", "monitorSave.ts"), "utf8")).join("\n");
  for (const loc of shippedLocales()) {
    for (const key of Object.keys(catalogueFor(loc)!)) {
      const inChrome = localizeHtml(english, { catalogue: { [key]: "\u0001" }, pseudo: false }).includes("\u0001");
      assert.ok(inChrome || (runtimeSrc.includes(`t(${JSON.stringify(key)}`) || runtimeSrc.includes(`tr(${JSON.stringify(key)}`)), `${loc}: "${key}" unused`);
    }
  }
  const es = buildPreviewHtml({ ...base, locale: "es-ES" });
  assert.match(es, /Restablecer/);
  assert.match(es, /Advanced/); // untranslated key stays English
});

test("machine-facing text is untouched by the pseudo-locale", () => {
  const out = buildPreviewHtml({ ...base, locale: "qps-ploc" });
  assert.match(out, /data-theme="dark" data-locale="qps-ploc"/);
  assert.match(out, /id="find-type"/);
  assert.match(out, /<option>Node<\/option>/); // value-less option is read as text
  assert.match(out, /nonce="n" id="preview-main" src="s.js"/);
  assert.notEqual(out, buildPreviewHtml(base));
});

test("pseudo-locale lengthens, brackets and spares entities and placeholders", () => {
  assert.equal(pseudoLocalize("12"), "12");
  const p = pseudoLocalize("a &lt; {n} b");
  assert.ok(p.startsWith("[") && p.endsWith("]") && p.includes("&lt;") && p.includes("{n}"));
  assert.ok(p.length > "a &lt; {n} b".length);
});

test("every visible chrome text node is bracketed under the pseudo-locale", () => {
  const out = localizeHtml(TOOLBAR_HTML + VIEW_MENU_HTML, pickCatalogue("qps-ploc"));
  const texts = [...out.replace(/<svg[\s\S]*?<\/svg>/g, "").matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)].map((m) => m[1].trim());
  assert.ok(texts.length > 5);
  for (const t of texts) assert.ok(t.startsWith("[") && t.endsWith("]"), `unlocalised: ${t}`);
});
