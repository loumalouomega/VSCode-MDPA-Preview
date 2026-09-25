/**
 * The pure operation-history core: a serializable operation record, a dispatcher
 * that applies one op to a model, a replay that folds a whole op list from a base
 * model, and JSON recipe (de)serialization.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. Every
 * op maps to one of the pure model→model transforms; because those are
 * deterministic and parameterless-or-recorded-param, an op list is a fully
 * replayable recipe. Used by the host-side OperationHistory manager (src/opHistory.ts).
 */

import { MdpaDiagnostic, MdpaModel, FieldBlockKind, EntityKind } from "./types";
import { meshExtname, meshStem } from "./meshFormats";
import { OpName, OP_LABELS } from "./opLabels";
import { linearToQuadratic } from "./linearToQuadratic";
import { removeOrphanNodes } from "./removeOrphanNodes";
import { mergeNodes } from "./mergeNodes";
import { scaleCoords, translateCoords, rotateCoords, Axis } from "./transformCoords";
import { extractSubModelPart } from "./subModelPartExtract";
import { skinDistanceSurface } from "./extractSkin";
import { deleteSubModelPart } from "./deleteSubModelPart";
import {
  remeshModel,
  levelsetModel,
  RemeshParams,
  LevelsetParams,
  RemeshResult,
  MmgProgress,
  FrozenSelector,
  LocalSizeOverride,
} from "./remesh";
import { renameSubModelPart } from "./renameSubModelPart";
import {
  addSubModelPartEntities,
  createSubModelPart,
  mergeSubModelParts,
  moveSubModelPart,
  removeSubModelPartEntities,
  SmpEntityKind,
  SMP_ENTITY_KINDS,
} from "./subModelPartTree";
import { writeMeshSizeFields, MeshSizeTarget } from "./meshSize";
import { setElementRadius, RadiusMode } from "./setElementRadius";
import { assignProperty, cloneProperty, createProperty, deleteProperty, setProperty } from "./propertyOps";
import { SelectionSeed, ENTITY_KINDS, entityUniverses, resolveSeed } from "./selectionCore";
import { PropertyValue } from "./propertiesParser";
import { deleteEntities } from "./selectCells";
import { smoothModel, SmoothMethod, SmoothParams } from "./smoothMesh";
import { reorderModel, ReorderMethod, REORDER_METHODS } from "./reorderMesh";
import { partitionModel, PartitionMethod, PARTITION_VARIABLE } from "./partitionMesh";
import { linearize } from "./linearize";
import { refineModel } from "./refineMesh";
import { RefineSelector, REFINE_COMPARES, RefineCompare } from "./refineSelect";
import { simplexifyModel } from "./simplexify";
import { cropModel, CropParams } from "./cropMesh";
import {
  fieldCalcModel,
  averageField,
  FieldCalcParams,
  AverageFieldParams,
  AverageDirection,
  CellBlockKind,
  scopeVariables as fieldScopeVariables,
} from "./fieldCalc";
import {
  renameFieldModel,
  dropFieldsModel,
  keepFieldsModel,
  conditionFieldModel,
  isValidFieldName,
  CONDITION_MODES,
  CONDITION_SCOPES,
  NAN_POLICIES,
  RenameFieldParams,
  FieldSelectParams,
  ConditionFieldParams,
} from "./fieldManage";
import { repairSurfaceModel, RepairSurfaceParams } from "./repairSurface";
import { curvatureModel, gaussBonnetResidual, CurvatureParams, CURVATURE_DUAL_AREAS, CurvatureDualArea } from "./curvature";
import { shrinkwrapModel, sobolevDeformModel, describeInverted, ShrinkwrapParams, SobolevParams } from "./deform";
import { compareFieldModel, CompareFieldParams, CORRESPONDENCES, Correspondence } from "./meshCompare";
import { markComponentsModel, MarkComponentsParams } from "./splitComponents";
import {
  surfaceRemeshModel,
  volumeMeshModel,
  optimizeVolumeModel,
  SurfaceRemeshParams,
  VolumeMeshParams,
  OptimizeVolumeParams,
  SURFACE_REMESH_METRICS,
} from "./meshing";
import { mergeManyModels, MergeMeshParams, MergeSource } from "./mergeMesh";
import { renumberModel, RenumberParams, RENUMBER_TARGETS, RenumberTarget } from "./renumberMesh";
import {
  gradientFieldModel,
  GradientParams,
  GRADIENT_METHODS,
  GRADIENT_OPERATORS,
  GradientMethod,
  GradientOperator,
} from "./gradientField";
import { HessianParams, hessianFieldModel } from "./hessianField";
import { SdfParams, SDF_SIGNS, SdfSign, sdfFieldModel } from "./sdfField";
import { remapFieldsOntoRemesh } from "./remeshFields";
import {
  TransferFieldParams,
  TRANSFER_CONFLICTS,
  TransferOnConflict,
  transferFieldModel,
} from "./transferField";
import {
  ErrorEstimateParams,
  ErrorMarking,
  ERROR_MARKINGS,
  estimateErrorModel,
} from "./errorEstimate";
import { parseMeshFile } from "./meshFileParser";
import { parseMdpa } from "./mdpaParser";
import {
  validateSizeExpr,
  validateSizeExprLenient,
  remeshSizeExprVars,
  SIZE_EXPR_VARIABLES,
  REMESH_DISTANCE_VAR,
} from "./sizeExpr";
import {
  GLOBAL_REDUCTIONS,
  GlobalReduction,
  GlobalSpec,
  computeGlobal,
  globalValueCount,
  defaultGlobalName,
} from "./globalReduce";
import * as fs from "node:fs";
import * as path from "node:path";
import { trackEngine } from "../engineActivity";

/**
 * mergeMesh's `path` is picked from the same "Mesh files" dialog as File ▸
 * Open (`.mdpa` listed first — see `pickMergeMeshFile` in meshExport.ts), but
 * `parseMeshFile` (meshFileParser.ts) is deliberately the dispatcher for the
 * *other* formats only — `.mdpa` is text, parsed by `parseMdpa` everywhere
 * else in the extension (loadMesh in mcp/tools.ts, both editor providers).
 * Without this, merging a `.mdpa` file — the single most likely pick for a
 * Kratos user — would throw "Unsupported mesh file extension \".mdpa\"".
 */
async function parseMergeSource(fsPath: string): Promise<MdpaModel> {
  if (meshExtname(fsPath) === ".mdpa") {
    return parseMdpa(fs.readFileSync(fsPath, "utf8"));
  }
  return parseMeshFile(fsPath);
}

/**
 * A merged-in file's stem names the SubModelPart wrapping its geometry, so the
 * merge module itself never has to know about the filesystem. mdpa part names
 * are whitespace-delimited tokens, so whitespace collapses to `_`.
 */
function smpNameFromPath(fsPath: string): string {
  const stem = meshStem(fsPath).trim().replace(/\s+/g, "_");
  return stem.length > 0 ? stem : "MergedMesh";
}

/** Entities of one kind across every block (the outcome messages' counts). */
function countOfKind(model: MdpaModel, kind: EntityKind): number {
  let n = 0;
  for (const b of model.blocks) if (b.kind === kind) n += b.count;
  return n;
}

/**
 * The entity id lists a `createSubModelPartFromSelection` record brings: the
 * explicit per-kind arrays (the webview posts these), or — spelt as a `seed` —
 * the seed resolved AGAINST the model at apply time (the headless/recipe
 * spelling, also what makes the op chainable inside one mesh_transform array).
 */
function resolveSelectionIds(
  model: MdpaModel,
  rec: Extract<OpRecord, { op: "createSubModelPartFromSelection" }>
): { kinds: Record<EntityKind, number[]>; reason?: string } {
  if (rec.seed) {
    const r = resolveSeed(model, rec.seed);
    if (r.reason) return { kinds: { Elements: [], Conditions: [], Geometries: [] }, reason: r.reason };
    return {
      kinds: {
        Elements: r.kinds.Elements.size ? Array.from(r.kinds.Elements).sort((a, b) => a - b) : [],
        Conditions: r.kinds.Conditions.size ? Array.from(r.kinds.Conditions).sort((a, b) => a - b) : [],
        Geometries: r.kinds.Geometries.size ? Array.from(r.kinds.Geometries).sort((a, b) => a - b) : [],
      },
    };
  }
  const clean = (xs?: number[]) => (Array.isArray(xs) ? xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b) : []);
  const kinds: Record<EntityKind, number[]> = { Elements: clean(rec.elements), Conditions: clean(rec.conditions), Geometries: clean(rec.geometries) };
  // A pick may name an entity that no longer exists (stale state between a
  // model change and this apply). It is pruned, not carried — an id the mesh
  // does not define would write a part listing phantom entities.
  const universes = entityUniverses(model);
  for (const kind of ENTITY_KINDS) {
    const before = kinds[kind].length;
    kinds[kind] = kinds[kind].filter((id) => universes[kind].has(id));
    if (before !== kinds[kind].length)
      return { kinds: { Elements: [], Conditions: [], Geometries: [] }, reason: "the selection names entities that are not in the mesh — refresh the selection and try again." };
  }
  return { kinds };
}

/**
 * The files a mergeMesh record names. `paths` is today's shape; a single `path`
 * is the pre-N-ary spelling and is still honoured, because saved recipes and
 * problem archives on disk can predate the extension that reads them.
 */
function mergeSourcePaths(rec: Extract<OpRecord, { op: "mergeMesh" }>): string[] {
  if (rec.paths && rec.paths.length > 0) return rec.paths;
  return rec.path ? [rec.path] : [];
}

export type OpRecord =
  | { op: "linearToQuadratic" }
  | { op: "removeOrphanNodes" }
  | { op: "mergeNodes"; tolerance: number }
  | { op: "scale"; sx: number; sy: number; sz: number }
  | { op: "translate"; dx: number; dy: number; dz: number }
  | { op: "rotate"; axis: Axis; angle: number; cx?: number; cy?: number; cz?: number }
  | { op: "deleteSubModelPart"; path: string }
  | { op: "renameSubModelPart"; path: string; newName: string }
  | { op: "createSubModelPart"; parentPath: string; name: string }
  | { op: "moveSubModelPart"; path: string; newParentPath: string }
  | { op: "mergeSubModelParts"; sourcePath: string; targetPath: string }
  | { op: "addSubModelPartEntities"; path: string; kind: SmpEntityKind; ids: number[] }
  | { op: "removeSubModelPartEntities"; path: string; kind: SmpEntityKind; ids: number[] }
  | { op: "writeMeshSizeFields"; target: MeshSizeTarget }
  | { op: "setElementRadius"; value: number; mode: RadiusMode; target?: string }
  // Properties authoring (propertyOps.ts) — pure, sync, native. Never writes a
  // field: a Properties value and an Elemental CROSS_AREA are two sources of
  // truth, and the beam renderer reads the former by design (see beamElements.ts).
  | { op: "setProperty"; propertyId: number; name: string; value: PropertyValue }
  | { op: "createProperty"; id?: number; name?: string; value?: PropertyValue }
  | { op: "cloneProperty"; propertyId: number; newId?: number }
  | { op: "deleteProperty"; propertyId: number }
  // `kind`+`ids` or `part` scope the rewrite; Geometries carry no propertyIds
  // and are refused (flat fields rather than a nested scope: recipes are JSON).
  | { op: "assignProperty"; propertyId: number; kind?: EntityKind; ids?: number[]; part?: string }
  // A SubModelPart built from what is selected: explicit per-kind id lists
  // (the webview's picks) or a `seed` predicate resolved AGAINST the model at
  // apply time (the headless/recipe spelling — also what makes the op
  // chainable inside one mesh_transform array). Exactly one must resolve to
  // something, or the op is a noop by name rather than an empty part.
  | {
      op: "createSubModelPartFromSelection";
      parentPath: string;
      name: string;
      elements?: number[];
      conditions?: number[];
      geometries?: number[];
      seed?: SelectionSeed;
    }
  // DELETE the selected entities (the complement of a selection-driven export:
  // the same restrictToCells machinery, run with keep = universe − ids, so
  // conditions on surviving ground stay, constraints vanish with their nodes,
  // fields slice and SubModelParts narrow — the shipped rules, not new ones).
  | {
      op: "deleteEntities";
      elements?: number[];
      conditions?: number[];
      geometries?: number[];
    }
  | ({ op: "smooth" } & SmoothParams)
  | { op: "reorder"; method: ReorderMethod }
  | { op: "partition"; nparts: number; method?: PartitionMethod; createParts?: boolean }
  | { op: "linearize" }
  | { op: "refine"; levels?: number; select?: RefineSelector }
  | { op: "simplexify" }
  | ({ op: "crop" } & CropParams)
  | ({ op: "fieldCalc" } & FieldCalcParams)
  | ({ op: "averageField" } & AverageFieldParams)
  // Field management (fieldManage.ts): native, sync, lossless.
  | ({ op: "renameField" } & RenameFieldParams)
  | ({ op: "keepFields" } & FieldSelectParams)
  | ({ op: "dropFields" } & FieldSelectParams)
  | ({ op: "conditionField" } & ConditionFieldParams)
  // Native, sync: each Element's connected-component index as a field (see splitComponents.ts).
  | ({ op: "markComponents" } & MarkComponentsParams)
  // Adopting meshio++ ops (see adoptOp.ts): the result replaces the mesh.
  | ({ op: "repairSurface" } & RepairSurfaceParams)
  // meshio++ surface/volume meshing, ADOPTED in place with an explicit cell-identity policy (see meshing.ts).
  | ({ op: "surfaceRemesh" } & SurfaceRemeshParams)
  | ({ op: "volumeMesh" } & VolumeMeshParams)
  | ({ op: "optimizeVolume" } & OptimizeVolumeParams)
  // meshio++ as an ORACLE (see curvature.ts): per-node curvature fields, cells untouched.
  | ({ op: "curvature" } & CurvatureParams)
  // Coordinate-only meshio++ oracles (see deform.ts). shrinkwrap names its
  // target surface exactly like sdfDistance: a file, a SubModelPart of this
  // mesh, or its own skin — exactly one.
  | ({ op: "shrinkwrap"; path?: string; part?: string; skin?: boolean } & ShrinkwrapParams)
  | ({ op: "sobolevDeform" } & SobolevParams)
  // Compares one of THIS mesh's fields with the same field of another file and
  // writes <base>_DIFF/_ABS/_REL (see meshCompare.ts). Async: it reads the file.
  | ({ op: "compareField"; path: string } & CompareFieldParams)
  // A global (scalar) variable: one reduction of a field's values, stored as
  // a SPEC on `model.globals` (see globalReduce.ts) and recomputed from the
  // current fields by every formula scope — never a stored value that could
  // go stale. Sync: reductions are one O(n) pass over values already in hand.
  | { op: "reduceField"; variable: string; kind: FieldBlockKind; reduction: GlobalReduction; output: string }
  | ({ op: "fieldGradient" } & GradientParams)
  | ({ op: "fieldHessian" } & HessianParams)
  | ({ op: "estimateError" } & ErrorEstimateParams)
  // `path`/`part`/`skin` mirror remesh's `distanceSurfacePath`/
  // `distanceSurfacePart`/`distanceSurfaceSkin` split and are mutually
  // exclusive for the same reason: `path` reads a second file off disk, `part`
  // extracts a SubModelPart already in THIS model (extractSubModelPart — no
  // file, no I/O), `skin` is the mesh's own exterior skin (the one File ▸
  // Export skin… writes — see skinDistanceSurface). Exactly one is required.
  | ({ op: "sdfDistance"; path?: string; part?: string; skin?: boolean } & SdfParams)
  | ({ op: "transferField"; path: string } & TransferFieldParams)
  | ({ op: "renumber" } & RenumberParams)
  // `path` is the pre-N-ary spelling, kept optional so an old recipe still
  // type-checks on its way through parseOpsJson; mergeSourcePaths resolves both.
  | ({ op: "mergeMesh"; paths?: string[]; path?: string } & MergeMeshParams)
  // `distanceSurfacePath`/`distanceSurfacePart` are the two recipe-safe
  // spellings of RemeshParams' `distanceSurface` (an in-memory MdpaModel,
  // never persisted — see remesh.ts); `Omit` keeps that field itself
  // unreachable on a stored record. `distanceSurfacePath` reads a SECOND file
  // off disk (the split sdfDistance/transferField/mergeMesh already use);
  // `distanceSurfacePart` instead extracts a SubModelPart ALREADY IN the model
  // being remeshed (e.g. an existing skin/boundary group) via
  // `extractSubModelPart` — no second file needed. Mutually exclusive
  // (`validateParams` refuses both set); applyOpAsync resolves whichever is
  // given into a real model right before running. Kept for scripted/recipe
  // use (mesh_transform, an old saved recipe) even though the Remesh sidebar
  // form no longer offers a dedicated picker for either — the interactive
  // equivalent is computing a variable via the Variables panel (or
  // `sdfDistance` directly) and referencing it by name, which the `expr`
  // scope's field widening (see `remesh.ts`) already covers with no
  // remesh-specific wiring needed. `distanceSurfaceSkin` is the third
  // spelling: the model's own exterior skin (skinDistanceSurface).
  | ({
      op: "remesh";
      distanceSurfacePath?: string;
      distanceSurfacePart?: string;
      distanceSurfaceSkin?: boolean;
    } & Omit<
      RemeshParams,
      "distanceSurface"
    >)
  | ({ op: "levelset" } & LevelsetParams);

// OpName/OP_LABELS live in opLabels.ts (a fs/path-free leaf module) so the
// webview bundle can import them without pulling in this file's node:fs
// import; re-exported here so every existing import site is unaffected.
export type { OpName };
export { OP_LABELS };

/**
 * Ops that run through the (async, comparatively slow) MMG WASM pipeline.
 * They must go through applyOpAsync/replayOpsAsync, and the history keeps a
 * snapshot after them so undo/redo of later ops never re-runs the remesher.
 */
export function isAsyncOp(op: OpName): boolean {
  return ASYNC_OPS.has(op);
}

/**
 * Operations that run through WASM and must therefore be awaited.
 *
 * Two families, both async for the same mechanical reason (`applyOp` is
 * synchronous) but with different UX weight: the MMG ops are slow enough to
 * need live progress and cancellation, while the meshio++ ones are a single
 * in-process call with neither. They share the gate because the gate is about
 * awaitability, and it also earns them history snapshotting — worth having for
 * any op you would rather not re-run on every undo.
 */
const ASYNC_OPS = new Set<OpName>([
  "repairSurface",
  "surfaceRemesh",
  "volumeMesh",
  "optimizeVolume",
  "curvature",
  "shrinkwrap",
  "sobolevDeform",
  "compareField",
  "remesh",
  "levelset",
  "smooth",
  "reorder",
  "partition",
  "mergeMesh",
  "fieldGradient",
  "fieldHessian",
  "estimateError",
  "sdfDistance",
  "transferField",
]);

/** Live-progress + cancellation hooks threaded down to the MMG runner. */
export interface MmgRunOptions {
  onProgress?: MmgProgress;
  /** Honoured by the worker runner (thread terminated); the in-process default cannot abort a running WASM call. */
  signal?: AbortSignal;
  /**
   * Pass over the ASYNC_OPS during a replay instead of running them.
   *
   * Exists for stepping a VTK timeline: every frame change re-bases the history
   * and replays it, and re-running a remesh (or any meshio++ oracle) on every
   * arrow-key press would make the timeline unusable. The skipped ops stay in
   * the stack, marked, and a Re-apply runs them deliberately.
   */
  skipAsyncOps?: boolean;
  /**
   * Called with each op's own outcome as a replay walks the stack.
   *
   * `replayOpsAsync` has always computed this and thrown it away, which is why
   * a REDO could advance the cursor over an operation that no longer applies
   * without a word — unlike `replayOntoBase`, which marks every op it runs.
   * Optional and unread by every other caller, so `current()`'s contract is
   * unchanged for them.
   */
  onOutcome?: (index: number, rec: OpRecord, out: { noop?: boolean; message?: string }) => void;
}

/** How the MMG ops execute; swappable so the extension can run them in a worker thread. */
export type MmgRunner = (
  op: "remesh" | "levelset",
  model: MdpaModel,
  params: RemeshParams | LevelsetParams,
  opts?: MmgRunOptions
) => Promise<RemeshResult>;

let mmgRunner: MmgRunner = (op, model, params, opts) =>
  op === "remesh"
    ? remeshModel(model, params as RemeshParams, opts?.onProgress)
    : levelsetModel(model, params as LevelsetParams, opts?.onProgress);

/**
 * Replaces the in-process MMG runner (the default, used by plain-Node tests).
 * `extension.ts` installs the worker-thread client at activation so remeshes
 * never block the extension host and can be cancelled.
 */
export function configureMmgRunner(runner: MmgRunner): void {
  mmgRunner = runner;
}

/**
 * The one call site both MMG ops go through, so the status bar's engine line
 * (`engineActivity.ts`) sees every run — worker or in-process — without either
 * runner knowing about it.
 */
function runMmg(
  op: "remesh" | "levelset",
  model: MdpaModel,
  params: RemeshParams | LevelsetParams,
  opts?: MmgRunOptions
): Promise<RemeshResult> {
  return trackEngine("mmg", () => mmgRunner(op, model, params, opts));
}

export interface OpApplied {
  model: MdpaModel;
  /** Nodes the preview should highlight (e.g. new quadratic mid nodes). */
  highlightNodes?: number[];
  /** True when the op left the model unchanged (nothing to do). */
  noop?: boolean;
}

/** A short summary of an op's effect for the result toast. */
export interface OpOutcome extends OpApplied {
  message?: string;
}

/**
 * Whether a global output name survives into formula scopes: it must not
 * collide with a reserved sizing variable (h/x/y/z/stats/d) or with an
 * existing field name of any kind (fields win — per-entity lookup stays
 * primary). Mirrors the filter `remeshSizeExprVars` and `expressionSizes`
 * apply independently; kept here so the `reduceField` message can warn at
 * creation time instead of letting an unusable global pass silently (a global
 * exists ONLY for formulas, unlike a field, so silence would be worse).
 */
function isScopeUsableGlobalName(output: string, model: MdpaModel): boolean {
  const name = output.toLowerCase();
  if ([...SIZE_EXPR_VARIABLES, REMESH_DISTANCE_VAR].includes(name)) return false;
  return !model.fields.some((f) => f.variable.toLowerCase() === name);
}

/** Worker crash / cancellation → a noop outcome, shared by both MMG ops. */
function mmgFailureOutcome(op: "remesh" | "levelset", model: MdpaModel, err: unknown): OpOutcome {  const why = err instanceof Error ? err.message : String(err);
  return {
    model,
    noop: true,
    message: why === "cancelled" ? `${OP_LABELS[op]} cancelled.` : `${OP_LABELS[op]} failed: ${why}`,
  };
}

/**
 * Carries the pre-remesh model's data fields onto a successful MMG result
 * (remesh or levelset — both rebuild through `rebuildModel`, which returns
 * `fields: []`). Runs host-side in `applyOpAsync`, AFTER `mmgRunner` resolves,
 * so the worker thread only ever sees geometry and plain-Node/MCP callers get
 * the identical behavior through the default in-process runner. Nodal values
 * are barycentric-interpolated (exact for P1-on-simplex fields, bit-exact on
 * an identical mesh), cell values come from the containing source cell.
 *
 * Mapping failure degrades to the legacy drop message and can never fail (or
 * noop) a good remesh: the worst case is exactly yesterday's behavior. A
 * field-less source passes through untouched.
 */
async function withRemappedFields(
  prevModel: MdpaModel,
  outcome: OpOutcome,
  op: "remesh" | "levelset",
  opts?: MmgRunOptions
): Promise<OpOutcome> {
  if (outcome.noop || prevModel.fields.length === 0) return outcome;
  const product = op === "remesh" ? "remeshed" : "split";
  opts?.onProgress?.(`Mapping ${prevModel.fields.length} field(s) onto the ${product} mesh…`);
  const diagnostics: MdpaDiagnostic[] = [];
  try {
    const r = await remapFieldsOntoRemesh(outcome.model, prevModel, diagnostics);
    const tail: string[] = [];
    if (r.transferred.length > 0) {
      tail.push(
        `Mapped ${r.transferred.length} field(s) onto the new mesh ` +
          `(${r.transferred.map((t) => t.name).join(", ")}).`
      );
    }
    for (const d of r.dropped) tail.push(`Dropped ${d.name} (${d.reason}).`);
    if (r.fixedDropped) {
      tail.push("Nodal fixity flags were not carried (new nodes have no fixity).");
    }
    if (r.nearestFallbacks > 0) {
      tail.push(
        `${r.nearestFallbacks} node(s)/cell(s) took the nearest source value ` +
          `(outside any source cell — MMG only drifts the surface, so a large count means a bad mesh).`
      );
    }
    return {
      ...outcome,
      model: r.model,
      message: [outcome.message, ...tail].filter(Boolean).join(" "),
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ...outcome,
      message:
        `${outcome.message ?? ""} ${prevModel.fields.length} data field(s) were dropped ` +
        `(field mapping failed: ${why}).`,
    };
  }
}

/** Applies a single operation to `model` (pure; input never mutated). */
export function applyOp(model: MdpaModel, rec: OpRecord): OpOutcome {
  switch (rec.op) {
    case "linearToQuadratic": {
      const r = linearToQuadratic(model);
      if (r.convertedCells === 0) return { model, noop: true, message: "No linear cells to convert." };
      return {
        model: r.model,
        highlightNodes: r.addedNodeIds,
        message: `Converted ${r.convertedCells} cell(s) to quadratic (+${r.addedNodes} node(s)).`,
      };
    }
    case "removeOrphanNodes": {
      const r = removeOrphanNodes(model);
      if (r.removed === 0) return { model, noop: true, message: "No orphan nodes to remove." };
      return { model: r.model, message: `Removed ${r.removed} orphan node(s).` };
    }
    case "mergeNodes": {
      const r = mergeNodes(model, rec.tolerance);
      if (r.merged === 0) return { model, noop: true, message: "No coincident nodes to merge." };
      const dropped =
        r.constraintsDropped > 0
          ? ` Dropped ${r.constraintsDropped} constraint(s) the weld made self-referential.`
          : "";
      return { model: r.model, message: `Merged ${r.merged} coincident node(s).${dropped}` };
    }
    case "scale": {
      return {
        model: scaleCoords(model, rec.sx, rec.sy, rec.sz),
        message: `Scaled by (${rec.sx}, ${rec.sy}, ${rec.sz}).`,
      };
    }
    case "translate": {
      return {
        model: translateCoords(model, rec.dx, rec.dy, rec.dz),
        message: `Translated by (${rec.dx}, ${rec.dy}, ${rec.dz}).`,
      };
    }
    case "rotate": {
      const cx = rec.cx ?? 0, cy = rec.cy ?? 0, cz = rec.cz ?? 0;
      return {
        model: rotateCoords(model, rec.axis, rec.angle, cx, cy, cz),
        message: `Rotated ${rec.angle}° about ${rec.axis.toUpperCase()} through (${cx}, ${cy}, ${cz}).`,
      };
    }
    case "deleteSubModelPart": {
      const r = deleteSubModelPart(model, rec.path);
      if (!r.deleted) return { model, noop: true, message: `SubModelPart "${rec.path}" not found.` };
      return { model: r.model, message: `Deleted SubModelPart "${rec.path}".` };
    }
    case "renameSubModelPart": {
      const r = renameSubModelPart(model, rec.path, rec.newName);
      if (!r.renamed) return { model, noop: true, message: `Could not rename SubModelPart "${rec.path}".` };
      return { model: r.model, message: `Renamed SubModelPart "${rec.path}" → "${rec.newName}".` };
    }
    case "createSubModelPart": {
      const r = createSubModelPart(model, rec.parentPath, rec.name);
      if (!r.created) return { model, noop: true, message: r.message ?? "Could not create the SubModelPart." };
      const where = rec.parentPath ? `"${rec.parentPath}"` : "the model";
      return { model: r.model, message: `Created SubModelPart "${rec.name}" under ${where}.` };
    }
    case "moveSubModelPart": {
      const r = moveSubModelPart(model, rec.path, rec.newParentPath);
      if (!r.moved) return { model, noop: true, message: r.message ?? "Could not move the SubModelPart." };
      // The propagation is Kratos' own AddNode behaviour, but it changes parts
      // the user did not name — so it is reported rather than done silently.
      const extra = r.propagated > 0 ? ` ${r.propagated} entity id(s) added to the new ancestors.` : "";
      return {
        model: r.model,
        message: `Moved "${rec.path}" under ${rec.newParentPath ? `"${rec.newParentPath}"` : "the model"}.${extra}`,
      };
    }
    case "mergeSubModelParts": {
      const r = mergeSubModelParts(model, rec.sourcePath, rec.targetPath);
      if (!r.merged) return { model, noop: true, message: r.message ?? "Could not merge the SubModelParts." };
      const up = r.propagated > 0 ? `, ${r.propagated} added to its ancestors` : "";
      return {
        model: r.model,
        message: `Merged "${rec.sourcePath}" into "${rec.targetPath}" (+${r.gained} entity id(s)${up}).`,
      };
    }
    case "addSubModelPartEntities": {
      const r = addSubModelPartEntities(model, rec.path, rec.kind, rec.ids);
      if (r.changed === 0 && r.propagated === 0) {
        return { model, noop: true, message: r.message ?? `"${rec.path}" already has those ${rec.kind}.` };
      }
      const extra = r.propagated > 0 ? `, ${r.propagated} added to its ancestors` : "";
      return { model: r.model, message: `Added ${r.changed} ${rec.kind} to "${rec.path}"${extra}.` };
    }
    case "removeSubModelPartEntities": {
      const r = removeSubModelPartEntities(model, rec.path, rec.kind, rec.ids);
      if (r.changed === 0 && r.propagated === 0) {
        return { model, noop: true, message: r.message ?? `"${rec.path}" has none of those ${rec.kind}.` };
      }
      const extra = r.propagated > 0 ? `, ${r.propagated} from its descendants` : "";
      return { model: r.model, message: `Removed ${r.changed} ${rec.kind} from "${rec.path}"${extra}.` };
    }
    case "writeMeshSizeFields": {
      const r = writeMeshSizeFields(model, rec.target);
      if (r.added === 0) return { model, noop: true, message: "No mesh-size fields to write." };
      const what =
        rec.target === "both" ? "NODAL_H + ELEMENT_H" : rec.target === "nodal" ? "NODAL_H" : "ELEMENT_H";
      return { model: r.model, message: `Wrote mesh-size field(s): ${what}.` };
    }
    case "setElementRadius": {
      const r = setElementRadius(model, rec.value, rec.mode, rec.target);
      if (r.changed === 0) {
        return {
          model,
          noop: true,
          message:
            rec.mode === "multiply"
              ? "No existing RADIUS to scale."
              : "No sphere (one-node) elements to set a radius on.",
        };
      }
      const where = rec.target ? ` in "${rec.target}"` : "";
      const what =
        rec.mode === "multiply" ? `scaled by ${rec.value}` : `set to ${rec.value}`;
      return {
        model: r.model,
        message: `Radius ${what} on ${r.changed} element(s)${where}${r.created ? " (field created)" : ""}.`,
      };
    }
    case "setProperty": {
      const r = setProperty(model, rec.propertyId, rec.name, rec.value);
      return r.changed ? { model: r.model, message: r.message ?? `Set ${rec.name} on Properties ${rec.propertyId}.` } : { model, noop: true, message: r.message };
    }
    case "createProperty": {
      const r = createProperty(model, rec);
      return r.changed ? { model: r.model, message: r.message ?? `Created Properties ${rec.id}.` } : { model, noop: true, message: r.message };
    }
    case "cloneProperty": {
      const r = cloneProperty(model, rec.propertyId, rec.newId);
      return r.changed ? { model: r.model, message: r.message } : { model, noop: true, message: r.message };
    }
    case "deleteProperty": {
      const r = deleteProperty(model, rec.propertyId);
      return r.changed ? { model: r.model, message: r.message } : { model, noop: true, message: r.message };
    }
    case "assignProperty": {
      const scope = rec.part ? { part: rec.part } : { kind: rec.kind as EntityKind, ids: rec.ids ?? [] };
      const r = assignProperty(model, scope, rec.propertyId);
      return r.changed ? { model: r.model, message: r.message } : { model, noop: true, message: r.message };
    }
    case "createSubModelPartFromSelection": {
      const { kinds, reason } = resolveSelectionIds(model, rec);
      const total = kinds.Elements.length + kinds.Conditions.length + kinds.Geometries.length;
      if (total === 0) {
        return {
          model,
          noop: true,
          message: reason ?? "The selection resolved to no entities — nothing to put in a SubModelPart.",
        };
      }
      const created = createSubModelPart(model, rec.parentPath, rec.name);
      if (!created.created) return { model, noop: true, message: created.message ?? "Could not create the SubModelPart." };
      const childPath = rec.parentPath ? `${rec.parentPath}/${rec.name}` : rec.name;
      let withEntities = created.model;
      let added = 0;
      let propagated = 0;
      const KINDS: { kind: EntityKind; smp: SmpEntityKind }[] = [
        { kind: "Elements", smp: "elements" },
        { kind: "Conditions", smp: "conditions" },
        { kind: "Geometries", smp: "geometries" },
      ];
      // NODES first: a selection's node closure rides in as an extra kind so
      // the subset rule holds for the whole tree (Kratos' AddNode cascade
      // only pushes adds UP, and a part with elements but no node list is
      // unreadable by the mdpa reader).
      const nodeSet = new Set<number>();
      for (const b of model.blocks) {
        const ids = kinds[b.kind];
        if (!ids.length) continue;
        const idSet = new Set(ids);
        for (let i = 0; i < b.count; i++) {
          if (!idSet.has(b.entityIds[i])) continue;
          for (let k = 0; k < b.stride; k++) nodeSet.add(b.connectivity[i * b.stride + k]);
        }
      }
      if (nodeSet.size > 0) {
        const w = addSubModelPartEntities(withEntities, childPath, "nodes", Array.from(nodeSet).sort((a, b) => a - b));
        propagated += w.propagated;
        withEntities = w.model;
      }
      for (const { kind, smp } of KINDS) {
        if (kinds[kind].length === 0) continue;
        const w = addSubModelPartEntities(withEntities, childPath, smp, kinds[kind]);
        added += w.changed;
        propagated += w.propagated;
        withEntities = w.model;
      }
      const where = rec.parentPath ? `"${rec.parentPath}"` : "the model";
      const parts = KINDS.filter((k) => kinds[k.kind].length > 0).map((k) => `${kinds[k.kind].length} ${k.smp}`).join(", ");
      const nodes = nodeSet.size > 0 ? `${nodeSet.size} node(s), ` : "";
      const up = propagated > 0 ? ` (+${propagated} added to its ancestors)` : "";
      return { model: withEntities, message: `Created SubModelPart "${rec.name}" under ${where} from the selection — ${nodes}${added} entities (${parts})${up}.` };
    }
    case "deleteEntities": {
      // Nothing explicit = illegal, caught at the record level; ids not in the
      // mesh are counted so a stale explicit set is visible rather than silent.
      const clean = (xs?: number[]) => (Array.isArray(xs) ? xs.filter((v) => Number.isFinite(v)) : []);
      const asked = { Elements: clean(rec.elements), Conditions: clean(rec.conditions), Geometries: clean(rec.geometries) };
      const total = asked.Elements.length + asked.Conditions.length + asked.Geometries.length;
      if (total === 0) return { model, noop: true, message: "No entity ids to delete." };
      const universes = entityUniverses(model);
      const before: Record<EntityKind, number> = { Elements: 0, Conditions: 0, Geometries: 0 };
      let matched = 0;
      for (const kind of ["Elements", "Conditions", "Geometries"] as EntityKind[]) {
        for (const id of asked[kind]) if (universes[kind].has(id)) matched++;
      }
      if (matched === 0)
        return { model, noop: true, message: "None of the ids to delete is in the mesh — refresh the selection." };
      const r = deleteEntities(model, asked);
      const dropped: Record<EntityKind, number> = {
        Elements: countOfKind(model, "Elements") - countOfKind(r.model, "Elements"),
        Conditions: countOfKind(model, "Conditions") - countOfKind(r.model, "Conditions"),
        Geometries: countOfKind(model, "Geometries") - countOfKind(r.model, "Geometries"),
      };
      const parts = (["Elements", "Conditions", "Geometries"] as EntityKind[])
        .filter((k) => dropped[k] > 0 || asked[k].length > 0)
        .map((k) => `${dropped[k]}/${asked[k].length} ${k.toLowerCase()}`);
      const extra = r.droppedConstraints > 0 ? `, ${r.droppedConstraints} constraint(s) lost their nodes` : "";
      return {
        model: r.model,
        message: `Deleted ${matched} entity(ies) ${parts.length ? `(${parts.join(", ")})` : ""}${extra}.`,
      };
    }
    case "linearize": {
      const r = linearize(model);
      if (r.convertedCells === 0) return { model, noop: true, message: "No quadratic cells to linearize." };
      return {
        model: r.model,
        message:
          `Linearized ${r.convertedCells} cell(s) (-${r.removedNodes} node(s)).` +
          (r.droppedConstraints > 0
            ? ` Dropped ${r.droppedConstraints} constraint(s) on the removed mid-side nodes.`
            : ""),
      };
    }
    case "refine": {
      const r = refineModel(model, { levels: rec.levels ?? 1, select: rec.select });
      if (r.refinedCells === 0) {
        return { model, noop: true, message: r.problem ?? "No cells could be refined." };
      }
      const parts = [
        rec.select
          ? `Refined ${r.selectedCells} selected + ${r.refinedCells - r.selectedCells} closure cell(s)` +
            ` into ${r.producedCells} (+${r.addedNodes} node(s)), ${r.closurePasses} closure pass(es).`
          : `Refined ${r.refinedCells} cell(s) into ${r.producedCells} (+${r.addedNodes} node(s)).`,
      ];
      if (r.greenCells > 0) {
        parts.push(
          `${r.greenCells} transitional cell(s) are flagged REFINE_GREEN; a later refine splits ` +
            `them fully rather than partially again.`
        );
      }
      if (r.degeneratedToUniform) {
        parts.push("The closure grew the selection to every cell — this is uniform refinement.");
      }
      if (r.unresolvedSelectionIds > 0) {
        parts.push(
          `${r.unresolvedSelectionIds} id(s) in the selector's field name no cell of that kind.`
        );
      }
      // Computed since this op shipped and never surfaced — a block passed
      // through untouched is exactly what a reader needs to know about.
      if (r.skippedBlocks.length > 0) {
        parts.push(`Left untouched: ${r.skippedBlocks.join(", ")}.`);
      }
      return { model: r.model, message: parts.join(" ") };
    }
    case "simplexify": {
      const r = simplexifyModel(model);
      if (r.splitCells === 0) return { model, noop: true, message: "No cells needed splitting into simplices." };
      return {
        model: r.model,
        message: `Split ${r.splitCells} cell(s) into ${r.producedSimplices} simplices.`,
      };
    }
    case "renumber": {
      const r = renumberModel(model, rec);
      const parts: string[] = [];
      if (r.nodesRenumbered > 0) {
        parts.push(`${r.nodesRenumbered} node(s) (max id ${r.spans.nodes[0]} → ${r.spans.nodes[1]})`);
      }
      for (const kind of ["Elements", "Conditions", "Geometries"] as const) {
        const n = r.entitiesRenumbered[kind];
        if (n > 0) parts.push(`${n} ${kind.toLowerCase()} (max id ${r.spans[kind][0]} → ${r.spans[kind][1]})`);
      }
      if (r.constraintsRenumbered > 0) parts.push(`${r.constraintsRenumbered} constraint(s)`);
      if (parts.length === 0) {
        return { model, noop: true, message: "Ids are already consecutive — nothing to compact." };
      }
      const notes: string[] = [];
      if (r.danglingRefs > 0) notes.push(`${r.danglingRefs} dangling reference(s) dropped`);
      if (r.constraintsDropped > 0) {
        notes.push(`${r.constraintsDropped} constraint(s) dropped with their nodes`);
      }
      if (r.constraintIdsLeftUndefined > 0) {
        notes.push(
          `${r.constraintIdsLeftUndefined} constraint id(s) left as-is (no block defines them)`
        );
      }
      return {
        model: r.model,
        message: `Renumbered ${parts.join(" and ")}.${notes.length ? ` ${notes.join("; ")}.` : ""}`,
      };
    }
    case "crop": {
      const r = cropModel(model, rec);
      if (r.droppedCells === 0) return { model, noop: true, message: "Nothing outside the crop region." };
      return {
        model: r.model,
        message:
          `Kept ${r.keptCells} cell(s), dropped ${r.droppedCells} (-${r.removedNodes} node(s)).` +
          (r.droppedConstraints > 0
            ? ` Dropped ${r.droppedConstraints} constraint(s) reaching outside the region.`
            : ""),
      };
    }
    case "fieldCalc": {
      const r = fieldCalcModel(model, rec);
      if (r.computed === 0) return { model, noop: true, message: "The expression produced no values." };
      return { model: r.model, message: `Computed ${rec.output} for ${r.computed} entit(y/ies).` };
    }
    case "averageField": {
      const r = averageField(model, rec);
      if (r.computed === 0) {
        return { model, noop: true, message: `No "${rec.variable}" field to average.` };
      }
      const to = rec.direction === "nodalToElemental" ? "Elemental" : "Nodal";
      return { model: r.model, message: `Averaged ${rec.variable} onto ${r.computed} ${to} record(s).` };
    }
    case "renameField": {
      const r = renameFieldModel(model, rec);
      if (!r.renamed) return { model, noop: true, message: r.message };
      return {
        model: r.model,
        message:
          `Renamed ${rec.kind}:${rec.variable} to ${rec.newName}.` +
          (r.globalsUpdated > 0 ? ` ${r.globalsUpdated} global reduction(s) now read the new name.` : ""),
      };
    }
    case "dropFields":
    case "keepFields": {
      const r = (rec.op === "dropFields" ? dropFieldsModel : keepFieldsModel)(model, rec);
      if (r.removed.length === 0) {
        return {
          model,
          noop: true,
          message:
            rec.op === "dropFields"
              ? `No field matched ${rec.variables.map((v) => `"${v}"`).join(", ")}.`
              : "Every field at that location is already in the keep list.",
        };
      }
      const tail: string[] = [];
      if (r.missing.length > 0) tail.push(`Not found: ${r.missing.join(", ")}.`);
      if (r.orphanedGlobals.length > 0) {
        tail.push(`${r.orphanedGlobals.length} global reduction(s) (${r.orphanedGlobals.join(", ")}) lost their source field.`);
      }
      return {
        model: r.model,
        message: [`Removed ${r.removed.length} field(s): ${r.removed.join(", ")}.`, ...tail].join(" "),
      };
    }
    case "markComponents": {
      const r = markComponentsModel(model, rec);
      if (r.components === 0) return { model, noop: true, message: "The mesh has no Elements to group." };
      if (r.components === 1) {
        return { model, noop: true, message: `The mesh is a single connected component (${r.sizes[0]} element(s)); nothing to mark.` + (r.looseNodes ? ` ${r.looseNodes} loose node(s) belong to no element.` : "") };
      }
      const top = r.sizes.slice(0, 5).join(", ") + (r.sizes.length > 5 ? ", …" : "");
      return {
        model: r.model,
        message:
          `Marked ${r.components} connected components in ${rec.output ?? "COMPONENT_INDEX"} (0 = the largest). Elements per component: ${top}.` +
          (r.isolated > 0 ? ` ${r.isolated} are isolated fragments (under ${100 * (rec.fragmentFraction ?? 0.01)}% of the largest).` : "") +
          (r.looseNodes ? ` ${r.looseNodes} loose node(s) belong to no element.` : ""),
      };
    }
    case "conditionField": {
      const r = conditionFieldModel(model, rec);
      if (r.conditioned === 0) return { model, noop: true, message: r.message };
      const rangeText =
        rec.mode === "clamp"
          ? ` to [${rec.lo ?? 0}, ${rec.hi ?? 1}]`
          : rec.mode === "normalize"
            ? ` onto [${rec.lo ?? 0}, ${rec.hi ?? 1}]`
            : " to zero mean and unit deviation";
      return {
        model: r.model,
        message:
          `${rec.mode === "clamp" ? "Clamped" : rec.mode === "normalize" ? "Normalized" : "Standardized"} ` +
          `${rec.kind}:${rec.variable}${rangeText}${(rec.scope ?? "component") === "magnitude" ? " by magnitude" : ""} ` +
          `(${r.conditioned} record(s)${rec.output ? ` → ${rec.output}` : ""}).` +
          (r.message ? ` ${r.message}` : ""),
      };
    }
    case "reduceField": {
      const spec: GlobalSpec = { variable: rec.variable, kind: rec.kind, reduction: rec.reduction };
      const value = computeGlobal(model, spec);
      if (!Number.isFinite(value)) {
        return { model, noop: true, message: `No usable "${rec.variable}" values to reduce.` };
      }
      const n = globalValueCount(model, spec);
      const globals = { ...(model.globals ?? {}), [rec.output]: spec };
      const tail = isScopeUsableGlobalName(rec.output, { ...model, globals })
        ? ""
        : ` Note: "${rec.output}" is not usable in formulas (reserved or shadowed name).`;
      return {
        model: { ...model, globals },
        message: `Computed ${rec.output} = ${value} (${rec.kind} ${rec.variable}, n=${n}).${tail}`,
      };
    }
    case "remesh":
    case "levelset":
    case "repairSurface":
    case "surfaceRemesh":
    case "volumeMesh":
    case "optimizeVolume":
    case "curvature":
    case "shrinkwrap":
    case "sobolevDeform":
    case "compareField":
    case "smooth":
    case "reorder":
    case "partition":
    case "mergeMesh":
    case "fieldGradient":
    case "fieldHessian":
    case "estimateError":
    case "sdfDistance":
    case "transferField":
      // Loud failure instead of a silent skip: these ops are async-only (WASM,
      // or in mergeMesh's case reading a second file off disk).
      throw new Error(`Operation "${rec.op}" must run through applyOpAsync.`);
    default: {
      // Exhaustiveness guard for unknown op names coming from a loaded recipe.
      return { model, noop: true, message: `Unknown operation.` };
    }
  }
}

/** Applies a single operation, including the async MMG ones (pure; input never mutated). */
/**
 * The second surface an op works against, named one of three ways — `path`
 * reads a SECOND file off disk (mergeMesh's pattern, including its rule that an
 * unreadable file is a noop, never a throw), `part` extracts a SubModelPart
 * already in THIS model via `extractSubModelPart` (no file, no I/O), `skin` uses
 * the mesh's own exterior skin. The caller has already refused more or fewer
 * than one being set. `purpose` finishes the "not found" sentence.
 */
async function resolveSurfaceSource(
  model: MdpaModel,
  rec: { path?: string; part?: string; skin?: boolean },
  purpose: string
): Promise<{ surface: MdpaModel; from: string } | { failure: string }> {
  if (rec.path) {
    try {
      return { surface: await parseMergeSource(rec.path), from: `"${rec.path}"` };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { failure: `Could not read "${rec.path}" (${why}).` };
    }
  }
  if (rec.skin) {
    const skin = skinDistanceSurface(model);
    if (!skin.surface) return { failure: skin.reason! };
    return { surface: skin.surface, from: "the mesh skin" };
  }
  const part = extractSubModelPart(model, rec.part!);
  if (!part) return { failure: `SubModelPart "${rec.part}" not found — nothing to ${purpose}.` };
  return { surface: part, from: `SubModelPart "${rec.part}"` };
}

export async function applyOpAsync(
  model: MdpaModel,
  rec: OpRecord,
  opts?: MmgRunOptions
): Promise<OpOutcome> {
  switch (rec.op) {
    case "mergeMesh": {
      const paths = mergeSourcePaths(rec);
      if (paths.length === 0) return { model, noop: true, message: "No file to merge." };
      const sources: MergeSource[] = [];
      const failed: string[] = [];
      for (const p of paths) {
        try {
          sources.push({ model: await parseMergeSource(p), name: smpNameFromPath(p) });
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          failed.push(`"${p}" (${why})`);
        }
      }
      // A file we cannot read is a noop, never a throw — but one bad file out of
      // several should not discard the ones that did read.
      if (sources.length === 0) {
        return { model, noop: true, message: `Could not read ${failed.join("; ")}` };
      }
      const r = mergeManyModels(model, sources, rec);
      if (r.addedNodes === 0 && r.addedCells === 0) {
        return { model, noop: true, message: "The file(s) to merge were empty." };
      }
      const from =
        paths.length === 1 ? `"${paths[0]}"` : `${r.wrapperPaths.length} file(s)`;
      const weld = r.welded > 0 ? `, welded ${r.welded} coincident node(s)` : "";
      const skipped = r.skipped > 0 ? ` ${r.skipped} empty file(s) skipped.` : "";
      const unread = failed.length > 0 ? ` Could not read ${failed.join("; ")}.` : "";
      return {
        model: r.model,
        message:
          `Merged ${r.addedCells} cell(s) and ${r.addedNodes} node(s) from ${from}${weld}.` +
          `${skipped}${unread}`,
      };
    }
    case "sdfDistance": {
      // Resolved one of two ways, mirroring remesh's distanceSurfacePath /
      // distanceSurfacePart split: `path` reads a SECOND file off disk —
      // mergeMesh's pattern, including its rule that an unreadable file is a
      // noop, never a throw; `part` instead extracts a SubModelPart already
      // in THIS model (e.g. an existing skin/boundary group) via
      // `extractSubModelPart` — no file, no I/O; `skin` measures to the mesh's
      // own exterior skin. `validateParams` already refused more/fewer than
      // one being set.
      const resolved = await resolveSurfaceSource(model, rec, "measure distance to");
      if ("failure" in resolved) return { model, noop: true, message: resolved.failure };
      const { surface, from } = resolved;
      const r = await sdfFieldModel(model, surface, rec);
      if (!r.output) return { model, noop: true, message: "Nothing to measure." };
      const banded = r.numBanded > 0 ? `, ${r.numBanded} clamped by the band` : "";
      return {
        model: r.model,
        message:
          `Computed ${r.output} from ${from} — ${r.numInside} of ` +
          `${model.nodeCount} node(s) inside${banded}.`,
      };
    }
    case "transferField": {
      let source: MdpaModel;
      try {
        source = await parseMergeSource(rec.path);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { model, noop: true, message: `Could not read "${rec.path}" (${why}).` };
      }
      const diagnostics: MdpaDiagnostic[] = [];
      const r = await transferFieldModel(model, source, rec, diagnostics);
      if (r.transferred.length === 0) {
        const why =
          r.dropped.length > 0
            ? ` ${r.dropped.length} array(s) did not survive the internal ` +
              `simplexification and were dropped: ${r.dropped.join(", ")}.`
            : "";
        return { model, noop: true, message: `No field was transferred.${why}` };
      }
      const lost =
        r.dropped.length > 0 ? ` Dropped ${r.dropped.join(", ")} (entity count changed).` : "";
      return {
        model: r.model,
        message: `Transferred ${r.transferred.join(", ")} from "${rec.path}".${lost}`,
      };
    }
    case "levelset":
      try {
        const outcome = await runMmg(rec.op, model, rec, opts);
        return await withRemappedFields(model, outcome, rec.op, opts);
      } catch (err) {
        return mmgFailureOutcome("levelset", model, err);
      }
    case "remesh": {
      // A distance surface is resolved here, one of two ways, and folded into
      // the RemeshParams bundle that crosses (possibly into the worker thread)
      // as one unit, since MmgRunner takes a single serializable `params`. The
      // resolved model is never written back onto `rec`, so a saved recipe
      // still only ever carries `distanceSurfacePath`/`distanceSurfacePart`.
      // `distanceSurfacePath` reads a SECOND file off disk — mergeMesh's
      // pattern, including its rule: an unreadable file is a noop, never a
      // throw. `distanceSurfacePart` instead extracts a SubModelPart already
      // in the CURRENT model (e.g. an existing skin/boundary group) via
      // `extractSubModelPart` — no file, no I/O, and the same "not found is a
      // noop" rule applies since `validateParams` already refused both being
      // set at once.
      let params: RemeshParams = rec;
      if (rec.distanceSurfacePath) {
        try {
          params = { ...rec, distanceSurface: await parseMergeSource(rec.distanceSurfacePath) };
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          return { model, noop: true, message: `Could not read "${rec.distanceSurfacePath}" (${why}).` };
        }
      } else if (rec.distanceSurfacePart) {
        const surface = extractSubModelPart(model, rec.distanceSurfacePart);
        if (!surface) {
          return {
            model,
            noop: true,
            message: `SubModelPart "${rec.distanceSurfacePart}" not found — nothing to measure distance to.`,
          };
        }
        params = { ...rec, distanceSurface: surface };
      } else if (rec.distanceSurfaceSkin) {
        const skin = skinDistanceSurface(model);
        if (!skin.surface) return { model, noop: true, message: skin.reason! };
        params = { ...rec, distanceSurface: skin.surface };
      }
      try {
        const outcome = await runMmg("remesh", model, params, opts);
        return await withRemappedFields(model, outcome, "remesh", opts);
      } catch (err) {
        return mmgFailureOutcome("remesh", model, err);
      }
    }
    case "shrinkwrap": {
      const resolved = await resolveSurfaceSource(model, rec, "project onto");
      if ("failure" in resolved) return { model, noop: true, message: resolved.failure };
      const r = await shrinkwrapModel(model, resolved.surface, rec);
      if (r.message) return { model, noop: true, message: r.message };
      if (r.numProjected === 0) {
        return {
          model,
          noop: true,
          message: `No node was projected (${r.numMissed} beyond the maximum distance, ${r.numSkipped} not selected to move).`,
        };
      }
      const parts = [
        `Projected ${r.numProjected} node(s) onto ${resolved.from} (a projection, not a collision-free fit); ` +
          `max displacement ${r.maxDisplacement.toPrecision(4)}.`,
      ];
      if (r.numMissed > 0) parts.push(`${r.numMissed} node(s) beyond the maximum distance were left in place.`);
      if (r.numSkipped > 0) parts.push(`${r.numSkipped} node(s) not selected to move.`);
      if (!r.targetWatertight && (rec.offset ?? 0) !== 0) {
        parts.push("The target is not closed, so a non-zero offset may land on different sides near its defects.");
      }
      const inv = describeInverted(r.inverted);
      if (inv) parts.push(inv);
      return { model: r.model, message: parts.join(" ") };
    }
    case "compareField": {
      let other: MdpaModel;
      try {
        other = await parseMergeSource(rec.path);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { model, noop: true, message: `Could not read "${rec.path}" (${why}).` };
      }
      const r = await compareFieldModel(model, other, rec);
      if (r.written.length === 0) return { model, noop: true, message: r.message ?? "Nothing to compare." };
      const c = r.comparison!;
      const how = (rec.correspondence ?? "id") === "spatial" ? "sampled at this mesh's nodes" : "by id";
      const parts = [
        `Compared ${rec.kind}:${rec.variable} with "${rec.path}" (${how}): ${c.compared} entit(y/ies) compared, ` +
          `max |a−b| = ${c.maxAbs.toPrecision(4)}${c.worstId !== undefined ? ` (id ${c.worstId})` : ""}, ` +
          `RMS ${c.rms.toPrecision(4)}, mean ${c.meanAbs.toPrecision(4)}` +
          (c.maxRel > 0 ? `, max relative ${c.maxRel.toPrecision(4)}` : "") + ".",
      ];
      if ((rec.atol ?? 0) > 0 || (rec.rtol ?? 0) > 0) {
        parts.push(`${c.exceeding} outside the tolerance (atol ${rec.atol ?? 0}, rtol ${rec.rtol ?? 0}).`);
      }
      if (r.uncovered > 0) {
        parts.push(`${r.uncovered} entit(y/ies) of this mesh have no counterpart and are left as gaps, not 0.`);
      }
      if (c.onlyInBIds > 0) parts.push(`${c.onlyInBIds} value(s) exist only in the other mesh.`);
      parts.push(`Wrote ${r.written.map((w) => w.replace(/^[A-Za-z]+:/, "")).join(", ")}.`);
      return { model: r.model, message: parts.join(" ") };
    }
    case "sobolevDeform": {
      const r = await sobolevDeformModel(model, rec);
      if (r.message) return { model, noop: true, message: r.message };
      if (!(r.maxDisplacement > 0)) {
        return { model, noop: true, message: "The smoothed displacement is zero everywhere, so nothing moved." };
      }
      const parts = [
        `Deformed by "${rec.variable}" (length scale ${rec.lengthScale}): ` +
          (rec.lengthScale === 0
            ? "applied unfiltered"
            : `${r.numIterations} iteration(s), relative residual ${r.residual.toExponential(2)}`) +
          `; max displacement ${r.maxDisplacement.toPrecision(4)}.`,
      ];
      if (!r.converged) {
        parts.push(
          `Did NOT converge (relative residual ${r.residual.toExponential(2)}): the last iterate was kept — raise max iterations or lower the length scale.`
        );
      }
      if (r.numFixed > 0) parts.push(`${r.numFixed} node(s) pinned.`);
      if (r.numIsolated > 0) parts.push(`${r.numIsolated} node(s) in no top-dimensional cell received their raw displacement.`);
      if (r.numUncovered > 0) parts.push(`${r.numUncovered} node(s) had no value in the field and moved by 0.`);
      const inv = describeInverted(r.inverted);
      if (inv) parts.push(inv);
      return { model: r.model, message: parts.join(" ") };
    }
    case "curvature": {
      const r = await curvatureModel(model, rec);
      if (r.written.length === 0) {
        return { model, noop: true, message: r.message ?? "Every node's curvature is undefined (boundary or unreferenced nodes)." };
      }
      const range = (key: string): string => {
        const s = r.stats[key];
        return s && s.count > 0 ? `[${s.min.toPrecision(4)}, ${s.max.toPrecision(4)}]` : "undefined";
      };
      const prefix = rec.outputPrefix ?? "CURVATURE";
      const parts = [`Wrote ${r.written.map((k) => k.replace(/^Nodal:/, "")).join(", ")}.`];
      if (r.stats[`Nodal:${prefix}_MEAN`]) parts.push(`Mean curvature ∈ ${range(`Nodal:${prefix}_MEAN`)}.`);
      if (r.stats[`Nodal:${prefix}_GAUSSIAN`]) parts.push(`Gaussian curvature ∈ ${range(`Nodal:${prefix}_GAUSSIAN`)}.`);
      const gb = gaussBonnetResidual(r);
      if (gb !== undefined) {
        parts.push(
          `Gauss–Bonnet: Σ angle defect = ${r.totalAngleDefect.toPrecision(6)} vs 2πχ = ${(2 * Math.PI * r.eulerCharacteristic).toPrecision(6)}.`
        );
      }
      parts.push(...r.warnings);
      return { model: r.model, message: parts.join(" ") };
    }
    case "surfaceRemesh": {
      const r = await surfaceRemeshModel(model, rec);
      return r.changed ? { model: r.model, message: r.message } : { model, noop: true, message: r.message };
    }
    case "volumeMesh": {
      const r = await volumeMeshModel(model, rec);
      return r.changed ? { model: r.model, message: r.message } : { model, noop: true, message: r.message };
    }
    case "optimizeVolume": {
      const r = await optimizeVolumeModel(model, rec);
      return r.changed ? { model: r.model, message: r.message } : { model, noop: true, message: r.message };
    }
    case "repairSurface": {
      const r = await repairSurfaceModel(model, rec);
      if (!r.changed) return { model, noop: true, message: r.message };
      return { model: r.model, message: r.message };
    }
    case "smooth": {
      const r = await smoothModel(model, rec);
      if (r.numNodesMoved === 0) {
        return { model, noop: true, message: "No nodes could be moved (all pinned)." };
      }
      const skipped = r.numSkippedInversion > 0
        ? `, ${r.numSkippedInversion} move(s) skipped to avoid inverting a cell`
        : "";
      return {
        model: r.model,
        message:
          `Smoothed ${r.numNodesMoved} node(s), max displacement ` +
          `${r.maxDisplacement.toPrecision(3)}${skipped}.`,
      };
    }
    case "fieldGradient": {
      const r = await gradientFieldModel(model, rec);
      if (!r.output) {
        return { model, noop: true, message: `No "${rec.variable}" field to differentiate.` };
      }
      // NaN rows and least-squares fallbacks are reported rather than hidden: a
      // partly-NaN field looks clean in the field picker and is not.
      const notes: string[] = [];
      if (r.numSkipped > 0) notes.push(`${r.numSkipped} cell(s) could not be differentiated`);
      if (r.numFallback > 0) notes.push(`${r.numFallback} fell back to Green-Gauss`);
      return {
        model: r.model,
        message:
          `Computed ${r.output} (${r.components} component(s))` +
          (notes.length > 0 ? ` — ${notes.join(", ")}` : "") +
          ".",
      };
    }
    case "fieldHessian": {
      const r = await hessianFieldModel(model, rec);
      if (!r.output) {
        return { model, noop: true, message: `No "${rec.variable}" field to differentiate.` };
      }
      // Same honesty as fieldGradient: a partly-NaN field looks clean in the
      // field picker, and the composition falls back on a poor neighbourhood.
      const notes: string[] = [];
      if (r.numSkipped > 0) notes.push(`${r.numSkipped} node(s) could not be differentiated`);
      if (r.numFallback > 0) notes.push(`${r.numFallback} fell back to Green-Gauss`);
      return {
        model: r.model,
        message:
          `Computed ${r.output} (${r.components} component(s))` +
          (notes.length > 0 ? ` — ${notes.join(", ")}` : "") +
          ".",
      };
    }
    case "estimateError": {
      const r = await estimateErrorModel(model, rec);
      if (!r.output) {
        return { model, noop: true, message: `No "${rec.variable}" field to estimate from.` };
      }
      const notes: string[] = [];
      if (r.marked) notes.push(`${r.numMarked} cell(s) marked as ${r.marked}`);
      if (r.numSkipped > 0) notes.push(`${r.numSkipped} cell(s) could not be evaluated (NaN)`);
      return {
        model: r.model,
        message:
          `Computed ${r.output}; global error ${r.globalError.toExponential(3)}` +
          (notes.length > 0 ? ` — ${notes.join(", ")}` : "") +
          ".",
      };
    }
    case "reorder": {
      const r = await reorderModel(model, rec.method);
      if (r.moved === 0) return { model, noop: true, message: "Node order already optimal." };
      // Report the outcome honestly: RCM on an already well-numbered mesh can
      // come out worse, and the space-filling methods optimize locality rather
      // than bandwidth, so a rise is expected there rather than a failure.
      const delta =
        r.bandwidthAfter < r.bandwidthBefore
          ? ""
          : rec.method === "rcm"
            ? " — no improvement; the original numbering was already good"
            : " (this method optimizes cache locality, not bandwidth)";
      return {
        model: r.model,
        message:
          `Reordered ${r.moved} node(s) — bandwidth ${r.bandwidthBefore} → ` +
          `${r.bandwidthAfter}${delta}.`,
      };
    }
    case "partition": {
      const r = await partitionModel(model, rec);
      if (r.assigned === 0) return { model, noop: true, message: "No cells to partition." };
      return {
        model: r.model,
        message:
          `Partitioned ${r.assigned} cell(s) into ${r.sizes.length} part(s) ` +
          `(${r.sizes.join(" / ")}) as ${PARTITION_VARIABLE}.`,
      };
    }
    default:
      return applyOp(model, rec);
  }
}

/** Folds `ops` over `base`, returning the final model + the last op's highlight. */
export function replayOps(base: MdpaModel, ops: OpRecord[]): OpApplied {
  let model = base;
  let highlightNodes: number[] | undefined;
  for (const rec of ops) {
    const out = applyOp(model, rec);
    model = out.model;
    highlightNodes = out.noop ? highlightNodes : out.highlightNodes;
  }
  return { model, highlightNodes };
}

/** Async replay: like replayOps but able to run the MMG operations. */
export async function replayOpsAsync(
  base: MdpaModel,
  ops: OpRecord[],
  opts?: MmgRunOptions
): Promise<OpApplied> {
  let model = base;
  let highlightNodes: number[] | undefined;
  for (let i = 0; i < ops.length; i++) {
    const rec = ops[i];
    if (opts?.signal?.aborted) break;
    // Left out entirely rather than run — see MmgRunOptions.skipAsyncOps. The
    // model passes through untouched, exactly as a noop would.
    if (opts?.skipAsyncOps && isAsyncOp(rec.op)) continue;
    const out = await applyOpAsync(model, rec, opts);
    opts?.onOutcome?.(i, rec, out);
    model = out.model;
    highlightNodes = out.noop ? highlightNodes : out.highlightNodes;
  }
  return { model, highlightNodes };
}

const RECIPE_VERSION = 1;
const KNOWN_OPS = new Set<OpName>([
  "linearToQuadratic",
  "removeOrphanNodes",
  "mergeNodes",
  "scale",
  "translate",
  "rotate",
  "deleteSubModelPart",
  "renameSubModelPart",
  "createSubModelPart",
  "moveSubModelPart",
  "mergeSubModelParts",
  "addSubModelPartEntities",
  "removeSubModelPartEntities",
  "writeMeshSizeFields",
  "setElementRadius",
  "setProperty",
  "createProperty",
  "cloneProperty",
  "deleteProperty",
  "assignProperty",
  "createSubModelPartFromSelection",
  "deleteEntities",
  "smooth",
  "reorder",
  "renumber",
  "partition",
  "linearize",
  "refine",
  "simplexify",
  "crop",
  "fieldCalc",
  "averageField",
  "renameField",
  "keepFields",
  "dropFields",
  "conditionField",
  "markComponents",
  "repairSurface",
  "surfaceRemesh",
  "volumeMesh",
  "optimizeVolume",
  "curvature",
  "shrinkwrap",
  "sobolevDeform",
  "compareField",
  "reduceField",
  "fieldGradient",
  "fieldHessian",
  "estimateError",
  "sdfDistance",
  "transferField",
  "mergeMesh",
  "remesh",
  "levelset",
]);

const MMG_MODULES = new Set(["auto", "mmg3d", "mmgs", "mmg2d"]);
const REMESH_MODES = new Set(["factor", "hsiz", "optimize", "expr", "aniso"]);
const FROZEN_KINDS = new Set(["block", "part"]);
const MESH_SIZE_TARGETS = new Set<MeshSizeTarget>(["nodal", "element", "both"]);
const RADIUS_MODES = new Set<RadiusMode>(["absolute", "multiply"]);
const SMOOTH_METHODS = new Set<SmoothMethod>(["laplacian", "taubin", "odt"]);
const PARTITION_METHODS = new Set<PartitionMethod>(["sfc", "kahip", "auto"]);
const CROP_MODES = new Set(["all", "any"]);
const FIELD_LOCATIONS = new Set(["Nodal", "Elemental", "Conditional"]);
const CELL_BLOCK_KINDS = new Set(["Elements", "Conditions"]);
const AVERAGE_DIRECTIONS = new Set(["nodalToElemental", "elementalToNodal"]);

/**
 * Coerces a message's raw JSON into a `PropertyValue` — a plain number/bool/
 * string or array is accepted too (the webview's property form does not need
 * to know the tagged union), while a malformed structured value is refused
 * rather than degraded, since silent data surgery here would be invisible
 * until the written file surprised the solver.
 */
/**
 * Structural-only value check for RECIPE records (parseOpsJson hands these
 * over after JSON ingest, so the tagged shape is spelled exactly); `undefined`
 * passes, because `createProperty` legitimately builds an empty set.
 */
function isPropertyValueShape(v: unknown): v is PropertyValue {
  if (v === undefined || v === null) return true;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return true;
  if (Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x))) return true;
  if (Array.isArray(v) && v.length > 0 && v.every((row) => Array.isArray(row) && row.every((x) => typeof x === "number" && Number.isFinite(x)))) return true;
  if (v && typeof v === "object") {
    const kind = (v as { kind?: unknown }).kind;
    if (kind === "number" && Number.isFinite((v as { value?: number }).value)) return true;
    if (kind === "bool") return true;
    if (kind === "string") return true;
    if (kind === "vector") return isPropertyValueShape((v as { values?: unknown }).values);
    if (kind === "matrix") {
      const rows = (v as { rows?: unknown }).rows;
      return Array.isArray(rows) && rows.length > 0 && rows.every((row) => isPropertyValueShape(row));
    }
  }
  return false;
}

/** Shape-less message forms (number/bool/string/array) accept the wrapped shape. */
function propertyValueFromMessage(raw: unknown): PropertyValue | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? { kind: "number", value: raw } : undefined;
  if (typeof raw === "boolean") return { kind: "bool", value: raw };
  if (typeof raw === "string") return { kind: "string", value: raw };
  if (Array.isArray(raw) && raw.every((v) => typeof v === "number" && Number.isFinite(v)))
    return { kind: "vector", values: raw as number[] };
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((row) => Array.isArray(row) && row.every((v) => typeof v === "number" && Number.isFinite(v)))
  )
    return { kind: "matrix", rows: raw as number[][] };
  if (raw && typeof raw === "object") {
    const tag = (raw as { kind?: unknown }).kind;
    if (tag === "number" || tag === "bool" || tag === "string") {
      const v = (raw as { value?: unknown }).value;
      if (tag === "number") return typeof v === "number" && Number.isFinite(v) ? (raw as PropertyValue) : undefined;
      return typeof v === typeof (tag === "bool" ? true : "s") ? (raw as PropertyValue) : undefined;
    }
    if (tag === "vector" && Array.isArray((raw as { values?: unknown }).values)) return propertyValueFromMessage((raw as { values: unknown }).values);
    if (tag === "matrix" && Array.isArray((raw as { rows?: unknown }).rows)) return propertyValueFromMessage((raw as { rows: unknown }).rows);
  }
  return undefined;
}

/**
 * A record's selection seed: `undefined` when absent, `null` when present but
 * unusable (a malformed seed must refuse the op, not degrade to "no seed").
 */
function selectionSeedFromMessage(raw: unknown): SelectionSeed | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!raw || typeof raw !== "object") return null;
  const seed = raw as Record<string, unknown>;
  const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (seed.kind) {
    case "explicit":
      return { kind: "explicit" };
    case "part": {
      const path = str(seed.path);
      return path ? { kind: "part", path } : null;
    }
    case "field": {
      const variable = str(seed.variable);
      const blockKind = seed.blockKind;
      const lo = seed.lo, hi = seed.hi;
      const component = seed.component === undefined ? undefined : seed.component === "mag" ? "mag" : Number(seed.component);
      if (!variable) return null;
      if (typeof blockKind !== "string" || !FIELD_LOCATIONS.has(blockKind)) return null;
      if (!fin(lo) || !fin(hi)) return null;
      if (component !== undefined && component !== "mag" && !Number.isFinite(Number(component))) return null;
      const rule = seed.rule === undefined ? undefined : seed.rule;
      if (rule !== undefined && rule !== "all" && rule !== "any") return null;
      const out: Extract<SelectionSeed, { kind: "field" }> = {
        kind: "field",
        variable,
        blockKind: blockKind as "Nodal" | "Elemental" | "Conditional",
        lo,
        hi,
      };
      if (component !== undefined) out.component = component as "mag" | number;
      if (rule) out.rule = rule;
      return out;
    }
    case "quality": {
      const metric = str(seed.metric);
      return metric ? { kind: "quality", metric } : null;
    }
    case "property": {
      const propertyId = Number(seed.propertyId);
      return Number.isInteger(propertyId) && propertyId > 0 ? { kind: "property", propertyId } : null;
    }
    default:
      return null;
  }
}

/**
 * Builds a validated OpRecord from a raw webview `applyOp` message (which now
 * carries any numeric parameters entered in the sidebar). Returns undefined on a
 * missing/invalid op or param so the host can ignore it.
 *
 * `model` is OPTIONAL and used only by remesh's `expr` mode, to widen its
 * sizing-formula's allowed variables with the mesh's own existing Nodal field
 * names (see `remeshSizeExprVars`) — every OTHER caller here stays model-free
 * by design, since `applyBatch`'s queued records and a saved recipe's
 * `validateParams` (see below) cannot assume today's model is the one an op
 * will eventually run against. Passed by `opApply.ts`/MCP's `mesh_transform`,
 * both of which already hold the live model at the call site.
 */
export function opRecordFromMessage(
  msg: Record<string, unknown>,
  model?: MdpaModel
): OpRecord | undefined {
  const op = msg.op;
  const num = (k: string, dflt?: number): number => {
    const v = Number(msg[k]);
    return Number.isFinite(v) ? v : dflt ?? NaN;
  };
  switch (op) {
    case "linearToQuadratic":
    case "removeOrphanNodes":
      return { op };
    case "mergeNodes": {
      const tolerance = num("tolerance");
      return tolerance > 0 ? { op, tolerance } : undefined;
    }
    case "scale": {
      const sx = num("sx", 1), sy = num("sy", 1), sz = num("sz", 1);
      return [sx, sy, sz].every(Number.isFinite) ? { op, sx, sy, sz } : undefined;
    }
    case "translate": {
      const dx = num("dx", 0), dy = num("dy", 0), dz = num("dz", 0);
      return [dx, dy, dz].every(Number.isFinite) ? { op, dx, dy, dz } : undefined;
    }
    case "rotate": {
      const axis = msg.axis;
      const angle = num("angle", 0);
      const cx = num("cx", 0), cy = num("cy", 0), cz = num("cz", 0);
      return (axis === "x" || axis === "y" || axis === "z") &&
        [angle, cx, cy, cz].every(Number.isFinite)
        ? { op, axis, angle, cx, cy, cz }
        : undefined;
    }
    case "deleteSubModelPart": {
      const path = msg.path;
      return typeof path === "string" && path.length > 0 ? { op, path } : undefined;
    }
    case "renameSubModelPart": {
      const path = msg.path;
      const newName = msg.newName;
      return typeof path === "string" && path.length > 0 &&
        typeof newName === "string" && newName.length > 0
        ? { op, path, newName }
        : undefined;
    }
    case "createSubModelPart": {
      const parentPath = msg.parentPath;
      const name = msg.name;
      // parentPath "" is legal — it means the top level.
      return typeof parentPath === "string" && typeof name === "string" && name.trim().length > 0
        ? { op, parentPath, name: name.trim() }
        : undefined;
    }
    case "moveSubModelPart": {
      const path = msg.path;
      const newParentPath = msg.newParentPath;
      return typeof path === "string" && path.length > 0 && typeof newParentPath === "string"
        ? { op, path, newParentPath }
        : undefined;
    }
    case "mergeSubModelParts": {
      const sourcePath = msg.sourcePath;
      const targetPath = msg.targetPath;
      return typeof sourcePath === "string" && sourcePath.length > 0 &&
        typeof targetPath === "string" && targetPath.length > 0
        ? { op, sourcePath, targetPath }
        : undefined;
    }
    case "addSubModelPartEntities":
    case "removeSubModelPartEntities": {
      const path = msg.path;
      const kind = msg.kind;
      const ids = msg.ids;
      if (typeof path !== "string" || path.length === 0) return undefined;
      if (typeof kind !== "string" || !SMP_ENTITY_KINDS.includes(kind as SmpEntityKind)) {
        return undefined;
      }
      if (!Array.isArray(ids) || ids.length === 0) return undefined;
      const clean = ids.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (clean.length !== ids.length) return undefined;
      return { op, path, kind: kind as SmpEntityKind, ids: clean };
    }
    case "writeMeshSizeFields": {
      const target = msg.target;
      return typeof target === "string" && MESH_SIZE_TARGETS.has(target as MeshSizeTarget)
        ? { op, target: target as MeshSizeTarget }
        : undefined;
    }
    case "setElementRadius": {
      const value = num("value");
      const mode = msg.mode;
      if (!(value > 0)) return undefined; // a zero or negative radius draws nothing
      if (typeof mode !== "string" || !RADIUS_MODES.has(mode as RadiusMode)) return undefined;
      const target = msg.target;
      // An absent/empty target means the whole mesh; anything else must name a part.
      if (target !== undefined && typeof target !== "string") return undefined;
      const rec: Extract<OpRecord, { op: "setElementRadius" }> = {
        op,
        value,
        mode: mode as RadiusMode,
      };
      if (typeof target === "string" && target.length > 0) rec.target = target;
      return rec;
    }
    case "setProperty": {
      const propertyId = num("propertyId");
      if (!Number.isInteger(propertyId) || propertyId <= 0) return undefined;
      const name = typeof msg.name === "string" ? msg.name.trim() : "";
      if (!name || /\s/.test(name)) return undefined;
      const value = propertyValueFromMessage(msg.value);
      return value ? { op, propertyId, name, value } : undefined;
    }
    case "createProperty": {
      const rec: Extract<OpRecord, { op: "createProperty" }> = { op };
      if (msg.id !== undefined && msg.id !== "") {
        const id = num("id");
        if (!Number.isInteger(id) || id <= 0) return undefined;
        rec.id = id;
      }
      if (msg.name !== undefined) {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        if (!name || /\s/.test(name)) return undefined;
        rec.name = name;
      }
      if (msg.value !== undefined) {
        const value = propertyValueFromMessage(msg.value);
        if (!value) return undefined;
        rec.value = value;
      }
      if (rec.name !== undefined && rec.value === undefined) return undefined;
      return rec;
    }
    case "cloneProperty": {
      const propertyId = num("propertyId");
      if (!Number.isInteger(propertyId) || propertyId <= 0) return undefined;
      const rec: Extract<OpRecord, { op: "cloneProperty" }> = { op, propertyId };
      if (msg.newId !== undefined && msg.newId !== "") {
        const newId = num("newId");
        if (!Number.isInteger(newId) || newId <= 0) return undefined;
        rec.newId = newId;
      }
      return rec;
    }
    case "deleteProperty": {
      const propertyId = num("propertyId");
      return Number.isInteger(propertyId) && propertyId > 0 ? { op, propertyId } : undefined;
    }
    case "assignProperty": {
      const propertyId = num("propertyId");
      if (!Number.isInteger(propertyId) || propertyId <= 0) return undefined;
      const kind = msg.kind;
      const part = typeof msg.part === "string" ? msg.part.trim() : "";
      const ids = msg.ids;
      if (part.length > 0) return { op, propertyId, part };
      if (typeof kind === "string" && ENTITY_KINDS.includes(kind as EntityKind)) {
        const clean = Array.isArray(ids) ? ids.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
        if (clean.length === 0 || clean.length !== (Array.isArray(ids) ? ids.length : -1)) return undefined;
        return { op, propertyId, kind: kind as EntityKind, ids: clean };
      }
      return undefined;
    }
    case "createSubModelPartFromSelection": {
      const parentPath = msg.parentPath;
      const name = typeof msg.name === "string" ? msg.name.trim() : "";
      if (typeof parentPath !== "string" || !name) return undefined;
      const rec: Extract<OpRecord, { op: "createSubModelPartFromSelection" }> = { op, parentPath, name };
      if (Array.isArray(msg.elements)) {
        const clean = msg.elements.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        if (clean.length !== msg.elements.length) return undefined;
        rec.elements = clean;
      }
      if (Array.isArray(msg.conditions)) {
        const clean = msg.conditions.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        if (clean.length !== msg.conditions.length) return undefined;
        rec.conditions = clean;
      }
      if (Array.isArray(msg.geometries)) {
        const clean = msg.geometries.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        if (clean.length !== msg.geometries.length) return undefined;
        rec.geometries = clean;
      }
      const seed = selectionSeedFromMessage(msg.seed);
      if (seed === null) return undefined;
      if (seed) rec.seed = seed;
      const pickCount = (rec.elements?.length ?? 0) + (rec.conditions?.length ?? 0) + (rec.geometries?.length ?? 0);
      if (seed && pickCount > 0) return undefined; // one source, not both
      if (!seed && pickCount === 0) return undefined;
      return rec;
    }
    case "deleteEntities": {
      const rec: Extract<OpRecord, { op: "deleteEntities" }> = { op };
      let total = 0;
      for (const key of ["elements", "conditions", "geometries"] as const) {
        const raw = msg[key];
        if (!Array.isArray(raw)) continue;
        const clean: number[] = [];
        for (const v of raw) {
          if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
          clean.push(v);
        }
        rec[key] = clean;
        total += clean.length;
      }
      return total > 0 ? rec : undefined;
    }
    case "shrinkwrap": {
      const path = typeof msg.path === "string" ? msg.path.trim() : "";
      const part = typeof msg.part === "string" ? msg.part.trim() : "";
      const skin = msg.skin === true;
      if ([path, part, skin].filter(Boolean).length !== 1) return undefined;
      const rec: Extract<OpRecord, { op: "shrinkwrap" }> = path ? { op, path } : skin ? { op, skin: true } : { op, part };
      for (const k of ["offset", "blend"] as const) {
        if (msg[k] === undefined || msg[k] === "") continue;
        const v = Number(msg[k]);
        if (!Number.isFinite(v)) return undefined;
        rec[k] = v;
      }
      if (msg.maxDistance !== undefined && msg.maxDistance !== "") {
        const v = Number(msg.maxDistance);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec.maxDistance = v;
      }
      for (const k of ["movePart", "pinPart"] as const) {
        const v = msg[k];
        if (typeof v === "string" && v.trim().length > 0) rec[k] = v.trim();
      }
      const nw = msg.normalWeight;
      if (nw !== undefined && nw !== "") {
        if (nw !== "angle" && nw !== "area") return undefined;
        rec.normalWeight = nw;
      }
      if (msg.recordDistance !== undefined) rec.recordDistance = Boolean(msg.recordDistance);
      return rec;
    }
    case "compareField": {
      const path = typeof msg.path === "string" ? msg.path.trim() : "";
      const variable = typeof msg.variable === "string" ? msg.variable.trim() : "";
      const kind = msg.kind;
      if (!path || !variable) return undefined;
      if (typeof kind !== "string" || !FIELD_LOCATIONS.has(kind)) return undefined;
      const rec: Extract<OpRecord, { op: "compareField" }> = { op, path, variable, kind: kind as FieldBlockKind };
      const sv = msg.sourceVariable;
      if (typeof sv === "string" && sv.trim().length > 0) rec.sourceVariable = sv.trim();
      const co = msg.correspondence;
      if (co !== undefined && co !== "") {
        if (typeof co !== "string" || !(CORRESPONDENCES as readonly string[]).includes(co)) return undefined;
        rec.correspondence = co as Correspondence;
      }
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) {
        if (!isValidFieldName(output.trim())) return undefined;
        rec.output = output.trim();
      }
      for (const k of ["atol", "rtol"] as const) {
        if (msg[k] === undefined || msg[k] === "") continue;
        const v = Number(msg[k]);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec[k] = v;
      }
      return rec;
    }
    case "sobolevDeform": {
      const variable = typeof msg.variable === "string" ? msg.variable.trim() : "";
      if (!variable) return undefined;
      const lengthScale = Number(msg.lengthScale);
      if (msg.lengthScale === undefined || msg.lengthScale === "" || !Number.isFinite(lengthScale) || lengthScale < 0) {
        return undefined;
      }
      const rec: Extract<OpRecord, { op: "sobolevDeform" }> = { op, variable, lengthScale };
      const fixedPart = msg.fixedPart;
      if (typeof fixedPart === "string" && fixedPart.trim().length > 0) rec.fixedPart = fixedPart.trim();
      if (msg.fixBoundary !== undefined) rec.fixBoundary = Boolean(msg.fixBoundary);
      if (msg.maxIterations !== undefined && msg.maxIterations !== "") {
        const v = Number(msg.maxIterations);
        if (!Number.isFinite(v) || v < 1) return undefined;
        rec.maxIterations = Math.floor(v);
      }
      if (msg.tolerance !== undefined && msg.tolerance !== "") {
        const v = Number(msg.tolerance);
        if (!Number.isFinite(v) || !(v > 0)) return undefined;
        rec.tolerance = v;
      }
      return rec;
    }
    case "curvature": {
      const rec: Extract<OpRecord, { op: "curvature" }> = { op };
      for (const k of ["mean", "gaussian", "principal", "area", "includeBoundary"] as const) {
        if (msg[k] !== undefined) rec[k] = Boolean(msg[k]);
      }
      const da = msg.dualArea;
      if (da !== undefined && da !== "") {
        if (typeof da !== "string" || !(CURVATURE_DUAL_AREAS as readonly string[]).includes(da)) return undefined;
        rec.dualArea = da as CurvatureDualArea;
      }
      const prefix = msg.outputPrefix;
      if (typeof prefix === "string" && prefix.trim().length > 0) {
        if (!isValidFieldName(prefix.trim())) return undefined;
        rec.outputPrefix = prefix.trim();
      }
      return rec;
    }
    case "surfaceRemesh": {
      const rec: Extract<OpRecord, { op: "surfaceRemesh" }> = { op };
      if (msg.numClusters !== undefined && msg.numClusters !== "") {
        const v = Number(msg.numClusters);
        if (!Number.isFinite(v) || v < 4) return undefined;
        rec.numClusters = Math.floor(v);
      }
      const metric = msg.metric;
      if (metric !== undefined && metric !== "") {
        if (typeof metric !== "string" || !(SURFACE_REMESH_METRICS as readonly string[]).includes(metric)) return undefined;
        rec.metric = metric as SurfaceRemeshParams["metric"];
      }
      for (const k of ["gradation", "maxAnisotropy"] as const) {
        if (msg[k] === undefined || msg[k] === "") continue;
        const v = Number(msg[k]);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec[k] = v;
      }
      if (rec.maxAnisotropy !== undefined && (rec.metric ?? "isotropic") !== "anisotropic") return undefined;
      if (msg.preserveBoundary !== undefined) rec.preserveBoundary = Boolean(msg.preserveBoundary);
      return rec;
    }
    case "volumeMesh": {
      const rec: Extract<OpRecord, { op: "volumeMesh" }> = { op };
      if (msg.cellSize !== undefined && msg.cellSize !== "") {
        const v = Number(msg.cellSize);
        if (!Number.isFinite(v) || !(v > 0)) return undefined;
        rec.cellSize = v;
      }
      if (msg.resolution !== undefined && msg.resolution !== "") {
        const r = Array.isArray(msg.resolution) ? msg.resolution.map(Number) : String(msg.resolution).split(/[ ,x×]+/).filter(Boolean).map(Number);
        if (r.length !== 3 || !r.every((n) => Number.isInteger(n) && n >= 1)) return undefined;
        rec.resolution = [r[0], r[1], r[2]];
      }
      if ((rec.cellSize === undefined) === (rec.resolution === undefined)) return undefined;
      for (const k of ["paddingRelative", "warpFraction"] as const) {
        if (msg[k] === undefined || msg[k] === "") continue;
        const v = Number(msg[k]);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec[k] = v;
      }
      if (msg.maxTets !== undefined && msg.maxTets !== "") {
        const v = Number(msg.maxTets);
        if (!Number.isFinite(v) || v < 1) return undefined;
        rec.maxTets = Math.floor(v);
      }
      if (msg.keepSurface !== undefined) rec.keepSurface = Boolean(msg.keepSurface);
      return rec;
    }
    case "optimizeVolume": {
      const rec: Extract<OpRecord, { op: "optimizeVolume" }> = { op };
      if (msg.maxIterations !== undefined && msg.maxIterations !== "") {
        const v = Number(msg.maxIterations);
        if (!Number.isFinite(v) || v < 1) return undefined;
        rec.maxIterations = Math.floor(v);
      }
      if (msg.minImprovement !== undefined && msg.minImprovement !== "") {
        const v = Number(msg.minImprovement);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec.minImprovement = v;
      }
      for (const k of ["relocate", "flip", "preserveBoundary"] as const) if (msg[k] !== undefined) rec[k] = Boolean(msg[k]);
      return rec;
    }
    case "repairSurface": {
      const rec: Extract<OpRecord, { op: "repairSurface" }> = { op };
      for (const k of ["fixOrientation", "orientOutward", "fillHoles", "splitNonManifold"] as const) {
        if (msg[k] !== undefined) rec[k] = Boolean(msg[k]);
      }
      for (const k of ["maxHoleEdges", "weldTolerance"] as const) {
        if (msg[k] === undefined || msg[k] === "") continue;
        const v = Number(msg[k]);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec[k] = k === "maxHoleEdges" ? Math.floor(v) : v;
      }
      return rec;
    }
    case "smooth": {
      const rec: Extract<OpRecord, { op: "smooth" }> = { op };
      const method = msg.method;
      if (typeof method === "string") {
        if (!SMOOTH_METHODS.has(method as SmoothMethod)) return undefined;
        rec.method = method as SmoothMethod;
      }
      const iterations = num("iterations", 10);
      if (!(iterations > 0)) return undefined;
      rec.iterations = Math.floor(iterations);
      // lambda/mu are validated by meshio++ itself (it throws on an out-of-band
      // pair, with a message naming the constraint); only pass them when set so
      // an omitted value keeps the method's own default.
      for (const k of ["lambda", "mu", "featureAngle"] as const) {
        if (msg[k] !== undefined && msg[k] !== "") {
          const v = Number(msg[k]);
          if (!Number.isFinite(v)) return undefined;
          rec[k] = v;
        }
      }
      for (const k of ["fixBoundary", "preserveFeatures", "guardInversion"] as const) {
        if (msg[k] !== undefined) rec[k] = Boolean(msg[k]);
      }
      return rec;
    }
    case "reorder": {
      const method = msg.method;
      return typeof method === "string" && REORDER_METHODS.includes(method as ReorderMethod)
        ? { op, method: method as ReorderMethod }
        : undefined;
    }
    case "partition": {
      const nparts = num("nparts");
      if (!(nparts >= 1)) return undefined;
      const rec: Extract<OpRecord, { op: "partition" }> = { op, nparts: Math.floor(nparts) };
      const method = msg.method;
      if (typeof method === "string") {
        if (!PARTITION_METHODS.has(method as PartitionMethod)) return undefined;
        rec.method = method as PartitionMethod;
      }
      if (msg.createParts !== undefined) rec.createParts = Boolean(msg.createParts);
      return rec;
    }
    case "linearize":
      return { op };
    case "refine": {
      const levels = num("levels", 1);
      if (levels <= 0) return undefined;
      const raw = msg.select as Record<string, unknown> | undefined;
      if (!raw || typeof raw !== "object") return { op, levels: Math.floor(levels) };
      const by = String(raw.by ?? "");
      if (by === "part") {
        const path = String(raw.path ?? "").trim();
        return path ? { op, levels: Math.floor(levels), select: { by, path } } : undefined;
      }
      if (by === "ids") {
        const kind = String(raw.kind ?? "Elements");
        if (kind !== "Elements" && kind !== "Conditions" && kind !== "Geometries") return undefined;
        const ids = Array.isArray(raw.ids)
          ? raw.ids.map((x) => Number(x)).filter((x) => Number.isFinite(x))
          : [];
        return ids.length > 0
          ? { op, levels: Math.floor(levels), select: { by, kind, ids } }
          : undefined;
      }
      if (by === "field") {
        const compare = String(raw.compare ?? ">") as RefineCompare;
        if (!REFINE_COMPARES.includes(compare)) return undefined;
        const location = String(raw.location ?? "Elemental");
        if (location !== "Elemental" && location !== "Conditional" && location !== "Nodal") {
          return undefined;
        }
        const value = Number(raw.value ?? 0.5);
        if (!Number.isFinite(value)) return undefined;
        return {
          op,
          levels: Math.floor(levels),
          select: {
            by,
            variable: raw.variable ? String(raw.variable) : undefined,
            compare,
            value,
            location,
          },
        };
      }
      return undefined;
    }
    case "simplexify":
      return { op };
    case "crop": {
      const kind = msg.kind;
      const mode = msg.mode;
      if (mode !== undefined && !(typeof mode === "string" && CROP_MODES.has(mode))) return undefined;
      const modeVal = mode as "all" | "any" | undefined;
      const vec3 = (v: unknown): [number, number, number] | undefined =>
        Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)))
          ? (v.map(Number) as [number, number, number])
          : undefined;
      if (kind === "bbox") {
        const lo = vec3(msg.lo);
        const hi = vec3(msg.hi);
        return lo && hi ? { op, kind, lo, hi, mode: modeVal } : undefined;
      }
      if (kind === "plane") {
        const point = vec3(msg.point);
        const normal = vec3(msg.normal);
        return point && normal ? { op, kind, point, normal, mode: modeVal } : undefined;
      }
      return undefined;
    }
    case "fieldCalc": {
      const expr = msg.expr;
      const location = msg.location;
      const output = msg.output;
      return typeof expr === "string" &&
        expr.length > 0 &&
        typeof location === "string" &&
        FIELD_LOCATIONS.has(location) &&
        typeof output === "string" &&
        output.length > 0
        ? { op, expr, location: location as Extract<OpRecord, { op: "fieldCalc" }>["location"], output }
        : undefined;
    }
    case "fieldGradient": {
      const variable = msg.variable;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "fieldGradient" }> = { op, variable };
      const operator = msg.operator;
      if (operator !== undefined) {
        if (!GRADIENT_OPERATORS.includes(operator as GradientOperator)) return undefined;
        rec.operator = operator as GradientOperator;
      }
      const method = msg.method;
      if (method !== undefined) {
        if (!GRADIENT_METHODS.includes(method as GradientMethod)) return undefined;
        rec.method = method as GradientMethod;
      }
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) rec.output = output.trim();
      return rec;
    }
    case "fieldHessian": {
      const variable = msg.variable;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "fieldHessian" }> = { op, variable };
      const method = msg.method;
      if (method !== undefined) {
        if (!GRADIENT_METHODS.includes(method as GradientMethod)) return undefined;
        rec.method = method as GradientMethod;
      }
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) rec.output = output.trim();
      return rec;
    }
    case "estimateError": {
      const variable = msg.variable;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "estimateError" }> = { op, variable };
      const marking = msg.marking;
      if (marking !== undefined && marking !== "") {
        if (!ERROR_MARKINGS.includes(marking as ErrorMarking)) return undefined;
        rec.marking = marking as ErrorMarking;
      }
      // Only "fraction"/"dorfler" constrain the value to (0, 1]; "absolute" is
      // an indicator threshold, so any finite number is legitimate there. The
      // range check itself lives in estimateErrorModel, which owns the meaning.
      if (msg.markingValue !== undefined && msg.markingValue !== "") {
        const v = Number(msg.markingValue);
        if (!Number.isFinite(v)) return undefined;
        rec.markingValue = v;
      }
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) rec.output = output.trim();
      return rec;
    }
    case "sdfDistance": {
      const path = typeof msg.path === "string" ? msg.path.trim() : "";
      const part = typeof msg.part === "string" ? msg.part.trim() : "";
      const skin = msg.skin === true;
      // Mutually exclusive, like remesh's distanceSurfacePath/distanceSurfacePart/
      // distanceSurfaceSkin — the sidebar enforces this itself, so a message
      // naming more than one (or none) is malformed input.
      if ([path, part, skin].filter(Boolean).length !== 1) return undefined;
      const rec: Extract<OpRecord, { op: "sdfDistance" }> = path
        ? { op, path }
        : skin
          ? { op, skin: true }
          : { op, part };
      const sign = msg.sign;
      if (sign !== undefined && sign !== "") {
        if (!SDF_SIGNS.includes(sign as SdfSign)) return undefined;
        rec.sign = sign as SdfSign;
      }
      if (msg.band !== undefined && msg.band !== "") {
        const v = Number(msg.band);
        if (!Number.isFinite(v) || v < 0) return undefined;
        rec.band = v;
      }
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) rec.output = output.trim();
      return rec;
    }
    case "transferField": {
      const path = msg.path;
      if (typeof path !== "string" || path.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "transferField" }> = { op, path };
      const arrays = msg.arrays;
      if (arrays !== undefined) {
        // A comma-separated string is what the sidebar's text input produces;
        // an array is what a recipe carries. Both mean the same thing.
        const list =
          typeof arrays === "string"
            ? arrays.split(",")
            : Array.isArray(arrays)
              ? arrays
              : undefined;
        if (!list) return undefined;
        const names = list.map((x) => String(x).trim()).filter((x) => x.length > 0);
        if (names.length > 0) rec.arrays = names;
      }
      const onConflict = msg.onConflict;
      if (onConflict !== undefined && onConflict !== "") {
        if (!TRANSFER_CONFLICTS.includes(onConflict as TransferOnConflict)) return undefined;
        rec.onConflict = onConflict as TransferOnConflict;
      }
      return rec;
    }
    case "averageField": {
      const variable = msg.variable;
      const direction = msg.direction;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      if (typeof direction !== "string" || !AVERAGE_DIRECTIONS.has(direction)) return undefined;
      const rec: Extract<OpRecord, { op: "averageField" }> = {
        op,
        variable,
        direction: direction as AverageDirection,
      };
      const target = msg.target;
      if (target !== undefined) {
        if (typeof target !== "string" || !CELL_BLOCK_KINDS.has(target)) return undefined;
        rec.target = target as CellBlockKind;
      }
      const output = msg.output;
      if (typeof output === "string" && output.length > 0) rec.output = output;
      return rec;
    }
    case "renameField": {
      const kind = msg.kind;
      const variable = msg.variable;
      const newName = typeof msg.newName === "string" ? msg.newName.trim() : "";
      if (typeof kind !== "string" || !FIELD_LOCATIONS.has(kind)) return undefined;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      if (!isValidFieldName(newName)) return undefined;
      const rec: Extract<OpRecord, { op: "renameField" }> = { op, kind: kind as FieldBlockKind, variable, newName };
      const oc = msg.onConflict;
      if (oc !== undefined && oc !== "") {
        if (oc !== "error" && oc !== "overwrite") return undefined;
        rec.onConflict = oc;
      }
      return rec;
    }
    case "keepFields":
    case "dropFields": {
      const raw = msg.variables;
      const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : undefined;
      if (!list) return undefined;
      const variables = list.map((x) => String(x).trim()).filter((x) => x.length > 0);
      if (variables.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "keepFields" | "dropFields" }> = { op, variables };
      const kind = msg.kind;
      if (kind !== undefined && kind !== "") {
        if (typeof kind !== "string" || !FIELD_LOCATIONS.has(kind)) return undefined;
        rec.kind = kind as FieldBlockKind;
      }
      return rec;
    }
    case "markComponents": {
      const rec: Extract<OpRecord, { op: "markComponents" }> = { op };
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) {
        if (!isValidFieldName(output.trim())) return undefined;
        rec.output = output.trim();
      }
      if (msg.fragmentFraction !== undefined && msg.fragmentFraction !== "") {
        const v = Number(msg.fragmentFraction);
        if (!Number.isFinite(v) || v < 0 || v > 1) return undefined;
        rec.fragmentFraction = v;
      }
      return rec;
    }
    case "conditionField": {
      const kind = msg.kind;
      const variable = msg.variable;
      const mode = msg.mode;
      if (typeof kind !== "string" || !FIELD_LOCATIONS.has(kind)) return undefined;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      if (typeof mode !== "string" || !(CONDITION_MODES as readonly string[]).includes(mode)) return undefined;
      const rec: Extract<OpRecord, { op: "conditionField" }> = {
        op,
        kind: kind as FieldBlockKind,
        variable,
        mode: mode as ConditionFieldParams["mode"],
      };
      for (const key of ["lo", "hi", "nanReplacement"] as const) {
        const v = msg[key];
        if (v === undefined || v === "") continue;
        const n = Number(v);
        if (!Number.isFinite(n)) return undefined;
        rec[key] = n;
      }
      if (rec.mode === "clamp" && rec.lo !== undefined && rec.hi !== undefined && rec.lo > rec.hi) return undefined;
      if (rec.mode === "normalize" && (rec.lo ?? 0) >= (rec.hi ?? 1)) return undefined;
      const scope = msg.scope;
      if (scope !== undefined && scope !== "") {
        if (typeof scope !== "string" || !(CONDITION_SCOPES as readonly string[]).includes(scope)) return undefined;
        rec.scope = scope as ConditionFieldParams["scope"];
      }
      const nan = msg.nanPolicy;
      if (nan !== undefined && nan !== "") {
        if (typeof nan !== "string" || !(NAN_POLICIES as readonly string[]).includes(nan)) return undefined;
        rec.nanPolicy = nan as ConditionFieldParams["nanPolicy"];
      }
      const output = msg.output;
      if (typeof output === "string" && output.trim().length > 0) {
        if (!isValidFieldName(output.trim())) return undefined;
        rec.output = output.trim();
      }
      return rec;
    }
    case "reduceField": {
      const variable = msg.variable;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      const kind =
        typeof msg.kind === "string" && FIELD_LOCATIONS.has(msg.kind)
          ? (msg.kind as FieldBlockKind)
          : "Nodal";
      const reduction = msg.reduction;
      if (typeof reduction !== "string" || !(GLOBAL_REDUCTIONS as readonly string[]).includes(reduction)) {
        return undefined;
      }
      const output =
        typeof msg.output === "string" && msg.output.trim().length > 0
          ? msg.output.trim()
          : defaultGlobalName(variable, reduction as GlobalReduction);
      return { op, variable, kind, reduction: reduction as GlobalReduction, output };
    }
    case "renumber": {
      const rec: Extract<OpRecord, { op: "renumber" }> = { op };
      const target = msg.target;
      if (target !== undefined) {
        if (typeof target !== "string" || !RENUMBER_TARGETS.has(target as RenumberTarget)) {
          return undefined;
        }
        rec.target = target as RenumberTarget;
      }
      if (msg.start !== undefined) {
        const s = num("start");
        if (!Number.isInteger(s) || s < 1) return undefined;
        rec.start = s;
      }
      return rec;
    }
    case "mergeMesh": {
      // `paths` is today's shape; a lone `path` is the pre-N-ary spelling.
      const raw = Array.isArray(msg.paths) ? msg.paths : msg.path !== undefined ? [msg.path] : [];
      const paths = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length === 0 || paths.length !== raw.length) return undefined;
      const rec: Extract<OpRecord, { op: "mergeMesh" }> = { op, paths };
      if (msg.weld !== undefined) rec.weld = Boolean(msg.weld);
      if (msg.tolerance !== undefined) {
        const t = num("tolerance");
        if (!(t > 0)) return undefined;
        rec.tolerance = t;
      }
      if (typeof msg.name === "string" && msg.name.length > 0) rec.name = msg.name;
      return rec;
    }
    case "remesh": {
      const mode = typeof msg.mode === "string" && REMESH_MODES.has(msg.mode) ? msg.mode : "factor";
      const rec: Extract<OpRecord, { op: "remesh" }> = {
        op,
        mode: mode as "factor" | "hsiz" | "optimize" | "expr" | "aniso",
      };
      const distanceSurfacePath =
        typeof msg.distanceSurfacePath === "string" ? msg.distanceSurfacePath.trim() : "";
      const distanceSurfacePart =
        typeof msg.distanceSurfacePart === "string" ? msg.distanceSurfacePart.trim() : "";
      // Mutually exclusive — the sidebar enforces this itself (picking one
      // clears the other), so a message naming both is malformed input.
      const distanceSurfaceSkin = msg.distanceSurfaceSkin === true;
      if ([distanceSurfacePath, distanceSurfacePart, distanceSurfaceSkin].filter(Boolean).length > 1) {
        return undefined;
      }
      if (distanceSurfacePath) rec.distanceSurfacePath = distanceSurfacePath;
      if (distanceSurfacePart) rec.distanceSurfacePart = distanceSurfacePart;
      if (distanceSurfaceSkin) rec.distanceSurfaceSkin = true;
      // `model` (when the caller has one — see this function's own doc
      // comment) widens the sizing formula's scope with the mesh's own
      // existing Nodal field names, so a variable computed via the Variables
      // panel (or fieldCalc/sdfDistance directly) is usable here too.
      const fieldVars = model
        ? fieldScopeVariables(
            model.fields.filter((f) => f.kind === "Nodal"),
            false
          )
        : [];
      const globalVars = model ? Object.keys(model.globals ?? {}).map((n) => n.toLowerCase()) : [];
      const allowedVars = remeshSizeExprVars(
        Boolean(distanceSurfacePath || distanceSurfacePart || distanceSurfaceSkin),
        fieldVars,
        globalVars
      );
      if (mode === "factor") {
        const factor = num("factor", 1);
        if (!(factor > 0)) return undefined;
        rec.factor = factor;
      } else if (mode === "hsiz") {
        const hsiz = num("hsiz");
        if (!(hsiz > 0)) return undefined;
        rec.hsiz = hsiz;
      } else if (mode === "expr") {
        const sizeExpr = typeof msg.sizeExpr === "string" ? msg.sizeExpr.trim() : "";
        if (!sizeExpr || validateSizeExpr(sizeExpr, allowedVars) !== undefined) return undefined;
        rec.sizeExpr = sizeExpr;
        const parts = parseSizeParts(msg.sizeParts, allowedVars);
        if (parts.length) rec.sizeParts = parts;
      } else if (mode === "aniso") {
        const variable = typeof msg.variable === "string" ? msg.variable.trim() : "";
        if (!variable) return undefined;
        rec.variable = variable;
        if (msg.method !== undefined && msg.method !== "") {
          if (!GRADIENT_METHODS.includes(msg.method as GradientMethod)) return undefined;
          rec.method = msg.method as GradientMethod;
        }
      }
      const frozen = parseFrozen(msg.frozen);
      if (frozen) rec.frozen = frozen;
      else if (msg.frozen !== undefined) return undefined;
      const localSizes = parseLocalSizes(msg.localSizes);
      if (localSizes) rec.localSizes = localSizes;
      else if (msg.localSizes !== undefined) return undefined;
      copyMmgTuning(msg, rec);
      const angle = Number(msg.angleDetection);
      if (Number.isFinite(angle)) rec.angleDetection = angle;
      for (const k of ["nosurf", "noinsert", "noswap", "nomove"] as const) {
        if (msg[k]) rec[k] = true;
      }
      return rec;
    }
    case "levelset": {
      const variable = msg.variable;
      if (typeof variable !== "string" || variable.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "levelset" }> = { op, variable };
      const isovalue = Number(msg.isovalue);
      if (Number.isFinite(isovalue) && isovalue !== 0) rec.isovalue = isovalue;
      if (msg.isosurf) rec.isosurf = true;
      // MMG accepts any rmc without complaint and a value above a real domain's
      // volume fraction silently deletes that domain, so the range is checked here.
      if (msg.rmc !== undefined && msg.rmc !== "") {
        const rmc = Number(msg.rmc);
        if (!(Number.isFinite(rmc) && rmc > 0 && rmc < 1)) return undefined;
        rec.rmc = rmc;
      }
      if (msg.keepMaterials) rec.keepMaterials = true;
      const noSplit = parseFrozen(msg.noSplit);
      if (noSplit) {
        if (noSplit.length > 0) {
          rec.noSplit = noSplit;
          rec.keepMaterials = true; // no-split is only meaningful with a material map
        }
      } else if (msg.noSplit !== undefined) return undefined;
      const baseRefs = parseFrozen(msg.baseRefs);
      if (baseRefs) {
        if (baseRefs.length > 0) rec.baseRefs = baseRefs;
      } else if (msg.baseRefs !== undefined) return undefined;
      copyMmgTuning(msg, rec);
      return rec;
    }
    default:
      return undefined;
  }
}

/**
 * Validates a raw `frozen` value into `{kind, target}[]`. Rows with an unknown
 * kind or an empty target are dropped (the `parseSizeParts` convention);
 * a non-array value is invalid.
 */
function parseFrozen(raw: unknown): FrozenSelector[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: FrozenSelector[] = [];
  for (const entry of raw) {
    const e = entry as { kind?: unknown; target?: unknown };
    const kind = typeof e?.kind === "string" ? e.kind : "";
    const target = typeof e?.target === "string" ? e.target.trim() : "";
    if (target && FROZEN_KINDS.has(kind)) {
      out.push({ kind: kind as FrozenSelector["kind"], target });
    }
  }
  return out;
}

/**
 * Validates a raw `localSizes` value. Every row needs a known kind, a
 * non-empty target and all three positive bounds (a missing bound has no MMG
 * "unset" spelling worth guessing at).
 */
function parseLocalSizes(raw: unknown): LocalSizeOverride[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: LocalSizeOverride[] = [];
  for (const entry of raw) {
    const e = entry as { kind?: unknown; target?: unknown; hmin?: unknown; hmax?: unknown; hausd?: unknown };
    const kind = typeof e?.kind === "string" ? e.kind : "";
    const target = typeof e?.target === "string" ? e.target.trim() : "";
    const hmin = Number(e?.hmin);
    const hmax = Number(e?.hmax);
    const hausd = Number(e?.hausd);
    if (!target || !FROZEN_KINDS.has(kind)) return undefined;
    if (!(hmin > 0 && hmax > 0 && hausd > 0)) return undefined;
    out.push({ kind: kind as LocalSizeOverride["kind"], target, hmin, hmax, hausd });
  }
  return out;
}

/**
 * Validates a raw `sizeParts` value into `{path, expr}[]`, keeping only entries
 * with a non-empty path and a parseable expression (invalid rows are dropped).
 * `allowedVars` mirrors whatever the global expression was validated against
 * (see `remeshSizeExprVars`), so a `d` override is only accepted alongside a
 * distance surface.
 */
function parseSizeParts(
  raw: unknown,
  allowedVars: readonly string[] = SIZE_EXPR_VARIABLES
): { path: string; expr: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { path: string; expr: string }[] = [];
  for (const entry of raw) {
    const e = entry as { path?: unknown; expr?: unknown };
    const path = typeof e?.path === "string" ? e.path.trim() : "";
    const expr = typeof e?.expr === "string" ? e.expr.trim() : "";
    if (path && expr && validateSizeExpr(expr, allowedVars) === undefined) out.push({ path, expr });
  }
  return out;
}

/** Copies the optional positive MMG tuning params (hmin/hmax/hausd/hgrad/module). */
function copyMmgTuning(
  msg: Record<string, unknown>,
  rec: { hmin?: number; hmax?: number; hausd?: number; hgrad?: number; module?: "auto" | "mmg3d" | "mmgs" | "mmg2d" }
): void {
  for (const k of ["hmin", "hmax", "hausd", "hgrad"] as const) {
    const v = Number(msg[k]);
    if (Number.isFinite(v) && v > 0) rec[k] = v;
  }
  if (typeof msg.module === "string" && MMG_MODULES.has(msg.module) && msg.module !== "auto") {
    rec.module = msg.module as "mmg3d" | "mmgs" | "mmg2d";
  }
}

/** Serializes an op list to a JSON recipe string. */
export function serializeOps(ops: OpRecord[], source: string): string {
  return JSON.stringify({ version: RECIPE_VERSION, source, operations: ops }, null, 2);
}

/** Parses a JSON recipe, keeping only well-formed known ops; collects warnings. */
export function parseOpsJson(text: string): { operations: OpRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { operations: [], warnings: ["File is not valid JSON."] };
  }
  const obj = raw as { operations?: unknown };
  if (!obj || !Array.isArray(obj.operations)) {
    return { operations: [], warnings: ["No \"operations\" array in the recipe."] };
  }
  const operations: OpRecord[] = [];
  for (const entry of obj.operations) {
    const rec = entry as { op?: unknown };
    const name = rec?.op;
    if (typeof name !== "string" || !KNOWN_OPS.has(name as OpName)) {
      warnings.push(`Skipped unknown operation "${String(name)}".`);
      continue;
    }
    if (!validateParams(rec as OpRecord, warnings)) continue;
    operations.push(normalizeRecord(rec as OpRecord));
  }
  return { operations, warnings };
}

/**
 * Recipe tolerance: rewrites a legacy/shorthand record into today's canonical
 * shape. Deliberately NOT `opRecordFromMessage`, which would also apply every
 * op's defaults and so silently rewrite records that were already fine (a
 * `rotate` with no centre would gain an explicit `cx/cy/cz` of 0).
 */
function normalizeRecord(rec: OpRecord): OpRecord {
  if (rec.op === "mergeMesh" && !(rec.paths && rec.paths.length > 0) && rec.path) {
    const { path: legacy, ...rest } = rec;
    return { ...rest, paths: [legacy] };
  }
  return rec;
}

/** Verifies an op record carries the params its type requires. */
function validateParams(rec: OpRecord, warnings: string[]): boolean {
  const bad = (why: string): boolean => {
    warnings.push(`Skipped "${rec.op}": ${why}.`);
    return false;
  };
  const nums = (keys: string[]): boolean =>
    keys.every((k) => typeof (rec as unknown as Record<string, unknown>)[k] === "number");
  switch (rec.op) {
    case "mergeNodes":
      return typeof rec.tolerance === "number" && rec.tolerance > 0
        ? true
        : bad("missing/invalid tolerance");
    case "scale":
      return nums(["sx", "sy", "sz"]) ? true : bad("missing/invalid scale factors");
    case "translate":
      return nums(["dx", "dy", "dz"]) ? true : bad("missing/invalid translation");
    case "rotate": {
      const centerOk = (["cx", "cy", "cz"] as const).every(
        (k) => rec[k] === undefined || typeof rec[k] === "number"
      );
      return (rec.axis === "x" || rec.axis === "y" || rec.axis === "z") &&
        typeof rec.angle === "number" &&
        centerOk
        ? true
        : bad("missing/invalid axis/angle/center");
    }
    case "deleteSubModelPart":
      return typeof rec.path === "string" && rec.path.length > 0
        ? true
        : bad("missing path");
    case "renameSubModelPart":
      return typeof rec.path === "string" && rec.path.length > 0 &&
        typeof rec.newName === "string" && rec.newName.length > 0
        ? true
        : bad("missing path/newName");
    case "createSubModelPart":
      // An empty parentPath is the top level, so only the NAME must be non-empty.
      return typeof rec.parentPath === "string" &&
        typeof rec.name === "string" && rec.name.trim().length > 0
        ? true
        : bad("missing parentPath/name");
    case "moveSubModelPart":
      return typeof rec.path === "string" && rec.path.length > 0 &&
        typeof rec.newParentPath === "string"
        ? true
        : bad("missing path/newParentPath");
    case "mergeSubModelParts":
      return typeof rec.sourcePath === "string" && rec.sourcePath.length > 0 &&
        typeof rec.targetPath === "string" && rec.targetPath.length > 0
        ? true
        : bad("missing sourcePath/targetPath");
    case "addSubModelPartEntities":
    case "removeSubModelPartEntities": {
      if (typeof rec.path !== "string" || rec.path.length === 0) return bad("missing path");
      if (!SMP_ENTITY_KINDS.includes(rec.kind)) return bad("invalid kind");
      return Array.isArray(rec.ids) &&
        rec.ids.length > 0 &&
        rec.ids.every((v) => typeof v === "number" && Number.isFinite(v))
        ? true
        : bad("missing/invalid ids");
    }
    case "writeMeshSizeFields":
      return MESH_SIZE_TARGETS.has(rec.target) ? true : bad("missing/invalid target");
    case "setElementRadius": {
      if (!(typeof rec.value === "number" && rec.value > 0)) return bad("missing/invalid value");
      if (!RADIUS_MODES.has(rec.mode)) return bad("missing/invalid mode");
      return rec.target === undefined || typeof rec.target === "string"
        ? true
        : bad("invalid target");
    }
    case "setProperty": {
      if (!Number.isInteger(rec.propertyId) || rec.propertyId <= 0) return bad("missing/invalid propertyId");
      if (typeof rec.name !== "string" || !rec.name || /\s/.test(rec.name)) return bad("missing/invalid name");
      return isPropertyValueShape(rec.value) ? true : bad("missing/invalid property value");
    }
    case "createProperty": {
      if (rec.id !== undefined && !(Number.isInteger(rec.id) && rec.id > 0)) return bad("invalid id");
      if (rec.name !== undefined) {
        if (typeof rec.name !== "string" || !rec.name || /\s/.test(rec.name)) return bad("invalid name");
        if (rec.value === undefined) return bad("a named variable needs its value");
      }
      if (rec.value !== undefined && rec.name === undefined) return bad("a value needs its variable name");
      return isPropertyValueShape(rec.value) ? true : bad("missing/invalid property value");
    }
    case "cloneProperty": {
      if (!Number.isInteger(rec.propertyId) || rec.propertyId <= 0) return bad("missing/invalid propertyId");
      return rec.newId === undefined || (Number.isInteger(rec.newId) && rec.newId > 0) ? true : bad("invalid newId");
    }
    case "deleteProperty":
      return Number.isInteger(rec.propertyId) && rec.propertyId > 0 ? true : bad("missing/invalid propertyId");
    case "assignProperty": {
      if (!Number.isInteger(rec.propertyId) || rec.propertyId <= 0) return bad("missing/invalid propertyId");
      if (typeof rec.part === "string" && rec.part.length > 0) return true;
      if (ENTITY_KINDS.includes(rec.kind as EntityKind)) {
        if (!Array.isArray(rec.ids) || rec.ids.some((v) => !Number.isFinite(v))) return bad("missing/invalid ids");
        return true;
      }
      return bad("exactly one of part or kind+ids is required");
    }
    case "createSubModelPartFromSelection": {
      if (typeof rec.parentPath !== "string") return bad("missing parentPath");
      if (typeof rec.name !== "string" || !rec.name) return bad("missing name");
      const seedOK =
        rec.seed === undefined ||
        (rec.seed.kind === "explicit" ||
          (rec.seed.kind === "part" && rec.seed.path.length > 0) ||
          (rec.seed.kind === "field" && rec.seed.variable.length > 0 && Number.isFinite(rec.seed.lo) && Number.isFinite(rec.seed.hi) && FIELD_LOCATIONS.has(rec.seed.blockKind)) ||
          (rec.seed.kind === "quality" && rec.seed.metric.length > 0) ||
          (rec.seed.kind === "property" && Number.isInteger(rec.seed.propertyId) && rec.seed.propertyId > 0));
      if (!seedOK) return bad("invalid seed");
      const hasSeed = rec.seed !== undefined;
      const pickCount =
        (Array.isArray(rec.elements) ? rec.elements.length : 0) +
        (Array.isArray(rec.conditions) ? rec.conditions.length : 0) +
        (Array.isArray(rec.geometries) ? rec.geometries.length : 0);
      if (hasSeed && pickCount > 0) return bad("a seed and explicit id lists are mutually exclusive");
      if (!hasSeed && pickCount === 0) return bad("no selection given (id lists or a seed)");
      return true;
    }
    case "deleteEntities": {
      const count =
        (Array.isArray(rec.elements) ? rec.elements.length : 0) +
        (Array.isArray(rec.conditions) ? rec.conditions.length : 0) +
        (Array.isArray(rec.geometries) ? rec.geometries.length : 0);
      if (count === 0) return bad("no entity ids given");
      for (const list of [rec.elements, rec.conditions, rec.geometries] as (number[] | undefined)[]) {
        if (list && list.some((v) => !Number.isFinite(v))) return bad("missing/invalid ids");
      }
      return true;
    }
    case "shrinkwrap": {
      if ([rec.path, rec.part, rec.skin].filter(Boolean).length !== 1) return bad("exactly one of path/part/skin is required");
      for (const k of ["offset", "blend"] as const) {
        if (rec[k] !== undefined && !Number.isFinite(rec[k])) return bad(`invalid ${k}`);
      }
      if (rec.maxDistance !== undefined && !(Number.isFinite(rec.maxDistance) && rec.maxDistance >= 0)) return bad("invalid maxDistance");
      if (rec.normalWeight !== undefined && rec.normalWeight !== "angle" && rec.normalWeight !== "area") return bad("invalid normalWeight");
      return true;
    }
    case "compareField": {
      if (typeof rec.path !== "string" || rec.path.length === 0) return bad("missing path");
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (!FIELD_LOCATIONS.has(rec.kind)) return bad("missing/invalid kind");
      if (rec.correspondence !== undefined && !(CORRESPONDENCES as readonly string[]).includes(rec.correspondence)) {
        return bad("invalid correspondence");
      }
      if (rec.output !== undefined && (typeof rec.output !== "string" || !isValidFieldName(rec.output))) return bad("invalid output");
      for (const k of ["atol", "rtol"] as const) {
        if (rec[k] !== undefined && !(Number.isFinite(rec[k]) && (rec[k] as number) >= 0)) return bad(`invalid ${k}`);
      }
      return true;
    }
    case "sobolevDeform": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (!(typeof rec.lengthScale === "number" && Number.isFinite(rec.lengthScale) && rec.lengthScale >= 0)) {
        return bad("missing/invalid lengthScale");
      }
      if (rec.maxIterations !== undefined && !(Number.isFinite(rec.maxIterations) && rec.maxIterations >= 1)) return bad("invalid maxIterations");
      if (rec.tolerance !== undefined && !(Number.isFinite(rec.tolerance) && rec.tolerance > 0)) return bad("invalid tolerance");
      return true;
    }
    case "curvature": {
      if (rec.dualArea !== undefined && !(CURVATURE_DUAL_AREAS as readonly string[]).includes(rec.dualArea)) {
        return bad("invalid dualArea");
      }
      if (rec.outputPrefix !== undefined && (typeof rec.outputPrefix !== "string" || !isValidFieldName(rec.outputPrefix))) {
        return bad("invalid outputPrefix");
      }
      return true;
    }
    case "surfaceRemesh": {
      if (rec.numClusters !== undefined && !(Number.isFinite(rec.numClusters) && rec.numClusters >= 4)) return bad("invalid numClusters");
      if (rec.metric !== undefined && !(SURFACE_REMESH_METRICS as readonly string[]).includes(rec.metric)) return bad("invalid metric");
      for (const k of ["gradation", "maxAnisotropy"] as const) if (rec[k] !== undefined && !(Number.isFinite(rec[k]) && (rec[k] as number) >= 0)) return bad(`invalid ${k}`);
      if (rec.maxAnisotropy !== undefined && (rec.metric ?? "isotropic") !== "anisotropic") return bad("maxAnisotropy needs metric anisotropic");
      return true;
    }
    case "volumeMesh": {
      if ((rec.cellSize === undefined) === (rec.resolution === undefined)) return bad("give exactly one of cellSize / resolution");
      if (rec.cellSize !== undefined && !(Number.isFinite(rec.cellSize) && rec.cellSize > 0)) return bad("invalid cellSize");
      if (rec.resolution !== undefined && !(Array.isArray(rec.resolution) && rec.resolution.length === 3 && rec.resolution.every((n) => Number.isInteger(n) && n >= 1))) return bad("invalid resolution");
      for (const k of ["paddingRelative", "warpFraction"] as const) if (rec[k] !== undefined && !(Number.isFinite(rec[k]) && (rec[k] as number) >= 0)) return bad(`invalid ${k}`);
      if (rec.maxTets !== undefined && !(Number.isFinite(rec.maxTets) && rec.maxTets >= 1)) return bad("invalid maxTets");
      return true;
    }
    case "optimizeVolume": {
      if (rec.maxIterations !== undefined && !(Number.isFinite(rec.maxIterations) && rec.maxIterations >= 1)) return bad("invalid maxIterations");
      if (rec.minImprovement !== undefined && !(Number.isFinite(rec.minImprovement) && rec.minImprovement >= 0)) return bad("invalid minImprovement");
      return true;
    }
    case "repairSurface": {
      for (const k of ["maxHoleEdges", "weldTolerance"] as const) {
        if (rec[k] !== undefined && !(typeof rec[k] === "number" && Number.isFinite(rec[k]) && (rec[k] as number) >= 0)) {
          return bad(`invalid ${k}`);
        }
      }
      return true;
    }
    case "smooth": {
      if (rec.method !== undefined && !SMOOTH_METHODS.has(rec.method)) {
        return bad("invalid method");
      }
      if (rec.iterations !== undefined && !(typeof rec.iterations === "number" && rec.iterations > 0)) {
        return bad("invalid iterations");
      }
      return true;
    }
    case "reorder":
      return REORDER_METHODS.includes(rec.method) ? true : bad("missing/invalid method");
    case "partition": {
      if (!(typeof rec.nparts === "number" && rec.nparts >= 1)) return bad("missing/invalid nparts");
      return rec.method === undefined || PARTITION_METHODS.has(rec.method)
        ? true
        : bad("invalid method");
    }
    case "linearize":
    case "simplexify":
      return true;
    case "refine": {
      if (rec.levels !== undefined && !(typeof rec.levels === "number" && rec.levels > 0)) {
        return bad("invalid levels");
      }
      const sel = rec.select;
      if (sel === undefined) return true;
      if (sel.by === "part") return sel.path ? true : bad("refine: select.path is required");
      if (sel.by === "ids") {
        return Array.isArray(sel.ids) && sel.ids.length > 0
          ? true
          : bad("refine: select.ids is required");
      }
      if (sel.by === "field") {
        return sel.compare === undefined || REFINE_COMPARES.includes(sel.compare)
          ? true
          : bad("refine: invalid select.compare");
      }
      return bad("refine: unknown select.by");
    }
    case "crop": {
      const vec3ok = (v: unknown): boolean => Array.isArray(v) && v.length === 3;
      if (rec.mode !== undefined && !CROP_MODES.has(rec.mode)) return bad("invalid mode");
      if (rec.kind === "bbox") return vec3ok(rec.lo) && vec3ok(rec.hi) ? true : bad("invalid lo/hi");
      if (rec.kind === "plane") {
        return vec3ok(rec.point) && vec3ok(rec.normal) ? true : bad("invalid point/normal");
      }
      return bad("invalid kind");
    }
    case "fieldCalc":
      return typeof rec.expr === "string" &&
        rec.expr.length > 0 &&
        FIELD_LOCATIONS.has(rec.location) &&
        typeof rec.output === "string" &&
        rec.output.length > 0
        ? true
        : bad("missing/invalid expr/location/output");
    case "averageField": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (!AVERAGE_DIRECTIONS.has(rec.direction)) return bad("missing/invalid direction");
      if (rec.target !== undefined && !CELL_BLOCK_KINDS.has(rec.target)) return bad("invalid target");
      return true;
    }
    case "renameField": {
      if (!FIELD_LOCATIONS.has(rec.kind)) return bad("missing/invalid kind");
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (typeof rec.newName !== "string" || !isValidFieldName(rec.newName)) return bad("missing/invalid newName");
      if (rec.onConflict !== undefined && rec.onConflict !== "error" && rec.onConflict !== "overwrite") {
        return bad("invalid onConflict");
      }
      return true;
    }
    case "keepFields":
    case "dropFields": {
      if (!Array.isArray(rec.variables) || rec.variables.length === 0 || rec.variables.some((v) => typeof v !== "string" || v.length === 0)) {
        return bad("missing/invalid variables");
      }
      if (rec.kind !== undefined && !FIELD_LOCATIONS.has(rec.kind)) return bad("invalid kind");
      return true;
    }
    case "markComponents": {
      if (rec.output !== undefined && (typeof rec.output !== "string" || !isValidFieldName(rec.output))) return bad("invalid output");
      if (rec.fragmentFraction !== undefined && !(Number.isFinite(rec.fragmentFraction) && rec.fragmentFraction >= 0 && rec.fragmentFraction <= 1)) {
        return bad("invalid fragmentFraction");
      }
      return true;
    }
    case "conditionField": {
      if (!FIELD_LOCATIONS.has(rec.kind)) return bad("missing/invalid kind");
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (!(CONDITION_MODES as readonly string[]).includes(rec.mode)) return bad("missing/invalid mode");
      for (const key of ["lo", "hi", "nanReplacement"] as const) {
        if (rec[key] !== undefined && !Number.isFinite(rec[key])) return bad(`invalid ${key}`);
      }
      if (rec.mode === "clamp" && (rec.lo ?? 0) > (rec.hi ?? 1)) return bad("lo must not exceed hi");
      if (rec.mode === "normalize" && (rec.lo ?? 0) >= (rec.hi ?? 1)) return bad("lo must be below hi");
      if (rec.scope !== undefined && !(CONDITION_SCOPES as readonly string[]).includes(rec.scope)) return bad("invalid scope");
      if (rec.nanPolicy !== undefined && !(NAN_POLICIES as readonly string[]).includes(rec.nanPolicy)) return bad("invalid nanPolicy");
      if (rec.output !== undefined && (typeof rec.output !== "string" || !isValidFieldName(rec.output))) return bad("invalid output");
      return true;
    }
    case "reduceField": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (!FIELD_LOCATIONS.has(rec.kind)) return bad("missing/invalid kind");
      if (!(GLOBAL_REDUCTIONS as readonly string[]).includes(rec.reduction)) {
        return bad("missing/invalid reduction");
      }
      return typeof rec.output === "string" && rec.output.length > 0 ? true : bad("missing output");
    }
    case "fieldGradient": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (rec.operator !== undefined && !GRADIENT_OPERATORS.includes(rec.operator)) {
        return bad("invalid operator");
      }
      if (rec.method !== undefined && !GRADIENT_METHODS.includes(rec.method)) {
        return bad("invalid method");
      }
      if (rec.output !== undefined && (typeof rec.output !== "string" || rec.output.length === 0)) {
        return bad("invalid output");
      }
      return true;
    }
    case "fieldHessian": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (rec.method !== undefined && !GRADIENT_METHODS.includes(rec.method)) {
        return bad("invalid method");
      }
      if (rec.output !== undefined && (typeof rec.output !== "string" || rec.output.length === 0)) {
        return bad("invalid output");
      }
      return true;
    }
    case "estimateError": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) return bad("missing variable");
      if (rec.marking !== undefined && !ERROR_MARKINGS.includes(rec.marking)) {
        return bad("invalid marking");
      }
      if (rec.markingValue !== undefined && !Number.isFinite(rec.markingValue)) {
        return bad("invalid markingValue");
      }
      if (rec.output !== undefined && (typeof rec.output !== "string" || rec.output.length === 0)) {
        return bad("invalid output");
      }
      return true;
    }
    case "sdfDistance": {
      const hasPath = typeof rec.path === "string" && rec.path.length > 0;
      const hasPart = typeof rec.part === "string" && rec.part.length > 0;
      const hasSkin = rec.skin === true;
      if (rec.skin !== undefined && typeof rec.skin !== "boolean") return bad("invalid skin");
      if (!hasPath && !hasPart && !hasSkin) return bad("missing path, part or skin");
      if ([hasPath, hasPart, hasSkin].filter(Boolean).length > 1) {
        return bad("path, part and skin are mutually exclusive");
      }
      if (rec.sign !== undefined && !SDF_SIGNS.includes(rec.sign)) return bad("invalid sign");
      if (rec.band !== undefined && !(typeof rec.band === "number" && rec.band >= 0)) {
        return bad("invalid band");
      }
      if (rec.output !== undefined && (typeof rec.output !== "string" || rec.output.length === 0)) {
        return bad("invalid output");
      }
      return true;
    }
    case "transferField": {
      if (typeof rec.path !== "string" || rec.path.length === 0) return bad("missing path");
      if (
        rec.arrays !== undefined &&
        !(Array.isArray(rec.arrays) && rec.arrays.every((x: unknown) => typeof x === "string"))
      ) {
        return bad("invalid arrays");
      }
      return rec.onConflict === undefined || TRANSFER_CONFLICTS.includes(rec.onConflict)
        ? true
        : bad("invalid onConflict");
    }
    case "renumber": {
      if (rec.target !== undefined && !RENUMBER_TARGETS.has(rec.target)) return bad("invalid target");
      return rec.start === undefined || (Number.isInteger(rec.start) && rec.start >= 1)
        ? true
        : bad("invalid start");
    }
    case "mergeMesh": {
      if (Array.isArray(rec.paths)) {
        return rec.paths.length > 0 && rec.paths.every((p) => typeof p === "string" && p.length > 0)
          ? true
          : bad("missing/invalid paths");
      }
      // A recipe written before mergeMesh became N-ary; normalizeRecord folds it.
      return typeof rec.path === "string" && rec.path.length > 0 ? true : bad("missing paths");
    }
    case "remesh": {
      if (!REMESH_MODES.has(rec.mode)) return bad("missing/invalid mode");
      if (
        rec.distanceSurfacePath !== undefined &&
        !(typeof rec.distanceSurfacePath === "string" && rec.distanceSurfacePath.length > 0)
      ) {
        return bad("invalid distanceSurfacePath");
      }
      if (
        rec.distanceSurfacePart !== undefined &&
        !(typeof rec.distanceSurfacePart === "string" && rec.distanceSurfacePart.length > 0)
      ) {
        return bad("invalid distanceSurfacePart");
      }
      if (rec.distanceSurfaceSkin !== undefined && typeof rec.distanceSurfaceSkin !== "boolean") {
        return bad("invalid distanceSurfaceSkin");
      }
      const distanceSources = [
        rec.distanceSurfacePath,
        rec.distanceSurfacePart,
        rec.distanceSurfaceSkin,
      ].filter(Boolean).length;
      if (distanceSources > 1) {
        return bad("distanceSurfacePath, distanceSurfacePart and distanceSurfaceSkin are mutually exclusive");
      }
      const hasDistance = distanceSources > 0;
      if (rec.mode === "factor" && !(typeof rec.factor === "number" && rec.factor > 0)) {
        return bad("missing/invalid factor");
      }
      if (rec.mode === "hsiz" && !(typeof rec.hsiz === "number" && rec.hsiz > 0)) {
        return bad("missing/invalid hsiz");
      }
      if (rec.mode === "expr") {
        // Lenient, not the strict SIZE_EXPR_VARIABLES-only check: a recipe is
        // model-free by design (it may replay against a different mesh than
        // the one it was authored on), so a formula referencing a real Nodal
        // field name it cannot see here must not be rejected outright — only
        // `d` (fully derivable from the record itself) is still gated. Full
        // "unknown name" resolution happens at replay time, in expressionSizes.
        if (
          typeof rec.sizeExpr !== "string" ||
          validateSizeExprLenient(rec.sizeExpr, hasDistance) !== undefined
        ) {
          return bad("missing/invalid sizeExpr");
        }
        if (rec.sizeParts !== undefined) {
          const partsOk =
            Array.isArray(rec.sizeParts) &&
            rec.sizeParts.every(
              (p) =>
                typeof p?.path === "string" &&
                p.path.length > 0 &&
                typeof p?.expr === "string" &&
                validateSizeExprLenient(p.expr, hasDistance) === undefined
            );
          if (!partsOk) return bad("invalid sizeParts");
        }
      }
      if (rec.mode === "aniso") {
        if (typeof rec.variable !== "string" || rec.variable.length === 0) {
          return bad("missing/invalid variable");
        }
        if (rec.method !== undefined && !GRADIENT_METHODS.includes(rec.method)) {
          return bad("invalid method");
        }
      }
      if (rec.frozen !== undefined) {
        if (!Array.isArray(rec.frozen) || !rec.frozen.every((f) => selectorOk(f))) {
          return bad("invalid frozen");
        }
      }
      if (rec.localSizes !== undefined) {
        const localsOk =
          Array.isArray(rec.localSizes) &&
          rec.localSizes.every(
            (o) =>
              typeof o?.target === "string" &&
              o.target.length > 0 &&
              (o?.kind === "block" || o?.kind === "part") &&
              typeof o?.hmin === "number" &&
              (o.hmin as number) > 0 &&
              typeof o?.hmax === "number" &&
              (o.hmax as number) > 0 &&
              typeof o?.hausd === "number" &&
              (o.hausd as number) > 0
          );
        if (!localsOk) return bad("invalid localSizes");
      }
      return mmgTuningOk(rec) ? true : bad("invalid MMG tuning parameter");
    }
    case "levelset": {
      if (typeof rec.variable !== "string" || rec.variable.length === 0) {
        return bad("missing variable");
      }
      if (rec.isovalue !== undefined && typeof rec.isovalue !== "number") {
        return bad("invalid isovalue");
      }
      if (
        rec.rmc !== undefined &&
        !(typeof rec.rmc === "number" && rec.rmc > 0 && rec.rmc < 1)
      ) {
        return bad("invalid rmc");
      }
      for (const key of ["noSplit", "baseRefs"] as const) {
        const v = rec[key];
        if (v === undefined) continue;
        if (!Array.isArray(v) || !v.every((e) => selectorOk(e))) return bad(`invalid ${key}`);
      }
      return mmgTuningOk(rec) ? true : bad("invalid MMG tuning parameter");
    }
    default:
      return true; // parameterless ops
  }
}

/** One `{kind, target}` entity selector, as `frozen`/`noSplit`/`baseRefs` carry. */
function selectorOk(e: unknown): boolean {
  const sel = e as { kind?: unknown; target?: unknown };
  return (
    typeof sel?.kind === "string" &&
    FROZEN_KINDS.has(sel.kind) &&
    typeof sel.target === "string" &&
    sel.target.length > 0
  );
}

/** Optional MMG tuning params must be positive numbers / a known module. */
function mmgTuningOk(rec: {
  hmin?: number;
  hmax?: number;
  hausd?: number;
  hgrad?: number;
  module?: string;
}): boolean {
  const numsOk = (["hmin", "hmax", "hausd", "hgrad"] as const).every(
    (k) => rec[k] === undefined || (typeof rec[k] === "number" && (rec[k] as number) > 0)
  );
  return numsOk && (rec.module === undefined || MMG_MODULES.has(rec.module));
}
