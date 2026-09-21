/**
 * Giving the cells an operation CREATED an identity: which block they belong to,
 * which property they carry, which SubModelParts list them, and what their
 * elemental/conditional fields say — inherited from the SOURCE cells they
 * replace.
 *
 * Pure module (no vscode / DOM / wasm). Needed by the operations whose meshio++
 * result has NO cell correspondence with its input (surface remeshing, volume
 * meshing, tetrahedral optimization): upstream drops `cell_data` and cell
 * regions for them, so every produced cell arrives with a fresh id, a
 * synthesized block name and no group membership. This module is the explicit
 * policy that puts those back, in two tiers:
 *
 * 1. **Exact match by node set.** When node ids survive the operation (a point
 *    set that is unchanged, as in `optimizeVolume`), a produced cell whose sorted
 *    corner ids equal a source cell's IS that cell — same entity id, block,
 *    property, parts and field values. Only the cells the operation actually
 *    changed are new.
 * 2. **Nearest source cell.** Every other cell inherits BLOCK, PROPERTY, PARTS and
 *    FIELD VALUES from the source cell whose centroid is nearest (a uniform-grid
 *    search), with a FRESH entity id — it is a new cell, only its context is
 *    carried. Nearest-centroid is an approximation and the report says how many
 *    cells took it; a part boundary that runs through a re-meshed patch is
 *    resolved at the resolution of the new cells.
 *
 * Fresh ids start past the largest id of that kind anywhere in the source, so
 * they can never collide with a kept cell or with entities the caller re-attaches
 * from outside the operation's scope.
 */

import { EntityBlock, EntityKind, FieldData, MdpaModel, SubModelPart } from "./types";
import { cellCategory } from "./writers/writerCommon";
import { definedConstraintIds } from "./constraintsParser";
import { VtkCellType } from "./geometryMap";

export interface InheritOptions {
  /** Which source cells may lend identity, and which adopted cells receive it. */
  category: "surface" | "volume";
  /** Try the exact node-set match first (needs the operation to have preserved node ids). */
  matchByNodes: boolean;
  /**
   * Force every produced cell to this kind (e.g. the boundary faces of a freshly
   * generated volume mesh are Conditions even when the surface they were
   * generated from was a shell of Elements). A cell whose source is of another
   * kind keeps the source's PROPERTY and PARTS but not its block — a block named
   * for an element type is not a valid condition — and takes a default name.
   */
  targetKind?: EntityKind;
}

/** A Kratos-legal default block name for a produced cell type, when no source block lends one. */
export function defaultBlockName(kind: EntityKind, vtkCellType: number | undefined): string {
  const C = VtkCellType;
  if (kind === "Conditions") {
    if (vtkCellType === C.TRIANGLE) return "SurfaceCondition3D3N";
    if (vtkCellType === C.QUAD) return "SurfaceCondition3D4N";
    if (vtkCellType === C.LINE) return "LineCondition3D2N";
    if (vtkCellType === C.VERTEX) return "PointCondition3D1N";
  } else if (kind === "Elements") {
    if (vtkCellType === C.TETRA) return "Element3D4N";
    if (vtkCellType === C.HEXAHEDRON) return "Element3D8N";
    if (vtkCellType === C.TRIANGLE) return "Element2D3N";
    if (vtkCellType === C.QUAD) return "Element2D4N";
    if (vtkCellType === C.LINE) return "Element2D2N";
  }
  return `${kind === "Elements" ? "Element" : kind === "Conditions" ? "Condition" : "Geometry"}_${vtkCellType ?? "x"}`;
}

export interface InheritResult {
  model: MdpaModel;
  /** Cells that kept their source identity through an exact node-set match. */
  matched: number;
  /** Cells that inherited context from the nearest source cell (fresh id). */
  inherited: number;
  /** Cells with no source cell to inherit from (the source had no cell of that category). */
  orphaned: number;
}

interface SrcCell {
  kind: EntityKind;
  id: number;
  blockIndex: number;
  cellIndex: number;
  vtkCellType: number | undefined;
  stride: number;
  centroid: [number, number, number];
}

function centroidOf(coordOf: (id: number) => [number, number, number] | undefined, ids: ArrayLike<number>, n: number): [number, number, number] | undefined {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k < n; k++) {
    const p = coordOf(ids[k]);
    if (!p) return undefined;
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / n, y / n, z / n];
}

/** A uniform grid over the source centroids, for nearest-neighbour lookups. */
class CentroidGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly size: number;
  private readonly min: [number, number, number];
  constructor(private readonly src: SrcCell[]) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of src) for (let k = 0; k < 3; k++) {
      if (c.centroid[k] < min[k]) min[k] = c.centroid[k];
      if (c.centroid[k] > max[k]) max[k] = c.centroid[k];
    }
    this.min = min;
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-12);
    // About one source centroid per grid cell in the populated dimensions.
    this.size = span / Math.max(1, Math.ceil(Math.cbrt(src.length)));
    src.forEach((c, i) => {
      const key = this.key(c.centroid);
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
  }
  private coord(p: [number, number, number]): [number, number, number] {
    return [Math.floor((p[0] - this.min[0]) / this.size), Math.floor((p[1] - this.min[1]) / this.size), Math.floor((p[2] - this.min[2]) / this.size)];
  }
  private key(p: [number, number, number]): string {
    const c = this.coord(p);
    return `${c[0]},${c[1]},${c[2]}`;
  }
  /** Index into `src` of the nearest centroid. */
  nearest(p: [number, number, number]): number {
    const [cx, cy, cz] = this.coord(p);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring < 4096; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
        const list = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const c = this.src[i].centroid;
          const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      // Anything in a farther ring is at least (ring) cells away.
      if (best >= 0 && Math.sqrt(bestD) <= ring * this.size) break;
    }
    return best;
  }
}

const KINDS: EntityKind[] = ["Elements", "Conditions", "Geometries"];

export function inheritCellIdentity(base: MdpaModel, adopted: MdpaModel, opts: InheritOptions): InheritResult {
  const baseIdx = new Map<number, number>();
  for (let i = 0; i < base.nodeCount; i++) baseIdx.set(base.nodeIds[i], i);
  const adoptedIdx = new Map<number, number>();
  for (let i = 0; i < adopted.nodeCount; i++) adoptedIdx.set(adopted.nodeIds[i], i);
  const coordOfBase = (id: number): [number, number, number] | undefined => {
    const i = baseIdx.get(id);
    return i === undefined ? undefined : [base.coords[i * 3], base.coords[i * 3 + 1], base.coords[i * 3 + 2]];
  };
  const coordOfAdopted = (id: number): [number, number, number] | undefined => {
    const i = adoptedIdx.get(id);
    return i === undefined ? undefined : [adopted.coords[i * 3], adopted.coords[i * 3 + 1], adopted.coords[i * 3 + 2]];
  };

  // Source cells of the category, with their centroids and (for matching) node-set keys.
  const src: SrcCell[] = [];
  const byKey = new Map<string, number>();
  base.blocks.forEach((b, bi) => {
    if (cellCategory(b.vtkCellType) !== opts.category) return;
    for (let c = 0; c < b.count; c++) {
      const ids = b.connectivity.subarray(c * b.stride, (c + 1) * b.stride);
      const ctr = centroidOf(coordOfBase, ids, b.stride);
      if (!ctr) continue;
      const idx = src.length;
      src.push({ kind: b.kind, id: b.entityIds[c], blockIndex: bi, cellIndex: c, vtkCellType: b.vtkCellType, stride: b.stride, centroid: ctr });
      if (opts.matchByNodes) byKey.set([...ids].sort((x, y) => x - y).join(","), idx);
    }
  });

  const nextId: Record<EntityKind, number> = { Elements: 0, Conditions: 0, Geometries: 0 };
  for (const b of base.blocks) for (const id of b.entityIds) if (id > nextId[b.kind]) nextId[b.kind] = id;
  for (const k of KINDS) nextId[k]++;

  const grid = src.length > 0 ? new CentroidGrid(src) : undefined;

  // One group per (source block, produced cell type).
  interface Group { srcBlock: number; vtkCellType: number | undefined; stride: number; kind: EntityKind; entityIds: number[]; propertyIds: number[]; conn: number[]; srcRef: SrcCell[] }
  const groups = new Map<string, Group>();
  let matched = 0;
  let inherited = 0;
  let orphaned = 0;
  const orphanBlocks: EntityBlock[] = [];

  for (const ab of adopted.blocks) {
    if (cellCategory(ab.vtkCellType) !== opts.category) {
      orphanBlocks.push(ab);
      continue;
    }
    for (let c = 0; c < ab.count; c++) {
      const ids = ab.connectivity.subarray(c * ab.stride, (c + 1) * ab.stride);
      let ref: SrcCell | undefined;
      let keepId = false;
      if (opts.matchByNodes) {
        const hit = byKey.get([...ids].sort((x, y) => x - y).join(","));
        if (hit !== undefined && src[hit].vtkCellType === ab.vtkCellType) {
          ref = src[hit];
          keepId = true;
        }
      }
      if (!ref && grid) {
        const ctr = centroidOf(coordOfAdopted, ids, ab.stride);
        if (ctr) ref = src[grid.nearest(ctr)];
      }
      if (!ref) {
        orphaned++;
        const key = `orphan|${ab.kind}|${ab.vtkCellType}|${ab.stride}`;
        let g = groups.get(key);
        if (!g) {
          g = { srcBlock: -1, vtkCellType: ab.vtkCellType, stride: ab.stride, kind: ab.kind, entityIds: [], propertyIds: [], conn: [], srcRef: [] };
          groups.set(key, g);
        }
        g.entityIds.push(ab.entityIds[c]);
        g.propertyIds.push(0);
        g.conn.push(...ids);
        continue;
      }
      // A produced cell of a different type than the block it would join keeps its own block.
      const sameType = ref.vtkCellType === ab.vtkCellType;
      const kind: EntityKind = opts.targetKind ?? (sameType ? ref.kind : ab.kind);
      const srcBlock = sameType && ref.kind === kind ? ref.blockIndex : -1;
      const key = `${srcBlock}|${kind}|${ab.vtkCellType}|${ab.stride}`;
      let g = groups.get(key);
      if (!g) {
        g = { srcBlock, vtkCellType: ab.vtkCellType, stride: ab.stride, kind, entityIds: [], propertyIds: [], conn: [], srcRef: [] };
        groups.set(key, g);
      }
      const id = keepId ? ref.id : nextId[kind]++;
      if (keepId) matched++;
      else inherited++;
      g.entityIds.push(id);
      g.propertyIds.push(base.blocks[ref.blockIndex].propertyIds?.[ref.cellIndex] ?? 0);
      g.conn.push(...ids);
      g.srcRef.push(ref);
    }
  }

  const blocks: EntityBlock[] = [];
  for (const g of groups.values()) {
    const source = g.srcBlock >= 0 ? base.blocks[g.srcBlock] : undefined;
    const hasProp = g.propertyIds.some((p) => p !== 0);
    blocks.push({
      kind: g.kind,
      name: source ? source.name : defaultBlockName(g.kind, g.vtkCellType),
      vtkCellType: g.vtkCellType,
      count: g.entityIds.length,
      stride: g.stride,
      entityIds: Int32Array.from(g.entityIds),
      propertyIds: hasProp ? Int32Array.from(g.propertyIds) : undefined,
      connectivity: Int32Array.from(g.conn),
    });
  }
  blocks.push(...orphanBlocks);

  // Cell fields: the value of each produced cell's source cell. Nodal fields stay as adopted.
  const newFields: FieldData[] = adopted.fields.filter((f) => f.kind === "Nodal");
  for (const f of base.fields) {
    if (f.kind === "Nodal") continue;
    const want: EntityKind = f.kind === "Elemental" ? "Elements" : "Conditions";
    const rowOf = new Map<number, number>();
    for (let i = 0; i < f.ids.length; i++) rowOf.set(f.ids[i], i);
    const c = Math.max(1, f.components);
    const ids: number[] = [];
    const values: number[] = [];
    for (const g of groups.values()) {
      if (g.kind !== want) continue;
      g.srcRef.forEach((ref, i) => {
        const row = rowOf.get(ref.id);
        if (row === undefined || ref.kind !== want) return;
        ids.push(g.entityIds[i]);
        for (let k = 0; k < c; k++) values.push(f.values[row * c + k]);
      });
    }
    if (ids.length > 0) newFields.push({ kind: f.kind, variable: f.variable, components: f.components, ids: Int32Array.from(ids), values: Float64Array.from(values) });
  }

  // SubModelParts: replace the category cells' ids with the produced cells that inherited membership.
  const replaced: Record<EntityKind, Set<number>> = { Elements: new Set(), Conditions: new Set(), Geometries: new Set() };
  for (const s of src) replaced[s.kind].add(s.id);
  // source (kind,id) -> produced ids
  const producedBySource = new Map<string, { kind: EntityKind; id: number }[]>();
  for (const g of groups.values()) g.srcRef.forEach((ref, i) => {
    const key = `${ref.kind}:${ref.id}`;
    const entry = { kind: g.kind, id: g.entityIds[i] };
    const list = producedBySource.get(key);
    if (list) list.push(entry);
    else producedBySource.set(key, [entry]);
  });
  const producedNodes = new Map<string, Set<number>>(); // source key -> corner node ids of its produced cells
  for (const g of groups.values()) g.srcRef.forEach((ref, i) => {
    const key = `${ref.kind}:${ref.id}`;
    const s = producedNodes.get(key) ?? new Set<number>();
    for (let k = 0; k < g.stride; k++) s.add(g.conn[i * g.stride + k]);
    producedNodes.set(key, s);
  });
  // Constraints were maintained by the adoption (a constraint naming a lost node is gone); a part
  // keeps the ids of those that survive.
  const liveConstraints = new Set(definedConstraintIds(adopted.constraints));
  const fixPart = (p: SubModelPart): SubModelPart => {
    const lists: Record<EntityKind, number[]> = {
      Elements: [...p.elementIds].filter((id) => !replaced.Elements.has(id)),
      Conditions: [...p.conditionIds].filter((id) => !replaced.Conditions.has(id)),
      Geometries: [...p.geometryIds].filter((id) => !replaced.Geometries.has(id)),
    };
    const nodes = new Set<number>([...p.nodeIds].filter((id) => adoptedIdx.has(id)));
    const own: Record<EntityKind, Set<number>> = { Elements: new Set(p.elementIds), Conditions: new Set(p.conditionIds), Geometries: new Set(p.geometryIds) };
    for (const s of src) {
      if (!own[s.kind].has(s.id)) continue;
      for (const e of producedBySource.get(`${s.kind}:${s.id}`) ?? []) lists[e.kind].push(e.id);
      for (const n of producedNodes.get(`${s.kind}:${s.id}`) ?? []) nodes.add(n);
    }
    const sorted = (a: number[]): Int32Array => Int32Array.from([...new Set(a)].sort((x, y) => x - y));
    return {
      ...p,
      nodeIds: sorted([...nodes]),
      elementIds: sorted(lists.Elements),
      conditionIds: sorted(lists.Conditions),
      geometryIds: sorted(lists.Geometries),
      constraintIds: adopted.constraints ? p.constraintIds.filter((id) => liveConstraints.has(id)) : new Int32Array(0),
      children: p.children.map(fixPart),
    };
  };

  return {
    model: { ...adopted, blocks, fields: newFields, subModelParts: base.subModelParts.map(fixPart) },
    matched,
    inherited,
    orphaned,
  };
}
