/**
 * Where a ROM parameter lands in the generated documents, found BY
 * PERTURBATION: the documents are rebuilt twice with the parameter set to two
 * distinct probe values, and every leaf that changed with it is a place the
 * driver must write the sampled value. This needs no knowledge of how each
 * problemtype maps a form value into Kratos JSON (a `$field:` template, a hook
 * that broadcasts a vector, a material variable), and it cannot drift from the
 * generator because it IS the generator.
 *
 * A leaf that changed into something other than the probe value (the generator
 * transformed it: a derived quantity, a unit conversion) is not something the
 * driver can reproduce, so that parameter is refused by name.
 *
 * Pure module: no vscode / DOM / node imports.
 */

import type { JsonValue } from "../types";

export type JsonPath = (string | number)[];

export interface ParameterPath {
  /** Which generated document: the primary ProjectParameters or the materials file. */
  document: "parameters" | "materials";
  path: JsonPath;
  /** `number`: write the value; `string`: substitute it into `template` at `{mu}`. */
  kind: "number" | "string";
  template?: string;
}

/** Probe values: distinctive, finite, and unlikely to collide with anything a case holds. */
export const PROBE_A = 1234.56789;
export const PROBE_B = 8765.4321;

/** Every leaf path whose value differs between two JSON documents of the same shape. */
export function diffLeaves(a: JsonValue, b: JsonValue, path: JsonPath = []): { path: JsonPath; a: JsonValue; b: JsonValue }[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [{ path, a, b }];
    return a.flatMap((x, i) => diffLeaves(x, b[i], [...path, i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: { path: JsonPath; a: JsonValue; b: JsonValue }[] = [];
    for (const k of keys) {
      if (!(k in a) || !(k in b)) out.push({ path: [...path, k], a: a[k] ?? null, b: b[k] ?? null });
      else out.push(...diffLeaves(a[k], b[k], [...path, k]));
    }
    return out;
  }
  return a === b ? [] : [{ path, a, b }];
}

/** The number spellings a probe value may appear as inside a string leaf. */
const spellings = (x: number): string[] => [...new Set([String(x), x.toFixed(5), x.toExponential()])];

/**
 * Classifies the leaves that changed between the two probe documents. Returns
 * the writable paths, or the reason a change cannot be reproduced.
 */
export function classifyChanges(
  document: ParameterPath["document"],
  changes: { path: JsonPath; a: JsonValue; b: JsonValue }[]
): { paths: ParameterPath[]; problems: string[] } {
  const paths: ParameterPath[] = [];
  const problems: string[] = [];
  for (const c of changes) {
    const where = `${document === "materials" ? "materials" : "ProjectParameters"} › ${c.path.join(".")}`;
    if (typeof c.a === "number" && typeof c.b === "number" && Math.abs(c.a - PROBE_A) < 1e-9 && Math.abs(c.b - PROBE_B) < 1e-9) {
      paths.push({ document, path: c.path, kind: "number" });
      continue;
    }
    if (typeof c.a === "string" && typeof c.b === "string") {
      const spellA = spellings(PROBE_A).find((s) => (c.a as string).includes(s));
      const spellB = spellings(PROBE_B).find((s) => (c.b as string).includes(s));
      if (spellA && spellB) {
        const template = (c.a as string).split(spellA).join("{mu}");
        if (template === (c.b as string).split(spellB).join("{mu}")) {
          paths.push({ document, path: c.path, kind: "string", template });
          continue;
        }
      }
    }
    problems.push(`${where} is derived from the value rather than equal to it, so it cannot be sampled.`);
  }
  return { paths, problems };
}

/** Resolves a path in a JSON document (undefined when it does not exist). */
export function valueAtPath(doc: JsonValue, path: JsonPath): JsonValue | undefined {
  let cur: JsonValue | undefined = doc;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? (typeof key === "number" ? cur[key] : undefined) : (cur as Record<string, JsonValue>)[String(key)];
  }
  return cur;
}
