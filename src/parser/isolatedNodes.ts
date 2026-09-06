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

/**
 * Ids of `nodeIds` referenced by no cell in `cells`, in `nodeIds` order.
 *
 * The per-SubModelPart counterpart of `findIsolatedNodeIds`: a node that IS
 * used somewhere in the main mesh but by no cell of this part is isolated
 * *within the part* — invisible today, since the global pass only sees the
 * whole-model connectivity. The caller passes the part's own cells (the layer
 * it will actually draw, including node-set-induced cells); point cells
 * (`cellType === undefined`, single-node) never count as coverage, since they
 * are the rendering of isolation itself, not geometry that resolves it.
 */
export function findIsolatedNodeIdsInScope(
  nodeIds: ArrayLike<number>,
  cells: Array<{ cellType?: unknown; nodeIds: ArrayLike<number> }>
): number[] {
  const used = new Set<number>();
  for (const cell of cells) {
    // Point cells (cellType === undefined) are the rendering of isolation
    // itself, not geometry that resolves it. A one-node cell WITH a type
    // (VTK_VERTEX particle) is real geometry and does count as coverage.
    if (cell.cellType === undefined) continue;
    for (let i = 0; i < cell.nodeIds.length; i++) used.add(cell.nodeIds[i]);
  }
  const out: number[] = [];
  for (let i = 0; i < nodeIds.length; i++) {
    if (!used.has(nodeIds[i])) out.push(nodeIds[i]);
  }
  return out;
}
