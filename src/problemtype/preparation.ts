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
}

export function parsePreparationReport(text: string): PreparationReport {
  const value = JSON.parse(text);
  const revision = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const file = (v: any) => v && typeof v.name === "string" && v.name.length > 0 &&
    !/[\\/]/.test(v.name) && v.name !== "." && v.name !== ".." && revision(v.revision);
  if (!value || value.version !== 1) throw new Error("Unsupported preparation schema.");
  if (value.producer?.name !== "vscode-mdpa.case-generator" || !revision(value.producer.scriptRevision) ||
      !["builtin", "js", "py"].includes(value.producer.source) || typeof value.problemtype !== "string" ||
      !file(value.sourceMesh) || !file(value.solverMesh) || !Array.isArray(value.inputs) || !value.inputs.every(file) ||
      new Set(value.inputs.map((v: any) => v.name)).size !== value.inputs.length ||
      !value.inputs.some((v: any) => v.name === "MainKratos.py" && v.revision === value.producer.scriptRevision) ||
      !value.inputs.some((v: any) => v.name === "ProjectParameters.json") ||
      !value.settings || value.settings.problemtypeId !== value.problemtype ||
      value.settingsRevision !== hash(JSON.stringify(value.settings)) ||
      !value.effectiveParameters || typeof value.effectiveParameters !== "object" || Array.isArray(value.effectiveParameters) ||
      value.units?.state !== "undeclared" || typeof value.units.reason !== "string" ||
      !Array.isArray(value.findings) || !value.findings.every((v: any) => v?.severity === "warning" && typeof v.message === "string")) {
    throw new Error("Malformed preparation report.");
  }
  return value as PreparationReport;
}

export function writePreparedCase(options: {
  directory: string; sourcePath: string; solverMeshPath: string;
  runtime: ProblemtypeRuntime; state: CaseState; generated: GeneratedCase; warnings: string[];
}): { written: string[]; preparation: PreparationReport } {
  const { directory, generated, runtime, state } = options;
  const manifest = path.join(directory, PREPARATION_FILE);
  if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).version !== 1) {
    throw new Error("Unsupported preparation schema; existing evidence was not overwritten.");
  }
  const documents: [string, string][] = [
    ["ProjectParameters.json", generated.projectParameters],
    [generated.materialsFileName, generated.materials], ["MainKratos.py", generated.mainScript],
  ];
  const mesh = (file: string) => ({ name: path.basename(file), revision: hash(fs.readFileSync(file)) });
  const preparation: PreparationReport = {
    version: 1, producer: { name: "vscode-mdpa.case-generator", source: runtime.source, scriptRevision: hash(generated.mainScript) },
    problemtype: runtime.decl.id, sourceMesh: mesh(options.sourcePath), solverMesh: mesh(options.solverMeshPath),
    settings: structuredClone(state), settingsRevision: hash(JSON.stringify(state)),
    effectiveParameters: JSON.parse(generated.projectParameters),
    units: { state: "undeclared", reason: "This case has no declared unit system. Mesh, material and load values must use consistent units; no conversion was inferred." },
    findings: [...new Set([...options.warnings, ...generated.warnings])].map(message => ({ severity: "warning", message })),
    inputs: documents.map(([name, content]) => ({ name, revision: hash(content) })),
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
