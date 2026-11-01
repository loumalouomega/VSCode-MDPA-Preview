/**
 * Total force on a surface or line (roadmap item 42).
 *
 * A structural surface load is entered in N/m² and a line load in N/m, so a
 * user who knows the TOTAL force had to measure the area first. A load
 * assignment whose `loadMode` field is `"total"` stores the total in its
 * `modulus` field; at generation the modulus written to the process is
 * `total / measure`, with the measure of the assigned SubModelPart's cells
 * taken from the mesh (`partMeasures.ts`). The case file keeps the TOTAL, so a
 * re-mesh recomputes the distributed value; the preparation report records the
 * measure used. The measure is the undeformed one (no follower loads).
 *
 * Pure module (no vscode/DOM/fs).
 */
import type { Measure } from "../parser/partMeasures";
import type { Assignment, JsonObject, JsonValue } from "./types";

/** What was divided by what — recorded in the preparation report. */
export interface LoadMeasure {
  conditionId: string;
  smpPath: string;
  /** The total force entered (N, in the case's unit system). */
  total: number;
  /** The part's undeformed length (1) or area (2). */
  measure: number;
  dimension: 1 | 2;
  /** The distributed value written to the process. */
  modulus: number;
}

/** Condition ids that take a `loadMode` and the measure dimension they need (absent = length or area). */
const EXPECTED_DIMENSION: Record<string, 1 | 2> = { lineLoad: 1, surfaceLoad: 2 };

/** True when this assignment asks for a total force. */
export function isTotalLoad(a: Assignment): boolean {
  return a.values.loadMode === "total";
}

/**
 * Returns `process` with `Parameters.modulus` divided by the part's measure, plus
 * the record of what was done. Throws (the generator refuses) when the part has
 * no measurable cells of the right dimension.
 */
export function applyTotalLoad(
  process: JsonObject,
  a: Assignment,
  measures: Record<string, Measure | null> | undefined
): { process: JsonObject; record: LoadMeasure } {
  const where = `Total force on "${a.smpPath}"`;
  const measure = measures?.[a.smpPath];
  if (!measure || !(measure.value > 0) || !Number.isFinite(measure.value)) {
    throw new Error(`${where}: the part has no measurable length or area (zero or missing), so the force cannot be distributed.`);
  }
  if (measure.dimension === 3) {
    throw new Error(`${where}: the part measures a volume; assign the load to a surface or line part.`);
  }
  const expected = EXPECTED_DIMENSION[a.conditionId];
  if (expected !== undefined && measure.dimension !== expected) {
    throw new Error(
      `${where}: a ${expected === 1 ? "line" : "surface"} load needs a part of ${expected === 1 ? "line" : "surface"} cells, but this part measures a ${measure.dimension === 1 ? "length" : "area"}.`
    );
  }
  const total = Number(a.values.modulus);
  if (!Number.isFinite(total)) throw new Error(`${where}: the total force is not a number.`);
  const params = (process as { Parameters?: JsonObject }).Parameters;
  if (!params || typeof params !== "object") {
    throw new Error(`${where}: the condition's process has no Parameters to carry the distributed value.`);
  }
  const modulus = total / measure.value;
  const next: JsonObject = { ...process, Parameters: { ...params, modulus: modulus as JsonValue } };
  return {
    process: next,
    record: {
      conditionId: a.conditionId,
      smpPath: a.smpPath,
      total,
      measure: measure.value,
      dimension: measure.dimension,
      modulus,
    },
  };
}
