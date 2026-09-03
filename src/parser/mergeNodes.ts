/**
 * Merges coincident nodes — nodes whose coordinates fall in the same
 * tolerance-sized grid cell are welded into one (the lowest id in the group is
 * the representative), and all connectivity / SubModelPart / nodal-field
 * references are rewired to it.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned. Uses the same spatial
 * grid-hash idea as the STL vertex welding in stlParser.ts.
 */

import { EntityBlock, FieldData, MdpaModel, SubModelPart } from "./types";
import {
  definedConstraintIds,
  mapConstraintNodes,
  pruneSubModelPartConstraints,
} from "./constraintsParser";
import { nodeIndexMap } from "./writers/writerCommon";

export interface MergeNodesResult {
  model: MdpaModel;
  /** How many nodes were welded away. */
  merged: number;
  /** Constraints dropped because welding made them self-referential. */
  constraintsDropped: number;
}

export function mergeNodes(model: MdpaModel, tolerance: number): MergeNodesResult {
  const tol = tolerance > 0 ? tolerance : 1e-6;
  const idx = nodeIndexMap(model);

  // Group nodes by rounded-coordinate key; representative = lowest id in group.
  const rep = new Map<number, number>(); // oldId → representative id
  const groupRep = new Map<string, number>();
  for (let i = 0; i < model.nodeCount; i++) {
    const id = model.nodeIds[i];
    const s = i * 3;
    const key =
      `${Math.round(model.coords[s] / tol)}:` +
      `${Math.round(model.coords[s + 1] / tol)}:` +
      `${Math.round(model.coords[s + 2] / tol)}`;
    const existing = groupRep.get(key);
    if (existing === undefined) {
      groupRep.set(key, id);
      rep.set(id, id);
    } else {
      const r = Math.min(existing, id);
      groupRep.set(key, r);
      rep.set(id, r);
    }
  }
  // A group's representative might have been lowered after earlier members were
  // recorded; resolve every node to the final group representative.
  const resolve = (id: number): number => {
    let r = rep.get(id)!;
    while (rep.get(r)! !== r) r = rep.get(r)!;
    return r;
  };

  const merged = model.nodeCount - new Set([...model.nodeIds].map(resolve)).size;
  if (merged === 0) return { model, merged: 0, constraintsDropped: 0 };

  // Surviving nodes = the representatives, in original order.
  const survivors: number[] = [];
  const isSurvivor = new Set<number>();
  for (let i = 0; i < model.nodeCount; i++) {
    const id = model.nodeIds[i];
    if (resolve(id) === id && !isSurvivor.has(id)) {
      isSurvivor.add(id);
      survivors.push(id);
    }
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

  // Rewire block connectivity to representatives.
  const blocks: EntityBlock[] = model.blocks.map((b) => {
    const connectivity = new Int32Array(b.connectivity.length);
    for (let i = 0; i < b.connectivity.length; i++) {
      connectivity[i] = resolve(b.connectivity[i]);
    }
    return { ...b, connectivity };
  });

  // Rewire SubModelPart node lists (dedupe after remap).
  const remapPart = (p: SubModelPart): SubModelPart => {
    const seen = new Set<number>();
    const ids: number[] = [];
    for (const id of p.nodeIds) {
      const r = resolve(id);
      if (!seen.has(r)) {
        seen.add(r);
        ids.push(r);
      }
    }
    return { ...p, nodeIds: Int32Array.from(ids), children: p.children.map(remapPart) };
  };
  const subModelParts = model.subModelParts.map(remapPart);

  // Collapse nodal fields onto representatives (a representative's own record
  // wins over a merged member's).
  const fields = model.fields.map((f) => (f.kind === "Nodal" ? collapseField(f, resolve) : f));

  // Constraints follow the weld like connectivity does, with one extra rule:
  // once a constraint's slave and one of its masters resolve to the SAME node
  // it constrains a node against itself, which is meaningless to Kratos — so it
  // is dropped and its id pruned from every SubModelPart that listed it, rather
  // than written out as a degenerate row. Duplicated masters are deliberately
  // left alone: summing their weights would be this extension inventing
  // numbers the file never contained.
  let constraints = model.constraints;
  let constraintsDropped = 0;
  let parts = subModelParts;
  if (constraints) {
    const welded = mapConstraintNodes(constraints, resolve).blocks;
    const kept: typeof welded = [];
    for (const block of welded) {
      const rows = block.rows.filter((r) => {
        if (r.kind === "raw") return true;
        const slaves = new Set(r.slaveIds);
        const degenerate = r.masterIds.some((m) => slaves.has(m));
        if (degenerate) constraintsDropped++;
        return !degenerate;
      });
      if (rows.length > 0) kept.push({ name: block.name, variables: block.variables, rows });
    }
    constraints = kept.length > 0 ? kept : undefined;
    if (constraintsDropped > 0) {
      const keep = new Set(definedConstraintIds(constraints));
      parts = pruneSubModelPartConstraints(parts, keep).parts;
    }
  }

  return {
    model: {
      nodeCount,
      nodeIds,
      coords,
      blocks,
      subModelParts: parts,
      meta: model.meta,
      properties: model.properties,
      constraints,
      fields,
      diagnostics: [],
      is3D: model.is3D,
      bounds: { min, max },
    },
    merged,
    constraintsDropped,
  };
}

function collapseField(field: FieldData, resolve: (id: number) => number): FieldData {
  const comps = field.components;
  const chosen = new Map<number, { vals: number[]; fixed?: number }>();
  for (let i = 0; i < field.ids.length; i++) {
    const orig = field.ids[i];
    const r = resolve(orig);
    const vals = [...field.values.subarray(i * comps, i * comps + comps)];
    const fixed = field.fixed ? field.fixed[i] : undefined;
    if (r === orig || !chosen.has(r)) chosen.set(r, { vals, fixed });
  }
  const ids = new Int32Array(chosen.size);
  const values = new Float64Array(chosen.size * comps);
  const fixedArr = field.fixed ? new Uint8Array(chosen.size) : undefined;
  let r = 0;
  for (const [id, rec] of chosen) {
    ids[r] = id;
    values.set(rec.vals, r * comps);
    if (fixedArr) fixedArr[r] = rec.fixed ?? 0;
    r++;
  }
  return { kind: field.kind, variable: field.variable, components: comps, ids, values, fixed: fixedArr };
}
