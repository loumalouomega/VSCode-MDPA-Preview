/**
 * Rendering a run comparison as Markdown (roadmap item 6).
 *
 * The Kratos Runs `kratos.runs.compare` command opens this report for two
 * runs the user picked; `runCompare.ts` stays the evidence-only core, so this
 * module takes a `RunComparison` and returns text. Pure (no vscode) and
 * deterministic for a given `now`, so the layout is Node-testable.
 */

import * as path from "node:path";

import { COMPARE_LIST_LIMIT, type RunComparison } from "./runCompare";

/** A table cell: objects as compact JSON, pipes escaped, whitespace folded. */
function cell(value: unknown, budget = 120): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const flat = raw.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return flat.length > budget ? `${flat.slice(0, budget - 1)}…` : flat;
}

/** A recorded revision shortened for a table; a hash prefix still identifies it. */
function shortRevision(revision?: string): string {
  if (revision === undefined) return "—";
  const sha = /^sha256:([0-9a-f]+)$/.exec(revision);
  if (sha) return `sha256:${sha[1].slice(0, 12)}…`;
  return cell(revision, 40);
}

function yesNo(value?: boolean): string {
  if (value === undefined) return "Not recorded";
  return value ? "Yes" : "No";
}

/**
 * The report for one comparison as Markdown. `now` is the generation time
 * (defaults to `Date.now()`); pass it in tests for a stable document.
 */
export function renderRunComparisonMarkdown(comparison: RunComparison, now: number = Date.now()): string {
  const left = path.basename(comparison.left.runDirectory);
  const right = path.basename(comparison.right.runDirectory);
  const out: string[] = [
    `# Run comparison — ${cell(left, 80)} vs ${cell(right, 80)}`,
    "",
    "> Recorded facts about two saved runs — identity, settings, inputs and outputs. Never a judgement about which run is “better”.",
    "",
    "## Verdict",
    "",
  ];
  if (comparison.comparable) {
    out.push("Comparable — both sides are terminal isolated runs.", "");
  } else {
    out.push("Not comparable:", "");
    for (const problem of comparison.problems) out.push(`- ${cell(problem, 300)}`);
    out.push("");
  }

  const sameEntries: [string, boolean | undefined][] = [
    ["Same source mesh", comparison.same.sourceMesh],
    ["Same problemtype", comparison.same.problemtype],
    ["Identical settings", comparison.same.settings],
    ["Same CAD source", comparison.same.cadSource],
  ];
  if (sameEntries.some(([, value]) => value !== undefined)) {
    out.push("## Identity", "", "| Check | Result |", "| --- | --- |");
    for (const [label, value] of sameEntries) {
      if (value !== undefined) out.push(`| ${label} | ${yesNo(value)} |`);
    }
    out.push("");
  }

  out.push("## Settings", "");
  if (comparison.settings.length > 0) {
    out.push(`| Setting | ${cell(left, 40)} | ${cell(right, 40)} |`, "| --- | --- | --- |");
    for (const change of comparison.settings) {
      const leftCell = "left" in change ? cell(change.left) : "—";
      const rightCell = "right" in change ? cell(change.right) : "—";
      out.push(`| \`${cell(change.path, 120)}\` | ${leftCell} | ${rightCell} |`);
    }
    if (comparison.settings.length >= COMPARE_LIST_LIMIT) {
      out.push("", `> List bounded at ${COMPARE_LIST_LIMIT} differing settings; the runs record more.`);
    }
    out.push("");
  } else if (Object.keys(comparison.same).length > 0) {
    out.push("Identical — no setting differs.", "");
  } else {
    out.push("Neither run kept a preparation manifest (a run launched without generation), so settings cannot be compared.", "");
  }

  const counts = comparison.counts;
  out.push("## Outputs", "", `Paired ${counts.paired} · only on the left ${counts.onlyLeft} · only on the right ${counts.onlyRight} · changed ${counts.changed} · unverified ${counts.unverified}.`, "");
  if (comparison.changed.length > 0) {
    out.push("### Changed outputs", "", "| Output | Left revision | Right revision |", "| --- | --- | --- |");
    for (const change of comparison.changed) {
      out.push(`| \`${cell(`${change.role}:${change.path}`, 160)}\` | ${shortRevision(change.left)} | ${shortRevision(change.right)} |`);
    }
    if (comparison.changed.length >= COMPARE_LIST_LIMIT) out.push("", `> List bounded at ${COMPARE_LIST_LIMIT} changed outputs; the runs record more.`);
    out.push("");
  }
  if (comparison.onlyLeft.length > 0) {
    out.push("### Only on the left", "");
    for (const entry of comparison.onlyLeft) out.push(`- \`${cell(entry, 200)}\``);
    if (comparison.onlyLeft.length >= COMPARE_LIST_LIMIT) out.push("", `> List bounded at ${COMPARE_LIST_LIMIT} entries; the runs record more.`);
    out.push("");
  }
  if (comparison.onlyRight.length > 0) {
    out.push("### Only on the right", "");
    for (const entry of comparison.onlyRight) out.push(`- \`${cell(entry, 200)}\``);
    if (comparison.onlyRight.length >= COMPARE_LIST_LIMIT) out.push("", `> List bounded at ${COMPARE_LIST_LIMIT} entries; the runs record more.`);
    out.push("");
  }
  if (comparison.unverified.length > 0) {
    out.push("### Unverified", "", "> These pairs share a name but at least one side never pinned the bytes, so equality is **not** claimed.", "");
    for (const change of comparison.unverified) out.push(`- \`${cell(`${change.role}:${change.path}`, 200)}\``);
    if (comparison.unverified.length >= COMPARE_LIST_LIMIT) out.push("", `> List bounded at ${COMPARE_LIST_LIMIT} entries; the runs record more.`);
    out.push("");
  }

  out.push(`Compared ${new Date(now).toISOString()}. Revisions are what each run recorded when it ended; a file that recorded none is reported as unverified, never as unchanged.`, "");
  return out.join("\n");
}
