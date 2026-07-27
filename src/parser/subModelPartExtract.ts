/**
 * Slices a single SubModelPart (and, by default, its whole descendant subtree)
 * out of an `MdpaModel` into a fresh standalone `MdpaModel` that can be handed to
 * the writer layer (`writeMeshFile`) to export the part on its own.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 *
 * SubModelParts store entity **ids only** — the connectivity lives on
 * `model.blocks`.  So the slice joins the part's id-lists against every block,
 * copies the matching entities, then derives the referenced node set (connectivity
 * closure ∪ the part's own listed nodes) and rebuilds the node arrays.  MDPA
 * connectivity is id-based, so node ids are preserved verbatim — no renumbering.
 */

import {
  EntityBlock,
  EntityKind,
  FieldData,
  MdpaModel,
  SubModelPart,
} from "./types";
import { nodeIndexMap } from "./writers/writerCommon";

/** Depth-first lookup of a SubModelPart by its dotted `path`. */
export function findSubModelPart(
  model: MdpaModel,
  path: string
): SubModelPart | undefined {
  const walk = (parts: SubModelPart[]): SubModelPart | undefined => {
    for (const p of parts) {
      if (p.path === path) return p;
      const hit = walk(p.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(model.subModelParts);
}

interface IdSets {
  elements: Set<number>;
  conditions: Set<number>;
  geometries: Set<number>;
  nodes: Set<number>;
}

/** Recursively unions a part's + descendants' entity/node ids into `sets`. */
function collectIds(part: SubModelPart, sets: IdSets): void {
  for (const id of part.elementIds) sets.elements.add(id);
  for (const id of part.conditionIds) sets.conditions.add(id);
  for (const id of part.geometryIds) sets.geometries.add(id);
  for (const id of part.nodeIds) sets.nodes.add(id);
  for (const child of part.children) collectIds(child, sets);
}

function setForKind(sets: IdSets, kind: EntityKind): Set<number> {
  return kind === "Elements"
    ? sets.elements
    : kind === "Conditions"
      ? sets.conditions
      : sets.geometries;
}

/** Slices `block` down to entities whose id is in `keep`, or undefined if none. */
function sliceBlock(block: EntityBlock, keep: Set<number>): EntityBlock | undefined {
  const rows: number[] = [];
  for (let i = 0; i < block.count; i++) {
    if (keep.has(block.entityIds[i])) rows.push(i);
  }
  if (rows.length === 0) return undefined;

  const stride = block.stride;
  const entityIds = new Int32Array(rows.length);
  const propertyIds = block.propertyIds ? new Int32Array(rows.length) : undefined;
  const connectivity = new Int32Array(rows.length * stride);
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r];
    entityIds[r] = block.entityIds[src];
    if (propertyIds && block.propertyIds) propertyIds[r] = block.propertyIds[src];
    connectivity.set(
      block.connectivity.subarray(src * stride, src * stride + stride),
      r * stride
    );
  }
  return {
    kind: block.kind,
    name: block.name,
    vtkCellType: block.vtkCellType,
    count: rows.length,
    stride,
    entityIds,
    propertyIds,
    connectivity,
  };
}

/** Slices a FieldData down to records whose id is in `keep`, or undefined. */
/**
 * Rebuilds a field from a list of surviving ROW indices.
 *
 * The `fixed` flags are re-sliced alongside `ids`/`values` — carrying the
 * original-length array next to shortened ones is the invariant every caller
 * has to preserve, so it lives here rather than in each of them.
 */
export function sliceFieldRows(field: FieldData, rows: number[]): FieldData {
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

function sliceField(field: FieldData, keep: Set<number>): FieldData | undefined {
  const rows: number[] = [];
  for (let i = 0; i < field.ids.length; i++) {
    if (keep.has(field.ids[i])) rows.push(i);
  }
  return rows.length === 0 ? undefined : sliceFieldRows(field, rows);
}

/** Re-roots `part` so its `path` becomes just its own name (descendants rebased). */
function reroot(part: SubModelPart, parentPath: string): SubModelPart {
  const path = parentPath ? `${parentPath}/${part.name}` : part.name;
  return {
    name: part.name,
    nodeIds: part.nodeIds,
    elementIds: part.elementIds,
    conditionIds: part.conditionIds,
    geometryIds: part.geometryIds,
    constraintIds: part.constraintIds,
    path,
    children: part.children.map((c) => reroot(c, path)),
  };
}

/**
 * Builds a standalone `MdpaModel` containing only the SubModelPart at `path`
 * (including its descendant subtree).  Returns undefined if no such part exists.
 */
export function extractSubModelPart(
  model: MdpaModel,
  path: string
): MdpaModel | undefined {
  const part = findSubModelPart(model, path);
  if (!part) return undefined;

  const sets: IdSets = {
    elements: new Set<number>(),
    conditions: new Set<number>(),
    geometries: new Set<number>(),
    nodes: new Set<number>(),
  };
  collectIds(part, sets);

  // Slice the geometry blocks.
  const blocks: EntityBlock[] = [];
  for (const block of model.blocks) {
    const kept = sliceBlock(block, setForKind(sets, block.kind));
    if (kept) blocks.push(kept);
  }

  // Node closure: every node referenced by a kept cell, plus the part's own nodes.
  const keptNodes = new Set<number>(sets.nodes);
  for (const block of blocks) {
    for (const id of block.connectivity) keptNodes.add(id);
  }

  // Rebuild node arrays in the source model's order, keeping original ids.
  const idx = nodeIndexMap(model);
  const orderedNodeIds: number[] = [];
  for (let i = 0; i < model.nodeCount; i++) {
    if (keptNodes.has(model.nodeIds[i])) orderedNodeIds.push(model.nodeIds[i]);
  }
  const nodeCount = orderedNodeIds.length;
  const nodeIds = new Int32Array(nodeCount);
  const coords = new Float32Array(nodeCount * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nodeCount; i++) {
    const id = orderedNodeIds[i];
    nodeIds[i] = id;
    const s = idx.get(id)! * 3;
    for (let k = 0; k < 3; k++) {
      const v = model.coords[s + k];
      coords[i * 3 + k] = v;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (nodeCount === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  // Slice fields (Nodal → node set, Elemental/Conditional → entity set).
  const fields: FieldData[] = [];
  for (const field of model.fields) {
    const keep =
      field.kind === "Nodal"
        ? keptNodes
        : field.kind === "Elemental"
          ? sets.elements
          : sets.conditions;
    const sliced = sliceField(field, keep);
    if (sliced) fields.push(sliced);
  }

  return {
    nodeCount,
    nodeIds,
    coords,
    blocks,
    subModelParts: [reroot(part, "")],
    meta: [],
    fields,
    diagnostics: [],
    is3D: model.is3D,
    bounds: { min, max },
  };
}
