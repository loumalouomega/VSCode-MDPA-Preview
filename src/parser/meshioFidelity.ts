/**
 * The explicit fidelity adapter: replaces the blanket "adopting a meshio++
 * result is too lossy" prohibition with a carry/adopt mechanism that
 * reconstructs Kratos ids, entity kinds, property references, constraints
 * and SubModelPart grouping when they were carried out, and REPORTS what it
 * could not retain rather than silently degrading or throwing.
 *
 * Pure module: no vscode / DOM / wasm imports.
 *
 * ## Why this is separate from the Group A oracles
 *
 * The eight existing oracle modules (smoothMesh.ts, reorderMesh.ts, …) ask
 * meshio++ for an ANSWER whose shape survives the boundary intact and apply
 * it to our own model — cheaper than a full adopt, and provably safe. This
 * module exists for the operations that have no such oracle form: repair,
 * decimate, slice/isosurface-as-real-meshes, partition export, and every
 * other Tier 2 item that genuinely needs the mesh meshio++ returns. Nothing
 * here converts an existing oracle to adoption.
 *
 * ## The mechanism (see modelToMeshio's `opts.carriers`)
 *
 * `modelToMeshio(model, diagnostics, {carriers: true})` additionally emits,
 * as ordinary `point_data`/`cell_data` arrays: `mdpa:id` (upstream's own
 * MDPA node/entity id convention), `kratos:kind` (0/1/2 for
 * Elements/Conditions/Geometries — this extension's own carrier, since
 * upstream only carries that distinction in a per-format side channel that
 * does not survive an operation), and `gmsh:physical` (upstream's own MDPA
 * property-id convention). SubModelPart membership rides the EXISTING,
 * unconditional `regions` mechanism (`buildRegions` in meshioConvert.ts),
 * prefixed with `kratos:smp/` and keeping "/" verbatim when carriers are on
 * — a colon can never appear in a Kratos block/entity name, so a region
 * name starting with the prefix is unambiguously a part, never a block's own
 * `Cell` region, and the "/" separator (rather than the plain export's
 * dotted flatten) is what lets nesting come back exactly rather than being
 * guessed from a name a foreign file could coincidentally also produce.
 * `model.properties` rides `mesh.propertySets`, a Mesh-level slot upstream
 * itself carries through shape-preserving operations (measured against the
 * live wasm: `smooth`/`transform` return it unchanged; a restructuring op
 * like `convertCells` returns an empty array — exactly the "unsupported
 * transformations report what cannot be retained" case).
 *
 * Every carrier is OFF by default (`carriers` defaults to false) and is
 * never set by `writeMeshioBytes` — an ordinary export must never carry
 * these into a real file, where a colon-bearing array would surface as a
 * bogus field on a later read (measured: a `.vtu` written with carriers on
 * does carry them into the file).
 *
 * ## What `adoptMeshioMesh` guarantees, and what it does not
 *
 * For a result whose cell blocks are all RECTANGULAR (uniform node count —
 * `isRectangularCellBlock`), every id/kind/propertyId/SubModelPart/
 * Properties/constraint slot is reconstructed exactly for every surviving
 * entity, and a node/cell the operation invented is reported as `generated`
 * rather than silently claimed as "recovered". Block DISPLAY NAMES are NOT
 * recovered — they are resynthesized from the meshio type name and kind
 * (`triangle`, `triangle_Conditions`, …) — because reconstructing the
 * original block boundary reliably would need a THIRD region-based carrier
 * this design deliberately does not add (see the module's own decision
 * record in CLAUDE.md); it is reported once as a `blockNames` loss.
 *
 * For a result containing a RAGGED (polygon/polyhedron) cell block, per-cell
 * fidelity recovery is not implemented: rather than risk silently
 * diverging from `meshioToModel`'s own fan-out/skip bookkeeping (used
 * nowhere else outside that function), this falls back to the plain,
 * already-tested `meshioToModel` read path — synthesized ids, everything
 * "Elements" — and reports every carried slot as lost. This is a stated,
 * testable boundary, not a silent shortfall.
 */

import {
  MeshioMesh,
  MeshioDataArray,
  meshioDataToNumbers,
  meshioToModel,
  isRectangularCellBlock,
  fromUpstreamPropertySets,
} from "./meshioConvert";
import {
  MESHIO_ID_KEY,
  MESHIO_KIND_KEY,
  MESHIO_PROPERTY_KEY,
  MESHIO_PART_PREFIX,
  MESHIO_CARRIER_KEYS,
  MESHIO_TO_VTK_TYPE,
  MESHIO_TO_VTK_ORDER,
} from "./meshioFormats";
import { MeshioRegion } from "./meshioRegions";
import {
  mapConstraintNodes,
  filterConstraintsById,
  pruneSubModelPartConstraints,
  definedConstraintIds,
  ConstraintBlock,
} from "./constraintsParser";
import { EntityBlock, EntityKind, FieldData, MdpaModel, MdpaDiagnostic, SubModelPart } from "./types";
import { finalizeModel } from "./modelBuilder";

/** One thing the adapter did or did not retain, for reporting to a UI or MCP caller. */
export type FidelitySlot =
  | "nodeIds"
  | "entityIds"
  | "entityKinds"
  | "propertyIds"
  | "properties"
  | "subModelParts"
  | "constraints"
  | "blockNames"
  | "fieldFixedFlags";

export interface FidelityReport {
  op: string;
  retained: FidelitySlot[];
  lost: { slot: FidelitySlot; reason: string; count?: number }[];
  /** Entities the operation invented (no usable carrier value), by kind. */
  generated: { nodes: number; elements: number; conditions: number; geometries: number };
}

const KIND_OF_CODE: readonly EntityKind[] = ["Elements", "Conditions", "Geometries"];

function maxIdOf(ids: Int32Array): number {
  let max = 0;
  for (let i = 0; i < ids.length; i++) if (ids[i] > max) max = ids[i];
  return max;
}

function maxEntityIdByKind(model: MdpaModel, kind: EntityKind): number {
  let max = 0;
  for (const b of model.blocks) {
    if (b.kind !== kind) continue;
    const m = maxIdOf(b.entityIds);
    if (m > max) max = m;
  }
  return max;
}

function uniqSorted(values: readonly number[]): Int32Array {
  return Int32Array.from([...new Set(values)].sort((a, b) => a - b));
}

interface PartAccumulator {
  nodeIds: number[];
  elementIds: number[];
  conditionIds: number[];
  geometryIds: number[];
}

/**
 * Rebuilds a nested SubModelPart tree from `kratos:smp/`-prefixed regions.
 * A parent with no entities of its own (only its children do) never gets a
 * region — exactly as `buildRegions` never emits one for it on the way out
 * — so an intermediate segment with no accumulator entry is synthesized as
 * an empty part, the same rule Kratos' own nesting relies on.
 */
function partsFromCarrierRegions(
  regions: readonly MeshioRegion[] | undefined,
  flatEntity: readonly ({ kind: EntityKind; id: number } | undefined)[],
  nodeIds: Int32Array
): SubModelPart[] {
  const byPath = new Map<string, PartAccumulator>();
  const accum = (path: string): PartAccumulator => {
    let a = byPath.get(path);
    if (!a) {
      a = { nodeIds: [], elementIds: [], conditionIds: [], geometryIds: [] };
      byPath.set(path, a);
    }
    return a;
  };
  for (const r of regions ?? []) {
    if (!r.name.startsWith(MESHIO_PART_PREFIX)) continue;
    const path = r.name.slice(MESHIO_PART_PREFIX.length);
    const a = accum(path);
    if (r.kind === "point") {
      for (const idx of r.entries) {
        if (idx >= 0 && idx < nodeIds.length) a.nodeIds.push(nodeIds[idx]);
      }
    } else if (r.kind === "cell") {
      for (const gi of r.entries) {
        const e = flatEntity[gi];
        if (!e) continue;
        if (e.kind === "Elements") a.elementIds.push(e.id);
        else if (e.kind === "Conditions") a.conditionIds.push(e.id);
        else a.geometryIds.push(e.id);
      }
    }
    // A "side" region never reaches here — the carry path never emits one.
  }

  interface TreeNode {
    name: string;
    path: string;
    own?: PartAccumulator;
    children: Map<string, TreeNode>;
  }
  const root = new Map<string, TreeNode>();
  for (const [path] of byPath) {
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let level = root;
    let built = "";
    let node: TreeNode | undefined;
    for (const seg of segments) {
      built = built ? `${built}/${seg}` : seg;
      node = level.get(seg);
      if (!node) {
        node = { name: seg, path: built, children: new Map() };
        level.set(seg, node);
      }
      level = node.children;
    }
    if (node) node.own = byPath.get(path);
  }
  const toArray = (level: Map<string, TreeNode>): SubModelPart[] =>
    [...level.values()].map((n) => ({
      name: n.name,
      path: n.path,
      nodeIds: uniqSorted(n.own?.nodeIds ?? []),
      elementIds: uniqSorted(n.own?.elementIds ?? []),
      conditionIds: uniqSorted(n.own?.conditionIds ?? []),
      geometryIds: uniqSorted(n.own?.geometryIds ?? []),
      constraintIds: new Int32Array(0),
      children: toArray(n.children),
    }));
  return toArray(root);
}

/**
 * Maintains `base.constraints` through the recovered node-id map, using only
 * the EXISTING maintenance helpers in constraintsParser.ts: a constraint
 * naming a node the operation did not carry through is dropped (never
 * zero-filled), never remapped (carried ids never change value), and pruned
 * from every SubModelPart that named it.
 */
function adoptConstraints(
  base: MdpaModel,
  survivingNodeIds: ReadonlySet<number>,
  parts: SubModelPart[]
): { constraints?: ConstraintBlock[]; parts: SubModelPart[]; droppedIds: number[] } {
  if (!base.constraints || base.constraints.length === 0) {
    return { constraints: undefined, parts, droppedIds: [] };
  }
  const { blocks: mapped, droppedIds } = mapConstraintNodes(base.constraints, (id) =>
    survivingNodeIds.has(id) ? id : undefined
  );
  const keptIds = new Set(definedConstraintIds(mapped));
  const filtered = filterConstraintsById(mapped, (id) => keptIds.has(id));
  const pruned = pruneSubModelPartConstraints(parts, keptIds);
  return { constraints: filtered, parts: pruned.parts, droppedIds };
}

/**
 * Reconstructs an `MdpaModel` from a meshio++ operation's result, using the
 * carrier arrays `modelToMeshio(base, …, {carriers: true})` emitted (and
 * whatever the operation itself carried through — `regions`, `propertySets`)
 * to recover Kratos ids, kind, propertyIds, Properties, constraints and
 * SubModelPart grouping. See the module doc for exactly what is and is not
 * guaranteed.
 */
export function adoptMeshioMesh(
  base: MdpaModel,
  result: MeshioMesh,
  diagnostics: MdpaDiagnostic[],
  opts: {
    op: string;
    /**
     * Recover each cell's block DISPLAY name from the per-block `Cell` regions
     * `modelToMeshio` always emits (named after the source `EntityBlock`, and
     * carried through by every op that keeps regions). Off by default — the
     * baseline contract, pinned by meshioFidelityRoundTrip.test.ts, is that a
     * block's name is NOT recovered — and opt-in for the ops whose result keeps
     * those regions, so an in-place repair does not rename the user's blocks.
     */
    recoverBlockNames?: boolean;
  }
): { model: MdpaModel; report: FidelityReport } {
  const lost: FidelityReport["lost"] = [];
  const retained: FidelitySlot[] = [];
  const generated = { nodes: 0, elements: 0, conditions: 0, geometries: 0 };

  if (result.cells.some((cb) => !isRectangularCellBlock(cb))) {
    // A ragged block defeats a correct direct-cell walk without re-deriving
    // meshioToModel's own fan-out bookkeeping — fall back to the plain,
    // already-tested read path rather than risk a silently wrong one.
    const model = meshioToModel(result, diagnostics);
    return {
      model,
      report: {
        op: opts.op,
        retained: [],
        lost: (
          ["entityIds", "entityKinds", "propertyIds", "properties", "subModelParts", "constraints", "blockNames"] as FidelitySlot[]
        ).map((slot) => ({
          slot,
          reason:
            "the result contains a ragged (polygon/polyhedron) cell block; per-cell " +
            "fidelity recovery is not implemented for that shape, so the plain read " +
            "path was used instead (synthesized ids, every block reported as Elements).",
        })),
        generated,
      },
    };
  }

  const dim = result.dim;
  const numPoints = dim > 0 ? Math.floor(result.points.length / dim) : 0;
  const coords = new Float32Array(numPoints * 3);
  for (let i = 0; i < numPoints; i++) {
    for (let k = 0; k < dim; k++) coords[i * 3 + k] = result.points[i * dim + k];
  }

  // --- Node ids -------------------------------------------------------
  const nodeIds = new Int32Array(numPoints);
  const idCarrier = result.point_data?.[MESHIO_ID_KEY];
  const idNums = idCarrier ? meshioDataToNumbers(idCarrier) : undefined;
  let nextNodeId = maxIdOf(base.nodeIds) + 1;
  const seenNodeId = new Set<number>();
  for (let i = 0; i < numPoints; i++) {
    const raw = idNums && idNums.length === numPoints ? Math.round(idNums[i]) : undefined;
    if (raw !== undefined && raw > 0 && !seenNodeId.has(raw)) {
      nodeIds[i] = raw;
      seenNodeId.add(raw);
    } else {
      nodeIds[i] = nextNodeId++;
      generated.nodes++;
      seenNodeId.add(nodeIds[i]);
    }
  }
  if (generated.nodes === 0) retained.push("nodeIds");
  else {
    lost.push({
      slot: "nodeIds",
      reason: `${generated.nodes} point(s) had no usable mdpa:id carrier and were assigned fresh ids`,
      count: generated.nodes,
    });
  }

  // --- Cells: kind, entity id, propertyId, connectivity ----------------
  const nextEntityId: Record<EntityKind, number> = {
    Elements: maxEntityIdByKind(base, "Elements") + 1,
    Conditions: maxEntityIdByKind(base, "Conditions") + 1,
    Geometries: maxEntityIdByKind(base, "Geometries") + 1,
  };
  const seenEntityId: Record<EntityKind, Set<number>> = {
    Elements: new Set(),
    Conditions: new Set(),
    Geometries: new Set(),
  };
  interface Group {
    kind: EntityKind;
    vtkCellType: number;
    stride: number;
    typeName: string;
    /** The recovered source-block name, when `recoverBlockNames` found one. */
    blockName?: string;
    entityIds: number[];
    connectivity: number[];
    propertyIds: number[];
    /** Non-carrier cell_data, collected in the same per-cell visitation order. */
    fields: Map<string, number[]>;
  }
  const groups = new Map<string, Group>();
  const groupOrder: string[] = [];
  let totalCells = 0;
  for (const cb of result.cells) {
    if (isRectangularCellBlock(cb)) totalCells += cb.nodesPerCell > 0 ? Math.floor(cb.data.length / cb.nodesPerCell) : 0;
  }
  const flatEntity = new Array<{ kind: EntityKind; id: number } | undefined>(totalCells);

  const cellFieldNames = Object.keys(result.cell_data ?? {}).filter((k) => !MESHIO_CARRIER_KEYS.has(k));

  // Block display names, recovered per cell from the block `Cell` regions.
  const baseBlockNames = new Set(base.blocks.map((b) => b.name));
  const blockNameOfCell = new Map<number, string>();
  if (opts.recoverBlockNames) {
    for (const r of result.regions ?? []) {
      if (r.kind !== "cell" || r.name.startsWith(MESHIO_PART_PREFIX) || !baseBlockNames.has(r.name)) continue;
      for (const gi of r.entries) {
        const idx = Number(gi);
        if (!blockNameOfCell.has(idx)) blockNameOfCell.set(idx, r.name);
      }
    }
  }

  let anyKindGenerated = false;
  let anyPropertyLost = false;
  let flatIdx = 0;
  for (let bi = 0; bi < result.cells.length; bi++) {
    const cb = result.cells[bi] as { type: string; data: Int32Array; nodesPerCell: number };
    const vtkCellType = MESHIO_TO_VTK_TYPE[cb.type];
    const stride = cb.nodesPerCell;
    const nCells = stride > 0 ? Math.floor(cb.data.length / stride) : 0;
    if (vtkCellType === undefined) {
      diagnostics.push({
        line: 0,
        message: `Cell type "${cb.type}" has no VTK equivalent; ${nCells} cell(s) skipped.`,
      });
      flatIdx += nCells;
      continue;
    }
    const perm = MESHIO_TO_VTK_ORDER[cb.type];
    const idArr = result.cell_data?.[MESHIO_ID_KEY]?.[bi];
    const kindArr = result.cell_data?.[MESHIO_KIND_KEY]?.[bi];
    const propArr = result.cell_data?.[MESHIO_PROPERTY_KEY]?.[bi];
    const idsN = idArr ? meshioDataToNumbers(idArr) : undefined;
    const kindsN = kindArr ? meshioDataToNumbers(kindArr) : undefined;
    const propsN = propArr ? meshioDataToNumbers(propArr) : undefined;
    // Per non-carrier field: this block's own array, and its component width.
    const fieldArrays = new Map<string, { nums: ArrayLike<number>; comps: number }>();
    for (const name of cellFieldNames) {
      const arr = result.cell_data?.[name]?.[bi];
      if (!arr) continue;
      const comps = result.cell_data_components?.[name] ?? 1;
      fieldArrays.set(name, { nums: meshioDataToNumbers(arr), comps });
    }

    for (let c = 0; c < nCells; c++) {
      let kind: EntityKind = "Elements";
      if (kindsN && kindsN.length === nCells) {
        const code = Math.round(kindsN[c]);
        if (code >= 0 && code <= 2) kind = KIND_OF_CODE[code];
        else anyKindGenerated = true;
      } else {
        anyKindGenerated = true;
      }

      const rawId = idsN && idsN.length === nCells ? Math.round(idsN[c]) : undefined;
      let entityId: number;
      if (rawId !== undefined && rawId > 0 && !seenEntityId[kind].has(rawId)) {
        entityId = rawId;
      } else {
        entityId = nextEntityId[kind]++;
        generated[kind === "Elements" ? "elements" : kind === "Conditions" ? "conditions" : "geometries"]++;
      }
      seenEntityId[kind].add(entityId);

      let propertyId = 0;
      if (propsN && propsN.length === nCells) propertyId = Math.round(propsN[c]);
      else anyPropertyLost = true;

      const recoveredName = blockNameOfCell.get(flatIdx);
      const key = `${cb.type}|${kind}|${recoveredName ?? ""}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          kind,
          vtkCellType,
          stride,
          typeName: cb.type,
          blockName: recoveredName,
          entityIds: [],
          connectivity: [],
          propertyIds: [],
          fields: new Map(),
        };
        groups.set(key, g);
        groupOrder.push(key);
      }
      g.entityIds.push(entityId);
      g.propertyIds.push(propertyId);
      for (let k = 0; k < stride; k++) {
        const localPoint = cb.data[c * stride + (perm ? perm[k] : k)];
        g.connectivity.push(nodeIds[localPoint] ?? 0);
      }
      for (const [name, { nums, comps }] of fieldArrays) {
        let vals = g.fields.get(name);
        if (!vals) {
          vals = [];
          g.fields.set(name, vals);
        }
        for (let k = 0; k < comps; k++) vals.push(nums[c * comps + k] ?? 0);
      }

      flatEntity[flatIdx] = { kind, id: entityId };
      flatIdx++;
    }
  }

  const entityGenerated = generated.elements + generated.conditions + generated.geometries;
  if (entityGenerated === 0) retained.push("entityIds");
  else {
    lost.push({
      slot: "entityIds",
      reason: `${entityGenerated} cell(s) had no usable mdpa:id carrier and were assigned fresh ids`,
      count: entityGenerated,
    });
  }
  if (!anyKindGenerated) retained.push("entityKinds");
  else lost.push({ slot: "entityKinds", reason: "some cell(s) carried no usable kratos:kind and defaulted to Elements" });
  if (!anyPropertyLost) retained.push("propertyIds");
  else lost.push({ slot: "propertyIds", reason: "some cell(s) carried no usable gmsh:physical and defaulted to 0 (no property)" });

  // Block display names are recovered only on request — see the module doc.
  const namelessGroups = groupOrder.filter((k) => groups.get(k)!.blockName === undefined).length;
  if (opts.recoverBlockNames && namelessGroups === 0) retained.push("blockNames");
  else {
    lost.push({
      slot: "blockNames",
      reason: opts.recoverBlockNames
        ? "some cells lie in no source block (the operation created them), so their blocks are " +
          "resynthesized from the meshio type name and kind."
        : "original block names are not carried; blocks are resynthesized from the " +
          "meshio type name and kind (e.g. \"triangle\", \"triangle_Conditions\").",
    });
  }

  const blocks: EntityBlock[] = groupOrder.map((key) => {
    const g = groups.get(key)!;
    const name = g.blockName ?? (g.kind === "Elements" ? g.typeName : `${g.typeName}_${g.kind}`);
    const hasProperty = g.propertyIds.some((p) => p !== 0);
    return {
      kind: g.kind,
      name,
      vtkCellType: g.vtkCellType,
      count: g.entityIds.length,
      stride: g.stride,
      entityIds: Int32Array.from(g.entityIds),
      propertyIds: hasProperty ? Int32Array.from(g.propertyIds) : undefined,
      connectivity: Int32Array.from(g.connectivity),
    };
  });

  // Non-carrier cell fields, split by the RECOVERED kind (a field spanning
  // both Elements and Conditions cells in one meshio cell_data array becomes
  // one Elemental and one Conditional FieldData — MdpaModel has no field
  // shape spanning kinds).
  const cellFieldAccum = new Map<
    string,
    { kind: "Elemental" | "Conditional"; variable: string; ids: number[]; values: number[]; components: number }
  >();
  for (const key of groupOrder) {
    const g = groups.get(key)!;
    if (g.kind === "Geometries") continue; // no field kind spans Geometries
    const kind = g.kind === "Elements" ? "Elemental" : "Conditional";
    for (const [name, vals] of g.fields) {
      const comps = result.cell_data_components?.[name] ?? 1;
      const accKey = `${kind}:${name}`;
      let acc = cellFieldAccum.get(accKey);
      if (!acc) {
        acc = { kind, variable: name, ids: [], values: [], components: comps };
        cellFieldAccum.set(accKey, acc);
      }
      acc.ids.push(...g.entityIds);
      acc.values.push(...vals);
    }
  }
  const cellFields: FieldData[] = [...cellFieldAccum.values()].map((acc) => ({
    kind: acc.kind,
    variable: acc.variable,
    components: acc.components,
    ids: Int32Array.from(acc.ids),
    values: Float64Array.from(acc.values),
  }));

  // Non-carrier nodal fields, point-major aligned with the recovered `nodeIds`.
  const nodalFields: FieldData[] = [];
  for (const [name, arr] of Object.entries(result.point_data ?? {})) {
    if (MESHIO_CARRIER_KEYS.has(name)) continue;
    const components = result.point_data_components?.[name] ?? 1;
    const nums = meshioDataToNumbers(arr);
    if (nums.length !== components * numPoints) continue; // shape mismatch: not ours to guess
    nodalFields.push({
      kind: "Nodal",
      variable: name,
      components,
      ids: Int32Array.from(nodeIds),
      values: Float64Array.from(nums),
    });
  }

  // --- SubModelParts (carrier regions) ---------------------------------
  let parts = partsFromCarrierRegions(result.regions, flatEntity, nodeIds);
  const anyPartRegion = (result.regions ?? []).some((r) => r.name.startsWith(MESHIO_PART_PREFIX));
  if (anyPartRegion || base.subModelParts.length === 0) retained.push("subModelParts");
  else {
    lost.push({
      slot: "subModelParts",
      reason: "the result carried no kratos:smp/ regions, so no SubModelPart membership could be recovered",
    });
  }

  // --- Properties -------------------------------------------------------
  let properties = base.properties;
  if (result.propertySets && result.propertySets.length > 0) {
    properties = fromUpstreamPropertySets(result.propertySets);
    retained.push("properties");
  } else if (base.properties && base.properties.length > 0) {
    // A restructuring op drops mesh-level propertySets (measured: convertCells
    // returns []). Carrying the base's verbatim is safe — a PropertySet is
    // keyed by its own id, never by any entity — and orphaning an id nothing
    // still references is harmless.
    lost.push({
      slot: "properties",
      reason:
        "the operation drops mesh-level property sets; they were carried " +
        "forward from the input unchanged, which is safe because a PropertySet " +
        "is keyed by its own id, not by any entity.",
    });
  }

  // --- Constraints --------------------------------------------------------
  const survivingNodeIds = new Set<number>(nodeIds);
  const { constraints, parts: prunedParts, droppedIds } = adoptConstraints(base, survivingNodeIds, parts);
  parts = prunedParts;
  if (!base.constraints || base.constraints.length === 0 || droppedIds.length === 0) {
    if (base.constraints && base.constraints.length > 0) retained.push("constraints");
  } else {
    lost.push({
      slot: "constraints",
      reason: `${droppedIds.length} constraint(s) named a node the operation did not carry through and were dropped`,
      count: droppedIds.length,
    });
  }

  const model = finalizeModel({
    nodeCount: numPoints,
    coords,
    nodeIds,
    blocks,
    fields: [...nodalFields, ...cellFields],
    diagnostics,
    subModelParts: parts,
  });

  const hadFixedFlags = base.fields.some((f) => f.kind === "Nodal" && f.fixed);
  if (hadFixedFlags) {
    lost.push({
      slot: "fieldFixedFlags",
      reason: "the Nodal is_fixed flag is not part of the carrier mechanism and is never recovered",
    });
  }

  return {
    model: { ...model, properties, constraints, meta: base.meta },
    report: { op: opts.op, retained, lost, generated },
  };
}
