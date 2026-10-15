/**
 * Isoparametric tessellation of curved cells into linear simplices, adopted in
 * place (see adoptOp.ts) through meshio++'s `tessellate` (>= 16.42.0).
 *
 * Every `triangle6`, `quad8`, `quad9`, `tetra10` and `hexahedron27` cell is
 * sampled on a reference lattice and mapped through its own shape functions, so
 * a curved quadratic element becomes a cluster of straight triangles/tetrahedra
 * that follows its curvature (the viewer and most downstream tools only draw
 * the linear skeleton). Every other cell passes through unchanged.
 *
 * Pure module (no vscode / DOM). Measured against the live wasm, and why this
 * module does more than call `runAdoptingOp`:
 *
 * - Upstream REPLICATES a parent's `mdpa:id`/`kratos:kind`/property carrier onto
 *   every child, so the generic adoption would hand duplicate ids to a fresh-id
 *   pass. Here the first child keeps the parent's id and its siblings take
 *   fresh ids past the largest of that kind (each kind is its own id space),
 *   assigned BEFORE adoption so the mapping parent id -> child ids is known.
 * - Upstream DROPS every cell region, so the SubModelPart entity lists would
 *   come back empty. They are rebuilt from the base tree: each list maps through
 *   the parent -> children table, and node lists gain the closure of the child
 *   cells (the new mid-edge nodes). The parent/child subset rule holds because
 *   the mapping is monotone.
 * - Blocks come back named after the meshio type (`tetra`), which Kratos cannot
 *   instantiate; they are renamed with `defaultBlockName`.
 * - Nodal fields are interpolated by upstream (kept), Elemental/Conditional
 *   values are copied onto the children, and the Nodal `fixed` flag, which the
 *   carrier mechanism never recovers, is restored for the nodes that existed.
 */

import { EntityBlock, EntityKind, FieldData, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { VtkCellType } from "./geometryMap";
import { runAdoptingOp } from "./adoptOp";
import { defaultBlockName } from "./cellInheritance";
import { carryFieldMeta } from "./fieldDimensions";

export interface TessellateParams {
  /**
   * Divisions per axis for `quad8`/`quad9`/`hexahedron27` and recursive splits
   * (`2^levels` divisions per edge) for `triangle6`/`tetra10` (default 2).
   */
  levels?: number;
}

export const TESSELLATE_MAX_LEVELS = 5;
/** Refuse a request whose estimated output would exceed this many cells. */
export const TESSELLATE_MAX_CELLS = 5_000_000;

export type TessellateOutcome =
  | { model: MdpaModel; changed: true; message: string }
  | { model: MdpaModel; changed: false; message: string };

const C = VtkCellType;
const CURVED_TYPES = new Set<number>([C.QUADRATIC_TRIANGLE, C.QUADRATIC_QUAD, C.BIQUADRATIC_QUAD, C.QUADRATIC_TETRA, C.TRIQUADRATIC_HEXAHEDRON]);
const KIND_CODE: Record<EntityKind, number> = { Elements: 0, Conditions: 1, Geometries: 2 };
const CODE_KIND: EntityKind[] = ["Elements", "Conditions", "Geometries"];

export function isCurvedCellType(t: number | undefined): boolean {
  return t !== undefined && CURVED_TYPES.has(t);
}

/** Linear children one curved cell becomes at `levels` (an estimate of what `tessellate` emits). */
export function childrenPerCell(vtkCellType: number | undefined, levels: number): number {
  switch (vtkCellType) {
    case C.QUADRATIC_TRIANGLE:
      return 4 ** levels;
    case C.QUADRATIC_TETRA:
      return 8 ** levels;
    case C.QUADRATIC_QUAD:
    case C.BIQUADRATIC_QUAD:
      return 2 * Math.max(1, levels) ** 2;
    case C.TRIQUADRATIC_HEXAHEDRON:
      return 6 * Math.max(1, levels) ** 3;
    default:
      return 1;
  }
}

export function estimateTessellatedCells(model: MdpaModel, levels: number): number {
  let n = 0;
  for (const b of model.blocks) n += b.count * (isCurvedCellType(b.vtkCellType) ? childrenPerCell(b.vtkCellType, levels) : 1);
  return n;
}

type NumArr = { length: number; [i: number]: number | bigint };
const num = (a: NumArr, i: number): number => Number(a[i]);
function put(a: NumArr, i: number, v: number): void {
  (a as unknown as Record<number, number | bigint>)[i] = a instanceof BigInt64Array || a instanceof BigUint64Array ? BigInt(v) : v;
}

function maxIdPerKind(model: MdpaModel): number[] {
  const max = [0, 0, 0];
  for (const b of model.blocks) {
    const k = KIND_CODE[b.kind];
    for (let i = 0; i < b.count; i++) if (b.entityIds[i] > max[k]) max[k] = b.entityIds[i];
  }
  return max;
}

/** Build the parent -> child id table and make every output cell id unique (first child keeps its parent's id). */
function assignChildIds(mesh: { cell_data?: Record<string, unknown[]> }, base: MdpaModel): Map<number, Map<number, number[]>> {
  const ids = mesh.cell_data?.["mdpa:id"] as NumArr[] | undefined;
  const kinds = mesh.cell_data?.["kratos:kind"] as NumArr[] | undefined;
  const table = new Map<number, Map<number, number[]>>([[0, new Map()], [1, new Map()], [2, new Map()]]);
  if (!ids || !kinds) return table;
  const counter = maxIdPerKind(base);
  for (let b = 0; b < ids.length; b++) {
    for (let i = 0; i < ids[b].length; i++) {
      const k = num(kinds[b], i);
      const parent = num(ids[b], i);
      const byParent = table.get(k) ?? new Map<number, number[]>();
      table.set(k, byParent);
      const list = byParent.get(parent);
      if (!list) {
        byParent.set(parent, [parent]);
      } else {
        const fresh = ++counter[k];
        put(ids[b], i, fresh);
        list.push(fresh);
      }
    }
  }
  return table;
}

function mapIds(ids: Int32Array, byParent: Map<number, number[]> | undefined): number[] {
  const out: number[] = [];
  if (!byParent) return out;
  for (const id of ids) {
    const kids = byParent.get(id);
    if (kids) for (const k of kids) out.push(k);
  }
  return out;
}

function rebuildParts(
  parts: SubModelPart[],
  table: Map<number, Map<number, number[]>>,
  nodesOf: (kind: number, id: number) => ArrayLike<number> | undefined,
  existingNodes: Set<number>
): SubModelPart[] {
  return parts.map((p) => {
    const elementIds = mapIds(p.elementIds, table.get(0));
    const conditionIds = mapIds(p.conditionIds, table.get(1));
    const geometryIds = mapIds(p.geometryIds, table.get(2));
    const nodes = new Set<number>();
    for (const n of p.nodeIds) if (existingNodes.has(n)) nodes.add(n);
    for (const [k, ids] of [[0, elementIds], [1, conditionIds], [2, geometryIds]] as [number, number[]][]) {
      for (const id of ids) {
        const nn = nodesOf(k, id);
        if (nn) for (let j = 0; j < nn.length; j++) nodes.add(nn[j]);
      }
    }
    const sorted = (a: number[] | Set<number>) => Int32Array.from(a).sort();
    return {
      ...p,
      nodeIds: sorted(nodes),
      elementIds: sorted(elementIds),
      conditionIds: sorted(conditionIds),
      geometryIds: sorted(geometryIds),
      children: rebuildParts(p.children, table, nodesOf, existingNodes),
    };
  });
}

/** Carry the Nodal `fixed` flag (never recovered by adoption) onto the nodes that already existed. */
function restoreFixedFlags(out: FieldData, base: MdpaModel): FieldData {
  if (out.kind !== "Nodal") return out;
  const src = base.fields.find((f) => f.kind === "Nodal" && f.variable === out.variable);
  if (!src?.fixed) return out;
  const fixed = new Map<number, number>();
  for (let i = 0; i < src.ids.length; i++) if (src.fixed[i]) fixed.set(src.ids[i], 1);
  if (fixed.size === 0) return out;
  const flags = new Uint8Array(out.ids.length);
  for (let i = 0; i < out.ids.length; i++) flags[i] = fixed.get(out.ids[i]) ?? 0;
  return { ...out, fixed: flags };
}

export async function tessellateModel(
  model: MdpaModel,
  params: TessellateParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<TessellateOutcome> {
  const levels = params.levels ?? 2;
  const curved = model.blocks.filter((b) => isCurvedCellType(b.vtkCellType));
  if (curved.length === 0) {
    return {
      model,
      changed: false,
      message:
        "No curved cells to tessellate. Tessellation handles 6-node triangles, 8/9-node quads, 10-node tetrahedra and 27-node hexahedra; linear cells and the other quadratic types (20-node hexahedra, 15-node wedges, 13-node pyramids) pass through unchanged.",
    };
  }
  const estimate = estimateTessellatedCells(model, levels);
  if (estimate > TESSELLATE_MAX_CELLS) {
    return {
      model,
      changed: false,
      message: `Tessellating at ${levels} level(s) would create about ${estimate.toLocaleString("en-US")} cells (limit ${TESSELLATE_MAX_CELLS.toLocaleString("en-US")}). Use fewer levels.`,
    };
  }
  let table = new Map<number, Map<number, number[]>>();
  const run = await runAdoptingOp(
    model,
    diagnostics,
    "tessellate",
    (m, mesh) => m.tessellate(mesh, levels, true, true, false),
    {
      patchResult: (r) => {
        table = assignChildIds(r.mesh as unknown as { cell_data?: Record<string, unknown[]> }, model);
      },
    }
  );
  if (!run) return { model, changed: false, message: "Nothing to tessellate." };
  const r = run.result;

  // Blocks: upstream names them after the meshio type, which Kratos cannot instantiate.
  const taken = new Set<string>();
  const blocks: EntityBlock[] = run.model.blocks.map((b) => {
    let name = defaultBlockName(b.kind, b.vtkCellType);
    if (taken.has(`${b.kind}:${name}`)) name = b.name;
    taken.add(`${b.kind}:${name}`);
    return { ...b, name };
  });

  // SubModelParts: upstream dropped the cell regions, so rebuild from the base tree.
  const location = new Map<string, EntityBlock>();
  const offsetOf = new Map<string, number>();
  for (const b of blocks) {
    const k = KIND_CODE[b.kind];
    for (let i = 0; i < b.count; i++) {
      location.set(`${k}:${b.entityIds[i]}`, b);
      offsetOf.set(`${k}:${b.entityIds[i]}`, i);
    }
  }
  const nodesOf = (kind: number, id: number): ArrayLike<number> | undefined => {
    const key = `${kind}:${id}`;
    const b = location.get(key);
    if (!b) return undefined;
    const o = offsetOf.get(key) ?? 0;
    return b.connectivity.subarray(o * b.stride, (o + 1) * b.stride);
  };
  const baseNodes = new Set<number>(model.nodeIds);
  const subModelParts = model.subModelParts.length > 0 ? rebuildParts(model.subModelParts, table, nodesOf, baseNodes) : run.model.subModelParts;

  const fields = run.model.fields.map((f) => {
    const src = model.fields.find((s) => s.kind === f.kind && s.variable === f.variable);
    return carryFieldMeta(src, restoreFixedFlags(f, model));
  });

  const out: MdpaModel = { ...run.model, blocks, subModelParts, fields };
  const added = out.nodeCount - model.nodeCount;
  const cellsAfter = out.blocks.reduce((s, b) => s + b.count, 0);
  const cellsBefore = model.blocks.reduce((s, b) => s + b.count, 0);
  const parts = [
    `Tessellated ${r.numCurvedSourceCells} curved cell(s) at ${levels} level(s): ${cellsBefore} → ${cellsAfter} cells, ${model.nodeCount} → ${out.nodeCount} nodes (${added} new).`,
    r.numPassThroughSourceCells > 0 ? `${r.numPassThroughSourceCells} cell(s) of other types passed through unchanged.` : "",
    r.numFacetsWithBadCount === 0
      ? "The tessellation is conforming (every interior facet is shared by exactly two cells)."
      : `Warning: ${r.numFacetsWithBadCount} facet(s) do not have a conforming cell count.`,
    "Each child keeps its parent's property, SubModelParts and cell-field values; the first child keeps the parent's id and its siblings take fresh ids.",
  ];
  return { model: out, changed: true, message: parts.filter(Boolean).join(" ") };
}
