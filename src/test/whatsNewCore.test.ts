import { test } from "node:test";
import assert from "node:assert";
import {
  changelogToHtml,
  compareSemver,
  parseChangelog,
  selectNewEntries,
} from "../whatsNewCore";

// A trimmed-down fixture mirroring the real CHANGELOG.md shape: intro
// paragraph, several version sections (not all with a trailing link-def), and
// the reference-link-definition block at the tail.
const CHANGELOG = `# Changelog

All notable changes are documented in this file.

## [2.2.0] - 2026-07-18

- Upgraded to meshio++ 6.6.1 with support for **EnSight Gold** (\`.case\`)
- New \`mesh_convert\` options

## [2.1.0] - 2026-07-17

- Mesh Size panel ([#51](https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51))

## [2.0.0] - 2026-07-16

- Extended mesh-format support

[2.1.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/loumalouomega/VSCode-MDPA-Preview/compare/v1.9.4...v2.0.0
`;

test("parseChangelog extracts versions, dates, and bodies newest-first", () => {
  const entries = parseChangelog(CHANGELOG);
  assert.deepEqual(
    entries.map((e) => e.version),
    ["2.2.0", "2.1.0", "2.0.0"]
  );
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2026-07-18", "2026-07-17", "2026-07-16"]
  );
  // Intro paragraph is not attached to any entry.
  assert.ok(!entries[0].body.includes("All notable changes"));
  // Body content is captured.
  assert.ok(entries[0].body.includes("meshio++ 6.6.1"));
});

test("parseChangelog excludes the trailing link-definition block from bodies", () => {
  const entries = parseChangelog(CHANGELOG);
  const last = entries[entries.length - 1];
  assert.equal(last.version, "2.0.0");
  assert.ok(!last.body.includes("compare/"));
  assert.ok(!last.body.includes("]:"));
  assert.ok(last.body.includes("Extended mesh-format support"));
});

test("parseChangelog handles an empty / heading-less file", () => {
  assert.deepEqual(parseChangelog(""), []);
  assert.deepEqual(parseChangelog("# Just a title\n\nsome prose"), []);
});

test("compareSemver orders numerically, not lexically", () => {
  assert.ok(compareSemver("2.10.0", "2.9.0") > 0);
  assert.ok(compareSemver("2.1.0", "2.2.0") < 0);
  assert.equal(compareSemver("2.2.0", "2.2.0"), 0);
  assert.ok(compareSemver("2.0.0", "1.9.4") > 0);
});

test("selectNewEntries returns only strictly-newer entries", () => {
  const entries = parseChangelog(CHANGELOG);
  assert.deepEqual(
    selectNewEntries(entries, "2.1.0").map((e) => e.version),
    ["2.2.0"]
  );
  assert.deepEqual(
    selectNewEntries(entries, "2.0.0").map((e) => e.version),
    ["2.2.0", "2.1.0"]
  );
});

test("selectNewEntries is empty for fresh install and downgrade", () => {
  const entries = parseChangelog(CHANGELOG);
  assert.deepEqual(selectNewEntries(entries, undefined), []);
  // Current already newest → nothing newer.
  assert.deepEqual(selectNewEntries(entries, "2.2.0"), []);
  // "Downgrade": stored version newer than everything present.
  assert.deepEqual(selectNewEntries(entries, "3.0.0"), []);
});

test("changelogToHtml converts the markdown subset and never emits a script", () => {
  const entries = parseChangelog(CHANGELOG);
  const html = changelogToHtml(entries);
  assert.ok(html.includes("<strong>EnSight Gold</strong>"));
  assert.ok(html.includes("<code>.case</code>"));
  assert.ok(
    html.includes(
      '<a href="https://github.com/loumalouomega/VSCode-MDPA-Preview/pull/51">#51</a>'
    )
  );
  assert.ok(html.includes("<li>"));
  assert.ok(!/<script/i.test(html));
});

test("changelogToHtml escapes HTML in body text", () => {
  const entries = parseChangelog(
    "## [1.0.0] - 2026-01-01\n\n- Handles <img src=x onerror=alert(1)> & other <b>markup</b>\n"
  );
  const html = changelogToHtml(entries);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&amp;"));
});

test("changelogToHtml handles an empty selection", () => {
  const html = changelogToHtml([]);
  assert.ok(html.includes("No changelog entries"));
  assert.ok(!/<script/i.test(html));
});
