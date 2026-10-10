import { discoverOutputs } from '../problemtype/outputDiscovery';
import { runPlotWorker } from "../plotWorkerClient";
import { PLOT_CAPABILITIES, emptyPlotRecipe, validatePlotRecipe } from "../parser/plot/recipe";
import { writePlotCsv } from "../parser/plot/files";
import type { ImportOptions, PlotDataset, PlotExecution, PlotTable, PlotRunBinding } from "../parser/plot/types";
import type { PlotTimeCursorRequest } from "../parser/plot/runs";
import type { PlotRunTargetRequest, PlotRunTarget } from "../parser/plot/navigation";
import { solverArgv, THREAD_RECEIPT } from '../problemtype/threadControl';
import { estimateTimeStep, validateFluidTimeStepping } from "../problemtype/timeStepEstimate";
import {
  BATCH_MANIFEST_NAME,
  BatchManifest,
  parseBatchManifest,
  planBatch,
  recipeHash,
  runBatch,
  serializeBatchManifest,
} from "../parser/batchPlan";
import { RecipePreset, findRecipePreset } from "../parser/recipePresets";
import {
  DEFAULT_RECIPE_PRESET_PATHS,
  discoverRecipePresets,
} from "../recipePresetLibrary";
import { sequenceSource, exportResampled, ResampleSourceOptions } from "../parser/resampleFiles";
import type { ResampleOptions } from "../parser/resampleSequence";
import { qualityGate, hausdorff, periodicNodes, PeriodicOptions } from "../parser/analysisOps";
import { assertFreshElmerDestination } from "../parser/caeFiles";
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
import { createHash, randomUUID } from "node:crypto";
import { MdpaModel, EntityBlock, SubModelPart, EntityKind } from "../parser/types";
import { parseMdpa } from "../parser/mdpaParser";
import { surfaceDefects } from "../parser/surfaceDefects";
import { curvatureModel, gaussBonnetResidual } from "../parser/curvature";
import { compareMeshes, compareFieldModel } from "../parser/meshCompare";
import { fieldUnitLabel } from "../parser/fieldDimensions";
import { deriveMesh, DeriveSpec, DERIVE_KINDS, DERIVE_STANDALONE_KINDS } from "../parser/deriveMesh";
import type { StreamSeeds } from "../parser/streamlines";
import { writeRawMeshioBytes } from "../parser/meshio";
import { probeAlongPath, probeToCsv } from "../parser/pathProbe";
import { partitionParts, partitionManifest } from "../parser/partitionExport";
import { splitModel } from "../parser/splitComponents";
import {
  parseMeshFile,
  readMeshMetadata,
  readMeshTimeSteps,
  statMeshSource,
} from "../parser/meshFileParser";
import { summarizeMeshFile } from "../parser/meshSummary";
import {
  HEADER_METADATA_EXTENSIONS,
  IN_FILE_TIMELINE_EXTENSIONS,
  meshExtname,
  meshStem,
  SUPPORTED_MESH_EXTENSIONS,
  VTK_XML_EXTENSIONS,
} from "../parser/meshFormats";
import {
  isMeshioReadExtension,
  MESHIO_READ_EXTENSIONS,
} from "../parser/meshioFormats";
import {
  OP_LABELS,
  applyOpAsync,
  isAsyncOp,
  opRecordFromMessage,
  parseOpsJson,
} from "../parser/operations";
import { writeMeshFileAsync } from "../parser/writers/meshWriter";
import {
  ExportReport,
  ProvenanceMode,
  PROVENANCE_MODES,
  buildExportReport,
  buildUnverifiedReport,
  serializeReport,
  finalizeReport,
  observeExport,
  provenanceRequest,
  verifyReport,
} from "../parser/exportReport";
import { isNativeExportExtension } from "../parser/writers/exportFormats";
import { meshioPackageVersion } from "../parser/meshio";
import {
  EXPORTABLE_EXTENSIONS,
  isExportableExtension,
} from "../parser/writers/exportFormats";
import { exportEligibility } from "../parser/writers/exportEligibility";
import { extractSubModelPart, findSubModelPart } from "../parser/subModelPartExtract";
import { extractSkinModel } from "../parser/extractSkin";
import { TABLE_KINDS, csvChunks, isTableKind, prepareTable } from "../parser/dataTable";
import { FieldSeriesSpec, seriesToCsv } from "../parser/fieldSeries";
import { packXdmfSeries } from "../parser/meshio";
import {
  collectFieldSeries,
  discoverSeriesFiles,
  packStepsFromFiles,
  packStepsFromInFile,
  discoverSeriesSteps,
  seriesFilesInDir,
} from "../parser/fieldSeriesScan";
import { packPvdSeries, PackPvdResult, pvdOutputClash, pvdPieceDir } from "../parser/packPvd";
import { buildMembershipIndex } from "../parser/smpMembership";
import { getMeshCapabilities } from "../parser/meshCapabilities";
import { writeXlsx } from "../parser/writers/xlsxWriter";
import { computeMeshQuality } from "../parser/meshQuality";
import { SelectionSeed, resolveSeed } from "../parser/selectionCore";
import { computeGlobal, GLOBAL_REDUCTIONS, reduceValues, type GlobalReduction } from "../parser/globalReduce";
import { computeMeshSize } from "../parser/meshSize";
import { watertightReport } from "../parser/watertight";
import { integrateFields } from "../parser/fieldIntegrate";
import { describeFlowBalance, flowBalance, flowBalanceSeries, FlowBalanceSpec } from "../parser/flowBalance";
import { flowBalanceToCsv, flowSeriesToCsv } from "../parser/analysisExport";
import { defaultSphereRadius, sphereStats } from "../parser/sphereElements";
import { PropertySet } from "../parser/propertiesParser";
import {
  ConstraintBlock,
  countConstraints,
  definedConstraintIds,
  undefinedConstraintIds,
} from "../parser/constraintsParser";
import { beamStats, defaultBeamRadius } from "../parser/beamElements";
import { findIsolatedNodeIds } from "../parser/isolatedNodes";
import { CaseState, JsonValue, MaterialAssignment, ProblemtypeRuntime, ProblemtypeSource } from "../problemtype/types";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { buildGenContext, domainProblems, generateCase, subModelPartPaths } from "../problemtype/generate";
import { PREPARATION_FILE, writePreparedCase } from "../problemtype/preparation";
import { defaultCaseState } from "../problemtype/api";
import { planCaseMesh } from "../problemtype/caseMesh";
import {
  BUILTIN_PRESETS,
  MaterialPreset,
  MaterialPresetSnapshot,
  findPreset,
  presetsForLaw,
  resolvePresetValues,
  serializePresetFile,
  snapshotOf,
  validateMaterialAssignment,
} from "../problemtype/materialCatalog";
import {
  DEFAULT_MATERIAL_LIBRARY_PATHS,
  MaterialLibrary,
  discoverMaterialLibrary,
  importPresetFile,
} from "../problemtype/materialLibrary";
import { writeMdpa } from "../parser/writers/mdpaWriter";
import {
  caseFilePath,
  runFilePath,
  runLogPath,
  parseCaseJson,
  serializeCase,
} from "../problemtype/caseFile";
import { RunRecord, caseKeyFor, latestResultFile } from "../problemtype/runCore";
import { parseRunJson, reconcileStatus, serializeRun, sidecarFromRecord } from "../problemtype/runFile";
import { executionFilePath, parseExecutionReceipt, terminalExecution, type ExecutionArtifact, type ExecutionReceipt, type ExecutionState } from "../problemtype/runReceipt";
import { freezeExecutionResult } from "../problemtype/runResultInventory";
import { plotDirectorySource } from "../parser/plot/directoryInventory";
import { isPidAlive, spawnRun, stopPid } from "../problemtype/runProcess";
import { computeKratosEnv, defaultPythonPath, resolveKratosInstall } from "../problemtype/kratosEnv";
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
  /**
   * What "unchanged" means for this path. Usually the opened file's
   * mtime+size; for an OpenFOAM case the polyMesh files', because the `.foam`
   * marker is 0 bytes and never changes when the mesh does.
   */
  stamp: string;
  model: MdpaModel;
  /** Original text, kept for .mdpa only (lossless ModelPartData/Table round-trips). */
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
 * multi-step mesh (Exodus since 8.6.0, MED since 9.9.0, GiD postprocess, XDMF,
 * OpenFOAM time directories); 0 is the first
 * step, so it is treated the same as "unset" for cache purposes. `piece`/
 * `dropGhosts` (roadmap item 3) select one piece of a parallel/partitioned
 * VTK XML file (.pvtu/.pvtp) and drop its ghost cells, following the same
 * cache-bypass rule as inputFormat/timeStep — the cache key cannot
 * distinguish them either. `region` (roadmap item 3, Step 5) selects one
 * region of a multi-region OpenFOAM case instead of merging every region —
 * same bypass rule, same reason. Any of the five bypasses the cache in both
 * directions: the key is path+mtime+size and distinguishes none of them, so
 * a cached parse under different ones must not be served — nor stored,
 * where it would shadow the default.
 */
export async function loadMesh(
  fsPath: string,
  inputFormat?: string,
  timeStep?: number,
  piece?: number,
  dropGhosts?: boolean,
  region?: string
): Promise<{ model: MdpaModel; ext: string; sourceText?: string }> {
  const abs = path.resolve(fsPath);
  const ext = meshExtname(abs);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  if (inputFormat && !isMeshioReadExtension(ext) && inputFormat !== "elmer") {
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
        `(Exodus, MED, GiD postprocess, CGNS/Tecplot, XDMF, OpenFOAM): ${MESHIO_READ_EXTENSIONS.join(", ")}`
    );
  }
  if (region !== undefined && ext !== ".foam") {
    throw new Error(`region is only accepted for OpenFOAM cases (.foam), not "${ext}".`);
  }
  const bypassCache =
    Boolean(inputFormat) ||
    (timeStep !== undefined && timeStep !== 0) ||
    piece !== undefined ||
    dropGhosts !== undefined ||
    region !== undefined;
  // Keyed on every file a READ would open, not just the one named: an OpenFOAM
  // marker is 0 bytes, a GiD `.post.msh` does not change when its `.post.res`
  // gains a step, and an `.xmf` does not change when its `.h5` is rewritten —
  // each of which would otherwise serve a stale model forever.
  const { stamp } = await statMeshSource(abs);
  const hit = bypassCache ? undefined : meshCache.get(abs);
  if (hit && hit.stamp === stamp) {
    meshCache.delete(abs); // refresh LRU order
    meshCache.set(abs, hit);
    return { model: hit.model, ext, sourceText: hit.sourceText };
  }
  let model: MdpaModel;
  let sourceText: string | undefined;
  if (ext === ".mdpa") {
    sourceText = fs.readFileSync(abs, "utf8");
    model = parseMdpa(sourceText);
  } else if (SUPPORTED_MESH_EXTENSIONS.includes(ext) || inputFormat === "elmer") {
    model = await parseMeshFile(abs, undefined, {
      meshioFormat: inputFormat,
      timeStep,
      piece,
      dropGhosts,
      foamRegion: region,
    });
  } else {
    throw new Error(
      `Unsupported mesh format "${ext}". Supported: .mdpa, ${SUPPORTED_MESH_EXTENSIONS.join(", ")}`
    );
  }
  if (bypassCache) return { model, ext, sourceText };
  meshCache.set(abs, { stamp, model, sourceText });
  while (meshCache.size > CACHE_MAX) {
    const oldest = meshCache.keys().next().value as string;
    meshCache.delete(oldest);
  }
  return { model, ext, sourceText };
}

// --- summaries --------------------------------------------------------------

/**
 * One parsed Properties block, flattened for JSON.
 *
 * Values are unwrapped from the `PropertyValue` union into plain JSON — a
 * number, a boolean, an array, an array of arrays, or a string — because an
 * agent reading this wants the value, not the tag. The tag is recoverable from
 * the JSON type in every case, and `mesh_transform` does not consume this.
 */
function propertySummary(set: PropertySet): object {
  const values: Record<string, unknown> = {};
  for (const name of Object.keys(set.variables)) {
    const v = set.variables[name];
    values[name] =
      v.kind === "vector" ? v.values : v.kind === "matrix" ? v.rows : v.value;
  }
  return {
    id: set.id,
    values,
    ...(set.tables.length > 0
      ? { tables: set.tables.map((t) => ({ columns: t.args, rows: t.rows.length })) }
      : {}),
  };
}

/**
 * One parsed `Begin Constraints` block, flattened for JSON.
 *
 * Rows are summarised rather than listed: a real MPC mesh carries tens of
 * thousands of them, and the questions an agent asks here are "does this mesh
 * have constraints, of what kind, over which id range" — `mesh_export_table`
 * and `mesh_find_entity` are the tools for individual values. `verbatimRows`
 * counts rows this extension could not decompose: they round-trip, but no
 * operation can maintain them, so an agent about to renumber wants to know.
 */
function constraintBlockSummary(b: ConstraintBlock): object {
  const ids = definedConstraintIds([b]);
  const { raw } = countConstraints([b]);
  return {
    name: b.name,
    variables: b.variables,
    count: b.rows.length,
    ...(raw > 0 ? { verbatimRows: raw } : {}),
    ...(ids.length > 0 ? { idRange: [Math.min(...ids), Math.max(...ids)] } : {}),
  };
}

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
      // Unconditional, unlike the top-level `constraints` section: `counts` is
      // a fixed-shape object where a 0 is an answer.
      constraints: p.constraintIds.length,
    },
    children: p.children.map(smpTree),
  };
}

function countByKind(model: MdpaModel, kind: EntityKind): number {
  return model.blocks.filter((b) => b.kind === kind).reduce((n, b) => n + b.count, 0);
}

const DIAG_LIMIT = 20;

/**
 * The shape `mesh_info` already returned — {total, first} over a model's
 * parse diagnostics — applied uniformly across every tool that hands back a
 * model, so a caller does not have to know which tools happen to report
 * diagnostics and which silently drop them.
 */
function diagnosticsBlock(model: MdpaModel): { total: number; first: MdpaModel["diagnostics"] } {
  return { total: model.diagnostics.length, first: model.diagnostics.slice(0, DIAG_LIMIT) };
}

// --- mesh tools -------------------------------------------------------------

export async function meshHeaderInfo(fsPath: string, inputFormat?: string): Promise<object> {
  const abs = path.resolve(fsPath);
  try {
    fs.statSync(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  const ext = meshExtname(abs);
  if (!isMeshioReadExtension(ext)) {
    throw new Error(
      `Header-only preview is not available for "${ext}", which has its own parser — parse it. ` +
        `It is only offered for the meshio++ formats whose reader stays header-only: ${HEADER_METADATA_EXTENSIONS.join(", ")}. ` +
        `Or pass summary:true, which works for every supported format and reports what it cost.`
    );
  }
  // Defense in depth, in this order: the static table refuses the known
  // full-read formats without paying for one, and the result gate below
  // catches whatever the table did not foresee (an ambiguous extension
  // holding another format's bytes, a future wasm bump changing a reader).
  // Either way a "fast" path never serves a full read at header price.
  if (!HEADER_METADATA_EXTENSIONS.includes(ext) && !inputFormat) {
    throw new Error(
      `Header-only preview is not available for "${ext}": its reader falls back to a full ` +
        `read, so metadataOnly would cost the same as parsing. Eligible: ${HEADER_METADATA_EXTENSIONS.join(", ")}. ` +
        `Omit metadataOnly to parse it, or pass summary:true, which works for every supported format and reports what it cost.`
    );
  }
  const { metadata } = await readMeshMetadata(abs, inputFormat);
  if (metadata.fellBackToFullRead) {
    throw new Error(
      `Header-only preview is not available for this "${ext}" file (reader "${metadata.format}" ` +
        `fell back to a full read). Omit metadataOnly to parse it.`
    );
  }
  return {
    path: abs,
    format: ext,
    metadataOnly: true,
    resolvedFormat: metadata.format,
    nodeCount: metadata.numPoints,
    pointDim: metadata.pointDim,
    cellCount: metadata.numCells,
    cellBlocks: metadata.cellBlocks,
    pointDataNames: metadata.pointDataNames,
    cellDataNames: metadata.cellDataNames,
    fieldDataNames: metadata.fieldDataNames,
    // Empty on most native header-only paths (upstream maps no regions
    // there) — present so the shape is stable. Since 11.5.0 gmsh maps the
    // block Cell regions; full part membership still needs a parse, see
    // mesh_info without metadataOnly.
    regions: metadata.regions,
    // Omitted — never null — when the reader computed no bounding box, which
    // is every native header-only path: "not computed" must not read as a box
    // at the origin.
    ...(metadata.bboxMin !== undefined && metadata.bboxMax !== undefined
      ? { bounds: { min: metadata.bboxMin, max: metadata.bboxMax } }
      : {}),
    ...(metadata.timeValues.length > 0 ? { timeValues: metadata.timeValues } : {}),
  };
}

export async function meshInfo(args: {
  path: string;
  inputFormat?: string;
  /** Selects a step of a multi-step mesh (Exodus, MED, GiD postprocess, CGNS/Tecplot, XDMF, OpenFOAM time directories). */
  timeStep?: number;
  /**
   * Report the file header only (counts, block shapes, data-array names,
   * regions, bbox) without parsing the mesh. Only the formats in
   * HEADER_METADATA_EXTENSIONS, whose `readMetadata` stays header-only — a
   * format that falls back to a full read is refused rather than served at
   * header price. Bypasses the model cache in both directions (a summary must
   * never shadow, or be shadowed by, a parsed model). Cannot be combined with
   * `timeStep`, which names a frame to parse.
   */
  metadataOnly?: boolean;
  /**
   * Report what is in the file WITHOUT parsing it, for every supported format —
   * the universal counterpart of `metadataOnly`, which is the meshio++
   * header-price contract and refuses anything it cannot serve cheaply.
   *
   * This never refuses for ineligibility; it reports `cost` instead, which is
   * the whole difference. `"header"` is a bounded read, `"scan"` streams the
   * file without building arrays (`.mdpa` declares no counts, so it has no
   * choice), `"buffered"` holds the file plus siblings in memory, and `"read"`
   * means the reader parsed the mesh to answer. Check `cost` before assuming a
   * summary of a huge file was cheap; `bytesRead` says what it actually took.
   */
  summary?: boolean;
  /** Selects one piece of a .pvtu/.pvtp file instead of merging every piece (0-based). */
  piece?: number;
  /** Drop ghost/duplicate cells at partition seams (.pvtu/.pvtp; defaults to true for them). */
  dropGhosts?: boolean;
  /** Selects one region of a multi-region OpenFOAM case (.foam) instead of merging every region. */
  region?: string;
}): Promise<object> {
  if (args.summary === true) {
    // Two combination errors only — never an ineligibility refusal.
    if (args.metadataOnly === true) {
      throw new Error(
        "summary cannot be combined with metadataOnly: summary works for every supported format and reports its cost, metadataOnly is the meshio++ header-only contract and refuses anything else."
      );
    }
    if (args.timeStep !== undefined) {
      throw new Error("summary cannot be combined with timeStep: one reports the file's shape, the other parses a frame.");
    }
    const s = await summarizeMeshFile(args.path, { meshioFormat: args.inputFormat });
    return {
      path: s.path,
      format: s.ext,
      summary: true,
      cost: s.cost,
      method: s.method,
      fileSize: s.fileSize,
      bytesRead: s.bytesRead,
      exact: s.exact,
      ...(s.datasetType ? { datasetType: s.datasetType } : {}),
      ...(s.nodeCount !== undefined ? { nodeCount: s.nodeCount } : {}),
      ...(s.cellCount !== undefined ? { cellCount: s.cellCount } : {}),
      blocks: s.blocks,
      pointDataNames: s.pointDataNames,
      cellDataNames: s.cellDataNames,
      fieldDataNames: s.fieldDataNames,
      regions: s.regions,
      // Omitted, never null/empty-as-an-answer — see `unknown`.
      ...(s.bounds ? { bounds: s.bounds } : {}),
      ...(s.extent ? { extent: s.extent } : {}),
      ...(s.children ? { children: s.children } : {}),
      ...(s.timeValues.length > 0 ? { timeValues: s.timeValues } : {}),
      /** What this format's header genuinely cannot say — not "none". */
      unknown: s.unknown,
      ...(s.notes.length > 0 ? { notes: s.notes } : {}),
    };
  }
  if (args.metadataOnly === true) {
    if (args.timeStep !== undefined) {
      throw new Error("metadataOnly cannot be combined with timeStep: one reports the file header, the other parses a frame.");
    }
    return meshHeaderInfo(args.path, args.inputFormat);
  }
  const { model, ext } = await loadMesh(
    args.path,
    args.inputFormat,
    args.timeStep,
    args.piece,
    args.dropGhosts,
    args.region
  );
  // Gated on IN_FILE_TIMELINE_EXTENSIONS, not every meshio format: Exodus's
  // readMetadata always falls back to a full read
  // (no native metadata path), so calling it for the other ~38 meshio
  // formats — none of which carry a time series — would double the read
  // cost of every meshInfo call for no benefit. MED accepts a `timeStep`
  // since meshio++ 9.9.0 but is not a metadata reader upstream, so it would
  // pay that doubled cost and still report [] — see meshFormats.ts. OpenFOAM
  // answers from a directory listing, which is cheap either way.
  const timeValues = IN_FILE_TIMELINE_EXTENSIONS.includes(ext)
    ? await readMeshTimeSteps(args.path)
    : [];
  // One pass each; both sections are reported only for a mesh that has the
  // cells in question, so every other report is unchanged.
  const spheres = sphereStats(model);
  const beams = beamStats(model);
  // Nodes referenced by no cell connectivity (connectivity-only: a node listed
  // in a SubModelPart but in no block still counts — see isolatedNodes.ts).
  // Reported only when non-empty, like `spheres`/`beams` below. Ids are capped
  // so a mesh that is mostly strays does not flood the agent's context.
  const isolatedIds = findIsolatedNodeIds(model);
  const ISOLATED_ID_LIMIT = 1000;
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
      // Only when the source stated them (an OpenFOAM `dimensions [..]`); absent = UNKNOWN,
      // never dimensionless (former roadmap item 12).
      ...(f.dimensions ? { dimensions: f.dimensions, unit: fieldUnitLabel(f) } : {}),
    })),
    // Global (scalar) variable SPECS with their live values, recomputed from
    // the current fields (see globalReduce.ts) — conditional like `fields`,
    // so a mesh with none reports nothing new.
    ...(model.globals && Object.keys(model.globals).length > 0
      ? {
          globals: Object.entries(model.globals).map(([name, spec]) => ({
            name,
            variable: spec.variable,
            kind: spec.kind,
            reduction: spec.reduction,
            value: computeGlobal(model, spec),
          })),
        }
      : {}),
    ...(timeValues.length > 0 ? { timeStep: args.timeStep ?? 0, timeValues } : {}),
    // The parsed `Begin Properties <id>` values, when the source was a .mdpa
    // that declared any (see propertiesParser.ts). Conditional like `spheres`
    // below, so every other format's report is unchanged. This is the id space
    // `blocks[].propertyIds` points into — the join an agent needs to answer
    // "what section does this element have?" without reading the file itself.
    ...(model.properties && model.properties.length > 0
      ? { properties: model.properties.map(propertySummary) }
      : {}),
    // The parsed `Begin Constraints` blocks — Kratos master/slave constraints —
    // when the source was a .mdpa that declared any. Conditional like
    // `properties`, so every other format's report is unchanged. This is the id
    // space `subModelParts[].counts.constraints` points into; `undefinedIds`
    // names the ids a SubModelPart lists that no block defines, which is a file
    // Kratos cannot read back and is invisible from the counts alone.
    ...(model.constraints && model.constraints.length > 0
      ? {
          constraints: {
            blocks: model.constraints.map(constraintBlockSummary),
            total: countConstraints(model.constraints).linear,
            verbatimRows: countConstraints(model.constraints).raw,
            undefinedIds: undefinedConstraintIds(model.constraints, model.subModelParts),
          },
        }
      : {}),
    // Source-format metadata with no home elsewhere in the model — today
    // only MED (mesh name, description, units). Conditional like `properties`
    // /`constraints`, so every other format's report is unchanged.
    ...(model.source ? { source: model.source } : {}),
    // Reported only when the mesh actually has particles, so ordinary meshes
    // are unchanged. Present so an agent can decide whether to reach for
    // setElementRadius without a second call: `radiusField: false` on a
    // non-zero `cells` is the Exodus SPHERE case that has no radius at all.
    ...(spheres.cells > 0
      ? {
          spheres: {
            blocks: spheres.blocks,
            cells: spheres.cells,
            radiusField: spheres.withRadius > 0,
            radiusCoverage: spheres.withRadius,
            radiusMin: spheres.radiusMin,
            radiusMax: spheres.radiusMax,
            suggestedRadius: defaultSphereRadius(model),
          },
        }
      : {}),
    // The 1D counterpart of `spheres`. `sectioned` on a non-zero `cells` is
    // what separates a beam frame from a 2D boundary skin or an imported
    // wireframe, which are the same line cells with nothing attached — see
    // beamElements.ts. `elementsSectioned` is the stricter count the viewer
    // gates its automatic rendering on, since a boundary condition may
    // legitimately share a structural part's Properties id.
    ...(beams.cells > 0
      ? {
          beams: {
            blocks: beams.blocks,
            cells: beams.cells,
            sectioned: beams.withSection,
            elementsSectioned: beams.elementsWithSection,
            radiusMin: beams.radiusMin,
            radiusMax: beams.radiusMax,
            suggestedRadius: defaultBeamRadius(model),
          },
        }
      : {}),
    ...(isolatedIds.length > 0
      ? {
          isolatedNodes: {
            count: isolatedIds.length,
            ids: isolatedIds.slice(0, ISOLATED_ID_LIMIT),
            ...(isolatedIds.length > ISOLATED_ID_LIMIT ? { truncated: true } : {}),
          },
        }
      : {}),
    diagnostics: diagnosticsBlock(model),
  };
}

export async function meshQuality(args: {
  path: string;
  require?: string;
  maxInverted?: number;
  maxDegenerate?: number;
  badIdLimit?: number;
  defectLimit?: number;
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const limit = args.badIdLimit ?? 20;
  const defectLimit = args.defectLimit ?? 50;
  const defects = surfaceDefects(model);
  const report = computeMeshQuality(model);
  return {
    gate: args.require !== undefined ? await qualityGate(model, args.require, args.maxInverted, args.maxDegenerate) : undefined,
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
    // meshio++ >= 10.4.0. Geometric quality says whether each element is
    // well-shaped; this says whether the boundary they form is closed. Both are
    // "is this mesh fit to solve on", so an agent should not need a second call
    // to learn the surface has holes. Undefined for a mesh with no cells.
    watertight: await watertightReport(model).catch(() => undefined),
    // WHERE the surface defects are, for the mesh's own surface (triangle/quad)
    // cells: the node-id pairs of hole-rim and non-manifold edges and the ids of
    // wound-against-a-neighbour and zero-area faces, each capped at
    // `defectLimit` with the true total beside it. `surfaceCellCount` 0 means
    // "nothing to check" (a solid's boundary is not a surface a repair changes).
    surfaceDefects: {
      surfaceCellCount: defects.surfaceCellCount,
      boundaryEdges: { total: defects.boundaryEdges.length, edges: defects.boundaryEdges.slice(0, defectLimit) },
      nonManifoldEdges: { total: defects.nonManifoldEdges.length, edges: defects.nonManifoldEdges.slice(0, defectLimit) },
      inconsistentFaces: { total: defects.inconsistentFaces.length, faces: defects.inconsistentFaces.slice(0, defectLimit) },
      degenerateFaces: { total: defects.degenerateFaces.length, faces: defects.degenerateFaces.slice(0, defectLimit) },
    },
  };
}

/**
 * mesh_field_integrate: the cell-measure-weighted total and mean of the
 * Elemental/Conditional fields, for the whole mesh and per named region (one
 * per block and per SubModelPart, so this is the per-part breakdown).
 * Read-only — the mesh is never modified.
 */
export async function meshFieldIntegrate(args: {
  path: string;
  variables?: string[];
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const integrals = await integrateFields(model, args.variables ?? []);
  return {
    path: args.path,
    integrals,
    // Regions are not a partition — a cell in two of them contributes fully to
    // both — so the region totals need not sum to the domain total. Said here
    // because it otherwise reads as an arithmetic error.
    note:
      "Regions overlap: a cell belonging to two regions contributes fully to " +
      "each, so region totals need not sum to the domain total.",
  };
}

/**
 * mesh_flow_balance: signed volumetric flux through named SubModelPart
 * boundaries (positive OUT of the domain), area-weighted pressure on them, the
 * net/imbalance across them and an optional pressure drop — see flowBalance.ts
 * for the conventions. Read-only; `allSteps` repeats it over the time series
 * one model at a time, like mesh_probe.
 */
export async function meshFlowBalance(args: {
  path: string;
  sections: { name?: string; part: string }[];
  velocity?: string;
  pressure?: string;
  density?: number;
  orientation?: "outward" | "winding";
  pressureDrop?: { from: string; to: string };
  pressureDensity?: number;
  pressureReference?: "gauge" | "absolute";
  timeStep?: number;
  allSteps?: boolean;
  outputPath?: string;
}): Promise<object> {
  const spec: FlowBalanceSpec = {
    sections: args.sections,
    velocity: args.velocity,
    pressure: args.pressure,
    density: args.density,
    orientation: args.orientation,
    pressureDrop: args.pressureDrop,
    pressureDensity: args.pressureDensity,
    pressureReference: args.pressureReference,
  };
  if (args.allSteps && args.timeStep !== undefined) throw new Error("Choose either allSteps or a single timeStep, not both.");
  let written: string | undefined;
  const writeCsv = (csv: string): void => {
    if (!args.outputPath) return;
    const out = path.resolve(args.outputPath);
    if (path.extname(out).toLowerCase() !== ".csv") throw new Error(`Cannot write a flow balance as "${path.extname(out)}" — supported: .csv`);
    fs.writeFileSync(out, csv, "utf8");
    written = out;
  };
  if (!args.allSteps) {
    const { model } = await loadMesh(args.path, undefined, args.timeStep);
    const result = flowBalance(model, spec);
    writeCsv(flowBalanceToCsv(result));
    return { path: path.resolve(args.path), summary: describeFlowBalance(result), ...result, outputPath: written };
  }
  const abs = path.resolve(args.path);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const { steps, source } = await discoverSeriesSteps(abs);
  // A lone file is not a series; `parseMeshFile` does not read .mdpa, so it goes through loadMesh like every other tool.
  const loadable = source === "single" ? steps.map((s) => ({ ...s, load: async () => (await loadMesh(abs)).model })) : steps;
  const series = await flowBalanceSeries(loadable, spec);
  writeCsv(flowSeriesToCsv(series));
  return {
    path: abs,
    source,
    totalSteps: steps.length,
    steps: series.rows.map((r) => ({ label: r.label, ...(r.result ? { summary: describeFlowBalance(r.result), sections: r.result.sections, netFlux: r.result.netFlux, imbalance: r.result.imbalance, pressureDrop: r.result.pressureDrop, warnings: r.result.warnings } : { error: r.error }) })),
    outputPath: written,
  };
}

/**
 * Evaluate one explicitly selected scalar from a solver result using the
 * parser's existing field/reduction routines. The app stores this versioned
 * definition with its source run; this tool never guesses units or mutates a
 * result file.
 */
export async function caseEvaluateQuantity(args: {
  path: string;
  runId: string;
  field: string;
  kind: "Nodal" | "Elemental" | "Conditional";
  component: "scalar" | "x" | "y" | "z" | "magnitude";
  region?: string;
  timeStep?: number;
  /** Explicit physical time for a selected per-step result file without embedded series metadata. */
  time?: number;
  reduction: GlobalReduction;
  unit: string;
}): Promise<object> {
  const sourcePath = path.resolve(args.path);
  const unit = args.unit.trim();
  if (!args.runId.trim()) throw new Error("runId is required.");
  if (!unit) throw new Error("unit is required; result units are never inferred.");
  if (args.time !== undefined && !Number.isFinite(args.time)) throw new Error("time must be finite.");
  if (args.time !== undefined && args.timeStep !== undefined) throw new Error("Choose either an explicit time or a time-series step index, not both.");
  if (!(GLOBAL_REDUCTIONS as readonly string[]).includes(args.reduction)) throw new Error(`Unsupported reduction: ${args.reduction}`);
  const { model, ext } = await loadMesh(sourcePath, undefined, args.timeStep);
  const field = model.fields.find(value => value.variable === args.field && value.kind === args.kind);
  if (!field) throw new Error(`No ${args.kind} field named ${args.field} exists in ${sourcePath}.`);

  let included: Set<number> | undefined;
  const region = args.region?.trim() || "global";
  if (region !== "global") {
    const selected = findSubModelPart(model, region);
    if (!selected) throw new Error(`No SubModelPart named ${region} exists in ${sourcePath}.`);
    included = new Set<number>();
    const collect = (part: SubModelPart): void => {
      const ids = field.kind === "Nodal" ? part.nodeIds : field.kind === "Elemental" ? part.elementIds : part.conditionIds;
      for (const id of ids) included!.add(id);
      for (const child of part.children) collect(child);
    };
    collect(selected);
  }

  const componentIndex = args.component === "x" ? 0 : args.component === "y" ? 1 : args.component === "z" ? 2 : -1;
  if (args.component === "scalar" && field.components !== 1) throw new Error(`${args.field} has ${field.components} components; choose x, y, z or magnitude.`);
  if (args.component !== "scalar" && field.components === 1) throw new Error(`${args.field} is scalar; choose component "scalar".`);
  if (componentIndex >= field.components) throw new Error(`${args.field} has only ${field.components} components; component ${args.component} is unavailable.`);

  const values: number[] = [];
  for (let row = 0; row < field.ids.length; row++) {
    if (included && !included.has(field.ids[row])) continue;
    if (args.component === "magnitude") {
      let square = 0;
      for (let component = 0; component < field.components; component++) {
        const value = field.values[row * field.components + component];
        if (!Number.isFinite(value)) { square = NaN; break; }
        square += value * value;
      }
      values.push(Math.sqrt(square));
    } else if (args.component === "scalar") values.push(field.values[row]);
    else values.push(field.values[row * field.components + componentIndex]);
  }

  const timeValues = IN_FILE_TIMELINE_EXTENSIONS.includes(ext) ? await readMeshTimeSteps(sourcePath) : [];
  const requestedStep = args.timeStep ?? 0;
  const normalizedStep = requestedStep < 0 ? timeValues.length + requestedStep : requestedStep;
  const time = timeValues.length ? timeValues[normalizedStep] : args.time ?? 0;
  if (timeValues.length && !Number.isFinite(time)) throw new Error(`No time step ${requestedStep} exists in ${sourcePath}.`);
  const revision = artifactRevision(sourcePath);
  if (!revision) throw new Error(`Could not fingerprint the selected result file: ${sourcePath}`);
  const value = reduceValues(values, args.reduction);
  return {
    version: 1,
    runId: args.runId,
    source: { path: sourcePath, revision },
    evaluation: { field: field.variable, kind: field.kind, component: args.component, region, time, reduction: args.reduction, unit },
    quantity: {
      field: field.variable, kind: field.kind, component: args.component, region, time, reduction: args.reduction,
      unit, value: Number.isFinite(value) ? value : null, runId: args.runId,
    },
  };
}

/**
 * mesh_curvature: the read-only counterpart of mesh_transform's `curvature` op —
 * per-field statistics, the Gauss–Bonnet check and the orientation warnings,
 * without writing any field. Same core (`curvatureModel`), so the two cannot
 * disagree.
 */
export async function meshCurvature(args: {
  path: string;
  mean?: boolean;
  gaussian?: boolean;
  principal?: boolean;
  dualArea?: "mixed-voronoi" | "barycentric";
  includeBoundary?: boolean;
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const { path: _path, ...params } = args;
  const r = await curvatureModel(model, { ...params, area: false });
  if (r.written.length === 0) {
    return { path: args.path, computed: false, message: r.message ?? "Every node's curvature is undefined." };
  }
  const gb = gaussBonnetResidual(r);
  return {
    path: args.path,
    computed: true,
    // Keyed by the field name the op would write (CURVATURE_MEAN, …). `count` is
    // the number of nodes with a defined value; the rest are gaps.
    fields: Object.fromEntries(Object.entries(r.stats).map(([k, s]) => [k.replace(/^Nodal:/, ""), s])),
    nodeCount: model.nodeCount,
    numBoundary: r.numBoundary,
    numIsolated: r.numIsolated,
    numDegenerate: r.numDegenerate,
    totalAngleDefect: r.totalAngleDefect,
    eulerCharacteristic: r.eulerCharacteristic,
    // angle-defect sum minus 2*pi*chi; ~0 for a sound closed surface. Absent for
    // an open or non-manifold one, where the theorem does not apply.
    gaussBonnetResidual: gb,
    watertight: r.quality,
    warnings: r.warnings,
  };
}

/**
 * mesh_compare: how two meshes differ, structurally and per field, matched by
 * ENTITY ID (see meshCompare.ts for why this is native rather than meshio++'s
 * `diff`). With `variable` it also compares that one field — by id, or, for two
 * different discretizations of the same domain, by spatial point sampling — and
 * with `outputPath` it writes mesh A carrying the `<base>_DIFF`/`_ABS`/`_REL`
 * fields (the difference mesh), exactly what mesh_transform's `compareField`
 * op would produce.
 */
export async function meshCompare(args: {
  pathA: string;
  pathB: string;
  hausdorff?: boolean;
  faceSamples?: number;
  atol?: number;
  rtol?: number;
  variable?: string;
  kind?: "Nodal" | "Elemental" | "Conditional";
  sourceVariable?: string;
  correspondence?: "id" | "spatial";
  output?: string;
  outputPath?: string;
  provenance?: string;
  verify?: boolean;
}): Promise<object> {
  const a = await loadMesh(args.pathA);
  const b = await loadMesh(args.pathB);
  const comparison = compareMeshes(a.model, b.model, { atol: args.atol, rtol: args.rtol });
  const out: Record<string, unknown> = { pathA: args.pathA, pathB: args.pathB, comparison };
  if (args.hausdorff) out.hausdorff = await hausdorff(a.model, b.model, args.faceSamples);
  if (args.outputPath && !args.variable) throw new Error("outputPath needs a `variable` to write difference fields for.");
  if (args.variable) {
    const r = await compareFieldModel(a.model, b.model, {
      variable: args.variable,
      kind: args.kind ?? "Nodal",
      sourceVariable: args.sourceVariable,
      correspondence: args.correspondence,
      output: args.output,
      atol: args.atol,
      rtol: args.rtol,
    });
    out.fieldComparison = r.comparison ?? null;
    out.uncovered = r.uncovered;
    out.written = r.written;
    if (r.message) out.message = r.message;
    if (args.outputPath && r.written.length > 0) {
      const warnings: string[] = [];
      const written = await writeModelReported(r.model, args.outputPath, a.sourceText, undefined, warnings, { sourceFile: args.pathA, ops: [{ op: "compareField" }], provenance: args.provenance, verify: args.verify });
      out.outputPath = written.path;
      out.report = written.report;
      out.warnings = warnings;
    }
  }
  return out;
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

/** What `writeModelReported` needs beyond the write itself; every field is optional. */
interface WriteInfo {
  /** The mesh (or recipe target) this model came from, for the report's source line. */
  sourceFile?: string;
  /** Applied operations, in order. */
  ops?: import("../parser/exportReport").ReportOperation[];
  /** `auto` (default) embeds where the format has a header slot, `sidecar` also writes the report beside the file, `none` records nothing. */
  provenance?: string;
  /** Re-read the written file and grade every claim in the report against it. */
  verify?: boolean;
}

function provenanceModeOf(v: string | undefined): ProvenanceMode {
  if (v === undefined) return "auto";
  if ((PROVENANCE_MODES as readonly string[]).includes(v)) return v as ProvenanceMode;
  throw new Error(`provenance must be one of ${PROVENANCE_MODES.join(", ")} (got "${v}").`);
}

/**
 * The write every mesh-writing tool shares, returning the export report next to
 * the path. Mirrors the extension's `writeModelFile` (src/meshExport.ts) through
 * the same `buildExportReport`/`finalizeReport`, so the two describe one export
 * identically. Exported for the viewer batch command, which runs the same
 * load/apply/write pipeline as `mesh_batch_transform`.
 */
export async function writeModelReported(
  model: MdpaModel,
  outPath: string,
  sourceText: string | undefined,
  format?: string,
  /**
   * Collects the writer's advisory messages (today: verbatim `.mdpa`
   * Constraints copied onto renumbered nodes) so the tool can report them
   * instead of writing a quietly-degraded file and saying nothing.
   */
  warningsOut?: string[],
  info: WriteInfo = {}
): Promise<{ path: string; report: ExportReport }> {
  // The report carries every advisory too, so it needs a list even when the
  // caller did not ask for one.
  const warnings = warningsOut ?? [];
  const mode = provenanceModeOf(info.provenance);
  const abs = path.resolve(outPath);
  const ext = meshExtname(abs);
  if (!isExportableExtension(ext) && !format) {
    throw new Error(
      `Cannot write "${ext}" — exportable formats: ${EXPORTABLE_EXTENSIONS.join(", ")}`
    );
  }
  // DOLFIN/TetGen/EnSight throw part-way through the write if the mesh has
  // no representable cells; refuse with the actual reason before that
  // happens (same check the extension host runs — exportEligibility.ts).
  const eligibility = exportEligibility(model, ext);
  if (eligibility && !eligibility.ok) {
    throw new Error(eligibility.reason as string);
  }
  for (const w of eligibility?.warnings ?? []) warnings?.push(w);
  const elmer = ext === ".elmer" || format === "elmer";
  const caseDir = elmer ? abs : path.dirname(abs);
  if (elmer) await assertFreshElmerDestination(caseDir);
  const outputStem = elmer ? path.basename(abs, ext === ".elmer" ? ext : "") : undefined;
  const sourceName = info.sourceFile ? path.basename(info.sourceFile) : undefined;
  const sourceFormat = info.sourceFile ? meshExtname(info.sourceFile) : undefined;
  const { data, companions, provenance } = await writeMeshFileAsync(model, ext, {
    sourceText: ext === ".mdpa" ? sourceText : undefined,
    name: outputStem ?? path.basename(abs, ext),
    format,
    onWarning: (m) => warnings.push(m),
    provenance: provenanceRequest(mode, {
      sourceFile: sourceName,
      sourceFormat,
      ops: info.ops,
      tool: "Kratos MDPA Preview MCP server",
      kernelVersion: meshioPackageVersion(),
    }),
  });
  // Uint8Array (the binary meshio++ formats) is written raw; a string as utf8.
  fs.mkdirSync(caseDir, { recursive: true });
  const markerPath = elmer ? path.join(caseDir, `${outputStem || path.basename(caseDir)}.elmer`) : abs;
  fs.writeFileSync(markerPath, data);
  // XDMF references its companion .h5 by name — the main file is useless alone;
  // an OpenFOAM `.foam` marker is 0 bytes and its companions ARE the mesh. Both
  // give a companion a relative path, whose folders may not exist yet.
  for (const c of companions) {
    const dest = path.join(caseDir, c.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, c.data);
  }
  invalidateCache(abs);
  const built = buildExportReport({
    model,
    ext,
    format,
    targetFile: path.basename(markerPath),
    companions: companions.map((c) => c.name),
    sourceFile: sourceName,
    sourceFormat,
    ops: info.ops,
    warnings: [...warnings],
    kernelVersion: meshioPackageVersion(),
  });
  const done = finalizeReport(built, mode, provenance?.embedded === true, !isNativeExportExtension(ext) || !!format);
  let report = done.report;
  if (done.sidecar) fs.writeFileSync(path.join(path.dirname(markerPath), done.sidecar.name), done.sidecar.text);
  if (info.verify) {
    try {
      const reread = await parseMeshFile(markerPath, undefined, format ? { meshioFormat: format } : undefined);
      report = verifyReport(report, observeExport(model, reread));
    } catch (e) {
      report = { ...report, unexpected: [`the written file could not be re-read: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  return { path: markerPath, report };
}

/**
 * Runs op records one at a time against the ROLLING model, not the mesh as
 * originally opened — this is what lets a later remesh `expr` step see a field
 * an EARLIER step in the same sequence just computed (e.g. sdfDistance's own
 * "d"). Shared by `mesh_transform` and `mesh_batch_transform`, and exported for
 * the viewer batch command, which runs the same rolling-model loop.
 */
export async function applyRecipeToModel(
  start: MdpaModel,
  raw: unknown[],
  signal?: AbortSignal
): Promise<{ model: MdpaModel; operations: { op: string; label: string }[]; outcomes: { op: string; label: string; noop: boolean; message?: string }[] }> {
  let model = start;
  const outcomes: { op: string; label: string; noop: boolean; message?: string }[] = [];
  const operations: { op: string; label: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (signal?.aborted) throw new Error("cancelled");
    const entry = raw[i];
    const rec = opRecordFromMessage((entry ?? {}) as Record<string, unknown>, model);
    if (!rec) {
      const opName = (entry as { op?: unknown } | null)?.op;
      throw new Error(
        `ops[${i}]: invalid or unknown operation ${JSON.stringify(opName)}. ` +
          `Known ops: ${Object.keys(OP_LABELS).join(", ")}`
      );
    }
    const out = isAsyncOp(rec.op)
      ? await withMmgLock(() =>
          applyOpAsync(model, rec, { signal, onProgress: (m) => progressSink?.(m) })
        )
      : await applyOpAsync(model, rec);
    outcomes.push({ op: rec.op, label: OP_LABELS[rec.op], noop: out.noop === true, message: out.message });
    operations.push({ ...rec, label: OP_LABELS[rec.op] });
    model = out.model;
  }
  return { model, outcomes, operations };
}

export async function meshTransform(args: {
  path: string;
  ops?: unknown[];
  recipePath?: string;
  outputPath?: string;
  provenance?: string;
  verify?: boolean;
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
  const applied = await applyRecipeToModel(src.model, raw);
  const model = applied.model;
  const outcomes = applied.outcomes;
  const { path: written, report } = await writeModelReported(
    model,
    args.outputPath ?? args.path,
    src.sourceText,
    undefined,
    warnings,
    {
      sourceFile: args.path,
      ops: applied.operations,
      provenance: args.provenance,
      verify: args.verify,
    }
  );
  return {
    outputPath: written,
    report,
    outcomes,
    warnings,
    diagnostics: diagnosticsBlock(model),
    nodeCount: { before: src.model.nodeCount, after: model.nodeCount },
    elementCount: { before: countByKind(src.model, "Elements"), after: countByKind(model, "Elements") },
    bounds: model.bounds,
  };
}

/**
 * Applies one recipe to many meshes (former roadmap item 5, delivered 2026-10-09). Explicit and sequential:
 * one file is loaded, transformed, written and released before the next, so a
 * long series never holds more than one model. The plan is refused as a whole
 * when any output would overwrite an input or another output; a per-file
 * failure is recorded and never stops the rest; `<outputDir>/kkss-batch.json`
 * records every file so `resume` skips those already done.
 */
/** size:mtime of a file, or undefined when it cannot be statted. Shared with the viewer batch command. */
export function stampOfPath(fsPath: string): string | undefined {
  try {
    const st = fs.statSync(fsPath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Persists the batch manifest atomically (tmp + rename). Shared with the viewer batch command. */
export function saveBatchManifestAtomic(manifestPath: string, manifest: BatchManifest): void {
  const tmp = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, serializeBatchManifest(manifest), { flag: "wx" });
  fs.renameSync(tmp, manifestPath);
}

export async function meshBatchTransform(args: {
  paths?: string[];
  seriesOf?: string;
  ops?: unknown[];
  recipePath?: string;
  /** Name of a recipe preset from `.kratos/recipes` (alternative to `ops`/`recipePath`). */
  recipePreset?: string;
  /** Extra directories searched for presets (absolute, or relative to the working directory). */
  recipePresetDirs?: string[];
  recipeName?: string;
  outputDir: string;
  naming?: string;
  outputExt?: string;
  overwrite?: boolean;
  resume?: boolean;
  dryRun?: boolean;
  provenance?: string;
}): Promise<object> {
  const warnings: string[] = [];
  let raw = args.ops;
  let recipeText: string;
  let preset: RecipePreset | undefined;
  const sources = [raw?.length ? "ops" : "", args.recipePath ? "recipePath" : "", args.recipePreset ? "recipePreset" : ""].filter(
    Boolean
  );
  if (sources.length > 1) {
    throw new Error(`Provide only one of \`ops\`, \`recipePath\`, \`recipePreset\` (got ${sources.join(", ")}).`);
  }
  if (args.recipePreset) {
    const found = discoverRecipePresets([process.cwd()], [...DEFAULT_RECIPE_PRESET_PATHS, ...(args.recipePresetDirs ?? [])]);
    for (const p of found.problems) warnings.push(`${p.file}: ${p.message}`);
    preset = findRecipePreset(found.presets, args.recipePreset);
    if (!preset) {
      const known = found.presets.map((p) => p.name).join(", ");
      throw new Error(
        `Unknown recipe preset "${args.recipePreset}". Known presets: ${known || "(none)"}. ` +
          `Presets live in ${DEFAULT_RECIPE_PRESET_PATHS.join(", ")} under the working directory (or \`recipePresetDirs\`).`
      );
    }
    raw = preset.ops;
    recipeText = JSON.stringify(preset.ops);
  } else if (args.recipePath) {
    if (raw?.length) throw new Error("Provide either `ops` or `recipePath`, not both.");
    recipeText = fs.readFileSync(args.recipePath, "utf8");
    const parsed = parseOpsJson(recipeText);
    warnings.push(...parsed.warnings);
    raw = parsed.operations;
  } else {
    recipeText = JSON.stringify(raw ?? []);
  }
  if (!raw || raw.length === 0) {
    throw new Error("No operations: provide `ops` (array of op records) or `recipePath`.");
  }
  if (!!args.paths?.length === !!args.seriesOf) {
    throw new Error("Provide exactly one of `paths` (explicit files) or `seriesOf` (a series file or folder).");
  }
  let inputs: string[];
  if (args.seriesOf) {
    const abs = path.resolve(args.seriesOf);
    const files = fs.statSync(abs).isDirectory() ? await seriesFilesInDir(abs) : await discoverSeriesFiles(abs);
    if (files.length === 0) throw new Error(`No filename series found at ${abs}.`);
    inputs = files.map((f) => f.fsPath);
  } else {
    inputs = args.paths!.map((p) => path.resolve(p));
  }
  const recipeName =
    args.recipeName ?? (args.recipePath ? path.basename(args.recipePath).replace(/\.ops\.json$|\.json$/i, "") : preset?.name ?? "batch");
  const outputDir = path.resolve(args.outputDir);
  const manifestPath = path.join(outputDir, BATCH_MANIFEST_NAME);
  const hash = recipeHash(recipeText);
  let resume: BatchManifest | undefined;
  if (args.resume && fs.existsSync(manifestPath)) {
    const parsed = parseBatchManifest(fs.readFileSync(manifestPath, "utf8"));
    warnings.push(...parsed.warnings);
    resume = parsed.manifest;
  }
  const planned = planBatch({
    inputs,
    outputDir,
    recipeName,
    naming: args.naming ?? preset?.naming,
    outputExt: args.outputExt ?? preset?.outputExt,
    overwrite: args.overwrite ?? preset?.overwrite ?? false,
    // A resumed run legitimately meets its own earlier outputs.
    exists: (p) => !resume && fs.existsSync(p),
  });
  if (planned.problems.length > 0) {
    throw new Error(`Batch refused, nothing written:\n- ${planned.problems.join("\n- ")}`);
  }
  if (args.dryRun) {
    return {
      dryRun: true,
      recipeName,
      ...(preset ? { recipePreset: preset.name, recipePresetFile: preset.file } : {}),
      outputDir,
      manifestPath,
      plan: planned.entries,
      warnings: [...warnings, ...planned.warnings],
    };
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const result = await runBatch(
    planned.entries,
    {
      stampOf: stampOfPath,
      save: (m) => saveBatchManifestAtomic(manifestPath, m),
      process: async (entry, signal) => {
        const src = await loadMesh(entry.input);
        const applied = await applyRecipeToModel(src.model, raw!, signal);
        const w: string[] = [];
        const { report } = await writeModelReported(applied.model, entry.output, src.sourceText, undefined, w, {
          sourceFile: entry.input,
          ops: applied.operations,
          provenance: args.provenance,
        });
        const lossy = report.warnings?.length ?? w.length;
        return { report, message: `${applied.outcomes.length} op(s) applied${lossy ? `, ${lossy} writer warning(s)` : ""}` };
      },
    },
    { recipeName, recipeHash: hash, resume, onProgress: (d, t, e) => progressSink?.(`Batch ${d}/${t}: ${path.basename(e.input)} ${e.status}`) }
  );
  return {
    recipeName,
    ...(preset ? { recipePreset: preset.name, recipePresetFile: preset.file } : {}),
    outputDir,
    manifestPath,
    done: result.done,
    failed: result.failed,
    skipped: result.skipped,
    cancelled: result.cancelled,
    resumeNote: result.resumeNote,
    entries: result.manifest.entries,
    warnings,
  };
}

export async function meshConvert(args: {
  path: string;
  outputPath: string;
  inputFormat?: string;
  outputFormat?: string;
  /** Selects a step of a multi-step input file (Exodus, MED, GiD postprocess, CGNS/Tecplot, XDMF, OpenFOAM time directories). */
  timeStep?: number;
  /** Selects one piece of a .pvtu/.pvtp input instead of merging every piece (0-based). */
  piece?: number;
  /** Drop ghost/duplicate cells at partition seams (.pvtu/.pvtp; defaults to true for them). */
  dropGhosts?: boolean;
  /** Selects one region of a multi-region OpenFOAM input case (.foam) instead of merging every region. */
  region?: string;
  provenance?: string;
  verify?: boolean;
}): Promise<object> {
  const src = await loadMesh(
    args.path,
    args.inputFormat,
    args.timeStep,
    args.piece,
    args.dropGhosts,
    args.region
  );
  const warnings: string[] = [];
  const { path: written, report } = await writeModelReported(
    src.model,
    args.outputPath,
    src.sourceText,
    args.outputFormat,
    warnings,
    { sourceFile: args.path, provenance: args.provenance, verify: args.verify }
  );
  return {
    outputPath: written,
    report,
    sourceFormat: src.ext,
    targetFormat: meshExtname(written),
    nodeCount: src.model.nodeCount,
    elementCount: countByKind(src.model, "Elements"),
    conditionCount: countByKind(src.model, "Conditions"),
    warnings,
    diagnostics: diagnosticsBlock(src.model),
  };
}

export async function meshExtractSubModelPart(args: {
  path: string;
  submodelpart: string;
  outputPath: string;
  provenance?: string;
  verify?: boolean;
}): Promise<object> {
  const src = await loadMesh(args.path);
  const extracted = extractSubModelPart(src.model, args.submodelpart);
  if (!extracted) {
    throw new Error(
      `SubModelPart "${args.submodelpart}" not found. Available: ` +
        subModelPartPaths(src.model.subModelParts).join(", ")
    );
  }
  const warnings: string[] = [];
  const { path: written, report } = await writeModelReported(extracted, args.outputPath, undefined, undefined, warnings, {
    sourceFile: args.path,
    provenance: args.provenance,
    verify: args.verify,
  });
  return {
    outputPath: written,
    report,
    submodelpart: args.submodelpart,
    nodeCount: extracted.nodeCount,
    blocks: extracted.blocks.map(blockSummary),
    warnings,
    diagnostics: diagnosticsBlock(extracted),
  };
}

const KIND_OF_ENTITY: Record<string, EntityKind> = {
  Element: "Elements",
  Condition: "Conditions",
  Geometry: "Geometries",
};

export async function meshExtractSkin(args: {
  path: string;
  outputPath: string;
  provenance?: string;
  verify?: boolean;
}): Promise<object> {
  const src = await loadMesh(args.path);
  const { model: skin, faces } = extractSkinModel(src.model);
  if (faces === 0) {
    throw new Error("No boundary faces found — the mesh has no volume or surface cells to skin.");
  }
  const warnings: string[] = [];
  const { path: written, report } = await writeModelReported(skin, args.outputPath, undefined, undefined, warnings, {
    sourceFile: args.path,
    provenance: args.provenance,
    verify: args.verify,
  });
  return {
    outputPath: written,
    report,
    faces,
    nodeCount: skin.nodeCount,
    blocks: skin.blocks.map(blockSummary),
    warnings,
    diagnostics: diagnosticsBlock(skin),
  };
}

/**
 * mesh_derive: a NEW mesh computed from the opened one — a slice, an isosurface
 * or a threshold region — written to `outputPath`. Not an edit (nothing is
 * undoable and nothing is written back to the input), so it lives beside
 * mesh_extract_skin rather than in mesh_transform. Same core as the UI's
 * Export slice / Export isosurface / Export region: `deriveMesh`.
 */
export async function meshDerive(args: {
  /** Optional only for kind "grid", which is made from nothing. */
  path?: string;
  provenance?: string;
  verify?: boolean;
  kind: "featureEdges" | "slice" | "isosurface" | "threshold" | "decimate" | "grid" | "voxelize" | "sdfVolume" | "streamlines";
  outputPath: string;
  outputFormat?: string;
  /** Read this step of a multi-step file instead of the first (the frame every kind works on). */
  timeStep?: number;
  seedPoints?: number[][];
  seedLine?: { from: number[]; to: number[]; count: number };
  seedPlane?: { origin: number[]; u: number[]; v: number[]; nu: number; nv: number };
  seedPart?: string;
  direction?: "forward" | "backward" | "both";
  maxSteps?: number;
  maxLength?: number;
  stepFraction?: number;
  minSpeed?: number;
  maxSeeds?: number;
  origin?: number[];
  normal?: number[];
  variable?: string;
  values?: number[];
  component?: number | "mag";
  fieldKind?: "Nodal" | "Elemental" | "Conditional";
  range?: number[];
  normalizedRange?: number[];
  referenceRange?: number[] | "frame";
  rule?: "all" | "any";
  output?: "region" | "skin";
  ratio?: number;
  targetFaces?: number;
  maxError?: number;
  placement?: "optimal" | "midpoint" | "endpoint";
  preserveBoundary?: boolean;
  preserveFeatures?: boolean;
  featureAngle?: number;
  feature?: boolean;
  boundary?: boolean;
  nonManifold?: boolean;
  inconsistent?: boolean;
  frozenPart?: string;
  dims?: number[];
  spacing?: number[];
  resolution?: number[];
  cellSize?: number;
  bounds?: number[];
  padding?: number;
  paddingRelative?: number;
  fill?: "all" | "surface" | "inside";
  sign?: "pseudonormal" | "winding-number" | "unsigned";
  attachOccupancy?: boolean;
  structure?: "voxel" | "octree";
  location?: "corner" | "center";
  band?: number;
  rootResolution?: number;
  maxDepth?: number;
}): Promise<object> {
  if (!args.path && !DERIVE_STANDALONE_KINDS.includes(args.kind)) throw new Error(`kind "${args.kind}" needs a \`path\`.`);
  const src = args.path ? await loadMesh(args.path, undefined, args.timeStep) : { model: parseMdpa("") };
  const pair = (v: number[] | undefined, what: string): [number, number] => {
    if (!v || v.length !== 2) throw new Error(`${what} must be [lo, hi].`);
    return [v[0], v[1]];
  };
  const triple = (v: number[] | undefined, what: string): [number, number, number] => {
    if (!v || v.length !== 3) throw new Error(`${what} must be [x, y, z].`);
    return [v[0], v[1], v[2]];
  };
  let spec: DeriveSpec;
  if (args.kind === "slice") {
    spec = { kind: "slice", origin: triple(args.origin, "origin"), normal: triple(args.normal, "normal") };
  } else if (args.kind === "isosurface") {
    if (!args.variable) throw new Error("An isosurface needs a `variable`.");
    spec = { kind: "isosurface", variable: args.variable, values: args.values ?? [], component: args.component };
  } else if (args.kind === "threshold") {
    if (!args.variable) throw new Error("A threshold needs a `variable`.");
    spec = {
      kind: "threshold",
      variable: args.variable,
      fieldKind: args.fieldKind ?? "Nodal",
      component: args.component,
      range: args.range ? pair(args.range, "range") : undefined,
      normalized: args.normalizedRange
        ? {
            range: pair(args.normalizedRange, "normalizedRange"),
            reference: args.referenceRange === "frame" ? "frame" : pair(args.referenceRange as number[] | undefined, "referenceRange"),
          }
        : undefined,
      rule: args.rule,
      output: args.output,
    };
  } else if (args.kind === "decimate") {
    spec = {
      kind: "decimate",
      ratio: args.ratio,
      targetFaces: args.targetFaces,
      maxError: args.maxError,
      placement: args.placement,
      preserveBoundary: args.preserveBoundary,
      preserveFeatures: args.preserveFeatures,
      featureAngle: args.featureAngle,
      frozenPart: args.frozenPart,
    };
  } else if (args.kind === "grid") {
    spec = {
      kind: "grid",
      dims: (args.dims ?? []) as [number, number, number],
      origin: args.origin as [number, number, number] | undefined,
      spacing: args.spacing as [number, number, number] | undefined,
    };
  } else if (args.kind === "voxelize" || args.kind === "sdfVolume") {
    const lattice = {
      resolution: args.resolution as [number, number, number] | undefined,
      cellSize: args.cellSize,
      bounds: args.bounds,
      padding: args.padding,
      paddingRelative: args.paddingRelative,
      sign: args.sign,
    };
    spec =
      args.kind === "voxelize"
        ? { kind: "voxelize", ...lattice, fill: args.fill, attachOccupancy: args.attachOccupancy }
        : { kind: "sdfVolume", ...lattice, structure: args.structure, location: args.location, band: args.band, rootResolution: args.rootResolution, maxDepth: args.maxDepth };
  } else if (args.kind === "streamlines") {
    if (!args.variable) throw new Error("Streamlines need a `variable` (a Nodal vector field).");
    const given = [args.seedPoints, args.seedLine, args.seedPlane, args.seedPart].filter((x) => x !== undefined).length;
    if (given !== 1) throw new Error("Give exactly one of seedPoints, seedLine, seedPlane and seedPart.");
    const seeds: StreamSeeds = args.seedPoints
      ? { kind: "points", points: args.seedPoints.map((p) => triple(p, "every seed point")) }
      : args.seedLine
        ? { kind: "line", from: triple(args.seedLine.from, "seedLine.from"), to: triple(args.seedLine.to, "seedLine.to"), count: args.seedLine.count }
        : args.seedPlane
          ? { kind: "plane", origin: triple(args.seedPlane.origin, "seedPlane.origin"), u: triple(args.seedPlane.u, "seedPlane.u"), v: triple(args.seedPlane.v, "seedPlane.v"), nu: args.seedPlane.nu, nv: args.seedPlane.nv }
          : { kind: "part", path: args.seedPart! };
    spec = {
      kind: "streamlines",
      variable: args.variable,
      seeds,
      direction: args.direction,
      maxSteps: args.maxSteps,
      maxLength: args.maxLength,
      stepFraction: args.stepFraction,
      minSpeed: args.minSpeed,
      maxSeeds: args.maxSeeds,
      frame: args.path ? `${path.basename(args.path)}${args.timeStep !== undefined ? `, step ${args.timeStep}` : ""}` : undefined,
    };
  } else {
    throw new Error(`kind must be one of ${DERIVE_KINDS.join(", ")}.`);
  }
  // A streamline trace reports per-seed progress as MCP log lines (throttled to
  // whole percents — a 1000-seed run must not emit 1000 lines); every other
  // kind ignores the callback. Cancellation stays with the request lifecycle
  // (item 2): `register.ts` does not forward the MCP abort signal into tools.
  let lastPct = -1;
  const derived = await deriveMesh(src.model, spec, [], {
    onProgress: (done, total) => {
      const pct = total > 0 ? Math.floor((100 * done) / total) : 100;
      if (pct >= lastPct + 10 || done >= total) {
        lastPct = pct;
        progressSink?.(`Streamlines ${done}/${total} seeds`);
      }
    },
  });
  const warnings: string[] = [];
  let written: string;
  let report: ExportReport | undefined;
  const deriveOps = [{ op: `derive:${spec.kind}`, parameters: spec }];
  if (meshExtname(path.resolve(args.outputPath)) === ".vti") {
    // The one container our unstructured writers cannot produce: a dense lattice, written straight from meshio++'s own mesh.
    if (!derived.raw || !derived.denseLattice) {
      throw new Error(".vti holds a dense regular lattice: use kind \"grid\", an sdfVolume with structure \"voxel\", or a voxelize with fill \"all\" — any partial lattice must be written as .vtu or another cell format.");
    }
    const abs = path.resolve(args.outputPath);
    const mode = provenanceModeOf(args.provenance);
    const sourceFile = args.path ? path.basename(args.path) : undefined;
    const sourceFormat = args.path ? meshExtname(args.path) : undefined;
    const raw = await writeRawMeshioBytes(derived.raw, ".vti", "vti", { stem: path.basename(abs, ".vti"), provenance: provenanceRequest(mode, { sourceFile, sourceFormat, ops: deriveOps, tool: "Kratos MDPA Preview MCP server", kernelVersion: meshioPackageVersion() }) });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, raw.data);
    for (const c of raw.companions) {
      const dest = path.join(path.dirname(abs), c.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, c.data);
    }
    invalidateCache(abs);
    written = abs;
    const done = finalizeReport(buildUnverifiedReport({ model: derived.model, ext: ".vti", format: "vti", targetFile: path.basename(abs), sourceFile, sourceFormat, ops: deriveOps, companions: raw.companions.map((c) => c.name), kernelVersion: meshioPackageVersion() }, "structured lattice writer; single-mesh fidelity measurements do not cover this path"), mode, raw.provenance?.embedded === true, true);
    report = done.report;
    if (args.verify) {
      try { report = verifyReport(report, observeExport(derived.model, await parseMeshFile(abs))); }
      catch (e) { report.warnings.push(`Verification could not re-read the output: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (done.sidecar) fs.writeFileSync(path.join(path.dirname(abs), done.sidecar.name), serializeReport(report));
  } else {
    // No sourceText: the result is new geometry or a restriction, so the input's
    // verbatim Properties/Table blocks do not apply.
    const r = await writeModelReported(derived.model, args.outputPath, undefined, args.outputFormat, warnings, {
      sourceFile: args.path,
      ops: deriveOps,
      provenance: args.provenance,
      verify: args.verify,
    });
    written = r.path;
    report = r.report;
  }
  return {
    outputPath: written,
    ...(report ? { report } : {}),
    kind: args.kind,
    summary: derived.summary,
    nodeCount: derived.model.nodeCount,
    blocks: derived.model.blocks.map(blockSummary),
    fields: derived.model.fields.map((f) => ({ kind: f.kind, variable: f.variable, components: f.components, count: f.ids.length })),
    ...(derived.streamlines ? { streamlines: derived.streamlines } : {}),
    warnings,
    diagnostics: diagnosticsBlock(derived.model),
  };
}

/**
 * mesh_probe: a nodal field along a polyline — distance-versus-value rows, a gap
 * (null) wherever the path leaves the mesh or crosses a region the field was
 * never written, optionally across EVERY step of a time series.
 */
export async function meshProbe(args: {
  path: string;
  points: number[][];
  variable: string;
  samples?: number;
  allSteps?: boolean;
  outputPath?: string;
}): Promise<object> {
  const params = { points: args.points as [number, number, number][], samples: args.samples ?? 101, variable: args.variable };
  let written: string | undefined;
  const writeCsv = (csv: string): void => {
    if (!args.outputPath) return;
    const out = path.resolve(args.outputPath);
    if (path.extname(out).toLowerCase() !== ".csv") throw new Error(`Cannot write a probe as "${path.extname(out)}" — supported: .csv`);
    fs.writeFileSync(out, csv, "utf8");
    written = out;
  };
  if (!args.allSteps) {
    const src = await loadMesh(args.path);
    const r = await probeAlongPath(src.model, params);
    writeCsv(probeToCsv(r));
    return { path: path.resolve(args.path), ...r, outputPath: written };
  }
  const abs = path.resolve(args.path);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const { steps, source } = await discoverSeriesSteps(abs);
  const results: { label: string; result?: Awaited<ReturnType<typeof probeAlongPath>>; error?: string }[] = [];
  // One model at a time, like the series scan: peak memory is one step.
  for (const step of steps) {
    try {
      // A lone file is not a series; `parseMeshFile` does not read .mdpa, so it goes through loadMesh like every other tool.
      const model = source === "single" ? (await loadMesh(abs)).model : await step.load();
      results.push({ label: step.label, result: await probeAlongPath(model, params) });
    } catch (err) {
      // A half-written file from a running solver is the normal case; one bad step must not lose the rest.
      results.push({ label: step.label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const first = results.find((x) => x.result)?.result;
  if (first) {
    const lines = [["step", "distance", "x", "y", "z", ...first.columns].join(",")];
    for (const r of results) {
      if (!r.result) continue;
      for (const row of r.result.rows) {
        lines.push([JSON.stringify(r.label), row.distance, ...row.position, ...row.values.map((v) => (v === null ? "" : v))].join(","));
      }
    }
    writeCsv(lines.join("\n") + "\n");
  }
  return { path: abs, source, totalSteps: steps.length, steps: results, outputPath: written };
}

/**
 * mesh_split: one input mesh -> SEVERAL files. `by: "partition"` writes N
 * per-part meshes (optionally with ghost layers) for a distributed run;
 * `"component"`, `"type"` and `"field"` split into connected bodies, element
 * types or the distinct values of an elemental field. Every part keeps the
 * SOURCE's own ids, kinds, Properties, SubModelParts and fields (see
 * partitionExport.ts / splitComponents.ts), and a manifest is written beside
 * them and returned.
 */
export async function meshSplit(args: {
  path: string;
  by: "partition" | "component" | "type" | "field";
  outputDir: string;
  format?: string;
  outputFormat?: string;
  nparts?: number;
  method?: "sfc" | "kahip" | "auto";
  imbalance?: number;
  seed?: number;
  ghostLayers?: number;
  weights?: string;
  variable?: string;
  fragmentFraction?: number;
  provenance?: string;
  verify?: boolean;
}): Promise<object> {
  const src = await loadMesh(args.path);
  const abs = path.resolve(args.path);
  const stem = meshStem(abs);
  const ext = (args.format ?? (isExportableExtension(meshExtname(abs)) ? meshExtname(abs) : ".vtu")).toLowerCase();
  if (!isExportableExtension(ext)) throw new Error(`Cannot write "${ext}" — exportable formats: ${EXPORTABLE_EXTENSIONS.join(", ")}`);
  const dir = path.resolve(args.outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const warnings: string[] = [];
  const files: string[] = [];
  const reports: ExportReport[] = [];
  const write = async (m: MdpaModel, key: string): Promise<string> => {
    const out = path.join(dir, `${stem}_${key}${ext}`);
    const written = await writeModelReported(m, out, undefined, args.outputFormat, undefined, { sourceFile: abs, ops: [{ op: `split:${args.by}` }], provenance: args.provenance, verify: args.verify });
    reports.push(written.report);
    warnings.push(...written.report.warnings);
    return out;
  };

  if (args.by === "partition") {
    if (args.nparts === undefined) throw new Error("`nparts` is required for by: \"partition\".");
    const r = await partitionParts(src.model, {
      nparts: args.nparts,
      method: args.method,
      imbalance: args.imbalance,
      seed: args.seed,
      ghostLayers: args.ghostLayers,
      weights: args.weights,
    });
    for (const p of r.parts) files.push(await write(p.model, `part${p.partId}`));
    const manifest = partitionManifest(abs, r, files.map((f) => path.basename(f)), { reports });
    const manifestPath = path.join(dir, `${stem}.partitions.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return { by: "partition", manifestPath, ...(manifest as object), warnings: [...(r.warnings), ...warnings] };
  }

  const spec =
    args.by === "component"
      ? ({ by: "component", fragmentFraction: args.fragmentFraction } as const)
      : args.by === "type"
        ? ({ by: "type" } as const)
        : args.by === "field"
          ? (args.variable ? ({ by: "field", variable: args.variable } as const) : undefined)
          : undefined;
  if (!spec) throw new Error(args.by === "field" ? "`variable` is required for by: \"field\"." : `by must be one of partition, component, type, field.`);
  const r = splitModel(src.model, spec);
  const groups: object[] = [];
  for (const g of r.groups) {
    const f = await write(g.model, g.key);
    files.push(f);
    groups.push({ key: g.key, file: path.basename(f), elements: g.elements, conditions: g.conditions, nodes: g.nodes, ...(g.isolated !== undefined ? { isolated: g.isolated } : {}) });
  }
  const manifest = {
    source: abs,
    by: args.by,
    idsPreserved: true,
    groups,
    reports,
    unassignedConditions: r.unassignedConditions,
    looseNodes: r.looseNodes,
    warnings: [...r.warnings, ...warnings],
  };
  const manifestPath = path.join(dir, `${stem}.split.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifestPath, ...manifest };
}

/** JSON mode returns rows inline, so it is bounded: an agent asking for a
 *  five-million-row mesh would otherwise flood its own context. */
const TABLE_JSON_DEFAULT = 100;
const TABLE_JSON_MAX = 10_000;

const TABLE_WRITE_EXTENSIONS = [".csv", ".xlsx"];

/**
 * The data table: every node/element/condition/geometry as a row of plain
 * values — coordinates or connectivity, plus every field defined there.
 *
 * The parity counterpart of the webview's Data table panel, and the only tool
 * that reports field VALUES: `mesh_info` reports field metadata alone, and
 * `mesh_find_entity` answers for one id. Both modes build the table through
 * the same `prepareTable` the panel uses.
 */
export async function meshExportTable(args: {
  path: string;
  kind: string;
  outputPath?: string;
  submodelpart?: string;
  membership?: boolean;
  nodeColumns?: boolean;
  limit?: number;
  offset?: number;
  inputFormat?: string;
  timeStep?: number;
}): Promise<object> {
  if (!isTableKind(args.kind)) {
    throw new Error(`Unknown kind "${args.kind}" — expected one of ${TABLE_KINDS.join(", ")}.`);
  }
  const { model } = await loadMesh(args.path, args.inputFormat, args.timeStep);
  const opts = {
    membership: args.membership,
    submodelpart: args.submodelpart,
    nodeColumns: args.nodeColumns,
  };
  const view = prepareTable(
    model,
    args.kind,
    opts,
    args.membership ? buildMembershipIndex(model.subModelParts) : undefined
  );

  if (args.outputPath) {
    const abs = path.resolve(args.outputPath);
    const ext = path.extname(abs).toLowerCase();
    // Deliberately NOT writeModel: that is the mesh-writer path and knows only
    // mesh formats, so its error would name the wrong list of extensions.
    if (!TABLE_WRITE_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Cannot write a table as "${ext}" — supported: ${TABLE_WRITE_EXTENSIONS.join(", ")}`
      );
    }
    let truncated = 0;
    if (ext === ".xlsx") {
      const result = writeXlsx(view, args.kind);
      fs.writeFileSync(abs, result.data);
      truncated = result.truncated;
    } else {
      const out = fs.openSync(abs, "w");
      try {
        for (const chunk of csvChunks(view)) fs.writeSync(out, chunk);
      } finally {
        fs.closeSync(out);
      }
    }
    return {
      outputPath: abs,
      kind: args.kind,
      columns: view.columns,
      rowCount: view.rowCount,
      ...(truncated > 0 ? { truncated } : {}),
    };
  }

  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? TABLE_JSON_DEFAULT)), TABLE_JSON_MAX);
  const end = Math.min(view.rowCount, offset + limit);
  const rows: (number | string | null)[][] = [];
  for (let i = offset; i < end; i++) {
    // A blank is null rather than undefined: JSON.stringify drops undefined
    // from an array position, which would shift every later column.
    rows.push(view.row(i).map((v) => (v === undefined ? null : v)));
  }
  return {
    kind: args.kind,
    columns: view.columns,
    rowCount: view.rowCount,
    offset,
    rows,
  };
}

/** JSON mode is bounded: a 5 000-step run must not be one unbounded call. */
const SERIES_DEFAULT_LIMIT = 200;
const SERIES_MAX_LIMIT = 5_000;

/** entityType -> the FieldData kind that entity's values live under. */
const SERIES_FIELD_KIND: Record<string, FieldSeriesSpec["kind"]> = {
  Node: "Nodal",
  Element: "Elemental",
  Condition: "Conditional",
};

/**
 * One entity's value for one variable across every step of a time series —
 * the headless mirror of the viewer's "Plot over time".
 *
 * The only tool that reads a value ACROSS steps: `mesh_info` reports field
 * metadata, `mesh_export_table` reads one step, and `mesh_find_entity` reads
 * one id. Step discovery is the same code the VTK preview uses, so a sibling
 * `<prefix>_<rank>_<step>` series is found from any one of its files.
 *
 * It deliberately does NOT go through `loadMesh`: that 4-entry LRU is keyed
 * path+mtime+size, a non-zero `timeStep` bypasses it in both directions
 * anyway, and a 200-step scan would evict everything else fifty times over.
 */
export async function meshFieldSeries(args: {
  path: string;
  entityType: string;
  entityId: number;
  variable: string;
  outputPath?: string;
  offset?: number;
  limit?: number;
}): Promise<object> {
  const kind = SERIES_FIELD_KIND[args.entityType];
  if (!kind) {
    // Geometries are refused by name rather than returning a series of nulls:
    // FieldBlockKind has no geometric member, so there is nothing to sample.
    throw new Error(
      `entityType must be one of ${Object.keys(SERIES_FIELD_KIND).join(", ")} ` +
        `— "${args.entityType}" carries no field values.`
    );
  }
  if (!args.variable) throw new Error("variable is required.");
  const abs = path.resolve(args.path);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);

  const { steps, source } = await discoverSeriesSteps(abs);
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const limit = Math.min(
    Math.max(1, Math.floor(args.limit ?? SERIES_DEFAULT_LIMIT)),
    SERIES_MAX_LIMIT
  );
  const window = steps.slice(offset, offset + limit);
  const series = await collectFieldSeries(window, {
    kind,
    variable: args.variable,
    entityId: args.entityId,
  });

  let written: string | undefined;
  if (args.outputPath) {
    const out = path.resolve(args.outputPath);
    const ext = path.extname(out).toLowerCase();
    if (ext !== ".csv") {
      throw new Error(`Cannot write a series as "${ext}" — supported: .csv`);
    }
    fs.writeFileSync(out, seriesToCsv(series), "utf8");
    written = out;
  }

  return {
    path: abs,
    // Tells an agent that pointed at a static file that it got one point, not
    // a series — otherwise a length-1 result looks like a broken timeline.
    source,
    entityType: args.entityType,
    entityId: args.entityId,
    variable: args.variable,
    components: series.components,
    componentNames: series.componentNames,
    totalSteps: steps.length,
    offset,
    labels: series.labels,
    frameIndices: series.frameIndices,
    // A gap is null, never 0 — the variable or the id is absent at that step.
    values: series.values,
    present: series.present,
    missingField: series.missingField,
    missingId: series.missingId,
    ...(series.topologyChangedAt !== undefined
      ? { topologyChangedAt: series.topologyChangedAt }
      : {}),
    errors: series.errors,
    ...(written ? { outputPath: written } : {}),
  };
}

/**
 * Packs a run's per-step mesh files into one time-series container.
 *
 * `target` picks the container, and the DEFAULT is the one that was always
 * there: a single XDMF, which cannot represent a series whose mesh changes
 * between steps. The refusal for that case names `.pvd`, which can — the same
 * two options the extension's Pack… dialog offers.
 */
export async function meshPackSeries(args: {
  path: string;
  outputPath: string;
  target?: "xdmf" | "pvd";
  provenance?: string;
}): Promise<object> {
  const mode = provenanceModeOf(args.provenance);
  const abs = path.resolve(args.path);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  if (!args.outputPath) throw new Error("outputPath is required.");
  const container = args.target ?? "xdmf";
  const out = path.resolve(args.outputPath);
  const outExt = path.extname(out).toLowerCase();
  // Not routed through writeModel: that is the mesh-writer path and its error
  // would name thirty single-mesh formats, none of which can hold a series.
  if (container === "xdmf" ? outExt !== ".xdmf" && outExt !== ".xmf" : outExt !== ".pvd") {
    throw new Error(
      `Cannot pack a series as "${outExt}" for target "${container}" — ` +
        (container === "xdmf"
          ? `supported: .xdmf, .xmf (a single file, so the mesh must be the same at every step).`
          : `supported: .pvd (an index plus one file per step, each with its own mesh).`)
    );
  }

  const isDir = fs.statSync(abs).isDirectory();
  const files = isDir ? await seriesFilesInDir(abs) : await discoverSeriesFiles(abs);
  if (files.length === 0) {
    // No filename series. A format carrying its own steps is already one file —
    // but a .pvd can still take it apart, one file per step, which is the whole
    // point for an adaptive run. XDMF has nothing to combine and stays refused.
    const found = await discoverSeriesSteps(abs);
    if (container === "xdmf" || found.source !== "inFile") {
      throw new Error(
        `No multi-step series at ${abs}. Packing combines a run's per-step files ` +
          `(<prefix>_<rank>_<step>.<ext>); a single file, or a format that already ` +
          `carries its own steps, has nothing to combine for an XDMF. ` +
          (container === "xdmf"
            ? `Pass target "pvd" to repack such a source as one file per step.`
            : ``)
      );
    }
    const result = await packPvdSeries(packStepsFromInFile(found.steps), {
      stem: meshStem(path.basename(out)),
      provenance: mode,
      kernelVersion: meshioPackageVersion(),
    });
    const written = writePvdOutput(out, result);
    invalidateCache(out);
    return {
      outputPath: out,
      target: container,
      companionDirectory: path.dirname(written[0]),
      files: written,
      steps: result.steps,
      times: found.steps.map((s, i) => (Number.isFinite(Number(s.label)) ? Number(s.label) : i)),
      sourceFiles: [abs],
      warnings: result.warnings,
      reports: result.reports,
      ...(result.sidecar ? { reportSidecar: result.sidecar.name } : {}),
    };
  }

  const outStem = meshStem(path.basename(out));
  if (container === "pvd") {
    const result = await packPvdSeries(
      packStepsFromFiles(files, { byteFormats: VTK_XML_EXTENSIONS }),
      { stem: outStem, provenance: mode, kernelVersion: meshioPackageVersion() }
    );
    const written = writePvdOutput(out, result);
    invalidateCache(out);
    return {
      outputPath: out,
      target: container,
      companionDirectory: path.dirname(written[0]),
      files: written,
      steps: result.steps,
      times: result.times,
      sourceFiles: files.map((f) => f.fsPath),
      warnings: result.warnings,
      reports: result.reports,
      ...(result.sidecar ? { reportSidecar: result.sidecar.name } : {}),
    };
  }

  const result = await packXdmfSeries(packStepsFromFiles(files), { stem: outStem, targetFile: path.basename(out), provenance: mode });

  const outDir = path.dirname(out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, result.data);
  // The `.h5` is not an extra: an `.xdmf` written without it is unreadable.
  const companions: string[] = [];
  for (const c of result.companions) {
    const to = path.join(outDir, c.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, c.data);
    companions.push(to);
  }
  invalidateCache(out);
  if (result.sidecar) fs.writeFileSync(path.join(outDir, result.sidecar.name), result.sidecar.text);

  return {
    outputPath: out,
    target: container,
    companions,
    steps: result.steps,
    times: files.map((f, i) => (Number.isFinite(Number(f.label)) ? Number(f.label) : i)),
    sourceFiles: files.map((f) => f.fsPath),
    warnings: result.warnings,
    reports: result.reports,
    ...(result.sidecar ? { reportSidecar: result.sidecar.name } : {}),
  };
}

/**
 * Writes a `.pvd` and its step files beside it. Pieces first, then the index:
 * an index naming files that are not there yet reads as an empty series, so a
 * failure part-way through leaves nothing published rather than a broken one.
 * The destination rule (refuse, never overwrite a directory this pack owns) is
 * `packPvd.ts`'s, so it cannot drift from what the extension's own Pack… does.
 */
function writePvdOutput(out: string, result: PackPvdResult): string[] {
  const pieceDir = pvdPieceDir(out);
  const clash = pvdOutputClash(
    out,
    fs.existsSync(out),
    fs.existsSync(pieceDir) && fs.readdirSync(pieceDir).length > 0
  );
  if (clash) throw new Error(clash);
  fs.mkdirSync(pieceDir, { recursive: true });
  const written: string[] = [];
  for (const piece of result.pieces) {
    const to = path.join(pieceDir, piece.name);
    fs.writeFileSync(to, piece.data);
    written.push(to);
  }
  try {
    fs.writeFileSync(out, result.data, { flag: "wx" });
  } catch (err) {
    // Nothing else had claimed that directory name (checked above), so taking
    // it back down leaves the destination exactly as it was found.
    fs.rmSync(pieceDir, { recursive: true, force: true });
    throw err;
  }
  written.unshift(out);
  if (result.sidecar) {
    const dest = path.join(path.dirname(out), result.sidecar.name);
    fs.writeFileSync(dest, result.sidecar.text);
    written.push(dest);
  }
  return written;
}

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

/**
 * Evaluates a selection predicate over a mesh file, returning the entity ids
 * per KIND (Elements/Conditions/Geometries each have their own id space) —
 * the headless half of the preview's selection sets, and the feed for
 * `mesh_transform`'s `assignProperty`/`createSubModelPartFromSelection`.
 * Read-only. The seed shape is selectionCore's `SelectionSeed`, validated
 * loosely here (the op layer refuses malformed records by name).
 */
export async function meshSelect(args: {
  path: string;
  seed: Record<string, unknown>;
  timeStep?: number;
  /** Per-kind id cap in the reply (default 10000; `total` beside each list). */
  limit?: number;
  /** Writes the ids as JSON (uncapped) instead of only returning them. */
  outputPath?: string;
}): Promise<object> {
  const src = await loadMesh(args.path, undefined, args.timeStep);
  const raw = args.seed as { kind?: unknown } | null;
  const kind = raw?.kind;
  if (typeof kind !== "string") throw new Error('seed.kind is required: "part" | "field" | "quality" | "property".');
  let seed: SelectionSeed;
  try {
    seed = JSON.parse(JSON.stringify(raw)) as SelectionSeed;
  } catch {
    throw new Error("seed is not valid JSON data.");
  }
  const report = kind === "quality" ? computeMeshQuality(src.model) : undefined;
  const r = resolveSeed(src.model, seed, report);
  if (r.reason) throw new Error(`Seed resolved to nothing: ${r.reason}`);
  const limit = args.limit ?? 10000;
  const slice = (set: Set<number>): { total: number; ids: number[] } => {
    const ids = Array.from(set).sort((a, b) => a - b);
    return { total: ids.length, ids: ids.length > limit ? ids.slice(0, limit) : ids };
  };
  const elements = slice(r.kinds.Elements);
  const conditions = slice(r.kinds.Conditions);
  const geometries = slice(r.kinds.Geometries);
  const result = {
    path: args.path,
    timeStep: args.timeStep,
    seed: seed,
    counts: {
      elements: elements.total,
      conditions: conditions.total,
      geometries: geometries.total,
      total: elements.total + conditions.total + geometries.total,
    },
    elementIds: elements.ids,
    conditionIds: conditions.ids,
    geometryIds: geometries.ids,
    truncated: [elements, conditions, geometries].some((s) => s.total > s.ids.length),
  };
  if (args.outputPath) {
    const abs = path.isAbsolute(args.outputPath)
      ? args.outputPath
      : path.join(path.dirname(path.resolve(args.path)), args.outputPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ ...result, elementIds: Array.from(r.kinds.Elements).sort((a, b) => a - b), conditionIds: Array.from(r.kinds.Conditions).sort((a, b) => a - b), geometryIds: Array.from(r.kinds.Geometries).sort((a, b) => a - b) }, null, 2));
    return { ...result, outputPath: abs };
  }
  return result;
}

/**
 * The meshio++ capability inventory: what the installed WASM build can read,
 * write, select and enumerate, and which of it this extension routes. Takes
 * no arguments — the answer is a property of the installed package, not of a
 * file. UI-exempt features have no entry here; every mesh tool's format
 * vocabulary does.
 */
export async function meshCapabilities(): Promise<object> {
  return { ...await getMeshCapabilities(), plotting: PLOT_CAPABILITIES };
}

/** General tables deliberately do not masquerade as meshes. JSON is bounded; CSV is not downsampled. */
export async function plotTableRead(args: { path: string; options?: ImportOptions; offset?: number; limit?: number }, execution: PlotExecution = {}): Promise<object> {
  const source = { id: "table", type: "table" as const, path: path.resolve(args.path), options: args.options };
  validatePlotRecipe(emptyPlotRecipe(source));
  const result = await runPlotWorker({ source }, execution) as PlotTable;
  const offset = Math.max(0, Math.floor(args.offset ?? 0)), limit = Math.min(10000, Math.max(1, Math.floor(args.limit ?? 100)));
  return { ...result, path: source.path, rowCount: result.rows.length, offset, rows: result.rows.slice(offset, offset + limit) };
}

export async function plotRuns(args:{paths:string[]},execution:PlotExecution={}):Promise<object> {
  return await runPlotWorker({runs:args.paths},execution);
}
export async function plotRunBind(args:{recordPath:string;path:string},execution:PlotExecution={}):Promise<PlotRunBinding> {
  return await runPlotWorker({bindRun:{recordPath:path.resolve(args.recordPath),path:path.resolve(args.path)}},execution) as PlotRunBinding;
}
export async function plotTimeCursor(args:PlotTimeCursorRequest,execution:PlotExecution={}):Promise<object> {
  validatePlotRecipe(emptyPlotRecipe({id:"cursor",type:"mesh",kind:"Nodes",path:args.path,run:args.run}));
  return await runPlotWorker({timeCursor:args},execution);
}
export async function plotRunTarget(args:PlotRunTargetRequest,execution:PlotExecution={}):Promise<PlotRunTarget> {
  return await runPlotWorker({runTarget:args},execution) as PlotRunTarget;
}

export async function plotDataset(args: { recipe: unknown; outputPath?: string; limit?: number }, execution: PlotExecution = {}): Promise<object> {
  const recipe = validatePlotRecipe(args.recipe);
  const result = await runPlotWorker({ recipe }, execution) as PlotDataset;
  if (args.outputPath) {
    const out = path.resolve(args.outputPath);
    if (path.extname(out).toLowerCase() !== ".csv") throw new Error("Plot numeric export requires a .csv path.");
    await writePlotCsv(out,result,execution.signal);
  }
  const limit = Math.min(10000, Math.max(1, Math.floor(args.limit ?? 100)));
  const inline = recipe.sources.some(s=>s.type==="inline");
  return { ...result, recipe:inline?undefined:result.recipe, ...(inline?{inlineDataInRequest:true,recipeMetadata:{...recipe,sources:recipe.sources.map(s=>s.type==="inline"?{id:s.id,type:s.type,columns:s.table.columns,rowCount:s.table.rows.length,revision:s.table.revision}:s)}}:{}), outputPath: args.outputPath, jsonLimit: limit, series: result.series.map(s => ({ ...s, totalPoints: s.points.length, points: s.points.slice(0, limit), original: s.original.slice(0, limit) })) };
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
      family: e.runtime?.decl.family,
      domains: e.runtime?.decl.domains?.map((d) => ({ id: d.id, label: d.label, mdpaSuffix: d.mdpaSuffix, materialsFileName: d.materialsFileName })),
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
  const casePath = args.casePath ?? caseFilePath(args.meshPath);
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
  for (const a of state.assignments) {
    if (!conditionIds.has(a.conditionId)) {
      issues.push(`Assignment condition "${a.conditionId}" is not declared by "${ptId}".`);
    }
    if (!knownPaths.has(a.smpPath)) {
      issues.push(`Assignment SubModelPart "${a.smpPath}" is not in the mesh.`);
    }
  }
  for (const m of state.materials) {
    const law = runtime.decl.materialLaws.find((l) => l.id === m.lawId);
    if (!law) {
      issues.push(`Material law "${m.lawId}" is not declared by "${ptId}".`);
    } else {
      // The same rulebook the generator refuses on, so preflight and Generate
      // cannot disagree about a case.
      for (const issue of validateMaterialAssignment(law, m.values, m.preset)) {
        issues.push(`Material "${m.smpPath}": ${issue.message}.`);
      }
    }
    if (!knownPaths.has(m.smpPath)) {
      issues.push(`Material SubModelPart "${m.smpPath}" is not in the mesh.`);
    }
  }
  // A coupled problemtype's missing parts / interfaces: the generator refuses these too.
  for (const message of domainProblems(runtime.decl, state.assignments)) issues.push(message);
  {
    const scratch: string[] = [];
    const ctx = buildGenContext(runtime, model, state, meshStem(args.meshPath), scratch);
    for (const message of await runtime.validate(ctx)) issues.push(message);
  }
  // Same rulebook the generator refuses on, so preflight and Generate cannot
  // disagree. Any state carrying the fluid time-stepping fields gets the
  // check, including Python ports (e.g. fluid_py).
  {
    const problem = (state.values as Record<string, Record<string, unknown> | undefined> | undefined)?.problem;
    if (problem && "timeStepMode" in problem) {
      for (const issue of validateFluidTimeStepping(problem as Record<string, unknown>)) {
        issues.push(`Time stepping: ${issue.message}`);
      }
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
  const casePath = caseFilePath(args.meshPath);
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
  const ext = meshExtname(args.meshPath);
  // .mdpa is the native format and lives outside SUPPORTED_MESH_EXTENSIONS
  // (the meshio++-plus-native-preview list), so it is accepted explicitly.
  if (ext !== ".mdpa" && !SUPPORTED_MESH_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported mesh format "${ext}". Supported: .mdpa, ${SUPPORTED_MESH_EXTENSIONS.join(", ")}`
    );
  }
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
  // meshStem, not basename+extname: the latter yields `case.post` for a
  // `case.post.msh` source and the next join would double the suffix.
  const stem = meshStem(args.meshPath);
  // Shared with PtController.generate: an .mdpa source is referenced directly
  // unless the mesh-name adaptation renames a block, while any other source
  // is always converted to a `<stem>_case.mdpa` case mesh.
  const plan = planCaseMesh(runtime, src.model, state, stem, ext === ".mdpa");
  const caseModel = plan.caseModel;
  const caseStem = plan.caseStem;
  const written: string[] = [];
  if (plan.shouldWriteMesh) {
    const adaptedPath = path.join(caseDir, `${caseStem}.mdpa`);
    fs.writeFileSync(
      adaptedPath,
      writeMdpa(caseModel, { sourceText: ext === ".mdpa" ? src.sourceText : undefined })
    );
    invalidateCache(adaptedPath);
    written.push(adaptedPath);
  }
  // A coupled problemtype writes one sliced mesh per physics domain instead.
  const domainPaths: string[] = [];
  for (const dm of plan.domainMeshes) {
    const domainPath = path.join(caseDir, `${dm.stem}.mdpa`);
    fs.writeFileSync(domainPath, writeMdpa(dm.model));
    invalidateCache(domainPath);
    written.push(domainPath);
    domainPaths.push(domainPath);
  }
  const out = await generateCase(runtime, caseModel, state, caseStem);
  const prepared = writePreparedCase({ directory: caseDir, sourcePath: args.meshPath,
    solverMeshPath: domainPaths[0] ?? path.join(caseDir, `${caseStem}.mdpa`), runtime, state, generated: out,
    warnings: [...warnings, ...plan.warnings], extraMeshPaths: domainPaths.slice(1) });
  written.push(...prepared.written);
  warnings.push(...plan.warnings, ...out.warnings);
  return {
    written,
    problemtype: runtime.decl.id,
    domainSize: plan.domainSize,
    renames: plan.renames,
    warnings,
    preparation: prepared.preparation,
  };
}

// --- material presets ---------------------------------------------------------

/**
 * The catalog: the shipped rows plus every workspace library file. Built-ins
 * first, so a user row that reuses a built-in id is the one the list reports
 * twice rather than silently shadowing it — `origin` and `file` say which is
 * which, and a case that copied a built-in keeps working either way.
 */
function loadMaterialLibrary(workspaceDirs?: string[]): MaterialLibrary {
  const user = discoverMaterialLibrary(workspaceDirs ?? [], DEFAULT_MATERIAL_LIBRARY_PATHS);
  return { presets: [...BUILTIN_PRESETS, ...user.presets], problems: user.problems };
}

const presetView = (p: MaterialPreset): Record<string, unknown> => ({
  id: p.id,
  name: p.name,
  origin: p.origin,
  laws: p.laws,
  values: p.values,
  ...(p.units ? { units: p.units } : {}),
  ...(p.reference ? { reference: p.reference } : {}),
  ...(p.version ? { version: p.version } : {}),
  source: p.source,
  ...(p.file ? { file: p.file } : {}),
});

export async function materialPresetList(args: {
  preset?: string;
  law?: string;
  workspaceDirs?: string[];
  outputPath?: string;
}): Promise<object> {
  const library = loadMaterialLibrary(args.workspaceDirs);
  const wanted = args.law === undefined
    ? library.presets
    : presetsForLaw(library.presets, args.law);
  const presets = args.preset === undefined
    ? wanted
    : wanted.filter((p) => p.id === args.preset || p.name === args.preset);
  if (args.preset !== undefined && presets.length === 0) {
    throw new Error(
      `No material preset "${args.preset}" in the library. ` +
        (args.law ? `None of them declares compatibility with law "${args.law}". ` : "") +
        `Call material_preset_list without arguments to see what there is.`
    );
  }
  if (args.outputPath !== undefined) {
    fs.writeFileSync(args.outputPath, serializePresetFile(presets));
  }
  return {
    count: presets.length,
    presets: presets.map(presetView),
    // A workspace file reusing a shipped id shows up twice here; applying it
    // takes the workspace file (see findPreset), and the two differ in `file`.
    ...(presets.length > 1
      ? { note: "More than one entry answers this id; a workspace file overrides the shipped row when applied." }
      : {}),
    problems: library.problems,
    ...(args.outputPath !== undefined ? { written: args.outputPath } : {}),
  };
}

export async function materialPresetImport(args: {
  path: string;
  workspaceDirs?: string[];
}): Promise<object> {
  const dirs = args.workspaceDirs ?? [];
  if (dirs.length === 0) {
    throw new Error(
      "`workspaceDirs` is required to import: presets are copied into the first listed folder's " +
        `${DEFAULT_MATERIAL_LIBRARY_PATHS[0]}/ so the sidebar picks them up. Read a file without ` +
        `installing it with material_preset_list(outputPath).`
    );
  }
  const imported = importPresetFile(args.path, dirs, DEFAULT_MATERIAL_LIBRARY_PATHS);
  const library = loadMaterialLibrary(dirs);
  return {
    written: imported.written,
    imported: imported.presets.map(presetView),
    warnings: imported.warnings,
    count: library.presets.length,
  };
}

/**
 * Fills one SubModelPart's material from a catalog row, or from explicit
 * values, and writes the case file. A preset is applied as a SNAPSHOT: the
 * resolved numbers and the row's provenance are copied into the case, so the
 * library can change afterwards without touching this case.
 */
export async function caseMaterialAssign(args: {
  meshPath: string;
  lawId: string;
  smpPath: string;
  preset?: string;
  values?: Record<string, number>;
  state?: unknown;
  casePath?: string;
  problemtype?: string;
  workspaceDirs?: string[];
}): Promise<object> {
  const read = readState(args);
  const problemtypeId = args.problemtype ?? read.state?.problemtypeId;
  if (!problemtypeId) {
    throw new Error(
      `No case state (${read.from}) and no \`problemtype\` given — a material needs the law it belongs to.`
    );
  }
  const runtime = await resolveRuntime(problemtypeId, args.workspaceDirs);
  const law = runtime.decl.materialLaws.find((l) => l.id === args.lawId);
  if (!law) {
    throw new Error(
      `Problemtype "${problemtypeId}" declares no material law "${args.lawId}". ` +
        `It has: ${runtime.decl.materialLaws.map((l) => l.id).join(", ") || "none"}.`
    );
  }
  const working: CaseState = read.state ?? defaultCaseState(runtime.decl);

  let values: Record<string, JsonValue> | undefined;
  let snapshot: MaterialPresetSnapshot | undefined;
  const conversions: { variable: string; from: string; to: string; factor: number }[] = [];
  const derived: { variable: string; formula: string; inputs: { id: string; value: number }[] }[] = [];
  let problems: string[] = [];

  if (args.preset !== undefined) {
    const library = loadMaterialLibrary(args.workspaceDirs);
    const preset = findPreset(library.presets, args.preset);
    if (!preset) {
      throw new Error(
        `No material preset "${args.preset}". Call material_preset_list to see the catalog.`
      );
    }
    // Applied on top of whatever the row already holds, so a kinematic-only
    // preset can use this material's density — and the row's own numbers are
    // preserved for every variable the preset says nothing about.
    const existing = working.materials.find((m) => m.smpPath === args.smpPath);
    const resolved = resolvePresetValues(law, preset, existing?.values ?? {});
    values = resolved.values;
    problems = resolved.problems;
    conversions.push(...resolved.conversions);
    derived.push(...resolved.derived);
    snapshot = snapshotOf(preset, resolved.values);
  } else if (args.values !== undefined) {
    values = { ...args.values };
  } else {
    throw new Error("Pass either `preset` (a catalog id) or `values` (explicit numbers).");
  }

  if (problems.length > 0) {
    throw new Error(`The preset does not fit this material:\n- ${problems.join("\n- ")}`);
  }
  const issues = validateMaterialAssignment(law, values ?? {}, snapshot);
  const fatal = issues.find((i) => i.severity === "error");
  if (fatal) throw new Error(`The material is not usable: ${fatal.message}.`);

  // One material per SubModelPart: Kratos assigns a property per part, so an
  // existing row for this part is replaced rather than duplicated.
  const material: MaterialAssignment = {
    smpPath: args.smpPath,
    lawId: law.id,
    values: values!,
    ...(snapshot ? { preset: snapshot } : {}),
  };
  const index = working.materials.findIndex((m) => m.smpPath === args.smpPath);
  if (index >= 0) working.materials.splice(index, 1, material);
  else working.materials.push(material);

  const casePath = caseFilePath(args.meshPath);
  fs.writeFileSync(casePath, serializeCase(working));
  return {
    casePath,
    source: read.from,
    law: { id: law.id, name: law.name },
    smpPath: args.smpPath,
    values: material.values,
    ...(snapshot ? { preset: snapshot } : {}),
    ...(conversions.length > 0 ? { conversions } : {}),
    ...(derived.length > 0 ? { derived } : {}),
    warnings: [...read.warnings, ...issues.map((i) => i.message)],
    state: working,
  };
}

// --- problem archives ---------------------------------------------------------

/** The default wait budget, in seconds — see caseRun. */
const RUN_WAIT_DEFAULT_S = 10;
const RUN_WAIT_MAX_S = 600;

interface OwnedRun {
  requestId: string;
  ownerId: string;
  runDirectory: string;
}

const isSafeIdentity = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

function writeExecution(receipt: ExecutionReceipt): void {
  const file = executionFilePath(receipt.runDirectory);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temp, file);
}

function readExecution(runDirectory: string): ExecutionReceipt | undefined {
  try { return parseExecutionReceipt(fs.readFileSync(executionFilePath(runDirectory), "utf8"), runDirectory); }
  catch { return undefined; }
}

function executionState(status: string | undefined): ExecutionState {
  if (status === "finished") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "running" || status === "detached") return "running";
  if (status === "starting") return "dispatching";
  return "uncertain";
}

function artifactRevision(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return `sha256:${hash.digest('hex')}`;
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function collectExecutionArtifacts(receipt: ExecutionReceipt, generated?: object, prior: ExecutionArtifact[] = []): Promise<ExecutionArtifact[]> {
  if (terminalExecution(receipt)) return receipt.artifacts;
  const out: ExecutionArtifact[] = [];
  const seen = new Set<string>();
  const add = (role: string, file: string): void => {
    const abs = path.resolve(file);
    const key = `${role}\0${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (!fs.statSync(abs).isFile()) return;
      const revision = artifactRevision(abs);
      out.push({ role, path: abs, ...(revision ? { revision } : { revisionUnavailable: "Could not read file." }) });
    } catch { /* A missing generated artifact is left out and reported by status consumers. */ }
  };
  for (const artifact of prior) add(artifact.role, artifact.path);
  add("mesh", receipt.meshPath);
  add("resources", path.join(path.dirname(receipt.meshPath), THREAD_RECEIPT));
  const generatedFiles = generated && typeof generated === "object" && "written" in generated && Array.isArray((generated as { written?: unknown }).written)
    ? (generated as { written: unknown[] }).written : [];
  for (const file of generatedFiles) if (typeof file === "string") add("input", file);
  const sidecar = readRun(receipt.meshPath).sidecar;

  add("convergence", path.join(path.dirname(receipt.meshPath), "kkss-convergence-v1.jsonl"));
  add("convergence", path.join(path.dirname(receipt.meshPath), "kkss-convergence-v2.jsonl"));
  add("preparation", path.join(path.dirname(receipt.meshPath), PREPARATION_FILE));
  const outputs = discoverOutputs(path.dirname(receipt.meshPath));
  for (const file of outputs.results) add("result", file);
  for (const file of outputs.companions) add("result-companion", file);
  if (sidecar?.logFile) add("log", sidecar.logFile);
  for (const result of out.filter(a => a.role === "result" && plotDirectorySource(a.path))) {
    try {
      for (const artifact of await freezeExecutionResult(result.path)) {
        const existing = out.find(a => a.role === artifact.role && a.path === artifact.path);
        if (existing) Object.assign(existing, artifact); else out.push(artifact);
      }
    } catch (error) {
      result.inventoryUnavailable = error instanceof Error ? error.message : String(error);
    }
  }
  return out;
}

function updateExecution(owned: OwnedRun, update: Partial<ExecutionReceipt>): ExecutionReceipt | undefined {
  const current = readExecution(owned.runDirectory);
  if (!current || current.requestId !== owned.requestId || current.ownerId !== owned.ownerId) return undefined;
  // Once the owning process observed completion, pin its artifact revisions.
  // Status polling must not relabel rewritten output bytes as the old run.
  if (terminalExecution(current)) return current;
  if (['succeeded', 'failed', 'cancelled'].includes(String(update.state))) {
    const outputs = discoverOutputs(path.dirname(current.meshPath));
    update = { ...update, outputFindings: outputs.findings };
  }
  let resources = current.resources;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(owned.runDirectory, THREAD_RECEIPT), "utf8"));
    if (resources && value.version === 1 && value.requestedThreads === resources.requestedThreads && value.effectiveThreads === resources.requestedThreads) resources = value;
  } catch { /* Unacknowledged thread application remains unknown. */ }
  const next = { ...current, ...update, ...(resources ? { resources } : {}), updatedAt: Date.now() };
  writeExecution(next);
  return next;
}

function validateOwnedArgs(args: { requestId?: string; ownerId?: string; runDirectory?: string }): OwnedRun | undefined {
  if (args.requestId === undefined && args.ownerId === undefined && args.runDirectory === undefined) return undefined;
  if (typeof args.requestId !== "string" || !isSafeIdentity(args.requestId) ||
      typeof args.ownerId !== "string" || !isSafeIdentity(args.ownerId) ||
      typeof args.runDirectory !== "string" || !args.runDirectory.trim()) {
    throw new Error("Queue-managed execution requires safe requestId and ownerId values and a runDirectory.");
  }
  return { requestId: args.requestId, ownerId: args.ownerId, runDirectory: path.resolve(args.runDirectory) };
}

function executionReceiptForRun(owned: OwnedRun | undefined, meshPath: string, status: string, runId?: string, artifacts: ExecutionArtifact[] = []): ExecutionReceipt | undefined {
  if (!owned) return undefined;
  const current = readExecution(owned.runDirectory);
  if (!current || current.requestId !== owned.requestId || current.ownerId !== owned.ownerId) return undefined;
  const next = { ...current, meshPath: path.resolve(meshPath), ...(runId ? { jobId: runId } : {}), state: executionState(status), artifacts, updatedAt: Date.now() };
  return updateExecution(owned, next);
}

/** Reads the sidecar and reconciles it, the same way case_status does. */
function readRun(meshPath: string): {
  path: string;
  sidecar?: ReturnType<typeof parseRunJson>["sidecar"];
  status?: string;
  alive?: boolean;
} {
  const p = runFilePath(meshPath);
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return { path: p };
  }
  const { sidecar } = parseRunJson(text);
  if (!sidecar) return { path: p };
  const alive = sidecar.pid !== undefined ? isPidAlive(sidecar.pid) : undefined;
  return { path: p, sidecar, status: reconcileStatus(sidecar, alive).status, ...(alive !== undefined ? { alive } : {}) };
}

function writeRun(meshPath: string, record: RunRecord, logFile?: string, owned?: OwnedRun): void {
  try {
    const base = sidecarFromRecord(record, "mcp", logFile);
    fs.writeFileSync(runFilePath(meshPath), serializeRun({
      ...base,
      ...(owned ? { requestId: owned.requestId, ownerId: owned.ownerId, runDirectory: owned.runDirectory } : {}),
    }));
  } catch {
    // A read-only folder must not break a run that already started.
  }
}

/**
 * Start a Kratos solve for a mesh.
 *
 * **The server never OWNS the run.** Its stdout is the JSON-RPC transport and
 * it exits with its stdio client, so the child is always spawned detached, with
 * both streams appended to `<stem>.kratosrun.log` and unref'd — it survives the
 * server by construction, and its output is never lost. Only the WAITING
 * varies, via `waitSeconds`.
 *
 * `waitSeconds` is one knob rather than a `wait` flag plus a timeout, because
 * two knobs for one dimension interact undefinably (what would
 * `wait:false, timeout:60` mean?). `0` returns immediately.
 *
 * The budget is small (10 s) on purpose. There is no server-side timeout
 * anywhere, so the only limit is the CLIENT's request timeout — a number this
 * process does not control and cannot observe. A budget tuned to the typical
 * 60 s default would still blow a client configured at 30 s, and would do it
 * while believing itself safe. Ten seconds separates "trivial case, already
 * finished" from "this is a real solve" and costs nothing, because expiry is
 * not a failure: it returns an ordinary `running` blob naming the pid and the
 * log, and the run continues. An agent that wants to block longer says so
 * explicitly and thereby owns its own client's timeout.
 */
export async function caseRun(args: {
  threads?: number;
  meshPath: string;
  python?: string;
  installPath?: string;
  extraEnv?: Record<string, string>;
  scriptName?: string;
  waitSeconds?: number;
  generate?: boolean;
  force?: boolean;
  problemtype?: string;
  casePath?: string;
  workspaceDirs?: string[];
  /** Stable identity for resumable queue dispatch. Requires ownerId + runDirectory. */
  requestId?: string;
  /** Caller identity required to inspect or cancel this queue-owned request. */
  ownerId?: string;
  /** Fresh per-run output directory; source mesh and case state are snapshotted into it. */
  runDirectory?: string;
}): Promise<object> {
  solverArgv(args.python ?? "python", args.scriptName ?? "MainKratos.py", args.threads);
  const owned = validateOwnedArgs(args);
  const sourceAbs = path.resolve(args.meshPath);
  let abs = sourceAbs;
  let casePath = args.casePath;
  const runExt = meshExtname(abs);
  if (runExt !== ".mdpa" && !SUPPORTED_MESH_EXTENSIONS.includes(runExt)) {
    throw new Error(
      `Unsupported mesh format "${runExt}". Supported: .mdpa, ${SUPPORTED_MESH_EXTENSIONS.join(", ")}`
    );
  }
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const warnings: string[] = [];

  if (owned) {
    const existingRequest = readExecution(owned.runDirectory);
    if (existingRequest) {
      if (existingRequest.requestId !== owned.requestId || existingRequest.ownerId !== owned.ownerId) {
        throw new Error("This run directory already belongs to a different request or owner.");
      }
      // Stable request IDs are idempotency keys. A retry observes the recorded
      // request and never launches a second solver, even after a lost reply.
      return caseStatus({ requestId: owned.requestId, ownerId: owned.ownerId, runDirectory: owned.runDirectory });
    }
    if (fs.existsSync(executionFilePath(owned.runDirectory))) {
      throw new Error("The existing execution receipt is unreadable; refusing to risk a duplicate solver launch.");
    }
    if (fs.existsSync(owned.runDirectory) && fs.readdirSync(owned.runDirectory).length > 0) {
      throw new Error("Queue-managed runDirectory must be fresh and empty.");
    }
    fs.mkdirSync(owned.runDirectory, { recursive: true });
    const snapshottedMesh = path.join(owned.runDirectory, path.basename(sourceAbs));
    const initial: ExecutionReceipt = {
      version: 1, requestId: owned.requestId, ownerId: owned.ownerId, state: "dispatching",
      runDirectory: owned.runDirectory, meshPath: snapshottedMesh,
      createdAt: Date.now(), updatedAt: Date.now(), artifacts: [],
      ...(args.threads !== undefined ? { resources: { requestedThreads: args.threads } } : {}),
    };
    // This atomic record is the dispatch intent. If the process dies after
    // this point, lookup reports uncertainty and callers must not resubmit.
    writeExecution(initial);
    try {
      fs.copyFileSync(sourceAbs, snapshottedMesh, fs.constants.COPYFILE_EXCL);
      const sourceCase = args.casePath ? path.resolve(args.casePath) : caseFilePath(sourceAbs);
      const snapshotCase = caseFilePath(snapshottedMesh);
      if (fs.existsSync(sourceCase)) {
        fs.copyFileSync(sourceCase, snapshotCase, fs.constants.COPYFILE_EXCL);
        casePath = snapshotCase;
      } else {
        casePath = undefined;
      }
      abs = snapshottedMesh;
      if (args.generate === false) {
        const sourceScript = path.join(path.dirname(sourceAbs), args.scriptName ?? "MainKratos.py");
        const snapshotScript = path.join(owned.runDirectory, args.scriptName ?? "MainKratos.py");
        if (fs.existsSync(sourceScript)) fs.copyFileSync(sourceScript, snapshotScript, fs.constants.COPYFILE_EXCL);
      }
      updateExecution(owned, { meshPath: abs, artifacts: await collectExecutionArtifacts(initial) });
    } catch (error) {
      updateExecution(owned, { state: "failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // BEFORE generating, not after: generating rewrites ProjectParameters.json
  // underneath whatever is already reading it.
  const existing = readRun(abs);
  if (existing.sidecar && existing.status === "detached") {
    const pid = existing.sidecar.pid;
    if (!args.force) {
      throw new Error(
        `A run for this mesh may still be active (pid ${pid ?? "?"}, started by ` +
          `${existing.sidecar.launchedBy}). Stop it with case_stop, or pass force:true to ` +
          `start another anyway — which replaces its status record.`
      );
    }
    warnings.push(
      `Started while a previous run (pid ${pid ?? "?"}, ${existing.sidecar.launchedBy}) may still ` +
        `be active; its status record has been replaced.`
    );
  }

  const caseDir = path.dirname(abs);
  const stem = meshStem(abs);

  // A DIFFERENT case in the same folder shares ProjectParameters.json and
  // vtk_output/ (output_path is hardcoded by design). A warning, not a refusal
  // — the same severity the extension chose for this case.
  try {
    for (const name of fs.readdirSync(caseDir)) {
      if (!name.endsWith(".kratosrun.json") || name === path.basename(runFilePath(abs))) continue;
      const { sidecar } = parseRunJson(fs.readFileSync(path.join(caseDir, name), "utf8"));
      if (!sidecar?.pid || !isPidAlive(sidecar.pid)) continue;
      warnings.push(
        `"${sidecar.stem}" may also be running in this folder (pid ${sidecar.pid}); both cases ` +
          `share ProjectParameters.json, MainKratos.py and vtk_output/.`
      );
    }
  } catch {
    /* unreadable dir — the spawn will report it */
  }

  // Generate first by default, exactly as the sidebar's Run does. Skipping it
  // is the more surprising default: a stale ProjectParameters.json solves the
  // WRONG problem silently, where a missing MainKratos.py at least fails loudly.
  let generated: object | undefined;
  if (args.generate !== false) {
    generated = await caseGenerate({
      meshPath: abs,
      ...(args.problemtype !== undefined ? { problemtype: args.problemtype } : {}),
      ...(casePath !== undefined ? { casePath } : {}),
      ...(args.workspaceDirs !== undefined ? { workspaceDirs: args.workspaceDirs } : {}),
    });
  }

  const outputs = discoverOutputs(caseDir);
  if (owned && outputs.unsafe.length) {
    updateExecution(owned, { state: "failed", message: outputs.findings.join(" ") });
    throw new Error('Output paths must stay inside the isolated run workspace.');
  }
  const script = args.scriptName ?? "MainKratos.py";
  if (!fs.existsSync(path.join(caseDir, script))) {
    throw new Error(
      `${script} is not in ${caseDir}. Run case_generate first, or pass generate:true (the default).`
    );
  }

  const python = args.python || defaultPythonPath(process.platform);
  let installPath = args.installPath ?? "";
  if (installPath) {
    const resolution = resolveKratosInstall(installPath, fs.existsSync, process.platform);
    if (resolution.root) installPath = resolution.root;
    else if (resolution.problem) warnings.push(resolution.problem);
  }
  const envDelta = computeKratosEnv({
    platform: process.platform,
    installPath,
    extraEnv: args.extraEnv ?? {},
    base: process.env as Record<string, string>,
  });

  const logFile = runLogPath(abs);
  const argv = solverArgv(python, script, args.threads);
  const record: RunRecord = {
    id: `mcp-${randomUUID()}`,
    caseKey: caseKeyFor(abs, process.platform),
    meshFsPath: abs,
    caseDir,
    stem,
    argv,
    launchMode: "output",
    startedAt: Date.now(),
    status: "starting",
  };

  // Persist the run identity before creating the child. A crash before spawn
  // acknowledgement is therefore observable as an unresolved request.
  writeRun(abs, record, logFile, owned);
  const handle = spawnRun({
    argv,
    cwd: caseDir,
    envDelta,
    detached: true,
    unref: true,
    logFile,
  });
  record.pid = handle.pid;
  record.status = "running";
  writeRun(abs, record, logFile, owned);
  if (owned) {
    const current = readExecution(owned.runDirectory);
    if (current) executionReceiptForRun(owned, abs, record.status, record.id, await collectExecutionArtifacts(current, generated));
  }

  // Kept alive on EVERY path, including waitSeconds:0. While this server lives
  // it is the only thing that can record how the run ended; once it exits,
  // nothing can, and case_status correctly reports `orphaned` instead of
  // inventing an exit code.
  const settled = handle.exited.then(async (exit) => {
    record.endedAt = Date.now();
    record.exitCode = exit.exitCode;
    record.signal = exit.signal;
    if (exit.reason === "spawn-error") {
      record.status = "failed";
      record.message = `Could not start ${argv[0]}: ${exit.message ?? "unknown error"}`;
    } else if (record.stopRequested || readRun(abs).sidecar?.stopRequested === true) {
      record.status = "cancelled";
      record.message =
        "Stopped. Results already written to vtk_output/ are kept; the final step may be incomplete.";
    } else if (exit.exitCode === 0) {
      record.status = "finished";
    } else {
      record.status = "failed";
      record.message = exit.signal
        ? `Ended on signal ${exit.signal}.`
        : `Exited with code ${exit.exitCode}.`;
    }
    writeRun(abs, record, logFile, owned);
    if (owned) {
      const receipt = readExecution(owned.runDirectory);
      if (receipt) executionReceiptForRun(owned, abs, record.status, record.id, await collectExecutionArtifacts(receipt, generated));
    }
    return exit;
  });

  let budget = args.waitSeconds ?? RUN_WAIT_DEFAULT_S;
  if (!Number.isFinite(budget) || budget < 0) budget = RUN_WAIT_DEFAULT_S;
  if (budget > RUN_WAIT_MAX_S) {
    warnings.push(`waitSeconds clamped from ${args.waitSeconds} to ${RUN_WAIT_MAX_S}.`);
    budget = RUN_WAIT_MAX_S;
  }

  if (budget > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budget * 1000);
    });
    const outcome = await Promise.race([settled, expired]);
    // Both branches must clear it, or the timer holds the loop open.
    if (timer) clearTimeout(timer);
    if (outcome !== "timeout") {
      return {
        ...runReply(abs, record, logFile, warnings, generated),
        exitCode: record.exitCode ?? null,
        ...(owned && readExecution(owned.runDirectory) ? { executionReceipt: executionReceiptForRun(owned, abs, record.status, record.id, await collectExecutionArtifacts(readExecution(owned.runDirectory)!, generated)) } : {}),
      };
    }
    warnings.push(
      `Still running after ${budget}s — this is not a failure. Poll case_status, or read ${logFile}.`
    );
  }

  // No exitCode on this path, deliberately: its ABSENCE is what tells an agent
  // the run has not ended.
  return {
    ...runReply(abs, record, logFile, warnings, generated),
    ...(owned && readExecution(owned.runDirectory) ? { executionReceipt: executionReceiptForRun(owned, abs, record.status, record.id, await collectExecutionArtifacts(readExecution(owned.runDirectory)!, generated)) } : {}),
  };
}

/** The shape both waiting paths return, overlapping case_status's key names. */
function runReply(
  meshPath: string,
  record: RunRecord,
  logFile: string,
  warnings: string[],
  generated?: object
): Record<string, unknown> {
  return {
    meshPath,
    status: record.status,
    ...(record.message ? { message: record.message } : {}),
    runId: record.id,
    launchedBy: "mcp",
    command: record.argv,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    logFile,
    sidecar: runFilePath(meshPath),
    ...(generated ? { generated } : {}),
    warnings,
  };
}

/**
 * Stop the latest run for a mesh.
 *
 * Signals a pid read off a FILE, which is the one thing in this server that can
 * affect a process it did not create. `isPidAlive` is a maybe, not a yes — pids
 * are reused — so the guards matter: a run with an `endedAt` is never signalled,
 * and the sidecar must still name the same `runId` it named a moment ago.
 *
 * The latch is written BEFORE the signal, and to disk, because the process that
 * owns the handle is the one that writes the terminal record and it is usually
 * not this one.
 */
export async function caseStop(args: { meshPath?: string; requestId?: string; ownerId?: string; runDirectory?: string }): Promise<object> {
  const owned = validateOwnedArgs(args);
  let request: ExecutionReceipt | undefined;
  let abs: string;
  if (owned) {
    request = readExecution(owned.runDirectory);
    if (!request) throw new Error("No durable request receipt exists for that requestId and ownerId.");
    if (request.requestId !== owned.requestId || request.ownerId !== owned.ownerId) throw new Error("Request ownership mismatch; cancellation was refused.");
    abs = request.meshPath;
    if (args.meshPath && path.resolve(args.meshPath) !== abs) throw new Error("meshPath does not belong to this request.");
  } else {
    if (!args.meshPath) throw new Error("meshPath or a complete requestId/ownerId/runDirectory identity is required.");
    abs = path.resolve(args.meshPath);
  }
  if (!fs.existsSync(abs)) {
    if (owned && request) return { stopped: false, status: request.state, message: "The request has no attached run process to cancel.", executionReceipt: request };
    throw new Error(`File not found: ${abs}`);
  }
  const warnings: string[] = [];
  const current = readRun(abs);
  if (!current.sidecar) {
    return { meshPath: abs, stopped: false, status: request?.state ?? "none", message: "No run process has been recorded for this request.", sidecar: current.path, ...(request ? { executionReceipt: request } : {}) };
  }
  const sidecar = current.sidecar;
  if (owned && (sidecar.requestId !== owned.requestId || sidecar.ownerId !== owned.ownerId)) {
    throw new Error("The recorded process does not belong to this request owner; cancellation was refused.");
  }
  if (sidecar.endedAt !== undefined || current.status !== "detached") {
    const receipt = owned ? executionReceiptForRun(owned, abs, current.status ?? sidecar.status, sidecar.runId, await collectExecutionArtifacts(request!, undefined, request!.artifacts)) : undefined;
    return {
      meshPath: abs,
      stopped: false,
      status: current.status,
      message: "That run has already ended; nothing was signalled.",
      runId: sidecar.runId,
      sidecar: current.path,
      ...(receipt ? { executionReceipt: receipt } : {}),
    };
  }
  if (sidecar.pid === undefined) {
    return { meshPath: abs, stopped: false, status: current.status, message: "No pid was recorded, so there is nothing to signal.", runId: sidecar.runId, sidecar: current.path };
  }
  if (sidecar.launchedBy === "extension") {
    warnings.push(
      "This run was started in the editor, which owns its process handle and writes the final " +
        "status. Stopping from here may still be recorded as failed — use the Stop button in the " +
        "Kratos Runs view for the correct label."
    );
  }
  if (process.platform === "win32") {
    warnings.push(
      "On Windows signals are not real, so this terminates immediately rather than stopping gracefully."
    );
  }

  // Latch first, on disk, so whoever writes the terminal record can tell a
  // deliberate stop from a crash.
  try {
    fs.writeFileSync(current.path, serializeRun({ ...sidecar, stopRequested: true }));
  } catch {
    warnings.push("Could not record the stop request; the run may be reported as failed rather than cancelled.");
  }

  const outcome = await stopPid(sidecar.pid);

  // Re-read: the run may have ended on its own while the ladder ran, in which
  // case the owner has already written a terminal record and a blind write here
  // would resurrect a stale `running`.
  const after = readRun(abs);
  const stillOurs = after.sidecar?.runId === sidecar.runId;
  if (stillOurs && after.sidecar?.endedAt === undefined) {
    try {
      fs.writeFileSync(
        current.path,
        serializeRun({
          ...after.sidecar!,
          status: "cancelled",
          endedAt: Date.now(),
          message:
            "Stopped. Results already written to vtk_output/ are kept; the final step may be incomplete.",
        })
      );
    } catch {
      warnings.push("Could not update the status record.");
    }
  }

  const receipt = owned ? executionReceiptForRun(owned, abs, after.status ?? (outcome === "alive" ? "detached" : "cancelled"), sidecar.runId, await collectExecutionArtifacts(request!, undefined, request!.artifacts)) : undefined;

  return {
    meshPath: abs,
    stopped: outcome !== "alive",
    outcome,
    status: outcome === "alive" ? after.status : "cancelled",
    runId: sidecar.runId,
    pid: sidecar.pid,
    sidecar: current.path,
    warnings,
    ...(receipt ? { executionReceipt: receipt } : {}),
  };
}

/**
 * The status of the latest Kratos run for a mesh.
 *
 * The MCP server cannot own a run — its stdout IS the JSON-RPC transport and it
 * dies with its stdio client — so the extension and this tool agree through the
 * `<stem>.kratosrun.json` sidecar instead, exactly as they already agree about
 * a case through `<stem>.kratoscase.json`.
 *
 * It reconciles rather than repeats: a record still marked running whose pid is
 * gone reports `orphaned`, and one whose pid is alive reports `detached`, never
 * `running` — pids are reused, so liveness is a maybe. Progress comes from
 * `vtk_output/` through the same `latestResultFile` the extension uses, so both
 * sides answer "how far along is it" identically.
 */
export async function caseStatus(args: { meshPath?: string; requestId?: string; ownerId?: string; runDirectory?: string }): Promise<object> {
  const owned = validateOwnedArgs(args);
  let request: ExecutionReceipt | undefined;
  let abs: string;
  if (owned) {
    request = readExecution(owned.runDirectory);
    if (!request) throw new Error("No durable request receipt exists for that requestId and ownerId.");
    if (request.requestId !== owned.requestId || request.ownerId !== owned.ownerId) throw new Error("Request ownership mismatch.");
    abs = request.meshPath;
    if (args.meshPath && path.resolve(args.meshPath) !== abs) throw new Error("meshPath does not belong to this request.");
  } else {
    if (!args.meshPath) throw new Error("meshPath or a complete requestId/ownerId/runDirectory identity is required.");
    abs = path.resolve(args.meshPath);
  }
  if (!fs.existsSync(abs)) {
    if (owned && request) return { status: request.state, requestId: owned.requestId, ownerId: owned.ownerId, executionReceipt: request };
    throw new Error(`File not found: ${abs}`);
  }
  const sidecarPath = runFilePath(abs);

  const discovered = discoverOutputs(path.dirname(abs));
  const latestFile = discovered.results[0];
  const latest = latestResultFile(discovered.results.map(file => path.basename(file)));
  const output = { directory: latestFile ? path.dirname(latestFile) : path.dirname(abs), fileCount: discovered.results.length,
    latestFile: latestFile ? path.basename(latestFile) : undefined, latestStep: latest?.step,
    steps: latest?.group.steps.length ?? discovered.results.length, ...discovered };

  let text: string;
  try {
    text = fs.readFileSync(sidecarPath, "utf8");
  } catch {
    const receipt = owned && request ? updateExecution(owned, { state: request.state === "dispatching" ? "uncertain" : request.state }) : undefined;
    return {
      meshPath: abs,
      status: "none",
      message: "No run has been recorded for this mesh.",
      sidecar: sidecarPath,
      output,
      ...(receipt ? { executionReceipt: receipt } : request ? { executionReceipt: request } : {}),
    };
  }
  const { sidecar, warnings } = parseRunJson(text);
  if (!sidecar) {
    const receipt = owned && request ? updateExecution(owned, { state: "uncertain", message: warnings.join(" ") }) : undefined;
    return { meshPath: abs, status: "unknown", warnings, sidecar: sidecarPath, output, ...(receipt ? { executionReceipt: receipt } : request ? { executionReceipt: request } : {}) };
  }
  if (owned && (sidecar.requestId !== owned.requestId || sidecar.ownerId !== owned.ownerId)) {
    throw new Error("The run sidecar does not match the requested owner identity.");
  }
  const alive = sidecar.pid !== undefined ? isPidAlive(sidecar.pid) : undefined;
  const { status, message } = reconcileStatus(sidecar, alive);
  const receipt = owned ? executionReceiptForRun(owned, abs, status, sidecar.runId, await collectExecutionArtifacts(request!, undefined, request!.artifacts)) : undefined;
  return {
    meshPath: abs,
    status,
    ...(message ? { message } : {}),
    runId: sidecar.runId,
    launchMode: sidecar.launchMode,
    launchedBy: sidecar.launchedBy,
    command: sidecar.argv,
    startedAt: sidecar.startedAt,
    ...(sidecar.endedAt !== undefined ? { endedAt: sidecar.endedAt } : {}),
    ...(sidecar.pid !== undefined ? { pid: sidecar.pid } : {}),
    ...(sidecar.exitCode !== undefined ? { exitCode: sidecar.exitCode } : {}),
    sidecar: sidecarPath,
    output,
    warnings,
    ...(receipt ? { executionReceipt: receipt } : {}),
  };
}

export async function problemPack(args: {
  meshPath: string;
  outputPath?: string;
  recipePath?: string;
  provenance?: string;
}): Promise<object> {
  const abs = path.resolve(args.meshPath);
  const dir = path.dirname(abs);
  const stem = meshStem(abs);
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
    collected = await collectProblemFiles(abs, opsJson, provenanceModeOf(args.provenance));
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

export async function meshPeriodic(args: PeriodicOptions & { path: string; outputPath?: string }): Promise<object> {
  const { model } = await loadMesh(args.path);
  const report = await periodicNodes(model, args);
  if (args.outputPath) fs.writeFileSync(args.outputPath, 'slave,master\n' + report.pairs.map(p => `${p.slave},${p.master}`).join('\n') + '\n');
  return report;
}

export async function meshResample(args: ResampleOptions & ResampleSourceOptions & { path: string; outputPath: string; provenance?: string }): Promise<object> {
  return exportResampled(await sequenceSource(args.path,args),args,args.outputPath,undefined,provenanceModeOf(args.provenance));
}

/**
 * Read-only convective time-step estimate and output budget for a mesh.
 * Guidance only: explicit arguments win, then the saved case's "problem"
 * section (refVelocity/courantTarget/endTime), and nothing is written — apply
 * a chosen step through case_write_state.
 */
export async function caseEstimateTimestep(args: {
  meshPath: string;
  refVelocity?: number;
  courant?: number;
  safety?: number;
  endTime?: number;
  outputInterval?: number;
}): Promise<object> {
  const { model } = await loadMesh(args.meshPath);
  let saved: Record<string, unknown> = {};
  try {
    const { state } = readState({ meshPath: args.meshPath });
    const problem = state?.values?.problem;
    if (problem && typeof problem === "object") saved = problem as Record<string, unknown>;
  } catch {
    /* no saved case: explicit arguments only */
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = {
    refVelocity: args.refVelocity ?? num(saved.refVelocity) ?? 0,
    courant: args.courant ?? num(saved.courantTarget),
    safety: args.safety,
    endTime: args.endTime ?? num(saved.endTime),
    outputInterval: args.outputInterval,
  };
  return { input, estimate: estimateTimeStep(model, input) };
}
