/**
 * Sets — or rescales — the RADIUS of a mesh's sphere/particle elements.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 *
 * This exists because a particle file routinely arrives with NO radius at all.
 * The file from issue #63 — a real PeriLab peridynamics run — declares 504
 * `SPHERE` elements and not one Exodus `attrib` variable, so an edit-only
 * operation would be inapplicable to the very file that motivated it. Hence
 * `absolute` may CREATE the field.
 *
 * The two modes are not redundant:
 *  - `absolute` authors a radius from nothing (the case above), or overwrites.
 *  - `multiply` rescales an imported file WITHOUT flattening per-particle
 *    variation, which is the only way to fix a units mismatch on a mesh whose
 *    radii genuinely differ. It is a noop when there is nothing to scale;
 *    inventing a base would silently make every particle identical.
 *
 * `target` scopes the change to one SubModelPart (and its subtree). That is not
 * a luxury: a multi-block Exodus file merges all its SPHERE blocks into a
 * single EntityBlock, so the SubModelParts are the ONLY handle left for giving
 * bulk and boundary particles different radii.
 */

import { FieldData, MdpaModel } from "./types";
import { findSubModelPart } from "./subModelPartExtract";
import { radiusField, RADIUS_VARIABLE, sphereBlocks } from "./sphereElements";

export type RadiusMode = "absolute" | "multiply";

export interface SetElementRadiusResult {
  model: MdpaModel;
  /** How many cells ended up with a (new or changed) radius. */
  changed: number;
  /** True when the model had no RADIUS field before. */
  created: boolean;
}

/** Every element id in a part and its descendants. */
function subtreeElementIds(model: MdpaModel, path: string): Set<number> | undefined {
  const part = findSubModelPart(model, path);
  if (!part) return undefined;
  const out = new Set<number>();
  const walk = (p: typeof part): void => {
    for (const id of p.elementIds) out.add(id);
    for (const id of p.conditionIds) out.add(id);
    for (const child of p.children) walk(child);
  };
  walk(part);
  return out;
}

export function setElementRadius(
  model: MdpaModel,
  value: number,
  mode: RadiusMode,
  target?: string
): SetElementRadiusResult {
  const noop = { model, changed: 0, created: false };
  if (!Number.isFinite(value) || value <= 0) return noop;

  // Resolve the scope first, then collect in one pass — a present-but-unknown
  // target changes nothing rather than falling through to the whole mesh.
  const scoped =
    target !== undefined && target.length > 0 ? subtreeElementIds(model, target) : undefined;
  if (target !== undefined && target.length > 0 && !scoped) return noop;

  const candidates = new Set<number>();
  for (const b of sphereBlocks(model)) {
    for (const id of b.entityIds) if (!scoped || scoped.has(id)) candidates.add(id);
  }
  if (candidates.size === 0) return noop;

  const existing = radiusField(model);
  // `multiply` has no meaningful base without existing values, and defaulting
  // one would quietly destroy the per-particle variation it exists to preserve.
  if (mode === "multiply" && !existing) return noop;

  const kind: FieldData["kind"] = existing?.kind ?? "Elemental";
  const values = new Map<number, number>();
  if (existing) {
    for (let i = 0; i < existing.ids.length; i++) values.set(existing.ids[i], existing.values[i]);
  }

  let changed = 0;
  for (const id of candidates) {
    const prior = values.get(id);
    if (mode === "multiply") {
      if (prior === undefined) continue; // nothing to scale on this cell
      values.set(id, prior * value);
    } else {
      values.set(id, value);
    }
    changed++;
  }
  if (changed === 0) return noop;

  // Ascending ids: field records are id-keyed everywhere downstream, but a
  // stable order keeps .mdpa diffs and test assertions readable.
  const ids = Array.from(values.keys()).sort((a, b) => a - b);
  const field: FieldData = {
    kind,
    variable: RADIUS_VARIABLE,
    components: 1,
    ids: Int32Array.from(ids),
    values: Float64Array.from(ids, (id) => values.get(id)!),
  };

  return {
    model: {
      ...model,
      // Replace the prior RADIUS of the same kind, keep everything else.
      fields: [
        ...model.fields.filter((f) => !(f.kind === kind && f.variable === RADIUS_VARIABLE)),
        field,
      ],
    },
    changed,
    created: existing === undefined,
  };
}
