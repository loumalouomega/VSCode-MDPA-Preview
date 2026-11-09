// Restart saving and starting from another run (roadmap item 29). Pure: no fs,
// no vscode. The fs half (terminal run, mesh identity, files present) is
// restartFile.ts. Key names follow Kratos' save_restart_process and
// RestartUtility as read from its sources; no run has verified them yet.

import type { CaseState, JsonObject, JsonValue, RestartState } from "./types";

/** Built-ins whose solver document has a `model_import_settings` Kratos can restart from. */
export const RESTART_PROBLEMTYPES: readonly string[] = ["structural", "fluid", "convectionDiffusion"];

export function supportsRestart(problemtypeId: string): boolean {
  return RESTART_PROBLEMTYPES.includes(problemtypeId);
}

/** The save_restart_process entry for `output_processes.restart_output`. */
export function restartSaveProcess(modelPartName: string, save: NonNullable<RestartState["save"]>): JsonObject {
  return {
    python_module: "save_restart_process",
    kratos_module: "KratosMultiphysics",
    process_name: "SaveRestartProcess",
    help: "This process saves restart files",
    Parameters: {
      model_part_name: modelPartName,
      restart_save_frequency: save.frequency,
      restart_control_type: save.controlType,
      save_restart_files_in_folder: true,
      max_files_to_keep: save.keep ?? -1,
    },
  };
}

/** `model_import_settings` that load a previous run's restart file. */
export function restartImportSettings(from: NonNullable<RestartState["from"]>): JsonObject {
  return {
    input_type: "rest",
    input_filename: from.inputFilename ?? "",
    restart_load_file_label: String(from.label ?? 0),
  };
}

/** Reasons the restart options cannot be applied, before any file is written. */
export function restartRefusals(problemtypeId: string, restart: RestartState | undefined): string[] {
  if (!restart || (!restart.save && !restart.from)) return [];
  const out: string[] = [];
  if (!supportsRestart(problemtypeId)) {
    out.push(`Restart is not available for the "${problemtypeId}" problemtype (supported: ${RESTART_PROBLEMTYPES.join(", ")}).`);
    return out;
  }
  if (restart.from && (!restart.from.inputFilename || restart.from.label === undefined)) {
    out.push("The restart source is not resolved: name a previous run that has restart files (resolveRestartSource).");
  }
  return out;
}

/**
 * Applies the restart options to a built solver document. Returns the document
 * unchanged when there are none; the caller has already checked `restartRefusals`.
 */
export function applyRestart(document: JsonObject, state: CaseState, modelPartName: string): JsonObject {
  const restart = state.restart;
  if (!restart || (!restart.save && !restart.from)) return document;
  const out: JsonObject = { ...document };
  if (restart.from) {
    const solver = { ...((document.solver_settings as JsonObject | undefined) ?? {}) };
    solver.model_import_settings = restartImportSettings(restart.from);
    out.solver_settings = solver;
  }
  if (restart.save) {
    const outputs = { ...((document.output_processes as JsonObject | undefined) ?? {}) };
    const existing = Array.isArray(outputs.restart_output) ? (outputs.restart_output as JsonValue[]) : [];
    outputs.restart_output = [...existing, restartSaveProcess(modelPartName, restart.save)];
    out.output_processes = outputs;
  }
  return out;
}
