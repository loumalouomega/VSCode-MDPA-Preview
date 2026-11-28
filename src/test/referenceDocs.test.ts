/** Fails when a committed reference island differs from a fresh generation (roadmap item 84). */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { REFERENCE_PAGES, mcpToolsPage, readmeToolsPage, applyIsland, extractIsland } from "../parser/referenceDocs";
import { extractMcpTools } from "../parser/mcpToolExtract";
import { OP_LABELS } from "../parser/opLabels";

const root = path.join(__dirname, "..", "..");
const mcpTools = extractMcpTools(fs.readFileSync(path.join(root, "src", "mcp", "register.ts"), "utf8"));
const ALL_PAGES = [...REFERENCE_PAGES, mcpToolsPage(mcpTools), readmeToolsPage(mcpTools)];

for (const page of ALL_PAGES) {
  test(`${page.file} island is current (run npm run docs:reference)`, () => {
    // Windows checkouts may use CRLF: normalize BOTH sides, since page.render() builds its
    // text from source files (src/mcp/register.ts and friends) that are CRLF there too.
    const content = fs.readFileSync(path.join(root, page.file), "utf8").replace(/\r\n?/g, "\n");
    const rendered = page.render().replace(/\r\n?/g, "\n");
    assert.equal(extractIsland(page, content), rendered);
  });
}

test("applyIsland keeps prose outside the island and is idempotent", () => {
  const page = REFERENCE_PAGES.find((p) => p.islandId === "operations")!;
  const hand = `# T\n\nhand prose\n\n<!-- BEGIN GENERATED: operations -->\nold\n<!-- END GENERATED: operations -->\n\ntail prose\n`;
  const next = applyIsland(page, hand);
  assert.ok(next.startsWith("# T\n\nhand prose\n"));
  assert.ok(next.endsWith("\ntail prose\n"));
  assert.equal(applyIsland(page, next), next);
});

test("operations island lists every operation", () => {
  const text = REFERENCE_PAGES.find((p) => p.islandId === "operations")!.render();
  for (const op of Object.keys(OP_LABELS)) assert.ok(text.includes(`| \`${op}\` |`), op);
});
