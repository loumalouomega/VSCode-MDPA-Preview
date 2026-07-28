/**
 * Crops a mesh to a bounding box or a half-space defined by a plane: keeps
 * cells whose nodes are inside (mode `"all"`: every node; `"any"`: at least
 * one), then removes anything left unreferenced.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * Native rather than meshio++'s `cropBbox`/`cropPlane` because both prune and
 * RENUMBER points, so adopting their output would round-trip through
 * meshioConvert — destroying SubModelParts, `propertyIds`, block kinds and
 * every entity id. Structurally this is `deleteSubModelPart.ts` with the
 * inside/outside test inverted: instead of "the entities named by this path",
 * the removal set is "the entities failing the geometric test", and the same
 * `sliceBlock`/`sliceField` helpers (from `subModelPartExtract.ts`) rebuild the
 * blocks and fields around whatever survives.
 */

import { MdpaModel, SubModelPart } from "./types";
import { sliceBlock, sliceField } from "./subModelPartExtract";
import { removeOrphanNodes } from "./removeOrphanNodes";

export type CropMode = "all" | "any";

export interface CropBboxParams {
  kind: "bbox";
  lo: [number, number, number];
  hi: [number, number, number];
  mode?: CropMode;
}

export interface CropPlaneParams {
  kind: "plane";
  point: [number, number, number];
  normal: [number, number, number];
  mode?: CropMode;
}

export type CropParams = CropBboxParams | CropPlaneParams;

export interface CropResult {
  model: MdpaModel;
  /** Cells kept (across all blocks). */
  keptCells: number;
  /** Cells dropped. */
  droppedCells: number;
  /** Nodes left unreferenced by anything kept, then removed. */
  removedNodes: number;
}

/** True when the node satisfies the crop's geometric test on its own. */
function insideTest(params: CropParams): (x: number, y: number, z: number) => boolean {
  if (params.kind === "bbox") {
    const [lx, ly, lz] = params.lo;
    const [hx, hy, hz] = params.hi;
    return (x, y, z) => x >= lx && x <= hx && y >= ly && y <= hy && z >= lz && z <= hz;
  }
  const [px, py, pz] = params.point;
  const [nx, ny, nz] = params.normal;
  return (x, y, z) => (x - px) * nx + (y - py) * ny + (z - pz) * nz >= 0;
}

export function cropModel(model: MdpaModel, params: CropParams): CropResult {
  const noop: CropResult = { model, keptCells: 0, droppedCells: 0, removedNodes: 0 };

  const normal = params.kind === "plane" ? params.normal : undefined;
  if (normal && normal.every((v) => v === 0)) {
    throw new Error("cropPlane: normal must not be the zero vector.");
  }

  const inside = insideTest(params);
  const nodeInside = new Map<number, boolean>();
  for (let i = 0; i < model.nodeCount; i++) {
    const o = i * 3;
    nodeInside.set(
      model.nodeIds[i],
      inside(model.coords[o], model.coords[o + 1], model.coords[o + 2])
    );
  }

  const mode = params.mode ?? "all";
  const keepElements = new Set<number>();
  const keepConditions = new Set<number>();
  const keepGeometries = new Set<number>();
  let keptCells = 0;
  let droppedCells = 0;

  for (const block of model.blocks) {
    const target =
      block.kind === "Elements"
        ? keepElements
        : block.kind === "Conditions"
          ? keepConditions
          : keepGeometries;
    for (let c = 0; c < block.count; c++) {
      const base = c * block.stride;
      let insideCount = 0;
      for (let k = 0; k < block.stride; k++) {
        if (nodeInside.get(block.connectivity[base + k])) insideCount++;
      }
      const keep = mode === "all" ? insideCount === block.stride : insideCount > 0;
      if (keep) {
        target.add(block.entityIds[c]);
        keptCells++;
      } else {
        droppedCells++;
      }
    }
  }

  if (keptCells === 0) {
    throw new Error("crop: no cells survive — the box/plane does not intersect this mesh.");
  }
  if (droppedCells === 0) return noop;

  const blocks = model.blocks
    .map((b) =>
      sliceBlock(
        b,
        b.kind === "Elements" ? keepElements : b.kind === "Conditions" ? keepConditions : keepGeometries
      )
    )
    .filter((b) => b !== undefined);

  const fields = model.fields
    .map((f) => {
      if (f.kind === "Nodal") return f; // node-keyed; filtered by removeOrphanNodes below
      return sliceField(f, f.kind === "Conditional" ? keepConditions : keepElements);
    })
    .filter((f) => f !== undefined);

  // SubModelPart node membership narrows to nodes actually inside the region
  // (an explicit node listing is user intent, independent of which cells
  // survive); Elemental/Conditional membership narrows to surviving entities.
  const filterPart = (part: SubModelPart): SubModelPart => ({
    ...part,
    nodeIds: part.nodeIds.filter((id) => nodeInside.get(id) === true),
    elementIds: part.elementIds.filter((id) => keepElements.has(id)),
    conditionIds: part.conditionIds.filter((id) => keepConditions.has(id)),
    geometryIds: part.geometryIds.filter((id) => keepGeometries.has(id)),
    children: part.children.map(filterPart),
  });

  const cropped: MdpaModel = {
    ...model,
    blocks,
    fields,
    subModelParts: model.subModelParts.map(filterPart),
  };
  const { model: cleaned, removed } = removeOrphanNodes(cropped);

  return { model: cleaned, keptCells, droppedCells, removedNodes: removed };
}
