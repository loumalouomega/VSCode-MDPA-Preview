/**
 * CaseState (de)serialization for the `<stem>.kratoscase.json` file written
 * next to the mdpa. Tolerant like the ops-recipe reader in parser/operations.ts:
 * malformed pieces degrade to defaults with warnings instead of throwing.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import { Assignment, CaseState, JsonValue, MaterialAssignment, OutputState } from "./types";

const CASE_VERSION = 1;

/** Serializes a case state to the pretty JSON stored on disk. */
export function serializeCase(state: CaseState): string {
  return JSON.stringify({ ...state, version: CASE_VERSION }, null, 2) + "\n";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readValues(raw: unknown): Record<string, Record<string, JsonValue>> {
  const out: Record<string, Record<string, JsonValue>> = {};
  if (!isRecord(raw)) return out;
  for (const [section, fields] of Object.entries(raw)) {
    if (isRecord(fields)) out[section] = { ...(fields as Record<string, JsonValue>) };
  }
  return out;
}

function readAssignments(raw: unknown, warnings: string[], what: string): Assignment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`"${what}" is not an array — ignored.`);
    return [];
  }
  const out: Assignment[] = [];
  for (const entry of raw) {
    const a = entry as { conditionId?: unknown; smpPath?: unknown; values?: unknown };
    if (typeof a?.conditionId === "string" && typeof a?.smpPath === "string") {
      out.push({
        conditionId: a.conditionId,
        smpPath: a.smpPath,
        values: isRecord(a.values) ? ({ ...a.values } as Record<string, JsonValue>) : {},
      });
    } else {
      warnings.push(`Skipped a malformed entry in "${what}".`);
    }
  }
  return out;
}

function readMaterials(raw: unknown, warnings: string[]): MaterialAssignment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`"materials" is not an array — ignored.`);
    return [];
  }
  const out: MaterialAssignment[] = [];
  for (const entry of raw) {
    const m = entry as { smpPath?: unknown; lawId?: unknown; values?: unknown };
    if (typeof m?.smpPath === "string" && typeof m?.lawId === "string") {
      out.push({
        smpPath: m.smpPath,
        lawId: m.lawId,
        values: isRecord(m.values) ? ({ ...m.values } as Record<string, JsonValue>) : {},
      });
    } else {
      warnings.push(`Skipped a malformed entry in "materials".`);
    }
  }
  return out;
}

function readOutput(raw: unknown): OutputState {
  const o = isRecord(raw) ? raw : {};
  const interval = Number(o.interval);
  return {
    format: o.format === "binary" ? "binary" : "ascii",
    controlType: o.controlType === "time" ? "time" : "step",
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    nodalVariables: Array.isArray(o.nodalVariables)
      ? o.nodalVariables.filter((v): v is string => typeof v === "string")
      : [],
  };
}

/** Parses a case file; returns undefined state when nothing usable is inside. */
export function parseCaseJson(text: string): { state?: CaseState; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { warnings: ["Case file is not valid JSON."] };
  }
  if (!isRecord(raw)) return { warnings: ["Case file is not a JSON object."] };
  if (typeof raw.problemtypeId !== "string" || raw.problemtypeId.length === 0) {
    return { warnings: ["Case file has no problemtypeId."] };
  }
  if (typeof raw.version === "number" && raw.version > CASE_VERSION) {
    warnings.push(`Case file version ${raw.version} is newer than supported (${CASE_VERSION}).`);
  }
  return {
    state: {
      version: CASE_VERSION,
      problemtypeId: raw.problemtypeId,
      values: readValues(raw.values),
      assignments: readAssignments(raw.assignments, warnings, "assignments"),
      materials: readMaterials(raw.materials, warnings),
      output: readOutput(raw.output),
    },
    warnings,
  };
}
