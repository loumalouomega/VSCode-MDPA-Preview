/**
 * Partition EXPORT: N per-part meshes, optionally with ghost layers, each keeping
 * the SOURCE's own ids — the file-per-rank layout a distributed run starts from.
 * (`partitionMesh.ts` is the other half: ONE mesh with a `PARTITION_INDEX`
 * field, for looking at a decomposition rather than writing one.)
 *
 * Pure module (no vscode / DOM). meshio++'s `partition` is an ORACLE here: it
 * says which cells each part owns and which it holds as ghosts
 * (`recordIds: true` gives `partition:original_cell_id` and, with
 * `ghostLayers`, `partition:ghost`), and every part is then REBUILT NATIVELY
 * from those source cell ids with `restrictToCells`. The returned meshes are
 * never adopted, so ids, Elements/Conditions/Geometries kinds, Properties,
 * SubModelParts, fields and constraints survive — a partition of a Kratos mesh
 * is a set of Kratos meshes, not of meshio++ conversions.
 *
 * Because ids are preserved, the "original-id map" of a part is the identity and
 * the manifest says so instead of shipping million-entry arrays; what a
 * distributed setup actually needs is per part: what it owns, what it holds as
 * ghost, and which of its nodes are shared with another part (the interface).
 *
 * The WASM build has no KaHIP: `"kahip"` throws by name and `"auto"` resolves to
 * `"sfc"`, a Hilbert space-filling-curve cut balanced by cell count (or by
 * weight, with `weights`) with good locality but no edge-cut minimization.
 */

import { EntityKind, FieldData, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { modelToMeshio, meshioBlockOrder } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { flattenMeshioData } from "./meshioAdapter";
import { restrictToCells } from "./selectCells";
import type { PartitionMethod } from "./partitionMesh";

export const PARTITION_GHOST_VARIABLE = "PARTITION_GHOST";
export const PARTITION_OWNER_VARIABLE = "PARTITION_INDEX";
export const GHOST_PART = "Ghost";

export interface PartitionExportParams {
  nparts: number;
  method?: PartitionMethod;
  /** Load imbalance tolerance (default 0.03). */
  imbalance?: number;
  seed?: number;
  /** Layers of face-adjacent ghost cells each part also holds (default 0). */
  ghostLayers?: number;
  /** An ELEMENTAL field of per-element weights; an element without a value weighs 1. Must be finite and > 0. */
  weights?: string;
}

const KINDS: EntityKind[] = ["Elements", "Conditions", "Geometries"];
type Counts = Record<EntityKind, number>;
const zero = (): Counts => ({ Elements: 0, Conditions: 0, Geometries: 0 });

export interface ExportedPart {
  partId: number;
  model: MdpaModel;
  owned: Counts;
  ghost: Counts;
  nodes: number;
  /** Nodes this part shares with at least one other part — the interface a solver exchanges over. */
  interfaceNodes: number;
  /** Ids of those nodes (ascending). */
  interfaceNodeIds: number[];
}

export interface PartitionExportResult {
  parts: ExportedPart[];
  method: "sfc";
  ghostLayers: number;
  /** Owned Elements per part, and the imbalance max/mean − 1 (0 = perfectly even). */
  ownedElements: number[];
  imbalance: number;
  warnings: string[];
}

export async function partitionParts(
  model: MdpaModel,
  params: PartitionExportParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<PartitionExportResult> {
  const nparts = Math.floor(params.nparts);
  if (!(nparts >= 1)) throw new Error("nparts must be at least 1.");
  const ghostLayers = Math.floor(params.ghostLayers ?? 0);
  if (!(ghostLayers >= 0) || ghostLayers > 8) throw new Error("ghostLayers must be between 0 and 8.");
  if (params.method === "kahip") {
    throw new Error("KaHIP is not available in the WebAssembly build; use \"sfc\" (or \"auto\", which resolves to it).");
  }
  const total = model.blocks.reduce((s, b) => s + b.count, 0);
  if (total === 0) throw new Error("The mesh has no cells to partition.");
  const elements = model.blocks.filter((b) => b.kind === "Elements").reduce((s, b) => s + b.count, 0);
  if (nparts > Math.max(1, elements)) throw new Error(`${nparts} parts requested for ${elements} element(s).`);

  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) throw new Error("The mesh has no cells to partition.");
  const order = meshioBlockOrder(model);
  if (order.length !== mesh.cells.length) throw new Error("partition: block correspondence failed; the result was discarded.");

  // Per-cell weights, block-major like every cell array. Only Elements carry the field.
  let weightsKey = "";
  if (params.weights) {
    const f = model.fields.find((x) => x.kind === "Elemental" && x.variable === params.weights);
    if (!f) throw new Error(`No Elemental field named "${params.weights}" to weight the partition by.`);
    const byId = new Map<number, number>();
    for (let i = 0; i < f.ids.length; i++) byId.set(f.ids[i], f.values[i * Math.max(1, f.components)]);
    weightsKey = "partition_weight";
    const perBlock: Float64Array[] = order.map((b) => {
      const w = new Float64Array(b.count).fill(1);
      if (b.kind === "Elements") {
        for (let c = 0; c < b.count; c++) {
          const v = byId.get(b.entityIds[c]);
          if (v !== undefined) {
            if (!(Number.isFinite(v) && v > 0)) throw new Error(`Weight of element ${b.entityIds[c]} is ${v}; weights must be finite and positive.`);
            w[c] = v;
          }
        }
      }
      return w;
    });
    mesh.cell_data = { ...(mesh.cell_data ?? {}), [weightsKey]: perBlock as unknown as NonNullable<typeof mesh.cell_data>[string] };
  }

  const m = await loadMeshio();
  const raw = m.partition(mesh, nparts, params.method ?? "sfc", params.imbalance ?? 0.03, "eco", params.seed ?? 0, true, ghostLayers, weightsKey, false);
  if (raw.length !== nparts) throw new Error(`partition returned ${raw.length} part(s) for ${nparts}; the result was discarded.`);

  // Global block-major source index -> (kind, id).
  const flat: { kind: EntityKind; id: number }[] = [];
  for (const b of order) for (let c = 0; c < b.count; c++) flat.push({ kind: b.kind, id: b.entityIds[c] });

  // `partition:original_cell_id` is the BLOCK-LOCAL index of the cell in the source
  // (measured — a global index would not need the block offset), and a part
  // keeps its blocks 1:1 with the input, empty ones included, so block b of a part
  // is block b of the source.
  const blockStart: number[] = [];
  let acc = 0;
  for (const b of order) {
    blockStart.push(acc);
    acc += b.count;
  }
  interface Raw { partId: number; owned: number[]; ghost: number[] }
  const perPart: Raw[] = raw.map((p) => {
    const idsPerBlock = p.mesh.cell_data?.["partition:original_cell_id"];
    const ghostPerBlock = p.mesh.cell_data?.["partition:ghost"];
    if (!idsPerBlock || idsPerBlock.length !== order.length) {
      throw new Error("partition returned no per-block source cell ids; the result was discarded.");
    }
    const owned: number[] = [];
    const ghost: number[] = [];
    for (let bi = 0; bi < order.length; bi++) {
      const ids = flattenMeshioData([idsPerBlock[bi]] as never);
      const flags = ghostPerBlock ? flattenMeshioData([ghostPerBlock[bi]] as never) : [];
      for (let i = 0; i < ids.length; i++) (flags[i] ? ghost : owned).push(blockStart[bi] + ids[i]);
    }
    return { partId: p.partId, owned, ghost };
  });
  // Every source cell is OWNED by exactly one part — the invariant everything else leans on.
  const ownerOf = new Int32Array(flat.length).fill(-1);
  for (const p of perPart) {
    for (const g of p.owned) {
      if (ownerOf[g] !== -1) throw new Error(`Source cell ${g} is owned by two parts; the result was discarded.`);
      ownerOf[g] = p.partId;
    }
  }
  if (ownerOf.some((v) => v === -1)) throw new Error("A source cell is owned by no part; the result was discarded.");

  // Which parts each node lies in, for the interface.
  const built: { raw: Raw; model: MdpaModel; owned: Counts; ghost: Counts }[] = perPart.map((p) => {
    const keep: Record<EntityKind, Set<number>> = { Elements: new Set(), Conditions: new Set(), Geometries: new Set() };
    const owned = zero();
    const ghost = zero();
    for (const g of p.owned) {
      keep[flat[g].kind].add(flat[g].id);
      owned[flat[g].kind]++;
    }
    for (const g of p.ghost) {
      keep[flat[g].kind].add(flat[g].id);
      ghost[flat[g].kind]++;
    }
    const restricted = restrictToCells(model, keep).model;
    return { raw: p, model: restricted, owned, ghost };
  });

  const nodePartCount = new Map<number, number>();
  for (const b of built) {
    // A node is "in" a part when an OWNED cell uses it: a ghost-only node belongs to a neighbour.
    for (const id of ownedNodes(b.model, b.raw, flat)) nodePartCount.set(id, (nodePartCount.get(id) ?? 0) + 1);
  }

  const parts: ExportedPart[] = built.map((b) => {
    const ownedNodeSet = ownedNodes(b.model, b.raw, flat);
    const interfaceNodeIds = [...ownedNodeSet].filter((id) => (nodePartCount.get(id) ?? 0) > 1).sort((x, y) => x - y);
    const withFields = addPartFields(b.model, b.raw, flat, ownerOf, ownedNodeSet, b.ghost);
    return {
      partId: b.raw.partId,
      model: withFields,
      owned: b.owned,
      ghost: b.ghost,
      nodes: withFields.nodeCount,
      interfaceNodes: interfaceNodeIds.length,
      interfaceNodeIds,
    };
  });
  parts.sort((a, b) => a.partId - b.partId);
  const sizes = parts.map((p) => p.owned.Elements);
  const mean = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length);
  const warnings: string[] = [];
  if (params.method === "auto" || params.method === undefined) {
    warnings.push("Partitioned with the space-filling-curve method (the WebAssembly build has no KaHIP): balanced, with good locality, but the interface is not edge-cut optimized.");
  }
  return {
    parts,
    method: "sfc",
    ghostLayers,
    ownedElements: sizes,
    imbalance: mean > 0 ? Math.max(...sizes) / mean - 1 : 0,
    warnings,
  };
}

/** Node ids used by this part's OWNED cells (the part's own nodes, excluding ghost-only ones). */
function ownedNodes(part: MdpaModel, raw: { owned: number[] }, flat: { kind: EntityKind; id: number }[]): Set<number> {
  const owned: Record<EntityKind, Set<number>> = { Elements: new Set(), Conditions: new Set(), Geometries: new Set() };
  for (const g of raw.owned) owned[flat[g].kind].add(flat[g].id);
  const out = new Set<number>();
  for (const b of part.blocks) {
    for (let c = 0; c < b.count; c++) {
      if (!owned[b.kind].has(b.entityIds[c])) continue;
      for (let k = 0; k < b.stride; k++) out.add(b.connectivity[c * b.stride + k]);
    }
  }
  return out;
}

/** PARTITION_INDEX (the owner of each cell), PARTITION_GHOST (0/1) and a Ghost SubModelPart. */
function addPartFields(
  part: MdpaModel,
  raw: { partId: number; owned: number[]; ghost: number[] },
  flat: { kind: EntityKind; id: number }[],
  ownerOf: Int32Array,
  ownedNodeSet: Set<number>,
  ghostCounts: Counts
): MdpaModel {
  const isGhost: Record<EntityKind, Set<number>> = { Elements: new Set(), Conditions: new Set(), Geometries: new Set() };
  for (const g of raw.ghost) isGhost[flat[g].kind].add(flat[g].id);
  const ownerById: Record<EntityKind, Map<number, number>> = { Elements: new Map(), Conditions: new Map(), Geometries: new Map() };
  for (const g of [...raw.owned, ...raw.ghost]) ownerById[flat[g].kind].set(flat[g].id, ownerOf[g]);

  const fields: FieldData[] = part.fields.filter(
    (f) => !((f.kind === "Elemental" || f.kind === "Conditional") && (f.variable === PARTITION_GHOST_VARIABLE || f.variable === PARTITION_OWNER_VARIABLE))
  );
  for (const [kind, fk] of [["Elements", "Elemental"], ["Conditions", "Conditional"]] as const) {
    const ids: number[] = [];
    for (const b of part.blocks) if (b.kind === kind) for (let c = 0; c < b.count; c++) ids.push(b.entityIds[c]);
    if (ids.length === 0) continue;
    fields.push(
      { kind: fk, variable: PARTITION_OWNER_VARIABLE, components: 1, ids: Int32Array.from(ids), values: Float64Array.from(ids, (id) => ownerById[kind].get(id) ?? raw.partId) },
      { kind: fk, variable: PARTITION_GHOST_VARIABLE, components: 1, ids: Int32Array.from(ids), values: Float64Array.from(ids, (id) => (isGhost[kind].has(id) ? 1 : 0)) }
    );
  }
  let subModelParts = part.subModelParts;
  if (ghostCounts.Elements + ghostCounts.Conditions + ghostCounts.Geometries > 0) {
    const taken = new Set(subModelParts.map((p) => p.name));
    let name = GHOST_PART;
    for (let i = 2; taken.has(name); i++) name = `${GHOST_PART}_${i}`;
    const ghostNodes: number[] = [];
    for (const b of part.blocks) {
      for (let c = 0; c < b.count; c++) {
        if (!isGhost[b.kind].has(b.entityIds[c])) continue;
        for (let k = 0; k < b.stride; k++) {
          const id = b.connectivity[c * b.stride + k];
          if (!ownedNodeSet.has(id)) ghostNodes.push(id);
        }
      }
    }
    const ghostPart: SubModelPart = {
      name,
      path: name,
      nodeIds: Int32Array.from([...new Set(ghostNodes)].sort((a, b) => a - b)),
      elementIds: Int32Array.from([...isGhost.Elements].sort((a, b) => a - b)),
      conditionIds: Int32Array.from([...isGhost.Conditions].sort((a, b) => a - b)),
      geometryIds: Int32Array.from([...isGhost.Geometries].sort((a, b) => a - b)),
      constraintIds: new Int32Array(0),
      children: [],
    };
    subModelParts = [...subModelParts, ghostPart];
  }
  return { ...part, fields, subModelParts };
}

/** The manifest a distributed setup reads: what each file owns, holds as ghost, and shares. */
export function partitionManifest(
  source: string,
  r: PartitionExportResult,
  files: string[],
  extra: { interfaceNodeLimit?: number } = {}
): object {
  const limit = extra.interfaceNodeLimit ?? 1000;
  return {
    source,
    parts: r.parts.length,
    method: r.method,
    ghostLayers: r.ghostLayers,
    // Ids are the SOURCE's own in every part, so the original-id map is the identity.
    idsPreserved: true,
    imbalance: r.imbalance,
    warnings: r.warnings,
    files: r.parts.map((p, i) => ({
      part: p.partId,
      file: files[i],
      nodes: p.nodes,
      owned: p.owned,
      ghost: p.ghost,
      interfaceNodes: p.interfaceNodes,
      interfaceNodeIds: p.interfaceNodeIds.slice(0, limit),
      interfaceNodeIdsTruncated: p.interfaceNodeIds.length > limit,
    })),
  };
}

