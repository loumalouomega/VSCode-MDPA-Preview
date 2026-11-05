/**
 * View-only sector repeat (roadmap item 24, third increment): `copies` rotated copies of
 * a cyclic-symmetry sector about the x, y or z axis, as a NEW display-only `MdpaModel`.
 *
 * Rotation preserves orientation, so no re-winding is needed. Nodes on the axis are shared;
 * seam nodes between neighbouring sectors are NOT welded (the copies coincide but stay
 * separate nodes, which is invisible in a display and keeps the id maps trivial).
 * Vectors rotate with the copy, 3x3 tensors as `R T Rᵀ`, scalars are copied, other widths
 * are copied and reported. Copy k of node/entity id is `id + k * stride`.
 */
import type { EntityBlock, FieldData, MdpaModel } from "../types";
import { carryFieldMeta } from "../fieldDimensions";

export interface SectorSpec {
  axis: "x" | "y" | "z";
  /** Number of copies including the original (>= 2). */
  copies: number;
  /** Angle between neighbouring copies; default 360 / copies. */
  angleDeg?: number;
}

export interface SectorResult {
  model: MdpaModel;
  nodeStride: number;
  entityStride: number;
  axisNodes: number;
  sourceNodeId(id: number): number;
  sourceEntityId(id: number): number;
  diagnostics: string[];
}

export const SECTOR_MAX_COPIES = 360;
export const SECTOR_MAX_CELLS = 2_000_000;

function rotationMatrix(axis: "x" | "y" | "z", th: number): number[] {
  const c = Math.cos(th), s = Math.sin(th);
  if (axis === "x") return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === "y") return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function sectorExpand(model: MdpaModel, spec: SectorSpec): SectorResult {
  const diagnostics: string[] = [];
  const copies = Math.floor(spec.copies);
  if (!(copies >= 2) || copies > SECTOR_MAX_COPIES) throw new Error(`Sector: copies must be between 2 and ${SECTOR_MAX_COPIES}.`);
  const step = ((spec.angleDeg ?? 360 / copies) * Math.PI) / 180;
  if (!Number.isFinite(step) || step === 0) throw new Error("Sector: the angle between copies must be non-zero.");
  const ai = spec.axis === "x" ? 0 : spec.axis === "y" ? 1 : 2;
  let srcCells = 0;
  for (const bl of model.blocks) srcCells += bl.count;
  if (srcCells * copies > SECTOR_MAX_CELLS)
    throw new Error(`Sector: ${srcCells} cells x ${copies} copies exceeds the view limit of ${SECTOR_MAX_CELLS}.`);

  const n = model.nodeCount;
  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const tol = Math.max(diag, 1) * 1e-9;
  const onAxis = new Uint8Array(n);
  let axisNodes = 0;
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    idToIndex.set(model.nodeIds[i], i);
    let r2 = 0;
    for (let a = 0; a < 3; a++) if (a !== ai) r2 += model.coords[3 * i + a] ** 2;
    if (Math.sqrt(r2) <= tol) { onAxis[i] = 1; axisNodes++; }
  }
  const nodeStride = model.nodeIds.reduce((m, id) => Math.max(m, id), 0);
  let entityStride = 0;
  for (const bl of model.blocks) for (const id of bl.entityIds) entityStride = Math.max(entityStride, id);
  const mapNode = (id: number, k: number): number => {
    const i = idToIndex.get(id);
    return i === undefined || onAxis[i] || k === 0 ? id : id + k * nodeStride;
  };

  const total = n + (copies - 1) * (n - axisNodes);
  const nodeIds = new Int32Array(total);
  const coords = new Float32Array(3 * total);
  let w = 0;
  for (let k = 0; k < copies; k++) {
    const R = rotationMatrix(spec.axis, k * step);
    for (let i = 0; i < n; i++) {
      if (k > 0 && onAxis[i]) continue;
      nodeIds[w] = mapNode(model.nodeIds[i], k);
      for (let a = 0; a < 3; a++)
        coords[3 * w + a] = R[3 * a] * model.coords[3 * i] + R[3 * a + 1] * model.coords[3 * i + 1] + R[3 * a + 2] * model.coords[3 * i + 2];
      w++;
    }
  }

  const blocks: EntityBlock[] = [];
  for (let k = 0; k < copies; k++) {
    for (const bl of model.blocks) {
      if (k === 0) { blocks.push(bl); continue; }
      const conn = new Int32Array(bl.connectivity.length);
      for (let i = 0; i < conn.length; i++) conn[i] = mapNode(bl.connectivity[i], k);
      const ids = new Int32Array(bl.entityIds.length);
      for (let i = 0; i < ids.length; i++) ids[i] = bl.entityIds[i] + k * entityStride;
      blocks.push({ ...bl, name: `${bl.name}_sector${k + 1}`, entityIds: ids, connectivity: conn, propertyIds: bl.propertyIds ? new Int32Array(bl.propertyIds) : undefined });
    }
  }

  const fields = model.fields.map((f) => sectorField(f, { onAxis, idToIndex, nodeStride, entityStride, copies, step, axis: spec.axis, diagnostics }));

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i++)
    for (let a = 0; a < 3; a++) {
      const v = coords[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  return {
    model: { ...model, nodeCount: total, nodeIds, coords, blocks, fields, bounds: { min, max }, is3D: true, derived: undefined },
    nodeStride, entityStride, axisNodes,
    sourceNodeId: (id) => (id > nodeStride && nodeStride > 0 ? ((id - 1) % nodeStride) + 1 : id),
    sourceEntityId: (id) => (id > entityStride && entityStride > 0 ? ((id - 1) % entityStride) + 1 : id),
    diagnostics,
  };
}

interface Ctx {
  onAxis: Uint8Array; idToIndex: Map<number, number>; nodeStride: number; entityStride: number;
  copies: number; step: number; axis: "x" | "y" | "z"; diagnostics: string[];
}

function sectorField(f: FieldData, c: Ctx): FieldData {
  const w = f.components, nodal = f.kind === "Nodal", rows = f.ids.length;
  const keepFor = (k: number): number[] => {
    const keep: number[] = [];
    for (let r = 0; r < rows; r++) {
      if (nodal && k > 0) { const i = c.idToIndex.get(f.ids[r]); if (i === undefined || c.onAxis[i]) continue; }
      keep.push(r);
    }
    return keep;
  };
  const per = Array.from({ length: c.copies }, (_, k) => keepFor(k));
  const total = per.reduce((s, a) => s + a.length, 0);
  const ids = new Int32Array(total), values = new Float64Array(total * w);
  const fixed = f.fixed ? new Uint8Array(total) : undefined;
  let o = 0, warned = false;
  for (let k = 0; k < c.copies; k++) {
    const R = rotationMatrix(c.axis, k * c.step);
    for (const r of per[k]) {
      const stride = nodal ? c.nodeStride : c.entityStride;
      const i = nodal ? c.idToIndex.get(f.ids[r]) : undefined;
      ids[o] = nodal && i !== undefined && c.onAxis[i] ? f.ids[r] : f.ids[r] + k * stride;
      const so = r * w, d = o * w;
      if (w === 1) values[d] = f.values[so];
      else if (w === 3) for (let a = 0; a < 3; a++) values[d + a] = R[3 * a] * f.values[so] + R[3 * a + 1] * f.values[so + 1] + R[3 * a + 2] * f.values[so + 2];
      else if (w === 9) {
        const T = Array.from(f.values.subarray(so, so + 9));
        const RT = new Array<number>(9).fill(0);
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let m = 0; m < 3; m++) RT[3 * a + b] += R[3 * a + m] * T[3 * m + b];
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { let s = 0; for (let m = 0; m < 3; m++) s += RT[3 * a + m] * R[3 * b + m]; values[d + 3 * a + b] = s; }
      } else {
        for (let q = 0; q < w; q++) values[d + q] = f.values[so + q];
        if (w > 1 && !warned) { warned = true; c.diagnostics.push(`Sector: field ${f.variable} has ${w} components; its copies are not rotated (only 3-vectors and 3x3 tensors are).`); }
      }
      if (fixed && f.fixed) fixed[o] = f.fixed[r];
      o++;
    }
  }
  const out: FieldData = { ...f, ids, values };
  if (fixed) out.fixed = fixed; else delete out.fixed;
  return carryFieldMeta(f, out);
}
