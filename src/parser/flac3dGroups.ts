/**
 * FLAC3D (`.f3grid`) group handling — roadmap item 3's "FLAC3D group
 * handling" scope, refreshed against the live 15.4.0 wasm (measured, not
 * assumed) rather than the pre-bump behaviour.
 *
 * Two independent facts, each verified by writing a real `MdpaModel` to
 * `.f3grid` and reading it back through the live wasm:
 *
 * 1. **Region naming.** meshio++'s own `mesh.regions` convention names a
 *    FLAC3D group `<zone|face>:<name>:<slot>` (upstream doc:
 *    `doc/formats/flac3d.md`) — `regionsToParts` (meshioRegions.ts) has no
 *    FLAC3D awareness, so it carries that whole string through verbatim as
 *    the SubModelPart name/path (`zone:Inlet:Default`), including a
 *    redundant per-BLOCK group meshio++'s writer already emits from our own
 *    `Cell` regions (`zone:Element3D4N:Default`). `cleanFlac3dPartNames`
 *    strips the prefix and folds a `Default` slot away entirely — the
 *    common case, since nothing here ever writes another slot — leaving a
 *    non-default slot as `<name> (<slot>)` rather than a fabricated parent
 *    part: FLAC3D's SLOT is a second, independent tagging axis (one zone
 *    can sit in several same-slot groups), not a containment hierarchy, so
 *    turning it into a SubModelPart PARENT would assert a nesting relation
 *    the file never claimed and would need `subModelPartTree.ts`'s
 *    union-of-children invariant maintained for a relation this format does
 *    not actually have.
 * 2. **Face cells arrive as Elements.** FLAC3D's own FACE section is
 *    structurally 2D-only (triangle/quad) and ZONE is structurally 3D-only
 *    — unlike, say, Gmsh, where 2D and 3D cells commingle with no special
 *    meaning — so every 2D block a `.f3grid` read produces is a genuine
 *    FLAC3D face, i.e. Kratos Conditions, not Elements. The generic meshio
 *    bridge has no such distinction (every block reads as Elements
 *    regardless of format), so `reclassifyFlac3dFaces` reassigns every
 *    surface-category block into its own Conditions id space (mirroring
 *    `openfoamCase.ts`'s `applyOpenFoamPatches`), remapping SubModelPart
 *    membership and any Elemental field that names a reclassified id.
 *
 * `cell_data["cell_ids"]` — the reader's own bookkeeping array (the file's
 * original 1-based zone/face id, per meshio++'s "Data mapping" doc) — is
 * dropped rather than shown as a user field: our own model already carries
 * a faithful, block-position-derived entity id, and "cell_ids" would read
 * as unexplained noise next to it.
 *
 * The write side needed NO change at all — measured directly: a plain
 * SubModelPart name with no colon (what `modelToMeshio`'s own per-block and
 * per-part `Cell` regions already emit, and what `cleanFlac3dPartNames`
 * produces) writes back as `ZGROUP "<name>" SLOT "Default"` on its own,
 * upstream defaulting the slot when the region name carries none. The one
 * consequence: re-exporting a `.f3grid` this extension already cleaned
 * loses a non-`Default` SLOT distinction (folded into the display name,
 * `<name> (<slot>)`, which has no colon either) — SLOT is a second, cross-
 * cutting tagging axis with no SubModelPart equivalent, so this is a
 * documented, one-way simplification rather than a round-trip promise.
 *
 * Pure (no vscode/DOM/wasm); called from meshFileParser.ts's dedicated
 * `.f3grid` branch, after `readMeshioModel`.
 */

import { EntityBlock, FieldData, MdpaModel, SubModelPart } from "./types";
import { cellCategory } from "./writers/writerCommon";
import { sortedUnique } from "./meshioRegions";

/** meshio++'s reader's own FLAC3D bookkeeping field — never user data. */
const FLAC3D_INTERNAL_FIELDS = new Set(["cell_ids"]);

export interface Flac3dRegionName {
  space: "zone" | "face";
  name: string;
  slot: string;
}

/**
 * Parses meshio++'s `<zone|face>:<name>:<slot>` FLAC3D region-name
 * convention. The split for `name`/`slot` is on the LAST colon (a group
 * name may itself contain one; a slot may not — the same rule the writer
 * uses in reverse, per upstream's doc). Returns `undefined` for anything
 * that does not start with a recognised space prefix, so a plain
 * (non-FLAC3D-shaped) SubModelPart name — including one this same code
 * already cleaned on an earlier pass — is left untouched.
 */
export function parseFlac3dRegionName(name: string): Flac3dRegionName | undefined {
  const m = /^(zone|face):(.+)$/.exec(name);
  if (!m) return undefined;
  const rest = m[2];
  const idx = rest.lastIndexOf(":");
  if (idx < 0) return undefined; // no slot half — not this convention
  return { space: m[1] as "zone" | "face", name: rest.slice(0, idx), slot: rest.slice(idx + 1) };
}

/**
 * Renames every top-level SubModelPart matching the FLAC3D convention,
 * de-duplicating collisions the same way `mergeMesh.ts`/`openfoamCase.ts`
 * already do (`_2`, `_3`, …). FLAC3D groups are always flat (upstream never
 * nests one inside another), so only top-level parts are examined.
 */
export function cleanFlac3dPartNames(model: MdpaModel): MdpaModel {
  // Pre-seed with every part this function will NOT touch, so a renamed
  // part is checked against them too — the collision a single forward pass
  // missed when the untouched part came second and never registered its
  // own name until after the rename had already claimed it.
  const used = new Set(
    model.subModelParts
      .filter((p) => !parseFlac3dRegionName(p.path))
      .map((p) => p.path)
  );
  let changed = false;
  const parts = model.subModelParts.map((p) => {
    const parsed = parseFlac3dRegionName(p.path);
    if (!parsed) return p;
    changed = true;
    let name = parsed.slot === "Default" ? parsed.name : `${parsed.name} (${parsed.slot})`;
    for (let n = 2; used.has(name); n++) {
      name = parsed.slot === "Default" ? `${parsed.name}_${n}` : `${parsed.name} (${parsed.slot})_${n}`;
    }
    used.add(name);
    return { ...p, name, path: name };
  });
  return changed ? { ...model, subModelParts: parts } : model;
}

/**
 * Reassigns every surface-category (triangle/quad, linear or quadratic)
 * `Elements` block into `Conditions`, in a fresh id space, since a
 * `.f3grid` read's 2D blocks are always FLAC3D faces. A noop when the mesh
 * has no such block (a pure-zone file — the common case for a solid mesh
 * with no boundary groups at all). Unlike `applyOpenFoamPatches`'s
 * tag-based matching this never meets a partially-boundary block — a block
 * is always homogeneous in `(cellType, stride)` by construction
 * (`meshioToModel`), so there is no mixed-block case to warn about and no
 * diagnostics parameter is needed.
 */
export function reclassifyFlac3dFaces(model: MdpaModel): MdpaModel {
  const isFaceBlock = model.blocks.map(
    (b) => b.kind === "Elements" && b.count > 0 && cellCategory(b.vtkCellType) === "surface"
  );
  if (!isFaceBlock.some(Boolean)) return model;

  // old element id -> new condition id, for every cell in a face block.
  const idMap = new Map<number, number>();
  let conditionId = 1;
  const blocks: EntityBlock[] = model.blocks.map((b, bi) => {
    if (!isFaceBlock[bi]) return b;
    const entityIds = new Int32Array(b.entityIds.length);
    for (let i = 0; i < b.entityIds.length; i++) {
      const newId = conditionId++;
      idMap.set(b.entityIds[i], newId);
      entityIds[i] = newId;
    }
    return { ...b, kind: "Conditions", entityIds };
  });

  const remapPart = (p: SubModelPart): SubModelPart => {
    const stayElement: number[] = [];
    const becomeCondition: number[] = [];
    for (const id of p.elementIds) {
      const mapped = idMap.get(id);
      if (mapped !== undefined) becomeCondition.push(mapped);
      else stayElement.push(id);
    }
    const children = p.children.map(remapPart);
    if (becomeCondition.length === 0) {
      return children === p.children ? p : { ...p, children };
    }
    return {
      ...p,
      elementIds: Int32Array.from(stayElement),
      conditionIds: sortedUnique([...p.conditionIds, ...becomeCondition]),
      children,
    };
  };

  const fields = model.fields.flatMap((f) => {
    if (f.kind !== "Elemental") return [f];
    const keepIdx: number[] = [];
    const moveIdx: number[] = [];
    for (let i = 0; i < f.ids.length; i++) {
      (idMap.has(f.ids[i]) ? moveIdx : keepIdx).push(i);
    }
    if (moveIdx.length === 0) return [f];
    const pick = (idxs: number[], mapId: boolean) => {
      const ids = new Int32Array(idxs.length);
      const values = new Float64Array(idxs.length * f.components);
      idxs.forEach((srcI, dstI) => {
        ids[dstI] = mapId ? (idMap.get(f.ids[srcI]) as number) : f.ids[srcI];
        for (let c = 0; c < f.components; c++) {
          values[dstI * f.components + c] = f.values[srcI * f.components + c];
        }
      });
      return { ids, values };
    };
    const moved = pick(moveIdx, true);
    const out: FieldData[] = [
      { ...f, kind: "Conditional", ids: moved.ids, values: moved.values },
    ];
    if (keepIdx.length > 0) {
      const kept = pick(keepIdx, false);
      out.push({ ...f, ids: kept.ids, values: kept.values });
    }
    return out;
  });

  return {
    ...model,
    blocks,
    subModelParts: model.subModelParts.map(remapPart),
    fields,
  };
}

/** Drops meshio++'s own FLAC3D bookkeeping field(s) — see the module doc comment. */
export function dropFlac3dInternalFields(model: MdpaModel): MdpaModel {
  const kept = model.fields.filter((f) => !FLAC3D_INTERNAL_FIELDS.has(f.variable));
  return kept.length === model.fields.length ? model : { ...model, fields: kept };
}
