/**
 * The MCP tool handler core: path-based tools over the pure parser/problemtype
 * modules. Every handler takes plain-JSON args, does its own fs I/O, and
 * returns a plain-JSON summary (never a raw MdpaModel — its typed arrays would
 * be mangled by JSON.stringify).
 *
 * Pure-ish module: no vscode / DOM / vtk.js and no MCP-SDK imports, so it
 * compiles under tsconfig.test.json and the tests call the handlers directly.
 * The SDK/zod wiring lives in src/mcp/register.ts; the stdio entry in
 * src/mcpServer.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MdpaModel, EntityBlock, SubModelPart, EntityKind } from "../parser/types";
import { parseMdpa } from "../parser/mdpaParser";
import { parseMeshFile, readMeshTimeSteps } from "../parser/meshFileParser";
import { IN_FILE_TIMELINE_EXTENSIONS, SUPPORTED_MESH_EXTENSIONS } from "../parser/meshFormats";
import {
  isMeshioReadExtension,
  MESHIO_READ_EXTENSIONS,
} from "../parser/meshioFormats";
import {
  OpRecord,
  OP_LABELS,
  applyOpAsync,
  isAsyncOp,
  opRecordFromMessage,
  parseOpsJson,
} from "../parser/operations";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import {
  EXPORTABLE_EXTENSIONS,
  isExportableExtension,
} from "../parser/writers/exportFormats";
import { extractSubModelPart, findSubModelPart } from "../parser/subModelPartExtract";
import { computeMeshQuality } from "../parser/meshQuality";
import { computeMeshSize } from "../parser/meshSize";
import { CaseState, ProblemtypeRuntime, ProblemtypeSource } from "../problemtype/types";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import {
  generateCase,
  resolveDomainSize,
  subModelPartPaths,
} from "../problemtype/generate";
import { defaultCaseState, flattenValues, resolveMeshNaming } from "../problemtype/api";
import { adaptMeshNames } from "../problemtype/meshAdapt";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import { parseCaseJson, serializeCase } from "../problemtype/caseFile";
import {
  PROBLEM_MANIFEST_NAME,
  buildProblemZip,
  parseProblemZip,
  isSafeEntryName,
} from "../parser/problemZip";
import { collectProblemFiles } from "../problemFiles";

// --- progress -------------------------------------------------------------

let progressSink: ((line: string) => void) | undefined;

/** Routes MMG progress lines somewhere (the server entry sends MCP log messages). */
export function setProgressSink(sink: ((line: string) => void) | undefined): void {
  progressSink = sink;
}

// --- model cache ------------------------------------------------------------

interface CachedMesh {
  mtimeMs: number;
  size: number;
  model: MdpaModel;
  /** Original text, kept for .mdpa only (lossless Properties/Table round-trips). */
  sourceText?: string;
}

const CACHE_MAX = 4;
const meshCache = new Map<string, CachedMesh>();

function invalidateCache(fsPath: string): void {
  meshCache.delete(path.resolve(fsPath));
}

/**
 * Parses a mesh file (any supported format incl. .mdpa) with an mtime-keyed LRU.
 *
 * `inputFormat` forces a meshio++ reader key (e.g. "ansys", "freefem",
 * "ansysinp"), which no extension defaults to. `timeStep` selects a step of a
 * multi-step meshio++ file (Exodus, since meshio++ >= 8.6.0); 0 is the first
 * step, so it is treated the same as "unset" for cache purposes. Either
 * bypasses the cache in both directions: the key is path+mtime+size and
 * distinguishes neither format nor step, so a cached parse under different
 * ones must not be served — nor stored, where it would shadow the default.
 */
export async function loadMesh(
  fsPath: string,
  inputFormat?: string,
  timeStep?: number
): Promise<{ model: MdpaModel; ext: string; sourceText?: string }> {
  const abs = path.resolve(fsPath);
  const ext = path.extname(abs).toLowerCase();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  if (inputFormat && !isMeshioReadExtension(ext)) {
    // Rather than silently parse with the extension's own parser: only the
    // meshio++ formats have a selectable reader.
    throw new Error(
      `inputFormat="${inputFormat}" does not apply to "${ext}", which has its own parser. ` +
        `It is only accepted for the extended formats: ${MESHIO_READ_EXTENSIONS.join(", ")}`
    );
  }
  if (timeStep !== undefined && !isMeshioReadExtension(ext)) {
    throw new Error(
      `timeStep is only accepted for the extended formats with a time series ` +
        `(currently Exodus): ${MESHIO_READ_EXTENSIONS.join(", ")}`
    );
  }
  const bypassCache = Boolean(inputFormat) || (timeStep !== undefined && timeStep !== 0);
  const hit = bypassCache ? undefined : meshCache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    meshCache.delete(abs); // refresh LRU order
    meshCache.set(abs, hit);
    return { model: hit.model, ext, sourceText: hit.sourceText };
  }
  let model: MdpaModel;
  let sourceText: string | undefined;
  if (ext === ".mdpa") {
    sourceText = fs.readFileSync(abs, "utf8");
    model = parseMdpa(sourceText);
  } else if (SUPPORTED_MESH_EXTENSIONS.includes(ext)) {
    model = await parseMeshFile(abs, undefined, { meshioFormat: inputFormat, timeStep });
  } else {
    throw new Error(
      `Unsupported mesh format "${ext}". Supported: .mdpa, ${SUPPORTED_MESH_EXTENSIONS.join(", ")}`
    );
  }
  if (bypassCache) return { model, ext, sourceText };
  meshCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, model, sourceText });
  while (meshCache.size > CACHE_MAX) {
    const oldest = meshCache.keys().next().value as string;
    meshCache.delete(oldest);
  }
  return { model, ext, sourceText };
}

// --- summaries --------------------------------------------------------------

function blockSummary(b: EntityBlock): object {
  return { kind: b.kind, name: b.name, count: b.count, stride: b.stride, vtkCellType: b.vtkCellType };
}

function smpTree(p: SubModelPart): object {
  return {
    name: p.name,
    path: p.path,
    counts: {
      nodes: p.nodeIds.length,
      elements: p.elementIds.length,
      conditions: p.conditionIds.length,
      geometries: p.geometryIds.length,
    },
    children: p.children.map(smpTree),
  };
}

function countByKind(model: MdpaModel, kind: EntityKind): number {
  return model.blocks.filter((b) => b.kind === kind).reduce((n, b) => n + b.count, 0);
}

const DIAG_LIMIT = 20;

// --- mesh tools -------------------------------------------------------------

export async function meshInfo(args: {
  path: string;
  inputFormat?: string;
  /** Selects a step of a multi-step meshio++ file (Exodus, since meshio++ >= 8.6.0). */
  timeStep?: number;
}): Promise<object> {
  const { model, ext } = await loadMesh(args.path, args.inputFormat, args.timeStep);
  // Gated on IN_FILE_TIMELINE_EXTENSIONS (currently Exodus only), not every
  // meshio format: Exodus's readMetadata always falls back to a full read
  // (no native metadata path), so calling it for the other ~38 meshio
  // formats — none of which carry a time series — would double the read
  // cost of every meshInfo call for no benefit.
  const timeValues = IN_FILE_TIMELINE_EXTENSIONS.includes(ext)
    ? await readMeshTimeSteps(args.path)
    : [];
  return {
    path: path.resolve(args.path),
    format: ext,
    nodeCount: model.nodeCount,
    elementCount: countByKind(model, "Elements"),
    conditionCount: countByKind(model, "Conditions"),
    geometryCount: countByKind(model, "Geometries"),
    is3D: model.is3D,
    bounds: model.bounds,
    blocks: model.blocks.map(blockSummary),
    subModelParts: model.subModelParts.map(smpTree),
    fields: model.fields.map((f) => ({
      variable: f.variable,
      kind: f.kind,
      components: f.components,
      count: f.ids.length,
    })),
    ...(timeValues.length > 0 ? { timeStep: args.timeStep ?? 0, timeValues } : {}),
    diagnostics: {
      total: model.diagnostics.length,
      first: model.diagnostics.slice(0, DIAG_LIMIT),
    },
  };
}

export async function meshQuality(args: {
  path: string;
  badIdLimit?: number;
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const limit = args.badIdLimit ?? 20;
  const report = computeMeshQuality(model);
  return {
    overallOk: report.overallOk,
    elementCount: report.elementCount,
    analyzedCount: report.analyzedCount,
    elementTypes: report.elementTypes,
    metrics: report.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      unit: m.unit,
      min: m.min,
      mean: m.mean,
      max: m.max,
      higherIsBetter: m.higherIsBetter,
      thresholds: m.thresholds,
      bandPct: m.bandPct,
      failed: m.failed,
      badEntityIds: m.badEntityIds.slice(0, limit),
      badEntityTotal: m.badEntityIds.length,
    })),
  };
}

/**
 * mesh_size: nodal size (Kratos NODAL_H = min distance to a node sharing an
 * element) + element size (mean edge length), with the element-size
 * box-whisker statistics and the IQR-outlier small/large element ids.
 */
export async function meshSize(args: {
  path: string;
  outlierLimit?: number;
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const limit = args.outlierLimit ?? 50;
  const r = computeMeshSize(model);
  const nodalValues = Array.from(r.nodalH.values);
  const elementValues = Array.from(r.elementSize.values);
  const summarize = (vals: number[], stats: typeof r.elementStats) => ({
    count: stats.count,
    min: stats.min,
    q1: stats.q1,
    median: stats.median,
    q3: stats.q3,
    max: stats.max,
    mean: stats.mean,
    std: stats.std,
    whiskerLo: stats.whiskerLo,
    whiskerHi: stats.whiskerHi,
  });
  return {
    elementCount: r.elementCount,
    analyzedCount: r.analyzedCount,
    elementTypes: r.elementTypes,
    nodalSize: summarize(nodalValues, r.nodalStats),
    elementSize: summarize(elementValues, r.elementStats),
    smallElementIds: r.smallElementIds.slice(0, limit),
    smallElementTotal: r.smallElementIds.length,
    bigElementIds: r.bigElementIds.slice(0, limit),
    bigElementTotal: r.bigElementIds.length,
  };
}

/** Serializes MMG runs: remesh.ts's progress listener is module-level. */
let mmgChain: Promise<unknown> = Promise.resolve();

function withMmgLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mmgChain.then(fn, fn);
  mmgChain = run.catch(() => undefined);
  return run;
}

async function writeModel(
  model: MdpaModel,
  outPath: string,
  sourceText: string | undefined,
  format?: string
): Promise<string> {
  const abs = path.resolve(outPath);
  const ext = path.extname(abs).toLowerCase();
  if (!isExportableExtension(ext)) {
    throw new Error(
      `Cannot write "${ext}" — exportable formats: ${EXPORTABLE_EXTENSIONS.join(", ")}`
    );
  }
  const { data, companions } = await writeMeshFileAsync(model, ext, {
    sourceText: ext === ".mdpa" ? sourceText : undefined,
    name: path.basename(abs, ext),
    format,
  });
  // Uint8Array (the binary meshio++ formats) is written raw; a string as utf8.
  fs.writeFileSync(abs, data);
  // XDMF references its companion .h5 by name — the main file is useless alone.
  for (const c of companions) {
    fs.writeFileSync(path.join(path.dirname(abs), c.name), c.data);
  }
  invalidateCache(abs);
  return abs;
}

export async function meshTransform(args: {
  path: string;
  ops?: unknown[];
  recipePath?: string;
  outputPath?: string;
}): Promise<object> {
  const src = await loadMesh(args.path);
  const warnings: string[] = [];
  let raw = args.ops;
  if (args.recipePath) {
    if (raw?.length) throw new Error("Provide either `ops` or `recipePath`, not both.");
    const parsed = parseOpsJson(fs.readFileSync(args.recipePath, "utf8"));
    warnings.push(...parsed.warnings);
    raw = parsed.operations;
  }
  if (!raw || raw.length === 0) {
    throw new Error("No operations: provide `ops` (array of op records) or `recipePath`.");
  }
  const records: OpRecord[] = raw.map((entry, i) => {
    const rec = opRecordFromMessage((entry ?? {}) as Record<string, unknown>);
    if (!rec) {
      const opName = (entry as { op?: unknown } | null)?.op;
      throw new Error(
        `ops[${i}]: invalid or unknown operation ${JSON.stringify(opName)}. ` +
          `Known ops: ${Object.keys(OP_LABELS).join(", ")}`
      );
    }
    return rec;
  });
  let model = src.model;
  const outcomes: object[] = [];
  for (const rec of records) {
    const out = isAsyncOp(rec.op)
      ? await withMmgLock(() =>
          applyOpAsync(model, rec, { onProgress: (m) => progressSink?.(m) })
        )
      : await applyOpAsync(model, rec);
    outcomes.push({ op: rec.op, label: OP_LABELS[rec.op], noop: out.noop === true, message: out.message });
    model = out.model;
  }
  const written = await writeModel(model, args.outputPath ?? args.path, src.sourceText);
  return {
    outputPath: written,
    outcomes,
    warnings,
    nodeCount: { before: src.model.nodeCount, after: model.nodeCount },
    elementCount: { before: countByKind(src.model, "Elements"), after: countByKind(model, "Elements") },
    bounds: model.bounds,
  };
}

export async function meshConvert(args: {
  path: string;
  outputPath: string;
  inputFormat?: string;
  outputFormat?: string;
  /** Selects a step of a multi-step input file (Exodus, since meshio++ >= 8.6.0). */
  timeStep?: number;
}): Promise<object> {
  const src = await loadMesh(args.path, args.inputFormat, args.timeStep);
  const written = await writeModel(
    src.model,
    args.outputPath,
    src.sourceText,
    args.outputFormat
  );
  return {
    outputPath: written,
    sourceFormat: src.ext,
    targetFormat: path.extname(written).toLowerCase(),
    nodeCount: src.model.nodeCount,
    elementCount: countByKind(src.model, "Elements"),
    conditionCount: countByKind(src.model, "Conditions"),
  };
}

export async function meshExtractSubModelPart(args: {
  path: string;
  submodelpart: string;
  outputPath: string;
}): Promise<object> {
  const src = await loadMesh(args.path);
  const extracted = extractSubModelPart(src.model, args.submodelpart);
  if (!extracted) {
    throw new Error(
      `SubModelPart "${args.submodelpart}" not found. Available: ` +
        subModelPartPaths(src.model.subModelParts).join(", ")
    );
  }
  const written = await writeModel(extracted, args.outputPath, undefined);
  return {
    outputPath: written,
    submodelpart: args.submodelpart,
    nodeCount: extracted.nodeCount,
    blocks: extracted.blocks.map(blockSummary),
  };
}

const KIND_OF_ENTITY: Record<string, EntityKind> = {
  Element: "Elements",
  Condition: "Conditions",
  Geometry: "Geometries",
};

export async function meshFindEntity(args: {
  path: string;
  entityType: "Node" | "Element" | "Condition" | "Geometry";
  entityId: number;
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const id = args.entityId;
  const owningParts = (member: (p: SubModelPart) => boolean): string[] => {
    const out: string[] = [];
    const walk = (p: SubModelPart): void => {
      if (member(p)) out.push(p.path);
      p.children.forEach(walk);
    };
    model.subModelParts.forEach(walk);
    return out;
  };
  if (args.entityType === "Node") {
    const idx = model.nodeIds.indexOf(id);
    if (idx < 0) throw new Error(`Node ${id} not found.`);
    return {
      entityType: "Node",
      entityId: id,
      coordinates: [model.coords[idx * 3], model.coords[idx * 3 + 1], model.coords[idx * 3 + 2]],
      subModelParts: owningParts((p) => p.nodeIds.includes(id)),
    };
  }
  const kind = KIND_OF_ENTITY[args.entityType];
  if (!kind) throw new Error(`Unknown entityType "${args.entityType}".`);
  for (const b of model.blocks) {
    if (b.kind !== kind) continue;
    const idx = b.entityIds.indexOf(id);
    if (idx < 0) continue;
    const memberKey =
      kind === "Elements" ? "elementIds" : kind === "Conditions" ? "conditionIds" : "geometryIds";
    return {
      entityType: args.entityType,
      entityId: id,
      block: b.name,
      nodeIds: Array.from(b.connectivity.slice(idx * b.stride, (idx + 1) * b.stride)),
      subModelParts: owningParts((p) => p[memberKey].includes(id)),
    };
  }
  throw new Error(`${args.entityType} ${id} not found.`);
}

// --- problemtype catalog ------------------------------------------------------

export interface CatalogEntry {
  runtime?: ProblemtypeRuntime;
  source: ProblemtypeSource;
  error?: string;
  fileName?: string;
}

/**
 * Built-ins plus workspace-authored problemtypes. For each dir the scan mirrors
 * the extension's convention: `<dir>/.kratos/problemtypes/*.{js,py}` when that
 * folder exists, else `<dir>/*.{js,py}` (so a problemtypes folder can be passed
 * directly). Load failures become entries carrying `error`.
 */
export async function loadProblemtypeCatalog(workspaceDirs?: string[]): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = BUILTIN_PROBLEMTYPES.map((runtime) => ({
    runtime,
    source: runtime.source,
  }));
  for (const dir of workspaceDirs ?? []) {
    const conventional = path.join(dir, ".kratos", "problemtypes");
    const scanDir = fs.existsSync(conventional) ? conventional : dir;
    let names: string[];
    try {
      names = fs.readdirSync(scanDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".js") && !name.endsWith(".py")) continue;
      const file = path.join(scanDir, name);
      const source: ProblemtypeSource = name.endsWith(".py") ? "py" : "js";
      try {
        const code = fs.readFileSync(file, "utf8");
        let runtimes: ProblemtypeRuntime[];
        if (source === "js") {
          const { loadJsProblemtypes } = await import("../problemtype/jsLoader");
          runtimes = loadJsProblemtypes(code, name);
        } else {
          const { loadPyProblemtypes } = await import("../problemtype/pyRuntime");
          runtimes = await loadPyProblemtypes(code, name);
        }
        entries.push(...runtimes.map((runtime) => ({ runtime, source, fileName: name })));
      } catch (err) {
        entries.push({
          source,
          error: err instanceof Error ? err.message : String(err),
          fileName: name,
        });
      }
    }
  }
  return entries;
}

async function resolveRuntime(
  id: string,
  workspaceDirs?: string[]
): Promise<ProblemtypeRuntime> {
  const catalog = await loadProblemtypeCatalog(workspaceDirs);
  const entry = catalog.find((e) => e.runtime?.decl.id === id);
  if (!entry?.runtime) {
    const known = catalog.filter((e) => e.runtime).map((e) => e.runtime!.decl.id);
    throw new Error(`Unknown problemtype "${id}". Available: ${known.join(", ")}`);
  }
  return entry.runtime;
}

export async function problemtypeList(args: {
  workspaceDirs?: string[];
}): Promise<object> {
  const catalog = await loadProblemtypeCatalog(args.workspaceDirs);
  return {
    problemtypes: catalog.map((e) => ({
      id: e.runtime?.decl.id,
      name: e.runtime?.decl.name,
      description: e.runtime?.decl.description,
      source: e.source,
      fileName: e.fileName,
      error: e.error,
    })),
  };
}

export async function problemtypeDescribe(args: {
  problemtype: string;
  workspaceDirs?: string[];
}): Promise<object> {
  const runtime = await resolveRuntime(args.problemtype, args.workspaceDirs);
  // The declaration is JSON-able by design; the default CaseState is the
  // skeleton a client edits and feeds to case_write_state / case_generate.
  return { declaration: runtime.decl, defaultState: defaultCaseState(runtime.decl) };
}

// --- case tools ---------------------------------------------------------------

function caseFilePathFor(meshPath: string): string {
  const dir = path.dirname(path.resolve(meshPath));
  const stem = path.basename(meshPath, path.extname(meshPath));
  return path.join(dir, `${stem}.kratoscase.json`);
}

/** Normalizes an inline state object / case file into a CaseState (+ warnings). */
function readState(args: {
  meshPath: string;
  state?: unknown;
  casePath?: string;
}): { state?: CaseState; warnings: string[]; from: string } {
  if (args.state !== undefined) {
    const parsed = parseCaseJson(JSON.stringify(args.state));
    return { state: parsed.state, warnings: parsed.warnings, from: "inline state" };
  }
  const casePath = args.casePath ?? caseFilePathFor(args.meshPath);
  let text: string;
  try {
    text = fs.readFileSync(casePath, "utf8");
  } catch {
    return { warnings: [], from: casePath };
  }
  const parsed = parseCaseJson(text);
  return { state: parsed.state, warnings: parsed.warnings, from: casePath };
}

export async function caseValidate(args: {
  meshPath: string;
  problemtype?: string;
  state?: unknown;
  casePath?: string;
  workspaceDirs?: string[];
}): Promise<object> {
  const { model } = await loadMesh(args.meshPath);
  const { state, warnings, from } = readState(args);
  if (!state) {
    throw new Error(
      `No usable case state (${from}). ${warnings.join(" ")} ` +
        `Pass \`state\` inline or write one with case_write_state.`
    );
  }
  const ptId = args.problemtype ?? state.problemtypeId;
  const runtime = await resolveRuntime(ptId, args.workspaceDirs);
  const issues: string[] = [];
  const knownPaths = new Set(subModelPartPaths(model.subModelParts));
  const conditionIds = new Set(runtime.decl.conditions.map((c) => c.id));
  const lawIds = new Set(runtime.decl.materialLaws.map((l) => l.id));
  for (const a of state.assignments) {
    if (!conditionIds.has(a.conditionId)) {
      issues.push(`Assignment condition "${a.conditionId}" is not declared by "${ptId}".`);
    }
    if (!knownPaths.has(a.smpPath)) {
      issues.push(`Assignment SubModelPart "${a.smpPath}" is not in the mesh.`);
    }
  }
  for (const m of state.materials) {
    if (!lawIds.has(m.lawId)) {
      issues.push(`Material law "${m.lawId}" is not declared by "${ptId}".`);
    }
    if (!knownPaths.has(m.smpPath)) {
      issues.push(`Material SubModelPart "${m.smpPath}" is not in the mesh.`);
    }
  }
  return { ok: issues.length === 0, problemtype: ptId, source: from, warnings, issues, state };
}

export async function caseWriteState(args: {
  meshPath: string;
  state: unknown;
}): Promise<object> {
  // Round-trip through the tolerant parser so malformed pieces degrade to
  // defaults with warnings instead of writing garbage the sidebar chokes on.
  const parsed = parseCaseJson(JSON.stringify(args.state));
  if (!parsed.state) {
    throw new Error(`Invalid case state: ${parsed.warnings.join(" ") || "unrecognized shape."}`);
  }
  const casePath = caseFilePathFor(args.meshPath);
  fs.writeFileSync(casePath, serializeCase(parsed.state));
  return { casePath, warnings: parsed.warnings };
}

export async function caseGenerate(args: {
  meshPath: string;
  problemtype?: string;
  state?: unknown;
  casePath?: string;
  workspaceDirs?: string[];
}): Promise<object> {
  const ext = path.extname(args.meshPath).toLowerCase();
  if (ext !== ".mdpa") throw new Error("case_generate needs a .mdpa mesh (Kratos input format).");
  const src = await loadMesh(args.meshPath);
  const read = readState(args);
  const warnings = [...read.warnings];
  let state = read.state;
  let runtime: ProblemtypeRuntime;
  if (state) {
    runtime = await resolveRuntime(args.problemtype ?? state.problemtypeId, args.workspaceDirs);
  } else if (args.problemtype) {
    runtime = await resolveRuntime(args.problemtype, args.workspaceDirs);
    state = defaultCaseState(runtime.decl);
    warnings.push(`No case state (${read.from}); generated with "${runtime.decl.id}" defaults.`);
  } else {
    throw new Error(
      `No case state (${read.from}) and no \`problemtype\` given — pass one or the other.`
    );
  }
  const caseDir = path.dirname(path.resolve(args.meshPath));
  const stem = path.basename(args.meshPath, ext);
  // Mirrors PtController.generate: adapt block names to what the solver
  // expects; on renames the original mesh stays untouched and a
  // `<stem>_case.mdpa` copy becomes input_filename.
  const scratch: string[] = []; // generateCase re-reports these warnings
  const domainSize = resolveDomainSize(runtime, src.model, scratch);
  const bases = resolveMeshNaming(runtime.decl, flattenValues(runtime.decl, state), domainSize);
  const adapted = adaptMeshNames(src.model, bases, domainSize);
  let caseModel = src.model;
  let caseStem = stem;
  const written: string[] = [];
  if (adapted.renames.length > 0) {
    caseModel = adapted.model;
    caseStem = `${stem}_case`;
    const adaptedPath = path.join(caseDir, `${caseStem}.mdpa`);
    fs.writeFileSync(adaptedPath, writeMdpa(caseModel, { sourceText: src.sourceText }));
    invalidateCache(adaptedPath);
    written.push(adaptedPath);
  }
  const out = await generateCase(runtime, caseModel, state, caseStem);
  const files: [string, string][] = [
    ["ProjectParameters.json", out.projectParameters],
    [out.materialsFileName, out.materials],
    ["MainKratos.py", out.mainScript],
  ];
  for (const [name, text] of files) {
    const p = path.join(caseDir, name);
    fs.writeFileSync(p, text);
    written.push(p);
  }
  warnings.push(...adapted.warnings, ...out.warnings);
  return {
    written,
    problemtype: runtime.decl.id,
    domainSize,
    renames: adapted.renames,
    warnings,
  };
}

// --- problem archives ---------------------------------------------------------

export async function problemPack(args: {
  meshPath: string;
  outputPath?: string;
  recipePath?: string;
}): Promise<object> {
  const abs = path.resolve(args.meshPath);
  const dir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  const warnings: string[] = [];

  // The ops recipe: an explicit recipePath wins; else the conventional
  // `<stem>.ops.json` next to the mesh (what the sidebar's Save operations…
  // writes). Validated through parseOpsJson so a broken recipe is not bundled.
  let opsJson: string | undefined;
  const recipePath = args.recipePath
    ? path.resolve(args.recipePath)
    : path.join(dir, `${stem}.ops.json`);
  try {
    opsJson = fs.readFileSync(recipePath, "utf8");
  } catch (err) {
    if (args.recipePath) {
      throw new Error(
        `Cannot read recipe: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (opsJson !== undefined) {
    const parsed = parseOpsJson(opsJson);
    warnings.push(...parsed.warnings);
    if (parsed.operations.length === 0) {
      warnings.push(`Recipe ${path.basename(recipePath)} has no valid operations; not bundled.`);
      opsJson = undefined;
    }
  }

  let collected;
  try {
    collected = await collectProblemFiles(abs, opsJson);
  } catch (err) {
    throw new Error(`Cannot read mesh: ${err instanceof Error ? err.message : String(err)}`);
  }
  const outputPath = args.outputPath
    ? path.resolve(args.outputPath)
    : path.join(dir, `${stem}.kratosproblem.zip`);
  fs.writeFileSync(outputPath, buildProblemZip(collected.manifest, collected.files));
  return {
    archivePath: outputPath,
    files: collected.files.map((f) => f.name),
    manifest: collected.manifest,
    warnings,
  };
}

export async function problemUnpack(args: {
  archivePath: string;
  destDir?: string;
  overwrite?: boolean;
}): Promise<object> {
  const abs = path.resolve(args.archivePath);
  const parsed = parseProblemZip(fs.readFileSync(abs));
  const warnings = [...parsed.warnings];
  const destDir = path.resolve(args.destDir ?? path.dirname(abs));

  // The manifest is archive metadata, not a problem file — don't extract it.
  const toWrite = parsed.entries.filter(
    (e) => e.name !== PROBLEM_MANIFEST_NAME && !e.name.endsWith("/")
  );
  const unsafe = toWrite.filter((e) => !isSafeEntryName(e.name));
  if (unsafe.length > 0) {
    warnings.push(`Skipped unsafe entry path(s): ${unsafe.map((e) => e.name).join(", ")}`);
  }
  const safe = toWrite.filter((e) => isSafeEntryName(e.name));
  if (safe.length === 0) throw new Error("The archive contains no extractable files.");

  if (!args.overwrite) {
    const conflicts = safe
      .map((e) => e.name)
      .filter((n) => fs.existsSync(path.join(destDir, n)));
    if (conflicts.length > 0) {
      throw new Error(
        `Refusing to overwrite existing file(s): ${conflicts.join(", ")}. ` +
          `Pass overwrite: true or a different destDir.`
      );
    }
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of safe) {
    const target = path.join(destDir, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    invalidateCache(target);
  }
  return {
    destDir,
    meshPath: parsed.mesh ? path.join(destDir, parsed.mesh) : undefined,
    // The extension replays this automatically on load; over MCP, apply it
    // with mesh_transform's recipePath.
    opsRecipePath: parsed.ops ? path.join(destDir, parsed.ops) : undefined,
    extracted: safe.map((e) => e.name),
    warnings,
  };
}
