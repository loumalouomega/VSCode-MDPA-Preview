/**
 * The Hessian (second derivative) of a scalar nodal field. Backed by meshio++'s
 * `hessian` (>= 10.9.0).
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. The input is
 * never mutated; a fresh MdpaModel is returned.
 *
 * ## Why this is an oracle, like gradientField.ts
 *
 * Adopting the mesh a meshio++ operation returns is badly lossy —
 * `modelToMeshio`/`meshioToModel` drops the Elements/Conditions/Geometries kind
 * of a block, every `propertyId` and every original entity id. So this module
 * asks exactly one question — "what is the second derivative at each node?" —
 * and writes the answer onto a clone of our own model as a new Nodal field.
 * Nothing else crosses back.
 *
 * That works because the operation is asked for `location: "point"`, which
 * yields ONE tuple per existing node in the input's own order. The result is
 * rejected outright if the tuple count does not match, which is the same guard
 * gradientField.ts applies and for the same reason: a mismatch means node order
 * cannot be trusted, and scattering curvature values onto the wrong nodes would
 * look perfectly clean in the field picker.
 *
 * ## Width, and why it is read back rather than assumed
 *
 * The Hessian of a scalar is the flattened row-major 3x3 matrix, `H[i][j]` at
 * index `i*3+j` — 9 components. The width is read off the returned mesh's
 * `point_data_components` map anyway, so an upstream change surfaces as a
 * rejected result instead of a silently misinterpreted array.
 *
 * ## Scalar only, and why that is enforced here rather than discovered
 *
 * Upstream raises on a multi-component array: a vector field's Hessian is a
 * separate quantity per component. Rejecting it in this layer lets the message
 * say what to do about it (differentiate one component at a time) instead of
 * surfacing a binding-level complaint about array widths.
 *
 * ## The caveat worth surfacing to a user
 *
 * `hessian` is a composition of two `gradient` calls, not a new kernel. That is
 * exact for a field that is at most linear (its Hessian is exactly zero
 * everywhere — the one mesh-shape-independent guarantee) and on a
 * structured/symmetric mesh away from its boundary, but it is a genuinely
 * approximate curvature estimate on an irregular mesh. `numSkipped` (nodes that
 * came back NaN) and `numFallback` (least-squares neighbourhoods that fell back
 * to Green-Gauss) are reported rather than hidden, since a partly-NaN field
 * looks clean in the field picker and is not.
 */

import { loadMeshio } from "./meshio";
import { modelToMeshio, sanitizeVariable } from "./meshioConvert";
import { FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import { GradientMethod, GRADIENT_METHODS } from "./gradientField";

export interface HessianParams {
  /** The NODAL field to differentiate twice. Must be scalar. */
  variable: string;
  /**
   * Forwarded to BOTH internal gradient passes. `green-gauss` (default) applies
   * the divergence theorem over each cell's own faces; `least-squares` fits over
   * the node-sharing neighbours and is smoother on an irregular mesh.
   */
  method?: GradientMethod;
  /** Name for the new field. Defaults to `<variable>_HESSIAN`. */
  output?: string;
}

export interface HessianResult {
  model: MdpaModel;
  /** The field that was created, or "" when the op was a noop. */
  output: string;
  /** Components of the new field: 9 for the flattened 3x3. */
  components: number;
  /** Nodes whose value could not be computed and came back NaN. */
  numSkipped: number;
  /** Least-squares neighbourhoods that fell back to Green-Gauss. */
  numFallback: number;
}

export { GRADIENT_METHODS as HESSIAN_METHODS };

export async function hessianFieldModel(
  model: MdpaModel,
  params: HessianParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<HessianResult> {
  const method = params.method ?? "green-gauss";
  const noop: HessianResult = {
    model,
    output: "",
    components: 0,
    numSkipped: 0,
    numFallback: 0,
  };

  const source = model.fields.find(
    (f) => f.kind === "Nodal" && f.variable === params.variable
  );
  if (!source) {
    // An Elemental field is piecewise constant, so it has no derivative at all
    // — which is a different message from "no such field".
    const elsewhere = model.fields.find((f) => f.variable === params.variable);
    throw new Error(
      elsewhere
        ? `"${params.variable}" is a ${elsewhere.kind} field, which is piecewise ` +
          `constant and has no derivative. Move it to the nodes first with the ` +
          `Average field operation, then differentiate.`
        : `No nodal field named "${params.variable}".`
    );
  }
  if (source.components !== 1) {
    // Upstream raises on this too, but a message naming the way forward beats
    // one naming an array width.
    throw new Error(
      `The Hessian is defined for a scalar field; "${params.variable}" has ` +
        `${source.components} components. Split it first (Field calculator, ` +
        `e.g. "${params.variable.toLowerCase()}_x") and differentiate one ` +
        `component at a time.`
    );
  }
  if (model.nodeCount === 0) return noop;

  // dim: 3 unconditionally, for the same reason smoothMesh.ts forces it — a
  // planar model would otherwise come back two-wide and every consumer of the
  // result would have to branch.
  const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
  if (mesh.cells.length === 0) return noop;

  // modelToMeshio sanitizes a Kratos variable name on the way out, so ask for
  // the name it actually emitted rather than the one the user typed.
  const inName = sanitizeVariable(params.variable);
  if (!mesh.point_data?.[inName]) return noop;
  const outName = "__hess__"; // never collides; renamed on the way back

  const m = await loadMeshio();
  const r = m.hessian(mesh, inName, method, "point", outName, true);

  const arr = r.mesh.point_data?.[outName];
  if (!arr) {
    throw new Error(`hessian produced no "${outName}" array; the result was discarded.`);
  }
  const components = r.mesh.point_data_components?.[outName] ?? 1;
  if (components < 1 || arr.length !== components * model.nodeCount) {
    // The whole design rests on one tuple per node, in order. Refuse rather
    // than scatter values onto the wrong nodes.
    throw new Error(
      `hessian returned ${arr.length} values (${components} components) for ` +
        `${model.nodeCount} nodes; node order cannot be trusted, so the result ` +
        `was discarded.`
    );
  }

  const variable = sanitizeVariable(
    params.output?.trim() || `${params.variable}_HESSIAN`
  );
  const ids = new Int32Array(model.nodeCount);
  for (let i = 0; i < model.nodeCount; i++) ids[i] = model.nodeIds[i];
  const field: FieldData = {
    kind: "Nodal",
    variable,
    components,
    ids,
    values: Float64Array.from(arr),
  };
  // Re-running the op replaces its own output rather than stacking a second
  // field of the same name, the same rule partitionMesh.ts follows.
  const fields = model.fields.filter(
    (f) => !(f.kind === "Nodal" && f.variable === variable)
  );
  fields.push(field);

  return {
    model: { ...model, fields },
    output: variable,
    components,
    numSkipped: r.numSkipped,
    numFallback: r.numFallback,
  };
}
