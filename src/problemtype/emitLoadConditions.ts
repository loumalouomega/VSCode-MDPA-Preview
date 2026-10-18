/**
 * Load-condition emission for point, moment and moving loads.
 *
 * Some loads have no condition blocks in an ordinary mesh: a point load is an
 * assignment on nodes, a moving load travels over the part's line entities,
 * but Kratos only assembles a load where a condition reads it
 * (`PointLoadCondition`, `MovingLoadCondition`, …). Assigning such a load
 * therefore synthesizes the conditions from the part's own entities into a
 * sibling SubModelPart (`<part name><sibling>` under the same parent), and
 * the process targets the sibling (see `siblingPathFor`, shared with the
 * process builders).
 *
 * The sibling keeps hand-built meshes working: a mesh that already carries
 * the conditions is adapted as usual, and the emitted sibling covers exactly
 * the part's entities, so the process assembles the same load either way.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable.
 */

import { EntityBlock, MdpaModel, SubModelPart } from "../parser/types";
import { findSubModelPart } from "../parser/subModelPartExtract";
import { ConditionEmitSpec } from "./types";

export interface LoadEmitRequest {
  smpPath: string;
  conditionId: string;
}

export interface LoadEmitOptions {
  domainSize: 2 | 3;
  /** The case's element formulation value for a condition ("" when unknown):
   * a value starting with "Axisym" selects the axisymmetric point variant. */
  formulationOf: (conditionId: string) => string;
  /** The declaration's emit spec for a condition id (undefined = no emission). */
  emitOf: (conditionId: string) => ConditionEmitSpec | undefined;
}

export interface LoadEmitResult {
  model: MdpaModel;
  added: { path: string; conditions: number; name: string }[];
  warnings: string[];
}

/** The sibling part an emitted load lives in (`Support` + `PointLoad`). */
export function siblingPathFor(smpPath: string, sibling: string): string {
  const slash = smpPath.lastIndexOf("/");
  const parent = slash < 0 ? "" : smpPath.slice(0, slash);
  const name = slash < 0 ? smpPath : smpPath.slice(slash + 1);
  return `${parent ? `${parent}/` : ""}${name}${sibling}`;
}

const parentPathOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Inserts `sibling` under `parentPath` ("" = top level) without mutating the tree. */
function insertUnder(parts: SubModelPart[], parentPath: string, sibling: SubModelPart): SubModelPart[] {
  if (parentPath === "") return [...parts, sibling];
  return parts.map((p) =>
    p.path === parentPath
      ? { ...p, children: [...p.children, sibling] }
      : { ...p, children: insertUnder(p.children, parentPath, sibling) }
  );
}

/**
 * The nodes a point-family load is emitted for: the part's own node list, or
 * (a part that lists only conditions) the union of its conditions'
 * connectivity. Direct membership only.
 */
function partNodes(model: MdpaModel, part: SubModelPart): number[] {
  const seen = new Set<number>(part.nodeIds);
  if (!seen.size) {
    const byId = new Map<number, number[]>();
    for (const block of model.blocks) {
      if (block.kind !== "Conditions") continue;
      for (let c = 0; c < block.count; c++) {
        byId.set(block.entityIds[c], [...block.connectivity.subarray(c * block.stride, (c + 1) * block.stride)]);
      }
    }
    for (const id of part.conditionIds) for (const node of byId.get(id) ?? []) seen.add(node);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The part's line entities (stride-2/3 elements, else stride-2/3 conditions) a moving load travels over. */
function lineEntities(
  model: MdpaModel,
  part: SubModelPart
): { kind: "Elements" | "Conditions"; id: number; nodes: number[] }[] {
  const index = (ids: Int32Array, kind: "Elements" | "Conditions"): Map<number, number[]> => {
    const byId = new Map<number, number[]>();
    for (const block of model.blocks) {
      if (block.kind !== kind || (block.stride !== 2 && block.stride !== 3)) continue;
      for (let c = 0; c < block.count; c++) {
        byId.set(block.entityIds[c], [...block.connectivity.subarray(c * block.stride, (c + 1) * block.stride)]);
      }
    }
    return new Map([...ids].filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!]));
  };
  const fromElements = index(part.elementIds, "Elements");
  const source = fromElements.size > 0 ? fromElements : index(part.conditionIds, "Conditions");
  const kind = fromElements.size > 0 ? "Elements" : "Conditions";
  return [...source].map(([id, nodes]) => ({ kind, id, nodes }));
}

function nextConditionId(model: MdpaModel): number {
  let next = 1;
  for (const block of model.blocks) {
    if (block.kind !== "Conditions") continue;
    for (const id of block.entityIds) next = Math.max(next, id + 1);
  }
  return next;
}

/**
 * Emits one condition family per request into a sibling of the assigned part.
 * Unknown paths and parts with nothing to emit from warn and are skipped; an
 * existing sibling (a re-run, or the coupling's own point-load sibling sharing
 * the same nodes) is left untouched. The input model is never mutated; when
 * nothing was emitted it is returned as-is.
 */
export function emitLoadConditions(
  model: MdpaModel,
  requests: LoadEmitRequest[],
  opts: LoadEmitOptions
): LoadEmitResult {
  const warnings: string[] = [];
  const added: LoadEmitResult["added"] = [];
  let output = model;
  let blocks: EntityBlock[] = model.blocks;
  let parts = model.subModelParts;
  let nextId = nextConditionId(model);
  for (const { smpPath, conditionId } of requests) {
    const emit = opts.emitOf(conditionId);
    if (!emit) continue;
    const part = findSubModelPart(output, smpPath);
    if (!part) {
      warnings.push(`"${smpPath}" is not in this mesh, so no "${conditionId}" conditions were emitted for it.`);
      continue;
    }
    const siblingPath = siblingPathFor(smpPath, emit.sibling);
    if (findSubModelPart(output, siblingPath)) continue;
    if (emit.family === "moment" && opts.domainSize === 2) {
      warnings.push(
        `"${smpPath}": a point moment has no 2D condition (Kratos only registers PointMomentCondition3D1N), so no conditions were emitted for it.`
      );
      continue;
    }
    const name =
      emit.family === "moving"
        ? undefined
        : emit.family === "moment"
          ? "PointMomentCondition3D1N"
          : opts.domainSize === 2 && !emit.pointName && emit.axisymmetricPoint && opts.formulationOf(conditionId).startsWith("Axisym")
            ? emit.axisymmetricPoint
            : `${emit.pointName ?? "PointLoadCondition"}${opts.domainSize}D1N`;
    let entityIds: number[];
    let nodes: number[];
    if (emit.family === "moving") {
      const lines = lineEntities(output, part);
      if (lines.length === 0) {
        warnings.push(
          `"${smpPath}" lists no line elements or conditions, so no moving-load conditions were emitted for it — assign the load to the part carrying the lines it travels over.`
        );
        continue;
      }
      const skipped = lines.filter((l) => l.nodes.length !== 2 && l.nodes.length !== 3);
      for (const l of skipped) {
        warnings.push(
          `"${smpPath}": line entity ${l.id} has ${l.nodes.length} nodes and no MovingLoadCondition variant, so it was skipped.`
        );
      }
      const kept = lines.filter((l) => l.nodes.length === 2 || l.nodes.length === 3);
      if (kept.length === 0) continue;
      entityIds = kept.map(() => nextId++);
      nodes = [...new Set(kept.flatMap((l) => l.nodes))].sort((a, b) => a - b);
      // One block per shape: blocks group entities by (kind, name, stride).
      const byShape = new Map<string, { name: string; stride: number; ids: number[]; nodes: number[] }>();
      kept.forEach((l, i) => {
        const key = `${l.nodes.length}`;
        const entry = byShape.get(key) ?? {
          name: `MovingLoadCondition${opts.domainSize}D${l.nodes.length}N`,
          stride: l.nodes.length,
          ids: [],
          nodes: [],
        };
        entry.ids.push(entityIds[i]);
        entry.nodes.push(...l.nodes);
        byShape.set(key, entry);
      });
      for (const entry of byShape.values()) {
        blocks = [
          ...blocks,
          {
            kind: "Conditions",
            name: entry.name,
            count: entry.ids.length,
            stride: entry.stride,
            entityIds: Int32Array.from(entry.ids),
            propertyIds: new Int32Array(entry.ids.length),
            connectivity: Int32Array.from(entry.nodes),
          },
        ];
      }
    } else {
      const pointNodes = partNodes(output, part);
      if (pointNodes.length === 0) {
        warnings.push(`"${smpPath}" holds no nodes, so no "${conditionId}" conditions were emitted for it.`);
        continue;
      }
      entityIds = pointNodes.map(() => nextId++);
      nodes = pointNodes;
      blocks = [
        ...blocks,
        {
          kind: "Conditions",
          name: name!,
          count: pointNodes.length,
          stride: 1,
          entityIds: Int32Array.from(entityIds),
          propertyIds: new Int32Array(pointNodes.length),
          connectivity: Int32Array.from(pointNodes),
        },
      ];
    }
    parts = insertUnder(parts, parentPathOf(smpPath), {
      name: `${part.name}${emit.sibling}`,
      nodeIds: Int32Array.from(nodes),
      elementIds: new Int32Array(0),
      conditionIds: Int32Array.from(entityIds),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      path: siblingPath,
      children: [],
    });
    output = { ...output, blocks, subModelParts: parts };
    added.push({ path: siblingPath, conditions: entityIds.length, name: emit.family });
  }
  if (!added.length) return { model, added, warnings };
  return { model: output, added, warnings };
}
