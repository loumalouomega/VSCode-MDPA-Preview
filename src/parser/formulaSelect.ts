/**
 * Selects cells with a boolean formula over coordinates and nodal fields — the
 * engine behind the `formula` selection seed (e.g. `z <= 0.0`, the "base" of a
 * model; `x > 1 && TEMP > 300`).
 *
 * Pure module (no vscode / DOM / wasm), bundled into both runtimes. The formula
 * runs through `sizeExpr.ts`'s eval-free predicate parser, so a seed read from a
 * saved sidecar or recipe can never execute code.
 *
 * Semantics, per cell of every kind (Elements, Conditions, Geometries):
 *   - `all`      every node of the cell satisfies the formula (default; a floor
 *                `z <= 0` selects the cells that lie ON or below it);
 *   - `any`      at least one node satisfies it;
 *   - `centroid` the formula holds at the cell centroid (nodal fields averaged).
 * A node whose formula cannot be computed (a referenced field is silent there)
 * does not satisfy it.
 */

import { EntityKind, MdpaModel } from "./types";
import { parsePredicate } from "./sizeExpr";
import { scopeVariables, valueMaps } from "./fieldCalc";
import { globalScopeValues } from "./globalReduce";

export type FormulaRule = "all" | "any" | "centroid";

export interface FormulaSelection {
  kinds: Record<EntityKind, Set<number>>;
  /** Nodes satisfying the formula (for rule all/any; empty for centroid). */
  nodes: Set<number>;
  /** Set when nothing was selected, or the formula is invalid. */
  reason?: string;
}

/** Names a formula may use: x, y, z, every nodal field (scalar or `_x/_y/_z`) and the globals. */
export function formulaVariables(model: MdpaModel): string[] {
  const nodal = model.fields.filter((f) => f.kind === "Nodal");
  return scopeVariables(nodal, true, Object.keys(model.globals ?? {}));
}

/** `undefined` when `expr` is a valid predicate for `model`, else the error text. */
export function validateFormula(model: MdpaModel, expr: string): string | undefined {
  try {
    parsePredicate(expr, formulaVariables(model));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function formulaCells(model: MdpaModel, expr: string, rule: FormulaRule = "all"): FormulaSelection {
  const empty = (reason: string): FormulaSelection => ({
    kinds: { Elements: new Set(), Conditions: new Set(), Geometries: new Set() },
    nodes: new Set(),
    reason,
  });
  if (!expr.trim()) return empty("The formula is empty.");
  let compiled;
  try {
    compiled = parsePredicate(expr, formulaVariables(model));
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
  const nodal = model.fields.filter((f) => f.kind === "Nodal");
  const values = valueMaps(nodal);
  const globals = globalScopeValues(model);
  const used = compiled.variablesUsed.filter((v) => v !== "x" && v !== "y" && v !== "z");

  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);

  const scopeAt = (x: number, y: number, z: number, get: (name: string) => number): Record<string, number> => {
    const scope: Record<string, number> = { x, y, z };
    for (const v of used) scope[v] = get(v);
    return scope;
  };

  // Per-node truth (all/any); lazily filled and cached by node index.
  const nodeTruth = new Int8Array(model.nodeCount).fill(-1);
  const holdsAtNode = (i: number): boolean => {
    if (nodeTruth[i] >= 0) return nodeTruth[i] === 1;
    const id = model.nodeIds[i];
    const scope = scopeAt(model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2], (v) =>
      values.get(v)?.get(id) ?? globals.get(v) ?? NaN
    );
    const ok = compiled.evaluate(scope) === 1;
    nodeTruth[i] = ok ? 1 : 0;
    return ok;
  };

  const out: FormulaSelection = {
    kinds: { Elements: new Set(), Conditions: new Set(), Geometries: new Set() },
    nodes: new Set(),
  };
  if (rule !== "centroid") {
    for (let i = 0; i < model.nodeCount; i++) if (holdsAtNode(i)) out.nodes.add(model.nodeIds[i]);
  }

  for (const b of model.blocks) {
    const target = out.kinds[b.kind];
    for (let c = 0; c < b.count; c++) {
      const ids = b.connectivity.subarray(c * b.stride, (c + 1) * b.stride);
      let hit: boolean;
      if (rule === "centroid") {
        let x = 0, y = 0, z = 0, n = 0;
        const sums = new Map<string, { s: number; k: number }>();
        for (const nid of ids) {
          const i = idx.get(nid);
          if (i === undefined) continue;
          x += model.coords[i * 3];
          y += model.coords[i * 3 + 1];
          z += model.coords[i * 3 + 2];
          n++;
          for (const v of used) {
            const val = values.get(v)?.get(nid);
            if (val === undefined || Number.isNaN(val)) continue;
            const acc = sums.get(v) ?? { s: 0, k: 0 };
            acc.s += val;
            acc.k++;
            sums.set(v, acc);
          }
        }
        if (n === 0) continue;
        hit =
          compiled.evaluate(
            scopeAt(x / n, y / n, z / n, (v) => {
              const acc = sums.get(v);
              return acc && acc.k > 0 ? acc.s / acc.k : globals.get(v) ?? NaN;
            })
          ) === 1;
      } else {
        let some = false;
        let every = ids.length > 0;
        for (const nid of ids) {
          const i = idx.get(nid);
          const ok = i !== undefined && holdsAtNode(i);
          if (ok) some = true;
          else every = false;
          if (rule === "any" && some) break;
          if (rule === "all" && !every) break;
        }
        hit = rule === "all" ? every : some;
      }
      if (hit) target.add(b.entityIds[c]);
    }
  }

  const total = out.kinds.Elements.size + out.kinds.Conditions.size + out.kinds.Geometries.size;
  if (total === 0) out.reason = `No cell satisfies "${expr.trim()}" (${rule}).`;
  return out;
}
