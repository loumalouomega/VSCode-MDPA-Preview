/**
 * Which cells a selective refine should split.
 *
 * Pure (no `vscode`/DOM/vtk/fs). Resolves a `RefineSelector` into per-kind sets
 * of entity ids, which is the shape `refineMesh.ts` already uses everywhere
 * (`childrenOf`, `renumberMesh`'s `entityMaps`, `cropMesh`'s keep sets) —
 * Elements, Conditions and Geometries have separate id spaces, so an id alone
 * is never an answer.
 *
 * ## The selector walks BLOCKS, not the field
 *
 * `ERROR_MARKED` is declared `Elemental` while its ids span all three id spaces
 * (`errorEstimate.ts` writes one row per cell of every block), so `Element 7`
 * and `Condition 7` are indistinguishable inside that array. Resolving by
 * walking the field would therefore pick cells at random between the two.
 * Walking blocks of the requested kind instead, and looking each
 * `entityIds[c]` up in the field's map, means an ambiguous id at worst yields a
 * stale VALUE for the right cell — never the wrong cell. The count of field ids
 * that match no cell of that kind is reported rather than swallowed, since on
 * today's `ERROR_MARKED` it is the visible edge of that malformedness.
 *
 * Selecting natively rather than widening `thresholdCells.ts`: that module has
 * no `geometryIds`, its `[lo, hi]` window cannot express `!=` or a one-sided
 * `>`, and it is documented view-only. The duplication is deliberate.
 */

import { EntityKind, FieldBlockKind, MdpaModel } from "./types";
import { findSubModelPart } from "./subModelPartExtract";

export type RefineCompare = "<" | "<=" | ">" | ">=" | "==" | "!=";

export const REFINE_COMPARES: readonly RefineCompare[] = ["<", "<=", ">", ">=", "==", "!="];

/** The field `estimateError` writes, and the default this selector reads. */
export const DEFAULT_SELECT_VARIABLE = "ERROR_MARKED";

export type RefineSelector =
  /** A SubModelPart and its whole subtree. */
  | { by: "part"; path: string }
  /** A per-cell field compared against a value. Defaults to ERROR_MARKED > 0.5. */
  | {
      by: "field";
      variable?: string;
      compare?: RefineCompare;
      value?: number;
      location?: FieldBlockKind;
    }
  /** Explicit entity ids of one kind — the escape hatch, and what a future click-selection posts. */
  | { by: "ids"; kind: EntityKind; ids: number[] };

export interface Selection {
  cells: Record<EntityKind, Set<number>>;
  count: number;
  /** Field ids naming no cell of the requested kind (see the note above). */
  unresolved: number;
  /**
   * Why nothing could be selected. A REASON, not an error: a selective refine
   * whose field is absent must be a noop with a message, because
   * `estimateError` is async and a `skipAsyncOps` timeline replay skips it —
   * throwing there would break a mesh that opens perfectly well.
   */
  problem?: string;
}

const emptyCells = (): Record<EntityKind, Set<number>> => ({
  Elements: new Set(),
  Conditions: new Set(),
  Geometries: new Set(),
});

/** Which block kind a per-cell field location addresses. */
function kindFor(location: FieldBlockKind): EntityKind | undefined {
  if (location === "Elemental") return "Elements";
  if (location === "Conditional") return "Conditions";
  return undefined; // Nodal — refused by name below
}

function compare(op: RefineCompare, a: number, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
  }
}

export function resolveSelection(model: MdpaModel, sel: RefineSelector): Selection {
  const cells = emptyCells();
  let unresolved = 0;

  if (sel.by === "ids") {
    for (const id of sel.ids) cells[sel.kind].add(id);
    const count = cells[sel.kind].size;
    return count === 0
      ? { cells, count: 0, unresolved: 0, problem: "No entity ids were given." }
      : { cells, count, unresolved: 0 };
  }

  if (sel.by === "part") {
    const part = findSubModelPart(model, sel.path);
    if (!part) {
      return { cells, count: 0, unresolved: 0, problem: `No SubModelPart "${sel.path}".` };
    }
    const walk = (p: typeof part): void => {
      for (const id of p.elementIds) cells.Elements.add(id);
      for (const id of p.conditionIds) cells.Conditions.add(id);
      for (const id of p.geometryIds) cells.Geometries.add(id);
      for (const c of p.children) walk(c);
    };
    walk(part);
    const count = cells.Elements.size + cells.Conditions.size + cells.Geometries.size;
    return count === 0
      ? {
          cells,
          count: 0,
          unresolved: 0,
          problem: `SubModelPart "${sel.path}" lists no elements, conditions or geometries.`,
        }
      : { cells, count, unresolved: 0 };
  }

  // by: "field"
  const location = sel.location ?? "Elemental";
  const kind = kindFor(location);
  if (!kind) {
    return {
      cells,
      count: 0,
      unresolved: 0,
      // A nodal field has no per-cell value, and the extension already owns the
      // conversion — the same refusal gradientField.ts makes in reverse.
      problem:
        "A Nodal field cannot select cells directly; convert it with Average field first.",
    };
  }
  const variable = sel.variable?.trim() || DEFAULT_SELECT_VARIABLE;
  const op = sel.compare ?? ">";
  const value = sel.value ?? 0.5;

  const field = model.fields.find((f) => f.kind === location && f.variable === variable);
  if (!field) {
    return {
      cells,
      count: 0,
      unresolved: 0,
      problem:
        `No ${location} field "${variable}". Run Error estimate with a marking ` +
        `policy first (it is skipped during timeline playback).`,
    };
  }

  // Only the FIRST component: a selector is a per-cell yes/no, and a vector
  // field's later components would silently pick a different set per component.
  const byId = new Map<number, number>();
  for (let i = 0; i < field.ids.length; i++) byId.set(field.ids[i], field.values[i * field.components]);

  const seen = new Set<number>();
  for (const block of model.blocks) {
    if (block.kind !== kind) continue;
    for (let c = 0; c < block.count; c++) {
      const id = block.entityIds[c];
      seen.add(id);
      const v = byId.get(id);
      if (v === undefined || !Number.isFinite(v)) continue; // NaN never selects
      if (compare(op, v, value)) cells[kind].add(id);
    }
  }
  for (const id of byId.keys()) if (!seen.has(id)) unresolved++;

  const count = cells[kind].size;
  return count === 0
    ? {
        cells,
        count: 0,
        unresolved,
        problem: `No ${kind} cell has ${variable} ${op} ${value}.`,
      }
    : { cells, count, unresolved };
}
