/**
 * Read-only reports and one derive-like pipeline over the meshio++ 20.0.0 scan
 * kernels: `measure` (elements, dimensions and GD&T by a JSON spec),
 * `findSymmetryPlane`, `fitCadIterate`. Shared by the MCP tools; the in-place
 * ops live in `meshio181.ts` and the new-mesh kernels in `kernelOps.ts`.
 *
 * Pure host module (no vscode / DOM). Nothing here modifies the model it is
 * given: each call converts it, asks the kernel and returns plain data (and, for
 * `fitCadIterate`, a NEW model).
 */

import type { MdpaDiagnostic, MdpaModel } from "./types";
import { modelToMeshio, meshioToModel } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { withKratosBlockNames, legalFields } from "./kernelMeshes";

const g = (x: number) => (Number.isFinite(x) ? +x.toPrecision(5) : null);

/** Elements, dimensions and tolerances of a mesh by a spec (an object or its JSON text). */
export async function measureReport(model: MdpaModel, spec: object | string, diagnostics: MdpaDiagnostic[] = []): Promise<{ report: unknown; numFail: number; warnings: string[] }> {
  if (model.nodeCount === 0) throw new Error("The mesh has no nodes.");
  const m = await loadMeshio();
  const r = m.measure(modelToMeshio(model, diagnostics, { dim: 3 }), spec);
  return { report: r.report, numFail: r.numFail, warnings: r.warnings };
}

export interface SymmetryPlaneOptions {
  seedOrigin?: number[];
  seedNormal?: number[];
  tolerance?: number;
  minShare?: number;
  maxSamples?: number;
  maxIterations?: number;
}

/** The plane the mesh is most nearly symmetric about, with the share of points that mirror within tolerance. */
export async function symmetryPlaneReport(model: MdpaModel, options: SymmetryPlaneOptions = {}, diagnostics: MdpaDiagnostic[] = []): Promise<Record<string, unknown>> {
  if (model.nodeCount === 0) throw new Error("The mesh has no nodes.");
  const m = await loadMeshio();
  const o = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const r = m.findSymmetryPlane(modelToMeshio(model, diagnostics, { dim: 3 }), o);
  return { origin: r.origin.map(g), normal: r.normal.map(g), rms: g(r.rms), share: g(r.share), tolerance: g(r.tolerance), chosenCandidate: r.chosenCandidate, warnings: r.warnings };
}

export interface FitCadIterateOptions { [key: string]: unknown }

/** Segments, fits and builds a solid from a scan in rounds towards a target; returns the rounds and the solid as a new model. */
export async function fitCadIterateModel(model: MdpaModel, options: FitCadIterateOptions = {}, diagnostics: MdpaDiagnostic[] = []): Promise<{ model: MdpaModel; summary: string; rounds: unknown[]; targetMet: boolean; stopReason: string }> {
  if (model.nodeCount === 0) throw new Error("The mesh has no nodes.");
  const m = await loadMeshio();
  const r = m.fitCadIterate(modelToMeshio(model, diagnostics, { dim: 3 }), options);
  const out = legalFields(withKratosBlockNames(meshioToModel(r.mesh as Parameters<typeof meshioToModel>[0], diagnostics)));
  const last = r.rounds[r.bestRound] as { shareWithin?: number; explained?: number; hausdorffMax?: number; numFaces?: number } | undefined;
  const summary =
    `Fitted a solid in ${r.rounds.length} round(s); best round ${r.bestRound + 1}: ${last?.numFaces ?? "?"} face(s), ` +
    `${g(100 * (last?.shareWithin ?? NaN))}% of the scan within tolerance, Hausdorff max ${g(last?.hausdorffMax ?? NaN)}. ` +
    `Target ${r.targetMet ? "met" : "NOT met"} (${r.stopReason}); ${r.numMeasured} measured face(s), ${r.numInferred} inferred.`;
  return { model: out, summary, rounds: r.rounds, targetMet: r.targetMet, stopReason: r.stopReason };
}
