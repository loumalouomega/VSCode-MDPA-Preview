/**
 * Shared field provenance for the sidebar: which in-session operation (if
 * any) produced the fields a `model` / `vtkFrame` message is about to carry.
 *
 * The host never reports "this op produced field X" — only whole models — so
 * the webview attributes new fields itself: every field-producing fire
 * records its origin label (and the output keys it can already name) via
 * `noteFieldFire`, and the Variables panel consumes it on the next model
 * message to label the auto-created rows ("Field calculator", "Remesh
 * (MMG)", …). Anything unattributed (file load, timeline step, MCP-made
 * field) lands under the "mesh" origin instead.
 *
 * One pending slot, not a queue: the host runs a single op at a time
 * (opApply.ts's opInFlight guard), so overlapping fires cannot interleave —
 * and queue mode stages without running, noting only when the batch actually
 * posts. A second fire before the first one's model arrives overwrites the
 * slot (last-writer-wins); the key diff still catches every new field, only
 * the label may name the later op.
 */

import type { ToolbarIconId } from "../src/toolbarIcons";

export type FieldMethod =
  | "formula"
  | "distanceFile"
  | "distancePart"
  | "distanceSkin"
  | "average"
  | "gradient"
  | "hessian"
  | "error"
  | "transfer"
  | "global";

/**
 * The method dropdown's icon, per method — the same glyph as the Field form
 * that computes it. A native `<select>` cannot render icons inside its
 * options, so the row shows this beside the dropdown instead (same
 * `.toolbar-icon` treatment as the form titles). Gradient reuses `fieldCalc`
 * exactly as its form does (it has no dedicated glyph); globals reuse
 * `average` (a reduction is an aggregation, like averaging).
 */
export const METHOD_ICONS: Record<FieldMethod, ToolbarIconId> = {
  formula: "fieldCalc",
  distanceFile: "sdf",
  distancePart: "sdf",
  distanceSkin: "sdf",
  average: "average",
  gradient: "fieldCalc",
  hessian: "fieldHessian",
  error: "estimateError",
  transfer: "transferField",
  global: "average",
};

/** A re-runnable definition, snapshotted from the firing form's inputs. */
export interface FieldDefinition {
  method: FieldMethod;
  /** Formula rows: Nodal (default) / Elemental / Conditional. */
  location?: string;
  /** Formula rows: the expression as typed. */
  expr?: string;
  /** Distance rows: sign mode (default pseudonormal)… */
  sign?: string;
  /** …and band (raw input, "" = unset). */
  band?: string;
  /** Distance-to-file rows: the picked surface path. */
  path?: string;
  /** Distance-to-part rows: the SubModelPart path. */
  part?: string;
  /** Average rows: the source variable. */
  variable?: string;
  /** Average rows: nodalToElemental / elementalToNodal. */
  direction?: string;
  /** Average rows: Elements / Conditions target. */
  target?: string;
  /** Gradient rows: gradient / divergence / curl. */
  operator?: string;
  /** Gradient/Hessian rows: green-gauss / least-squares. */
  opMethod?: string;
  /** Gradient/Hessian/Error rows: explicit output (blank = host default). */
  output?: string;
  /** Error rows: none / absolute / fraction / dorfler. */
  marking?: string;
  /** Error rows: marking value (raw input). */
  markingValue?: string;
  /** Transfer rows: comma-separated array list (blank = all). */
  arrays?: string;
  /** Transfer rows: overwrite / suffix / error. */
  onConflict?: string;
  /** Global rows: source field kind. */
  kind?: string;
  /** Global rows: min / max / mean / std / median / sum / count / q1 / q3 / iqr. */
  reduction?: string;
}

export interface PendingFieldFire {
  /** Human origin label for auto-created rows, e.g. "Field calculator". */
  origin: string;
  /** Output keys (`kind:variable`) known up front; empty when unknowable. */
  expectedKeys: string[];
  /** Present when the firing form's inputs fully define the computation. */
  definition?: FieldDefinition;
}

let pending: PendingFieldFire | undefined;

/**
 * Records that an `applyOp`/`applyBatch` carrying new fields was just posted.
 * Call on actual post only, never when staging into the operation queue.
 */
export function noteFieldFire(fire: PendingFieldFire): void {
  pending = fire;
}

/** One-shot: the pending fire, or undefined when the model came from elsewhere. */
export function drainPendingFieldFire(): PendingFieldFire | undefined {
  const fire = pending;
  pending = undefined;
  return fire;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Derives provenance from an already-built `applyOp` message — the single
 * choke point every sidebar fire goes through, so the Variables panel and
 * the Field forms cannot disagree about what an op produces. Does nothing
 * for ops that produce no new fields (transforms, history, remesh-mapping
 * passthrough…), leaving any earlier pending fire in place.
 *
 * `originOverride` lets the Variables panel name its own methods ("Formula",
 * …) instead of the op's form label: the message shape is identical, only
 * the speaker differs.
 */
export function noteFieldFireFromMessage(
  msg: Record<string, unknown>,
  originOverride?: string
): void {
  const op = msg.op;
  switch (op) {
    case "fieldCalc": {
      const output = str(msg.output);
      const location = str(msg.location) || "Nodal";
      if (!output) return;
      noteFieldFire({
        origin: originOverride ?? "Field calculator",
        expectedKeys: [`${location}:${output}`],
        definition: {
          method: "formula",
          location,
          expr: str(msg.expr),
        },
      });
      return;
    }
    case "sdfDistance": {
      // The host defaults an empty output to SDF_DISTANCE (sdfField.ts's
      // SDF_VARIABLE) — mirror that here so the expected key matches.
      const output = str(msg.output) || "SDF_DISTANCE";
      const path = str(msg.path);
      const part = str(msg.part);
      const skin = msg.skin === true;
      if (!path && !part && !skin) return;
      const sign = str(msg.sign) || undefined;
      const band = msg.band !== undefined && msg.band !== "" ? String(msg.band) : undefined;
      noteFieldFire({
        origin: originOverride ?? "Signed distance",
        expectedKeys: [`Nodal:${output}`],
        definition: path
          ? { method: "distanceFile", path, sign, band }
          : skin
            ? { method: "distanceSkin", sign, band }
            : { method: "distancePart", part, sign, band },
      });
      return;
    }
    case "averageField": {
      // No output input on the form: the host names it after the variable
      // (fieldCalc.ts), on Elements→Elemental / Conditions→Conditional.
      const variable = str(msg.variable);
      if (!variable) return;
      const kind = str(msg.target) === "Conditions" ? "Conditional" : "Elemental";
      noteFieldFire({
        origin: originOverride ?? "Average field",
        expectedKeys: [`${kind}:${variable}`],
        definition: {
          method: "average",
          variable,
          direction: str(msg.direction) || "nodalToElemental",
          target: str(msg.target) || "Elements",
        },
      });
      return;
    }
    case "fieldGradient": {
      // Nodal output; blank defaults to `<VARIABLE>_<OPERATOR>` (the host's
      // defaultOutputName in gradientField.ts), replicated here so the row
      // tracks the exact key. Operator defaults to gradient, like the form.
      const variable = str(msg.variable);
      if (!variable) return;
      const operator = str(msg.operator) || "gradient";
      const output = str(msg.output) || `${variable}_${operator.toUpperCase()}`;
      noteFieldFire({
        origin: originOverride ?? "Field gradient",
        expectedKeys: [`Nodal:${output}`],
        definition: {
          method: "gradient",
          variable,
          operator,
          opMethod: str(msg.method) || "green-gauss",
          output: str(msg.output),
        },
      });
      return;
    }
    case "fieldHessian": {
      // Nodal output; blank defaults to `<variable>_HESSIAN` (hessianField.ts).
      const variable = str(msg.variable);
      if (!variable) return;
      const output = str(msg.output) || `${variable}_HESSIAN`;
      noteFieldFire({
        origin: originOverride ?? "Field Hessian",
        expectedKeys: [`Nodal:${output}`],
        definition: {
          method: "hessian",
          variable,
          opMethod: str(msg.method) || "green-gauss",
          output: str(msg.output),
        },
      });
      return;
    }
    case "estimateError": {
      // Elemental indicator (blank → ERROR_INDICATOR) plus, unless marking is
      // "none", a second ERROR_MARKED flag field (errorEstimate.ts).
      const output = str(msg.output) || "ERROR_INDICATOR";
      const keys = [`Elemental:${output}`];
      const marking = str(msg.marking) || "none";
      if (marking !== "none") keys.push("Elemental:ERROR_MARKED");
      noteFieldFire({
        origin: originOverride ?? "Error estimate",
        expectedKeys: keys,
        definition: {
          method: "error",
          variable: str(msg.variable),
          marking,
          markingValue:
            msg.markingValue !== undefined && msg.markingValue !== "" ? String(msg.markingValue) : "",
          output: str(msg.output),
        },
      });
      return;
    }
    case "transferField": {
      // Explicit array lists name the variables but not their kinds; an empty
      // list transfers everything — unknowable here either way. The key diff
      // attributes whatever arrives. The definition IS the row for the new
      // transfer method (source + arrays + conflict re-runs the same op).
      noteFieldFire({
        origin: originOverride ?? "Transfer fields",
        expectedKeys: [],
        definition: {
          method: "transfer",
          path: str(msg.path),
          arrays: str(msg.arrays),
          onConflict: str(msg.onConflict) || "overwrite",
        },
      });
      return;
    }
    case "reduceField": {
      // Global (scalar) variable: blank output defaults to
      // `{reduction}_{variable}` (operations.ts), kind to Nodal. Tracked
      // under the `global:` namespace, never a field key.
      const variable = str(msg.variable);
      const reduction = str(msg.reduction);
      if (!variable || !reduction) return;
      const output = str(msg.output) || `${reduction}_${variable}`;
      noteFieldFire({
        origin: originOverride ?? "Global reduction",
        expectedKeys: [`global:${output}`],
        definition: {
          method: "global",
          variable,
          kind: str(msg.kind) || "Nodal",
          reduction,
          output: str(msg.output),
        },
      });
      return;
    }
    case "partition": {
      noteFieldFire({ origin: originOverride ?? "Partition", expectedKeys: ["Elemental:PARTITION_INDEX"] });
      return;
    }
    case "setElementRadius": {
      // Creates a radius field whose kind (Elemental vs Conditional) depends
      // on the mesh — the diff attributes it.
      noteFieldFire({ origin: originOverride ?? "Set element radius", expectedKeys: [] });
      return;
    }
    case "mergeMesh": {
      // Merging concatenates the sources' fields, so new names can appear
      // without any field op running — label them truthfully, no definition.
      noteFieldFire({ origin: originOverride ?? "Merge meshes", expectedKeys: [] });
      return;
    }
    default:
      return;
  }
}

/** Field kinds addressable as Variables rows / Field panel keys. */
export type FieldKind = "Nodal" | "Elemental" | "Conditional";

/** `kind:variable` inventory key shared by both panels (fieldData.ts's shape). */
export function fieldInventoryKey(kind: string, variable: string): string {
  return `${kind}:${variable}`;
}
