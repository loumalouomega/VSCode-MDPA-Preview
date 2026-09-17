/**
 * A posteriori error estimation — the Zienkiewicz-Zhu recovery-based indicator
 * of a nodal field, attached as a per-cell field. Backed by meshio++'s
 * `estimateError` (>= 10.10.0), used strictly as an oracle.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable. The input is
 * never mutated; a fresh MdpaModel is returned.
 *
 * ## Why this is an oracle, like partitionMesh.ts
 *
 * The indicator is one Float64 per cell, in the same block-major order
 * `partitionLabels` uses — a shape that survives the meshio boundary intact
 * without needing carriers. So the mesh meshio++ returns is never adopted: we
 * take the arrays off it and lay them back onto our own blocks, and every
 * SubModelPart, entity id, property id and block kind is preserved by
 * construction rather than repair.
 *
 * ## What the numbers mean
 *
 * `sqrt(|measure| * sum((recovered - raw)^2))` per cell, where "recovered" is
 * the smoothed gradient and "raw" the piecewise one. The estimator's defining
 * property is that a field the mesh can represent EXACTLY has zero error — a
 * linear field on any mesh — so a near-zero indicator everywhere means "this
 * mesh already resolves this solution", not "the estimate failed".
 *
 * ## Marking, and why it becomes a second field
 *
 * `marking` other than `"none"` also attaches a 0/1 array naming the cells
 * worth refining. It is emitted as its own Elemental field rather than folded
 * into the indicator, because that makes it usable immediately: the Field
 * panel's `threshold` mode can isolate the marked cells, and the value rides a
 * `.mdpa` export like any other Elemental data.
 *
 * ## The caveat worth surfacing to a user
 *
 * A cell the estimator cannot evaluate reads **NaN** in the indicator and 0
 * (never NaN) in the marking array, and is counted in `numSkipped`. A partly
 * NaN field looks perfectly clean in the field picker, so the count is reported
 * rather than hidden — the same rule gradientField.ts follows.
 */

import { MdpaModel, MdpaDiagnostic } from "./types";
import { sanitizeVariable } from "./meshioConvert";
import {
  prepareMeshioOp,
  meshioCorrespondence,
  flattenMeshioData,
  entityIdsInBlockOrder,
  requireNodalSource,
  attachCellField,
} from "./meshioAdapter";

/** Only `zz` is offered; it is the only estimator upstream implements. */
export type ErrorEstimateMethod = "zz";

/** How to turn the indicator into a 0/1 "refine me" flag. */
export type ErrorMarking = "none" | "absolute" | "fraction" | "dorfler";

export const ERROR_MARKINGS: readonly ErrorMarking[] = [
  "none",
  "absolute",
  "fraction",
  "dorfler",
];

export const ERROR_VARIABLE = "ERROR_INDICATOR";
export const ERROR_MARKED_VARIABLE = "ERROR_MARKED";

export interface ErrorEstimateParams {
  /** The NODAL field whose approximation error is estimated. */
  variable: string;
  method?: ErrorEstimateMethod;
  /**
   * `absolute` thresholds the indicator directly, `fraction` marks that
   * fraction of cells (worst first), `dorfler` marks the smallest set holding
   * that fraction of total error. Default `none` — indicator only.
   */
  marking?: ErrorMarking;
  /** Meaning depends on `marking`: a threshold, or a fraction in (0, 1]. */
  markingValue?: number;
  /** Name for the indicator field. Defaults to `ERROR_INDICATOR`. */
  output?: string;
}

export interface ErrorEstimateResult {
  model: MdpaModel;
  /** The indicator field created, or "" when the op was a noop. */
  output: string;
  /** The marking field created, or "" when `marking` was "none". */
  marked: string;
  /** The global error norm over the whole mesh. */
  globalError: number;
  /** Cells that could not be evaluated and read NaN. */
  numSkipped: number;
  /** Cells the marking policy selected. */
  numMarked: number;
}

export async function estimateErrorModel(
  model: MdpaModel,
  params: ErrorEstimateParams,
  diagnostics: MdpaDiagnostic[] = []
): Promise<ErrorEstimateResult> {
  const noop: ErrorEstimateResult = {
    model,
    output: "",
    marked: "",
    globalError: 0,
    numSkipped: 0,
    numMarked: 0,
  };
  const marking = params.marking ?? "none";

  requireNodalSource(model, params.variable, "estimate");
  if (marking === "fraction" || marking === "dorfler") {
    const v = params.markingValue;
    if (!(typeof v === "number" && v > 0 && v <= 1)) {
      throw new Error(
        `"${marking}" marking needs a fraction in (0, 1]; got ${String(v)}.`
      );
    }
  }

  const prepared = await prepareMeshioOp(model, diagnostics, { dim: 3 });
  if (!prepared) return noop;
  const { m, mesh } = prepared;

  const inName = sanitizeVariable(params.variable);
  if (!mesh.point_data?.[inName]) return noop;
  // Fixed internal names, renamed on the way back — upstream's own defaults
  // carry a colon ("error:zz"), which mdpaWriter.ts would emit verbatim into a
  // variable name Kratos cannot read.
  const outName = "__err__";
  const markedName = "__errmark__";

  const r = m.estimateError(
    mesh,
    inName,
    params.method ?? "zz",
    marking,
    params.markingValue ?? 0,
    outName,
    markedName,
    true
  );

  // The walk and modelToMeshio must agree 1:1. They did not when two
  // same-named blocks fused, and a plain length check on the flattened result
  // cannot see that: fusion moves cells between blocks without losing any.
  const { blocks, cellCount: total } = meshioCorrespondence(model, mesh, "estimateError");

  const indicator = flattenMeshioData(r.mesh.cell_data?.[outName]);
  if (indicator.length !== total) {
    // One value per cell, in order, is the entire basis for laying these back
    // onto our own blocks. Refuse rather than mislabel cells.
    throw new Error(
      `estimateError returned ${indicator.length} values for ${total} cells; ` +
        `cell order cannot be trusted, so the result was discarded.`
    );
  }
  const markedValues = marking === "none" ? [] : flattenMeshioData(r.mesh.cell_data?.[markedName]);
  const haveMarks = markedValues.length === total;

  const entityIds = entityIdsInBlockOrder(blocks, total);

  const variable = sanitizeVariable(params.output?.trim() || ERROR_VARIABLE);
  const { model: withIndicator } = attachCellField(model, {
    kind: "Elemental",
    variable,
    components: 1,
    ids: entityIds,
    values: indicator,
    alsoReplace: [ERROR_MARKED_VARIABLE],
  });
  let finalModel = withIndicator;
  if (haveMarks) {
    ({ model: finalModel } = attachCellField(withIndicator, {
      kind: "Elemental",
      variable: ERROR_MARKED_VARIABLE,
      components: 1,
      ids: entityIds,
      values: markedValues,
    }));
  }

  return {
    model: finalModel,
    output: variable,
    marked: haveMarks ? ERROR_MARKED_VARIABLE : "",
    globalError: r.globalError,
    numSkipped: r.numSkipped,
    numMarked: r.numMarked,
  };
}
