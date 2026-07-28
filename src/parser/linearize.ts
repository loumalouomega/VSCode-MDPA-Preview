/**
 * The inverse of linearToQuadratic.ts: drops every quadratic (mid-edge / face /
 * body) node from a cell's connectivity, keeping only its corners, and rewrites
 * the block's type/name/stride to the linear counterpart.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * Native rather than meshio++'s `convertCells("linearize")` for the same reason
 * every other op in this file is native: that op prunes and RENUMBERS points,
 * which would need the full round-trip fidelity layer to bring back through
 * `regions`/`propertyIds`/entity ids. Dropping trailing connectivity entries is
 * a one-line transform once you know which prefix is the corners — no wasm
 * needed, and no round-trip to be lossy.
 *
 * Mid-side nodes end up referenced by no surviving cell; `removeOrphanNodes`
 * (reused, not reimplemented) does the cleanup, including from Nodal fields and
 * SubModelPart node lists — a mid node introduced by `linearToQuadratic` is
 * exactly what this undoes.
 */

import { EntityBlock, MdpaModel } from "./types";
import { VtkCellType } from "./geometryMap";
import { removeOrphanNodes } from "./removeOrphanNodes";

const C = VtkCellType;

/** Quadratic (serendipity) VTK cell type -> its linear base + corner count. */
const QUADRATIC_TO_LINEAR: Record<number, { type: number; corners: number }> = {
  [C.QUADRATIC_EDGE]: { type: C.LINE, corners: 2 },
  [C.QUADRATIC_TRIANGLE]: { type: C.TRIANGLE, corners: 3 },
  [C.QUADRATIC_QUAD]: { type: C.QUAD, corners: 4 },
  [C.QUADRATIC_TETRA]: { type: C.TETRA, corners: 4 },
  [C.QUADRATIC_HEXAHEDRON]: { type: C.HEXAHEDRON, corners: 8 },
  [C.QUADRATIC_WEDGE]: { type: C.WEDGE, corners: 6 },
  [C.QUADRATIC_PYRAMID]: { type: C.PYRAMID, corners: 5 },
  // Biquadratic/triquadratic (extra face/body-centre nodes) still start with
  // the same corners, so they linearize the same way as their serendipity twin.
  [C.BIQUADRATIC_QUAD]: { type: C.QUAD, corners: 4 },
  [C.TRIQUADRATIC_HEXAHEDRON]: { type: C.HEXAHEDRON, corners: 8 },
};

/** Bump the trailing node-count token: Element2D6N→Element2D3N, Triangle2D6→Triangle2D3. */
function renameToNodeCount(name: string, newCount: number): string {
  return name.replace(/(\d+)(N?)$/, (_m, _n, n) => `${newCount}${n}`);
}

export interface LinearizeResult {
  model: MdpaModel;
  /** Cells narrowed to their linear base. */
  convertedCells: number;
  /** Nodes left unreferenced by any cell/SubModelPart, then removed. */
  removedNodes: number;
  /** Names of blocks left unchanged (already linear, or no known base). */
  skippedBlocks: string[];
}

export function linearize(model: MdpaModel): LinearizeResult {
  let convertedCells = 0;
  const skippedBlocks: string[] = [];

  const blocks: EntityBlock[] = model.blocks.map((block) => {
    const base = block.vtkCellType !== undefined ? QUADRATIC_TO_LINEAR[block.vtkCellType] : undefined;
    if (!base) {
      skippedBlocks.push(block.name);
      return block; // copied by reference; never mutated
    }
    const { type, corners } = base;
    const count = block.count;
    const connectivity = new Int32Array(count * corners);
    for (let c = 0; c < count; c++) {
      for (let k = 0; k < corners; k++) {
        connectivity[c * corners + k] = block.connectivity[c * block.stride + k];
      }
    }
    convertedCells += count;
    return {
      kind: block.kind,
      name: renameToNodeCount(block.name, corners),
      vtkCellType: type,
      count,
      stride: corners,
      entityIds: block.entityIds,
      propertyIds: block.propertyIds,
      connectivity,
    };
  });

  const narrowed: MdpaModel = { ...model, blocks };
  const { model: cleaned, removed } = removeOrphanNodes(narrowed);

  return { model: cleaned, convertedCells, removedNodes: removed, skippedBlocks };
}
