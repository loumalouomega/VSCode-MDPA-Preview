/**
 * CaseState (de)serialization for the `<stem>.kratoscase.json` file written
 * next to the mdpa. Tolerant like the ops-recipe reader in parser/operations.ts:
 * malformed pieces degrade to defaults with warnings instead of throwing.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable.
 */

import * as path from "node:path";

import { meshStem } from "../parser/meshFormats";
import { Assignment, CaseState, JsonValue, MaterialAssignment, OutputState } from "./types";
import type { MaterialPresetSnapshot, MaterialReference, MaterialSource } from "./materialCatalog";

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

/**
 * The catalog row a material was filled from. Optional in every direction: a
 * case written before the catalog existed, and a material typed by hand, both
 * simply have none.
 */
function readPresetSnapshot(raw: unknown, warnings: string[]): MaterialPresetSnapshot | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push("Skipped a malformed material preset snapshot.");
    return undefined;
  }
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || !isRecord(raw.values)) {
    warnings.push("Skipped a material preset snapshot without an id, name and values.");
    return undefined;
  }
  // A snapshot written by hand may carry no source block; it still names
  // itself, so it is kept rather than dropped for a missing citation.
  const source: MaterialSource =
    isRecord(raw.source) && typeof raw.source.name === "string" ? (raw.source as unknown as MaterialSource) : { name: raw.name };
  return {
    id: raw.id,
    name: raw.name,
    laws: Array.isArray(raw.laws) ? raw.laws.filter((l): l is string => typeof l === "string") : [],
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    origin: raw.origin === "builtin" ? "builtin" : "user",
    source,
    ...(isRecord(raw.reference) ? { reference: raw.reference as unknown as MaterialReference } : {}),
    values: { ...(raw.values as Record<string, JsonValue>) },
  };
}

function readMaterials(raw: unknown, warnings: string[]): MaterialAssignment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`"materials" is not an array — ignored.`);
    return [];
  }
  const out: MaterialAssignment[] = [];
  for (const entry of raw) {
    const m = entry as { smpPath?: unknown; lawId?: unknown; values?: unknown; preset?: unknown };
    if (typeof m?.smpPath === "string" && typeof m?.lawId === "string") {
      const preset = readPresetSnapshot(m.preset, warnings);
      out.push({
        smpPath: m.smpPath,
        lawId: m.lawId,
        values: isRecord(m.values) ? ({ ...m.values } as Record<string, JsonValue>) : {},
        ...(preset ? { preset } : {}),
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
      ...(isRecord(raw.outputProcesses) ? { outputProcesses: raw.outputProcesses as import("./types").JsonObject } : {}),
    },
    warnings,
  };
}

// ---- sidecar paths ----------------------------------------------------------
//
// Every per-mesh sidecar is `<dir>/<stem>.<something>` next to the mesh. The
// case path used to be spelled out in three places (the MCP tools, the
// controller and the problem archive); these are the one authority, so a
// fourth sidecar cannot quietly disagree about where it lives.
//
// `node:path` is safe here: the webview imports only `problemtype/types`, never
// this module, so this cannot reach the browser bundle the way it would from
// `parser/operations.ts`.

/**
 * `<dir>/<stem>` for a mesh path — the stem every sidecar name is built on.
 *
 * Uses `meshStem`, not `path.basename(p, path.extname(p))`: the latter yields
 * `case.post` for `case.post.msh`, and the next sidecar would be
 * `case.post.kratoscase.json`. Case files attach to any mesh format, so the
 * helper must be right for every extension, not just `.mdpa`.
 */
function sidecarBase(meshFsPath: string): string {
  const resolved = path.resolve(meshFsPath);
  return path.join(path.dirname(resolved), meshStem(resolved));
}

/** The saved problemtype setup: `<stem>.kratoscase.json`. */
export function caseFilePath(meshFsPath: string): string {
  return `${sidecarBase(meshFsPath)}.kratoscase.json`;
}

/**
 * The saved view state: `<stem>.kratosview.json` (roadmap items 3–4).
 * Today it carries only the user `layers` list; item 3 will add
 * camera/field/clip/layout keys alongside it. One authority with the case/run
 * paths above so a fifth sidecar cannot quietly disagree about where it lives.
 */
export function viewFilePath(meshFsPath: string): string {
  return `${sidecarBase(meshFsPath)}.kratosview.json`;
}

/** The latest run's status record: `<stem>.kratosrun.json`. */
export function runFilePath(meshFsPath: string): string {
  return `${sidecarBase(meshFsPath)}.kratosrun.json`;
}

/** Where a detached run tees its output: `<stem>.kratosrun.log`. */
export function runLogPath(meshFsPath: string): string {
  return `${sidecarBase(meshFsPath)}.kratosrun.log`;
}
