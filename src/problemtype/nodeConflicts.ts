/**
 * Conflicting conditions on shared nodes (roadmap item 41).
 *
 * Two DIFFERENT parts whose processes both fix the same variable on nodes they
 * share (a support and an imposed displacement meeting at an edge, two inlets
 * touching at a corner) are passed to Kratos as is, and the process applied
 * last silently wins. This reads the GENERATED `constraints_process_list`
 * (the dry run preflight already makes), so a hook-built process is judged by
 * what it actually writes. The rule is per fixed variable component, since
 * that is what the processes write.
 *
 * Pure: no vscode / DOM / fs.
 */
import type { MdpaModel } from "../parser/types";
import { subModelPartNodeIds } from "../parser/subModelPartExtract";
import type { Finding } from "./preflight";
import type { ConditionSpec } from "./types";

const SAMPLE = 8;
const AXES = ["x", "y", "z"];

interface FixedEntry {
  smpPath: string;
  variable: string;
  /** Per component: the fixed value (number, or the JSON text of an expression), or undefined when free. */
  fixed: (string | number | undefined)[];
  interval: [number, number];
}

function intervalOf(v: unknown): [number, number] {
  if (Array.isArray(v) && v.length === 2) {
    const n = (x: unknown): number => (typeof x === "number" ? x : x === "End" ? Infinity : x === "Begin" ? 0 : Number(x));
    const a = n(v[0]);
    const b = n(v[1]);
    if (Number.isFinite(a) || a === Infinity) return [a, b];
  }
  return [0, Infinity];
}

function entriesOf(pp: unknown, smpByDotted: (name: string) => string | undefined): FixedEntry[] {
  const list = (pp as { processes?: { constraints_process_list?: unknown } } | null)?.processes?.constraints_process_list;
  if (!Array.isArray(list)) return [];
  const out: FixedEntry[] = [];
  for (const e of list) {
    const p = (e as { Parameters?: Record<string, unknown> } | null)?.Parameters;
    if (!p || typeof p.variable_name !== "string" || typeof p.model_part_name !== "string") continue;
    const smpPath = smpByDotted(p.model_part_name);
    if (!smpPath) continue;
    const value = p.value;
    const constrained = p.constrained;
    const width = Array.isArray(value) ? value.length : Array.isArray(constrained) ? constrained.length : 1;
    const fixed: (string | number | undefined)[] = [];
    for (let i = 0; i < width; i++) {
      const c = Array.isArray(constrained) ? constrained[i] : constrained;
      if (c === false) {
        fixed.push(undefined);
        continue;
      }
      const v = Array.isArray(value) ? value[i] : value;
      fixed.push(typeof v === "number" ? v : v === undefined || v === null ? 0 : JSON.stringify(v));
    }
    out.push({ smpPath, variable: p.variable_name, fixed, interval: intervalOf(p.interval) });
  }
  return out;
}

export function sharedNodeConflicts(
  model: MdpaModel,
  projectParameters: string,
  assignments: { conditionId: string; smpPath: string }[],
  conditions: ConditionSpec[]
): Finding[] {
  let pp: unknown;
  try {
    pp = JSON.parse(projectParameters);
  } catch {
    return [];
  }
  // model_part_name is "<root>.<dotted path>": match by the dotted suffix.
  const paths = [...new Set(assignments.map((a) => a.smpPath))];
  const smpByDotted = (name: string): string | undefined =>
    paths.find((p) => name === p.split("/").join(".") || name.endsWith("." + p.split("/").join(".")));
  const entries = entriesOf(pp, smpByDotted);
  if (entries.length < 2) return [];

  const nodesOf = new Map<string, Set<number> | undefined>();
  const nodes = (p: string): Set<number> | undefined => {
    if (!nodesOf.has(p)) nodesOf.set(p, subModelPartNodeIds(model, p));
    return nodesOf.get(p);
  };
  const labelFor = (smpPath: string, variable: string): { id?: string; label: string } => {
    const mine = assignments.filter((a) => a.smpPath === smpPath);
    const cond =
      mine.map((a) => conditions.find((c) => c.id === a.conditionId)).find(
        (c) => (c?.processTemplate as { Parameters?: { variable_name?: unknown } } | undefined)?.Parameters?.variable_name === variable
      ) ?? conditions.find((c) => c.id === mine[0]?.conditionId);
    return { id: cond?.id, label: cond?.label ?? variable };
  };

  const out: Finding[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.variable !== b.variable || a.smpPath === b.smpPath) continue;
      if (a.interval[0] > b.interval[1] || b.interval[0] > a.interval[1]) continue; // never active together
      const na = nodes(a.smpPath);
      const nb = nodes(b.smpPath);
      if (!na || !nb) continue;
      const shared: number[] = [];
      for (const n of na) if (nb.has(n)) shared.push(n);
      if (shared.length === 0) continue;
      const comps: number[] = [];
      let differ = false;
      for (let k = 0; k < Math.min(a.fixed.length, b.fixed.length); k++) {
        if (a.fixed[k] === undefined || b.fixed[k] === undefined) continue;
        comps.push(k);
        if (a.fixed[k] !== b.fixed[k]) differ = true;
      }
      if (comps.length === 0) continue;
      const key = `${a.smpPath}\u0000${b.smpPath}\u0000${a.variable}\u0000${comps.join()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const la = labelFor(a.smpPath, a.variable);
      const lb = labelFor(b.smpPath, b.variable);
      const compText = a.fixed.length > 1 ? `${a.variable} (${comps.map((k) => AXES[k] ?? k).join(", ")})` : a.variable;
      const vals = differ
        ? ` with different values (${comps.map((k) => `${a.fixed[k]} vs ${b.fixed[k]}`).join("; ")}) — the one applied last wins`
        : " with the same values";
      out.push({
        severity: differ ? "warning" : "info",
        code: "condition-shared-nodes",
        message: `"${la.label}" on "${a.smpPath}" and "${lb.label}" on "${b.smpPath}" both fix ${compText} on ${shared.length} shared node(s)${vals}.`,
        target: {
          smpPath: a.smpPath,
          ...(la.id ? { conditionId: la.id } : {}),
          entityIds: shared.sort((x, y) => x - y).slice(0, SAMPLE),
        },
      });
    }
  }
  return out;
}
