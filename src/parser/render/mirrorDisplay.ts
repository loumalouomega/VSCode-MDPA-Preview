/**
 * View-only mirror expansion (roadmap item 24, first increment).
 *
 * `mirrorExpand(model, plane)` returns a NEW `MdpaModel` holding the source mesh plus its
 * reflection about a plane. It is a display path, like the curved-cell subdivision: nothing
 * is written, the operation history never sees it, and the webview keeps the host's model
 * as the source of truth for edits and exports.
 *
 * Rules, each chosen so the expanded model behaves like any other model downstream:
 *  - nodes within `tolerance` of the plane are SHARED (one node, not two), so a symmetric
 *    half-plate becomes one connected plate;
 *  - every other node gets a reflected copy with id `id + nodeOffset`, and every entity a
 *    copy with id `id + entityOffset` (ONE offset across Elements/Conditions/Geometries, so
 *    an Elemental field spanning several id spaces still maps consistently);
 *  - a reflection reverses orientation, so linear cells are re-wound by a permutation
 *    (a mirrored tetrahedron would otherwise have negative volume). Quadratic cells
 *    use the same permutation extended over their mid-edge/face nodes; other types without a
 *    table are copied un-wound and reported;
 *  - vectors reflect as `v - 2 (v.n) n` (the normal component flips), 3x3 tensors as
 *    `R T R`; other widths are copied unchanged and reported, never guessed;
 *  - Properties and constraints stay the source's; the copy appears as blocks named
 *    `<name>_mirror`, and every SubModelPart gains a `<name>_mirror` copy (children included)
 *    whose node/entity ids follow the copies; constraint ids are not copied.
 *
 * Pure: no vscode/DOM/wasm, bundled by the webview.
 */
import { VtkCellType } from "../geometryMap";
import type { EntityBlock, FieldData, MdpaModel, SubModelPart } from "../types";
import { carryFieldMeta } from "../fieldDimensions";

export interface MirrorPlane {
  origin: [number, number, number];
  /** Need not be unit length; the zero vector is refused. */
  normal: [number, number, number];
  /** Distance under which a node counts as lying on the plane. Default 1e-6 x bbox diagonal. */
  tolerance?: number;
}

export interface MirrorResult {
  model: MdpaModel;
  /** Mirror copy id = source id + offset. Nodes on the plane are shared and keep their id. */
  nodeOffset: number;
  entityOffset: number;
  /** Maps any node id of the expanded model back to the source node id. */
  sourceNodeId(id: number): number;
  /** Maps any entity id of the expanded model back to the source entity id. */
  sourceEntityId(id: number): number;
  /** Nodes shared on the plane. */
  sharedNodes: number;
  diagnostics: string[];
}

/** Node-order permutation that restores positive orientation after a reflection. */
const REWIND: Record<number, number[]> = {
  [VtkCellType.TRIANGLE]: [0, 2, 1],
  [VtkCellType.QUAD]: [0, 3, 2, 1],
  [VtkCellType.TETRA]: [0, 2, 1, 3],
  [VtkCellType.HEXAHEDRON]: [0, 3, 2, 1, 4, 7, 6, 5],
  [VtkCellType.WEDGE]: [0, 2, 1, 3, 5, 4],
  [VtkCellType.PYRAMID]: [0, 3, 2, 1, 4],
  // Quadratic cells (VTK node order): the corners permute like the linear cell and every
  // mid-edge node follows its edge, i.e. new edge (a, b) takes the old node on edge
  // (perm[a], perm[b]). Face and body centres of the bi/tri-quadratic cells follow their face.
  [VtkCellType.QUADRATIC_TRIANGLE]: [0, 2, 1, 5, 4, 3],
  [VtkCellType.QUADRATIC_QUAD]: [0, 3, 2, 1, 7, 6, 5, 4],
  [VtkCellType.BIQUADRATIC_QUAD]: [0, 3, 2, 1, 7, 6, 5, 4, 8],
  [VtkCellType.QUADRATIC_TETRA]: [0, 2, 1, 3, 6, 5, 4, 7, 9, 8],
  [VtkCellType.QUADRATIC_HEXAHEDRON]: [0, 3, 2, 1, 4, 7, 6, 5, 11, 10, 9, 8, 15, 14, 13, 12, 16, 19, 18, 17],
  [VtkCellType.TRIQUADRATIC_HEXAHEDRON]: [
    0, 3, 2, 1, 4, 7, 6, 5, 11, 10, 9, 8, 15, 14, 13, 12, 16, 19, 18, 17, 22, 23, 20, 21, 24, 25, 26,
  ],
  [VtkCellType.QUADRATIC_WEDGE]: [0, 2, 1, 3, 5, 4, 8, 7, 6, 11, 10, 9, 12, 14, 13],
  [VtkCellType.QUADRATIC_PYRAMID]: [0, 3, 2, 1, 4, 8, 7, 6, 5, 9, 12, 11, 10],
};
/** Cells whose orientation a reflection does not change. */
const NO_REWIND = new Set<number>([VtkCellType.VERTEX, VtkCellType.LINE, VtkCellType.QUADRATIC_EDGE]);

function maxOf(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

export function mirrorExpand(model: MdpaModel, plane: MirrorPlane): MirrorResult {
  const diagnostics: string[] = [];
  let [nx, ny, nz] = plane.normal;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0) || !Number.isFinite(len)) throw new Error("Mirror: the plane normal is the zero vector.");
  nx /= len;
  ny /= len;
  nz /= len;
  const [ox, oy, oz] = plane.origin;

  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const tol = plane.tolerance ?? (diag > 0 ? diag * 1e-6 : 1e-12);

  const n = model.nodeCount;
  const nodeOffset = maxOf(model.nodeIds);
  let entityOffset = 0;
  for (const bl of model.blocks) entityOffset = Math.max(entityOffset, maxOf(bl.entityIds));

  // Nodes: reflect, share the ones on the plane.
  const onPlane = new Uint8Array(n);
  const mirrorCoords: number[] = [];
  const mirrorIds: number[] = [];
  let shared = 0;
  for (let i = 0; i < n; i++) {
    const x = model.coords[3 * i], y = model.coords[3 * i + 1], z = model.coords[3 * i + 2];
    const d = (x - ox) * nx + (y - oy) * ny + (z - oz) * nz;
    if (Math.abs(d) <= tol) {
      onPlane[i] = 1;
      shared++;
      continue;
    }
    mirrorIds.push(model.nodeIds[i] + nodeOffset);
    mirrorCoords.push(x - 2 * d * nx, y - 2 * d * ny, z - 2 * d * nz);
  }
  const total = n + mirrorIds.length;
  const nodeIds = new Int32Array(total);
  nodeIds.set(model.nodeIds);
  nodeIds.set(mirrorIds, n);
  const coords = new Float32Array(3 * total);
  coords.set(model.coords);
  coords.set(mirrorCoords, 3 * n);

  const idToIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) idToIndex.set(model.nodeIds[i], i);
  const mapNode = (id: number): number => {
    const i = idToIndex.get(id);
    if (i === undefined || onPlane[i]) return id;
    return id + nodeOffset;
  };

  // Blocks: mirrored copies appended after the originals.
  const blocks: EntityBlock[] = [...model.blocks];
  const unwound = new Set<number>();
  for (const bl of model.blocks) {
    const ct = bl.vtkCellType;
    const perm = ct === undefined ? undefined : REWIND[ct];
    if (!perm && !(ct !== undefined && NO_REWIND.has(ct))) unwound.add(ct ?? -1);
    const conn = new Int32Array(bl.connectivity.length);
    for (let c = 0; c < bl.count; c++) {
      const base = c * bl.stride;
      for (let k = 0; k < bl.stride; k++) {
        const src = perm && perm.length === bl.stride ? perm[k] : k;
        conn[base + k] = mapNode(bl.connectivity[base + src]);
      }
    }
    const ids = new Int32Array(bl.entityIds.length);
    for (let i = 0; i < ids.length; i++) ids[i] = bl.entityIds[i] + entityOffset;
    blocks.push({
      ...bl,
      name: `${bl.name}_mirror`,
      entityIds: ids,
      connectivity: conn,
      propertyIds: bl.propertyIds ? new Int32Array(bl.propertyIds) : undefined,
    });
  }
  if (unwound.size)
    diagnostics.push(
      `Mirror: cell type(s) ${[...unwound].join(", ")} have no re-winding table; their copies keep the source node order and may have reversed orientation.`
    );

  // SubModelParts: the source parts stay as they are and each gains a mirrored copy named
  // `<name>_mirror` (children included, paths rebuilt under the copy). Node lists go through
  // `mapNode` (on-plane nodes keep their id), entity lists are offset like the blocks'. Constraint
  // ids are dropped on the copy: constraints are not mirrored, so a copied id would name nothing.
  const mapIds = (a: Int32Array, f: (id: number) => number): Int32Array => {
    const out = new Int32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = f(a[i]);
    return out;
  };
  const mirrorSmp = (p: SubModelPart, parentPath: string): SubModelPart => {
    const name = `${p.name}_mirror`;
    const path = parentPath ? `${parentPath}/${name}` : name;
    return {
      name,
      path,
      nodeIds: mapIds(p.nodeIds, mapNode),
      elementIds: mapIds(p.elementIds, (id) => id + entityOffset),
      conditionIds: mapIds(p.conditionIds, (id) => id + entityOffset),
      geometryIds: mapIds(p.geometryIds, (id) => id + entityOffset),
      constraintIds: new Int32Array(0),
      children: p.children.map((c) => mirrorSmp(c, path)),
    };
  };
  const subModelParts: SubModelPart[] = [...model.subModelParts, ...model.subModelParts.map((p) => mirrorSmp(p, ""))];

  // Fields.
  const fields: FieldData[] = model.fields.map((f) => mirrorField(f, onPlane, idToIndex, nodeOffset, entityOffset, [nx, ny, nz], diagnostics));

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i++)
    for (let a = 0; a < 3; a++) {
      const v = coords[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }

  const out: MdpaModel = {
    ...model,
    nodeCount: total,
    nodeIds,
    coords,
    blocks,
    subModelParts,
    fields,
    bounds: total ? { min, max } : model.bounds,
    is3D: model.is3D || max[2] - min[2] > 0,
    derived: undefined,
  };
  return {
    model: out,
    nodeOffset,
    entityOffset,
    sourceNodeId: (id) => (id > nodeOffset ? id - nodeOffset : id),
    sourceEntityId: (id) => (id > entityOffset ? id - entityOffset : id),
    sharedNodes: shared,
    diagnostics,
  };
}

function mirrorField(
  f: FieldData,
  onPlane: Uint8Array,
  idToIndex: Map<number, number>,
  nodeOffset: number,
  entityOffset: number,
  nrm: [number, number, number],
  diagnostics: string[]
): FieldData {
  const w = f.components;
  const rows = f.ids.length;
  const nodal = f.kind === "Nodal";
  const keep: number[] = [];
  for (let r = 0; r < rows; r++) {
    if (nodal) {
      const i = idToIndex.get(f.ids[r]);
      if (i === undefined || onPlane[i]) continue;
    }
    keep.push(r);
  }
  const total = rows + keep.length;
  const ids = new Int32Array(total);
  ids.set(f.ids);
  const values = new Float64Array(total * w);
  values.set(f.values);
  const fixed = f.fixed ? new Uint8Array(total) : undefined;
  if (fixed && f.fixed) fixed.set(f.fixed);

  const [nx, ny, nz] = nrm;
  let warned = false;
  const reflectRow = (src: Float64Array, so: number, dst: Float64Array, dof: number): void => {
    if (w === 3) {
      const dot = src[so] * nx + src[so + 1] * ny + src[so + 2] * nz;
      dst[dof] = src[so] - 2 * dot * nx;
      dst[dof + 1] = src[so + 1] - 2 * dot * ny;
      dst[dof + 2] = src[so + 2] - 2 * dot * nz;
    } else if (w === 2 && Math.abs(nz) < 1e-12) {
      const dot = src[so] * nx + src[so + 1] * ny;
      dst[dof] = src[so] - 2 * dot * nx;
      dst[dof + 1] = src[so + 1] - 2 * dot * ny;
    } else if (w === 9) {
      // R = I - 2 n n^T, T' = R T R.
      const R = [
        1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz,
        -2 * ny * nx, 1 - 2 * ny * ny, -2 * ny * nz,
        -2 * nz * nx, -2 * nz * ny, 1 - 2 * nz * nz,
      ];
      const T = Array.from(src.subarray(so, so + 9));
      const RT = new Array<number>(9).fill(0);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          for (let k = 0; k < 3; k++) RT[3 * i + j] += R[3 * i + k] * T[3 * k + j];
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          let s = 0;
          for (let k = 0; k < 3; k++) s += RT[3 * i + k] * R[3 * k + j];
          dst[dof + 3 * i + j] = s;
        }
    } else {
      for (let c = 0; c < w; c++) dst[dof + c] = src[so + c];
      if (w > 1 && !warned) {
        warned = true;
        diagnostics.push(
          `Mirror: field ${f.variable} has ${w} components; its copy is not reflected (only 3-vectors, 3x3 tensors and planar 2-vectors are).`
        );
      }
    }
  };
  keep.forEach((r, k) => {
    const row = rows + k;
    ids[row] = f.ids[r] + (nodal ? nodeOffset : entityOffset);
    if (w === 1) values[row] = f.values[r];
    else reflectRow(f.values, r * w, values, row * w);
    if (fixed && f.fixed) fixed[row] = f.fixed[r];
  });
  const out: FieldData = { ...f, ids, values };
  if (fixed) out.fixed = fixed;
  return carryFieldMeta(f, out);
}
