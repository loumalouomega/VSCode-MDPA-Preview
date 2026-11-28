// Regenerates doc/reference/*.md islands (roadmap item 84).
// Needs the compiled tests: `npm run build:tests` first (the npm script does it).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { REFERENCE_PAGES, mcpToolsPage, readmeToolsPage, applyIsland } = require(path.join(root, "out", "parser", "referenceDocs.js"));
const { extractMcpTools } = require(path.join(root, "out", "parser", "mcpToolExtract.js"));

const tools = extractMcpTools(fs.readFileSync(path.join(root, "src", "mcp", "register.ts"), "utf8"));
const pages = [...REFERENCE_PAGES, mcpToolsPage(tools), readmeToolsPage(tools)];

for (const page of pages) {
  const file = path.join(root, page.file);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  const next = applyIsland(page, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (next !== existing) fs.writeFileSync(file, next);
  console.log(`${next === existing ? "unchanged" : "wrote"} ${page.file}`);
}
