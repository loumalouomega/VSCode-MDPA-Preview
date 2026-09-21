/**
 * Comparing two meshes and their fields.
 *
 * Pure module (no vscode / DOM / wasm) for the structural and by-id half;
 * `compareFieldModel` adds the meshio++ point-sampling half for the SPATIAL
 * correspondence and is therefore async.
 *
 * ## Why native, not `diff`/`meshesEqual`
 *
 * meshio++'s `diff` compares two meshio meshes, and getting an `MdpaModel` into
 * one is the lossy round trip: entity ids, Elements/Conditions/Geometries kinds,
 * Properties and SubModelParts are gone by then, and upstream does not compare
 * named sets at all. This comparison is over the models themselves, so it says
 * which NODE ID moved, which ELEMENT 7 changed its connectivity, which
 * SubModelPart gained a member — and, because it works by id, it is inherently
 * order-free (upstream's `unordered` mode is the same idea for anonymous cells).
 *
 * ## Two correspondences, two different questions
 *
 * - **By id** asks "what happened to THIS entity": the same node id, the same
 *   element id, read from the other file. It needs the two meshes to share an
 *   id space (a re-run, an edit, a restart) and never invents a value.
 * - **Spatial** asks "what is the OTHER mesh's field where MY nodes are":
 *   barycentric point sampling through meshio++'s `interpolate`, for meshes with
 *   different discretizations of the same domain. It is deliberately not the
 *   mass-preserving `transferField` — that conserves totals and smooths, this
 *   samples — and a node outside the other mesh, or one whose sampling cell has
 *   a node with no value, is UNCOVERED: reported, written as a gap, never 0.
 */

import { EntityKind, FieldBlockKind, FieldData, MdpaModel, SubModelPart } from "./types";
import { modelToMeshio } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { attachCellField, attachNodalField } from "./meshioAdapter";
import { isValidFieldName } from "./fieldManage";

export interface CompareOptions {
  /** Absolute tolerance: `|a − b| <= atol + rtol·|b|` counts as equal (default 0). */
  atol?: number;
  /** Relative tolerance (default 0). */
  rtol?: number;
}

export interface FieldComparison {
  kind: FieldBlockKind;
  variable: string;
  /** Present in only one of the two meshes. */
  onlyIn?: "A" | "B";
  /** Same name, different widths: not compared. */
  shapeMismatch?: { a: number; b: number };
  components: number;
  /** Ids carrying a value in both. */
  compared: number;
  /** Ids with a value in A only / B only — coverage gaps, never counted as 0. */
  onlyInAIds: number;
  onlyInBIds: number;
  /** max |a − b| over compared rows and components (norm of the row difference for a vector). */
  maxAbs: number;
  /** id of the row where `maxAbs` occurs. */
  worstId?: number;
  meanAbs: number;
  rms: number;
  /** max |a − b| / |b| over rows where |b| > 0. */
  maxRel: number;
  /** Rows outside `atol + rtol·|b|`. */
  exceeding: number;
  /** Every compared value is bit-equal. */
  exact: boolean;
}

export interface EntityComparison {
  countA: number;
  countB: number;
  common: number;
  onlyInA: number;
  onlyInB: number;
  /** Same id, different node list (order matters — it is the winding). */
  connectivityChanged: number;
  /** Same id, different cell type. */
  typeChanged: number;
}

export interface PartDifference {
  path: string;
  /** Per list: how many ids only A / only B holds. */
  differences: { list: string; onlyInA: number; onlyInB: number }[];
}

export interface MeshComparison {
  verdict: "identical" | "equal within tolerance" | "different";
  nodes: {
    countA: number;
    countB: number;
    common: number;
    onlyInA: number;
    onlyInB: number;
    /** Common nodes whose coordinates differ by more than the tolerance. */
    moved: number;
    maxCoordDiff: number;
    worstId?: number;
  };
  entities: Record<EntityKind, EntityComparison>;
  blocks: { onlyInA: string[]; onlyInB: string[] };
  subModelParts: { onlyInA: string[]; onlyInB: string[]; differing: PartDifference[] };
  fields: FieldComparison[];
  messages: string[];
}

const within = (a: number, b: number, atol: number, rtol: number): boolean =>
  a === b || Math.abs(a - b) <= atol + rtol * Math.abs(b);

interface CellRef {
  type: number | undefined;
  nodes: number[];
}

function cellsByKind(m: MdpaModel): Record<EntityKind, Map<number, CellRef>> {
  const out: Record<EntityKind, Map<number, CellRef>> = {
    Elements: new Map(),
    Conditions: new Map(),
    Geometries: new Map(),
  };
  for (const b of m.blocks) {
    for (let c = 0; c < b.count; c++) {
      out[b.kind].set(b.entityIds[c], {
        type: b.vtkCellType,
        nodes: Array.from(b.connectivity.subarray(c * b.stride, (c + 1) * b.stride)),
      });
    }
  }
  return out;
}

function flattenParts(parts: SubModelPart[], into = new Map<string, SubModelPart>()): Map<string, SubModelPart> {
  for (const p of parts) {
    into.set(p.path, p);
    flattenParts(p.children, into);
  }
  return into;
}

function setDiff(a: ArrayLike<number>, b: ArrayLike<number>): [number, number] {
  const sa = new Set<number>();
  for (let i = 0; i < a.length; i++) sa.add(a[i]);
  const sb = new Set<number>();
  for (let i = 0; i < b.length; i++) sb.add(b[i]);
  let onlyA = 0;
  for (const v of sa) if (!sb.has(v)) onlyA++;
  let onlyB = 0;
  for (const v of sb) if (!sa.has(v)) onlyB++;
  return [onlyA, onlyB];
}

const PART_LISTS: [string, (p: SubModelPart) => ArrayLike<number>][] = [
  ["nodes", (p) => p.nodeIds],
  ["elements", (p) => p.elementIds],
  ["conditions", (p) => p.conditionIds],
  ["geometries", (p) => p.geometryIds],
  ["constraints", (p) => p.constraintIds],
];

/** Row difference statistics between two fields' shared ids; a vector row's difference is its Euclidean norm. */
export function compareFieldData(a: FieldData, b: FieldData, atol: number, rtol: number): FieldComparison {
  const base: FieldComparison = {
    kind: a.kind,
    variable: a.variable,
    components: a.components,
    compared: 0,
    onlyInAIds: 0,
    onlyInBIds: 0,
    maxAbs: 0,
    meanAbs: 0,
    rms: 0,
    maxRel: 0,
    exceeding: 0,
    exact: true,
  };
  if (a.components !== b.components) return { ...base, shapeMismatch: { a: a.components, b: b.components } };
  const c = Math.max(1, a.components);
  const rowB = new Map<number, number>();
  for (let i = 0; i < b.ids.length; i++) rowB.set(b.ids[i], i);
  let sum = 0;
  let sumSq = 0;
  const seen = new Set<number>();
  for (let i = 0; i < a.ids.length; i++) {
    const j = rowB.get(a.ids[i]);
    if (j === undefined) {
      base.onlyInAIds++;
      continue;
    }
    seen.add(a.ids[i]);
    let d2 = 0;
    let nb2 = 0;
    let ok = true;
    let same = true;
    for (let k = 0; k < c; k++) {
      const va = a.values[i * c + k];
      const vb = b.values[j * c + k];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) {
        // A non-finite value on either side is a gap, not a difference of 0.
        ok = false;
        break;
      }
      d2 += (va - vb) * (va - vb);
      nb2 += vb * vb;
      if (va !== vb) same = false;
    }
    if (!ok) {
      base.onlyInAIds++; // present but undefined: uncovered, like a missing row
      continue;
    }
    base.compared++;
    const d = Math.sqrt(d2);
    const nb = Math.sqrt(nb2);
    if (!same) base.exact = false;
    if (d > base.maxAbs) {
      base.maxAbs = d;
      base.worstId = a.ids[i];
    }
    sum += d;
    sumSq += d2;
    if (nb > 0) base.maxRel = Math.max(base.maxRel, d / nb);
    // A row is within tolerance when every component is.
    let rowWithin = true;
    for (let k = 0; k < c; k++) {
      if (!within(a.values[i * c + k], b.values[j * c + k], atol, rtol)) rowWithin = false;
    }
    if (!rowWithin) base.exceeding++;
  }
  for (let j = 0; j < b.ids.length; j++) if (!seen.has(b.ids[j])) base.onlyInBIds++;
  if (base.compared > 0) {
    base.meanAbs = sum / base.compared;
    base.rms = Math.sqrt(sumSq / base.compared);
  }
  return base;
}

export function compareMeshes(a: MdpaModel, b: MdpaModel, opts: CompareOptions = {}): MeshComparison {
  const atol = opts.atol ?? 0;
  const rtol = opts.rtol ?? 0;
  const messages: string[] = [];

  // --- nodes ---
  const idxB = new Map<number, number>();
  for (let i = 0; i < b.nodeCount; i++) idxB.set(b.nodeIds[i], i);
  let common = 0;
  let moved = 0;
  let maxCoordDiff = 0;
  let worstId: number | undefined;
  let exactNodes = true;
  const seenNodes = new Set<number>();
  for (let i = 0; i < a.nodeCount; i++) {
    const j = idxB.get(a.nodeIds[i]);
    if (j === undefined) continue;
    common++;
    seenNodes.add(a.nodeIds[i]);
    let rowMoved = false;
    for (let k = 0; k < 3; k++) {
      const va = a.coords[i * 3 + k];
      const vb = b.coords[j * 3 + k];
      const d = Math.abs(va - vb);
      if (d > maxCoordDiff) {
        maxCoordDiff = d;
        worstId = a.nodeIds[i];
      }
      if (va !== vb) exactNodes = false;
      if (!within(va, vb, atol, rtol)) rowMoved = true;
    }
    if (rowMoved) moved++;
  }
  const nodes = {
    countA: a.nodeCount,
    countB: b.nodeCount,
    common,
    onlyInA: a.nodeCount - common,
    onlyInB: b.nodeCount - common,
    moved,
    maxCoordDiff,
    worstId,
  };

  // --- entities, per kind (independent id spaces) ---
  const ca = cellsByKind(a);
  const cb = cellsByKind(b);
  const entities = {} as Record<EntityKind, EntityComparison>;
  let structureExact = exactNodes && nodes.onlyInA === 0 && nodes.onlyInB === 0;
  let structureWithin = moved === 0 && nodes.onlyInA === 0 && nodes.onlyInB === 0;
  for (const kind of ["Elements", "Conditions", "Geometries"] as EntityKind[]) {
    let comm = 0;
    let connectivityChanged = 0;
    let typeChanged = 0;
    for (const [id, ra] of ca[kind]) {
      const rb = cb[kind].get(id);
      if (!rb) continue;
      comm++;
      if (ra.type !== rb.type) typeChanged++;
      else if (ra.nodes.length !== rb.nodes.length || ra.nodes.some((n, i) => n !== rb.nodes[i])) connectivityChanged++;
    }
    entities[kind] = {
      countA: ca[kind].size,
      countB: cb[kind].size,
      common: comm,
      onlyInA: ca[kind].size - comm,
      onlyInB: cb[kind].size - comm,
      connectivityChanged,
      typeChanged,
    };
    const e = entities[kind];
    if (e.onlyInA || e.onlyInB || e.connectivityChanged || e.typeChanged) {
      structureExact = false;
      structureWithin = false;
    }
  }

  // --- blocks and SubModelParts ---
  const namesA = new Set(a.blocks.map((x) => x.name));
  const namesB = new Set(b.blocks.map((x) => x.name));
  const blocks = {
    onlyInA: [...namesA].filter((n) => !namesB.has(n)),
    onlyInB: [...namesB].filter((n) => !namesA.has(n)),
  };
  if (blocks.onlyInA.length || blocks.onlyInB.length) {
    structureExact = false;
    structureWithin = false;
  }
  const pa = flattenParts(a.subModelParts);
  const pb = flattenParts(b.subModelParts);
  const differing: PartDifference[] = [];
  for (const [path, part] of pa) {
    const other = pb.get(path);
    if (!other) continue;
    const diffs: PartDifference["differences"] = [];
    for (const [list, get] of PART_LISTS) {
      const [oa, ob] = setDiff(get(part), get(other));
      if (oa || ob) diffs.push({ list, onlyInA: oa, onlyInB: ob });
    }
    if (diffs.length) differing.push({ path, differences: diffs });
  }
  const subModelParts = {
    onlyInA: [...pa.keys()].filter((p) => !pb.has(p)),
    onlyInB: [...pb.keys()].filter((p) => !pa.has(p)),
    differing,
  };
  if (subModelParts.onlyInA.length || subModelParts.onlyInB.length || differing.length) {
    structureExact = false;
    structureWithin = false;
  }

  // --- fields ---
  const fields: FieldComparison[] = [];
  const keyOf = (f: FieldData): string => `${f.kind}:${f.variable}`;
  const fa = new Map(a.fields.map((f) => [keyOf(f), f]));
  const fb = new Map(b.fields.map((f) => [keyOf(f), f]));
  let fieldsExact = true;
  let fieldsWithin = true;
  for (const [key, f] of fa) {
    const g = fb.get(key);
    if (!g) {
      fields.push({ kind: f.kind, variable: f.variable, onlyIn: "A", components: f.components, compared: 0, onlyInAIds: f.ids.length, onlyInBIds: 0, maxAbs: 0, meanAbs: 0, rms: 0, maxRel: 0, exceeding: 0, exact: false });
      fieldsExact = false;
      fieldsWithin = false;
      continue;
    }
    const r = compareFieldData(f, g, atol, rtol);
    fields.push(r);
    if (r.shapeMismatch || r.onlyInAIds || r.onlyInBIds) {
      fieldsExact = false;
      fieldsWithin = false;
    } else {
      if (!r.exact) fieldsExact = false;
      if (r.exceeding > 0) fieldsWithin = false;
    }
  }
  for (const [key, g] of fb) {
    if (fa.has(key)) continue;
    fields.push({ kind: g.kind, variable: g.variable, onlyIn: "B", components: g.components, compared: 0, onlyInAIds: 0, onlyInBIds: g.ids.length, maxAbs: 0, meanAbs: 0, rms: 0, maxRel: 0, exceeding: 0, exact: false });
    fieldsExact = false;
    fieldsWithin = false;
  }

  if (nodes.onlyInA || nodes.onlyInB) {
    messages.push(`${nodes.onlyInA} node id(s) only in A and ${nodes.onlyInB} only in B — the two meshes do not share an id space there.`);
  }
  const verdict: MeshComparison["verdict"] =
    structureExact && fieldsExact ? "identical" : structureWithin && fieldsWithin ? "equal within tolerance" : "different";
  return { verdict, nodes, entities, blocks, subModelParts, fields, messages };
}

// --- the comparison as an OPERATION: difference fields -------------------------------

export type Correspondence = "id" | "spatial";
export const CORRESPONDENCES: readonly Correspondence[] = ["id", "spatial"];

export interface CompareFieldParams {
  /** The field (in this mesh) to compare, and where it lives. */
  variable: string;
  kind: FieldBlockKind;
  /** The field's name in the OTHER mesh, when it differs. */
  sourceVariable?: string;
  correspondence?: Correspondence;
  /** Base name for the written fields `<base>_DIFF`, `<base>_ABS`, `<base>_REL` (default: the variable). */
  output?: string;
  atol?: number;
  rtol?: number;
}

export interface CompareFieldResult {
  model: MdpaModel;
  written: string[];
  comparison?: FieldComparison;
  /** Rows of THIS mesh with no value from the other side (outside it, or coverage gaps). */
  uncovered: number;
  message?: string;
}

/** The other mesh's values at THIS mesh's nodes, by barycentric sampling; NaN where uncovered. */
async function sampleNodalFrom(a: MdpaModel, b: MdpaModel, field: FieldData): Promise<FieldData> {
  const src = modelToMeshio(b, [], { dim: 3 });
  if (src.cells.length === 0) throw new Error("The other mesh has no cells to sample from.");
  const c = Math.max(1, field.components);
  const rowOf = new Map<number, number>();
  for (let i = 0; i < field.ids.length; i++) rowOf.set(field.ids[i], i);
  const vals = new Float64Array(b.nodeCount * c);
  const cover = new Float64Array(b.nodeCount);
  for (let i = 0; i < b.nodeCount; i++) {
    const r = rowOf.get(b.nodeIds[i]);
    if (r === undefined) continue;
    let ok = true;
    for (let k = 0; k < c; k++) if (!Number.isFinite(field.values[r * c + k])) ok = false;
    if (!ok) continue;
    cover[i] = 1;
    for (let k = 0; k < c; k++) vals[i * c + k] = field.values[r * c + k];
  }
  src.point_data = { cmp_value: vals, cmp_cover: cover } as unknown as typeof src.point_data;
  src.point_data_components = c > 1 ? { cmp_value: c } : {};
  src.cell_data = {};
  src.cell_data_components = {};
  src.regions = [];
  const pts = new Float64Array(a.nodeCount * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = a.coords[i];
  const target = { dim: 3, points: pts, cells: [], point_data: {}, cell_data: {}, field_data: {} } as unknown as typeof src;
  const m = await loadMeshio();
  const out = m.interpolate(src, target, "barycentric", ["cmp_value", "cmp_cover"], false, NaN, "error");
  const v = out.point_data?.["cmp_value"] as ArrayLike<number> | undefined;
  const cv = out.point_data?.["cmp_cover"] as ArrayLike<number> | undefined;
  if (!v || !cv) throw new Error("meshio++ interpolate returned no sampled values.");
  const ids: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < a.nodeCount; i++) {
    // Covered only when the sample lies inside B AND every corner it interpolated had a value.
    if (!(Math.abs(Number(cv[i]) - 1) < 1e-9)) continue;
    let ok = true;
    for (let k = 0; k < c; k++) if (!Number.isFinite(Number(v[i * c + k]))) ok = false;
    if (!ok) continue;
    ids.push(a.nodeIds[i]);
    for (let k = 0; k < c; k++) values.push(Number(v[i * c + k]));
  }
  return { kind: "Nodal", variable: field.variable, components: field.components, ids: Int32Array.from(ids), values: Float64Array.from(values) };
}

export async function compareFieldModel(
  a: MdpaModel,
  b: MdpaModel,
  params: CompareFieldParams
): Promise<CompareFieldResult> {
  const none = (message: string): CompareFieldResult => ({ model: a, written: [], uncovered: 0, message });
  const mine = a.fields.find((f) => f.kind === params.kind && f.variable === params.variable);
  if (!mine) return none(`No ${params.kind} field named "${params.variable}" in this mesh.`);
  const theirName = params.sourceVariable ?? params.variable;
  const theirs = b.fields.find((f) => f.kind === params.kind && f.variable === theirName);
  if (!theirs) return none(`The other mesh has no ${params.kind} field named "${theirName}".`);
  if (mine.components !== theirs.components) {
    return none(`"${params.variable}" has ${mine.components} component(s) here and ${theirs.components} in the other mesh.`);
  }
  const base = params.output ?? params.variable;
  if (!isValidFieldName(base)) return none(`"${base}" is not a valid Kratos variable name.`);
  const correspondence = params.correspondence ?? "id";
  if (correspondence === "spatial" && params.kind !== "Nodal") {
    return none(
      "Spatial sampling compares NODAL fields (it samples the other mesh at this mesh's nodes). " +
        "Move a cell field to the nodes with Average field first, or compare by id."
    );
  }
  const atol = params.atol ?? 0;
  const rtol = params.rtol ?? 0;
  const other = correspondence === "spatial" ? await sampleNodalFrom(a, b, theirs) : theirs;
  const cmp = compareFieldData(mine, other, atol, rtol);
  if (cmp.compared === 0) {
    return { model: a, written: [], comparison: cmp, uncovered: mine.ids.length, message: "No entity carries a value in both meshes, so there is nothing to compare." };
  }

  // Difference fields on THIS mesh's ids that have a partner: signed, norm, relative norm.
  const c = Math.max(1, mine.components);
  const rowOther = new Map<number, number>();
  for (let i = 0; i < other.ids.length; i++) rowOther.set(other.ids[i], i);
  const ids: number[] = [];
  const diff: number[] = [];
  const abs: number[] = [];
  const relIds: number[] = [];
  const rel: number[] = [];
  for (let i = 0; i < mine.ids.length; i++) {
    const j = rowOther.get(mine.ids[i]);
    if (j === undefined) continue;
    let ok = true;
    let d2 = 0;
    let nb2 = 0;
    const row: number[] = [];
    for (let k = 0; k < c; k++) {
      const va = mine.values[i * c + k];
      const vb = other.values[j * c + k];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) {
        ok = false;
        break;
      }
      row.push(va - vb);
      d2 += (va - vb) * (va - vb);
      nb2 += vb * vb;
    }
    if (!ok) continue;
    ids.push(mine.ids[i]);
    diff.push(...row);
    abs.push(Math.sqrt(d2));
    if (nb2 > 0) {
      relIds.push(mine.ids[i]);
      rel.push(Math.sqrt(d2) / Math.sqrt(nb2));
    }
  }
  const idArr = Int32Array.from(ids);
  const put = (
    model: MdpaModel,
    variable: string,
    components: number,
    fieldIds: Int32Array,
    values: number[]
  ): MdpaModel =>
    params.kind === "Nodal"
      ? attachNodalField(model, { variable, components, ids: fieldIds, values: Float64Array.from(values) }).model
      : attachCellField(model, {
          kind: params.kind as "Elemental" | "Conditional",
          variable,
          components,
          ids: fieldIds,
          values: Float64Array.from(values),
        }).model;
  let next = a;
  const written: string[] = [];
  const emit = (suffix: string, components: number, fieldIds: Int32Array, values: number[]): void => {
    const variable = `${base}_${suffix}`;
    next = put(next, variable, components, fieldIds, values);
    written.push(`${params.kind}:${variable}`);
  };
  emit("DIFF", c, idArr, diff);
  emit("ABS", 1, idArr, abs);
  if (rel.length > 0) emit("REL", 1, Int32Array.from(relIds), rel);
  return { model: next, written, comparison: cmp, uncovered: mine.ids.length - cmp.compared };
}
