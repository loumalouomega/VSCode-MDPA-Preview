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

import { MdpaModel } from "./types";
import { linearToQuadratic } from "./linearToQuadratic";
import { removeOrphanNodes } from "./removeOrphanNodes";
import { mergeNodes } from "./mergeNodes";
import { scaleCoords, translateCoords, rotateCoords, Axis } from "./transformCoords";
import { deleteSubModelPart } from "./deleteSubModelPart";
import {
  remeshModel,
  levelsetModel,
  RemeshParams,
  LevelsetParams,
  RemeshResult,
  MmgProgress,
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
import { smoothModel, SmoothMethod, SmoothParams } from "./smoothMesh";
import { reorderModel, ReorderMethod, REORDER_METHODS } from "./reorderMesh";
import { partitionModel, PartitionMethod, PARTITION_VARIABLE } from "./partitionMesh";
import { linearize } from "./linearize";
import { refineModel } from "./refineMesh";
import { simplexifyModel } from "./simplexify";
import { cropModel, CropParams } from "./cropMesh";
import {
  fieldCalcModel,
  averageField,
  FieldCalcParams,
  AverageFieldParams,
  AverageDirection,
  CellBlockKind,
} from "./fieldCalc";
import { mergeModels, MergeMeshParams } from "./mergeMesh";
import {
  gradientFieldModel,
  GradientParams,
  GRADIENT_METHODS,
  GRADIENT_OPERATORS,
  GradientMethod,
  GradientOperator,
} from "./gradientField";
import { parseMeshFile } from "./meshFileParser";
import { parseMdpa } from "./mdpaParser";
import { validateSizeExpr } from "./sizeExpr";
import * as fs from "node:fs";
import * as path from "node:path";

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
  if (path.extname(fsPath).toLowerCase() === ".mdpa") {
    return parseMdpa(fs.readFileSync(fsPath, "utf8"));
  }
  return parseMeshFile(fsPath);
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
  | ({ op: "smooth" } & SmoothParams)
  | { op: "reorder"; method: ReorderMethod }
  | { op: "partition"; nparts: number; method?: PartitionMethod; createParts?: boolean }
  | { op: "linearize" }
  | { op: "refine"; levels?: number }
  | { op: "simplexify" }
  | ({ op: "crop" } & CropParams)
  | ({ op: "fieldCalc" } & FieldCalcParams)
  | ({ op: "averageField" } & AverageFieldParams)
  | ({ op: "fieldGradient" } & GradientParams)
  | ({ op: "mergeMesh"; path: string } & MergeMeshParams)
  | ({ op: "remesh" } & RemeshParams)
  | ({ op: "levelset" } & LevelsetParams);

export type OpName = OpRecord["op"];

/** Human-readable labels for the history list UI. */
export const OP_LABELS: Record<OpName, string> = {
  linearToQuadratic: "Linear → Quadratic",
  removeOrphanNodes: "Remove orphan nodes",
  mergeNodes: "Merge coincident nodes",
  scale: "Scale",
  translate: "Translate",
  rotate: "Rotate",
  deleteSubModelPart: "Delete SubModelPart",
  renameSubModelPart: "Rename SubModelPart",
  createSubModelPart: "Create SubModelPart",
  moveSubModelPart: "Move SubModelPart",
  mergeSubModelParts: "Merge SubModelParts",
  addSubModelPartEntities: "Add entities to SubModelPart",
  removeSubModelPartEntities: "Remove entities from SubModelPart",
  writeMeshSizeFields: "Write mesh size fields",
  setElementRadius: "Set element radius",
  smooth: "Smooth",
  reorder: "Reorder nodes",
  partition: "Partition",
  linearize: "Quadratic → Linear",
  refine: "Refine (uniform subdivision)",
  simplexify: "Simplexify",
  crop: "Crop",
  fieldCalc: "Field calculator",
  averageField: "Average field (nodal ↔ elemental)",
  fieldGradient: "Field gradient / divergence / curl",
  mergeMesh: "Merge mesh",
  remesh: "Remesh (MMG)",
  levelset: "Level-set split (MMG)",
};

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
  "remesh",
  "levelset",
  "smooth",
  "reorder",
  "partition",
  "mergeMesh",
  "fieldGradient",
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
      return { model: r.model, message: `Merged ${r.merged} coincident node(s).` };
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
    case "linearize": {
      const r = linearize(model);
      if (r.convertedCells === 0) return { model, noop: true, message: "No quadratic cells to linearize." };
      return {
        model: r.model,
        message: `Linearized ${r.convertedCells} cell(s) (-${r.removedNodes} node(s)).`,
      };
    }
    case "refine": {
      const r = refineModel(model, rec.levels ?? 1);
      if (r.refinedCells === 0) return { model, noop: true, message: "No cells could be refined." };
      return {
        model: r.model,
        message: `Refined ${r.refinedCells} cell(s) into ${r.producedCells} (+${r.addedNodes} node(s)).`,
      };
    }
    case "simplexify": {
      const r = simplexifyModel(model);
      if (r.splitCells === 0) return { model, noop: true, message: "No cells needed splitting into simplices." };
      return {
        model: r.model,
        message: `Split ${r.splitCells} cell(s) into ${r.producedSimplices} simplices.`,
      };
    }
    case "crop": {
      const r = cropModel(model, rec);
      if (r.droppedCells === 0) return { model, noop: true, message: "Nothing outside the crop region." };
      return {
        model: r.model,
        message: `Kept ${r.keptCells} cell(s), dropped ${r.droppedCells} (-${r.removedNodes} node(s)).`,
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
    case "remesh":
    case "levelset":
    case "smooth":
    case "reorder":
    case "partition":
    case "mergeMesh":
    case "fieldGradient":
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
export async function applyOpAsync(
  model: MdpaModel,
  rec: OpRecord,
  opts?: MmgRunOptions
): Promise<OpOutcome> {
  switch (rec.op) {
    case "mergeMesh": {
      let other;
      try {
        other = await parseMergeSource(rec.path);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { model, noop: true, message: `Could not read "${rec.path}": ${why}` };
      }
      const r = mergeModels(model, other, rec);
      if (r.addedNodes === 0 && r.addedCells === 0) {
        return { model, noop: true, message: "The file to merge was empty." };
      }
      const weld = r.welded > 0 ? `, welded ${r.welded} coincident node(s)` : "";
      return {
        model: r.model,
        message: `Merged ${r.addedCells} cell(s) and ${r.addedNodes} node(s) from "${rec.path}"${weld}.`,
      };
    }
    case "remesh":
    case "levelset":
      try {
        return await mmgRunner(rec.op, model, rec, opts);
      } catch (err) {
        // Worker crash or user cancellation: keep the model, report why.
        const why = err instanceof Error ? err.message : String(err);
        return {
          model,
          noop: true,
          message:
            why === "cancelled"
              ? `${OP_LABELS[rec.op]} cancelled.`
              : `${OP_LABELS[rec.op]} failed: ${why}`,
        };
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
  for (const rec of ops) {
    if (opts?.signal?.aborted) break;
    // Left out entirely rather than run — see MmgRunOptions.skipAsyncOps. The
    // model passes through untouched, exactly as a noop would.
    if (opts?.skipAsyncOps && isAsyncOp(rec.op)) continue;
    const out = await applyOpAsync(model, rec, opts);
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
  "smooth",
  "reorder",
  "partition",
  "linearize",
  "refine",
  "simplexify",
  "crop",
  "fieldCalc",
  "averageField",
  "fieldGradient",
  "mergeMesh",
  "remesh",
  "levelset",
]);

const MMG_MODULES = new Set(["auto", "mmg3d", "mmgs", "mmg2d"]);
const REMESH_MODES = new Set(["factor", "hsiz", "optimize", "expr"]);
const MESH_SIZE_TARGETS = new Set<MeshSizeTarget>(["nodal", "element", "both"]);
const RADIUS_MODES = new Set<RadiusMode>(["absolute", "multiply"]);
const SMOOTH_METHODS = new Set<SmoothMethod>(["laplacian", "taubin"]);
const PARTITION_METHODS = new Set<PartitionMethod>(["sfc", "kahip", "auto"]);
const CROP_MODES = new Set(["all", "any"]);
const FIELD_LOCATIONS = new Set(["Nodal", "Elemental", "Conditional"]);
const CELL_BLOCK_KINDS = new Set(["Elements", "Conditions"]);
const AVERAGE_DIRECTIONS = new Set(["nodalToElemental", "elementalToNodal"]);

/**
 * Builds a validated OpRecord from a raw webview `applyOp` message (which now
 * carries any numeric parameters entered in the sidebar). Returns undefined on a
 * missing/invalid op or param so the host can ignore it.
 */
export function opRecordFromMessage(msg: Record<string, unknown>): OpRecord | undefined {
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
      return levels > 0 ? { op, levels: Math.floor(levels) } : undefined;
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
    case "mergeMesh": {
      const path = msg.path;
      if (typeof path !== "string" || path.length === 0) return undefined;
      const rec: Extract<OpRecord, { op: "mergeMesh" }> = { op, path };
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
        mode: mode as "factor" | "hsiz" | "optimize" | "expr",
      };
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
        if (!sizeExpr || validateSizeExpr(sizeExpr) !== undefined) return undefined;
        rec.sizeExpr = sizeExpr;
        const parts = parseSizeParts(msg.sizeParts);
        if (parts.length) rec.sizeParts = parts;
      }
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
      copyMmgTuning(msg, rec);
      return rec;
    }
    default:
      return undefined;
  }
}

/**
 * Validates a raw `sizeParts` value into `{path, expr}[]`, keeping only entries
 * with a non-empty path and a parseable expression (invalid rows are dropped).
 */
function parseSizeParts(raw: unknown): { path: string; expr: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { path: string; expr: string }[] = [];
  for (const entry of raw) {
    const e = entry as { path?: unknown; expr?: unknown };
    const path = typeof e?.path === "string" ? e.path.trim() : "";
    const expr = typeof e?.expr === "string" ? e.expr.trim() : "";
    if (path && expr && validateSizeExpr(expr) === undefined) out.push({ path, expr });
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
    operations.push(rec as OpRecord);
  }
  return { operations, warnings };
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
    case "refine":
      return rec.levels === undefined || (typeof rec.levels === "number" && rec.levels > 0)
        ? true
        : bad("invalid levels");
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
    case "mergeMesh":
      return typeof rec.path === "string" && rec.path.length > 0 ? true : bad("missing path");
    case "remesh": {
      if (!REMESH_MODES.has(rec.mode)) return bad("missing/invalid mode");
      if (rec.mode === "factor" && !(typeof rec.factor === "number" && rec.factor > 0)) {
        return bad("missing/invalid factor");
      }
      if (rec.mode === "hsiz" && !(typeof rec.hsiz === "number" && rec.hsiz > 0)) {
        return bad("missing/invalid hsiz");
      }
      if (rec.mode === "expr") {
        if (typeof rec.sizeExpr !== "string" || validateSizeExpr(rec.sizeExpr) !== undefined) {
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
                validateSizeExpr(p.expr) === undefined
            );
          if (!partsOk) return bad("invalid sizeParts");
        }
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
      return mmgTuningOk(rec) ? true : bad("invalid MMG tuning parameter");
    }
    default:
      return true; // parameterless ops
  }
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
