/**
 * Cross-mesh field transfer — map fields from another mesh onto this one.
 * Backed by meshio++'s `conservativeInterpolate` (>= 10.7.0).
 *
 * Pure module: no vscode / DOM imports and, like mergeMesh.ts, no filesystem
 * access — it takes an already-parsed source model, so path handling stays in
 * operations.ts. The input is never mutated.
 *
 * ## Why conservative, not `interpolate`
 *
 * `interpolate` samples the source pointwise. `conservativeInterpolate` does an
 * exact overlap-measure weighted remap, so over the region the two meshes share
 * `sum(value * measure)` is EQUAL on both sides. For anything that is a density
 * — mass, energy, a source term — pointwise sampling quietly changes the total,
 * and the total is usually the thing that mattered.
 *
 * ## The fidelity guard, and why it is per-array
 *
 * Upstream simplexifies BOTH meshes internally (hex to tets, quad to triangles)
 * before clipping. Point count is invariant under that decomposition, but cell
 * count is NOT — a hex mesh's cells fan out sixfold. So the returned mesh's
 * cell set is not necessarily ours, and adopting a `cell_data` array wholesale
 * could scatter values across the wrong entities.
 *
 * Hence: an array is adopted only when its tuple count still matches our node
 * count (nodal) or our total cell count (elemental), and every array that does
 * not is DROPPED with a diagnostic naming it. That is gradientField.ts's
 * count-guard applied once per array rather than once per call, and it makes
 * the operation degrade honestly instead of silently corrupting a field.
 *
 * ## Nodal transfer is a SMOOTHING approximation, not a resampling
 *
 * The conservation guarantee is cell-based. `cell_data` is remapped directly,
 * but `point_data` goes by composition — point-to-cell, the clip engine, then
 * cell-to-point — so even transferring between two IDENTICAL meshes does not
 * return the source's nodal values: a corner node comes back as an average over
 * its incident cells. That is upstream's documented layered approximation, not
 * a defect here, but it is surprising enough to be worth stating: a constant
 * field survives exactly, a varying one is smoothed, and the total is what is
 * preserved. If you need pointwise fidelity on identical meshes, the field was
 * already there — this op is for moving data between DIFFERENT discretizations.
 *
 * ## What is deliberately not attempted
 *
 * The mesh meshio++ returns is never adopted, only read for its data arrays —
 * the same rule every other Group A oracle follows, and the reason
 * SubModelParts, entity ids, property ids and block kinds survive untouched.
 */

import { modelToMeshio, sanitizeVariable, meshioBlockOrder } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { EntityBlock, FieldData, MdpaDiagnostic, MdpaModel } from "./types";

/**
 * What to do when a transferred name already exists on the target — upstream's
 * own vocabulary, verified against the live artifact (which raises naming the
 * three it accepts, so a guessed fourth cannot pass silently).
 *
 * The target mesh handed to `conservativeInterpolate` carries OUR fields, so a
 * collision is the normal case whenever the source and target share a variable
 * name, not an edge case.
 */
export type TransferOnConflict = "error" | "overwrite" | "suffix";

export const TRANSFER_CONFLICTS: readonly TransferOnConflict[] = [
  "error",
  "overwrite",
  "suffix",
];

export interface TransferFieldParams {
  /**
   * Which source arrays to transfer. Empty/omitted means every `point_data`
   * AND `cell_data` array the source carries — upstream's own default, and
   * unlike `interpolate` there is one algorithm regardless of location.
   */
  arrays?: string[];
  /** Default `overwrite`: re-running the op should update, not fail. */
  onConflict?: TransferOnConflict;
}

export interface TransferFieldResult {
  model: MdpaModel;
  /** Variables that landed on our model. */
  transferred: string[];
  /** Arrays whose tuple count no longer matched, and were dropped. */
  dropped: string[];
}

function flatten(arrays: ArrayLike<number>[] | undefined): number[] {
  const out: number[] = [];
  for (const a of arrays ?? []) for (let i = 0; i < a.length; i++) out.push(a[i]);
  return out;
}

export async function transferFieldModel(
  model: MdpaModel,
  source: MdpaModel,
  params: TransferFieldParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<TransferFieldResult> {
  const noop: TransferFieldResult = { model, transferred: [], dropped: [] };
  if (model.nodeCount === 0) return noop;

  const targetMesh = modelToMeshio(model, diagnostics, { dim: 3 });
  const sourceMesh = modelToMeshio(source, diagnostics, { dim: 3 });
  if (targetMesh.cells.length === 0 || sourceMesh.cells.length === 0) return noop;

  const sourceNames = new Set([
    ...Object.keys(sourceMesh.point_data ?? {}),
    ...Object.keys(sourceMesh.cell_data ?? {}),
  ]);
  // Names are sanitized on the way out of modelToMeshio, so ask for what it
  // actually emitted rather than what the user typed.
  const wanted = (params.arrays ?? [])
    .map((n) => sanitizeVariable(n.trim()))
    .filter((n) => n.length > 0);
  for (const n of wanted) {
    if (!sourceNames.has(n)) {
      throw new Error(
        `The source mesh has no field named "${n}". It carries: ` +
          `${[...sourceNames].join(", ") || "(none)"}.`
      );
    }
  }
  if (sourceNames.size === 0) return noop;

  const m = await loadMeshio();
  // "overwrite" by default: upstream's own default is "error", which would make
  // re-running the op fail rather than update — the opposite of every other
  // field-producing op here, all of which replace their own output.
  const out = m.conservativeInterpolate(
    sourceMesh,
    targetMesh,
    wanted,
    0,
    params.onConflict ?? "overwrite"
  );

  const blocks = meshioBlockOrder(model);
  let cellCount = 0;
  for (const b of blocks) cellCount += b.count;
  const entityIds = new Int32Array(cellCount);
  {
    let c = 0;
    for (const b of blocks) for (let i = 0; i < b.count; i++) entityIds[c++] = b.entityIds[i];
  }
  const nodeIds = new Int32Array(model.nodeCount);
  for (let i = 0; i < model.nodeCount; i++) nodeIds[i] = model.nodeIds[i];

  const transferred: string[] = [];
  const dropped: string[] = [];
  const added: FieldData[] = [];
  const names = wanted.length > 0 ? wanted : [...sourceNames];

  for (const name of names) {
    const pt = out.point_data?.[name];
    if (pt) {
      const components = out.point_data_components?.[name] ?? 1;
      if (components >= 1 && pt.length === components * model.nodeCount) {
        added.push({
          kind: "Nodal",
          variable: name,
          components,
          ids: nodeIds,
          values: Float64Array.from(pt),
        });
        transferred.push(name);
      } else {
        dropped.push(name);
      }
      continue;
    }
    const cd = out.cell_data?.[name];
    if (cd) {
      const components = out.cell_data_components?.[name] ?? 1;
      const flat = flatten(cd);
      if (components >= 1 && flat.length === components * cellCount) {
        added.push({
          kind: "Elemental",
          variable: name,
          components,
          ids: entityIds,
          values: Float64Array.from(flat),
        });
        transferred.push(name);
      } else {
        // The simplexification case this module exists to catch.
        dropped.push(name);
      }
    }
  }

  for (const name of dropped) {
    diagnostics.push({
      line: 0,
      message:
        `Field "${name}" was not transferred: the result has a different entity ` +
        `count than this mesh, which happens when conservativeInterpolate's ` +
        `internal simplexification changed the cell count (a hex fans into six ` +
        `tets). Adopting it would put values on the wrong entities.`,
    });
  }
  if (added.length === 0) return { model, transferred: [], dropped };

  const replacing = new Set(added.map((f) => `${f.kind}:${f.variable}`));
  const fields = [
    ...model.fields.filter((f) => !replacing.has(`${f.kind}:${f.variable}`)),
    ...added,
  ];
  return { model: { ...model, fields }, transferred, dropped };
}
