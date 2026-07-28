/**
 * Merges a second mesh into the current one: appends its nodes and cells with
 * ids offset past the current model's own, adds one SubModelPart naming the
 * merged-in geometry, and optionally welds coincident nodes across the seam.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * The offsetting is the same idea `vtkMultiblock.ts`'s `parseVtm` already uses
 * to combine several files into one scene (nodes/entities offset past what
 * came before, fields concatenated by (kind, variable), one SubModelPart per
 * source) — this is that merge exposed as a mesh operation instead of a
 * multiblock-file reader. Welding reuses `mergeNodes.ts` OUTRIGHT rather than
 * reimplementing its tolerance grid: once the two node sets are concatenated
 * into one model, "weld coincident nodes across the seam" and "weld
 * coincident nodes" are the same problem.
 */

import { EntityBlock, FieldData, MdpaModel, SubModelPart } from "./types";
import { mergeNodes } from "./mergeNodes";

export interface MergeMeshParams {
  /** Weld nodes that coincide across the seam (reuses mergeNodes' grid). */
  weld?: boolean;
  tolerance?: number;
  /** Name for the SubModelPart wrapping the merged-in geometry. */
  name?: string;
}

export interface MergeMeshResult {
  model: MdpaModel;
  addedNodes: number;
  addedCells: number;
  /** Nodes welded away across the seam (0 unless `weld` was set). */
  welded: number;
}

function offsetPart(part: SubModelPart, nodeOffset: number, entityOffset: number): SubModelPart {
  return {
    ...part,
    nodeIds: part.nodeIds.map((id) => id + nodeOffset),
    elementIds: part.elementIds.map((id) => id + entityOffset),
    conditionIds: part.conditionIds.map((id) => id + entityOffset),
    geometryIds: part.geometryIds.map((id) => id + entityOffset),
    children: part.children.map((c) => offsetPart(c, nodeOffset, entityOffset)),
  };
}

export function mergeModels(
  base: MdpaModel,
  other: MdpaModel,
  params: MergeMeshParams = {}
): MergeMeshResult {
  if (other.nodeCount === 0 && other.blocks.every((b) => b.count === 0)) {
    return { model: base, addedNodes: 0, addedCells: 0, welded: 0 };
  }

  // Ids in `other` start past whatever is already used in `base` — entity ids
  // and node ids are offset independently, exactly as a multiblock merge does.
  const nodeOffset = maxId(base.nodeIds);
  const entityOffset = maxEntityId(base);

  const nodeIds = Int32Array.from([...base.nodeIds, ...Array.from(other.nodeIds, (id) => id + nodeOffset)]);
  const coords = Float32Array.from([...base.coords, ...other.coords]);

  const offsetBlocks: EntityBlock[] = other.blocks.map((b) => ({
    ...b,
    entityIds: b.entityIds.map((id) => id + entityOffset),
    connectivity: b.connectivity.map((id) => id + nodeOffset),
  }));
  const blocks = [...base.blocks, ...offsetBlocks];

  const offsetFields: FieldData[] = other.fields.map((f) => ({
    ...f,
    ids: f.ids.map((id) => (f.kind === "Nodal" ? id + nodeOffset : id + entityOffset)),
  }));
  // Same (kind, variable) present on both sides simply concatenates — matches
  // parseVtm's field-merge rule, and keeps the field usable across the whole
  // combined mesh rather than only where it happened to originate.
  const fields = [...base.fields];
  for (const of of offsetFields) {
    const existing = fields.find((f) => f.kind === of.kind && f.variable === of.variable);
    if (existing && existing.components === of.components) {
      const idx = fields.indexOf(existing);
      fields[idx] = {
        ...existing,
        ids: Int32Array.from([...existing.ids, ...of.ids]),
        values: Float64Array.from([...existing.values, ...of.values]),
      };
    } else {
      fields.push(of);
    }
  }

  const wrapperName = params.name ?? "MergedMesh";
  const wrapper: SubModelPart = {
    name: wrapperName,
    path: wrapperName,
    nodeIds: Int32Array.from(other.nodeIds, (id) => id + nodeOffset),
    elementIds: Int32Array.from(
      other.blocks.filter((b) => b.kind === "Elements").flatMap((b) => Array.from(b.entityIds, (id) => id + entityOffset))
    ),
    conditionIds: Int32Array.from(
      other.blocks.filter((b) => b.kind === "Conditions").flatMap((b) => Array.from(b.entityIds, (id) => id + entityOffset))
    ),
    geometryIds: Int32Array.from(
      other.blocks.filter((b) => b.kind === "Geometries").flatMap((b) => Array.from(b.entityIds, (id) => id + entityOffset))
    ),
    constraintIds: new Int32Array(0),
    children: other.subModelParts.map((p) => offsetPart(p, nodeOffset, entityOffset)),
  };

  const min: [number, number, number] = [
    Math.min(base.bounds.min[0], other.bounds.min[0]),
    Math.min(base.bounds.min[1], other.bounds.min[1]),
    Math.min(base.bounds.min[2], other.bounds.min[2]),
  ];
  const max: [number, number, number] = [
    Math.max(base.bounds.max[0], other.bounds.max[0]),
    Math.max(base.bounds.max[1], other.bounds.max[1]),
    Math.max(base.bounds.max[2], other.bounds.max[2]),
  ];

  const merged: MdpaModel = {
    nodeCount: nodeIds.length,
    nodeIds,
    coords,
    blocks,
    subModelParts: [...base.subModelParts, wrapper],
    meta: base.meta,
    fields,
    diagnostics: [],
    is3D: base.is3D || other.is3D,
    bounds: { min, max },
  };

  if (!params.weld) {
    return { model: merged, addedNodes: other.nodeCount, addedCells: other.blocks.reduce((n, b) => n + b.count, 0), welded: 0 };
  }

  const { model: welded, merged: weldedCount } = mergeNodes(merged, params.tolerance ?? 1e-6);
  return {
    model: welded,
    addedNodes: other.nodeCount - weldedCount,
    addedCells: other.blocks.reduce((n, b) => n + b.count, 0),
    welded: weldedCount,
  };
}

function maxId(ids: Int32Array): number {
  let max = 0;
  for (const id of ids) if (id > max) max = id;
  return max;
}

function maxEntityId(model: MdpaModel): number {
  let max = 0;
  for (const b of model.blocks) for (const id of b.entityIds) if (id > max) max = id;
  return max;
}
