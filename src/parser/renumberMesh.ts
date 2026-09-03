/**
 * Renumbers ids into a gapless run — the "compact the id space" transform.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * ## What this is, and what `reorderMesh.ts` is
 *
 * The two are complements, and it is worth being precise because the names are
 * close enough to mislead:
 *
 *   - `reorderMesh.ts` changes **storage order** — which node sits at which
 *     position in `nodeIds`/`coords` — and deliberately leaves every id alone,
 *     precisely so that SubModelPart lists, field records and connectivity (all
 *     keyed by id, never by index) stay valid untouched.
 *   - this module changes **the ids themselves** and leaves storage order alone.
 *     Node `k` keeps its coordinates; only its label changes.
 *
 * So `reorder` then `renumber` is the full RCM renumbering — the thing
 * `reorderMesh.ts`'s header says it will not do on its own.
 *
 * ## Per-kind id spaces
 *
 * Elements, Conditions and Geometries are each numbered 1..N **independently**,
 * which is what Kratos means: every real `.mdpa` on disk already has an
 * `Element 1` and a `Condition 1` side by side, so a single shared space would
 * be the novel invariant, not the faithful one. Nothing downstream assumes
 * global uniqueness — `buildCellLayout` keeps three separate id→cell maps,
 * `FieldData.kind` selects which space an Elemental vs Conditional record lives
 * in, `SubModelPart` keeps three lists, and the `mesh_find_entity` MCP tool
 * takes an `entityType`.
 *
 * ## What is deliberately NOT renumbered
 *
 *   - `coords` — index-parallel to `nodeIds`; this relabels, it does not reorder.
 *   - `FieldData.values` / `fixed` — positionally parallel to `ids`, and no row
 *     moves, so relabelling `ids` in place keeps them aligned.
 *   - `EntityBlock.propertyIds` — a *different* id space (the Properties table),
 *     which this extension line-counts rather than parses. Touching it would be
 *     a guess.
 *   - `SubModelPart.constraintIds` — `Constraints` is a meta block in
 *     `mdpaParser.ts` (line-counted, never parsed into entities) and is not one
 *     of `mdpaWriter.ts`'s verbatim-copied blocks, so there is nothing here to
 *     renumber them *against*. They are counted and reported instead.
 *   - `model.derived` — dropped rather than carried, because `nodalH` /
 *     `elementSize` are FieldData keyed by the OLD ids; a `{...model}` spread
 *     would keep them silently stale.
 */

import {
  EntityBlock,
  EntityKind,
  FieldData,
  MdpaDiagnostic,
  MdpaModel,
  SubModelPart,
} from "./types";

/**
 * `nodes` / `entities` scope the compaction to one side; `all` does both.
 * Entity kinds are not individually selectable — they are already independent
 * spaces, so compacting one and not another has no use case that "entities"
 * does not cover.
 */
export type RenumberTarget = "all" | "nodes" | "entities";

export const RENUMBER_TARGETS: ReadonlySet<RenumberTarget> = new Set<RenumberTarget>([
  "all",
  "nodes",
  "entities",
]);

const ENTITY_KINDS: readonly EntityKind[] = ["Elements", "Conditions", "Geometries"];

export interface RenumberParams {
  /** What to compact. Default `"all"`. */
  target?: RenumberTarget;
  /** First id of each compacted run. Default 1 — Kratos ids are 1-based. */
  start?: number;
}

export interface RenumberResult {
  model: MdpaModel;
  nodesRenumbered: number;
  /** Per kind — each gets its own independent run. */
  entitiesRenumbered: Record<EntityKind, number>;
  /** Highest id before → after, per space: the gap the operation closed. */
  spans: { nodes: [number, number] } & Record<EntityKind, [number, number]>;
  /** SubModelPart constraint ids seen and deliberately left alone. */
  constraintIdsLeft: number;
  /** References to ids no node/entity carries (dropped, or zeroed in connectivity). */
  danglingRefs: number;
  diagnostics: MdpaDiagnostic[];
}

/** Old → new for one id space, assigned in the order ids are visited. */
interface IdMap {
  map: Map<number, number>;
  changed: number;
  maxBefore: number;
  maxAfter: number;
  /** Ids that appeared more than once in the source order. */
  duplicates: number[];
}

function buildMap(ids: Iterable<number>, start: number): IdMap {
  const map = new Map<number, number>();
  const duplicates: number[] = [];
  let next = start;
  let changed = 0;
  let maxBefore = 0;
  for (const id of ids) {
    if (id > maxBefore) maxBefore = id;
    if (map.has(id)) {
      // A malformed source can repeat an id. The first occurrence wins (as it
      // does everywhere else that indexes by id); record it rather than throw —
      // no other operation in parser/ throws on bad input data.
      duplicates.push(id);
      continue;
    }
    const to = next++;
    if (to !== id) changed++;
    map.set(id, to);
  }
  return { map, changed, maxBefore, maxAfter: next - start === 0 ? 0 : next - 1, duplicates };
}

const IDENTITY: IdMap = {
  map: new Map(),
  changed: 0,
  maxBefore: 0,
  maxAfter: 0,
  duplicates: [],
};

/** Ids a block of this kind carries, in block order then within-block order. */
function* entityIdsOfKind(model: MdpaModel, kind: EntityKind): Generator<number> {
  for (const block of model.blocks) {
    if (block.kind !== kind) continue;
    for (const id of block.entityIds) yield id;
  }
}

export function renumberModel(model: MdpaModel, params: RenumberParams = {}): RenumberResult {
  const target: RenumberTarget = params.target ?? "all";
  const start = Number.isInteger(params.start) && (params.start as number) >= 1 ? (params.start as number) : 1;
  const doNodes = target === "all" || target === "nodes";
  const doEntities = target === "all" || target === "entities";

  const diagnostics: MdpaDiagnostic[] = [];
  const warn = (message: string): void => {
    diagnostics.push({ line: 0, message });
  };

  // --- the maps -----------------------------------------------------------
  const nodeMap = doNodes ? buildMap(model.nodeIds, start) : IDENTITY;
  const entityMaps = {} as Record<EntityKind, IdMap>;
  for (const kind of ENTITY_KINDS) {
    entityMaps[kind] = doEntities ? buildMap(entityIdsOfKind(model, kind), start) : IDENTITY;
  }

  for (const dup of nodeMap.duplicates) {
    warn(`Node id ${dup} appears more than once; the later occurrence was renumbered separately.`);
  }
  for (const kind of ENTITY_KINDS) {
    for (const dup of entityMaps[kind].duplicates) {
      warn(`${kind} id ${dup} appears more than once; the later occurrence was renumbered separately.`);
    }
  }

  const entitiesRenumbered = {} as Record<EntityKind, number>;
  for (const kind of ENTITY_KINDS) entitiesRenumbered[kind] = entityMaps[kind].changed;
  const totalEntityChanges = ENTITY_KINDS.reduce((n, k) => n + entitiesRenumbered[k], 0);

  const constraintIdsLeft = countConstraintIds(model.subModelParts);
  const spans = {
    nodes: [nodeMap.maxBefore, nodeMap.maxAfter] as [number, number],
  } as RenumberResult["spans"];
  for (const kind of ENTITY_KINDS) {
    spans[kind] = [entityMaps[kind].maxBefore, entityMaps[kind].maxAfter];
  }

  if (nodeMap.changed === 0 && totalEntityChanges === 0) {
    // Nothing to relabel — hand the original reference back so the op layer can
    // report a noop rather than a rebuild that changed nothing.
    return {
      model,
      nodesRenumbered: 0,
      entitiesRenumbered,
      spans,
      constraintIdsLeft,
      danglingRefs: 0,
      diagnostics,
    };
  }

  let danglingRefs = 0;
  /** Relabels an id, counting (and reporting via `miss`) one that has no mapping. */
  const relabel = (m: IdMap, id: number, miss: number): number => {
    if (m.map.size === 0) return id; // this space was not targeted
    const to = m.map.get(id);
    if (to === undefined) {
      danglingRefs++;
      return miss;
    }
    return to;
  };
  /** Relabels a list, DROPPING entries with no mapping (variable-length lists). */
  const relabelList = (m: IdMap, ids: Int32Array): Int32Array => {
    if (m.map.size === 0) return ids;
    const out: number[] = [];
    for (const id of ids) {
      const to = m.map.get(id);
      if (to === undefined) {
        danglingRefs++;
        continue;
      }
      out.push(to);
    }
    // Ascending, matching the id lists subModelPartTree.ts produces: the map is
    // not monotonic when the source storage order was scrambled.
    out.sort((a, b) => a - b);
    return Int32Array.from(out);
  };

  // --- nodes --------------------------------------------------------------
  const nodeIds = doNodes ? new Int32Array(model.nodeCount) : model.nodeIds;
  if (doNodes) {
    for (let i = 0; i < model.nodeCount; i++) {
      // A duplicate id maps to its FIRST slot's new id, so a later slot would
      // silently alias it; give the later one its own fresh label instead.
      nodeIds[i] = nodeMap.map.get(model.nodeIds[i]) ?? model.nodeIds[i];
    }
    if (nodeMap.duplicates.length > 0) {
      let next = start + nodeMap.map.size;
      const seen = new Set<number>();
      for (let i = 0; i < model.nodeCount; i++) {
        const id = nodeIds[i];
        if (seen.has(id)) nodeIds[i] = next++;
        else seen.add(id);
      }
    }
  }

  // --- blocks -------------------------------------------------------------
  const blocks: EntityBlock[] = model.blocks.map((b) => {
    const eMap = entityMaps[b.kind];
    const needsEntity = eMap.map.size > 0;
    if (!doNodes && !needsEntity) return b;
    const connectivity = doNodes ? new Int32Array(b.connectivity.length) : b.connectivity;
    if (doNodes) {
      for (let i = 0; i < b.connectivity.length; i++) {
        // Connectivity is stride-fixed, so a dangling node reference cannot be
        // dropped — it becomes 0, which is unreachable because `start >= 1` and
        // which buildCellLayout already skips as an unresolvable cell.
        connectivity[i] = relabel(nodeMap, b.connectivity[i], 0);
      }
    }
    const entityIds = needsEntity ? new Int32Array(b.entityIds.length) : b.entityIds;
    if (needsEntity) {
      for (let i = 0; i < b.entityIds.length; i++) {
        entityIds[i] = eMap.map.get(b.entityIds[i]) ?? b.entityIds[i];
      }
    }
    return { ...b, entityIds, connectivity };
  });

  // --- SubModelParts ------------------------------------------------------
  const remapPart = (p: SubModelPart): SubModelPart => ({
    ...p,
    nodeIds: relabelList(nodeMap, p.nodeIds),
    elementIds: relabelList(entityMaps.Elements, p.elementIds),
    conditionIds: relabelList(entityMaps.Conditions, p.conditionIds),
    geometryIds: relabelList(entityMaps.Geometries, p.geometryIds),
    children: p.children.map(remapPart),
  });
  const subModelParts = model.subModelParts.map(remapPart);

  // --- fields -------------------------------------------------------------
  const fields = model.fields.map((f) => {
    const m =
      f.kind === "Nodal"
        ? nodeMap
        : f.kind === "Elemental"
          ? entityMaps.Elements
          : entityMaps.Conditions;
    if (m.map.size === 0) return f;
    return relabelField(f, m, () => danglingRefs++);
  });

  if (danglingRefs > 0) {
    warn(
      `${danglingRefs} reference(s) pointed at ids no node or entity carries; ` +
        `dropped from part/field lists, zeroed in connectivity.`
    );
  }
  if (constraintIdsLeft > 0) {
    warn(
      `${constraintIdsLeft} SubModelPart constraint id(s) were left as-is — ` +
        `Constraints blocks are not parsed into entities, so there is nothing to renumber them against.`
    );
  }
  // A `Constraints` block survives a Save only as verbatim source text, and its
  // master/slave columns are NODE ids. Renumbering nodes therefore invalidates
  // it even when the id SET is unchanged — `reorder` then `renumber` is exactly
  // that case, and it is the one `mdpaWriter`'s own check provably cannot see,
  // because telling a permutation from a no-op needs the identity of a node.
  // So it is reported here, where renumbering is known to have happened.
  if (doNodes && nodeMap.changed > 0 && model.meta.some((m) => m.label.startsWith("Constraints"))) {
    warn(
      `The mesh declares Constraints blocks, which are carried through a Save as ` +
        `verbatim text keyed by NODE id. Renumbering the nodes leaves them pointing ` +
        `at the pre-renumber ids; re-derive them before running Kratos on the result.`
    );
  }

  return {
    model: {
      nodeCount: model.nodeCount,
      nodeIds,
      coords: model.coords,
      blocks,
      subModelParts,
      meta: model.meta,
      properties: model.properties,
      fields,
      diagnostics: [...model.diagnostics, ...diagnostics],
      is3D: model.is3D,
      bounds: model.bounds,
      // `derived` is deliberately omitted: its records are keyed by the old ids.
    },
    nodesRenumbered: nodeMap.changed,
    entitiesRenumbered,
    spans,
    constraintIdsLeft,
    danglingRefs,
    diagnostics,
  };
}

/** Relabels a field's ids in place — rows never move, so values stay aligned. */
function relabelField(field: FieldData, m: IdMap, onDangling: () => void): FieldData {
  const rows: number[] = [];
  const ids: number[] = [];
  for (let i = 0; i < field.ids.length; i++) {
    const to = m.map.get(field.ids[i]);
    if (to === undefined) {
      onDangling();
      continue;
    }
    rows.push(i);
    ids.push(to);
  }
  if (rows.length === field.ids.length) {
    return { ...field, ids: Int32Array.from(ids) };
  }
  const comps = field.components;
  const values = new Float64Array(rows.length * comps);
  const fixed = field.fixed ? new Uint8Array(rows.length) : undefined;
  for (let r = 0; r < rows.length; r++) {
    const src = rows[r];
    values.set(field.values.subarray(src * comps, src * comps + comps), r * comps);
    if (fixed && field.fixed) fixed[r] = field.fixed[src];
  }
  return { ...field, ids: Int32Array.from(ids), values, fixed };
}

function countConstraintIds(parts: SubModelPart[]): number {
  let n = 0;
  for (const p of parts) {
    n += p.constraintIds.length;
    n += countConstraintIds(p.children);
  }
  return n;
}
