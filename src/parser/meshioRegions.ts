/**
 * meshio++ named regions -> SubModelParts (and, for side regions, materialized
 * boundary-facet Conditions blocks).
 *
 * A `Region` is meshio++'s uniform spelling of what every format calls
 * something else: a gmsh physical group, an Abaqus `*NSET`/`*ELSET`/`*SURFACE`,
 * an Exodus block or set, a MED family, a Kratos SubModelPart.  Since
 * meshio++ 8.1.0 they ride on the mesh object itself, so `readMesh` carries
 * them with no extra call.
 *
 * Pure module: no vscode / DOM / wasm imports (meshioConvert.ts calls in here).
 */

import { MeshioAnyCellBlock, MeshioCellBlock } from "./meshioConvert";
import { MESHIO_TO_VTK_TYPE } from "./meshioFormats";
import { EntityBlock, MdpaDiagnostic, SubModelPart } from "./types";

/**
 * True for a uniform (fixed node-count) block; false for a ragged
 * (polygon/polyhedron) one.  Duplicated from meshioConvert.ts's
 * isRectangularCellBlock rather than imported, to avoid a circular
 * meshioConvert.ts <-> meshioRegions.ts module dependency (meshioConvert.ts
 * already imports regionsToParts from here).
 */
function isRectangular(cb: MeshioAnyCellBlock): cb is MeshioCellBlock {
  return typeof (cb as MeshioCellBlock).nodesPerCell === "number";
}

/** A named group of entities, exactly as `@meshioplusplus/wasm` hands it over. */
export interface MeshioRegion {
  name: string;
  /**
   * What `entries` indexes:
   *  - `"point"` — point indices, one value per entry.
   *  - `"cell"`  — GLOBAL cell indices, block-major (block 0's cells first),
   *    one value per entry.
   *  - `"side"`  — `(global cell index, local facet index)` pairs, so two
   *    values per entry.
   */
  kind: "point" | "cell" | "side";
  /** Topological dimension the group was declared for, or -1 if unspecified. */
  dim: number;
  /** Format-native integer id (gmsh physical tag, Exodus set id), or -1. */
  tag: number;
  entries: Int32Array;
}

/**
 * Local node indices of one facet of a cell, in the meshio++ node order that
 * `detail/cell_faces.hpp` (3D) and `detail/cell_edges.hpp` (2D) define.
 *
 * KEEP IN SYNC with those two files.  The facet ORDER is what `side` regions
 * index, so a reordering upstream silently mislabels every side set — the
 * ordering is asserted in meshioRegions.test.ts against the values below.
 */
interface FacetDef {
  /** meshio++ type name of the facet cell. */
  type: string;
  /** Local node indices into the parent cell's connectivity row. */
  nodes: readonly number[];
}

/** Facet tables, keyed by the parent cell's meshio++ type name. */
const FACETS: Readonly<Record<string, readonly FacetDef[]>> = {
  // --- 3D: faces (cell_faces.cpp) ---
  tetra: [
    { type: "triangle", nodes: [0, 1, 3] },
    { type: "triangle", nodes: [1, 2, 3] },
    { type: "triangle", nodes: [2, 0, 3] },
    { type: "triangle", nodes: [0, 2, 1] },
  ],
  tetra10: [
    { type: "triangle6", nodes: [0, 1, 3, 4, 8, 7] },
    { type: "triangle6", nodes: [1, 2, 3, 5, 9, 8] },
    { type: "triangle6", nodes: [2, 0, 3, 6, 7, 9] },
    { type: "triangle6", nodes: [0, 2, 1, 6, 5, 4] },
  ],
  hexahedron: [
    { type: "quad", nodes: [0, 4, 7, 3] },
    { type: "quad", nodes: [1, 2, 6, 5] },
    { type: "quad", nodes: [0, 1, 5, 4] },
    { type: "quad", nodes: [3, 7, 6, 2] },
    { type: "quad", nodes: [0, 3, 2, 1] },
    { type: "quad", nodes: [4, 5, 6, 7] },
  ],
  hexahedron20: [
    { type: "quad8", nodes: [0, 4, 7, 3, 16, 15, 19, 11] },
    { type: "quad8", nodes: [1, 2, 6, 5, 9, 18, 13, 17] },
    { type: "quad8", nodes: [0, 1, 5, 4, 8, 17, 12, 16] },
    { type: "quad8", nodes: [3, 7, 6, 2, 19, 14, 18, 10] },
    { type: "quad8", nodes: [0, 3, 2, 1, 11, 10, 9, 8] },
    { type: "quad8", nodes: [4, 5, 6, 7, 12, 13, 14, 15] },
  ],
  hexahedron27: [
    { type: "quad9", nodes: [0, 4, 7, 3, 16, 15, 19, 11, 23] },
    { type: "quad9", nodes: [1, 2, 6, 5, 9, 18, 13, 17, 21] },
    { type: "quad9", nodes: [0, 1, 5, 4, 8, 17, 12, 16, 20] },
    { type: "quad9", nodes: [3, 7, 6, 2, 19, 14, 18, 10, 22] },
    { type: "quad9", nodes: [0, 3, 2, 1, 11, 10, 9, 8, 24] },
    { type: "quad9", nodes: [4, 5, 6, 7, 12, 13, 14, 15, 25] },
  ],
  wedge: [
    { type: "triangle", nodes: [0, 2, 1] },
    { type: "triangle", nodes: [3, 4, 5] },
    { type: "quad", nodes: [0, 1, 4, 3] },
    { type: "quad", nodes: [1, 2, 5, 4] },
    { type: "quad", nodes: [2, 0, 3, 5] },
  ],
  wedge15: [
    { type: "triangle6", nodes: [0, 2, 1, 8, 7, 6] },
    { type: "triangle6", nodes: [3, 4, 5, 9, 10, 11] },
    { type: "quad8", nodes: [0, 1, 4, 3, 6, 13, 9, 12] },
    { type: "quad8", nodes: [1, 2, 5, 4, 7, 14, 10, 13] },
    { type: "quad8", nodes: [2, 0, 3, 5, 8, 12, 11, 14] },
  ],
  pyramid: [
    { type: "quad", nodes: [0, 3, 2, 1] },
    { type: "triangle", nodes: [0, 1, 4] },
    { type: "triangle", nodes: [1, 2, 4] },
    { type: "triangle", nodes: [2, 3, 4] },
    { type: "triangle", nodes: [3, 0, 4] },
  ],
  pyramid13: [
    { type: "quad8", nodes: [0, 3, 2, 1, 8, 7, 6, 5] },
    { type: "triangle6", nodes: [0, 1, 4, 5, 10, 9] },
    { type: "triangle6", nodes: [1, 2, 4, 6, 11, 10] },
    { type: "triangle6", nodes: [2, 3, 4, 7, 12, 11] },
    { type: "triangle6", nodes: [3, 0, 4, 8, 9, 12] },
  ],
  // --- 2D: edges (cell_edges.cpp) ---
  triangle: [
    { type: "line", nodes: [0, 1] },
    { type: "line", nodes: [1, 2] },
    { type: "line", nodes: [2, 0] },
  ],
  triangle6: [
    { type: "line3", nodes: [0, 1, 3] },
    { type: "line3", nodes: [1, 2, 4] },
    { type: "line3", nodes: [2, 0, 5] },
  ],
  quad: [
    { type: "line", nodes: [0, 1] },
    { type: "line", nodes: [1, 2] },
    { type: "line", nodes: [2, 3] },
    { type: "line", nodes: [3, 0] },
  ],
  quad8: [
    { type: "line3", nodes: [0, 1, 4] },
    { type: "line3", nodes: [1, 2, 5] },
    { type: "line3", nodes: [2, 3, 6] },
    { type: "line3", nodes: [3, 0, 7] },
  ],
  // quad9 shares quad8's edges — node 8 (the center) is on no edge.
  quad9: [
    { type: "line3", nodes: [0, 1, 4] },
    { type: "line3", nodes: [1, 2, 5] },
    { type: "line3", nodes: [2, 3, 6] },
    { type: "line3", nodes: [3, 0, 7] },
  ],
};

/** Which cell block, and which row inside it, a global cell index refers to. */
interface CellLocator {
  /** Index into the original `mesh.cells`. */
  block: number;
  /** Row within that block. */
  row: number;
}

export interface RegionConversion {
  subModelParts: SubModelPart[];
  /** Boundary facets materialized from `side` regions, as Conditions blocks. */
  conditionBlocks: EntityBlock[];
}

export interface RegionConversionInput {
  regions: readonly MeshioRegion[] | undefined;
  /** The ORIGINAL meshio blocks — region cell indices are global over these. */
  cells: readonly MeshioAnyCellBlock[];
  /** Indices into `cells` that produced output (see meshioConvert's `kept`). */
  kept: readonly number[];
  /** Entities produced per kept cell, in kept order (buildBlocksFromOffsets). */
  expansion: ArrayLike<number>;
  /** First entity id `buildBlocksFromOffsets` assigned (its `startEntityId`). */
  firstEntityId?: number;
  nodeCount: number;
  diagnostics: MdpaDiagnostic[];
}

/**
 * Converts meshio++ regions into SubModelParts.
 *
 * Regions sharing a name are MERGED into one part — Abaqus routinely declares
 * an `*NSET` and an `*ELSET` under the same name, and they are the same named
 * group, so the part carries both its nodes and its elements.
 *
 * `cell` entries are global, block-major cell indices over the ORIGINAL meshio
 * blocks, while a SubModelPart holds entity IDs.  Those differ in two ways that
 * both have to be undone: a block whose type has no VTK equivalent is dropped
 * (so it contributes no entities while still consuming global indices), and
 * `buildBlocksFromOffsets` may fan one cell out into several entities (a
 * polygon becomes a triangle fan).  `expansion` is what makes the second
 * recoverable — the same array that keeps cell_data aligned.
 */
export function regionsToParts(input: RegionConversionInput): RegionConversion {
  const { regions, cells, kept, expansion, nodeCount, diagnostics } = input;
  if (!regions || regions.length === 0) {
    return { subModelParts: [], conditionBlocks: [] };
  }

  const keptSet = new Set(kept);
  let totalCells = 0;
  for (const cb of cells) totalCells += rowCount(cb);

  // Global cell index -> the entity ids it became, plus where it came from.
  const entityStart = new Int32Array(totalCells);
  const entityCount = new Int32Array(totalCells);
  const locator: CellLocator[] = new Array(totalCells);

  let globalIdx = 0;
  let localIdx = 0; // index into `expansion` (kept cells only)
  let nextId = input.firstEntityId ?? 1;
  for (let bi = 0; bi < cells.length; bi++) {
    const rows = rowCount(cells[bi]);
    const isKept = keptSet.has(bi);
    for (let row = 0; row < rows; row++, globalIdx++) {
      locator[globalIdx] = { block: bi, row };
      if (!isKept) continue;
      const n = expansion[localIdx] ?? 0;
      entityStart[globalIdx] = nextId;
      entityCount[globalIdx] = n;
      nextId += n;
      localIdx++;
    }
  }

  // One entry per distinct region name, in first-seen order.
  const parts = new Map<
    string,
    { nodeIds: number[]; elementIds: number[]; conditionIds: number[] }
  >();
  const partFor = (name: string) => {
    let p = parts.get(name);
    if (!p) {
      p = { nodeIds: [], elementIds: [], conditionIds: [] };
      parts.set(name, p);
    }
    return p;
  };

  const facetCells: { type: string; conn: number[]; regionName: string }[] = [];

  for (const region of regions) {
    const name = (region.name ?? "").trim();
    if (!name) {
      diagnostics.push({ line: 0, message: "Skipped an unnamed region." });
      continue;
    }
    const part = partFor(name);

    if (region.kind === "point") {
      let dropped = 0;
      for (const p of region.entries) {
        if (p < 0 || p >= nodeCount) dropped++;
        else part.nodeIds.push(p + 1); // finalizeModel synthesizes ids 1..N
      }
      if (dropped > 0) {
        diagnostics.push({
          line: 0,
          message: `Region "${name}": ${dropped} point index/indices out of range; skipped.`,
        });
      }
    } else if (region.kind === "cell") {
      let dropped = 0;
      for (const g of region.entries) {
        if (g < 0 || g >= totalCells || entityCount[g] === 0) {
          dropped++;
          continue;
        }
        for (let k = 0; k < entityCount[g]; k++) part.elementIds.push(entityStart[g] + k);
      }
      if (dropped > 0) {
        diagnostics.push({
          line: 0,
          message:
            `Region "${name}": ${dropped} cell(s) reference a block this ` +
            `extension cannot draw; omitted from the SubModelPart.`,
        });
      }
    } else if (region.kind === "side") {
      let dropped = 0;
      for (let i = 0; i + 1 < region.entries.length; i += 2) {
        const g = region.entries[i];
        const facet = region.entries[i + 1];
        const conn = facetConnectivity(g, facet, cells, locator, totalCells);
        if (!conn) {
          dropped++;
          continue;
        }
        facetCells.push({ ...conn, regionName: name });
      }
      if (dropped > 0) {
        diagnostics.push({
          line: 0,
          message:
            `Region "${name}": ${dropped} facet(s) on a cell type with no ` +
            `known facet table; omitted.`,
        });
      }
    }
  }

  // Materialize the facets: one Conditions block per (region, facet type), so
  // a surface spanning triangles and quads stays two well-formed blocks.
  const conditionBlocks: EntityBlock[] = [];
  const byKey = new Map<string, { type: string; region: string; conn: number[]; ids: number[] }>();
  let conditionId = 1;
  for (const fc of facetCells) {
    const key = `${fc.regionName}|${fc.type}`;
    let blk = byKey.get(key);
    if (!blk) {
      blk = { type: fc.type, region: fc.regionName, conn: [], ids: [] };
      byKey.set(key, blk);
    }
    blk.ids.push(conditionId);
    partFor(fc.regionName).conditionIds.push(conditionId);
    conditionId++;
    for (const n of fc.conn) blk.conn.push(n);
  }
  // A surface spanning both triangles and quads needs one block per type; only
  // then is the type worth spelling out in the layer name.
  const typesPerRegion = new Map<string, number>();
  for (const blk of byKey.values()) {
    typesPerRegion.set(blk.region, (typesPerRegion.get(blk.region) ?? 0) + 1);
  }
  for (const blk of byKey.values()) {
    const stride = blk.conn.length / blk.ids.length;
    const split = (typesPerRegion.get(blk.region) ?? 1) > 1;
    conditionBlocks.push({
      kind: "Conditions",
      name: split ? `${blk.region}:${blk.type}` : blk.region,
      vtkCellType: MESHIO_TO_VTK_TYPE[blk.type],
      count: blk.ids.length,
      stride,
      entityIds: Int32Array.from(blk.ids),
      connectivity: Int32Array.from(blk.conn),
    });
  }

  const subModelParts: SubModelPart[] = [];
  const usedPaths = new Set<string>();
  for (const [name, p] of parts) {
    if (p.nodeIds.length === 0 && p.elementIds.length === 0 && p.conditionIds.length === 0) {
      continue;
    }
    // Paths address parts in the outline tree and in export/delete/rename ops,
    // so a duplicate would make one of them unreachable.
    let path = name;
    for (let n = 2; usedPaths.has(path); n++) path = `${name}_${n}`;
    usedPaths.add(path);
    subModelParts.push({
      name: path,
      path,
      nodeIds: sortedUnique(p.nodeIds),
      elementIds: sortedUnique(p.elementIds),
      conditionIds: sortedUnique(p.conditionIds),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      children: [],
    });
  }

  return { subModelParts, conditionBlocks };
}

/**
 * Rows (cells) in a meshio block, whichever of the three shapes it is.
 *
 * This MUST count ragged (polygon/polyhedron) blocks correctly even though
 * meshioConvert.ts skips them (no ragged-cell rendering path): region `cell`/
 * `side` entries are global, block-major cell indices over meshio++'s ORIGINAL
 * `mesh.cells`, so undercounting a ragged block here would shift every
 * region index for every block that follows it.
 */
function rowCount(cb: MeshioAnyCellBlock): number {
  if (isRectangular(cb)) {
    return cb.nodesPerCell > 0 ? Math.floor(cb.data.length / cb.nodesPerCell) : 0;
  }
  const offsets = "rowOffsets" in cb ? cb.rowOffsets : cb.cellOffsets;
  return Math.max(0, offsets.length - 1);
}

/**
 * The 1-based node ids of one facet, or undefined when the parent cell type
 * has no facet table (or the indices are out of range).  A ragged block's
 * type is never a FACETS key, but the rectangular narrowing is made explicit
 * here rather than relying on that absence.
 */
function facetConnectivity(
  globalCell: number,
  facet: number,
  cells: readonly MeshioAnyCellBlock[],
  locator: readonly CellLocator[],
  totalCells: number
): { type: string; conn: number[] } | undefined {
  if (globalCell < 0 || globalCell >= totalCells) return undefined;
  const loc = locator[globalCell];
  const cb = cells[loc.block];
  if (!isRectangular(cb)) return undefined; // no facet table for a ragged block
  const table = FACETS[cb.type];
  if (!table || facet < 0 || facet >= table.length) return undefined;
  const def = table[facet];
  const base = loc.row * cb.nodesPerCell;
  const conn: number[] = [];
  for (const local of def.nodes) {
    if (local >= cb.nodesPerCell) return undefined;
    conn.push(cb.data[base + local] + 1); // 0-based -> 1-based node ids
  }
  return { type: def.type, conn };
}

/**
 * Ascending, de-duplicated ids as an Int32Array — the shape every
 * `SubModelPart` id list takes. Exported for `openfoamCase.ts`, which builds
 * parts from a different source but must produce the identical shape.
 */
export function sortedUnique(ids: number[]): Int32Array {
  if (ids.length === 0) return new Int32Array(0);
  ids.sort((a, b) => a - b);
  const out: number[] = [ids[0]];
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] !== ids[i - 1]) out.push(ids[i]);
  }
  return Int32Array.from(out);
}
