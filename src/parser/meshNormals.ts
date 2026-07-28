/**
 * Face normals, and the orientation check they exist for.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable; the
 * webview bundles it through the Advanced ▸ Normals action.
 *
 * A normal is computed from the order the nodes are listed in, so drawing them
 * is the standard way to find an **inverted element**: one cell wound the wrong
 * way points its arrow against its neighbours, which is obvious on screen and
 * invisible in the numbers. The same winding also decides the sign of a
 * Jacobian, so a solver will either refuse the mesh or quietly integrate it
 * with a negative volume.
 *
 * `inconsistent` is the machine-checkable half of that: two faces sharing an
 * edge are consistently wound exactly when they traverse that edge in OPPOSITE
 * directions. A shared edge seen twice in the SAME direction means one of the
 * two is flipped relative to the other. This is a *relative* test — a mesh
 * whose faces are uniformly inside-out is self-consistent and reports zero, so
 * the arrows themselves remain the check for global orientation.
 *
 * Volume cells contribute their boundary faces, whose winding comes from
 * `volumeFaces`' tables rather than from the file, so they are consistent by
 * construction; the test bites on surface meshes (shells, skins, imported STL /
 * OBJ), which is exactly where a flipped element comes from in practice.
 */

import { EntityBlock, MdpaModel } from "./types";
import {
  cellCategory,
  cornerCount,
  nodeIndexMap,
  volumeFaces,
} from "./writers/writerCommon";

export interface MeshNormals {
  /** Face centroid xyz, 3 per face. */
  centroids: Float64Array;
  /** Unit face normal xyz, 3 per face. */
  normals: Float64Array;
  /** Faces that produced a normal. */
  count: number;
  /**
   * Faces sharing an edge with a neighbour wound the same way — i.e. flipped
   * relative to it. Zero for a consistently oriented mesh.
   */
  inconsistent: number;
  /** Entity ids of the cells those faces belong to (for highlighting). */
  inconsistentIds: number[];
  /** Faces skipped because they were degenerate (zero area). */
  degenerate: number;
}

/** Newell's method: robust for non-planar quads, and gives area-weighted length. */
function newellNormal(coords: Float32Array, poly: number[]): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] * 3;
    const b = poly[(i + 1) % poly.length] * 3;
    const ax = coords[a];
    const ay = coords[a + 1];
    const az = coords[a + 2];
    const bx = coords[b];
    const by = coords[b + 1];
    const bz = coords[b + 2];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  return [nx, ny, nz];
}

/**
 * Face normals for every surface cell and every volume-cell boundary face.
 *
 * Interior faces of a volume mesh are dropped (a face seen by two cells), so
 * what remains is the skin — the same rule `surfaceTriangles` uses, which is
 * what makes the arrows readable instead of a solid block of them.
 */
export function computeMeshNormals(model: MdpaModel): MeshNormals {
  const idToIndex = nodeIndexMap(model);
  /** Polygons to emit, with the cell they came from. */
  const polys: { poly: number[]; entityId: number }[] = [];
  /** Volume boundary faces, deduped: a face seen twice is interior. */
  const faceRecords = new Map<string, { poly: number[]; entityId: number; count: number }>();

  const cornerIndices = (block: EntityBlock, c: number, corners: number): number[] | null => {
    const out: number[] = [];
    for (let k = 0; k < corners; k++) {
      const idx = idToIndex.get(block.connectivity[c * block.stride + k]);
      if (idx === undefined) return null;
      out.push(idx);
    }
    return out;
  };

  for (const block of model.blocks) {
    const type = block.vtkCellType;
    const cat = cellCategory(type);
    if (cat !== "surface" && cat !== "volume") continue;
    const corners = Math.min(cornerCount(type) || block.stride, block.stride);
    for (let c = 0; c < block.count; c++) {
      const ci = cornerIndices(block, c, corners);
      if (!ci) continue;
      const entityId = block.entityIds[c];
      if (cat === "surface") {
        polys.push({ poly: ci, entityId });
      } else {
        for (const face of volumeFaces(type) ?? []) {
          const poly = face.map((li) => ci[li]);
          const key = [...poly].sort((a, b) => a - b).join(",");
          const rec = faceRecords.get(key);
          if (rec) rec.count++;
          else faceRecords.set(key, { poly, entityId, count: 1 });
        }
      }
    }
  }
  for (const rec of faceRecords.values()) {
    if (rec.count === 1) polys.push({ poly: rec.poly, entityId: rec.entityId }); // boundary only
  }

  const centroids = new Float64Array(polys.length * 3);
  const normals = new Float64Array(polys.length * 3);
  let count = 0;
  let degenerate = 0;

  // A directed edge "a>b" seen twice means the two faces sharing it are wound
  // the same way round, i.e. one is flipped relative to the other.
  const directed = new Map<string, number>();
  const flipped = new Set<number>();

  for (const { poly, entityId } of polys) {
    const [nx, ny, nz] = newellNormal(model.coords, poly);
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) {
      degenerate++;
      continue;
    }
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of poly) {
      cx += model.coords[p * 3];
      cy += model.coords[p * 3 + 1];
      cz += model.coords[p * 3 + 2];
    }
    centroids[count * 3] = cx / poly.length;
    centroids[count * 3 + 1] = cy / poly.length;
    centroids[count * 3 + 2] = cz / poly.length;
    normals[count * 3] = nx / len;
    normals[count * 3 + 1] = ny / len;
    normals[count * 3 + 2] = nz / len;
    count++;

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const key = `${a}>${b}`;
      const prior = directed.get(key);
      if (prior !== undefined) {
        flipped.add(entityId);
        flipped.add(prior);
      } else {
        directed.set(key, entityId);
      }
    }
  }

  return {
    centroids: centroids.subarray(0, count * 3),
    normals: normals.subarray(0, count * 3),
    count,
    inconsistent: flipped.size,
    inconsistentIds: Array.from(flipped),
    degenerate,
  };
}
