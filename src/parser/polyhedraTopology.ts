/**
 * Records the ORIGINAL polyhedral cells of a read whose polyhedra were
 * decomposed into tetrahedra (polyhedronDecompose.ts), as the
 * `MdpaModel.polyhedra` side channel (types.ts `PolyhedralTopology`).
 *
 * Both readers that decompose (vtkXmlParser.ts, meshioConvert.ts) stage the
 * fan's tetrahedra as ordinary flat cells and hand them to
 * `buildBlocksFromOffsets`, which numbers every emitted entity consecutively
 * from 1 in flat order. So the Element ids of a polyhedron's tetrahedra follow
 * from where they sat in the flat list plus the per-flat-cell `expansion` that
 * call returns — this collector remembers that position and `build` turns it
 * into ids once the expansion is known.
 *
 * Pure; imports types only.
 */

import type { PolyhedralTopology } from "./types";

export class PolyhedraCollector {
  private readonly nodes: number[] = [];
  private readonly faceOffsets: number[] = [0];
  private readonly cellOffsets: number[] = [0];
  private readonly firstFlat: number[] = [];
  private readonly tetCount: number[] = [];
  private readonly apexIndices: number[] = [];

  get size(): number {
    return this.firstFlat.length;
  }

  /**
   * One decomposed polyhedron. `data`/`faceOffsets` describe its faces as 0-based
   * node INDICES (face f = data[faceOffsets[f]..faceOffsets[f+1])); `firstFlat`
   * is the flat-cell index of its first tetrahedron and `tets` how many follow.
   */
  add(data: ArrayLike<number>, faceOffsets: ArrayLike<number>, firstFlat: number, tets: number): void {
    if (tets <= 0 || faceOffsets.length < 2) return;
    const base = this.nodes.length;
    for (let i = 0; i < data.length; i++) this.nodes.push(data[i]);
    for (let f = 1; f < faceOffsets.length; f++) this.faceOffsets.push(base + faceOffsets[f]);
    this.cellOffsets.push(this.faceOffsets.length - 1);
    this.firstFlat.push(firstFlat);
    this.tetCount.push(tets);
  }

  /** The 0-based indices of nodes the decomposition invented. */
  addApex(first: number, count: number): void {
    for (let i = 0; i < count; i++) this.apexIndices.push(first + i);
  }

  /**
   * Resolves flat positions to Element ids. `flatExpansion[f]` is what
   * `buildBlocksFromOffsets` made of staged flat cell `f`; a polyhedron whose
   * tetrahedra did not each become exactly one entity is left out (it could not
   * be matched back to its children).
   */
  build(flatExpansion: ArrayLike<number>): PolyhedralTopology | undefined {
    if (this.size === 0) return undefined;
    const prefix = new Int32Array(flatExpansion.length + 1);
    for (let f = 0; f < flatExpansion.length; f++) prefix[f + 1] = prefix[f] + flatExpansion[f];

    const nodes: number[] = [];
    const faceOffsets: number[] = [0];
    const cellOffsets: number[] = [0];
    const childOffsets: number[] = [0];
    const childIds: number[] = [];
    for (let p = 0; p < this.size; p++) {
      const first = this.firstFlat[p];
      const n = this.tetCount[p];
      let ok = first + n <= flatExpansion.length;
      for (let t = 0; ok && t < n; t++) if (flatExpansion[first + t] !== 1) ok = false;
      if (!ok) continue;
      for (let t = 0; t < n; t++) childIds.push(prefix[first + t] + 1);
      childOffsets.push(childIds.length);
      for (let f = this.cellOffsets[p]; f < this.cellOffsets[p + 1]; f++) {
        for (let k = this.faceOffsets[f]; k < this.faceOffsets[f + 1]; k++) nodes.push(this.nodes[k] + 1); // index -> id
        faceOffsets.push(nodes.length);
      }
      cellOffsets.push(faceOffsets.length - 1);
    }
    const count = cellOffsets.length - 1;
    if (count === 0) return undefined;
    return {
      count,
      nodes: Int32Array.from(nodes),
      faceOffsets: Int32Array.from(faceOffsets),
      cellOffsets: Int32Array.from(cellOffsets),
      childOffsets: Int32Array.from(childOffsets),
      childIds: Int32Array.from(childIds),
      apexNodeIds: Int32Array.from(this.apexIndices, (i) => i + 1),
    };
  }
}

/** VTK_POLYHEDRON. */
export const VTK_POLYHEDRON = 42;

const childIndexCache = new WeakMap<PolyhedralTopology, Map<number, number>>();

/**
 * The polyhedron an Element (one of the tetrahedra it was decomposed into)
 * belongs to: its 0-based index in `topology` and how many tetrahedra it became.
 * This is the picking provenance — a click resolves to a tetrahedron, and this
 * names the cell the file actually described.
 */
export function polyhedronOfElement(
  topology: PolyhedralTopology | undefined,
  elementId: number
): { index: number; children: number } | undefined {
  if (!topology) return undefined;
  let map = childIndexCache.get(topology);
  if (!map) {
    map = new Map();
    for (let p = 0; p < topology.count; p++) {
      for (let k = topology.childOffsets[p]; k < topology.childOffsets[p + 1]; k++) map.set(topology.childIds[k], p);
    }
    childIndexCache.set(topology, map);
  }
  const index = map.get(elementId);
  if (index === undefined) return undefined;
  return { index, children: topology.childOffsets[index + 1] - topology.childOffsets[index] };
}
