/**
 * Discrete curvature of a surface mesh: mean, Gaussian and principal curvature
 * per node, via meshio++'s `computeCurvature` (>= 10.37.0).
 *
 * Pure module (no vscode / DOM). An ORACLE in the sense of smoothMesh.ts: the
 * result is one value per EXISTING node in the input's own order, applied onto
 * our own model as ordinary Nodal fields — meshio++'s returned mesh is never
 * adopted. Cells are not touched at all.
 *
 * What is measured, not assumed (icosphere of radius R against the live wasm):
 * H = 1/R and K = 1/R² for an outward-wound sphere, the sum of the angle
 * defects is 4π (Gauss–Bonnet, 2πχ for a closed surface), a uniformly
 * inside-out surface reads H = −1/R (the sign of the mean curvature follows the
 * winding, so it is reported next to an orientation warning rather than left to
 * mislead), boundary nodes of an open surface and nodes no triangle references
 * read NaN, and `principal` is a 2-component array (k1 ≥ k2) that this module
 * splits into two scalar fields so a formula scope (`fieldCalc`, a remesh
 * sizing expression) can read either.
 */

import { MdpaDiagnostic, MdpaModel } from "./types";
import { cellCategory, cornerCount } from "./writers/writerCommon";
import { prepareMeshioOp, expectCount, attachNodalField, nodeIdsOf } from "./meshioAdapter";
import { meshioDataToNumbers, MeshioDataArray } from "./meshioConvert";
import { isValidFieldName } from "./fieldManage";
import type { MeshioSurfaceQuality } from "./meshio";

export const CURVATURE_DUAL_AREAS = ["mixed-voronoi", "barycentric"] as const;
export type CurvatureDualArea = (typeof CURVATURE_DUAL_AREAS)[number];
export const CURVATURE_PREFIX = "CURVATURE";

export interface CurvatureParams {
  /** Mean curvature H (default true). */
  mean?: boolean;
  /** Gaussian curvature K (default true). */
  gaussian?: boolean;
  /** The two principal curvatures k1 >= k2, as separate scalar fields (default false). */
  principal?: boolean;
  /** The per-node dual area the curvatures were divided by (default false). */
  area?: boolean;
  /** Dual-area choice: "mixed-voronoi" (default; exact for a well-shaped mesh) or "barycentric". */
  dualArea?: CurvatureDualArea;
  /** Compute boundary nodes too (default false: they read NaN and stay gaps). */
  includeBoundary?: boolean;
  /** Field-name prefix (default CURVATURE → CURVATURE_MEAN, CURVATURE_GAUSSIAN, …). */
  outputPrefix?: string;
}

export interface FieldStats {
  min: number;
  max: number;
  mean: number;
  /** Nodes with a defined value. */
  count: number;
}

export interface CurvatureResult {
  model: MdpaModel;
  /** "Nodal:CURVATURE_MEAN"-style keys of the fields written; empty = nothing to do. */
  written: string[];
  stats: Record<string, FieldStats>;
  numBoundary: number;
  numIsolated: number;
  numDegenerate: number;
  totalAngleDefect: number;
  /** Euler characteristic V − E + F of the surface cells; only meaningful for a closed surface. */
  eulerCharacteristic: number;
  quality: MeshioSurfaceQuality;
  /** Why a result should be read with care (orientation, boundary, degenerate faces). */
  warnings: string[];
  message?: string;
}

/** V − E + F over the mesh's own triangle/quad cells (used nodes only). */
export function eulerCharacteristic(model: MdpaModel): number {
  const nodes = new Set<number>();
  const edges = new Set<string>();
  let faces = 0;
  for (const b of model.blocks) {
    if (cellCategory(b.vtkCellType) !== "surface") continue;
    const n = Math.min(cornerCount(b.vtkCellType) || b.stride, b.stride);
    for (let c = 0; c < b.count; c++) {
      faces++;
      for (let k = 0; k < n; k++) {
        const a = b.connectivity[c * b.stride + k];
        const z = b.connectivity[c * b.stride + ((k + 1) % n)];
        nodes.add(a);
        edges.add(a < z ? `${a}>${z}` : `${z}>${a}`);
      }
    }
  }
  return nodes.size - edges.size + faces;
}

function stats(values: ArrayLike<number>, ids: Int32Array): { field: { ids: Int32Array; values: Float64Array }; s: FieldStats } {
  const keepIds: number[] = [];
  const keepVals: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    keepIds.push(ids[i]);
    keepVals.push(v);
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const count = keepVals.length;
  return {
    field: { ids: Int32Array.from(keepIds), values: Float64Array.from(keepVals) },
    s: { min: count ? min : NaN, max: count ? max : NaN, mean: count ? sum / count : NaN, count },
  };
}

const EMPTY_QUALITY: MeshioSurfaceQuality = {
  boundaryEdges: 0,
  nonManifoldEdges: 0,
  inconsistentPairs: 0,
  degenerateTriangles: 0,
  watertight: false,
};

function nothing(model: MdpaModel, message: string): CurvatureResult {
  return {
    model,
    written: [],
    stats: {},
    numBoundary: 0,
    numIsolated: 0,
    numDegenerate: 0,
    totalAngleDefect: 0,
    eulerCharacteristic: 0,
    quality: EMPTY_QUALITY,
    warnings: [],
    message,
  };
}

export async function curvatureModel(
  model: MdpaModel,
  params: CurvatureParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<CurvatureResult> {
  const prefix = params.outputPrefix ?? CURVATURE_PREFIX;
  if (!isValidFieldName(prefix)) return nothing(model, `"${prefix}" is not a valid Kratos variable name.`);
  if (model.blocks.some((b) => cellCategory(b.vtkCellType) === "volume")) {
    return nothing(
      model,
      "Curvature is defined on a surface; this mesh has volume cells. Use File ▸ Export skin… to get its boundary surface and measure that."
    );
  }
  if (!model.blocks.some((b) => cellCategory(b.vtkCellType) === "surface")) {
    return nothing(model, "No surface (triangle/quad) cells to measure curvature on.");
  }
  const wantMean = params.mean ?? true;
  const wantGauss = params.gaussian ?? true;
  const wantPrincipal = params.principal ?? false;
  const wantArea = params.area ?? false;
  if (!wantMean && !wantGauss && !wantPrincipal && !wantArea) return nothing(model, "Nothing selected to compute.");

  const prepared = await prepareMeshioOp(model, diagnostics, { dim: 3 });
  if (!prepared) return nothing(model, "Nothing to measure.");
  const r = prepared.m.computeCurvature(
    prepared.mesh,
    wantMean,
    wantGauss,
    params.dualArea ?? "mixed-voronoi",
    params.includeBoundary ?? false,
    wantArea,
    wantPrincipal,
    ""
  );

  const ids = nodeIdsOf(model);
  const out = r.mesh.point_data ?? {};
  const grab = (key: string, width: number): ArrayLike<number> | undefined => {
    const arr = out[key];
    if (!arr) return undefined;
    const nums = meshioDataToNumbers(arr as MeshioDataArray);
    expectCount(`computeCurvature (${key})`, "node", nums.length / width, model.nodeCount);
    return nums;
  };

  let next = model;
  const written: string[] = [];
  const allStats: Record<string, FieldStats> = {};
  const put = (variable: string, values: ArrayLike<number>): void => {
    const { field, s } = stats(values, ids);
    if (field.ids.length === 0) {
      allStats[`Nodal:${variable}`] = s;
      return; // every node undefined: an empty field is noise in every picker
    }
    next = attachNodalField(next, { variable, components: 1, ids: field.ids, values: field.values }).model;
    written.push(`Nodal:${variable}`);
    allStats[`Nodal:${variable}`] = s;
  };
  const mean = wantMean ? grab("curvature:mean", 1) : undefined;
  if (mean) put(`${prefix}_MEAN`, mean);
  const gauss = wantGauss ? grab("curvature:gaussian", 1) : undefined;
  if (gauss) put(`${prefix}_GAUSSIAN`, gauss);
  const area = wantArea ? grab("curvature:area", 1) : undefined;
  if (area) put(`${prefix}_AREA`, area);
  const principal = wantPrincipal ? grab("curvature:principal", 2) : undefined;
  if (principal) {
    const n = model.nodeCount;
    const k1 = new Float64Array(n);
    const k2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      k1[i] = principal[i * 2];
      k2[i] = principal[i * 2 + 1];
    }
    put(`${prefix}_K1`, k1);
    put(`${prefix}_K2`, k2);
  }

  const warnings: string[] = [];
  if (r.quality.inconsistentPairs > 0) {
    warnings.push(
      `${r.quality.inconsistentPairs} face pair(s) are wound against each other, so the SIGN of the mean curvature is unreliable — run Repair surface (fix winding) first.`
    );
  }
  if (r.numBoundary > 0 && !(params.includeBoundary ?? false)) {
    warnings.push(`${r.numBoundary} boundary node(s) have no curvature and are left as gaps.`);
  }
  if (r.numIsolated > 0) warnings.push(`${r.numIsolated} node(s) belong to no surface face and are left as gaps.`);
  if (r.numDegenerate > 0) warnings.push(`${r.numDegenerate} degenerate face(s) were skipped.`);

  return {
    model: next,
    written,
    stats: allStats,
    numBoundary: r.numBoundary,
    numIsolated: r.numIsolated,
    numDegenerate: r.numDegenerate,
    totalAngleDefect: r.totalAngleDefect,
    eulerCharacteristic: eulerCharacteristic(model),
    quality: r.quality,
    warnings,
  };
}

/** Gauss–Bonnet residual for a closed surface: the angle-defect sum minus 2πχ (≈ 0 when the mesh is sound). */
export function gaussBonnetResidual(r: Pick<CurvatureResult, "totalAngleDefect" | "eulerCharacteristic" | "quality">): number | undefined {
  return r.quality.boundaryEdges === 0 && r.quality.nonManifoldEdges === 0
    ? r.totalAngleDefect - 2 * Math.PI * r.eulerCharacteristic
    : undefined;
}
