/**
 * Field differential operators — the gradient, divergence or curl of a nodal
 * field. Backed by meshio++'s `gradient` (>= 9.10.0).
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. The input is
 * never mutated; a fresh MdpaModel is returned.
 *
 * ## Why this is an oracle, like smoothMesh.ts
 *
 * A meshio++ operation returns a whole mesh, and adopting one is badly lossy:
 * `modelToMeshio`/`meshioToModel` drops the Elements/Conditions/Geometries
 * kind of a block, every `propertyId` and every original entity id. So this
 * module asks meshio++ exactly one question — "what is the derivative at each
 * node?" — and writes the answer onto a clone of our own model as a new Nodal
 * field. Nothing else crosses back.
 *
 * That works because the operation is asked for `location: "point"`, which
 * yields ONE tuple per existing node, in the input's own order — the same
 * invariant smoothMesh.ts relies on for moved coordinates, and the reason the
 * result is rejected outright if the tuple count does not match.
 *
 * ## What the widths are
 *
 * `gradient` of an `nc`-component field has `3 * nc` components, row-major as
 * [component][derivative] — so a scalar gives 3 and a 3-vector gives 9.
 * `divergence` gives 1 and `curl` gives 3, and both need a 2- or 3-component
 * input. The width is read back from the returned mesh's components map rather
 * than assumed, so an upstream change surfaces as a rejected result instead of
 * a silently misinterpreted array.
 *
 * ## The two caveats worth surfacing to a user
 *
 * A cell meshio++ cannot differentiate (below the mesh's own topological
 * dimension, a ragged polygon block, a high-order type with no face table, or a
 * degenerate one) yields NaN rather than an approximation, counted in
 * `numSkipped`. And `least-squares` falls back to Green-Gauss on a
 * rank-deficient neighbourhood, counted in `numFallback`. Both are reported so
 * the caller can say so rather than presenting a partly-NaN field as clean.
 */

import { loadMeshio } from "./meshio";
import { modelToMeshio, sanitizeVariable } from "./meshioConvert";
import { FieldData, MdpaDiagnostic, MdpaModel } from "./types";

export type GradientOperator = "gradient" | "divergence" | "curl";
export type GradientMethod = "green-gauss" | "least-squares";

export const GRADIENT_OPERATORS: readonly GradientOperator[] = [
  "gradient",
  "divergence",
  "curl",
];
export const GRADIENT_METHODS: readonly GradientMethod[] = [
  "green-gauss",
  "least-squares",
];

export interface GradientParams {
  /** The NODAL field to differentiate. */
  variable: string;
  /** Default `gradient`. `divergence`/`curl` need a 2- or 3-component field. */
  operator?: GradientOperator;
  /**
   * `green-gauss` (default) applies the divergence theorem over the cell's own
   * faces and is exact for a linear field on any cell. `least-squares` fits
   * over the node-sharing neighbours and is smoother on an irregular mesh.
   */
  method?: GradientMethod;
  /** Name for the new field. Defaults to `<variable>_<OPERATOR>`. */
  output?: string;
}

export interface GradientResult {
  model: MdpaModel;
  /** The field that was created, or "" when the op was a noop. */
  output: string;
  /** Components of the new field: 3/9 for gradient, 1 for divergence, 3 for curl. */
  components: number;
  /** Nodes whose value could not be computed and came back NaN. */
  numSkipped: number;
  /** Least-squares neighbourhoods that fell back to Green-Gauss. */
  numFallback: number;
}

/** The name meshio++ gives the result when we do not override it. */
function defaultOutputName(variable: string, operator: GradientOperator): string {
  return `${variable}_${operator.toUpperCase()}`;
}

export async function gradientFieldModel(
  model: MdpaModel,
  params: GradientParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<GradientResult> {
  const operator = params.operator ?? "gradient";
  const method = params.method ?? "green-gauss";
  const noop: GradientResult = {
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
  if (operator !== "gradient" && source.components !== 2 && source.components !== 3) {
    throw new Error(
      `${operator} needs a 2- or 3-component field; "${params.variable}" has ` +
        `${source.components}.`
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
  const outName = "__grad__"; // never collides; renamed on the way back

  const m = await loadMeshio();
  const r = m.gradient(mesh, inName, operator, method, "point", outName, -1, true);

  const arr = r.mesh.point_data?.[outName];
  if (!arr) {
    throw new Error(
      `${operator} produced no "${outName}" array; the result was discarded.`
    );
  }
  const components = r.mesh.point_data_components?.[outName] ?? 1;
  if (components < 1 || arr.length !== components * model.nodeCount) {
    // The whole design rests on one tuple per node, in order. Refuse rather
    // than scatter values onto the wrong nodes.
    throw new Error(
      `${operator} returned ${arr.length} values (${components} components) for ` +
        `${model.nodeCount} nodes; node order cannot be trusted, so the result ` +
        `was discarded.`
    );
  }

  const variable = sanitizeVariable(
    params.output?.trim() || defaultOutputName(params.variable, operator)
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
