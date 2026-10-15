/**
 * Point-load conditions for a coupled load interface (roadmap item 16).
 *
 * A CoSimulation structure participant receives the fluid REACTION as a mapped
 * nodal POINT_LOAD. A load is assembled only where a condition reads it, and
 * the interface face of the structural slice carries its surface load
 * condition (`SurfaceLoadCondition3D3N`, reading PRESSURE / SURFACE_LOAD): the
 * mapped POINT_LOAD reaches the nodes but nothing consumes it, so the
 * structure solves with an unchanged right-hand side. This module re-emits the
 * interface nodes as one-node `PointLoadCondition2D1N` / `3D1N` conditions in a
 * SIBLING SubModelPart (`<part>PointLoad`).
 *
 * The sibling is not cosmetic. The coupled document keeps naming the original
 * surface part as the mapping destination; the point conditions only give the
 * transferred values a consumer. Adding the one-node conditions to the surface
 * part itself mixes cells and points in the ModelPart the `kratos_mapping`
 * operator builds its interface from, and the displacement transfer then fails
 * (verified by hand against Kratos 10.4.2/10.4.3) — the pure surface part and
 * the point sibling keep both transfer directions intact.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable.
 */

import { EntityBlock, MdpaModel, SubModelPart } from "../parser/types";
import { findSubModelPart } from "../parser/subModelPartExtract";

export interface PointLoadInterfaceResult {
  model: MdpaModel;
  added: { path: string; nodes: number; conditions: number }[];
  warnings: string[];
}

/** The sibling part of `path` gets this suffix (`Interface` → `InterfacePointLoad`). */
const SIBLING_SUFFIX = "PointLoad";

const parentPathOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * The interface nodes: the part's own node list, or (a part that lists only
 * conditions) the union of its conditions' connectivity. Direct membership
 * only — that is exactly the node set the coupling writes to.
 */
function nodesOf(part: SubModelPart, byId: Map<number, number[]>): number[] {
  const seen = new Set<number>(part.nodeIds);
  if (!seen.size) {
    for (const id of part.conditionIds) for (const node of byId.get(id) ?? []) seen.add(node);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Inserts `sibling` under `parentPath` ("" = top level) without mutating the tree. */
function insertUnder(parts: SubModelPart[], parentPath: string, sibling: SubModelPart): SubModelPart[] {
  if (parentPath === "") return [...parts, sibling];
  return parts.map((p) =>
    p.path === parentPath
      ? { ...p, children: [...p.children, sibling] }
      : { ...p, children: insertUnder(p.children, parentPath, sibling) }
  );
}

/**
 * Emits one point condition per node of each `paths` interface SubModelPart
 * into a sibling part of the same name plus `PointLoad`. Unknown paths warn
 * and are skipped; an existing sibling (a re-run) is left untouched.
 */
export function addInterfacePointLoads(
  model: MdpaModel,
  paths: string[],
  domainSize: 2 | 3
): PointLoadInterfaceResult {
  const conditionType = `PointLoadCondition${domainSize}D1N`;
  const warnings: string[] = [];
  const added: PointLoadInterfaceResult["added"] = [];
  let output = model;
  let blocks: EntityBlock[] = model.blocks;
  let parts = model.subModelParts;
  let nextId = 1;
  for (const block of model.blocks) {
    if (block.kind !== "Conditions") continue;
    for (const id of block.entityIds) nextId = Math.max(nextId, id + 1);
  }
  const byId = new Map<number, number[]>();
  for (const block of model.blocks) {
    if (block.kind !== "Conditions") continue;
    for (let c = 0; c < block.count; c++) {
      byId.set(block.entityIds[c], [...block.connectivity.subarray(c * block.stride, (c + 1) * block.stride)]);
    }
  }

  for (const path of [...new Set(paths)]) {
    const part = findSubModelPart(output, path);
    if (!part) {
      warnings.push(`The load interface "${path}" is not in this mesh slice, so no point conditions were emitted for it.`);
      continue;
    }
    const siblingPath = `${parentPathOf(path) ? `${parentPathOf(path)}/` : ""}${part.name}${SIBLING_SUFFIX}`;
    if (findSubModelPart(output, siblingPath)) continue;
    const nodes = nodesOf(part, byId);
    if (!nodes.length) {
      warnings.push(`The load interface "${path}" holds no nodes, so no point conditions were emitted for it.`);
      continue;
    }
    const entityIds = new Int32Array(nodes.length);
    const propertyIds = new Int32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) entityIds[i] = nextId++;
    blocks = [
      ...blocks,
      {
        kind: "Conditions",
        name: conditionType,
        count: nodes.length,
        stride: 1,
        entityIds,
        propertyIds,
        connectivity: Int32Array.from(nodes),
      },
    ];
    parts = insertUnder(parts, parentPathOf(path), {
      name: `${part.name}${SIBLING_SUFFIX}`,
      nodeIds: Int32Array.from(nodes),
      elementIds: new Int32Array(0),
      conditionIds: entityIds,
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      path: siblingPath,
      children: [],
    });
    output = { ...output, blocks, subModelParts: parts };
    added.push({ path: siblingPath, nodes: nodes.length, conditions: nodes.length });
  }
  if (!added.length) return { model, added, warnings };
  return { model: output, added, warnings };
}
