/** Map filename subpart meshes onto a frame while preserving its native groups. */
import * as path from "node:path";
import { parseMeshFile } from "./meshFileParser";
import { fileFor, VtkFileGroup } from "./vtkFileGroup";
import { EntityKind, MdpaModel, SubModelPart } from "./types";

export async function mergeSubparts(
  rootModel: MdpaModel,
  group: VtkFileGroup,
  dir: string,
  rank: number,
  step: string,
  rootPrefix: string,
  load: (fsPath: string) => Promise<MdpaModel> = parseMeshFile
): Promise<SubModelPart[]> {
  if (group.subParts.length === 0) return rootModel.subModelParts;

  // Build coord → rootNodeId lookup
  const coordMap = buildCoordMap(rootModel);

  // Build connectivity key → root entityId lookup
  const entityMap = buildEntityMap(rootModel);

  const subModelParts: SubModelPart[] = [...rootModel.subModelParts];

  for (const subSuffix of group.subParts) {
    const subPrefix = `${rootPrefix}_${subSuffix}`;
    const subFile = fileFor(group, subPrefix, rank, step);
    if (!subFile) continue;

    let subModel: MdpaModel;
    try {
      subModel = await load(path.join(dir, subFile));
    } catch {
      rootModel.diagnostics.push({
        line: 0,
        message: `Could not parse subpart file ${subFile}; subpart omitted.`,
      });
      continue;
    }

    // Map actual subpart nodeIds → root nodeIds via coordinates
    const subToRoot = new Map<number, number>();
    let mismatches = 0;
    for (let i = 0; i < subModel.nodeCount; i++) {
      const key = coordKey(
        subModel.coords[i * 3],
        subModel.coords[i * 3 + 1],
        subModel.coords[i * 3 + 2]
      );
      const rootNodeId = coordMap.get(key);
      if (rootNodeId !== undefined) {
        subToRoot.set(subModel.nodeIds[i], rootNodeId);
      } else {
        mismatches++;
      }
    }

    if (mismatches > 0) {
      rootModel.diagnostics.push({
        line: 0,
        message: `Subpart "${subSuffix}": ${mismatches} of ${subModel.nodeCount} node(s) could not be matched to the root mesh by coordinates.`,
      });
    }

    // Collect matched root nodeIds
    const nodeIds: number[] = [];
    for (const id of subToRoot.values()) {
      if (id > 0) nodeIds.push(id);
    }

    // Map subpart cells → root entityIds via connectivity
    const elementIds: number[] = [];
    const conditionIds: number[] = [];
    const geometryIds: number[] = [];
    for (const blk of subModel.blocks) {
      for (let e = 0; e < blk.count; e++) {
        // Translate source connectivity IDs to root node IDs
        const rootNodes: number[] = [];
        for (let k = 0; k < blk.stride; k++) {
          const subNodeId = blk.connectivity[e * blk.stride + k];
          const rootNodeId = subToRoot.get(subNodeId) ?? 0;
          rootNodes.push(rootNodeId);
        }
        if (rootNodes.includes(0)) continue;
        const key = `${blk.vtkCellType}:${connectKey(rootNodes)}`;
        const rootEntityId = entityMap.get(key);
        if (rootEntityId !== undefined) {
          for (const entity of rootEntityId) {
            const ids = entity.kind === "Elements" ? elementIds : entity.kind === "Conditions" ? conditionIds : geometryIds;
            ids.push(entity.id);
          }
        }
      }
    }

    const partPath = `${rootPrefix}.${subSuffix}`;

    subModelParts.push({
      name: subSuffix,
      nodeIds: Int32Array.from(new Set(nodeIds)),
      elementIds: Int32Array.from(new Set(elementIds)),
      conditionIds: Int32Array.from(new Set(conditionIds)),
      geometryIds: Int32Array.from(new Set(geometryIds)),
      constraintIds: new Int32Array(0),
      path: partPath,
      children: [],
    });
  }

  return subModelParts;
}

function coordKey(x: number, y: number, z: number): string {
  return `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
}

function buildCoordMap(model: MdpaModel): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < model.nodeCount; i++) {
    const key = coordKey(
      model.coords[i * 3],
      model.coords[i * 3 + 1],
      model.coords[i * 3 + 2]
    );
    map.set(key, model.nodeIds[i]);
  }
  return map;
}

function connectKey(nodeIds: number[]): string {
  return [...nodeIds].sort((a, b) => a - b).join(",");
}

function buildEntityMap(model: MdpaModel) {
  const map = new Map<string, { kind: EntityKind; id: number }[]>();
  for (const blk of model.blocks) {
    for (let e = 0; e < blk.count; e++) {
      const nodes: number[] = [];
      for (let k = 0; k < blk.stride; k++) {
        nodes.push(blk.connectivity[e * blk.stride + k]);
      }
      const key = `${blk.vtkCellType}:${connectKey(nodes)}`;
      const entities = map.get(key) ?? [];
      entities.push({ kind: blk.kind, id: blk.entityIds[e] });
      map.set(key, entities);
    }
  }
  return map;
}

