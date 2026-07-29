// Pure (no vscode/DOM/vtk) reverse index from an entity id to the dotted
// paths of every SubModelPart (including nested ones) that contains it.
// Behind the Inspect panel's "Member of" list — a picked node/element/
// condition/geometry has no back-reference to its SubModelParts, so this
// walks the tree once per model and memoizes lookups by id.

import { SubModelPart } from "./types";

export interface MembershipIndex {
  nodes: Map<number, string[]>;
  elements: Map<number, string[]>;
  conditions: Map<number, string[]>;
  geometries: Map<number, string[]>;
}

function addAll(map: Map<number, string[]>, ids: ArrayLike<number>, path: string): void {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const list = map.get(id);
    if (list) list.push(path);
    else map.set(id, [path]);
  }
}

function walk(part: SubModelPart, index: MembershipIndex): void {
  addAll(index.nodes, part.nodeIds, part.path);
  addAll(index.elements, part.elementIds, part.path);
  addAll(index.conditions, part.conditionIds, part.path);
  addAll(index.geometries, part.geometryIds, part.path);
  for (const child of part.children) walk(child, index);
}

export function buildMembershipIndex(parts: SubModelPart[]): MembershipIndex {
  const index: MembershipIndex = {
    nodes: new Map(),
    elements: new Map(),
    conditions: new Map(),
    geometries: new Map(),
  };
  for (const part of parts) walk(part, index);
  return index;
}
