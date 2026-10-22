/**
 * Selection sets: named groups of entities (per KIND — Elements, Conditions
 * and Geometries each have their own id space) that can be seeded by a
 * predicate and re-evaluated when the model changes.
 *
 * Pure module (no vscode / DOM / vtk / wasm), the same Node-testable tier as
 * `thresholdCells.ts` / `selectCells.ts`, which this composes. The webview
 * holds the live state and persists it to the view sidecar's `view.selections`
 * key (see `viewState.ts`); the promotion and deletion routes that act on a set
 * are ordinary ops in the undoable history.
 *
 * **Persistence writes the seed, not the answer.** A predicate set's ids are
 * re-derived on every model change, so the sidecar stores the predicate and
 * lets the next open re-resolve it. An `explicit` set has nothing to re-derive,
 * so its id snapshot is written too. `serializeSelectionSets` /
 * `validateSelectionSets` are that rule, and both are bounded (`MAX_SELECTION_SETS`,
 * `MAX_SELECTION_IDS`) because a sidecar is a view annotation, not a mesh export.
 *
 * **The survival rule is "refresh by definition".** A set seeded by a
 * predicate re-resolves against EVERY new model: that is how a selection
 * "survives applicable edits through correspondence" — the ops that keep the
 * three independent entity-kind id spaces intact (the overwhelming majority:
 * every transform/tree/slice op) keep their sets, while `remesh` / `levelset`
 * / `mergeMesh` (full-literal rebuilds that renumber ids wholesale and drop
 * properties by construction, see `finalizeModel`) re-resolve to whatever the
 * predicate still matches. A set seeded EXPLICITLY (picks / an id list)
 * intersects the new model's id universes; ids that vanished are pruned and
 * the change flagged, never silently kept — a stale selection silently applied
 * to a different mesh is exactly the failure this rule exists to prevent.
 */

import { EntityKind, MdpaModel, FieldData } from "./types";
import { thresholdCells, ThresholdRule } from "./thresholdCells";
import { FieldComponent } from "./fieldScalars";
import { findSubModelPart } from "./subModelPartExtract";
import { findPropertySet } from "./propertiesParser";
import { QualityReport } from "./meshQuality";
import { formulaCells, FormulaRule } from "./formulaSelect";

export const ENTITY_KINDS: EntityKind[] = ["Elements", "Conditions", "Geometries"];

export type KindIdSets = { [K in EntityKind]: number[] };

/** How a set's ids are (re-)derived whenever the model is re-posted. */
export type SelectionSeed =
  /** Frozen ids — intersect them with each new model's id universes. */
  | { kind: "explicit" }
  /** Entities listed (subtree-inclusive) by the SubModelPart at `path`. */
  | { kind: "part"; path: string }
  /** One field's value in a [lo, hi] window. */
  | {
      kind: "field";
      variable: string;
      blockKind: "Nodal" | "Elemental" | "Conditional";
      /** Nodal vectors: "mag" (default) or a component index. */
      component?: FieldComponent;
      lo: number;
      hi: number;
      /** Nodal-field cell rule; ignored for Elemental/Conditional. */
      rule?: ThresholdRule;
    }
  /** meshQuality ids in the bad/unacceptable bands of one metric. */
  | { kind: "quality"; metric: string }
  /** Entities whose block's `propertyIds` row is `propertyId`. */
  | { kind: "property"; propertyId: number }
  /** Cells whose nodes (or centroid) satisfy a boolean formula, e.g. `z <= 0`. */
  | { kind: "formula"; expr: string; rule?: FormulaRule };

/** One named selection set. Id lists are sorted ascending. */
export interface SelectionSet {
  name: string;
  seed: SelectionSeed;
  kinds: { Elements: number[]; Conditions: number[]; Geometries: number[] };
  /** Nodes picked directly (session-only; they ride into a SubModelPart created from the set). */
  nodes?: number[];
}

/** A seed resolution: a non-undefined `reason` means nothing was selected. */
export interface SeedResolution {
  kinds: { Elements: Set<number>; Conditions: Set<number>; Geometries: Set<number> };
  /** undefined = ok; otherwise a human-readable reason why nothing was selected. */
  reason?: string;
}

/** Per-kind id universe of a model, built from `blocks`' `entityIds`. */
export function entityUniverses(model: MdpaModel): Record<EntityKind, Set<number>> {  const sets: Record<EntityKind, Set<number>> = {
    Elements: new Set(),
    Conditions: new Set(),
    Geometries: new Set(),
  };
  for (const b of model.blocks) {
    const target = sets[b.kind];
    for (const id of b.entityIds) target.add(id);
  }
  return sets;
}

function fieldFor(model: MdpaModel, variable: string, blockKind: FieldData["kind"]): FieldData | undefined {
  const lowered = variable.toLowerCase();
  return model.fields.find((f) => f.kind === blockKind && f.variable.toLowerCase() === lowered);
}

/** No-op-propagation-safe per-kind merge of one seed's resolution. */
export function resolveSeed(
  model: MdpaModel,
  seed: SelectionSeed,
  qualityReport?: QualityReport
): SeedResolution {
  const kinds = {
    Elements: new Set<number>(),
    Conditions: new Set<number>(),
    Geometries: new Set<number>(),
  };
  switch (seed.kind) {
    case "explicit":
      // Explicit seeds resolve only against frozen ids, which the caller
      // intersects through `refreshSelection`; there is nothing to walk.
      return { kinds };

    case "part": {
      const part = findSubModelPart(model, seed.path);
      if (!part) return { kinds, reason: `no SubModelPart named "${seed.path}".` };
      kinds.Elements = new Set(part.elementIds);
      kinds.Conditions = new Set(part.conditionIds);
      kinds.Geometries = new Set(part.geometryIds);
      if (kinds.Elements.size + kinds.Conditions.size + kinds.Geometries.size === 0)
        return { kinds, reason: `SubModelPart "${seed.path}" lists no entities (nodes only).` };
      return { kinds };
    }

    case "field": {
      const field = fieldFor(model, seed.variable, seed.blockKind);
      if (!field) return { kinds, reason: `no ${seed.blockKind} field named "${seed.variable}".` };
      const { elementIds, conditionIds } = thresholdCells(model, field, effectiveComponent(seed, field), [seed.lo, seed.hi], seed.rule ?? "all");
      kinds.Elements = new Set(elementIds);
      kinds.Conditions = new Set(conditionIds);
      if (kinds.Elements.size + kinds.Conditions.size === 0)
        return { kinds, reason: `no cell's "${seed.variable}" value falls in [${seed.lo}, ${seed.hi}].` };
      return { kinds };
    }

    case "property": {
      if (!findPropertySet(model.properties, seed.propertyId))
        return { kinds, reason: `no Properties block with id ${seed.propertyId}.` };
      for (const b of model.blocks) {
        if (!b.propertyIds) continue;
        const length = Math.min(b.propertyIds.length, b.count);
        for (let i = 0; i < length; i++) {
          if (b.propertyIds[i] === seed.propertyId) kinds[b.kind].add(b.entityIds[i]);
        }
      }
      if (kinds.Elements.size + kinds.Conditions.size + kinds.Geometries.size === 0)
        return { kinds, reason: `no entity carries property id ${seed.propertyId}.` };
      return { kinds };
    }

    case "formula": {
      const r = formulaCells(model, seed.expr, seed.rule ?? "all");
      return r.reason ? { kinds: r.kinds, reason: r.reason } : { kinds: r.kinds };
    }

    case "quality": {
      const metric = qualityReport?.metrics.find((m) => m.key === seed.metric);
      if (!metric) return { kinds, reason: `unknown quality metric "${seed.metric}".` };
      if (!metric.perElement) return { kinds, reason: `metric "${seed.metric}" is not per-element.` };
      if (metric.badEntityIds.length === 0)
        return { kinds, reason: `metric "${seed.metric}" has no bad/unacceptable element.` };
      kinds.Elements = new Set(metric.badEntityIds);
      return { kinds };
    }
  }
}

/** Clamps a seed's component to what the field carries, defaulting sensibly. */
function effectiveComponent(seed: Extract<SelectionSeed, { kind: "field" }>, field: FieldData): FieldComponent {
  const requested = seed.component ?? (field.kind === "Nodal" ? "mag" : 0);
  if (requested === "mag") return "mag";
  return Number(requested) >= 0 && Number(requested) < field.components ? requested : field.kind === "Nodal" ? "mag" : 0;
}

/** Counts per kind of a resolution/set (the UI's set rows). */
export function counts(kinds: KindIdSets): { elements: number; conditions: number; geometries: number; total: number } {
  const elements = kinds.Elements.length;
  const conditions = kinds.Conditions.length;
  const geometries = kinds.Geometries.length;
  return { elements, conditions, geometries, total: elements + conditions + geometries };
}

/**
 * The even-odd crossing test for the lasso's **screen-space** polygon: a
 * sample is inside when the ray to the left crosses an odd number of edges.
 * Screen coordinates only, so no winding-preservation caveat applies — the
 * webview closes any polygon the user draws, self-intersections and all, and
 * even-odd is the technically honest answer for a drawn lasso anyway.
 */
export function pointInPolygon(
  x: number,
  y: number,
  pts: readonly { x: number; y: number }[]
): boolean {
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > y) !== (yj > y)) {
      const t = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
      if (t === 0) return true; // exactly on the edge: inside (the lasso traced it)
      if ((yj - yi) === 0) {
        if (Math.min(xi, xj) <= x && x <= Math.max(xi, xj)) return true; // a horizontal edge at y
      } else {
        const crossing = (xj - xi) * (y - yi) / (yj - yi) + xi;
        if (x < crossing) inside = !inside;
      }
    }
  }
  return inside;
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An explicit set that lost picked ids to a model that no longer has them. */
export interface SelectionPruneReport {
  name: string;
  pruned: KindIdSets;
}

/**
 * Re-evaluate a set list against `model`. Predicates re-resolve; explicit
 * sets intersect the id universes. Returns the NEW list (never mutates the
 * input) plus whether any set's content changed — among them pruned explicit
 * ids and sets whose reason (failure) newly appeared or cleared.
 *
 * `reports` names the sets that LOST picked ids, which is the one change a
 * user cannot see the cause of: a predicate re-resolving to a different set is
 * what a predicate does, whereas an explicit set shrinking means entities it
 * named are gone from the mesh. Only that case is reported, so stepping a
 * timeline through a field-seeded set does not narrate itself every frame.
 */
export function refreshSelection(
  model: MdpaModel,
  sets: readonly SelectionSet[],
  qualityReport?: QualityReport
): { sets: SelectionSet[]; changed: boolean; reports: SelectionPruneReport[] } {
  const universes = entityUniverses(model);
  const out: SelectionSet[] = [];
  const reports: SelectionPruneReport[] = [];
  let changed = false;
  for (const s of sets) {
    if (s.seed.kind === "explicit") {
      const kinds = { Elements: [] as number[], Conditions: [] as number[], Geometries: [] as number[] };
      const pruned: KindIdSets = { Elements: [], Conditions: [], Geometries: [] };
      for (const k of ENTITY_KINDS) {
        for (const id of s.kinds[k]) {
          if (universes[k].has(id)) kinds[k].push(id);
          else pruned[k].push(id);
        }
        if (pruned[k].length > 0) changed = true;
        else if (kinds[k].length !== s.kinds[k].length) changed = true;
      }
      if (pruned.Elements.length + pruned.Conditions.length + pruned.Geometries.length > 0) {
        reports.push({ name: s.name, pruned });
      }
      out.push({ ...s, kinds });
      continue;
    }
    const r = resolveSeed(model, s.seed, qualityReport);
    const kinds = { Elements: idsOfSorted(r.kinds.Elements), Conditions: idsOfSorted(r.kinds.Conditions), Geometries: idsOfSorted(r.kinds.Geometries) };
    if (!sameIds(kinds.Elements, s.kinds.Elements) || !sameIds(kinds.Conditions, s.kinds.Conditions) || !sameIds(kinds.Geometries, s.kinds.Geometries))
      changed = true;
    out.push({ ...s, kinds });
  }
  return { sets: out, changed, reports };
}

function idsOfSorted(set: ReadonlySet<number>): number[] {
  return set.size === 0 ? [] : Array.from(set).sort((a, b) => a - b);
}

/**
 * Is any entity of any kind picked in the list (the enable/disable guards'
 * question for "New SubModelPart from set" / "Export set…")?
 */
export function anySelected(sets: readonly SelectionSet[]): boolean {
  return sets.some((s) => counts(s.kinds).total > 0);
}

// --- Persistence --------------------------------------------------------------

/** A defensive bound: a sidecar is a small view annotation, not a mesh export. */
export const MAX_SELECTION_SETS = 32;
/** Per kind, per set. Above it the set is a mesh export, not a selection. */
export const MAX_SELECTION_IDS = 50_000;

/**
 * One selection set as it is written to the view sidecar.
 *
 * `SelectionSet` is already plain JSON (no `Set`, no typed arrays), so the
 * difference is only what is OPTIONAL: `kinds` is the frozen id snapshot and
 * is written only for an `explicit` seed, where the ids ARE the set. A
 * predicate seed carries its definition instead and re-resolves on the next
 * open — which is both the "refresh by definition" rule this module already
 * applies on every model change, and what keeps a field-window set over a
 * million-cell mesh from writing a million ids into a sidecar nobody edits by
 * hand.
 */
export interface SavedSelectionSet {
  name: string;
  seed: SelectionSeed;
  /** Present only for an `explicit` seed. */
  kinds?: KindIdSets;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function cleanSelectionIds(xs: unknown, limit = MAX_SELECTION_IDS): number[] {
  if (!Array.isArray(xs)) return [];
  const out = new Set<number>();
  for (const v of xs) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out.add(v);
  }
  // Ascending, so "the first N" means the lowest ids rather than an arbitrary slice.
  const all = Array.from(out).sort((a, b) => a - b);
  return all.length > limit ? all.slice(0, limit) : all;
}

/**
 * Reads one `SelectionSeed` back. Returns undefined for anything it cannot
 * spell, so the caller drops the whole set rather than guessing at half a
 * predicate — a seed that resolves differently than it was authored is worse
 * than a set that has to be rebuilt.
 */
export function validateSelectionSeed(raw: unknown): SelectionSeed | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "explicit":
      return { kind: "explicit" };
    case "part":
      return typeof r.path === "string" && r.path.length > 0 && r.path.length < 1024
        ? { kind: "part", path: r.path }
        : undefined;
    case "field": {
      if (typeof r.variable !== "string" || !r.variable) return undefined;
      const blockKind = r.blockKind;
      if (blockKind !== "Nodal" && blockKind !== "Elemental" && blockKind !== "Conditional") return undefined;
      if (!isFiniteNumber(r.lo) || !isFiniteNumber(r.hi)) return undefined;
      const c = r.component;
      const component =
        c === "mag" || (typeof c === "number" && Number.isInteger(c) && c >= 0 && c < 16)
          ? (c as FieldComponent)
          : undefined;
      const rule = r.rule === "all" || r.rule === "any" ? r.rule : undefined;
      // Only the keys the author actually set are carried, so a
      // serialize → validate → serialize round trip is stable.
      return {
        kind: "field",
        variable: r.variable,
        blockKind,
        lo: r.lo,
        hi: r.hi,
        ...(component !== undefined ? { component } : {}),
        ...(rule !== undefined ? { rule } : {}),
      };
    }
    case "quality":
      return typeof r.metric === "string" && r.metric.length > 0 && r.metric.length < 128
        ? { kind: "quality", metric: r.metric }
        : undefined;
    case "property":
      return typeof r.propertyId === "number" && Number.isInteger(r.propertyId) && r.propertyId >= 0
        ? { kind: "property", propertyId: r.propertyId }
        : undefined;
    case "formula": {
      if (typeof r.expr !== "string" || r.expr.trim().length === 0 || r.expr.length > 1000) return undefined;
      const rule = r.rule === "all" || r.rule === "any" || r.rule === "centroid" ? r.rule : undefined;
      return { kind: "formula", expr: r.expr, ...(rule ? { rule } : {}) };
    }
    default:
      return undefined;
  }
}

/** A fresh copy of a seed, so the serialized form shares nothing with the live set. */
function cloneSeed(seed: SelectionSeed): SelectionSeed {
  switch (seed.kind) {
    case "explicit":
      return { kind: "explicit" };
    case "part":
      return { kind: "part", path: seed.path };
    case "quality":
      return { kind: "quality", metric: seed.metric };
    case "property":
      return { kind: "property", propertyId: seed.propertyId };
    case "formula":
      return { kind: "formula", expr: seed.expr, ...(seed.rule ? { rule: seed.rule } : {}) };
    case "field":
      return {
        kind: "field",
        variable: seed.variable,
        blockKind: seed.blockKind,
        lo: seed.lo,
        hi: seed.hi,
        ...(seed.component !== undefined ? { component: seed.component } : {}),
        ...(seed.rule !== undefined ? { rule: seed.rule } : {}),
      };
  }
}

/** The JSON form of a set list (fresh copies, no shared references). */
export function serializeSelectionSets(sets: readonly SelectionSet[]): SavedSelectionSet[] {
  return sets.slice(0, MAX_SELECTION_SETS).map((s) => {
    const out: SavedSelectionSet = { name: s.name, seed: cloneSeed(s.seed) };
    if (s.seed.kind === "explicit") {
      out.kinds = {
        Elements: s.kinds.Elements.slice(0, MAX_SELECTION_IDS),
        Conditions: s.kinds.Conditions.slice(0, MAX_SELECTION_IDS),
        Geometries: s.kinds.Geometries.slice(0, MAX_SELECTION_IDS),
      };
    }
    return out;
  });
}

/**
 * Tolerant read of a persisted set list, the recipe-tolerance rule
 * `parseOpsJson` / `parseCaseJson` / `validateUserLayers` all follow: a bad
 * entry is dropped with a warning and the rest survive, so a hand-edited or
 * newer-writer sidecar degrades instead of failing an open.
 *
 * A missing `kinds` is NOT an error: it is the normal shape of a predicate
 * set, and it re-resolves against the model that opens (see
 * `refreshSelection`). An `explicit` set that lost its snapshot is dropped
 * rather than silently restored as an empty one.
 */
export function validateSelectionSets(raw: unknown): { sets: SelectionSet[]; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined) return { sets: [], warnings };
  if (!Array.isArray(raw)) {
    return { sets: [], warnings: ["View sidecar selections are not an array — ignored."] };
  }
  if (raw.length > MAX_SELECTION_SETS) {
    warnings.push(`View sidecar keeps at most ${MAX_SELECTION_SETS} selection sets — the rest were dropped.`);
  }
  const sets: SelectionSet[] = [];
  const seenNames = new Set<string>();
  for (const entry of raw.slice(0, MAX_SELECTION_SETS)) {
    const label = `Selection set ${sets.length + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`${label} is malformed — dropped.`);
      continue;
    }
    const r = entry as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name || name.length > 120) {
      warnings.push(`${label} has no usable name — dropped.`);
      continue;
    }
    let unique = name;
    if (seenNames.has(unique)) {
      let n = 2;
      while (seenNames.has(`${name} (${n})`)) n++;
      unique = `${name} (${n})`;
      warnings.push(`Duplicate selection set name "${name}" renamed to "${unique}".`);
    }
    seenNames.add(unique);
    const seed = validateSelectionSeed(r.seed);
    if (!seed) {
      warnings.push(`Selection set "${unique}" has an unreadable seed — dropped.`);
      continue;
    }
    const rawKinds = (r.kinds as Record<string, unknown> | undefined) ?? {};
    const kinds: KindIdSets = {
      Elements: cleanSelectionIds(rawKinds.Elements),
      Conditions: cleanSelectionIds(rawKinds.Conditions),
      Geometries: cleanSelectionIds(rawKinds.Geometries),
    };
    for (const k of ENTITY_KINDS) {
      const list = rawKinds[k];
      if (Array.isArray(list) && kinds[k].length < list.length) {
        warnings.push(`Selection set "${unique}": kept the first ${MAX_SELECTION_IDS} ${k.toLowerCase()} — the rest were dropped.`);
      }
    }
    if (seed.kind === "explicit") {
      // An explicit seed's snapshot IS the set, so one that survived with
      // nothing in it cannot be restored as a set the user never made.
      if (kinds.Elements.length + kinds.Conditions.length + kinds.Geometries.length === 0) {
        warnings.push(`Selection set "${unique}" was made of explicit picks but kept none — dropped.`);
        continue;
      }
    } else {
      // A predicate seed re-resolves on open, so the snapshot is never read
      // back — and never carried, so a stale one cannot outlive its mesh.
      kinds.Elements = [];
      kinds.Conditions = [];
      kinds.Geometries = [];
    }
    sets.push({ name: unique, seed, kinds });
  }
  return { sets, warnings };
}

/** One short prose line describing what a seed asks for (UI rows/outcome messages). */
export function describeSeed(seed: SelectionSeed): string {
  switch (seed.kind) {
    case "explicit":
      return "explicit picks";
    case "part":
      return `SubModelPart ${seed.path}`;
    case "field":
      return `${seed.variable} in [${seed.lo}, ${seed.hi}]`;
    case "quality":
      return `quality metric ${seed.metric} (bad/unacceptable)`;
    case "property":
      return `property id ${seed.propertyId}`;
    case "formula":
      return `formula ${seed.expr}${seed.rule && seed.rule !== "all" ? ` (${seed.rule})` : ""}`;
  }
}
