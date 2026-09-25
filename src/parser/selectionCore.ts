/**
 * Selection sets: named groups of entities (per KIND — Elements, Conditions
 * and Geometries each have their own id space) that can be seeded by a
 * predicate and re-evaluated when the model changes.
 *
 * Pure module (no vscode / DOM / vtk / wasm), the same Node-testable tier as
 * `thresholdCells.ts` / `selectCells.ts`, which this composes. The webview
 * holds the state; nothing here is serialized to disk or enters the operation
 * history — the persistent artifacts selection drives are the ops the user
 * issues from it (`createSubModelPartFromSelection`, property edits).
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
  | { kind: "property"; propertyId: number };

/** One named selection set. Id lists are sorted ascending. */
export interface SelectionSet {
  name: string;
  seed: SelectionSeed;
  kinds: { Elements: number[]; Conditions: number[]; Geometries: number[] };
}

/** A seed resolution: a non-undefined `reason` means nothing was selected. */
export interface SeedResolution {
  kinds: { Elements: Set<number>; Conditions: Set<number>; Geometries: Set<number> };
  /** undefined = ok; otherwise a human-readable reason why nothing was selected. */
  reason?: string;
}

/** Per-kind id universe of a model, built from `blocks`' `entityIds`. */
export function entityUniverses(model: MdpaModel): Record<EntityKind, Set<number>> {
  const sets: Record<EntityKind, Set<number>> = {
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

/**
 * Re-evaluate a set list against `model`. Predicates re-resolve; explicit
 * sets intersect the id universes. Returns the NEW list (never mutates the
 * input) plus whether any set's content changed — among them pruned explicit
 * ids and sets whose reason (failure) newly appeared or cleared.
 */
export function refreshSelection(
  model: MdpaModel,
  sets: readonly SelectionSet[],
  qualityReport?: QualityReport
): { sets: SelectionSet[]; changed: boolean } {
  const universes = entityUniverses(model);
  const out: SelectionSet[] = [];
  let changed = false;
  for (const s of sets) {
    if (s.seed.kind === "explicit") {
      const kinds = { Elements: [] as number[], Conditions: [] as number[], Geometries: [] as number[] };
      for (const k of ENTITY_KINDS) {
        const kept = s.kinds[k].filter((id) => universes[k].has(id));
        if (kept.length !== s.kinds[k].length) changed = true;
        kinds[k] = kept;
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
  return { sets: out, changed };
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
  }
}
