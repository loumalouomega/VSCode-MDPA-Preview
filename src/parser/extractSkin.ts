/**
 * Extracts the boundary skin of a mesh's volume cells (plus any pre-existing
 * surface cells) as a standalone `MdpaModel` — a real surface mesh, not a
 * preview overlay.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated.
 *
 * This ships as an EXPORT (a new file, like `extractSubModelPart`), never as
 * an in-place edit: a skin is a different mesh from its volume, with its own
 * node/entity ids, and there is no sense in which "undoing" it means anything
 * for the open model.
 *
 * Native rather than meshio++'s `extractSurface`/`extractSkin` for the
 * now-familiar reason: those operations DROP every region on the way out
 * (documented and verified — see `sphereElements.ts`'s sibling modules' docs
 * on the round-trip), so an extraction that could produce zero SubModelParts
 * would silently discard exactly the boundary-group information a Kratos user
 * most wants preserved (a `*SURFACE`/side-set boundary is often the whole
 * reason to extract a skin in the first place). Doing it natively means
 * SubModelParts survive the extraction like they do for
 * `extractSubModelPart` — only narrowed to the boundary, never dropped.
 *
 * The boundary-face walk itself mirrors `meshNormals.ts` and
 * `writerCommon.ts`'s `surfaceTriangles`: a volume cell's faces are looked up
 * via `volumeFaces`, keyed by their sorted node ids, and a face seen by two
 * cells is interior and excluded — only faces seen once survive.
 */

import { EntityBlock, FieldData, MdpaModel, SubModelPart } from "./types";
import { VtkCellType } from "./geometryMap";
import { cellCategory, cornerCount, volumeFaces, nodeIndexMap } from "./writers/writerCommon";
import { rebuildNodeArrays } from "./subModelPartExtract";

const C = VtkCellType;

export interface ExtractSkinResult {
  model: MdpaModel;
  /** Boundary faces produced. */
  faces: number;
}

interface Face {
  nodeIds: number[];
  type: number;
  /** The volume cell it came from (undefined for a pre-existing surface cell). */
  parentId?: number;
}

function nameFor(vtkType: number): string {
  switch (vtkType) {
    case C.TRIANGLE:
      return "SkinTriangle";
    case C.QUAD:
      return "SkinQuad";
    default:
      return `SkinCell_${vtkType}`;
  }
}

export function extractSkinModel(model: MdpaModel): ExtractSkinResult {
  const idToIndex = nodeIndexMap(model);
  const cornerIds = (block: EntityBlock, c: number, corners: number): number[] | undefined => {
    const out: number[] = [];
    for (let k = 0; k < corners; k++) {
      const id = block.connectivity[c * block.stride + k];
      if (idToIndex.get(id) === undefined) return undefined;
      out.push(id);
    }
    return out;
  };

  const faces: Face[] = [];
  const faceRecords = new Map<string, { nodeIds: number[]; type: number; parentId: number; count: number }>();

  for (const block of model.blocks) {
    const cat = cellCategory(block.vtkCellType);
    if (cat !== "surface" && cat !== "volume") continue;
    const corners = Math.min(cornerCount(block.vtkCellType) || block.stride, block.stride);
    for (let c = 0; c < block.count; c++) {
      const ids = cornerIds(block, c, corners);
      if (!ids) continue;
      if (cat === "surface") {
        faces.push({ nodeIds: ids, type: block.vtkCellType! });
        continue;
      }
      for (const face of volumeFaces(block.vtkCellType) ?? []) {
        const nodeIds = face.map((li) => ids[li]);
        const key = [...nodeIds].sort((a, b) => a - b).join(",");
        const rec = faceRecords.get(key);
        if (rec) rec.count++;
        else {
          faceRecords.set(key, {
            nodeIds,
            type: nodeIds.length === 3 ? C.TRIANGLE : C.QUAD,
            parentId: block.entityIds[c],
            count: 1,
          });
        }
      }
    }
  }
  for (const rec of faceRecords.values()) {
    if (rec.count === 1) faces.push({ nodeIds: rec.nodeIds, type: rec.type, parentId: rec.parentId });
  }

  if (faces.length === 0) {
    return {
      model: { ...model, blocks: [], fields: [], subModelParts: narrowParts(model.subModelParts, new Set()) },
      faces: 0,
    };
  }

  // Group into EntityBlocks by (vtkCellType, stride), first-seen order —
  // mirroring buildBlocksFromOffsets's grouping key, but keeping original
  // node ids rather than renumbering (this is an extraction, not a fresh parse).
  const byKey = new Map<string, { entityIds: number[]; connectivity: number[]; type: number; stride: number }>();
  let nextId = 1;
  for (const f of faces) {
    const stride = f.nodeIds.length;
    const key = `${f.type}|${stride}`;
    let g = byKey.get(key);
    if (!g) {
      g = { entityIds: [], connectivity: [], type: f.type, stride };
      byKey.set(key, g);
    }
    g.entityIds.push(nextId++);
    g.connectivity.push(...f.nodeIds);
  }
  const blocks: EntityBlock[] = Array.from(byKey.values()).map((g) => ({
    kind: "Elements",
    name: nameFor(g.type),
    vtkCellType: g.type,
    count: g.entityIds.length,
    stride: g.stride,
    entityIds: Int32Array.from(g.entityIds),
    connectivity: Int32Array.from(g.connectivity),
  }));

  const keptNodes = new Set<number>();
  for (const b of blocks) for (const id of b.connectivity) keptNodes.add(id);
  const { nodeIds, coords, bounds } = rebuildNodeArrays(model, keptNodes);

  // Only Nodal fields make sense here: the new blocks have fresh entity ids
  // with no relation to the source Elements/Conditions numbering, so an
  // Elemental/Conditional field cannot be carried across (dropped, as the
  // equivalent meshio++ operations do — the ids on the two sides simply do
  // not correspond, extraction or not).
  const fields: FieldData[] = model.fields
    .filter((f) => f.kind === "Nodal")
    .map((f) => {
      const rows: number[] = [];
      for (let i = 0; i < f.ids.length; i++) if (keptNodes.has(f.ids[i])) rows.push(i);
      if (rows.length === f.ids.length) return f;
      const comps = f.components;
      const ids = new Int32Array(rows.length);
      const values = new Float64Array(rows.length * comps);
      for (let r = 0; r < rows.length; r++) {
        ids[r] = f.ids[rows[r]];
        values.set(f.values.subarray(rows[r] * comps, (rows[r] + 1) * comps), r * comps);
      }
      return { kind: f.kind, variable: f.variable, components: comps, ids, values };
    })
    .filter((f) => f.ids.length > 0);

  return {
    model: {
      nodeCount: nodeIds.length,
      nodeIds,
      coords,
      blocks,
      subModelParts: narrowParts(model.subModelParts, keptNodes),
      // No `properties` either: the skin's blocks are built fresh and carry no
      // propertyIds, so there would be nothing pointing into them. No
      // `constraints` for the same reason — a skin is a different mesh with its
      // own entity ids, and `narrowParts` drops the id lists to match.
      meta: [],
      fields,
      diagnostics: [],
      is3D: model.is3D,
      bounds,
    },
    faces: faces.length,
  };
}

/**
 * Narrows every SubModelPart to its NODE membership on the skin — the only
 * thing that still corresponds: the new blocks have fresh entity ids, so
 * element/condition/geometry membership cannot follow across the extraction,
 * but a node that was in a part and lies on the boundary is still that node.
 * Kept even when a part ends up with none, so the tree still reads as "this
 * part existed" rather than silently vanishing.
 */
function narrowParts(parts: SubModelPart[], keptNodes: Set<number>): SubModelPart[] {
  return parts.map((p) => ({
    ...p,
    nodeIds: p.nodeIds.filter((id) => keptNodes.has(id)),
    elementIds: new Int32Array(0),
    conditionIds: new Int32Array(0),
    geometryIds: new Int32Array(0),
    // Constraints go with them, and for a sharper reason than the three above:
    // the skin model carries no `constraints` at all (its cells and ids are
    // fresh), so a surviving list would name constraints the written file
    // defines nowhere.
    constraintIds: new Int32Array(0),
    children: narrowParts(p.children, keptNodes),
  }));
}
