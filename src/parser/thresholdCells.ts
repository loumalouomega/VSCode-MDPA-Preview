// Pure (no vscode/DOM/vtk) threshold selection behind the Field panel's
// Threshold mode: which Elements/Conditions pass a [lo, hi] window on a field.
// View-only — no MdpaModel is produced or mutated; the webview builds an
// overlay layer from the returned id lists (see main.ts's field:threshold
// layer, the same addLayer pattern as the quality/mesh-size highlights).

import { EntityBlock, FieldData, MdpaModel } from "./types";
import { FieldComponent, componentScalar } from "./fieldScalars";

/** For a Nodal field: does a cell need every node in range, or just one? */
export type ThresholdRule = "all" | "any";

export interface ThresholdResult {
  elementIds: number[];
  conditionIds: number[];
}

function inRange(v: number | undefined, lo: number, hi: number): boolean {
  return v !== undefined && Number.isFinite(v) && v >= lo && v <= hi;
}

function scalarLookup(field: FieldData, component: FieldComponent): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < field.ids.length; i++) {
    map.set(field.ids[i], componentScalar(field, i, component));
  }
  return map;
}

function pushPassing(
  block: EntityBlock,
  target: number[],
  passes: (i: number) => boolean
): void {
  for (let i = 0; i < block.count; i++) {
    if (passes(i)) target.push(block.entityIds[i]);
  }
}

/**
 * Elements/Conditions passing the [lo, hi] window on `field`. Nodal fields
 * test each cell's nodes per `rule` ("all" in range = the default, or "any");
 * Elemental/Conditional fields test the cell's own value directly (`rule` is
 * ignored — there is only one value per cell). A cell with no value at all
 * (sparse field) never passes.
 */
export function thresholdCells(
  model: MdpaModel,
  field: FieldData,
  component: FieldComponent,
  range: [number, number],
  rule: ThresholdRule = "all"
): ThresholdResult {
  const [lo, hi] = range[0] <= range[1] ? range : [range[1], range[0]];
  const elementIds: number[] = [];
  const conditionIds: number[] = [];

  if (field.kind === "Nodal") {
    const valueByNode = scalarLookup(field, component);
    const wantAll = rule === "all";
    for (const block of model.blocks) {
      if (block.kind !== "Elements" && block.kind !== "Conditions") continue;
      const target = block.kind === "Elements" ? elementIds : conditionIds;
      pushPassing(block, target, (i) => {
        const nodeIds = block.connectivity.subarray(i * block.stride, (i + 1) * block.stride);
        for (let k = 0; k < nodeIds.length; k++) {
          const ok = inRange(valueByNode.get(nodeIds[k]), lo, hi);
          if (wantAll && !ok) return false; // one out-of-range node disqualifies "all"
          if (!wantAll && ok) return true; // one in-range node satisfies "any"
        }
        return wantAll; // "all": every node passed; "any": none did
      });
    }
    return { elementIds, conditionIds };
  }

  // Elemental / Conditional: one value per cell.
  const valueByEntity = scalarLookup(field, component);
  const kind = field.kind === "Elemental" ? "Elements" : "Conditions";
  for (const block of model.blocks) {
    if (block.kind !== kind) continue;
    const target = kind === "Elements" ? elementIds : conditionIds;
    pushPassing(block, target, (i) => inRange(valueByEntity.get(block.entityIds[i]), lo, hi));
  }
  return { elementIds, conditionIds };
}
