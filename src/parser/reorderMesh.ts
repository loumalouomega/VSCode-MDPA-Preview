/**
 * Node renumbering — reduces the bandwidth of the system matrix a solver will
 * assemble from this mesh, or improves cache locality. Backed by meshio++'s
 * `reorder`, used strictly as an oracle.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. The input is
 * never mutated; a fresh MdpaModel is returned.
 *
 * ## Why the permutation, and not the mesh
 *
 * `reorder` returns both a renumbered mesh AND the permutation that produced
 * it. We take only the permutation and apply it to our own model. That is not a
 * stylistic choice: adopting its mesh would mean a round-trip through
 * meshioConvert, which emits no `regions` and would therefore destroy every
 * SubModelPart — along with the Conditions/Geometries distinction, `propertyIds`
 * and every entity id. Applying a permutation ourselves touches none of that.
 *
 * What actually changes is only WHICH NODE ID sits at which position:
 *   - `nodeIds[newIndex]` keeps the same *id* the old node had, so SubModelPart
 *     node lists, Nodal field records and block connectivity — all of which are
 *     keyed by id, not by index — remain valid untouched.
 *   - `coords` are permuted to match.
 *
 * In other words the reordering is a pure relabelling of storage order. That is
 * exactly what a solver's assembly loop reads, and it is invisible to everything
 * in this extension that addresses entities by id.
 *
 * ⚠️ A `.mdpa` written from the result lists nodes in the new order but keeps
 * their original ids, which is the useful outcome (Kratos reads ids). Renumbering
 * the ids themselves would invalidate every SubModelPart and field record in the
 * file, so it is deliberately not done here.
 */

import { MdpaModel, MdpaDiagnostic } from "./types";
import { modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";

/**
 * `rcm` — Reverse Cuthill–McKee over the node adjacency graph; minimizes matrix
 * bandwidth, which is the one that matters for a direct solver.
 * `morton` / `hilbert` — space-filling curve over the coordinates; optimizes
 * cache locality rather than bandwidth (`hilbert` is the better of the two).
 */
export type ReorderMethod = "rcm" | "morton" | "hilbert";

export const REORDER_METHODS: readonly ReorderMethod[] = ["rcm", "morton", "hilbert"];

export interface ReorderResult {
  model: MdpaModel;
  /** Matrix bandwidth before and after; equal when nothing improved. */
  bandwidthBefore: number;
  bandwidthAfter: number;
  /** Nodes whose storage position changed. */
  moved: number;
}

export async function reorderModel(
  model: MdpaModel,
  method: ReorderMethod = "rcm",
  diagnostics: MdpaDiagnostic[] = []
): Promise<ReorderResult> {
  const unchanged: ReorderResult = {
    model,
    bandwidthBefore: 0,
    bandwidthAfter: 0,
    moved: 0,
  };
  if (model.nodeCount === 0) return unchanged;

  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return unchanged; // nothing to be adjacent through

  const m = await loadMeshio();
  const bandwidthBefore = m.computeBandwidth(mesh);
  const r = m.reorder(mesh, method);
  const perm = r.nodePermutation;

  if (perm.length !== model.nodeCount) {
    throw new Error(
      `reorder returned a permutation of ${perm.length} for ${model.nodeCount} nodes; ` +
        `the result was discarded.`
    );
  }

  // `perm` is old -> new: new_points[perm[i]] === old_points[i].
  const nodeIds = new Int32Array(model.nodeCount);
  const coords = new Float32Array(model.nodeCount * 3);
  let moved = 0;
  for (let oldIdx = 0; oldIdx < model.nodeCount; oldIdx++) {
    const newIdx = perm[oldIdx];
    if (newIdx !== oldIdx) moved++;
    nodeIds[newIdx] = model.nodeIds[oldIdx];
    for (let k = 0; k < 3; k++) coords[newIdx * 3 + k] = model.coords[oldIdx * 3 + k];
  }

  return {
    model: { ...model, nodeIds, coords },
    bandwidthBefore,
    bandwidthAfter: m.computeBandwidth(r.mesh),
    moved,
  };
}
