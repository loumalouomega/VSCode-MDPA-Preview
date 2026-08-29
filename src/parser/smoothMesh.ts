/**
 * Mesh smoothing — relaxes node positions to improve element shape without
 * changing topology. Backed by meshio++'s `smooth`.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. The input is
 * never mutated; a fresh MdpaModel is returned.
 *
 * ## Why this only sends geometry, and only takes coordinates back
 *
 * A meshio++ operation returns a whole mesh, and routing our model out and back
 * through meshioConvert is badly lossy: `modelToMeshio` emits no `regions`, so
 * every SubModelPart would be destroyed, and the return trip also collapses
 * Conditions/Geometries into Elements, drops `propertyIds`, renumbers every id
 * and renames every block.
 *
 * Smoothing is the one case where none of that has to happen. `smooth` moves
 * points and touches nothing else: the point count, their order, the cell
 * blocks, the connectivity and every data array come back untouched. So this
 * module uses meshio++ as an ORACLE — it asks only "where should the nodes be?"
 * and copies the answer onto a clone of our own model. Nothing else crosses
 * back, so SubModelParts, ids, kinds, properties and fields are preserved by
 * construction rather than by repair.
 *
 * The one invariant that makes it work is the point ORDER, which is why the
 * result is rejected if the returned point count does not match.
 */

import { MdpaModel, MdpaDiagnostic } from "./types";
import { modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";

export type SmoothMethod = "taubin" | "laplacian" | "odt";

export interface SmoothParams {
  /**
   * `taubin` (default) alternates a shrink and an anti-shrink pass, so a closed
   * surface keeps its volume. `laplacian` is stronger per pass but shrinks
   * without bound — run to convergence it collapses a closed surface to a point.
   *
   * `odt` (meshio++ >= 10.13.0) is optimal-Delaunay-triangulation smoothing:
   * each free interior vertex moves to the volume-weighted average of its
   * incident tets' circumcenters. It targets element QUALITY rather than
   * surface fairness, which is what the other two do, so it is the one to
   * reach for before a solve. **Tet-only** — upstream raises by name on any
   * other cell type, and that error is surfaced rather than swallowed, since
   * a silent noop would look identical to "smoothing did nothing useful".
   * It runs on `smooth`'s existing fixed connectivity, so this module's
   * point-count invariant holds for it unchanged.
   */
  method?: SmoothMethod;
  iterations?: number;
  /** Step size. Left undefined the method picks its own default (0.5 / 0.33). */
  lambda?: number;
  /** Taubin's negative back-step; must satisfy mu < -lambda < 0. */
  mu?: number;
  /** Pin boundary nodes (default true) — without it an open mesh creeps inward. */
  fixBoundary?: boolean;
  /** Pin nodes on sharp edges (default true). */
  preserveFeatures?: boolean;
  /** Dihedral angle, degrees, above which an edge counts as a feature. */
  featureAngle?: number;
  /** Reject a move that would invert an incident cell (default true). */
  guardInversion?: boolean;
}

export interface SmoothResult {
  model: MdpaModel;
  numNodesMoved: number;
  maxDisplacement: number;
  /** Moves rejected because they would have inverted a cell. */
  numSkippedInversion: number;
}

/** meshio++ uses a negative lambda/mu to mean "the method's own default". */
const USE_METHOD_DEFAULT = -1;

export async function smoothModel(
  model: MdpaModel,
  params: SmoothParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<SmoothResult> {
  const unchanged: SmoothResult = {
    model,
    numNodesMoved: 0,
    maxDisplacement: 0,
    numSkippedInversion: 0,
  };
  if (model.nodeCount === 0) return unchanged;

  // dim: 3 unconditionally — a planar model would otherwise come back with two
  // coordinates per point and the copy-back below would have to branch. A
  // planar mesh keeps z = 0 through smoothing anyway.
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return unchanged;

  const m = await loadMeshio();
  const r = m.smooth(
    mesh,
    params.method ?? "taubin",
    params.iterations ?? 10,
    params.lambda ?? USE_METHOD_DEFAULT,
    params.mu ?? -0.34,
    params.fixBoundary ?? true,
    params.preserveFeatures ?? true,
    params.featureAngle ?? 30,
    params.guardInversion ?? true
  );

  const pts = r.mesh.points;
  if (pts.length !== model.nodeCount * 3) {
    // Cannot happen for `smooth`, which is documented not to renumber — but the
    // whole design rests on the order being untouched, so refuse rather than
    // scatter coordinates onto the wrong nodes.
    throw new Error(
      `smooth returned ${Math.floor(pts.length / 3)} points for ${model.nodeCount} nodes; ` +
        `node order cannot be trusted, so the result was discarded.`
    );
  }

  const coords = new Float32Array(model.coords);
  for (let i = 0; i < pts.length; i++) coords[i] = pts[i];

  return {
    model: { ...model, coords, bounds: boundsOf(coords, model.nodeCount) },
    numNodesMoved: r.numNodesMoved,
    maxDisplacement: r.maxDisplacement,
    numSkippedInversion: r.numSkippedInversion,
  };
}

/** Recomputes the bounding box after the nodes have moved. */
function boundsOf(
  coords: Float32Array,
  nodeCount: number
): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nodeCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = coords[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (nodeCount === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
