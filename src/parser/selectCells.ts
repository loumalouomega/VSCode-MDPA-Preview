/**
 * Restrict a mesh to a chosen set of Elements, keeping everything that follows
 * from that choice: original entity ids, the Conditions and Geometries that
 * still lie on what remains, the fields, the SubModelParts (narrowed) and the
 * constraints whose nodes all survive.
 *
 * Pure module (no vscode / DOM / wasm). The structural sibling of
 * `cropMesh.ts` — the same `sliceBlock`/`sliceField` rebuild and the same
 * "decide which constraints die first, then remove orphans" order — but driven
 * by an explicit element selection (a threshold, later a selection set) rather
 * than a geometric test, so nothing is renumbered and the result stays
 * addressable by the ids the source file used.
 */

import { EntityKind, MdpaModel, SubModelPart } from "./types";
import { sliceBlock, sliceField } from "./subModelPartExtract";
import { removeOrphanNodes } from "./removeOrphanNodes";
import { definedConstraintIds, filterConstraintsByNode } from "./constraintsParser";
import { decompositionFor } from "./cellDecomposition";
import { cellCategory } from "./writers/writerCommon";

export interface SelectCellsResult {
  model: MdpaModel;
  keptElements: number;
  keptConditions: number;
  droppedElements: number;
  droppedConstraints: number;
}

/**
 * `keepElements` are entity ids in the ELEMENTS id space. A Condition or
 * Geometry is kept when every node it names is still used by a kept element
 * (a boundary condition on the retained region stays; one on the discarded part
 * does not).
 */
export function restrictToElements(model: MdpaModel, keepElements: ReadonlySet<number>): SelectCellsResult {
  const usedNodes = new Set<number>();
  let droppedElements = 0;
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      if (keepElements.has(b.entityIds[c])) {
        for (let k = 0; k < b.stride; k++) usedNodes.add(b.connectivity[c * b.stride + k]);
      } else droppedElements++;
    }
  }
  const keep: Record<EntityKind, Set<number>> = {
    Elements: new Set(keepElements),
    Conditions: new Set(),
    Geometries: new Set(),
  };
  for (const b of model.blocks) {
    if (b.kind === "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      let all = true;
      for (let k = 0; k < b.stride && all; k++) all = usedNodes.has(b.connectivity[c * b.stride + k]);
      if (all) keep[b.kind].add(b.entityIds[c]);
    }
  }

  const blocks = model.blocks.map((b) => sliceBlock(b, keep[b.kind])).filter((b) => b !== undefined);
  const fields = model.fields
    .map((f) => (f.kind === "Nodal" ? f : sliceField(f, f.kind === "Conditional" ? keep.Conditions : keep.Elements)))
    .filter((f) => f !== undefined);

  // A constraint survives only when every node it names does. Decided HERE,
  // before removeOrphanNodes (which counts a constrained node as used).
  const { blocks: constraints, droppedIds } = filterConstraintsByNode(model.constraints, (id) => usedNodes.has(id));
  const keepConstraints = new Set(definedConstraintIds(constraints));
  const filterPart = (p: SubModelPart): SubModelPart => ({
    ...p,
    nodeIds: p.nodeIds.filter((id) => usedNodes.has(id)),
    elementIds: p.elementIds.filter((id) => keep.Elements.has(id)),
    conditionIds: p.conditionIds.filter((id) => keep.Conditions.has(id)),
    geometryIds: p.geometryIds.filter((id) => keep.Geometries.has(id)),
    constraintIds: model.constraints ? p.constraintIds.filter((id) => keepConstraints.has(id)) : p.constraintIds,
    children: p.children.map(filterPart),
  });
  const restricted: MdpaModel = {
    ...model,
    blocks,
    fields,
    constraints,
    subModelParts: model.subModelParts.map(filterPart),
  };
  const { model: cleaned } = removeOrphanNodes(restricted);
  return {
    model: cleaned,
    keptElements: keep.Elements.size,
    keptConditions: keep.Conditions.size,
    droppedElements,
    droppedConstraints: droppedIds.length,
  };
}

/** Measure (length / area / volume) of every Element of the mesh's top dimension, by id. */
export function elementMeasures(model: MdpaModel): { measure: Map<number, number>; dimension: 1 | 2 | 3 | 0 } {
  const measure = new Map<number, number>();
  const idx = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) idx.set(model.nodeIds[i], i);
  const p = (id: number): [number, number, number] => {
    const i = idx.get(id)!;
    return [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
  };
  let dimension: 0 | 1 | 2 | 3 = 0;
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    const cat = cellCategory(b.vtkCellType);
    dimension = Math.max(dimension, cat === "volume" ? 3 : cat === "surface" ? 2 : cat === "line" ? 1 : 0) as 0 | 1 | 2 | 3;
  }
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    const cat = cellCategory(b.vtkCellType);
    const d = cat === "volume" ? 3 : cat === "surface" ? 2 : cat === "line" ? 1 : 0;
    if (d !== dimension || d === 0) continue;
    const dec = decompositionFor(b.vtkCellType);
    for (let c = 0; c < b.count; c++) {
      const ids = Array.from(b.connectivity.subarray(c * b.stride, c * b.stride + (dec.corners || b.stride)));
      if (ids.some((id) => !idx.has(id))) continue;
      let m = 0;
      if (d === 3 && dec.tets) {
        for (const t of dec.tets) {
          const [a, bb, cc, dd] = t.map((k) => p(ids[k]));
          const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]];
          const v = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
          const w = [dd[0] - a[0], dd[1] - a[1], dd[2] - a[2]];
          m += Math.abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
        }
      } else if (d === 2 && dec.tris) {
        for (const t of dec.tris) {
          const [a, bb, cc] = t.map((k) => p(ids[k]));
          const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]];
          const v = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
          m += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        }
      } else if (d === 1) {
        const a = p(ids[0]);
        const bb = p(ids[1]);
        m = Math.hypot(bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]);
      }
      measure.set(b.entityIds[c], m);
    }
  }
  return { measure, dimension };
}
