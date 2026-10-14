/** Portable, versioned evidence shared by host and MCP case generation. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CaseState, GeneratedCase, ProblemtypeRuntime } from "./types";

export const PREPARATION_FILE = "kkss-preparation-v1.json";
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export interface PreparationReport {
  version: 1;
  producer: { name: "vscode-mdpa.case-generator"; source: string; scriptRevision: string };
  problemtype: string;
  sourceMesh: { name: string; revision: string };
  solverMesh: { name: string; revision: string };
  settings: CaseState;
  settingsRevision: string;
  effectiveParameters: unknown;
  units: { state: "undeclared"; reason: string };
  findings: { severity: "warning"; message: string }[];
  inputs: { name: string; revision: string }[];
  /**
   * The primary document and driver script this case was written with. Absent in
   * a report from before a problemtype could name its own, which means the
   * single-physics names.
   */
  primaryDocument?: string;
  driverScript?: string;
  /**
   * Which run of which study produced this case, when it was prepared inside an
   * isolated run workspace. `runId` is the execution receipt's `requestId` (no
   * second registry); `clonedFrom` names the earlier run whose settings this one
   * started from, as a label — it never makes the earlier run's files an input.
   * Identity only, never a path, so a run directory stays relocatable.
   */
  run?: PreparationRun;
}

export interface PreparationRun { runId: string; studyId?: string; clonedFrom?: string }
const RUN_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const isRunIdentity = (v: unknown): v is string => typeof v === "string" && RUN_IDENTITY.test(v);

export function parsePreparationReport(text: string): PreparationReport {
  const value = JSON.parse(text);
  const revision = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const file = (v: any) => v && typeof v.name === "string" && v.name.length > 0 &&
    !/[\\/]/.test(v.name) && v.name !== "." && v.name !== ".." && revision(v.revision);
  const plainName = (v: unknown) => typeof v === "string" && v.length > 0 && !/[\\/]/.test(v) && v !== "." && v !== "..";
  if (!value || value.version !== 1) throw new Error("Unsupported preparation schema.");
  const primary = value.primaryDocument ?? "ProjectParameters.json";
  const driver = value.driverScript ?? "MainKratos.py";
  if (value.producer?.name !== "vscode-mdpa.case-generator" || !revision(value.producer.scriptRevision) ||
      !["builtin", "js", "py"].includes(value.producer.source) || typeof value.problemtype !== "string" ||
      !file(value.sourceMesh) || !file(value.solverMesh) || !Array.isArray(value.inputs) || !value.inputs.every(file) ||
      new Set(value.inputs.map((v: any) => v.name)).size !== value.inputs.length ||
      !plainName(primary) || !plainName(driver) ||
      !value.inputs.some((v: any) => v.name === driver && v.revision === value.producer.scriptRevision) ||
      !value.inputs.some((v: any) => v.name === primary) ||
      !value.settings || value.settings.problemtypeId !== value.problemtype ||
      value.settingsRevision !== hash(JSON.stringify(value.settings)) ||
      !value.effectiveParameters || typeof value.effectiveParameters !== "object" || Array.isArray(value.effectiveParameters) ||
      value.units?.state !== "undeclared" || typeof value.units.reason !== "string" ||
      !Array.isArray(value.findings) || !value.findings.every((v: any) => v?.severity === "warning" && typeof v.message === "string") ||
      (value.run !== undefined && !(isRunIdentity(value.run?.runId) &&
        (value.run.studyId === undefined || isRunIdentity(value.run.studyId)) &&
        (value.run.clonedFrom === undefined || isRunIdentity(value.run.clonedFrom))))) {
    throw new Error("Malformed preparation report.");
  }
  return value as PreparationReport;
}

/**
 * The primary document and driver a case was generated with, read from its
 * preparation record. A missing or unreadable record means the single-physics names.
 */
export function preparedNames(directory: string): { primaryDocument: string; driverScript: string } {
  const fallback = { primaryDocument: "ProjectParameters.json", driverScript: "MainKratos.py" };
  try {
    const report = parsePreparationReport(fs.readFileSync(path.join(directory, PREPARATION_FILE), "utf8"));
    return {
      primaryDocument: report.primaryDocument ?? fallback.primaryDocument,
      driverScript: report.driverScript ?? fallback.driverScript,
    };
  } catch {
    return fallback;
  }
}

export function writePreparedCase(options: {
  directory: string; sourcePath: string; solverMeshPath: string;
  runtime: ProblemtypeRuntime; state: CaseState; generated: GeneratedCase; warnings: string[];
  /** The other physics domains' mesh files (a coupled case); recorded as inputs. */
  extraMeshPaths?: string[];
  /** Identity of the isolated run this case is prepared for; omitted for an ordinary case. */
  run?: PreparationRun;
}): { written: string[]; preparation: PreparationReport } {
  const { directory, generated, runtime, state } = options;
  const manifest = path.join(directory, PREPARATION_FILE);
  if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).version !== 1) {
    throw new Error("Unsupported preparation schema; existing evidence was not overwritten.");
  }
  const documents: [string, string][] = [
    [generated.primaryDocumentName, generated.projectParameters],
    [generated.materialsFileName, generated.materials], [generated.driverScriptName, generated.mainScript],
    ...(generated.extraFiles ?? []).map((f): [string, string] => [f.name, f.content]),
  ];
  const mesh = (file: string) => ({ name: path.basename(file), revision: hash(fs.readFileSync(file)) });
  const preparation: PreparationReport = {
    version: 1, producer: { name: "vscode-mdpa.case-generator", source: runtime.source, scriptRevision: hash(generated.mainScript) },
    problemtype: runtime.decl.id, sourceMesh: mesh(options.sourcePath), solverMesh: mesh(options.solverMeshPath),
    primaryDocument: generated.primaryDocumentName, driverScript: generated.driverScriptName,
    ...(options.run ? { run: { ...options.run } } : {}),
    settings: structuredClone(state), settingsRevision: hash(JSON.stringify(state)),
    effectiveParameters: JSON.parse(generated.projectParameters),
    units: { state: "undeclared", reason: "This case has no declared unit system. Mesh, material and load values must use consistent units; no conversion was inferred." },
    findings: [...new Set([...options.warnings, ...generated.warnings])].map(message => ({ severity: "warning", message })),
    inputs: [
      ...documents.map(([name, content]) => ({ name, revision: hash(content) })),
      ...(options.extraMeshPaths ?? []).map(mesh),
    ],
  };
  const written = documents.map(([name, content]) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, content); return file;
  });
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(preparation, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temporary, manifest);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { written: [...written, manifest], preparation };
}
