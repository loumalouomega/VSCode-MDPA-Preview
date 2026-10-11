/**
 * "Save as monitor" from the viewer: turns the entity and variable the series
 * panel is plotting into a saved point monitor of the case that owns the open
 * result file. The decisions (which case, a collision-free id, validation) are
 * in the pure/fs modules below; this file only asks the user what they cannot
 * be guessed.
 */

import * as path from "node:path";
import * as vscode from "vscode";

import { findMonitorCases } from "./problemtype/monitorsFile";
import { readMonitors, writeMonitors } from "./problemtype/monitorsFile";
import { suggestMonitor, upsertMonitor, validateMonitor } from "./problemtype/monitors";

export async function saveMonitorFromViewer(resultPath: string, msg: Record<string, unknown>): Promise<void> {
  const cases = findMonitorCases(resultPath);
  if (cases.length === 0) {
    void vscode.window.showInformationMessage(
      "No case was found for this result. Monitors belong to a case: generate or run a case for the mesh first (it leaves a .kratoscase.json or .kratosrun.json beside it), or add the monitor with the case_monitors MCP tool."
    );
    return;
  }
  let chosen = cases[0];
  if (cases.length > 1) {
    const pick = await vscode.window.showQuickPick(
      cases.map((c) => ({ label: c.stem, description: c.dir, c })),
      { title: "Save the monitor to which case?", placeHolder: "More than one case is next to this result" }
    );
    if (!pick) return;
    chosen = pick.c;
  }
  const read = readMonitors(chosen.meshPath);
  for (const w of read.parsed.warnings) void vscode.window.showWarningMessage(w);
  const spec = { kind: msg.kind as "Nodal" | "Elemental" | "Conditional", entityId: Number(msg.entityId), variable: String(msg.variable ?? "") };
  const suggested = suggestMonitor(spec, read.parsed.monitors);
  const name = await vscode.window.showInputBox({ title: "Monitor name", value: suggested.name, prompt: "Shown in Kratos Runs and in exports" });
  if (name === undefined) return;
  const { monitor, problem } = validateMonitor({
    id: suggested.id,
    name: name || suggested.name,
    source: { type: "history", kind: spec.kind, entityId: spec.entityId, variable: spec.variable },
  });
  if (!monitor) {
    void vscode.window.showErrorMessage(problem ?? "The monitor is not valid.");
    return;
  }
  try {
    const file = writeMonitors(chosen.meshPath, upsertMonitor(read.parsed.monitors, monitor));
    void vscode.window.showInformationMessage(`Saved monitor "${monitor.name}" to ${path.basename(file)}. Evaluate it from Kratos Runs ▸ Export Monitors… or Plot Monitors.`);
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}
