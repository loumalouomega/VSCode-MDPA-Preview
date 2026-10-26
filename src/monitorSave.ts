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
import {
  needsReferencePoint,
  parseXyz,
  regionOperationsFor,
  suggestMonitor,
  suggestPointMonitor,
  suggestRegionMonitor,
  upsertMonitor,
  validateMonitor,
} from "./problemtype/monitors";
import { t } from "./parser/i18n/runtime";
import type { RegionOperation } from "./parser/plot/types";

export async function saveMonitorFromViewer(resultPath: string, msg: Record<string, unknown>): Promise<void> {
  const cases = findMonitorCases(resultPath);
  if (cases.length === 0) {
    void vscode.window.showInformationMessage(
      t("No case was found for this result. Monitors belong to a case: generate or run a case for the mesh first (it leaves a .kratoscase.json or .kratosrun.json beside it), or add the monitor with the case_monitors MCP tool.")
    );
    return;
  }
  let chosen = cases[0];
  if (cases.length > 1) {
    const pick = await vscode.window.showQuickPick(
      cases.map((c) => ({ label: c.stem, description: c.dir, c })),
      { title: t("Save the monitor to which case?"), placeHolder: t("More than one case is next to this result") }
    );
    if (!pick) return;
    chosen = pick.c;
  }
  const read = readMonitors(chosen.meshPath);
  for (const w of read.parsed.warnings) void vscode.window.showWarningMessage(w);
  const built = await buildSource(msg, read.parsed.monitors);
  if (!built) return;
  const name = await vscode.window.showInputBox({ title: t("Monitor name"), value: built.name, prompt: t("Shown in Kratos Runs and in exports") });
  if (name === undefined) return;
  const { monitor, problem } = validateMonitor({ id: built.id, name: name || built.name, source: built.source });
  if (!monitor) {
    void vscode.window.showErrorMessage(problem ?? t("The monitor is not valid."));
    return;
  }
  try {
    const file = writeMonitors(chosen.meshPath, upsertMonitor(read.parsed.monitors, monitor));
    void vscode.window.showInformationMessage(t("Saved monitor \"{name}\" to {file}. Evaluate it from Kratos Runs ▸ Export Monitors… or Plot Monitors.", { name: monitor.name, file: path.basename(file) }));
  } catch (err) {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}

interface BuiltMonitor {
  id: string;
  name: string;
  source: Record<string, unknown>;
}

/** Turns the viewer's message into a monitor source, asking only for what the click cannot say. */
async function buildSource(msg: Record<string, unknown>, existing: readonly { id: string }[]): Promise<BuiltMonitor | undefined> {
  const variable = String(msg.variable ?? "");
  if (msg.source === "point") {
    const coordinates = Array.isArray(msg.coordinates) ? parseXyz(msg.coordinates.join(",")) : undefined;
    if (!coordinates) {
      void vscode.window.showErrorMessage(t("The picked node has no usable coordinates."));
      return undefined;
    }
    return { ...suggestPointMonitor({ variable, coordinates }, existing), source: { type: "point", variable, coordinates } };
  }
  if (msg.source === "region") {
    const fields = (Array.isArray(msg.fields) ? msg.fields : []).filter(
      (f): f is { variable: string; kind: string; components: number } =>
        !!f && typeof f === "object" && typeof (f as { variable?: unknown }).variable === "string"
    );
    if (fields.length === 0) {
      void vscode.window.showInformationMessage(t("This mesh has no fields to monitor."));
      return undefined;
    }
    const field = await vscode.window.showQuickPick(
      fields.map((f) => ({ label: f.variable, description: `${f.kind}, ${f.components}`, f })),
      { title: t("Monitor which field?") }
    );
    if (!field) return undefined;
    const op = await vscode.window.showQuickPick(
      regionOperationsFor(Number(field.f.components) || 1).map((label) => ({ label })),
      { title: msg.submodelpart ? t("Quantity of {v} over {part}", { v: field.f.variable, part: String(msg.submodelpart) }) : t("Quantity of {v} over the whole mesh", { v: field.f.variable }) }
    );
    if (!op) return undefined;
    const operation = op.label as RegionOperation;
    const submodelpart = typeof msg.submodelpart === "string" && msg.submodelpart ? msg.submodelpart : undefined;
    const source: Record<string, unknown> = { type: "region", kind: field.f.kind, variable: field.f.variable, operation };
    if (submodelpart) source.submodelpart = submodelpart;
    if (needsReferencePoint(operation)) {
      const text = await vscode.window.showInputBox({ title: t("Moment reference point"), prompt: t("x, y, z (never assumed)"), validateInput: (v) => (parseXyz(v) ? undefined : t("Enter three numbers: x, y, z")) });
      const point = text === undefined ? undefined : parseXyz(text);
      if (!point) return undefined;
      source.referencePoint = point;
    }
    return { ...suggestRegionMonitor({ operation, variable: field.f.variable, submodelpart }, existing), source };
  }
  const spec = { kind: msg.kind as "Nodal" | "Elemental" | "Conditional", entityId: Number(msg.entityId), variable };
  return { ...suggestMonitor(spec, existing), source: { type: "history", kind: spec.kind, entityId: spec.entityId, variable } };
}
