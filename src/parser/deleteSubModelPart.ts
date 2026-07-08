/**
 * Deletes a SubModelPart (and its descendant subtree) from a mesh: removes the
 * elements / conditions / geometries it owns from the blocks (and their
 * elemental/conditional field records), drops the part from the SubModelPart
 * tree, then removes any nodes left unreferenced.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 */

import { EntityBlock, EntityKind, FieldData, MdpaModel, SubModelPart } from "./types";
import { findSubModelPart } from "./subModelPartExtract";
import { removeOrphanNodes } from "./removeOrphanNodes";

export interface DeleteSubModelPartResult {
  model: MdpaModel;
  /** True when the path matched and something was removed. */
  deleted: boolean;
}

interface RemoveSets {
  elements: Set<number>;
  conditions: Set<number>;
  geometries: Set<number>;
}

function collect(part: SubModelPart, sets: RemoveSets): void {
  for (const id of part.elementIds) sets.elements.add(id);
  for (const id of part.conditionIds) sets.conditions.add(id);
  for (const id of part.geometryIds) sets.geometries.add(id);
  for (const child of part.children) collect(child, sets);
}

function setForKind(sets: RemoveSets, kind: EntityKind): Set<number> {
  return kind === "Elements"
    ? sets.elements
    : kind === "Conditions"
      ? sets.conditions
      : sets.geometries;
}

/** Rebuilds `block` without the entities whose id is in `remove`; undefined if empty. */
function filterBlock(block: EntityBlock, remove: Set<number>): EntityBlock | undefined {
  const rows: number[] = [];
  for (let i = 0; i < block.count; i++) {
    if (!remove.has(block.entityIds[i])) rows.push(i);
  }
  if (rows.length === block.count) return block; // nothing removed from this block
  if (rows.length === 0) return undefined;

  const stride = block.stride;
  const entityIds = new Int32Array(rows.length);
  const propertyIds = block.propertyIds ? new Int32Array(rows.length) : undefined;
  const connectivity = new Int32Array(rows.length * stride);
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r];
    entityIds[r] = block.entityIds[src];
    if (propertyIds && block.propertyIds) propertyIds[r] = block.propertyIds[src];
    connectivity.set(block.connectivity.subarray(src * stride, src * stride + stride), r * stride);
  }
  return { ...block, count: rows.length, entityIds, propertyIds, connectivity };
}

/** Drops field records whose id is in `remove`. */
function filterField(field: FieldData, remove: Set<number>): FieldData {
  const rows: number[] = [];
  for (let i = 0; i < field.ids.length; i++) {
    if (!remove.has(field.ids[i])) rows.push(i);
  }
  if (rows.length === field.ids.length) return field;
  const comps = field.components;
  const ids = new Int32Array(rows.length);
  const values = new Float64Array(rows.length * comps);
  const fixed = field.fixed ? new Uint8Array(rows.length) : undefined;
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r];
    ids[r] = field.ids[src];
    values.set(field.values.subarray(src * comps, src * comps + comps), r * comps);
    if (fixed && field.fixed) fixed[r] = field.fixed[src];
  }
  return { kind: field.kind, variable: field.variable, components: comps, ids, values, fixed };
}

/** Removes the part at `path` from a SubModelPart tree. */
function pruneTree(parts: SubModelPart[], path: string): SubModelPart[] {
  const out: SubModelPart[] = [];
  for (const p of parts) {
    if (p.path === path) continue; // drop this part + its subtree
    out.push({ ...p, children: pruneTree(p.children, path) });
  }
  return out;
}

export function deleteSubModelPart(model: MdpaModel, path: string): DeleteSubModelPartResult {
  const part = findSubModelPart(model, path);
  if (!part) return { model, deleted: false };

  const sets: RemoveSets = {
    elements: new Set<number>(),
    conditions: new Set<number>(),
    geometries: new Set<number>(),
  };
  collect(part, sets);

  const blocks: EntityBlock[] = [];
  for (const block of model.blocks) {
    const kept = filterBlock(block, setForKind(sets, block.kind));
    if (kept) blocks.push(kept);
  }

  const fields = model.fields.map((f) =>
    f.kind === "Elemental"
      ? filterField(f, sets.elements)
      : f.kind === "Conditional"
        ? filterField(f, sets.conditions)
        : f
  );

  const trimmed: MdpaModel = {
    ...model,
    blocks,
    subModelParts: pruneTree(model.subModelParts, path),
    fields,
    diagnostics: [],
  };

  // Nodes left unreferenced by the deletion are cleaned up.
  const { model: cleaned } = removeOrphanNodes(trimmed);
  return { model: cleaned, deleted: true };
}
