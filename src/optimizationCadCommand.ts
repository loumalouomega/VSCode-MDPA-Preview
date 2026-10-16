/**
 * The VS Code side of the optimized-geometry CAD export: the dialogs around
 * the vscode-free core (`problemtype/optimization/cadExport.ts`). Shared by
 * the Kratos Runs command (`kratos.runs.exportOptimizedCad`) and the
 * Optimization progress panel's Export CAD button (via the host dep) — the
 * two only differ in where the case dir comes from.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { pickStepFit } from "./meshExport";
import { parseMeshFile } from "./parser/meshFileParser";
import {
  buildOptimizedCad,
  DEFAULT_DENSITY_THRESHOLD,
  guessDensityField,
  type OptimizedCadMode,
  resolveOptimizedFrame,
  scalarFieldsOf,
} from "./problemtype/optimization/cadExport";
import { readOptimization } from "./problemtype/optimization/summaryLogFile";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function pickMode(): Promise<OptimizedCadMode | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "Shape — the final mesh as optimized",
        mode: "shape" as OptimizedCadMode,
        detail: "Vertex morphing moves the nodes, so the latest design-field frame IS the optimized geometry. Writes it as STEP.",
      },
      {
        label: "Topology — contour a density field",
        mode: "topology" as OptimizedCadMode,
        detail: "A SIMP run leaves densities, not a surface: the level set at a threshold becomes the solid, then STEP.",
      },
    ],
    { title: "Export optimized geometry as CAD — what is the solid?", placeHolder: "shape or topology" }
  );
  return pick?.mode;
}

async function pickDensityField(variables: string[], preselect?: string): Promise<string | undefined> {
  if (variables.length === 0) {
    void vscode.window.showErrorMessage("This frame carries no scalar field to contour as density.");
    return undefined;
  }
  if (variables.length === 1) return variables[0];
  const pick = await vscode.window.showQuickPick(
    variables.map((v) => ({ label: v, description: v === preselect ? "density-like" : undefined })),
    { title: "Topology — which field holds the densities?", placeHolder: "density field" }
  );
  return pick?.label;
}

async function pickThreshold(): Promise<number | undefined> {
  const raw = await vscode.window.showInputBox({
    title: "Topology — density threshold",
    prompt: "Material where the density field is at or above this value",
    value: String(DEFAULT_DENSITY_THRESHOLD),
    validateInput: (v) => {
      const t = v.trim();
      if (t === "") return null;
      return Number.isFinite(Number(t)) ? null : "Enter a finite number.";
    },
  });
  if (raw === undefined) return undefined;
  return raw.trim() === "" ? DEFAULT_DENSITY_THRESHOLD : Number(raw);
}

/**
 * Runs the whole export for an optimization case folder: dialogs, build,
 * save dialog, write. `stem` names the suggested file. Refusals surface as
 * information messages (same wording as Open Design Fields); build failures
 * as errors.
 */
export async function runExportOptimizedCad(
  caseDir: string,
  opts: { excludeNewest?: boolean; stem?: string } = {}
): Promise<void> {
  const read = readOptimization(caseDir);
  if (!read.info?.designFieldsFolder) {
    void vscode.window.showInformationMessage(
      read.info
        ? "This optimization case writes no design fields (VTU output is off)."
        : (read.reason ?? "Not an optimization case.")
    );
    return;
  }
  const mode = await pickMode();
  if (!mode) return;
  let densityField: string | undefined;
  let threshold: number | undefined;
  if (mode === "topology") {
    let framePath: string;
    try {
      framePath = resolveOptimizedFrame(caseDir, { excludeNewest: opts.excludeNewest }).framePath;
    } catch (err) {
      void vscode.window.showInformationMessage(errText(err));
      return;
    }
    const frameModel = await parseMeshFile(framePath);
    const scalars = scalarFieldsOf(frameModel).map((f) => f.variable);
    densityField = await pickDensityField(scalars, guessDensityField(frameModel));
    if (!densityField) return;
    threshold = await pickThreshold();
    if (threshold === undefined) return;
  }
  const fitCad = await pickStepFit();
  if (fitCad === undefined) return; // cancelled dialog: write nothing
  const stem = opts.stem ?? `${path.basename(caseDir)}_optimized`;
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(caseDir, `${stem}.step`)),
    filters: { "STEP CAD": ["step"] },
    title: "Export optimized geometry as STEP",
  });
  if (!dest) return;
  let out;
  try {
    out = await buildOptimizedCad(caseDir, {
      mode,
      densityField,
      threshold,
      fitCad,
      excludeNewest: opts.excludeNewest,
      stem: path.basename(dest.fsPath, ".step"),
    });
  } catch (err) {
    void vscode.window.showErrorMessage(`The optimized geometry could not be exported as CAD: ${errText(err)}`);
    return;
  }
  fs.writeFileSync(dest.fsPath, out.data);
  for (const c of out.companions) {
    const companionPath = path.join(path.dirname(dest.fsPath), c.name);
    fs.mkdirSync(path.dirname(companionPath), { recursive: true });
    fs.writeFileSync(companionPath, c.data);
  }
  const fitted = out.notes.find((n) => n.includes("fitted CAD B-rep via fitCad"));
  const faceted = out.notes.find((n) => n.includes("faceted solid"));
  const how = fitted ? fitted : (faceted ?? "wrote the solid");
  void vscode.window.showInformationMessage(
    `Exported the optimized ${mode} (frame ${out.frame.fileName}) to ${path.basename(dest.fsPath)}: ${how}`
  );
}
