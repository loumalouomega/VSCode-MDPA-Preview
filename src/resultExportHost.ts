/**
 * Host glue for converting a finished run's VTK output to other formats: reads
 * the case's saved export settings, runs the shared `exportCaseResults` and
 * reports the outcome. The decisions live in `problemtype/resultExport.ts`.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { caseFilePath } from "./problemtype/caseFile";
import { parseCaseJson } from "./problemtype/caseFile";
import { caseExportResults } from "./mcp/tools";
import { describeResultExport, normalizeExportFormats, ResultExportOutcome } from "./problemtype/resultExport";

export function savedExportSettings(meshFsPath: string): { formats: string[]; folder?: string } {
  try {
    const output = parseCaseJson(fs.readFileSync(caseFilePath(meshFsPath), "utf8")).state?.output;
    return { formats: normalizeExportFormats(output?.exportFormats), folder: output?.exportFolder };
  } catch {
    return { formats: [] };
  }
}

/** Runs the conversion; resolves to the outcome, or to the error text (never throws). */
export async function convertRunResults(
  meshFsPath: string,
  formats: string[],
  folder: string | undefined
): Promise<{ outcome?: ResultExportOutcome; error?: string }> {
  try {
    const outcome = (await caseExportResults({ meshPath: meshFsPath, formats, folder })) as ResultExportOutcome;
    return { outcome };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Asks for formats, then converts and shows the result. Backs `kratos.runs.exportResults`. */
export async function exportResultsInteractive(meshFsPath: string): Promise<void> {
  const saved = savedExportSettings(meshFsPath);
  let formats = saved.formats;
  if (formats.length === 0) {
    const picks = await vscode.window.showQuickPick(
      [".xdmf", ".pvd", ".exo", ".msh", ".med", ".cgns", ".vtu", ".stl", ".ply", ".obj"].map((label) => ({ label })),
      { canPickMany: true, title: "Convert results to…" }
    );
    if (!picks || picks.length === 0) return;
    formats = picks.map((p) => p.label);
  }
  const { outcome, error } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Converting results…" },
    () => convertRunResults(meshFsPath, formats, saved.folder)
  );
  if (error || !outcome) {
    void vscode.window.showWarningMessage(`Result conversion failed: ${error}`);
    return;
  }
  void vscode.window.showInformationMessage(describeResultExport(outcome));
}
