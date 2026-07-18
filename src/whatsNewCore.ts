// Pure (no `vscode`/DOM) core of the "What's New" changelog popup: parse
// CHANGELOG.md, compare versions, pick the entries newer than the last-seen
// version, and render the selected entries to HTML. Kept vscode-free so it is
// Node-testable; the vscode glue (globalState + webview panel) lives in
// `whatsNew.ts`.

/** One version section parsed out of CHANGELOG.md. */
export interface ChangelogEntry {
  /** The `x.y.z` version string. */
  version: string;
  /** The `YYYY-MM-DD` date string. */
  date: string;
  /** The raw markdown body between this heading and the next (trimmed). */
  body: string;
}

const HEADING_RE = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;
// Reference-style link definitions at the file tail, e.g.
// `[2.2.0]: https://github.com/.../compare/v2.1.0...v2.2.0`
const LINK_DEF_RE = /^\[\d+\.\d+\.\d+\]:\s+\S+/;

/**
 * Parse CHANGELOG.md (Keep-a-Changelog format) into version entries, newest
 * first. The intro paragraph before the first heading and the trailing
 * reference-link-definition block are excluded from every entry's body.
 */
export function parseChangelog(text: string): ChangelogEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      entries.push(current);
    }
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      current = { version: m[1], date: m[2], body: "" };
      bodyLines = [];
      continue;
    }
    // Trailing link definitions belong to no entry's body.
    if (current && !LINK_DEF_RE.test(line)) {
      bodyLines.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Compare two `x.y.z` version strings numerically. Returns a negative number
 * if `a < b`, zero if equal, a positive number if `a > b`. Missing parts are
 * treated as 0.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * From a parsed changelog, select the entries strictly newer than
 * `lastShown`. An undefined `lastShown` (fresh install) yields an empty list —
 * new users get no popup.
 */
export function selectNewEntries(
  entries: ChangelogEntry[],
  lastShown: string | undefined
): ChangelogEntry[] {
  if (!lastShown) return [];
  return entries.filter((e) => compareSemver(e.version, lastShown) > 0);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert the small markdown subset used inside a changelog bullet into HTML:
 * `[text](url)` links (https only), `**bold**`, and `` `code` ``. The input is
 * HTML-escaped first, so no markup in the source text can inject elements.
 */
function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Links: [text](url) — only http(s) targets are turned into anchors.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_all, label: string, url: string) =>
      `<a href="${url}">${label}</a>`
  );
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Inline code: `text`
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

/** Render one entry's markdown body (bullet list) to an HTML `<ul>`. */
function renderBody(body: string): string {
  const items: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (m) {
      items.push(`<li>${renderInline(m[1])}</li>`);
    } else {
      // Non-bullet prose lines still get shown as list items so nothing is lost.
      items.push(`<li>${renderInline(line)}</li>`);
    }
  }
  return items.length ? `<ul>${items.join("")}</ul>` : "";
}

/**
 * Render selected changelog entries to an HTML fragment (one section per
 * version). Text is HTML-escaped; the output never contains a `<script>`.
 */
export function changelogToHtml(entries: ChangelogEntry[]): string {
  if (!entries.length) {
    return `<p class="empty">No changelog entries to show.</p>`;
  }
  return entries
    .map(
      (e) =>
        `<section class="entry">` +
        `<h2>${escapeHtml(e.version)} <span class="date">${escapeHtml(e.date)}</span></h2>` +
        renderBody(e.body) +
        `</section>`
    )
    .join("\n");
}
