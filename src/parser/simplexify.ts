/**
 * Simplexify: rewrites every cell into simplices of the same topological
 * dimension — hex→6 tets, wedge→3, pyramid→2, quad→2 triangles. Simplices are
 * already simplices and pass through unchanged.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * Native rather than meshio++'s `convertCells("simplexify")` because that
 * operation grows the cell count, and doing it through the wasm would mean a
 * round-trip through meshioConvert — which destroys SubModelParts, collapses
 * Conditions/Geometries into Elements and drops propertyIds. The decomposition
 * itself needs no wasm: `cellDecomposition.ts` already carries exactly these
 * tables for isoSurface.ts's marching tetrahedra, so this module is the same
 * tables applied as a real mesh edit instead of an internal marching step.
 *
 * Every child inherits its parent's entity id family (Elemental/Conditional
 * field rows and SubModelPart membership are id-keyed, so replicating the
 * parent's id onto each child keeps them all correctly assigned) — new entity
 * ids are minted only for the count beyond the first child.
 */

import { EntityBlock, FieldData, MdpaModel } from "./types";
import { decompositionFor } from "./cellDecomposition";
import { VtkCellType } from "./geometryMap";

const C = VtkCellType;

/** Simplex type + node count a decomposed cell becomes. */
function simplexTypeFor(cellType: number): { type: number; corners: number } | undefined {
  const d = decompositionFor(cellType);
  if (d.tets) return { type: C.TETRA, corners: 4 };
  if (d.tris) return { type: C.TRIANGLE, corners: 3 };
  return undefined;
}

/** Bump the trailing node-count token: Element3D8N -> Element3D4N. */
function renameToNodeCount(name: string, newCount: number): string {
  return name.replace(/(\d+)(N?)$/, (_m, _n, n) => `${newCount}${n}`);
}

export interface SimplexifyResult {
  model: MdpaModel;
  /** Cells replaced by >1 simplex (already-simplex cells don't count). */
  splitCells: number;
  /** Total simplices produced from those cells. */
  producedSimplices: number;
  /** Block names left unchanged (no known decomposition — e.g. line/vertex/polyhedron). */
  skippedBlocks: string[];
}

export function simplexifyModel(model: MdpaModel): SimplexifyResult {
  let splitCells = 0;
  let producedSimplices = 0;
  const skippedBlocks: string[] = [];
  // Maps a parent entity id to the ids of the simplices it produced, so
  // Elemental/Conditional fields and SubModelPart membership can be replicated.
  const childrenOf = new Map<number, number[]>();
  let nextId = maxEntityId(model) + 1;

  const blocks: EntityBlock[] = [];
  for (const block of model.blocks) {
    const target =
      block.vtkCellType !== undefined ? simplexTypeFor(block.vtkCellType) : undefined;
    const decomposition =
      block.vtkCellType !== undefined ? decompositionFor(block.vtkCellType) : undefined;
    const simplices = decomposition?.tets ?? decomposition?.tris;
    if (!target || !simplices) {
      skippedBlocks.push(block.name);
      blocks.push(block);
      continue;
    }

    const corners = block.stride;
    const perCell = simplices.length;
    const entityIds = new Int32Array(block.count * perCell);
    const propertyIds = block.propertyIds ? new Int32Array(block.count * perCell) : undefined;
    const connectivity = new Int32Array(block.count * perCell * target.corners);

    for (let c = 0; c < block.count; c++) {
      const parentId = block.entityIds[c];
      const kids: number[] = [];
      for (let s = 0; s < perCell; s++) {
        const childId = s === 0 ? parentId : nextId++;
        kids.push(childId);
        const out = c * perCell + s;
        entityIds[out] = childId;
        if (propertyIds) propertyIds[out] = block.propertyIds![c];
        for (let k = 0; k < target.corners; k++) {
          connectivity[out * target.corners + k] = block.connectivity[c * corners + simplices[s][k]];
        }
      }
      childrenOf.set(parentId, kids);
      if (perCell > 1) {
        splitCells++;
        producedSimplices += perCell;
      } else {
        producedSimplices++;
      }
    }

    blocks.push({
      kind: block.kind,
      name: renameToNodeCount(block.name, target.corners),
      vtkCellType: target.type,
      count: block.count * perCell,
      stride: target.corners,
      entityIds,
      propertyIds,
      connectivity,
    });
  }

  if (splitCells === 0) {
    return { model, splitCells: 0, producedSimplices, skippedBlocks };
  }

  const fields = model.fields.map((f) => replicateField(f, childrenOf));
  const subModelParts = model.subModelParts.map((p) => replicatePart(p, childrenOf));

  return {
    model: { ...model, blocks, fields, subModelParts },
    splitCells,
    producedSimplices,
    skippedBlocks,
  };
}

function maxEntityId(model: MdpaModel): number {
  let max = 0;
  for (const b of model.blocks) for (const id of b.entityIds) if (id > max) max = id;
  return max;
}

/** Nodal fields are untouched (node ids don't change); Elemental/Conditional replicate. */
function replicateField(field: FieldData, childrenOf: Map<number, number[]>): FieldData {
  if (field.kind === "Nodal") return field;
  const comps = field.components;
  const ids: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < field.ids.length; i++) {
    const kids = childrenOf.get(field.ids[i]) ?? [field.ids[i]];
    for (const kid of kids) {
      ids.push(kid);
      for (let k = 0; k < comps; k++) values.push(field.values[i * comps + k]);
    }
  }
  return {
    kind: field.kind,
    variable: field.variable,
    components: comps,
    ids: Int32Array.from(ids),
    values: Float64Array.from(values),
  };
}

function replicateIds(ids: Int32Array, childrenOf: Map<number, number[]>): Int32Array {
  const out: number[] = [];
  for (const id of ids) out.push(...(childrenOf.get(id) ?? [id]));
  return Int32Array.from(out);
}

function replicatePart(
  part: MdpaModel["subModelParts"][number],
  childrenOf: Map<number, number[]>
): MdpaModel["subModelParts"][number] {
  return {
    ...part,
    elementIds: replicateIds(part.elementIds, childrenOf),
    conditionIds: replicateIds(part.conditionIds, childrenOf),
    children: part.children.map((c) => replicatePart(c, childrenOf)),
  };
}
