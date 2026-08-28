/**
 * Signed distance from every node to an external surface, as a nodal field.
 * Backed by meshio++'s `sampleDistance` (>= 10.4.0).
 *
 * Pure module: no vscode / DOM imports and — like mergeMesh.ts — no filesystem
 * access either. It takes an already-parsed surface model, so path handling
 * stays in operations.ts. The input is never mutated.
 *
 * ## The purest oracle shape in the codebase
 *
 * `sampleDistance` takes a flat `[x0,y0,z0, x1,…]` array of query points and
 * returns one double per point. So OUR mesh never crosses the wasm boundary at
 * all: only the surface is converted, and what comes back is one value per node
 * in the order we sent them. There is no `modelToMeshio` round trip to lose
 * SubModelParts, block kinds, property ids or entity ids to — the model is
 * cloned with one extra field and nothing else can differ.
 *
 * `distanceToSurface` would have done the same job by attaching the field to a
 * converted copy of our mesh; it is deliberately not used, because that copy is
 * exactly the lossy round trip this design exists to avoid.
 *
 * ## Why this op earns its place
 *
 * The extension already has `levelset` (MMG), which splits a mesh along the
 * isosurface of a NODAL field. It had no way to produce such a field from an
 * imported geometry. Together the two are "cut this mesh along that surface",
 * with no new machinery: run `sdfDistance`, then `levelset` on its output.
 *
 * ## Sign convention
 *
 * Negative is inside, matching upstream. The surface must be closed for
 * "inside" to mean anything at all — an open surface still yields distances,
 * but the sign is not meaningful, which is what `watertightCheck` warns about.
 */

import { modelToMeshio, sanitizeVariable } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { FieldData, MdpaDiagnostic, MdpaModel } from "./types";

/** How the inside/outside sign is decided. */
export type SdfSign = "pseudonormal" | "winding" | "none";

export const SDF_SIGNS: readonly SdfSign[] = ["pseudonormal", "winding", "none"];

export const SDF_VARIABLE = "SDF_DISTANCE";

export interface SdfParams {
  /**
   * `pseudonormal` (default) is the fast angle-weighted test; `winding` is the
   * robust generalized winding number, slower but tolerant of small holes;
   * `none` returns unsigned distance.
   */
  sign?: SdfSign;
  /**
   * Only compute exact values within this distance of the surface, clamping
   * beyond it — a speed/accuracy trade for a narrow band. 0 (default) = no band.
   */
  band?: number;
  /** Name for the new field. Defaults to `SDF_DISTANCE`. */
  output?: string;
}

export interface SdfResult {
  model: MdpaModel;
  /** The field that was created, or "" when the op was a noop. */
  output: string;
  /** Nodes that came out negative, i.e. inside the surface. */
  numInside: number;
  /** Nodes clamped by `band` rather than measured exactly. */
  numBanded: number;
}

export async function sdfFieldModel(
  model: MdpaModel,
  surface: MdpaModel,
  params: SdfParams = {},
  diagnostics: MdpaDiagnostic[] = []
): Promise<SdfResult> {
  const noop: SdfResult = { model, output: "", numInside: 0, numBanded: 0 };
  if (model.nodeCount === 0) return noop;

  // Only the SURFACE is converted. dim: 3 for the same reason the other oracles
  // force it — a planar surface would otherwise come back two-wide.
  const surfaceMesh = modelToMeshio(surface, diagnostics, { dim: 3 });
  if (surfaceMesh.cells.length === 0) {
    throw new Error(
      "The surface file has no cells, so there is nothing to measure distance to."
    );
  }

  // Our coordinates go over as plain numbers, in nodeIds order.
  const points: number[] = [];
  for (let i = 0; i < model.nodeCount; i++) {
    points.push(model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]);
  }

  const m = await loadMeshio();
  // "warn" rather than "error": an open surface still yields usable UNSIGNED
  // distances, and refusing the whole operation would be worse than returning
  // values whose sign the caller was told not to trust.
  const band = params.band && params.band > 0 ? params.band : 0;
  const values = m.sampleDistance(
    surfaceMesh,
    points,
    params.sign ?? "pseudonormal",
    band,
    "warn"
  );

  if (values.length !== model.nodeCount) {
    // One value per node, in order, is the whole basis of this design.
    throw new Error(
      `sampleDistance returned ${values.length} values for ${model.nodeCount} ` +
        `nodes; node order cannot be trusted, so the result was discarded.`
    );
  }

  let numInside = 0;
  let numBanded = 0;
  for (const v of values) {
    if (v < 0) numInside++;
    // A banded run clamps to +/-band exactly; count those so a suspiciously
    // flat field is explained rather than mysterious.
    if (band > 0 && Math.abs(Math.abs(v) - band) < 1e-12) numBanded++;
  }

  const variable = sanitizeVariable(params.output?.trim() || SDF_VARIABLE);
  const ids = new Int32Array(model.nodeCount);
  for (let i = 0; i < model.nodeCount; i++) ids[i] = model.nodeIds[i];
  const field: FieldData = {
    kind: "Nodal",
    variable,
    components: 1,
    ids,
    values: Float64Array.from(values),
  };
  // Re-running replaces its own output rather than stacking a duplicate.
  const fields = model.fields.filter(
    (f) => !(f.kind === "Nodal" && f.variable === variable)
  );
  fields.push(field);

  return { model: { ...model, fields }, output: variable, numInside, numBanded };
}
