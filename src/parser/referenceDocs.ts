/**
 * Generated reference pages (roadmap item 84, first increment): the command
 * list and the operations table, rendered from `COMMANDS` and `OP_LABELS`.
 * Pure — `scripts/gen-docs-reference.mjs` writes the result and
 * `referenceDocs.test.ts` fails when a committed island differs from a fresh
 * generation. Hand-written prose lives outside the marked islands.
 */

import { COMMANDS, COMMAND_CATEGORIES, type CommandSpec, type ParamSpec } from "./commandSpec";
import { OP_LABELS } from "./opLabels";

export const ISLAND_BEGIN = (id: string): string => `<!-- BEGIN GENERATED: ${id} -->`;
export const ISLAND_END = (id: string): string => `<!-- END GENERATED: ${id} -->`;

const esc = (s: string): string => s.replace(/\|/g, "\\|");

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
];

/** Replace (or append) the island in `existing`; a missing file gets the default page. */
export function applyIsland(page: ReferencePage, existing: string | undefined): string {
  const block = `${ISLAND_BEGIN(page.islandId)}\n${page.render()}\n${ISLAND_END(page.islandId)}`;
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
