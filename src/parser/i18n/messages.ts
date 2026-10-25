/**
 * Chrome localisation (roadmap item 15, webview-chrome increment).
 *
 * Pure, import-free, bundled by both runtimes. The chrome markup in
 * `webviewChrome.ts` stays authored in English; `localizeHtml` rewrites the
 * user-visible strings of a finished HTML fragment — text nodes and the
 * `title` / `aria-label` / `placeholder` / `alt` attributes — through a
 * catalogue keyed by the trimmed English text. A string with no entry falls
 * back to English per key, never per file. Machine-facing values (ids,
 * `data-*`, `value`, class names, script and SVG content) are never touched.
 */

/** A locale table: English source text → translation. */
export type Catalogue = Readonly<Record<string, string>>;

/** The pseudo-locale tag (Windows' "qps-ploc"): lengthened, bracketed text. */
export const PSEUDO_LOCALE = "qps-ploc";

/** Locale tables, by language prefix. Add `xx.ts` and list it here. */
const CATALOGUES: Record<string, Catalogue> = {
  es: {
    Reset: "Restablecer",
    Quality: "Calidad",
    Field: "Campo",
    Find: "Buscar",
    Inspect: "Inspeccionar",
    File: "Archivo",
    "Mesh Quality": "Calidad de malla",
    Close: "Cerrar",
    "Export CSV": "Exportar CSV",
    Frame: "Encuadrar",
    "Zoom to bad elements": "Acercar a los elementos defectuosos",
    "Member of: {parts}": "Miembro de: {parts}",
    "Not part of any SubModelPart.": "No pertenece a ningún SubModelPart.",
    "Click a {n} node.": "Haga clic en el nodo {n}.",
    "Plot {v} over time": "Graficar {v} en el tiempo",
    Cancel: "Cancelar",
    Remove: "Quitar",
    "Loading…": "Cargando…",
    "Previous frame": "Fotograma anterior",
    "Next frame": "Fotograma siguiente",
    "Play / Pause": "Reproducir / Pausa",
    "More view controls": "Más controles de vista",
    "no SubModelParts": "sin SubModelParts",
    "no nodal fields": "sin campos nodales",
    "no fields": "sin campos",
    "no per-cell fields": "sin campos por celda",
    "whole mesh": "malla completa",
    "typed by hand": "escrito a mano",
    "save as preset": "guardar como preajuste",
    "re-apply": "volver a aplicar",
    "— none —": "— ninguno —",
    "Copy to all panes": "Copiar a todos los paneles",
    Range: "Rango",
    Count: "Cantidad",
  },
};

export interface LocaleChoice {
  catalogue: Catalogue;
  pseudo: boolean;
}

/** Choose the catalogue for a VS Code display language (`es`, `pt-br`, `qps-ploc`…). */
export function pickCatalogue(language: string | undefined): LocaleChoice {
  const lang = (language ?? "en").toLowerCase();
  if (lang === PSEUDO_LOCALE) return { catalogue: {}, pseudo: true };
  const table = Object.prototype.hasOwnProperty.call(CATALOGUES, lang.split(/[-_]/)[0])
    ? CATALOGUES[lang.split(/[-_]/)[0]]
    : {};
  return { catalogue: table, pseudo: false };
}

/** Names of the locales that ship a table (for tests and documentation). */
export function shippedLocales(): string[] {
  return Object.keys(CATALOGUES);
}

/** The table behind a shipped locale (tests check its keys against the chrome). */
export function catalogueFor(locale: string): Catalogue | undefined {
  return CATALOGUES[locale];
}

/**
 * Bracket and lengthen (~40 %) a string so clipped controls show up. Entities
 * (`&lt;`), `{n}` placeholders and letters-free strings are left alone.
 */
export function pseudoLocalize(s: string): string {
  if (!/[A-Za-z]/.test(s)) return s;
  const map: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" };
  const body = s.replace(/(&[#A-Za-z0-9]+;|\{\w+\})|([aeiouAEIOU])/g, (m, keep, v) => (keep ? m : map[v]));
  const pad = "~".repeat(Math.max(1, Math.ceil(s.replace(/&[#A-Za-z0-9]+;/g, "_").length * 0.4)));
  return `[${body}${pad}]`;
}

function translate(text: string, c: LocaleChoice): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const lead = text.slice(0, text.indexOf(trimmed));
  const trail = text.slice(lead.length + trimmed.length);
  if (c.pseudo) return lead + pseudoLocalize(trimmed) + trail;
  return Object.prototype.hasOwnProperty.call(c.catalogue, trimmed) ? lead + c.catalogue[trimmed] + trail : text;
}

const ATTRS = ["title", "aria-label", "placeholder", "alt"];

function localizeTag(tag: string, c: LocaleChoice): string {
  return tag.replace(
    new RegExp(`(\\s(?:${ATTRS.join("|")})=)(["'])([^"']*)\\2`, "g"),
    (_m, pre: string, q: string, val: string) => `${pre}${q}${translate(val, c)}${q}`
  );
}

/**
 * Localise an HTML fragment. Markup that carries `${...}` interpolations must
 * be localised AFTER interpolation (it works on finished strings).
 */
export function localizeHtml(html: string, choice: LocaleChoice): string {
  if (!choice.pseudo && Object.keys(choice.catalogue).length === 0) return html;
  let out = "";
  let i = 0;
  let skipUntil: string | undefined; // closing tag of an opaque element
  let inValuelessOption = false;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) { out += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
      const closing = tag.startsWith("</");
      if (skipUntil) {
        if (closing && name === skipUntil) skipUntil = undefined;
        out += tag;
      } else {
        if (!closing && (name === "script" || name === "style" || name === "svg")) skipUntil = name;
        if (name === "option") inValuelessOption = !closing && !/\svalue=/.test(tag);
        out += closing || !name ? tag : localizeTag(tag, choice);
      }
      i = end + 1;
    } else {
      const next = html.indexOf("<", i);
      const stop = next < 0 ? html.length : next;
      const text = html.slice(i, stop);
      out += skipUntil || inValuelessOption ? text : translate(text, choice);
      i = stop;
    }
  }
  return out;
}
