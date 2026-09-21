/**
 * WHERE a surface mesh is defective — the selectable half of the watertight
 * diagnostics.
 *
 * `watertight.ts` answers "how many" through meshio++ (host-only wasm) and
 * `meshNormals.ts` answers "which faces are wound against a neighbour"
 * natively. This module answers the remaining "which edges": the boundary
 * edges that make a hole and the non-manifold edges where three or more faces
 * meet, together with the inconsistently wound faces, so a UI can outline them
 * and the repair operation's before/after counts point at real geometry.
 *
 * Pure module (no vscode / DOM / wasm), bundled by both runtimes. It walks the
 * mesh's own SURFACE cells (triangles and quads of every kind); a volume mesh's
 * boundary is not a surface a repair could change, so its cells contribute
 * nothing here — `surfaceCellCount` says how much surface there was, so a
 * caller can tell "no defects" from "nothing to check".
 */

import { EntityBlock, EntityKind, MdpaModel } from "./types";
import { cellCategory, cornerCount } from "./writers/writerCommon";

export interface SurfaceDefects {
  /** Surface cells inspected (triangles + quads). Zero means there was nothing to check. */
  surfaceCellCount: number;
  /** Edges used by exactly one face — the rim of a hole. Node ids, ascending within each pair. */
  boundaryEdges: [number, number][];
  /** Edges used by three or more faces. */
  nonManifoldEdges: [number, number][];
  /** Faces sharing an edge with a neighbour wound the SAME way (flipped relative to it). */
  inconsistentFaces: { kind: EntityKind; id: number }[];
  /** Faces of zero area (their normal is undefined). */
  degenerateFaces: { kind: EntityKind; id: number }[];
}

interface EdgeRecord {
  lo: number;
  hi: number;
  count: number;
  /** Faces traversing the edge low→high vs high→low. */
  fwd: number;
  bwd: number;
  faces: number[];
}

function surfaceBlocks(model: MdpaModel): EntityBlock[] {
  return model.blocks.filter((b) => cellCategory(b.vtkCellType) === "surface");
}

export function surfaceDefects(model: MdpaModel): SurfaceDefects {
  const edges = new Map<string, EdgeRecord>();
  const faceRefs: { kind: EntityKind; id: number }[] = [];
  const degenerateFaces: { kind: EntityKind; id: number }[] = [];
  const index = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);

  for (const block of surfaceBlocks(model)) {
    const corners = Math.min(cornerCount(block.vtkCellType) || block.stride, block.stride);
    for (let c = 0; c < block.count; c++) {
      const ids: number[] = [];
      let ok = true;
      for (let k = 0; k < corners; k++) {
        const id = block.connectivity[c * block.stride + k];
        if (!index.has(id)) ok = false;
        ids.push(id);
      }
      if (!ok) continue;
      const ref = faceRefs.length;
      faceRefs.push({ kind: block.kind, id: block.entityIds[c] });

      // Newell normal length on the node ids' coordinates: zero => degenerate.
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < ids.length; i++) {
        const a = index.get(ids[i])! * 3;
        const b = index.get(ids[(i + 1) % ids.length])! * 3;
        nx += (model.coords[a + 1] - model.coords[b + 1]) * (model.coords[a + 2] + model.coords[b + 2]);
        ny += (model.coords[a + 2] - model.coords[b + 2]) * (model.coords[a] + model.coords[b]);
        nz += (model.coords[a] - model.coords[b]) * (model.coords[a + 1] + model.coords[b + 1]);
      }
      if (!(Math.hypot(nx, ny, nz) > 0)) degenerateFaces.push(faceRefs[ref]);

      for (let i = 0; i < ids.length; i++) {
        const a = ids[i];
        const b = ids[(i + 1) % ids.length];
        if (a === b) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = `${lo}>${hi}`;
        let rec = edges.get(key);
        if (!rec) {
          rec = { lo, hi, count: 0, fwd: 0, bwd: 0, faces: [] };
          edges.set(key, rec);
        }
        rec.count++;
        if (a === lo) rec.fwd++;
        else rec.bwd++;
        if (rec.faces.length < 2) rec.faces.push(ref);
      }
    }
  }

  const boundaryEdges: [number, number][] = [];
  const nonManifoldEdges: [number, number][] = [];
  const flipped = new Set<number>();
  for (const rec of edges.values()) {
    if (rec.count === 1) boundaryEdges.push([rec.lo, rec.hi]);
    else if (rec.count >= 3) nonManifoldEdges.push([rec.lo, rec.hi]);
    else if (rec.fwd === 2 || rec.bwd === 2) for (const f of rec.faces) flipped.add(f);
  }
  return {
    surfaceCellCount: faceRefs.length,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentFaces: [...flipped].sort((x, y) => x - y).map((i) => faceRefs[i]),
    degenerateFaces,
  };
}

/** One line for a status readout: the counts, and "nothing to check" for a mesh with no surface. */
export function surfaceDefectsSummary(d: SurfaceDefects): string {
  if (d.surfaceCellCount === 0) return "no surface cells to check";
  const parts: string[] = [];
  if (d.boundaryEdges.length > 0) parts.push(`${d.boundaryEdges.length} boundary edge(s)`);
  if (d.nonManifoldEdges.length > 0) parts.push(`${d.nonManifoldEdges.length} non-manifold edge(s)`);
  if (d.inconsistentFaces.length > 0) parts.push(`${d.inconsistentFaces.length} face(s) wound against a neighbour`);
  if (d.degenerateFaces.length > 0) parts.push(`${d.degenerateFaces.length} zero-area face(s)`);
  return parts.length > 0 ? parts.join(", ") : "closed, manifold and consistently wound";
}
