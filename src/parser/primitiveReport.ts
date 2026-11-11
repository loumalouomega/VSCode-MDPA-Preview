/**
 * Segmentation report with fitted primitives (roadmap item 31).
 *
 * Runs meshio++'s `fitPrimitives` over the `SEGMENT_PATCH` labels a `segment`
 * left on the model and reports, per patch, the primitive it matches (plane,
 * sphere, cylinder, cone, torus or none), its parameters and the fit residual.
 * Read-only and an ORACLE in the shape of `segmentMesh.ts`: our mesh never
 * changes; an optional `FIT_PRIMITIVE` field (1 plane … 5 torus, 0 unfitted,
 * -1 off the surface) lets patches be coloured by type.
 *
 * Parameter layout, measured against the live kernel for the three primitives
 * a solver user names boundaries by: `params[0..2]` a point on the primitive
 * (plane point, sphere centre, cylinder axis point), `params[3..5]` its normal
 * or axis (zero for a sphere) and `params[6]` its radius (cylinder, sphere).
 * Cone and torus parameters are returned raw, uninterpreted.
 */
import type { MdpaDiagnostic, MdpaModel } from "./types";
import { loadMeshio } from "./meshio";
import { flattenMeshioData, meshioCorrespondence } from "./meshioAdapter";
import { PATCH_PRIMITIVES, PatchPrimitive, refuseVolume, storedLabels, surfaceMesh, withLabels, SEGMENT_VARIABLE } from "./segmentMesh";

export const FIT_VARIABLE = "FIT_PRIMITIVE";
/** Field codes: index in this list + 1; 0 = no primitive accepted, -1 = off the surface. */
const TYPE_BY_CODE: (PatchPrimitive | "none")[] = ["none", ...PATCH_PRIMITIVES];

export interface FitPrimitivesParams {
  /** Inlier distance; relative to the bounding-box diagonal when `relative` (kernel default). */
  tolerance?: number;
  relative?: boolean;
  minInlierFraction?: number;
  types?: PatchPrimitive[];
  /** Trim the points a fit uses by sigma: auto (default), all, 3sigma, 2sigma, 1sigma (meshio++ >= 20.0.0). */
  usedPoints?: "auto" | "all" | "3sigma" | "2sigma" | "1sigma";
  /** The reference a plane/sphere/cylinder is refitted under (meshio++ >= 20.0.0). */
  criterion?: "least_squares" | "minimum_zone" | "min_circumscribed" | "max_inscribed";
  /** Also write the integer `FIT_PRIMITIVE` field. */
  writeField?: boolean;
}

export interface PatchFit {
  patch: number;
  cells: number;
  type: PatchPrimitive | "none";
  /** Fraction of the patch's facets within tolerance. */
  fraction: number;
  rms: number;
  max: number;
  tolerance: number;
  params: number[];
  point?: [number, number, number];
  axis?: [number, number, number];
  radius?: number;
}

export interface PrimitiveReport {
  model: MdpaModel;
  patches: PatchFit[];
  counts: Record<PatchPrimitive | "none", number>;
  message: string;
}

export async function fitPrimitivesReport(model: MdpaModel, params: FitPrimitivesParams = {}, diagnostics: MdpaDiagnostic[] = []): Promise<PrimitiveReport> {
  const empty = (message: string): PrimitiveReport => ({ model, patches: [], counts: { plane: 0, sphere: 0, cylinder: 0, cone: 0, torus: 0, none: 0 }, message });
  if (!refuseVolume(model, "Fit primitives")) return empty("There are no surface cells to fit.");
  const mesh = surfaceMesh(model, diagnostics);
  const { blocks, cellCount } = meshioCorrespondence(model, mesh, "fitPrimitives");
  const stored = storedLabels(model, blocks);
  if (stored.found === 0) return empty(`There is no ${SEGMENT_VARIABLE} field to fit: run Segment first.`);
  const perBlock: BigInt64Array[] = [];
  let cursor = 0;
  for (const b of blocks) {
    perBlock.push(BigInt64Array.from(stored.labels.slice(cursor, cursor + b.count), (v) => BigInt(v)));
    cursor += b.count;
  }
  (mesh as { cell_data?: Record<string, unknown[]> }).cell_data = { ...(mesh.cell_data ?? {}), "segment:patch": perBlock };
  const m = await loadMeshio();
  const r = m.fitPrimitives(mesh, "segment:patch", params.tolerance, params.relative, params.minInlierFraction, params.types, undefined, Object.fromEntries(Object.entries({ usedPoints: params.usedPoints, criterion: params.criterion }).filter(([, v]) => v !== undefined)));
  const fd = r.mesh.field_data ?? {};
  const num = (k: string): number[] => (fd[k] ? Array.from(fd[k] as ArrayLike<number | bigint>, Number) : []);
  const ids = num("fit:patch_id"), types = num("fit:patch_type"), frac = num("fit:patch_fraction"), rms = num("fit:patch_rms"), max = num("fit:patch_max"), tol = num("fit:patch_tolerance"), par = num("fit:patch_params");
  if (ids.length === 0 || par.length !== ids.length * 10) throw new Error("fitPrimitives returned an unexpected report shape; the result was discarded.");
  const cellsOf = new Map<number, number>();
  for (const k of stored.labels) if (k >= 0) cellsOf.set(k, (cellsOf.get(k) ?? 0) + 1);
  const counts: PrimitiveReport["counts"] = { plane: 0, sphere: 0, cylinder: 0, cone: 0, torus: 0, none: 0 };
  const patches: PatchFit[] = ids.map((patch, i) => {
    const type = TYPE_BY_CODE[types[i]] ?? "none";
    counts[type]++;
    const p = par.slice(i * 10, i * 10 + 10);
    const out: PatchFit = { patch, cells: cellsOf.get(patch) ?? 0, type, fraction: frac[i], rms: rms[i], max: max[i], tolerance: tol[i], params: p };
    if (type === "plane" || type === "sphere" || type === "cylinder") {
      out.point = [p[0], p[1], p[2]];
      if (type !== "sphere") out.axis = [p[3], p[4], p[5]];
      if (type !== "plane") out.radius = p[6];
    }
    return out;
  });
  let outModel = model;
  if (params.writeField) {
    const codes = flattenMeshioData(r.mesh.cell_data?.["fit:type"] as never);
    if (codes.length !== cellCount) throw new Error(`fitPrimitives returned ${codes.length} types for ${cellCount} cells; the result was discarded.`);
    outModel = withLabels(model, blocks, codes.map((c, i) => (stored.labels[i] < 0 ? -1 : c)), false, FIT_VARIABLE);
  }
  const listed = (["plane", "sphere", "cylinder", "cone", "torus", "none"] as const).filter((t) => counts[t] > 0).map((t) => `${counts[t]} ${t}`).join(", ");
  return { model: outModel, patches, counts, message: `${patches.length} patch(es): ${listed}.` };
}
