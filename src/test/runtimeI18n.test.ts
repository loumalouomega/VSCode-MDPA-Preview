import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setRuntimeLocale, t } from "../parser/i18n/runtime";
import { catalogueFor, shippedLocales } from "../parser/i18n/messages";
import { buildPreviewHtml } from "../webviewChrome";

test("English and unknown locales are the identity, placeholders still fill", () => {
  for (const l of [undefined, "en", "xx"]) {
    setRuntimeLocale(l);
    assert.equal(t("Close"), "Close");
    assert.equal(t("Plot {v} over time", { v: "T" }), "Plot T over time");
    assert.equal(t("Keep {missing}"), "Keep {missing}");
  }
});

test("a translation applies per key, falls back to English, and fills placeholders after translating", () => {
  setRuntimeLocale("es-ES");
  assert.equal(t("Close"), "Cerrar");
  assert.equal(t("Member of: {parts}", { parts: "A, B" }), "Miembro de: A, B");
  assert.equal(t("Some untranslated line"), "Some untranslated line");
  setRuntimeLocale(undefined);
});

test("the pseudo-locale brackets runtime strings", () => {
  setRuntimeLocale("qps-ploc");
  const out = t("Click a {n} node.", { n: "123" });
  assert.ok(out.startsWith("[") && out.endsWith("]") && out.includes("123"));
  setRuntimeLocale(undefined);
});

test("every catalogue key is used by the chrome or a t() literal, with matching placeholders", () => {
  const dir = path.join(__dirname, "..", "..", "webview");
  const src = [dir, path.join(dir, "plots")].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(d, f), "utf8"))).join("\n");
  const literals = new Set([...src.matchAll(/\btr?\("((?:[^"\\\n]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)));
  const chrome = buildPreviewHtml({ scriptUri: "s", designSystemUri: "d", styleUri: "c", cspSource: "x", nonce: "n", title: "T", theme: "dark" });
  for (const loc of shippedLocales()) {
    for (const [key, val] of Object.entries(catalogueFor(loc)!)) {
      assert.ok(literals.has(key) || chrome.includes(key), `${loc}: "${key}" unused`);
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      assert.equal(ph(val), ph(key), `${loc}: placeholders differ for "${key}"`);
    }
  }
});

test("t() literals never interpolate with ${}; they use {name} placeholders", () => {
  const dirs = [path.join(__dirname, "..", "..", "webview"), path.join(__dirname, "..", "..", "webview", "plots")];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!/\btr?\(`/.test(src), `${f}: t() given a template literal`);
    }
  }
});

test("exported CSV text is identical under the pseudo-locale", async () => {
  const { integralsToCsv } = await import("../parser/analysisExport");
  const sample = integralsToCsv as unknown as (...a: unknown[]) => string;
  setRuntimeLocale(undefined);
  let before: string | undefined, after: string | undefined;
  try { before = sample({ regions: [], total: [] }); } catch { before = undefined; }
  setRuntimeLocale("qps-ploc");
  try { after = sample({ regions: [], total: [] }); } catch { after = undefined; }
  setRuntimeLocale(undefined);
  assert.equal(after, before);
});

test("every shipped language translates exactly the same set of strings", () => {
  const locales = shippedLocales();
  assert.deepEqual([...locales].sort(), ["de", "es", "fr", "pt"]);
  const base = Object.keys(catalogueFor("es")!).sort();
  for (const l of locales) assert.deepEqual(Object.keys(catalogueFor(l)!).sort(), base, l);
});
