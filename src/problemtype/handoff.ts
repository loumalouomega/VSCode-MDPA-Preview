/**
 * The consuming half of CAD-Preview's simulation handoff (roadmap item 6,
 * "CAD handoff consumption").
 *
 * CAD-Preview writes `<exported mesh>.handoff.json` beside the mesh it exported:
 * which Parts the model had, which physical groups each one became, the unit and
 * scale factor, and the output hashes. This module reads that receipt and turns
 * it into preflight findings for the case built on top of the mesh — it never
 * infers ownership from a file name, never writes the manifest, and never judges
 * coverage: it reports what the export says, and what the case's assignments do
 * with it.
 *
 * The manifest is FOREIGN input (another extension's file, possibly written on
 * another machine), so parsing is tolerant in exactly the way `parseRunJson` is:
 * anything that is not a v1 handoff degrades to a warning, never a throw.
 *
 * Pure (no fs, no vscode): the file half lives in `handoffFile.ts`, so
 * `preflight.ts` keeps its no-fs promise and the sidebar and `case_validate`
 * share one rulebook.
 */

import * as path from "node:path";

import type { MdpaModel } from "../parser/types";
import type { CaseState } from "./types";
import type { Finding } from "./preflight";

/** Appended to the exported mesh's full name: `beam.vtk` → `beam.vtk.handoff.json`. */
export const HANDOFF_SUFFIX = ".handoff.json";

export interface HandoffGroup {
  dim: number;
  physicalTag: number;
  entityCount: number;
  elementCount: number;
}

export interface HandoffPart {
  name: string;
  /** `empty`: the Part had no entities; `unresolved`: entities landed in no group. */
  status: "resolved" | "unresolved" | "empty";
  groups: HandoffGroup[];
}

/** The fields this consumer uses; everything else in the file is ignored. */
export interface HandoffManifest {
  version: 1;
  kind: "cad-preview-handoff";
  source: { path: string; format: string; sha256: string };
  replay: { fingerprint: string };
  /** Geometry AND mesh sizes were scaled by `scaleFactor` into `unit` at export. */
  unit: { unit: string; scaleFactor: number };
  mesh: { nodeCount: number; elementCount: number };
  outputs: Array<{ path: string; format: string; sha256: string }>;
  parts: HandoffPart[];
  coverage: {
    emptyParts: string[];
    unresolvedParts: string[];
    unassignedSurfaceCount: number;
    unassignedSurfaceTags: number[];
    overlaps: Array<{ dim: number; entityTag: number; groups: string[] }>;
  };
  notes: string[];
}

/** What was found beside one mesh: a manifest, why there is none, or neither. */
export interface HandoffRead {
  /** The manifest path that was looked for. */
  path: string;
  manifest?: HandoffManifest;
  /** Set when the file exists but is not a usable v1 handoff. */
  problem?: string;
  /** SHA-256 of the mesh bytes — the output revision the manifest records. */
  meshRevision?: string;
}

/** The handoff manifest beside a mesh file: `<mesh>.handoff.json`. */
export function handoffPath(meshFsPath: string): string {
  return `${meshFsPath}${HANDOFF_SUFFIX}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Tolerant parse of a v1 handoff. Returns null for anything else, so a stray
 * JSON file named like a manifest is reported rather than misread.
 */
export function parseHandoff(text: string): HandoffManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.kind !== "cad-preview-handoff" || raw.version !== 1) return null;
  if (!Array.isArray(raw.outputs) || !Array.isArray(raw.parts)) return null;
  if (!isObject(raw.source) || typeof raw.source.sha256 !== "string") return null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const outputs = raw.outputs
    .filter((o): o is Record<string, unknown> => isObject(o) && typeof o.path === "string")
    .map((o) => ({ path: o.path as string, format: typeof o.format === "string" ? o.format : "", sha256: typeof o.sha256 === "string" ? o.sha256 : "" }));
  const parts: HandoffPart[] = raw.parts
    .filter((p): p is Record<string, unknown> => isObject(p) && typeof p.name === "string" && p.name.length > 0)
    .map((p) => ({
      name: p.name as string,
      status: p.status === "resolved" || p.status === "unresolved" || p.status === "empty" ? p.status : "unresolved",
      groups: Array.isArray(p.groups)
        ? p.groups.filter(isObject).map((g) => ({
            dim: number(g.dim),
            physicalTag: number(g.physicalTag),
            entityCount: number(g.entityCount),
            elementCount: number(g.elementCount),
          }))
        : [],
    }));
  const coverage = isObject(raw.coverage) ? raw.coverage : {};
  const mesh = isObject(raw.mesh) ? raw.mesh : {};
  const unit = isObject(raw.unit) ? raw.unit : {};
  const replay = isObject(raw.replay) ? raw.replay : {};
  return {
    version: 1,
    kind: "cad-preview-handoff",
    source: { path: typeof raw.source.path === "string" ? raw.source.path : "", format: typeof raw.source.format === "string" ? raw.source.format : "", sha256: raw.source.sha256 },
    replay: { fingerprint: typeof replay.fingerprint === "string" ? replay.fingerprint : "" },
    unit: { unit: typeof unit.unit === "string" ? unit.unit : "", scaleFactor: number(unit.scaleFactor) || 1 },
    mesh: { nodeCount: number(mesh.nodeCount), elementCount: number(mesh.elementCount) },
    outputs,
    parts,
    coverage: {
      emptyParts: strings(coverage.emptyParts),
      unresolvedParts: strings(coverage.unresolvedParts),
      unassignedSurfaceCount: number(coverage.unassignedSurfaceCount),
      unassignedSurfaceTags: Array.isArray(coverage.unassignedSurfaceTags)
        ? coverage.unassignedSurfaceTags.filter((t): t is number => typeof t === "number")
        : [],
      overlaps: Array.isArray(coverage.overlaps)
        ? coverage.overlaps.filter(isObject).map((o) => ({
            dim: number(o.dim),
            entityTag: number(o.entityTag),
            groups: strings(o.groups),
          }))
        : [],
    },
    notes: strings(raw.notes),
  };
}

/**
 * Cross-platform basename: a handoff written on Windows names `C:\cad\beam.vtk`
 * even when read on Linux, so both separators are honored.
 */
function baseName(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? "";
  return name === "." || name === ".." ? "" : name;
}

/** The output entry describing this mesh: by basename, so a moved project still matches. */
export function handoffOutput(manifest: HandoffManifest, meshFsPath: string): { path: string; sha256: string } | undefined {
  const name = baseName(meshFsPath);
  return manifest.outputs.find((o) => baseName(o.path) === name);
}

/**
 * The identity a preparation manifest records for a CAD export: the CAD
 * document's name and content revision, plus the replay fingerprint when the
 * export had one. Identity only — never a path — so a run directory stays
 * relocatable, and nothing is upgraded by hashing today's CAD file. Undefined
 * when the export recorded no source revision: the report must never claim an
 * identity the manifest does not state.
 */
export function handoffIdentity(manifest: HandoffManifest): { source: string; sourceRevision: string; replay?: string } | undefined {
  if (!manifest.source.sha256) return undefined;
  return {
    source: baseName(manifest.source.path) || "cad-document",
    sourceRevision: manifest.source.sha256,
    ...(manifest.replay.fingerprint ? { replay: manifest.replay.fingerprint } : {}),
  };
}

/** True when the case assigns at least one condition that acts on a surface. */
function hasSurfaceConditions(state: CaseState, surfaceConditionIds: ReadonlySet<string>): boolean {
  return state.assignments.some((a) => surfaceConditionIds.has(a.conditionId));
}

/**
 * Turns one handoff beside one mesh into findings for the case built on it.
 *
 * Codes:
 *  - `handoff-unreadable`      the file exists but is not a usable v1 handoff
 *  - `handoff-stale`           the mesh is not the export the manifest describes
 *  - `handoff-unlisted`        counts match, but the manifest names no such output
 *  - `handoff-part-unresolved` a CAD Part the case assigns to resolved to nothing
 *  - `handoff-coverage`        boundary surfaces in no Part group
 *  - `handoff-overlap`         an entity belongs to more than one Part group
 *  - `handoff-units`           the export scaled geometry; this case declares none
 *
 * Nothing is reported about a manifest that does not exist, and nothing is
 * reported twice in two wordings: `smp-missing`/`part-empty` keep their own
 * findings, and these carry the provenance those cannot state.
 */
export function handoffFindings(
  read: HandoffRead,
  model: MdpaModel,
  state: CaseState,
  options: { surfaceConditionIds?: ReadonlySet<string> } = {}
): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Finding["severity"], code: string, message: string, target?: Finding["target"]): void => {
    out.push(target ? { severity, code, message, target } : { severity, code, message });
  };
  if (read.problem) {
    add("warning", "handoff-unreadable", read.problem);
    return out;
  }
  const manifest = read.manifest;
  if (!manifest) return out;
  const name = path.basename(read.path);

  // --- Is this mesh the export the manifest describes? ---
  const counts = { nodes: model.nodeCount, elements: model.blocks.reduce((n, b) => n + b.count, 0) };
  const output = handoffOutput(manifest, read.path.slice(0, -HANDOFF_SUFFIX.length));
  const countMismatch = (manifest.mesh.nodeCount > 0 && manifest.mesh.nodeCount !== counts.nodes) ||
    (manifest.mesh.elementCount > 0 && manifest.mesh.elementCount !== counts.elements);
  const hashMismatch = output !== undefined && output.sha256 !== "" && read.meshRevision !== undefined &&
    output.sha256 !== read.meshRevision;
  if (countMismatch) {
    add("warning", "handoff-stale",
      `This mesh has ${counts.nodes} nodes and ${counts.elements} elements, but ${name} describes an export of ` +
        `${manifest.mesh.nodeCount} nodes and ${manifest.mesh.elementCount} elements. The case's group assignments may ` +
        `describe an earlier mesh; re-export or review them.`);
  } else if (hashMismatch) {
    add("warning", "handoff-stale",
      `This mesh is not byte-identical to the export ${name} recorded, so it was remeshed or edited after the handoff. ` +
        `Its Part→group assignments may be stale; re-export or review them.`);
  } else if (!output) {
    const countsRecorded = manifest.mesh.nodeCount > 0 || manifest.mesh.elementCount > 0;
    add("info", "handoff-unlisted",
      `${name} lists no output named like this mesh` +
        (countsRecorded ? ", although no count it records disagrees" : " and records no counts to check") +
        `. Treat its group assignments as advisory.`);
  }

  // --- Parts the case assigns to that the CAD model could not resolve. ---
  const referenced = [...new Set([...state.assignments.map((a) => a.smpPath), ...state.materials.map((m) => m.smpPath)])];
  const references = (part: string): boolean => referenced.some((p) => p === part || p.startsWith(`${part}/`));
  for (const part of manifest.parts) {
    if (part.status === "resolved" || !references(part.name)) continue;
    add("warning", "handoff-part-unresolved",
      part.status === "empty"
        ? `CAD Part "${part.name}" had no entities when this mesh was exported, but the case assigns to it, so those assignments have nothing to act on.`
        : `CAD Part "${part.name}" resolved to no physical group when this mesh was exported, but the case assigns to it, so those assignments have nothing to act on.`,
      { smpPath: part.name });
  }

  // --- Coverage facts, which the export states and cannot judge. ---
  if (manifest.coverage.unassignedSurfaceCount > 0) {
    const surfaces = hasSurfaceConditions(state, options.surfaceConditionIds ?? new Set());
    add(surfaces ? "warning" : "info", "handoff-coverage",
      `${manifest.coverage.unassignedSurfaceCount} boundary surface(s) of the CAD export belong to no Part group` +
        `${surfaces ? ", so surface conditions cannot be assigned to them" : ""}.`,
      manifest.coverage.unassignedSurfaceTags.length > 0
        ? { entityIds: manifest.coverage.unassignedSurfaceTags.slice(0, 8) }
        : undefined);
  }
  if (manifest.coverage.overlaps.length > 0) {
    const groups = [...new Set(manifest.coverage.overlaps.flatMap((o) => o.groups))].slice(0, 6);
    add("warning", "handoff-overlap",
      `${manifest.coverage.overlaps.length} entit(ies) belong to more than one Part group` +
        `${groups.length > 0 ? ` (${groups.map((g) => `"${g}"`).join(", ")})` : ""}; an assignment on one may also cover the other.`,
      { entityIds: manifest.coverage.overlaps.map((o) => o.entityTag).slice(0, 8) });
  }

  // --- Units: only a conversion is worth stating; "m, ×1" is the norm. ---
  if (manifest.unit.scaleFactor !== 1) {
    add("info", "handoff-units",
      `This case declares no unit system. Geometry and mesh sizes were scaled by ${manifest.unit.scaleFactor} ` +
        `into ${manifest.unit.unit || "the export unit"} at export. Keep mesh, material and load values consistent with it.`);
  }
  return out;
}
