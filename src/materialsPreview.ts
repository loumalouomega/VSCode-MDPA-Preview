/**
 * Kratos MDPA: Preview Material Tables. The host half: finds the materials
 * JSON (or takes the tables the Materials form already holds), builds one plot
 * per variable pair with the pure `materialsJsonPlot.ts` and opens each in the
 * Scientific plots workspace. Read-only: nothing here writes the file.
 */

import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openPlotBuilder } from "./plotController";
import { materialsPlotRecipes, materialsTables, type MaterialsTablesRead } from "./problemtype/materialsJsonPlot";

/** What the Materials form hands the command: tables already read from the case on screen. */
export interface MaterialTablesRequest {
  read: MaterialsTablesRead;
  label: string;
}

/** More charts than this ask which to open, so a big file does not spawn a wall of panels. */
const OPEN_ALL_LIMIT = 4;

const isRequest = (v: unknown): v is MaterialTablesRequest =>
  !!v && typeof v === "object" && "read" in v && "label" in v && typeof (v as MaterialTablesRequest).label === "string";

async function pickFile(arg: unknown): Promise<vscode.Uri | undefined> {
  if (arg instanceof vscode.Uri) return arg;
  const active = vscode.window.activeTextEditor?.document;
  if (active && !active.isUntitled && active.fileName.toLowerCase().endsWith(".json")) return active.uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Kratos materials (JSON)": ["json"] },
    title: "Choose a materials JSON file",
  });
  return picked?.[0];
}

export async function previewMaterialTables(context: vscode.ExtensionContext, arg?: unknown): Promise<void> {
  let read: MaterialsTablesRead;
  let label: string;
  if (isRequest(arg)) {
    ({ read, label } = arg);
  } else {
    const uri = await pickFile(arg);
    if (!uri) return;
    label = path.basename(uri.fsPath);
    try {
      read = materialsTables(JSON.parse(await fs.readFile(uri.fsPath, "utf8")));
    } catch (e) {
      void vscode.window.showErrorMessage(`Cannot read ${label} as JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  const plots = materialsPlotRecipes(read, label);
  if (plots.length === 0) {
    void vscode.window.showInformationMessage(read.notes.length > 0 ? read.notes.join(" ") : "There are no material tables to plot.");
    return;
  }
  let chosen = plots;
  if (plots.length > OPEN_ALL_LIMIT) {
    const picks = await vscode.window.showQuickPick(
      plots.map((p) => ({ label: p.title, description: `${p.recipe.series.length} table(s)`, plot: p, picked: true })),
      { canPickMany: true, title: `${plots.length} charts in ${label}: which to open?` }
    );
    if (!picks || picks.length === 0) return;
    chosen = picks.map((p) => p.plot);
  }
  for (const plot of chosen) openPlotBuilder(context, undefined, plot.recipe, plot.title);
  if (read.notes.length > 0) void vscode.window.showWarningMessage(`Material tables: ${read.notes.join(" ")}`);
}
