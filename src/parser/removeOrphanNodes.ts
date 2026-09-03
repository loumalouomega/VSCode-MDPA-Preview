/**
 * Removes orphan nodes — nodes referenced by no cell connectivity, listed in no
 * SubModelPart node list and named by no constraint — from a mesh.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable,
 * mirroring subModelPartExtract.ts / linearToQuadratic.ts. The input is never
 * mutated; a fresh MdpaModel is returned.
 *
 * MDPA connectivity is id-based, so surviving nodes keep their original ids and
 * the blocks / SubModelParts need no rewiring — only the node arrays and the
 * per-node (Nodal) field records shrink.
 */

import { FieldData, MdpaModel, SubModelPart } from "./types";
import { constraintNodeIds } from "./constraintsParser";
import { nodeIndexMap } from "./writers/writerCommon";

export interface RemoveOrphanNodesResult {
  model: MdpaModel;
  /** How many nodes were dropped. */
  removed: number;
}

/**
 * Every node id referenced by a cell or listed in any SubModelPart.
 *
 * Deliberately **excludes** the nodes a constraint names, and is exported for
 * exactly that reason: the modules that themselves remove nodes (`cropMesh`,
 * `linearize`, `deleteSubModelPart`) need "which nodes does the mesh proper
 * still use" to decide which constraints die, and asking a question that
 * already counts the constraints would answer itself. The ordering rule is that
 * the module removing nodes decides which constraints die first; this module
 * only protects the survivors of that decision.
 */
export function meshUsedNodeIds(model: MdpaModel): Set<number> {
  const used = new Set<number>();
  for (const block of model.blocks) {
    for (const id of block.connectivity) used.add(id);
  }
  const walk = (parts: SubModelPart[]): void => {
    for (const p of parts) {
      for (const id of p.nodeIds) used.add(id);
      walk(p.children);
    }
  };
  walk(model.subModelParts);
  return used;
}

/**
 * `meshUsedNodeIds` plus every node a constraint names.
 *
 * A constrained node has no cell of its own in a legitimate mesh — a master
 * node on a tied interface routinely belongs to the other side only — so
 * without this a Save-then-clean would delete the very node the constraint
 * refers to and leave the constraint dangling. Ids the file never declared are
 * harmless here: survivors are drawn from `model.nodeIds`, and `used` is only
 * ever membership-tested.
 */
function usedNodeIds(model: MdpaModel): Set<number> {
  const used = meshUsedNodeIds(model);
  for (const block of model.constraints ?? []) {
    for (const row of block.rows) {
      for (const id of constraintNodeIds(row)) used.add(id);
    }
  }
  return used;
}

/** Slices a Nodal FieldData down to records whose id is in `keep`. */
function sliceNodalField(field: FieldData, keep: Set<number>): FieldData {
  const rows: number[] = [];
  for (let i = 0; i < field.ids.length; i++) {
    if (keep.has(field.ids[i])) rows.push(i);
  }
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

export function removeOrphanNodes(model: MdpaModel): RemoveOrphanNodesResult {
  const used = usedNodeIds(model);
  if (used.size >= model.nodeCount) {
    return { model, removed: 0 };
  }

  const idx = nodeIndexMap(model);
  const survivors: number[] = [];
  for (let i = 0; i < model.nodeCount; i++) {
    if (used.has(model.nodeIds[i])) survivors.push(model.nodeIds[i]);
  }

  const nodeCount = survivors.length;
  const nodeIds = new Int32Array(nodeCount);
  const coords = new Float32Array(nodeCount * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nodeCount; i++) {
    const id = survivors[i];
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

  const fields = model.fields.map((f) =>
    f.kind === "Nodal" ? sliceNodalField(f, used) : f
  );

  return {
    model: {
      nodeCount,
      nodeIds,
      coords,
      blocks: model.blocks,
      subModelParts: model.subModelParts,
      meta: model.meta,
      properties: model.properties,
      constraints: model.constraints,
      fields,
      diagnostics: [],
      is3D: model.is3D,
      bounds: { min, max },
    },
    removed: model.nodeCount - nodeCount,
  };
}
