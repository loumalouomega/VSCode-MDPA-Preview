/**
 * View-only exploded view by top-level SubModelPart (roadmap item 61): each top-level
 * part is translated away from the model centre along the line to its own centre,
 * as a NEW display-only `MdpaModel`. Nothing is written and the history is untouched.
 *
 * A cell belongs to the FIRST top-level part listing its id; cells in no part stay where
 * they are. Nodes shared between parts are duplicated in the render copy only: the copy
 * of node `id` used by part `p` is `id + (p + 1) * nodeStride`, the copy used by the
 * unassigned cells keeps `id`. Entity ids are unchanged, so picks name their own id.
 *
 * `factor` 0 is the unexploded model (returned unchanged). At `factor` 1 the offsets are
 * scaled by the smallest `lambda >= 1` that separates every pair of part bounding boxes
 * along some axis; a pair that cannot be separated (identical centres, or an axis
 * restriction that leaves no free direction) is reported in `diagnostics`.
 */
import type { EntityBlock, FieldData, MdpaModel, SubModelPart } from "../types";
import { carryFieldMeta } from "../fieldDimensions";

export interface ExplodeSpec {
  /** 0 = unexploded, 1 = parts just separated, larger = further apart. */
  factor: number;
  /** Restrict the displacement to one axis (e.g. to open an assembly along z). */
  axis?: "x" | "y" | "z";
}

export interface ExplodeResult {
  model: MdpaModel;
  nodeStride: number;
  /** Number of top-level parts that carry cells and were moved. */
  parts: number;
  /** The lambda that separated the parts at factor 1 (1 when already apart). */
  separation: number;
  sourceNodeId(id: number): number;
  sourceEntityId(id: number): number;
  diagnostics: string[];
}

export const EXPLODE_MAX_FACTOR = 5;

type Box = { min: [number, number, number]; max: [number, number, number] };

export function explodeExpand(model: MdpaModel, spec: ExplodeSpec): ExplodeResult {
  const diagnostics: string[] = [];
  const factor = spec.factor;
  if (!Number.isFinite(factor) || factor < 0 || factor > EXPLODE_MAX_FACTOR) throw new Error(`Explode: factor must be between 0 and ${EXPLODE_MAX_FACTOR}.`);
  const nodeStride = model.nodeIds.reduce((m, id) => Math.max(m, id), 0);
  const identity = (): ExplodeResult => ({
    model, nodeStride, parts: 0, separation: 1,
    sourceNodeId: (id) => id, sourceEntityId: (id) => id, diagnostics,
  });
  const top: SubModelPart[] = model.subModelParts ?? [];
  if (factor === 0 || top.length === 0) {
    if (factor > 0) diagnostics.push("Explode: the mesh has no SubModelPart to separate.");
    return identity();
  }

  // Cell -> top-level part (first listing wins), per kind id space.
  const idKinds = ["Elements", "Conditions", "Geometries"] as const;
  const lists = (p: SubModelPart): Record<(typeof idKinds)[number], Int32Array> => ({
    Elements: p.elementIds, Conditions: p.conditionIds, Geometries: p.geometryIds,
  });
  const partOf: Record<(typeof idKinds)[number], Map<number, number>> = { Elements: new Map(), Conditions: new Map(), Geometries: new Map() };
  top.forEach((p, pi) => {
    const l = lists(p);
    for (const k of idKinds) for (const id of l[k]) if (!partOf[k].has(id)) partOf[k].set(id, pi);
  });

  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) nodeIndex.set(model.nodeIds[i], i);

  // Per-part node sets and boxes (from the cells assigned to it).
  const partNodes: Set<number>[] = top.map(() => new Set<number>());
  for (const b of model.blocks) {
    const map = partOf[b.kind];
    for (let c = 0; c < b.count; c++) {
      const pi = map.get(b.entityIds[c]);
      if (pi === undefined) continue;
      for (let k = 0; k < b.stride; k++) partNodes[pi].add(b.connectivity[c * b.stride + k]);
    }
  }
  const boxes: (Box | undefined)[] = partNodes.map((set) => {
    if (set.size === 0) return undefined;
    const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const id of set) {
      const i = nodeIndex.get(id);
      if (i === undefined) continue;
      for (let a = 0; a < 3; a++) {
        const v = model.coords[3 * i + a];
        if (v < box.min[a]) box.min[a] = v;
        if (v > box.max[a]) box.max[a] = v;
      }
    }
    return box;
  });
  const live = boxes.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  if (live.length === 0) {
    diagnostics.push("Explode: no top-level SubModelPart holds a cell.");
    return identity();
  }

  const centre: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) centre[a] = (model.bounds.min[a] + model.bounds.max[a]) / 2;
  const free = spec.axis ? [spec.axis === "x", spec.axis === "y", spec.axis === "z"] : [true, true, true];
  const dir: ([number, number, number] | undefined)[] = top.map((_, pi) => {
    const b = boxes[pi];
    if (!b) return undefined;
    return [0, 1, 2].map((a) => (free[a] ? (b.min[a] + b.max[a]) / 2 - centre[a] : 0)) as [number, number, number];
  });

  // Smallest lambda >= 1 separating every pair along some axis.
  let lambda = 1;
  for (let x = 0; x < live.length; x++) {
    for (let y = x + 1; y < live.length; y++) {
      const p = live[x], q = live[y];
      const bp = boxes[p]!, bq = boxes[q]!, up = dir[p]!, uq = dir[q]!;
      let need = Infinity;
      for (let a = 0; a < 3; a++) {
        // q above p: bp.max + L up < bq.min + L uq
        const d = uq[a] - up[a];
        if (d > 0) need = Math.min(need, (bp.max[a] - bq.min[a]) / d);
        else if (d < 0) need = Math.min(need, (bq.max[a] - bp.min[a]) / -d);
      }
      if (!Number.isFinite(need)) {
        diagnostics.push(`Explode: "${top[p].name}" and "${top[q].name}" share a centre${spec.axis ? " along the chosen axis" : ""} and cannot be separated.`);
      } else if (need > lambda) lambda = need;
    }
  }
  lambda = lambda * 1.001 + 1e-12; // strict separation, not touching
  const offset: ([number, number, number] | undefined)[] = dir.map((u) =>
    u ? [u[0] * lambda * factor, u[1] * lambda * factor, u[2] * lambda * factor] : undefined
  );

  // Which (part, node id) pairs the cells use; -1 part = unassigned cells.
  const used = new Map<number, Set<number>>(); // node id -> set of part indices (-1 allowed)
  const touch = (id: number, p: number): void => {
    let s = used.get(id);
    if (!s) used.set(id, (s = new Set()));
    s.add(p);
  };
  for (const b of model.blocks) {
    const map = partOf[b.kind];
    for (let c = 0; c < b.count; c++) {
      const p = map.get(b.entityIds[c]) ?? -1;
      for (let k = 0; k < b.stride; k++) touch(b.connectivity[c * b.stride + k], p);
    }
  }
  const newId = (id: number, p: number): number => (p < 0 || !offset[p] ? id : id + (p + 1) * nodeStride);

  const ids: number[] = [];
  const coordList: number[] = [];
  const variants = new Map<number, number[]>(); // original id -> new ids (for nodal fields)
  const variantPart = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) {
    const id = model.nodeIds[i];
    const parts = used.get(id);
    const list: number[] = [];
    const emit = (p: number): void => {
      const nid = newId(id, p);
      if (list.includes(nid)) return;
      list.push(nid);
      variantPart.set(nid, p);
      ids.push(nid);
      const o = p >= 0 ? offset[p] : undefined;
      for (let a = 0; a < 3; a++) coordList.push(model.coords[3 * i + a] + (o ? o[a] : 0));
    };
    if (!parts || parts.size === 0) emit(-1);
    else for (const p of [...parts].sort((a, b) => a - b)) emit(p);
    variants.set(id, list);
  }
  const nodeIds = Int32Array.from(ids);
  const coords = Float32Array.from(coordList);

  const blocks: EntityBlock[] = model.blocks.map((b) => {
    const map = partOf[b.kind];
    const conn = new Int32Array(b.connectivity.length);
    for (let c = 0; c < b.count; c++) {
      const p = map.get(b.entityIds[c]) ?? -1;
      for (let k = 0; k < b.stride; k++) conn[c * b.stride + k] = newId(b.connectivity[c * b.stride + k], p);
    }
    return { ...b, connectivity: conn };
  });

  const fields: FieldData[] = model.fields.map((f) => {
    if (f.kind !== "Nodal") return f;
    const w = f.components;
    const outIds: number[] = [];
    const rows: number[] = [];
    const fix: number[] = [];
    for (let r = 0; r < f.ids.length; r++) {
      const vs = variants.get(f.ids[r]) ?? [f.ids[r]];
      for (const v of vs) {
        outIds.push(v);
        for (let q = 0; q < w; q++) rows.push(f.values[r * w + q]);
        if (f.fixed) fix.push(f.fixed[r]);
      }
    }
    const out: FieldData = { ...f, ids: Int32Array.from(outIds), values: Float64Array.from(rows) };
    if (f.fixed) out.fixed = Uint8Array.from(fix); else delete out.fixed;
    return carryFieldMeta(f, out);
  });

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nodeIds.length; i++)
    for (let a = 0; a < 3; a++) {
      const v = coords[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }

  return {
    model: { ...model, nodeCount: nodeIds.length, nodeIds, coords, blocks, fields, bounds: { min, max }, derived: undefined },
    nodeStride,
    parts: live.length,
    separation: lambda,
    sourceNodeId: (id) => (id > nodeStride && nodeStride > 0 ? ((id - 1) % nodeStride) + 1 : id),
    sourceEntityId: (id) => id,
    diagnostics,
  };
}
