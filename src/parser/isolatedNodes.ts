/**
 * Isolated nodes — nodes referenced by no cell connectivity.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable and
 * importable from both runtimes (same arrangement as smpMembership.ts).
 *
 * This is deliberately connectivity-only: a node listed in a SubModelPart (or
 * named by a constraint) but in no block connectivity IS isolated here. That
 * differs from `meshUsedNodeIds` in removeOrphanNodes.ts, which unions the
 * SubModelPart lists (and, via `usedNodeIds`, the constraints) to answer the
 * coarser "can this node be deleted" question. The two definitions coexist:
 * removal must not strand parts/constraints, while this highlight must show
 * exactly the nodes with no geometry — including the node-only SubModelPart
 * case that motivated it.
 */

import type { MdpaModel } from "./types";

/**
 * Ids of `model.nodeIds` referenced by no block connectivity, in model order.
 * Ids the file never declared (dangling connectivity entries) are harmless:
 * membership is only ever tested against `model.nodeIds`.
 */
export function findIsolatedNodeIds(model: MdpaModel): number[] {
  const used = new Set<number>();
  for (const block of model.blocks) {
    for (const id of block.connectivity) used.add(id);
  }
  const out: number[] = [];
  for (const id of model.nodeIds) {
    if (!used.has(id)) out.push(id);
  }
  return out;
}
