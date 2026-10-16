/**
 * Exporting an optimization run's final geometry as CAD (STEP).
 *
 * The source is the run's own output, not the case mesh: the latest finished
 * design-field frame (`Optimization_Results/`, resolved exactly like
 * `kratos.runs.openDesignFields` — see `latestResultFile`), parsed with
 * `parseMeshFile` and written through the `.step` pipeline (`writeMeshioBytes`,
 * so fitCad semantics, the `.cad.json` companion and the faceted fallback are
 * identical to File ▸ Export ▸ CAD).
 *
 * Two modes, because the two control families leave different geometry behind:
 * - `shape`: the frame mesh IS the optimized geometry (vertex morphing moves
 *   the nodes), so it is written as-is.
 * - `topology`: a SIMP run leaves a density field, not a surface — the level
 *   set at `threshold` becomes the solid (meshio++ `isosurface`, the same
 *   kernel the Isosurface derive op uses). An Elemental density is averaged to
 *   the nodes first (`averageField`, elementalToNodal); a threshold the field
 *   never crosses is a refusal, not an empty solid.
 *
 * Pure `node:` core (no vscode / DOM): the Runs command, the Optimization
 * progress panel host and the MCP tool share it and only differ in how they
 * ask (QuickPick vs. arguments) and where they write (save dialog vs.
 * outputPath).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { FitCadOptions } from "@meshioplusplus/wasm";

import { averageField } from "../../parser/fieldCalc";
import { loadMeshio, writeMeshioBytes } from "../../parser/meshio";
import { meshioToModel, modelToMeshio, sanitizeVariable } from "../../parser/meshioConvert";
import type { MdpaDiagnostic, MdpaModel } from "../../parser/types";
import { parseMeshFile } from "../../parser/meshFileParser";
import { latestResultFile } from "../runCore";
import { readOptimization } from "./summaryLogFile";

export type OptimizedCadMode = "shape" | "topology";

/** The default density level set: material where density >= 0.5. */
export const DEFAULT_DENSITY_THRESHOLD = 0.5;

export interface OptimizedFrame {
  caseDir: string;
  folder: string;
  fileName: string;
  framePath: string;
  /** The timeline step the frame was written at (`groupVtkFiles` numbering). */
  step: string;
  frameIndex: number;
}

/**
 * The latest finished design-field frame of an optimization case, resolved
 * exactly like `kratos.vtk.openLatestResults` does for `openDesignFields`.
 * Throws the same user-facing refusal the UI commands show (no design fields
 * configured, no frames written yet, not an optimization case).
 */
export function resolveOptimizedFrame(
  caseDir: string,
  opts: { excludeNewest?: boolean } = {}
): OptimizedFrame {
  const read = readOptimization(caseDir);
  const folder = read.info?.designFieldsFolder;
  if (!read.info || !folder) {
    throw new Error(
      read.info
        ? "This optimization case writes no design fields (VTU output is off)."
        : (read.reason ?? "Not an optimization case.")
    );
  }
  const outDir = path.join(caseDir, folder);
  let names: string[] = [];
  try {
    names = fs.readdirSync(outDir);
  } catch {
    /* reported below */
  }
  const latest = latestResultFile(names, { excludeNewest: opts.excludeNewest });
  if (!latest) {
    throw new Error(`No results in ${folder}/ yet — run the case first (design fields appear as the optimizer writes steps).`);
  }
  return { caseDir, folder, fileName: latest.fileName, framePath: path.join(outDir, latest.fileName), step: latest.step, frameIndex: latest.frameIndex };
}

/** One scalar field on a frame: a topology candidate when it reads as density. */
export interface ScalarFieldRef {
  variable: string;
  kind: string;
  components: number;
}

/** Every scalar field on the model, in field order (the topology picker lists these). */
export function scalarFieldsOf(model: MdpaModel): ScalarFieldRef[] {
  return model.fields
    .filter((f) => f.components === 1)
    .map((f) => ({ variable: f.variable, kind: f.kind, components: f.components }));
}

/** A variable that smells like SIMP density, for pre-selecting the topology picker. */
export function guessDensityField(model: MdpaModel): string | undefined {
  const scalars = scalarFieldsOf(model).map((f) => f.variable);
  return scalars.find((v) => /dens/i.test(v));
}

export interface OptimizedCadOptions {
  /** `shape` writes the frame mesh; `topology` contours a density field (default `shape`). */
  mode?: OptimizedCadMode;
  /** Topology only: the scalar field to contour (required there). */
  densityField?: string;
  /** Topology only: material where the field >= this (default 0.5). */
  threshold?: number;
  /** The `.step` fit controls (writeStepModel): undefined takes the kernel defaults, `false` writes faceted. */
  fitCad?: FitCadOptions | false;
  /** Drop the newest frame: a killed run can leave it half-written. */
  excludeNewest?: boolean;
  /** File stem for the STEP (default `<case-stem>_optimized`). */
  stem?: string;
}

export interface OptimizedCadResult {
  /** The STEP bytes. */
  data: Uint8Array;
  /** Companion files to write beside it (today: the `.cad.json` B-rep). */
  companions: { name: string; data: Uint8Array }[];
  frame: OptimizedFrame;
  mode: OptimizedCadMode;
  densityField?: string;
  threshold?: number;
  /** The Elemental density was averaged to the nodes before contouring. */
  averagedToNodal?: boolean;
  /** Human report lines: what the solid was built from (the threshold is always stated). */
  notes: string[];
  diagnostics: MdpaDiagnostic[];
}

/**
 * Builds the optimized solid's STEP. Throws named refusals (no case, no
 * design fields, no frames, unknown density field, an uncrossed threshold, a
 * mesh with no skinnable surface) — never an empty file.
 */
export async function buildOptimizedCad(
  caseDir: string,
  opts: OptimizedCadOptions = {}
): Promise<OptimizedCadResult> {
  const mode = opts.mode ?? "shape";
  const frame = resolveOptimizedFrame(caseDir, { excludeNewest: opts.excludeNewest });
  const frameModel = await parseMeshFile(frame.framePath);
  const notes: string[] = [
    `Final design-field frame ${frame.fileName} (step ${frame.step}).`,
  ];
  let source: MdpaModel = frameModel;
  let densityField: string | undefined;
  let threshold: number | undefined;
  let averagedToNodal = false;

  if (mode === "topology") {
    if (!opts.densityField) {
      const have = scalarFieldsOf(frameModel).map((f) => `${f.variable} (${f.kind})`);
      throw new Error(
        `Topology mode needs the density field to contour${have.length > 0 ? ` — scalar fields on this frame: ${have.join(", ")}` : ", and this frame carries no scalar field"}.`
      );
    }
    densityField = opts.densityField;
    threshold = opts.threshold ?? DEFAULT_DENSITY_THRESHOLD;
    if (!Number.isFinite(threshold)) throw new Error(`The density threshold must be a finite number (got ${String(opts.threshold)}).`);
    let field = frameModel.fields.find((f) => f.components === 1 && f.variable === densityField);
    if (!field) {
      const have = scalarFieldsOf(frameModel).map((f) => `${f.variable} (${f.kind})`);
      throw new Error(
        `No scalar field named "${densityField}" on ${frame.fileName}${have.length > 0 ? ` — scalar fields: ${have.join(", ")}` : ", and the frame carries no scalar field"}.`
      );
    }
    if (field.kind !== "Nodal") {
      const originalKind = field.kind;
      const averaged = averageField(frameModel, { variable: densityField, direction: "elementalToNodal" });
      if (averaged.computed === 0) {
        throw new Error(`"${densityField}" is an ${originalKind} field that could not be moved to the nodes — no cell carried it.`);
      }
      source = averaged.model;
      field = source.fields.find((f) => f.kind === "Nodal" && f.variable === densityField);
      if (!field) throw new Error(`"${densityField}" could not be moved to the nodes.`);
      averagedToNodal = true;
      notes.push(`"${densityField}" is an ${originalKind} field: averaged to the nodes over ${averaged.computed} cells.`);
    }
    const diagnostics: MdpaDiagnostic[] = [];
    const mesh = modelToMeshio(source, diagnostics, { dim: 3 });
    if (mesh.cells.length === 0) throw new Error("The mesh has no cells to contour.");
    const m = await loadMeshio();
    // A negative component is the row magnitude upstream; identical to
    // component 0 for a scalar, and the derive op's own convention.
    const surf = m.isosurface(mesh, sanitizeVariable(densityField), [threshold], -1, true);
    if (surf.cells.length === 0 || surf.cells.every((c) => "data" in c && c.data.length === 0)) {
      throw new Error(`No isosurface: "${densityField}" never crosses ${threshold} on ${frame.fileName}.`);
    }
    source = meshioToModel(surf, diagnostics);
    const faces = source.blocks.reduce((s, b) => s + b.count, 0);
    notes.push(`Topology mode: isosurface of "${densityField}" at ${threshold} — ${faces} face(s).`);
  } else {
    notes.push(`Shape mode: the frame mesh as optimized (${frameModel.nodeCount} nodes).`);
  }

  const stem = opts.stem ?? `${path.basename(caseDir)}_optimized`;
  const stepDiagnostics: MdpaDiagnostic[] = [];
  const { data, companions } = await writeMeshioBytes(source, ".step", {
    stem,
    fitCad: opts.fitCad,
    diagnostics: stepDiagnostics,
  });
  for (const d of stepDiagnostics) notes.push(d.message);
  return {
    data,
    companions: companions.map((c) => ({ name: c.name, data: c.data })),
    frame,
    mode,
    ...(densityField !== undefined ? { densityField } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(averagedToNodal ? { averagedToNodal } : {}),
    notes,
    diagnostics: stepDiagnostics,
  };
}
