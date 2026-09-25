/**
 * Properties authoring: the pure transforms behind the
 * `setProperty` / `createProperty` / `cloneProperty` / `deleteProperty` /
 * `assignProperty` operations.
 *
 * Pure (no vscode / DOM / vtk / wasm), like every `MdpaModel`-in,
 * `MdpaModel`-out module in this directory. Every returned model carries
 * `properties: [<the new list>]` EXPLICITLY, per the "wherever `meta` goes,
 * `properties` goes" rule on `MdpaModel.properties` — an operation doing a
 * real rewrite must thread the slot deliberately: spelling it out is what
 * makes a later refactor's silent drop visible rather than accidental.
 *
 * Two shapes of edit, and the UI exposes both deliberately:
 *
 *  - **Shared-property editing** — `setProperty`/`deleteProperty` mutate one
 *    set in place. Every block whose `propertyIds` row points at that id sees
 *    the change; that is the point, not a bug (a frame's twenty girders share
 *    one `CROSS_AREA` for a reason).
 *  - **Clone-and-reassign** — `cloneProperty` copies a set to a fresh id
 *    (> any existing, the `mergeMesh.ts` rebasing convention) WITHOUT touching
 *    any block, and `assignProperty` rewrites selected blocks' `propertyIds`
 *    rows. Both are safe on any mesh; whether the author *meant* the two
 *    shapes to differ is the one thing a tool cannot infer, so both are
 *    offered rather than one being silently chosen.
 *
 * `beamElements.ts` resolves a beam's CROSS_AREA per cell through
 * `block.propertyIds[c] -> Properties -> CROSS_AREA -> field`, in that order,
 * so a Properties edit re-renders beams with no extra wiring — which is also
 * why these ops must NEVER write an Elemental `CROSS_AREA` field instead
 * (that would fork the section's source of truth).
 */

import { EntityKind, MdpaModel } from "./types";
import { PropertySet, PropertyTable, PropertyValue, findPropertySet, propertyValue } from "./propertiesParser";
import { findSubModelPart } from "./subModelPartExtract";

export const PROPERTY_KIND_ORDER: EntityKind[] = ["Elements", "Conditions", "Geometries"];

export interface PropertyOpResult {
  model: MdpaModel;
  changed: boolean;
  message?: string;
}

function valueEqual(a: PropertyValue | undefined, b: PropertyValue): boolean {
  if (a === undefined) return false;
  if (a.kind !== b.kind) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Geometry of the full-literal rule: the ONLY way these ops spell a return. */
function withProperties(model: MdpaModel, sets: PropertySet[]): MdpaModel {
  return { ...model, properties: sets };
}

function blockUsesProperty(b: { propertyIds?: Int32Array; count: number }, id: number): number {
  if (!b.propertyIds) return 0;
  const length = Math.min(b.propertyIds.length, b.count);
  let n = 0;
  for (let i = 0; i < length; i++) if (b.propertyIds[i] === id) n++;
  return n;
}

/** The largest Properties id in use, or 0 when there is none (ids are 1-based). */
export function maxPropertyId(sets: readonly PropertySet[] | undefined): number {
  let max = 0;
  if (sets) for (const s of sets) if (s.id > max) max = s.id;
  return max;
}

/**
 * Sets one variable on an EXISTING set (`propertyId` must resolve). A value
 * identical to the current one is a noop returning the model unchanged.
 */
export function setProperty(model: MdpaModel, propertyId: number, name: string, value: PropertyValue): PropertyOpResult {
  const sets = model.properties ?? [];
  const set = findPropertySet(sets, propertyId);
  if (!set)
    return {
      model,
      changed: false,
      message: `no Properties block with id ${propertyId} (existing ids: ${sets.map((s) => s.id).join(", ") || "none"}).`,
    };
  if (!name || /[\s]/.test(name))
    return { model, changed: false, message: `"${name}" is not a usable property name.` };
  const current = propertyValue(set, name);
  if (valueEqual(current, value)) return { model, changed: false };
  const variables: Record<string, PropertyValue> = Object.create(Object.getPrototypeOf(set.variables));
  for (const key of Object.keys(set.variables)) variables[key] = set.variables[key];
  variables[name] = value;
  const next = sets.map((s) => (s === set ? { ...s, variables } : s));
  return { model: withProperties(model, next), changed: true, message: `Properties ${set.id}.${name} set.` };
}

export interface CreatePropertyParams {
  /** Defaults to one past the largest existing id. */
  id?: number;
  /** Optionally seeds the first variable; more follow up through `setProperty`. */
  name?: string;
  value?: PropertyValue;
}

/** Appends a new, empty (or single-variable-seeded) Properties block. */
export function createProperty(model: MdpaModel, params: CreatePropertyParams): PropertyOpResult {
  const sets = model.properties ?? [];
  const id = params.id ?? maxPropertyId(sets) + 1;
  if (!Number.isInteger(id) || id <= 0) return { model, changed: false, message: `Properties id ${id} is not a positive integer.` };
  if (findPropertySet(sets, id)) return { model, changed: false, message: `Properties id ${id} already exists.` };
  if (params.name !== undefined && (!params.name || /\s/.test(params.name)))
    return { model, changed: false, message: `"${params.name}" is not a usable property name.` };
  if (params.value === undefined && params.name !== undefined)
    return { model, changed: false, message: `setting "${params.name}" needs a value.` };
  const created: PropertySet = { id, variables: Object.create(null), tables: [] };
  if (params.name !== undefined && params.value !== undefined) created.variables[params.name] = params.value;
  return { model: withProperties(model, [...sets, created]), changed: true, message: `Properties ${id} created${params.name ? ` with ${params.name}` : ""}.` };
}

/**
 * Copies one set, variables AND tables, to a fresh id; no block's
 * `propertyIds` row is touched. `newId` defaults to one past the largest
 * existing id — anything colliding is refused, never silently renumbered,
 * because an id that jumps would strand the reassignment step the clone is
 * the first half of.
 */
export function cloneProperty(model: MdpaModel, propertyId: number, newId?: number): PropertyOpResult {
  const sets = model.properties ?? [];
  const source = findPropertySet(sets, propertyId);
  if (!source) return { model, changed: false, message: `no Properties block with id ${propertyId}.` };
  const target = newId ?? maxPropertyId(sets) + 1;
  if (!Number.isInteger(target) || target <= 0) return { model, changed: false, message: `Properties id ${target} is not a positive integer.` };
  if (findPropertySet(sets, target)) return { model, changed: false, message: `Properties id ${target} already exists.` };
  const variables: Record<string, PropertyValue> = Object.create(null);
  for (const key of Object.keys(source.variables)) variables[key] = source.variables[key];
  const tables: PropertyTable[] = source.tables.map((t) => ({ args: [...t.args], rows: t.rows.map((r) => [...r]) }));
  const fresh: PropertySet = { id: target, variables, tables };
  const inserted = [...sets, fresh].sort((a, b) => a.id - b.id);
  return {
    model: withProperties(model, inserted),
    changed: true,
    message: `Properties ${source.id} cloned to ${target} (${Object.keys(variables).length} values, ${tables.length} tables).`,
  };
}

/**
 * Removes a set by id — REFUSED while any block's `propertyIds` still points
 * at it (neither zeroing those rows nor inventing a replacement is a choice a
 * mutation should make silently; assign first, then delete).
 */
export function deleteProperty(model: MdpaModel, propertyId: number): PropertyOpResult {
  const sets = model.properties ?? [];
  const target = findPropertySet(sets, propertyId);
  if (!target) return { model, changed: false, message: `no Properties block with id ${propertyId}.` };
  const users: { name: string; count: number }[] = [];
  for (const b of model.blocks) {
    const n = blockUsesProperty(b, propertyId);
    if (n > 0) users.push({ name: b.name, count: n });
  }
  if (users.length > 0) {
    const listed = users.slice(0, 4).map((u) => `${u.name} (${u.count})`).join(", ");
    return {
      model,
      changed: false,
      message: `Properties ${propertyId} is still assigned to ${users.reduce((n, u) => n + u.count, 0)} cells — reassign or delete those blocks first (${listed}${users.length > 4 ? ", …" : ""}).`,
    };
  }
  const next = sets.filter((s) => s !== target);
  return { model: withProperties(model, next), changed: true, message: `Properties ${propertyId} deleted (${next.length} set${next.length === 1 ? "" : "s"} remain).` };
}

export type AssignScope =
  /** Entity ids in `kind`'s own id space. */
  | { kind: EntityKind; ids: readonly number[] }
  /** The SubModelPart at `path` subtree-inclusive, resolved at apply time. */
  | { part: string };

/** Property ids the mesh's blocks already carry — the summarize line's basis. */
export function propertyUsers(model: MdpaModel, propertyId: number): { elements: number; conditions: number; geometries: number } {
  const out = { elements: 0, conditions: 0, geometries: 0 };
  for (const b of model.blocks) {
    const n = blockUsesProperty(b, propertyId);
    if (b.kind === "Elements") out.elements += n;
    else if (b.kind === "Conditions") out.conditions += n;
    else out.geometries += n;
  }
  return out;
}

/**
 * Rewrites the selected blocks' `propertyIds` rows to `propertyId`. The id
 * must resolve to an existing set (an unresolvable row is the undefined-
 * reference warning `mdpaWriter` already names, and authoring takes the
 * opposite direction: the set is created BEFORE assignment). Geometries have
 * no `propertyIds`, so a Geometries scope is refused by name rather than
 * silently accepted-then-ignored.
 */
export function assignProperty(model: MdpaModel, scope: AssignScope, propertyId: number): PropertyOpResult {
  if (!findPropertySet(model.properties, propertyId))
    return { model, changed: false, message: `Properties ${propertyId} does not exist — create it first.` };
  if ("part" in scope) {
    const part = findSubModelPart(model, scope.part);
    if (!part) return { model, changed: false, message: `no SubModelPart named "${scope.part}".` };
    const perKind: Record<EntityKind, Set<number>> = {
      Elements: new Set(part.elementIds),
      Conditions: new Set(part.conditionIds),
      Geometries: new Set(),
    };
    return assignToSets(model, perKind, propertyId);
  }
  if (scope.kind === "Geometries")
    return { model, changed: false, message: "Geometries carry no Properties — assign to Elements or Conditions." };
  return assignToSets(model, { Elements: new Set(), Conditions: new Set(), Geometries: new Set(), [scope.kind]: new Set(scope.ids) } as Record<EntityKind, Set<number>>, propertyId);
}

function assignToSets(model: MdpaModel, perKind: Record<EntityKind, Set<number>>, propertyId: number): PropertyOpResult {
  const blocks = model.blocks.map((b) => {
    const wanted = perKind[b.kind];
    if (!wanted || wanted.size === 0) return b;
    if (b.propertyIds) {
      const rows = b.propertyIds;
      let changed = false;
      for (let i = 0; i < Math.min(rows.length, b.count); i++) {
        const shouldHave = wanted.has(b.entityIds[i]) ? propertyId : rows[i];
        if (shouldHave !== rows[i]) {
          changed = true;
          break;
        }
      }
      if (!changed) return b;
      const next = new Int32Array(rows);
      for (let i = 0; i < Math.min(next.length, b.count); i++) next[i] = wanted.has(b.entityIds[i]) ? propertyId : next[i];
      return { ...b, propertyIds: next };
    }
    // This block carries no propertyIds at all (parsed so, or synthesized):
    // the assignment INVENTS the row, zero-filled where it is not wanted, the
    // same convention the parser uses (a missing 0 = the default Properties).
    const rows = new Int32Array(b.count);
    let touched = false;
    for (let i = 0; i < b.count; i++) {
      if (wanted.has(b.entityIds[i])) {
        rows[i] = propertyId;
        touched = true;
      }
    }
    return touched ? { ...b, propertyIds: rows } : b;
  });
  const changedBlocks = blocks.reduce((n, b, i) => (b !== model.blocks[i] ? n + 1 : n), 0);
  if (changedBlocks === 0) return { model, changed: false };
  return { model: { ...model, blocks }, changed: true, message: `${changedBlocks} block(s) now reference Properties ${propertyId}.` };
}
