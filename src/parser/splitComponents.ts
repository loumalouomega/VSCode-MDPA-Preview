/**
 * Splitting a mesh into groups of Elements — connected components, element
 * types, or the distinct values of a per-element field — and marking the
 * connected components in place.
 *
 * Pure module (no vscode / DOM / wasm). NATIVE rather than meshio++'s `split`:
 * connectivity through shared nodes is one union-find pass, and doing it on the
 * model itself keeps every id, entity kind, Property, SubModelPart and field —
 * what `split` on a converted mesh would give back is meshio cell blocks.
 * (`split by region` is `mesh_extract_submodelpart`, which already exists.)
 *
 * Connectivity is decided by ELEMENTS only: two bodies that a Condition happens
 * to reach across (a contact pair) are still two bodies. Conditions and
 * Geometries follow whichever group holds every node they name, through
 * `restrictToElements`; one that spans two groups belongs to neither and is
 * counted rather than silently attached.
 */

import { FieldData, MdpaModel } from "./types";
import { restrictToElements } from "./selectCells";

export interface ComponentInfo {
  /** 0 = the largest (most elements); ties broken by lowest node id, so it is deterministic. */
  index: number;
  elements: number;
  nodes: number;
  /** Element ids in this component, in mesh order. */
  elementIds: number[];
  /** Much smaller than the largest component: probably debris rather than a body. */
  isolated: boolean;
}

export interface ComponentsResult {
  components: ComponentInfo[];
  /** Nodes no Element uses at all (loose nodes, point clouds, orphans). */
  looseNodes: number;
}

/** Connected components of the mesh's Elements (cells sharing a node are connected). */
export function connectedComponents(model: MdpaModel, fragmentFraction = 0.01): ComponentsResult {
  const index = new Map<number, number>();
  for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);
  const parent = new Int32Array(model.nodeCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const used = new Uint8Array(model.nodeCount);
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      let first = -1;
      for (let k = 0; k < b.stride; k++) {
        const n = index.get(b.connectivity[c * b.stride + k]);
        if (n === undefined) continue;
        used[n] = 1;
        if (first < 0) first = n;
        else {
          const ra = find(first);
          const rb = find(n);
          if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
    }
  }
  interface Acc { root: number; elementIds: number[]; nodes: number; firstNodeId: number }
  const byRoot = new Map<number, Acc>();
  for (let i = 0; i < model.nodeCount; i++) {
    if (!used[i]) continue;
    const r = find(i);
    let a = byRoot.get(r);
    if (!a) {
      a = { root: r, elementIds: [], nodes: 0, firstNodeId: model.nodeIds[i] };
      byRoot.set(r, a);
    }
    a.nodes++;
    if (model.nodeIds[i] < a.firstNodeId) a.firstNodeId = model.nodeIds[i];
  }
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      for (let k = 0; k < b.stride; k++) {
        const n = index.get(b.connectivity[c * b.stride + k]);
        if (n !== undefined) {
          byRoot.get(find(n))!.elementIds.push(b.entityIds[c]);
          break;
        }
      }
    }
  }
  const sorted = [...byRoot.values()].sort((a, b) => b.elementIds.length - a.elementIds.length || a.firstNodeId - b.firstNodeId);
  const largest = sorted[0]?.elementIds.length ?? 0;
  const components: ComponentInfo[] = sorted.map((a, i) => ({
    index: i,
    elements: a.elementIds.length,
    nodes: a.nodes,
    elementIds: a.elementIds,
    isolated: i > 0 && a.elementIds.length < fragmentFraction * largest,
  }));
  let looseNodes = 0;
  for (let i = 0; i < model.nodeCount; i++) if (!used[i]) looseNodes++;
  return { components, looseNodes };
}

// --- the marking op --------------------------------------------------------------

export const COMPONENT_VARIABLE = "COMPONENT_INDEX";

export interface MarkComponentsParams {
  /** Field name (default COMPONENT_INDEX). */
  output?: string;
  /** A non-largest component with fewer than this fraction of the largest one's elements is flagged (default 0.01). */
  fragmentFraction?: number;
}

export interface MarkComponentsResult {
  model: MdpaModel;
  components: number;
  isolated: number;
  looseNodes: number;
  /** Elements per component, in index order (largest first). */
  sizes: number[];
}

/** Writes each Element's component index (0 = the largest) as an Elemental field. */
export function markComponentsModel(model: MdpaModel, params: MarkComponentsParams = {}): MarkComponentsResult {
  const r = connectedComponents(model, params.fragmentFraction ?? 0.01);
  const sizes = r.components.map((c) => c.elements);
  if (r.components.length <= 1) return { model, components: r.components.length, isolated: 0, looseNodes: r.looseNodes, sizes };
  const variable = params.output ?? COMPONENT_VARIABLE;
  const ids: number[] = [];
  const values: number[] = [];
  for (const c of r.components) for (const id of c.elementIds) {
    ids.push(id);
    values.push(c.index);
  }
  const field: FieldData = { kind: "Elemental", variable, components: 1, ids: Int32Array.from(ids), values: Float64Array.from(values) };
  return {
    model: { ...model, fields: [...model.fields.filter((f) => !(f.kind === "Elemental" && f.variable === variable)), field] },
    components: r.components.length,
    isolated: r.components.filter((c) => c.isolated).length,
    looseNodes: r.looseNodes,
    sizes,
  };
}

// --- splitting ----------------------------------------------------------------------

export type SplitSpec =
  | { by: "component"; fragmentFraction?: number }
  | { by: "type" }
  | { by: "field"; variable: string };

export interface SplitGroup {
  /** A filename-safe label. */
  key: string;
  model: MdpaModel;
  elements: number;
  conditions: number;
  nodes: number;
  isolated?: boolean;
}

export interface SplitResult {
  groups: SplitGroup[];
  /** Conditions/Geometries that name nodes of two different groups and so belong to neither. */
  unassignedConditions: number;
  looseNodes: number;
  warnings: string[];
}

const MAX_FIELD_GROUPS = 1000;

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "group";

export function splitModel(model: MdpaModel, spec: SplitSpec): SplitResult {
  const warnings: string[] = [];
  let looseNodes = 0;
  const raw: { key: string; ids: number[]; isolated?: boolean }[] = [];
  if (spec.by === "component") {
    const r = connectedComponents(model, spec.fragmentFraction ?? 0.01);
    looseNodes = r.looseNodes;
    for (const c of r.components) raw.push({ key: `component_${c.index}`, ids: c.elementIds, isolated: c.isolated });
  } else if (spec.by === "type") {
    for (const b of model.blocks) {
      if (b.kind !== "Elements") continue;
      const g = raw.find((x) => x.key === safe(b.name));
      if (g) for (let c = 0; c < b.count; c++) g.ids.push(b.entityIds[c]);
      else raw.push({ key: safe(b.name), ids: Array.from(b.entityIds.subarray(0, b.count)) });
    }
  } else {
    const f = model.fields.find((x) => x.kind === "Elemental" && x.variable === spec.variable);
    if (!f) throw new Error(`No Elemental field named "${spec.variable}" to split by.`);
    if (f.components !== 1) throw new Error(`"${spec.variable}" has ${f.components} components; split by a scalar field.`);
    const groups = new Map<number, number[]>();
    for (let i = 0; i < f.ids.length; i++) {
      const v = f.values[i];
      if (!Number.isFinite(v)) continue;
      const g = groups.get(v);
      if (g) g.push(f.ids[i]);
      else groups.set(v, [f.ids[i]]);
    }
    if (groups.size > MAX_FIELD_GROUPS) {
      throw new Error(`"${spec.variable}" has ${groups.size} distinct values; splitting by it would write more than ${MAX_FIELD_GROUPS} groups. Use a categorical field.`);
    }
    for (const v of [...groups.keys()].sort((a, b) => a - b)) raw.push({ key: `${safe(spec.variable)}_${safe(String(v))}`, ids: groups.get(v)! });
    const covered = f.ids.length;
    const totalElements = model.blocks.filter((b) => b.kind === "Elements").reduce((s, b) => s + b.count, 0);
    if (covered < totalElements) warnings.push(`${totalElements - covered} element(s) have no value in "${spec.variable}" and belong to no group.`);
  }
  if (raw.length === 0) throw new Error("No group to split into.");

  // Which group holds each element, to find Conditions that bridge groups.
  const groupOfElement = new Map<number, number>();
  raw.forEach((g, i) => g.ids.forEach((id) => groupOfElement.set(id, i)));
  const nodeGroups = new Map<number, Set<number>>();
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      const g = groupOfElement.get(b.entityIds[c]);
      if (g === undefined) continue;
      for (let k = 0; k < b.stride; k++) {
        const n = b.connectivity[c * b.stride + k];
        const s = nodeGroups.get(n) ?? new Set<number>();
        s.add(g);
        nodeGroups.set(n, s);
      }
    }
  }
  let unassigned = 0;
  for (const b of model.blocks) {
    if (b.kind === "Elements") continue;
    for (let c = 0; c < b.count; c++) {
      let common: Set<number> | undefined;
      for (let k = 0; k < b.stride; k++) {
        const s = nodeGroups.get(b.connectivity[c * b.stride + k]) ?? new Set<number>();
        common = common ? new Set([...common].filter((g) => s.has(g))) : new Set(s);
      }
      if (!common || common.size === 0) unassigned++;
    }
  }
  if (unassigned > 0) warnings.push(`${unassigned} condition/geometry cell(s) name nodes of more than one group and belong to none.`);

  const groups: SplitGroup[] = raw.map((g) => {
    const r = restrictToElements(model, new Set(g.ids));
    const conditions = r.model.blocks.filter((b) => b.kind !== "Elements").reduce((s, b) => s + b.count, 0);
    return { key: g.key, model: r.model, elements: r.keptElements, conditions, nodes: r.model.nodeCount, isolated: g.isolated };
  });
  return { groups, unassignedConditions: unassigned, looseNodes, warnings };
}

