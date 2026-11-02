/**
 * Wall thickness (inward) or clearance (outward) of a surface mesh, per facet,
 * via meshio++'s `thickness` (>= 18.0.0): a ray from each cell's centroid along
 * its normal, the distance to the first hit of the same surface (or `other`).
 *
 * Pure module (no vscode / DOM). An ORACLE in the sense of curvature.ts: the
 * result is one value per EXISTING cell in block-major order, applied onto our
 * own model as ordinary Elemental / Conditional fields; meshio++'s returned mesh
 * is never adopted and the cells are not touched.
 *
 * What is measured, not assumed (icosphere of radius 1 against the live wasm):
 * `direction: "auto"` picks inward for a closed outward-wound surface (the ray
 * runs through the wall, so the distance is the local diameter, ~1.97 on a
 * 320-facet sphere), a miss reads NaN in `thickness:distance`, and the result's
 * `cell_data` arrives as one array per block like every other per-cell array.
 * A miss becomes a GAP in the field (a row is dropped), never a zero: 0 would
 * read as an infinitely thin wall.
 */

import type { MdpaDiagnostic, MdpaModel } from "./types";
import { cellCategory } from "./writers/writerCommon";
import { prepareMeshioOp, meshioCorrespondence, flattenMeshioData, expectCount, attachCellField } from "./meshioAdapter";

export const THICKNESS_DIRECTIONS = ["auto", "inward", "outward"] as const;
export type ThicknessDirection = (typeof THICKNESS_DIRECTIONS)[number];
export const THICKNESS_VARIABLE = "THICKNESS";

export interface ThicknessParams {
  /** "inward" measures the wall, "outward" the clearance to the next surface, "auto" (default) chooses from the orientation. */
  direction?: ThicknessDirection;
  /** The longest ray; 0 / omitted = the bounding-box diagonal. */
  maxDistance?: number;
  /** Count the facets thinner than this (0 / omitted: none). */
  threshold?: number;
  /** Field name for the distance (default THICKNESS). */
  output?: string;
}

export interface ThicknessResult {
  model: MdpaModel;
  /** "Elemental:THICKNESS"-style keys of the fields written; empty = nothing to do. */
  written: string[];
  direction?: "inward" | "outward";
  numCells: number;
  numHit: number;
  numMissed: number;
  numBelow: number;
  min: number;
  max: number;
  mean: number;
  /** Entity of the least distance, `{kind, id}`, when anything was hit. */
  minEntity?: { kind: "Elements" | "Conditions" | "Geometries"; id: number };
  warnings: string[];
  message?: string;
}

const empty = (model: MdpaModel, message: string): ThicknessResult => ({
  model, written: [], numCells: 0, numHit: 0, numMissed: 0, numBelow: 0, min: NaN, max: NaN, mean: NaN, warnings: [], message,
});

/** Why a mesh cannot be measured, or undefined when it can. Shared with `validateParams`' callers and MCP. */
export function thicknessScopeProblem(model: MdpaModel): string | undefined {
  if (model.blocks.some((b) => b.count > 0 && cellCategory(b.vtkCellType) === "volume")) {
    return "Thickness is measured on a surface mesh, and this one has volume cells. Export its skin first (Advanced ▸ Export skin…).";
  }
  const hasSurface = model.blocks.some((b) => b.count > 0 && cellCategory(b.vtkCellType) === "surface");
  return hasSurface ? undefined : "The mesh has no surface cells (triangles or quadrilaterals) to measure.";
}

export async function thicknessModel(model: MdpaModel, params: ThicknessParams = {}, diagnostics: MdpaDiagnostic[] = []): Promise<ThicknessResult> {
  const problem = thicknessScopeProblem(model);
  if (problem) return empty(model, problem);
  const prepared = await prepareMeshioOp(model, diagnostics, { dim: 3 });
  if (!prepared) return empty(model, "The mesh has no cells to measure.");
  const { m, mesh } = prepared;

  const options: Record<string, unknown> = {};
  if (params.direction && params.direction !== "auto") options.direction = params.direction;
  if (params.maxDistance !== undefined && params.maxDistance > 0) options.maxDistance = params.maxDistance;
  if (params.threshold !== undefined && params.threshold > 0) options.threshold = params.threshold;
  const r = m.thickness(mesh, options);

  const { blocks, cellCount } = meshioCorrespondence(model, mesh, "thickness");
  const flat = flattenMeshioData(r.mesh.cell_data?.["thickness:distance"] as never);
  expectCount("thickness", "cell", flat.length, cellCount);

  // One field per id space; a miss (NaN) is a gap, not a zero.
  const rows: Record<"Elemental" | "Conditional", { ids: number[]; values: number[] }> = {
    Elemental: { ids: [], values: [] },
    Conditional: { ids: [], values: [] },
  };
  let cursor = 0;
  let skippedGeometries = 0;
  for (const b of blocks) {
    for (let c = 0; c < b.count; c++, cursor++) {
      const v = flat[cursor];
      if (b.kind === "Geometries") { skippedGeometries++; continue; }
      if (!Number.isFinite(v)) continue;
      const bucket = rows[b.kind === "Conditions" ? "Conditional" : "Elemental"];
      bucket.ids.push(b.entityIds[c]);
      bucket.values.push(v);
    }
  }

  const variable = params.output && params.output.trim() ? params.output.trim() : THICKNESS_VARIABLE;
  let out = model;
  const written: string[] = [];
  for (const kind of ["Elemental", "Conditional"] as const) {
    const bucket = rows[kind];
    if (bucket.ids.length === 0) continue;
    out = attachCellField(out, { kind, variable, components: 1, ids: Int32Array.from(bucket.ids), values: bucket.values }).model;
    written.push(`${kind}:${variable}`);
  }
  if (written.length === 0) {
    return { ...empty(model, `No facet's ray reached a surface within ${r.maxDistance.toPrecision(4)} (${r.numMissed} miss(es)).`), direction: r.direction, numCells: r.numCells, numMissed: r.numMissed, warnings: r.warnings };
  }

  let minEntity: ThicknessResult["minEntity"];
  if (r.minCell >= 0) {
    let at = 0;
    for (const b of blocks) {
      if (r.minCell < at + b.count) { minEntity = { kind: b.kind, id: b.entityIds[r.minCell - at] }; break; }
      at += b.count;
    }
  }
  const warnings = [...r.warnings];
  if (skippedGeometries > 0) warnings.push(`${skippedGeometries} Geometry cell(s) were measured but not written: a field cannot address the Geometries id space.`);
  return {
    model: out, written, direction: r.direction, numCells: r.numCells, numHit: r.numHit, numMissed: r.numMissed, numBelow: r.numBelow,
    min: r.min, max: r.max, mean: r.mean, minEntity, warnings,
  };
}

/** The outcome sentence shared by the op and the MCP tool. */
export function describeThickness(r: ThicknessResult, threshold?: number): string {
  const what = r.direction === "outward" ? "clearance" : "thickness";
  const parts = [
    `Wrote ${r.written.map((k) => k.replace(/^(Elemental|Conditional):/, "")).filter((v, i, a) => a.indexOf(v) === i).join(", ")}: ${what} of ${r.numHit} of ${r.numCells} facet(s) ∈ [${r.min.toPrecision(4)}, ${r.max.toPrecision(4)}], mean ${r.mean.toPrecision(4)}.`,
  ];
  if (r.numMissed > 0) parts.push(`${r.numMissed} ray(s) reached nothing and are gaps, not zeros.`);
  if (threshold && threshold > 0) parts.push(`${r.numBelow} facet(s) are thinner than ${threshold}.`);
  if (r.minEntity) parts.push(`Least at ${r.minEntity.kind.replace(/s$/, "")} ${r.minEntity.id}.`);
  return parts.concat(r.warnings).join(" ");
}
