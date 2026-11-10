// Element and condition id labels (roadmap item 60). Pure typed-array code:
// the centroids of every cell of one entity kind in one array, plus the text a
// label shows for a chosen source. The webview feeds the centroids through the
// same projection / occlusion / declutter pass the node labels use.

import type { EntityBlock } from "../types";
import type { MembershipIndex } from "../smpMembership";
import type { PreparedNodes } from "./displayGeometry";
import { blockCentroids } from "./hardwareSelection";

export type LabelTarget = "node" | "element" | "condition";
export type LabelSource = "id" | "propertyId" | "smp" | "field";

export const LABEL_TARGETS: readonly LabelTarget[] = ["node", "element", "condition"];
export const LABEL_SOURCES: readonly LabelSource[] = ["id", "propertyId", "smp", "field"];

export interface CellLabelPoints {
  /** Centroids, 3 per cell; a cell with an unresolved corner is NaN (never projected inside). */
  xyz: Float32Array;
  /** Index into the blocks array the cell belongs to. */
  block: Uint32Array;
  /** Index of the cell inside its block. */
  cell: Uint32Array;
}

/** Centroids of every cell of `kind` in `blocks`, concatenated in block order. */
export function cellLabelPoints(blocks: readonly EntityBlock[], kind: "Elements" | "Conditions", prep: PreparedNodes): CellLabelPoints {
  let total = 0;
  for (const b of blocks) if (b.kind === kind) total += b.count;
  const xyz = new Float32Array(total * 3);
  const block = new Uint32Array(total);
  const cell = new Uint32Array(total);
  let o = 0;
  blocks.forEach((b, bi) => {
    if (b.kind !== kind) return;
    const c = blockCentroids(b, prep);
    for (let i = 0; i < b.count; i++, o++) {
      xyz[o * 3] = c[i * 3];
      xyz[o * 3 + 1] = c[i * 3 + 1];
      xyz[o * 3 + 2] = c[i * 3 + 2];
      block[o] = bi;
      cell[o] = i;
    }
  });
  return { xyz, block, cell };
}

export interface LabelTextContext {
  blocks: readonly EntityBlock[];
  kind: "Elements" | "Conditions";
  membership?: MembershipIndex;
  /** Text of the active field at an entity id, undefined when it has no value there. */
  fieldText?: (id: number) => string | undefined;
}

/** The text one label shows. An absent value is an empty string, never "0". */
export function cellLabelText(source: LabelSource, pts: CellLabelPoints, i: number, ctx: LabelTextContext): string {
  const b = ctx.blocks[pts.block[i]];
  const c = pts.cell[i];
  const id = b.entityIds[c];
  switch (source) {
    case "id":
      return String(id);
    case "propertyId":
      return b.propertyIds ? String(b.propertyIds[c]) : "";
    case "smp": {
      const map = ctx.kind === "Elements" ? ctx.membership?.elements : ctx.membership?.conditions;
      const paths = map?.get(id);
      return paths && paths.length ? paths[0] : "";
    }
    case "field":
      return ctx.fieldText?.(id) ?? "";
  }
}

export function isLabelTarget(v: unknown): v is LabelTarget {
  return typeof v === "string" && (LABEL_TARGETS as readonly string[]).includes(v);
}
export function isLabelSource(v: unknown): v is LabelSource {
  return typeof v === "string" && (LABEL_SOURCES as readonly string[]).includes(v);
}
