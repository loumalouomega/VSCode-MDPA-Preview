/**
 * SubModelPart TREE operations: create, move/reparent, merge, and add/remove
 * entity ids. The counterparts of `renameSubModelPart.ts` (rename) and
 * `deleteSubModelPart.ts` (delete), which were the only two that existed.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * ## Why nothing outside the tree is touched
 *
 * A `SubModelPart` is five `Int32Array` id lists plus `path` and `children`, and
 * blocks and fields reference entities BY ID. So a pure tree edit — creating a
 * part, moving one, merging two, or changing which ids a part claims — needs no
 * change to `blocks`, `fields` or `coords` at all. That is the same invariant
 * `renameSubModelPart` relies on, and it is what makes these operations cheap.
 *
 * ## The parent/child subset rule
 *
 * Kratos requires a child SubModelPart's entities to be a subset of its
 * parent's, and it maintains that itself rather than validating it. Measured
 * against `kratos/sources/model_part.cpp`:
 *
 *   - `ModelPart::AddNode` on a sub model part calls
 *     `mpParentModelPart->AddNode(...)` FIRST (line 297), so adding an entity
 *     propagates UP through every ancestor.
 *   - `ModelPart::RemoveNode` removes from this part and then loops over
 *     `SubModelPartsBegin()..End()` doing the same (lines 439-440), so removing
 *     cascades DOWN through every descendant.
 *
 * These modules do exactly that. The invariant then holds by construction: no
 * operation here can produce a tree Kratos would reject, and there is no new
 * vocabulary ("strict mode", "repair") for a user to learn. The counts are
 * reported so the effect is visible rather than silent.
 */

import { MdpaModel, SubModelPart } from "./types";

/** The four entity kinds a SubModelPart can claim, plus constraints. */
export type SmpEntityKind = "nodes" | "elements" | "conditions" | "geometries" | "constraints";

export const SMP_ENTITY_KINDS: readonly SmpEntityKind[] = [
  "nodes",
  "elements",
  "conditions",
  "geometries",
  "constraints",
];

/** Field of `SubModelPart` holding each kind's ids. */
const ID_FIELD: Record<SmpEntityKind, keyof SubModelPart> = {
  nodes: "nodeIds",
  elements: "elementIds",
  conditions: "conditionIds",
  geometries: "geometryIds",
  constraints: "constraintIds",
};

function idsOf(part: SubModelPart, kind: SmpEntityKind): Int32Array {
  return part[ID_FIELD[kind]] as Int32Array;
}

/** A part with one kind's ids replaced (ascending, de-duplicated). */
function withIds(part: SubModelPart, kind: SmpEntityKind, ids: Int32Array): SubModelPart {
  return { ...part, [ID_FIELD[kind]]: ids } as SubModelPart;
}

/** Sorted, de-duplicated union — the storage order every writer here assumes. */
function unionIds(a: Int32Array, b: Iterable<number>): Int32Array {
  const set = new Set<number>(a);
  for (const v of b) set.add(v);
  return Int32Array.from([...set].sort((x, y) => x - y));
}

function withoutIds(a: Int32Array, remove: Set<number>): Int32Array {
  return a.filter((v) => !remove.has(v));
}

/** Rebuilds a subtree's `path`s from `parentPath`, keeping names/ids/children. */
export function rebasePaths(part: SubModelPart, parentPath: string): SubModelPart {
  const path = parentPath ? `${parentPath}/${part.name}` : part.name;
  return {
    ...part,
    path,
    children: part.children.map((c) => rebasePaths(c, path)),
  };
}

/** An empty SubModelPart named `name` under `parentPath`. */
function emptyPart(name: string, parentPath: string): SubModelPart {
  return {
    name,
    nodeIds: new Int32Array(0),
    elementIds: new Int32Array(0),
    conditionIds: new Int32Array(0),
    geometryIds: new Int32Array(0),
    constraintIds: new Int32Array(0),
    path: parentPath ? `${parentPath}/${name}` : name,
    children: [],
  };
}

/** A name Kratos accepts: non-empty and free of the path separator. */
function validName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.includes("/")) return undefined;
  return trimmed;
}

/**
 * Depth-first lookup of the node at `path`, or undefined.
 *
 * Deliberately a LIST-level helper rather than `subModelPartExtract.ts`'s
 * `findSubModelPart(model, path)`: the move and merge paths have to look inside
 * an already-detached list, where there is no `MdpaModel` to hand.
 */
function find(parts: SubModelPart[], path: string): SubModelPart | undefined {
  for (const p of parts) {
    if (p.path === path) return p;
    const hit = find(p.children, path);
    if (hit) return hit;
  }
  return undefined;
}

/** Every path in the subtree rooted at `part`, including its own. */
function subtreePaths(part: SubModelPart, out: Set<string> = new Set()): Set<string> {
  out.add(part.path);
  for (const c of part.children) subtreePaths(c, out);
  return out;
}

/** Maps the node at `path` through `fn`; returns undefined when not found. */
function mapAt(
  parts: SubModelPart[],
  path: string,
  fn: (p: SubModelPart) => SubModelPart
): SubModelPart[] | undefined {
  let hit = false;
  const list = parts.map((p) => {
    if (hit) return p;
    if (p.path === path) {
      hit = true;
      return fn(p);
    }
    const nested = mapAt(p.children, path, fn);
    if (nested) {
      hit = true;
      return { ...p, children: nested };
    }
    return p;
  });
  return hit ? list : undefined;
}

/** Removes the node at `path`, returning the pruned list and the detached node. */
function detach(
  parts: SubModelPart[],
  path: string
): { list: SubModelPart[]; taken: SubModelPart | undefined } {
  let taken: SubModelPart | undefined;
  const list: SubModelPart[] = [];
  for (const p of parts) {
    if (!taken && p.path === path) {
      taken = p;
      continue;
    }
    if (taken) {
      list.push(p);
      continue;
    }
    const nested = detach(p.children, path);
    if (nested.taken) {
      taken = nested.taken;
      list.push({ ...p, children: nested.list });
    } else {
      list.push(p);
    }
  }
  return { list, taken };
}

/** Inserts `child` under `parentPath` ("" = top level), rebasing its subtree. */
function attach(
  parts: SubModelPart[],
  parentPath: string,
  child: SubModelPart
): SubModelPart[] | undefined {
  if (parentPath === "") {
    return [...parts, rebasePaths(child, "")];
  }
  return mapAt(parts, parentPath, (p) => ({
    ...p,
    children: [...p.children, rebasePaths(child, p.path)],
  }));
}

/** The paths from the root down to (but excluding) `path`. */
function ancestorPaths(path: string): string[] {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join("/"));
  return out;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateSubModelPartResult {
  model: MdpaModel;
  created: boolean;
  /** Why not, when `created` is false. */
  message?: string;
}

/**
 * Creates an empty SubModelPart named `name` under `parentPath` ("" = top level).
 *
 * Empty is the honest starting state: entities are added afterwards with
 * `addSubModelPartEntities`, which is also what applies the propagation rule.
 */
export function createSubModelPart(
  model: MdpaModel,
  parentPath: string,
  name: string
): CreateSubModelPartResult {
  const clean = validName(name);
  if (!clean) {
    return { model, created: false, message: `"${name}" is not a valid SubModelPart name.` };
  }
  const siblings =
    parentPath === ""
      ? model.subModelParts
      : find(model.subModelParts, parentPath)?.children;
  if (siblings === undefined) {
    return { model, created: false, message: `No SubModelPart at "${parentPath}".` };
  }
  // Kratos disallows duplicate names among siblings — the same refusal
  // renameSubModelPart makes rather than silently suffixing.
  if (siblings.some((s) => s.name === clean)) {
    return {
      model,
      created: false,
      message: `"${parentPath || "the model"}" already has a SubModelPart named "${clean}".`,
    };
  }
  const list = attach(model.subModelParts, parentPath, emptyPart(clean, parentPath));
  if (!list) {
    return { model, created: false, message: `No SubModelPart at "${parentPath}".` };
  }
  return { model: { ...model, subModelParts: list }, created: true };
}

// ---------------------------------------------------------------------------
// move / reparent
// ---------------------------------------------------------------------------

export interface MoveSubModelPartResult {
  model: MdpaModel;
  moved: boolean;
  /** Entities added to the new ancestors to keep the subset rule (see module docs). */
  propagated: number;
  message?: string;
}

/**
 * Detaches the SubModelPart at `path` and re-attaches it under `newParentPath`
 * ("" = top level), rebasing every descendant `path`.
 *
 * The moved subtree's entities are then added to the new ancestors, which is
 * Kratos' own `AddNode` behaviour and what keeps the child-subset rule true.
 */
export function moveSubModelPart(
  model: MdpaModel,
  path: string,
  newParentPath: string
): MoveSubModelPartResult {
  const part = find(model.subModelParts, path);
  if (!part) return { model, moved: false, propagated: 0, message: `No SubModelPart at "${path}".` };
  if (newParentPath === path) {
    return { model, moved: false, propagated: 0, message: "A SubModelPart cannot be its own parent." };
  }
  // Moving a part INTO its own subtree would detach the destination along with
  // it and lose the whole branch.
  if (newParentPath !== "" && subtreePaths(part).has(newParentPath)) {
    return {
      model,
      moved: false,
      propagated: 0,
      message: `"${path}" cannot be moved inside itself.`,
    };
  }
  if (newParentPath !== "" && !find(model.subModelParts, newParentPath)) {
    return { model, moved: false, propagated: 0, message: `No SubModelPart at "${newParentPath}".` };
  }
  const destSiblings =
    newParentPath === ""
      ? model.subModelParts
      : (find(model.subModelParts, newParentPath)?.children ?? []);
  if (destSiblings.some((s) => s.path !== path && s.name === part.name)) {
    return {
      model,
      moved: false,
      propagated: 0,
      message: `"${newParentPath || "the model"}" already has a SubModelPart named "${part.name}".`,
    };
  }

  const { list, taken } = detach(model.subModelParts, path);
  if (!taken) return { model, moved: false, propagated: 0, message: `No SubModelPart at "${path}".` };
  const attached = attach(list, newParentPath, taken);
  if (!attached) {
    return { model, moved: false, propagated: 0, message: `No SubModelPart at "${newParentPath}".` };
  }

  // The subtree's whole entity set has to exist in every new ancestor.
  const claimed = collectSubtreeIds(taken);
  const moved = find(attached, newParentPath === "" ? taken.name : `${newParentPath}/${taken.name}`);
  const targets = moved ? ancestorPaths(moved.path) : [];
  const { parts, added } = propagateUp(attached, targets, claimed);
  return { model: { ...model, subModelParts: parts }, moved: true, propagated: added };
}

/** Every id the subtree claims, per kind. */
function collectSubtreeIds(part: SubModelPart): Record<SmpEntityKind, Set<number>> {
  const out = {} as Record<SmpEntityKind, Set<number>>;
  for (const k of SMP_ENTITY_KINDS) out[k] = new Set<number>();
  const walk = (p: SubModelPart): void => {
    for (const k of SMP_ENTITY_KINDS) for (const id of idsOf(p, k)) out[k].add(id);
    for (const c of p.children) walk(c);
  };
  walk(part);
  return out;
}

/** Adds `ids` to each part named in `targets`; returns how many entries were new. */
function propagateUp(
  parts: SubModelPart[],
  targets: string[],
  ids: Record<SmpEntityKind, Set<number>>
): { parts: SubModelPart[]; added: number } {
  let added = 0;
  let list = parts;
  for (const target of targets) {
    const next = mapAt(list, target, (p) => {
      let updated = p;
      for (const k of SMP_ENTITY_KINDS) {
        if (ids[k].size === 0) continue;
        const before = idsOf(updated, k);
        const after = unionIds(before, ids[k]);
        if (after.length !== before.length) {
          added += after.length - before.length;
          updated = withIds(updated, k, after);
        }
      }
      return updated;
    });
    if (next) list = next;
  }
  return { parts: list, added };
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

export interface MergeSubModelPartsResult {
  model: MdpaModel;
  merged: boolean;
  /** Entity ids `target` gained from `source`. */
  gained: number;
  /** Entity ids added to the target's ancestors to keep the subset rule. */
  propagated: number;
  message?: string;
}

/**
 * Merges the SubModelPart at `sourcePath` INTO the one at `targetPath`: the
 * target gains the union of the entity ids, the source's children are
 * re-attached under the target, and the source itself is removed.
 */
export function mergeSubModelParts(
  model: MdpaModel,
  sourcePath: string,
  targetPath: string
): MergeSubModelPartsResult {
  if (sourcePath === targetPath) {
    return { model, merged: false, gained: 0, propagated: 0, message: "A SubModelPart cannot be merged into itself." };
  }
  const source = find(model.subModelParts, sourcePath);
  const target = find(model.subModelParts, targetPath);
  if (!source) return { model, merged: false, gained: 0, propagated: 0, message: `No SubModelPart at "${sourcePath}".` };
  if (!target) return { model, merged: false, gained: 0, propagated: 0, message: `No SubModelPart at "${targetPath}".` };
  // Merging a part into its own descendant would delete the destination with it.
  if (subtreePaths(source).has(targetPath)) {
    return {
      model,
      merged: false,
      gained: 0,
      propagated: 0,
      message: `"${sourcePath}" contains "${targetPath}"; merge the other way round.`,
    };
  }
  // A child name that already exists under the target would produce duplicate
  // sibling names, which Kratos disallows — refuse rather than silently rename.
  const clash = source.children.find((c) => target.children.some((t) => t.name === c.name));
  if (clash) {
    return {
      model,
      merged: false,
      gained: 0,
      propagated: 0,
      message: `"${targetPath}" already has a SubModelPart named "${clash.name}"; rename one first.`,
    };
  }

  const { list, taken } = detach(model.subModelParts, sourcePath);
  if (!taken) return { model, merged: false, gained: 0, propagated: 0, message: `No SubModelPart at "${sourcePath}".` };

  let gained = 0;
  const updated = mapAt(list, targetPath, (p) => {
    let out = p;
    for (const k of SMP_ENTITY_KINDS) {
      const before = idsOf(out, k);
      const after = unionIds(before, idsOf(taken, k));
      if (after.length !== before.length) {
        gained += after.length - before.length;
        out = withIds(out, k, after);
      }
    }
    return {
      ...out,
      children: [...out.children, ...taken.children.map((c) => rebasePaths(c, out.path))],
    };
  });
  if (!updated) return { model, merged: false, gained: 0, propagated: 0, message: `No SubModelPart at "${targetPath}".` };

  // The absorbed entities must reach the target's ancestors too.
  const { parts, added } = propagateUp(
    updated,
    ancestorPaths(targetPath),
    collectSubtreeIds(taken)
  );
  return { model: { ...model, subModelParts: parts }, merged: true, gained, propagated: added };
}

// ---------------------------------------------------------------------------
// add / remove entities
// ---------------------------------------------------------------------------

export interface EntityEditResult {
  model: MdpaModel;
  /** Ids actually added to / removed from the named part. */
  changed: number;
  /** Ids added to ancestors (add) or removed from descendants (remove). */
  propagated: number;
  message?: string;
}

/**
 * Adds entity ids to the SubModelPart at `path`, and — mirroring Kratos'
 * `ModelPart::AddNode` — to every ancestor, so the child-subset rule holds.
 */
export function addSubModelPartEntities(
  model: MdpaModel,
  path: string,
  kind: SmpEntityKind,
  ids: readonly number[]
): EntityEditResult {
  const part = find(model.subModelParts, path);
  if (!part) return { model, changed: 0, propagated: 0, message: `No SubModelPart at "${path}".` };
  const wanted = ids.filter((n) => Number.isFinite(n));
  if (wanted.length === 0) {
    return { model, changed: 0, propagated: 0, message: "No entity ids given." };
  }

  let changed = 0;
  const updated = mapAt(model.subModelParts, path, (p) => {
    const before = idsOf(p, kind);
    const after = unionIds(before, wanted);
    changed = after.length - before.length;
    return changed > 0 ? withIds(p, kind, after) : p;
  });
  if (!updated) return { model, changed: 0, propagated: 0, message: `No SubModelPart at "${path}".` };

  const perKind = {} as Record<SmpEntityKind, Set<number>>;
  for (const k of SMP_ENTITY_KINDS) perKind[k] = new Set<number>();
  for (const id of wanted) perKind[kind].add(id);
  const { parts, added } = propagateUp(updated, ancestorPaths(path), perKind);

  return { model: { ...model, subModelParts: parts }, changed, propagated: added };
}

/**
 * Removes entity ids from the SubModelPart at `path`, and — mirroring Kratos'
 * `ModelPart::RemoveNode` — from every DESCENDANT, since a child cannot claim
 * an entity its parent no longer has.
 *
 * The entities themselves are untouched: this only changes which part claims
 * them. Deleting entities outright is `deleteSubModelPart` / the crop ops.
 */
export function removeSubModelPartEntities(
  model: MdpaModel,
  path: string,
  kind: SmpEntityKind,
  ids: readonly number[]
): EntityEditResult {
  const part = find(model.subModelParts, path);
  if (!part) return { model, changed: 0, propagated: 0, message: `No SubModelPart at "${path}".` };
  const drop = new Set(ids.filter((n) => Number.isFinite(n)));
  if (drop.size === 0) {
    return { model, changed: 0, propagated: 0, message: "No entity ids given." };
  }

  let changed = 0;
  let propagated = 0;
  const strip = (p: SubModelPart, isRoot: boolean): SubModelPart => {
    const before = idsOf(p, kind);
    const after = withoutIds(before, drop);
    const delta = before.length - after.length;
    if (delta > 0) {
      if (isRoot) changed = delta;
      else propagated += delta;
    }
    return {
      ...(delta > 0 ? withIds(p, kind, after) : p),
      children: p.children.map((c) => strip(c, false)),
    };
  };
  const updated = mapAt(model.subModelParts, path, (p) => strip(p, true));
  if (!updated) return { model, changed: 0, propagated: 0, message: `No SubModelPart at "${path}".` };

  return { model: { ...model, subModelParts: updated }, changed, propagated };
}
