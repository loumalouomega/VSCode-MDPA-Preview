/**
 * Generated reference pages (roadmap item 84, first increment): the command
 * list and the operations table, rendered from `COMMANDS` and `OP_LABELS`.
 * Pure — `scripts/gen-docs-reference.mjs` writes the result and
 * `referenceDocs.test.ts` fails when a committed island differs from a fresh
 * generation. Hand-written prose lives outside the marked islands.
 */

import { COMMANDS, COMMAND_CATEGORIES, type CommandSpec, type ParamSpec } from "./commandSpec";
import { OP_LABELS } from "./opLabels";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import type { FieldSpec, ProblemtypeDeclaration } from "../problemtype/types";
import type { McpToolDoc } from "./mcpToolExtract";

export const ISLAND_BEGIN = (id: string): string => `<!-- BEGIN GENERATED: ${id} -->`;
export const ISLAND_END = (id: string): string => `<!-- END GENERATED: ${id} -->`;

const esc = (s: string): string => s.replace(/\|/g, "\\|");

function escapeMcpCell(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const parts = flat.split(/(`[^`]*`)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? esc(part) : esc(part).replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("");
}

function paramText(p: ParamSpec): string {
  const vals = p.values && p.values.length ? `: ${p.values.join("/")}` : "";
  return `\`${p.name}\` (${p.type}${vals}${p.required ? ", required" : ""})`;
}

function commandRow(c: CommandSpec): string {
  const names = [c.name, ...(c.aliases ?? [])].map((n) => `\`${n}\``).join(", ");
  const params = c.params.length ? c.params.map(paramText).join(", ") : "—";
  return `| ${names} | ${esc(c.summary)} | ${esc(params)} | \`${esc(c.example)}\` |`;
}

/** The command list, one table per category. */
export function renderCommandIsland(): string {
  const out: string[] = [];
  for (const cat of COMMAND_CATEGORIES) {
    const list = COMMANDS.filter((c) => c.category === cat);
    if (!list.length) continue;
    out.push(`### ${cat}`, "", "| Command | Summary | Parameters | Example |", "| --- | --- | --- | --- |");
    for (const c of list) out.push(commandRow(c));
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** The operations table: every mesh operation, its label and its command line. */
export function renderOperationIsland(): string {
  const byName = new Map(COMMANDS.filter((c) => c.exec.kind === "op").map((c) => [c.name, c]));
  const out = ["| Operation | Label | Parameters | Example |", "| --- | --- | --- | --- |"];
  for (const op of Object.keys(OP_LABELS).sort()) {
    const c = byName.get(op);
    const params = c && c.params.length ? c.params.map(paramText).join(", ") : "—";
    out.push(`| \`${op}\` | ${esc(OP_LABELS[op as keyof typeof OP_LABELS])} | ${esc(params)} | ${c ? `\`${esc(c.example)}\`` : "—"} |`);
  }
  return out.join("\n");
}

export interface ReferencePage {
  /** Path relative to the repository root. */
  file: string;
  title: string;
  intro: string;
  islandId: string;
  render: () => string;
}

const cell = (v: unknown): string => esc(String(v ?? "").replace(/\s+/g, " ").trim());

function fieldRows(fields: readonly FieldSpec[]): string[] {
  const rows = ["| Field | Label | Type | Default | Unit | Choices |", "| --- | --- | --- | --- | --- | --- |"];
  for (const f of fields) {
    const choices = f.options ? f.options.map((o) => o.value).join(", ") : "";
    const def = f.default === undefined ? "" : `\`${JSON.stringify(f.default)}\``;
    rows.push(`| \`${f.id}\` | ${cell(f.label)} | ${f.type} | ${cell(def)} | ${cell(f.unit)} | ${cell(choices)} |`);
  }
  return rows;
}

/** One problemtype: identity, sections, conditions and material laws. */
export function renderProblemtypeIsland(d: ProblemtypeDeclaration): string {
  const out: string[] = [
    `**${d.name}** (\`${d.id}\`)${d.description ? ` — ${cell(d.description)}` : ""}`,
    "",
    `- Analysis stage: \`${d.analysisStage}\``,
    `- Root model part: \`${d.modelPartName}\``,
    `- Materials file: \`${d.materialsFileName}\``,
    `- Domain sizes: ${d.domainSizes.join(", ")}`,
    "",
    "## Sections",
    "",
  ];
  for (const sec of d.sections) out.push(`### ${sec.label}`, "", ...fieldRows(sec.fields), "");
  out.push("## Conditions", "");
  if (!d.conditions.length) out.push("None.", "");
  for (const c of d.conditions) {
    out.push(`### ${c.label} (\`${c.id}\`)`, "", `List: \`${c.list}\`${c.noProcess ? " — marks a SubModelPart, emits no process" : ""}`, "");
    if (c.fields.length) out.push(...fieldRows(c.fields), "");
  }
  out.push("## Material laws", "");
  if (!d.materialLaws.length) out.push("None.", "");
  for (const l of d.materialLaws) {
    out.push(`### ${l.id}`, "", `Constitutive law: ${l.name ? `\`${l.name}\`` : "—"}${l.domainSize ? `, ${l.domainSize}D only` : ""}`, "");
    if (l.variables.length) out.push(...fieldRows(l.variables), "");
  }
  return out.join("\n").trimEnd();
}

const problemtypePages: ReferencePage[] = BUILTIN_PROBLEMTYPES.map((rt) => ({
  file: `doc/reference/problemtypes/${rt.decl.id}.md`,
  title: `Problemtype: ${rt.decl.name}`,
  intro: "Generated from the built-in `ProblemtypeDeclaration`; run `npm run docs:reference` after changing it.",
  islandId: `problemtype-${rt.decl.id}`,
  render: () => renderProblemtypeIsland(rt.decl),
}));

export const REFERENCE_PAGES: readonly ReferencePage[] = [
  {
    file: "doc/reference/commands.md",
    title: "Command reference",
    intro: "Every command accepted by the command line. The table below is generated from `COMMANDS` in `commandSpec.ts`; run `npm run docs:reference` after changing it.",
    islandId: "commands",
    render: renderCommandIsland,
  },
  {
    file: "doc/reference/operations.md",
    title: "Operation reference",
    intro: "Every mesh operation and its command line. Generated from `OP_LABELS` and `COMMANDS`; run `npm run docs:reference` after changing either.",
    islandId: "operations",
    render: renderOperationIsland,
  },
  ...problemtypePages,
];

/** The MCP tool table, rendered from `server.registerTool` calls in `src/mcp/register.ts`. */
export function renderMcpToolsIsland(tools: readonly McpToolDoc[]): string {
  const out = ["| Tool | What it does |", "| --- | --- |"];
  for (const t of tools) {
    out.push(`| \`${t.name}\` | ${escapeMcpCell(t.description)} |`);
  }
  return out.join("\n");
}

export function mcpToolsPage(tools: readonly McpToolDoc[]): ReferencePage {
  return {
    file: "doc/reference/tools.md",
    title: "MCP tool reference",
    intro: "Every tool registered by the standalone MCP server (`src/mcp/register.ts`). Run `npm run docs:reference` after changing tool registrations.",
    islandId: "mcp-tools",
    render: () => renderMcpToolsIsland(tools),
  };
}

export function readmeToolsPage(tools: readonly McpToolDoc[]): ReferencePage {
  return {
    file: "README.md",
    title: "MCP tool reference",
    intro: "",
    islandId: "mcp-tools",
    render: () => renderMcpToolsIsland(tools),
  };
}

/** Replace (or append) the island in `existing`; a missing file gets the default page. */
export function applyIsland(page: ReferencePage, existing: string | undefined): string {
  // Islands are always written LF-only: on a Windows (CRLF) checkout the rendered text is built
  // from CRLF sources, and writing it verbatim would commit mixed line endings.
  const rendered = page.render().replace(/\r\n?/g, "\n");
  const block = `${ISLAND_BEGIN(page.islandId)}\n${rendered}\n${ISLAND_END(page.islandId)}`;
  if (existing === undefined) return `# ${page.title}\n\n${page.intro}\n\n${block}\n`;
  const b = existing.indexOf(ISLAND_BEGIN(page.islandId));
  const e = existing.indexOf(ISLAND_END(page.islandId));
  if (b < 0 || e < b) return `${existing.trimEnd()}\n\n${block}\n`;
  return existing.slice(0, b) + block + existing.slice(e + ISLAND_END(page.islandId).length);
}

/** The island text currently in `content`, or undefined. */
export function extractIsland(page: ReferencePage, content: string): string | undefined {
  const b = content.indexOf(ISLAND_BEGIN(page.islandId));
  const e = content.indexOf(ISLAND_END(page.islandId));
  if (b < 0 || e < b) return undefined;
  return content.slice(b + ISLAND_BEGIN(page.islandId).length + 1, e - 1);
}
