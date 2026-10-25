/**
 * Runtime localisation (roadmap item 15, webview-panel increment).
 *
 * Pure and bundled by the webview. Panels wrap their user-visible English
 * literals in `t("…")`; the catalogue is the same table `localizeHtml` uses for
 * the chrome, keyed by the English text. A missing key falls back to English,
 * `{name}` placeholders are substituted after translation so word order can
 * change, and English (the default) is the identity. Machine-facing text —
 * ids, message types, CSV headers, exported values — must never go through `t`.
 */
import { pickCatalogue, pseudoLocalize, type LocaleChoice } from "./messages";

let choice: LocaleChoice = { catalogue: {}, pseudo: false };

/** Select the locale for this runtime (a VS Code display language, or `qps-ploc`). */
export function setRuntimeLocale(language: string | undefined): void {
  choice = pickCatalogue(language);
}

/** Translate `english`, then fill `{name}` placeholders from `vars`. */
export function t(english: string, vars?: Record<string, string | number>): string {
  let text = english;
  if (!choice.pseudo && Object.prototype.hasOwnProperty.call(choice.catalogue, english)) {
    text = choice.catalogue[english];
  }
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (m, k: string) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
    );
  }
  return choice.pseudo ? pseudoLocalize(text) : text;
}
