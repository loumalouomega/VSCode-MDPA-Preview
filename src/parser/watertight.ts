/**
 * Surface watertightness — is this boundary closed, manifold and consistently
 * wound? Backed by meshio++'s `surfaceWatertightCheck` (>= 10.4.0).
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable.
 *
 * ## Why this lives next to meshNormals.ts rather than inside it
 *
 * `meshNormals.ts` already answers half of this question NATIVELY, and does it
 * well: two faces sharing an edge are consistently wound exactly when they
 * traverse it in opposite directions, so a directed edge seen twice means one
 * is flipped. That test is relative, needs no wasm, and is what draws the red
 * inverted-element overlay.
 *
 * What it cannot say is whether the surface is CLOSED — an edge belonging to
 * one face is a hole, an edge belonging to three is a non-manifold junction,
 * and neither is a winding problem. `surfaceWatertightCheck` returns those
 * counts. Keeping it in its own module is what lets `meshNormals.ts` stay pure,
 * synchronous and wasm-free (it is bundled into the WEBVIEW, which has no
 * access to the wasm at all), while this one runs host-side.
 *
 * ## Why the numbers matter more than the flag
 *
 * "Not watertight" is not actionable. Three boundary edges is a pinhole to
 * patch; three thousand is a surface that was never closed. A non-manifold edge
 * is a different defect from a hole and needs a different fix. So the counts
 * are surfaced individually rather than collapsed into a boolean — the same
 * reasoning that makes meshQuality.ts report per-metric histograms instead of
 * a pass/fail verdict.
 */

import { modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { MdpaDiagnostic, MdpaModel } from "./types";

export interface WatertightReport {
  /** Edges used by exactly one face — holes in the surface. */
  boundaryEdges: number;
  /** Edges used by three or more faces — non-manifold junctions. */
  nonManifoldEdges: number;
  /** Adjacent face pairs that traverse their shared edge the same way. */
  inconsistentPairs: number;
  /** Faces with zero area. */
  degenerateTriangles: number;
  /** True only when every count above is zero. */
  watertight: boolean;
}

/**
 * Runs the check on the model's own cells. A volume mesh's boundary is
 * extracted by meshio++ itself, so this is meaningful for both a surface mesh
 * and a solid one.
 */
export async function watertightReport(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[] = []
): Promise<WatertightReport | undefined> {
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return undefined;
  const m = await loadMeshio();
  const r = m.surfaceWatertightCheck(mesh);
  return {
    boundaryEdges: r.boundaryEdges,
    nonManifoldEdges: r.nonManifoldEdges,
    inconsistentPairs: r.inconsistentPairs,
    degenerateTriangles: r.degenerateTriangles,
    watertight: r.watertight,
  };
}

/** One line naming what is actually wrong, for a status readout. */
export function watertightSummary(r: WatertightReport): string {
  if (r.watertight) return "closed, manifold and consistently wound";
  const parts: string[] = [];
  if (r.boundaryEdges > 0) parts.push(`${r.boundaryEdges} boundary edge(s) — the surface has holes`);
  if (r.nonManifoldEdges > 0) {
    parts.push(`${r.nonManifoldEdges} non-manifold edge(s) — three or more faces meet`);
  }
  if (r.inconsistentPairs > 0) parts.push(`${r.inconsistentPairs} inconsistently wound face pair(s)`);
  if (r.degenerateTriangles > 0) parts.push(`${r.degenerateTriangles} zero-area face(s)`);
  return parts.join("; ");
}
