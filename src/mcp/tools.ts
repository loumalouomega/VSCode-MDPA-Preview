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
import { deriveMesh, DeriveSpec, DERIVE_KINDS, DERIVE_STANDALONE_KINDS } from "../parser/deriveMesh";
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
  discoverSeriesSteps,
  seriesFilesInDir,
} from "../parser/fieldSeriesScan";
import { buildMembershipIndex } from "../parser/smpMembership";
import { getMeshCapabilities } from "../parser/meshCapabilities";
import { writeXlsx } from "../parser/writers/xlsxWriter";
import { computeMeshQuality } from "../parser/meshQuality";
import { SelectionSeed, resolveSeed } from "../parser/selectionCore";
import { computeGlobal, GLOBAL_REDUCTIONS, reduceValues, type GlobalReduction } from "../parser/globalReduce";
import { computeMeshSize } from "../parser/meshSize";
import { watertightReport } from "../parser/watertight";
import { integrateFields } from "../parser/fieldIntegrate";
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
import { CaseState, ProblemtypeRuntime, ProblemtypeSource } from "../problemtype/types";
import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { generateCase, subModelPartPaths } from "../problemtype/generate";
import { PREPARATION_FILE, writePreparedCase } from "../problemtype/preparation";
import { defaultCaseState } from "../problemtype/api";
import { planCaseMesh } from "../problemtype/caseMesh";
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
  } else if (SUPPORTED_MESH_EXTENSIONS.includes(ext)) {
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
  badIdLimit?: number;
  defectLimit?: number;
}): Promise<object> {
  const { model } = await loadMesh(args.path);
  const limit = args.badIdLimit ?? 20;
  const defectLimit = args.defectLimit ?? 50;
  const defects = surfaceDefects(model);
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
  atol?: number;
  rtol?: number;
  variable?: string;
  kind?: "Nodal" | "Elemental" | "Conditional";
  sourceVariable?: string;
  correspondence?: "id" | "spatial";
  output?: string;
  outputPath?: string;
}): Promise<object> {
  const a = await loadMesh(args.pathA);
  const b = await loadMesh(args.pathB);
  const comparison = compareMeshes(a.model, b.model, { atol: args.atol, rtol: args.rtol });
  const out: Record<string, unknown> = { pathA: args.pathA, pathB: args.pathB, comparison };
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
      out.outputPath = await writeModel(r.model, args.outputPath, a.sourceText, undefined, warnings);
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

async function writeModel(
  model: MdpaModel,
  outPath: string,
  sourceText: string | undefined,
  format?: string,
  /**
   * Collects the writer's advisory messages (today: verbatim `.mdpa`
   * Constraints copied onto renumbered nodes) so the tool can report them
   * instead of writing a quietly-degraded file and saying nothing.
   */
  warnings?: string[]
): Promise<string> {
  const abs = path.resolve(outPath);
  const ext = meshExtname(abs);
  if (!isExportableExtension(ext)) {
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
  const { data, companions } = await writeMeshFileAsync(model, ext, {
    sourceText: ext === ".mdpa" ? sourceText : undefined,
    name: path.basename(abs, ext),
    format,
    onWarning: (m) => warnings?.push(m),
  });
  // Uint8Array (the binary meshio++ formats) is written raw; a string as utf8.
  fs.writeFileSync(abs, data);
  // XDMF references its companion .h5 by name — the main file is useless alone;
  // an OpenFOAM `.foam` marker is 0 bytes and its companions ARE the mesh. Both
  // give a companion a relative path, whose folders may not exist yet.
  for (const c of companions) {
    const dest = path.join(path.dirname(abs), c.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, c.data);
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
  let model = src.model;
  const outcomes: object[] = [];
  for (let i = 0; i < raw.length; i++) {
    // Built one at a time, against the ROLLING model rather than the mesh as
    // originally opened — this is what lets remesh's `expr` mode see a field
    // an EARLIER step in this same sequence just computed (e.g. sdfDistance's
    // own "d"), the "define a variable, then use it" chaining story. See
    // opRecordFromMessage's own doc comment.
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
          applyOpAsync(model, rec, { onProgress: (m) => progressSink?.(m) })
        )
      : await applyOpAsync(model, rec);
    outcomes.push({ op: rec.op, label: OP_LABELS[rec.op], noop: out.noop === true, message: out.message });
    model = out.model;
  }
  const written = await writeModel(
    model,
    args.outputPath ?? args.path,
    src.sourceText,
    undefined,
    warnings
  );
  return {
    outputPath: written,
    outcomes,
    warnings,
    diagnostics: diagnosticsBlock(model),
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
  /** Selects a step of a multi-step input file (Exodus, MED, GiD postprocess, CGNS/Tecplot, XDMF, OpenFOAM time directories). */
  timeStep?: number;
  /** Selects one piece of a .pvtu/.pvtp input instead of merging every piece (0-based). */
  piece?: number;
  /** Drop ghost/duplicate cells at partition seams (.pvtu/.pvtp; defaults to true for them). */
  dropGhosts?: boolean;
  /** Selects one region of a multi-region OpenFOAM input case (.foam) instead of merging every region. */
  region?: string;
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
  const written = await writeModel(
    src.model,
    args.outputPath,
    src.sourceText,
    args.outputFormat,
    warnings
  );
  return {
    outputPath: written,
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
  const written = await writeModel(extracted, args.outputPath, undefined, undefined, warnings);
  return {
    outputPath: written,
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
}): Promise<object> {
  const src = await loadMesh(args.path);
  const { model: skin, faces } = extractSkinModel(src.model);
  if (faces === 0) {
    throw new Error("No boundary faces found — the mesh has no volume or surface cells to skin.");
  }
  const warnings: string[] = [];
  const written = await writeModel(skin, args.outputPath, undefined, undefined, warnings);
  return {
    outputPath: written,
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
  kind: "slice" | "isosurface" | "threshold" | "decimate" | "grid" | "voxelize" | "sdfVolume";
  outputPath: string;
  outputFormat?: string;
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
  const src = args.path ? await loadMesh(args.path) : { model: parseMdpa("") };
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
  } else {
    throw new Error(`kind must be one of ${DERIVE_KINDS.join(", ")}.`);
  }
  const derived = await deriveMesh(src.model, spec);
  const warnings: string[] = [];
  let written: string;
  if (meshExtname(path.resolve(args.outputPath)) === ".vti") {
    // The one container our unstructured writers cannot produce: a dense lattice, written straight from meshio++'s own mesh.
    if (!derived.raw || !derived.denseLattice) {
      throw new Error(".vti holds a dense regular lattice: use kind \"grid\", an sdfVolume with structure \"voxel\", or a voxelize with fill \"all\" — any partial lattice must be written as .vtu or another cell format.");
    }
    const abs = path.resolve(args.outputPath);
    const raw = await writeRawMeshioBytes(derived.raw, ".vti", "vti", { stem: path.basename(abs, ".vti") });
    fs.writeFileSync(abs, raw.data);
    for (const c of raw.companions) {
      const dest = path.join(path.dirname(abs), c.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, c.data);
    }
    invalidateCache(abs);
    written = abs;
  } else {
    // No sourceText: the result is new geometry or a restriction, so the input's
    // verbatim Properties/Table blocks do not apply.
    written = await writeModel(derived.model, args.outputPath, undefined, args.outputFormat, warnings);
  }
  return {
    outputPath: written,
    kind: args.kind,
    summary: derived.summary,
    nodeCount: derived.model.nodeCount,
    blocks: derived.model.blocks.map(blockSummary),
    fields: derived.model.fields.map((f) => ({ kind: f.kind, variable: f.variable, components: f.components, count: f.ids.length })),
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
  const write = async (m: MdpaModel, key: string): Promise<string> => {
    const out = path.join(dir, `${stem}_${key}${ext}`);
    await writeModel(m, out, undefined, args.outputFormat, warnings);
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
    const manifest = partitionManifest(abs, r, files.map((f) => path.basename(f)));
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

export async function meshPackSeries(args: {
  path: string;
  outputPath: string;
}): Promise<object> {
  const abs = path.resolve(args.path);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  if (!args.outputPath) throw new Error("outputPath is required.");
  const out = path.resolve(args.outputPath);
  const outExt = path.extname(out).toLowerCase();
  // Not routed through writeModel: that is the mesh-writer path and its error
  // would name thirty single-mesh formats, none of which can hold a series.
  if (outExt !== ".xdmf" && outExt !== ".xmf") {
    throw new Error(
      `Cannot pack a series as "${outExt}" — supported: .xdmf, .xmf ` +
        `(the only format that carries a mesh time series).`
    );
  }

  const isDir = fs.statSync(abs).isDirectory();
  const files = isDir ? await seriesFilesInDir(abs) : await discoverSeriesFiles(abs);
  if (files.length === 0) {
    throw new Error(
      `No multi-step series at ${abs}. Packing combines a run's per-step files ` +
        `(<prefix>_<rank>_<step>.<ext>); a single file, or a format that already ` +
        `carries its own steps, has nothing to combine.`
    );
  }

  const result = await packXdmfSeries(
    packStepsFromFiles(files),
    { stem: meshStem(path.basename(out)) }
  );

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

  return {
    outputPath: out,
    companions,
    steps: result.steps,
    times: files.map((f, i) => (Number.isFinite(Number(f.label)) ? Number(f.label) : i)),
    sourceFiles: files.map((f) => f.fsPath),
    warnings: result.warnings,
  };
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
  return getMeshCapabilities();
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
  const out = await generateCase(runtime, caseModel, state, caseStem);
  const prepared = writePreparedCase({ directory: caseDir, sourcePath: args.meshPath,
    solverMeshPath: path.join(caseDir, `${caseStem}.mdpa`), runtime, state, generated: out,
    warnings: [...warnings, ...plan.warnings] });
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

// --- problem archives ---------------------------------------------------------

/** The default wait budget, in seconds — see caseRun. */
const RUN_WAIT_DEFAULT_S = 10;
const RUN_WAIT_MAX_S = 600;

type ExecutionState = "dispatching" | "running" | "uncertain" | "succeeded" | "failed" | "cancelled";
interface ExecutionArtifact {
  role: string;
  path: string;
  revision?: string;
  revisionUnavailable?: string;
}
interface ExecutionReceipt {
  version: 1;
  requestId: string;
  ownerId: string;
  jobId?: string;
  state: ExecutionState;
  runDirectory: string;
  meshPath: string;
  createdAt: number;
  updatedAt: number;
  artifacts: ExecutionArtifact[];
  message?: string;
}
interface OwnedRun {
  requestId: string;
  ownerId: string;
  runDirectory: string;
}

const EXECUTION_FILE = ".kkss-execution.json";
const isSafeIdentity = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

function executionFilePath(runDirectory: string): string {
  return path.join(path.resolve(runDirectory), EXECUTION_FILE);
}

function writeExecution(receipt: ExecutionReceipt): void {
  const file = executionFilePath(receipt.runDirectory);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temp, file);
}

function readExecution(runDirectory: string): ExecutionReceipt | undefined {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(executionFilePath(runDirectory), "utf8")); }
  catch { return undefined; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<ExecutionReceipt>;
  if (value.version !== 1 || typeof value.requestId !== "string" || typeof value.ownerId !== "string" ||
      typeof value.runDirectory !== "string" || typeof value.meshPath !== "string" ||
      !["dispatching", "running", "uncertain", "succeeded", "failed", "cancelled"].includes(String(value.state))) return undefined;
  const currentDirectory = path.resolve(runDirectory), recordedDirectory = path.resolve(value.runDirectory);
  const relocate = (file: string): string => {
    const absolute = path.resolve(file), relative = path.relative(recordedDirectory, absolute);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.resolve(currentDirectory, relative) : absolute;
  };
  return {
    ...(value as ExecutionReceipt),
    // Portable project folders may move. Rebase only paths owned by the
    // recorded run directory; externally referenced files remain explicit.
    runDirectory: currentDirectory,
    meshPath: relocate(value.meshPath),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter((artifact): artifact is ExecutionArtifact =>
      !!artifact && typeof artifact.role === "string" && typeof artifact.path === "string").map(artifact => ({ ...artifact, path: relocate(artifact.path) })) : [],
  };
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
  try { return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`; }
  catch { return undefined; }
}

function collectExecutionArtifacts(receipt: ExecutionReceipt, generated?: object, prior: ExecutionArtifact[] = []): ExecutionArtifact[] {
  const out: ExecutionArtifact[] = [];
  const seen = new Set<string>();
  const add = (role: string, file: string): void => {
    const abs = path.resolve(file);
    const key = `${role}\0${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (!fs.statSync(abs).isFile()) return;
      const size = fs.statSync(abs).size;
      const revision = size <= 25_000_000 ? artifactRevision(abs) : undefined;
      out.push({ role, path: abs, ...(revision ? { revision } : { revisionUnavailable: size > 25_000_000 ? "File exceeds 25 MB revision limit." : "Could not read file." }) });
    } catch { /* A missing generated artifact is left out and reported by status consumers. */ }
  };
  for (const artifact of prior) add(artifact.role, artifact.path);
  add("mesh", receipt.meshPath);
  const generatedFiles = generated && typeof generated === "object" && "written" in generated && Array.isArray((generated as { written?: unknown }).written)
    ? (generated as { written: unknown[] }).written : [];
  for (const file of generatedFiles) if (typeof file === "string") add("input", file);
  const sidecar = readRun(receipt.meshPath).sidecar;
  const outputDir = path.join(path.dirname(receipt.meshPath), "vtk_output");
  add("convergence", path.join(path.dirname(receipt.meshPath), "kkss-convergence-v1.jsonl"));
  add("convergence", path.join(path.dirname(receipt.meshPath), "kkss-convergence-v2.jsonl"));
  add("preparation", path.join(path.dirname(receipt.meshPath), PREPARATION_FILE));
  try {
    const latest = latestResultFile(fs.readdirSync(outputDir));
    if (latest) add("result", path.join(outputDir, latest.fileName));
  } catch { /* No result yet. */ }
  if (sidecar?.logFile) add("log", sidecar.logFile);
  return out;
}

function updateExecution(owned: OwnedRun, update: Partial<ExecutionReceipt>): ExecutionReceipt | undefined {
  const current = readExecution(owned.runDirectory);
  if (!current || current.requestId !== owned.requestId || current.ownerId !== owned.ownerId) return undefined;
  const next = { ...current, ...update, updatedAt: Date.now() };
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
  writeExecution(next);
  return next;
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
      updateExecution(owned, { meshPath: abs, artifacts: collectExecutionArtifacts(initial) });
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
  const argv = [python, script];
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
    if (current) executionReceiptForRun(owned, abs, record.status, record.id, collectExecutionArtifacts(current, generated));
  }

  // Kept alive on EVERY path, including waitSeconds:0. While this server lives
  // it is the only thing that can record how the run ended; once it exits,
  // nothing can, and case_status correctly reports `orphaned` instead of
  // inventing an exit code.
  const settled = handle.exited.then((exit) => {
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
      if (receipt) executionReceiptForRun(owned, abs, record.status, record.id, collectExecutionArtifacts(receipt, generated));
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
        ...(owned && readExecution(owned.runDirectory) ? { executionReceipt: executionReceiptForRun(owned, abs, record.status, record.id, collectExecutionArtifacts(readExecution(owned.runDirectory)!, generated)) } : {}),
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
    ...(owned && readExecution(owned.runDirectory) ? { executionReceipt: executionReceiptForRun(owned, abs, record.status, record.id, collectExecutionArtifacts(readExecution(owned.runDirectory)!, generated)) } : {}),
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
    const receipt = owned ? executionReceiptForRun(owned, abs, current.status ?? sidecar.status, sidecar.runId, collectExecutionArtifacts(request!, undefined, request!.artifacts)) : undefined;
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

  const receipt = owned ? executionReceiptForRun(owned, abs, after.status ?? (outcome === "alive" ? "detached" : "cancelled"), sidecar.runId, collectExecutionArtifacts(request!, undefined, request!.artifacts)) : undefined;

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

  const outDir = path.join(path.dirname(abs), "vtk_output");
  let names: string[] = [];
  try {
    names = fs.readdirSync(outDir);
  } catch {
    /* not run yet, or no output */
  }
  const latest = latestResultFile(names);
  const output = {
    directory: outDir,
    fileCount: names.length,
    latestStep: latest?.step,
    latestFile: latest?.fileName,
    steps: latest?.group.steps.length ?? 0,
  };

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
  const receipt = owned ? executionReceiptForRun(owned, abs, status, sidecar.runId, collectExecutionArtifacts(request!, undefined, request!.artifacts)) : undefined;
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
