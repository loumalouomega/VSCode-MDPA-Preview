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
import { writeMeshSizeFields, MeshSizeTarget } from "./meshSize";
import { validateSizeExpr } from "./sizeExpr";

export type OpRecord =
  | { op: "linearToQuadratic" }
  | { op: "removeOrphanNodes" }
  | { op: "mergeNodes"; tolerance: number }
  | { op: "scale"; sx: number; sy: number; sz: number }
  | { op: "translate"; dx: number; dy: number; dz: number }
  | { op: "rotate"; axis: Axis; angle: number; cx?: number; cy?: number; cz?: number }
  | { op: "deleteSubModelPart"; path: string }
  | { op: "renameSubModelPart"; path: string; newName: string }
  | { op: "writeMeshSizeFields"; target: MeshSizeTarget }
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
  writeMeshSizeFields: "Write mesh size fields",
  remesh: "Remesh (MMG)",
  levelset: "Level-set split (MMG)",
};

/**
 * Ops that run through the (async, comparatively slow) MMG WASM pipeline.
 * They must go through applyOpAsync/replayOpsAsync, and the history keeps a
 * snapshot after them so undo/redo of later ops never re-runs the remesher.
 */
export function isAsyncOp(op: OpName): boolean {
  return op === "remesh" || op === "levelset";
}

/** Live-progress + cancellation hooks threaded down to the MMG runner. */
export interface MmgRunOptions {
  onProgress?: MmgProgress;
  /** Honoured by the worker runner (thread terminated); the in-process default cannot abort a running WASM call. */
  signal?: AbortSignal;
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
    case "writeMeshSizeFields": {
      const r = writeMeshSizeFields(model, rec.target);
      if (r.added === 0) return { model, noop: true, message: "No mesh-size fields to write." };
      const what =
        rec.target === "both" ? "NODAL_H + ELEMENT_H" : rec.target === "nodal" ? "NODAL_H" : "ELEMENT_H";
      return { model: r.model, message: `Wrote mesh-size field(s): ${what}.` };
    }
    case "remesh":
    case "levelset":
      // Loud failure instead of a silent skip: MMG ops are async-only.
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
  "writeMeshSizeFields",
  "remesh",
  "levelset",
]);

const MMG_MODULES = new Set(["auto", "mmg3d", "mmgs", "mmg2d"]);
const REMESH_MODES = new Set(["factor", "hsiz", "optimize", "expr"]);
const MESH_SIZE_TARGETS = new Set<MeshSizeTarget>(["nodal", "element", "both"]);

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
    case "writeMeshSizeFields": {
      const target = msg.target;
      return typeof target === "string" && MESH_SIZE_TARGETS.has(target as MeshSizeTarget)
        ? { op, target: target as MeshSizeTarget }
        : undefined;
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
    case "writeMeshSizeFields":
      return MESH_SIZE_TARGETS.has(rec.target) ? true : bad("missing/invalid target");
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
