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

export type OpRecord =
  | { op: "linearToQuadratic" }
  | { op: "removeOrphanNodes" }
  | { op: "mergeNodes"; tolerance: number }
  | { op: "scale"; sx: number; sy: number; sz: number }
  | { op: "translate"; dx: number; dy: number; dz: number }
  | { op: "rotate"; axis: Axis; angle: number; cx?: number; cy?: number; cz?: number }
  | { op: "deleteSubModelPart"; path: string };

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
};

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
    default: {
      // Exhaustiveness guard for unknown op names coming from a loaded recipe.
      return { model, noop: true, message: `Unknown operation.` };
    }
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

const RECIPE_VERSION = 1;
const KNOWN_OPS = new Set<OpName>([
  "linearToQuadratic",
  "removeOrphanNodes",
  "mergeNodes",
  "scale",
  "translate",
  "rotate",
  "deleteSubModelPart",
]);

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
    default:
      return undefined;
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
    default:
      return true; // parameterless ops
  }
}
