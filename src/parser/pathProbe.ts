/**
 * Probing a NODAL field along a polyline: distance-versus-value, for the
 * quantitative question "what does this field do along this line" that Clip and
 * the Field panel answer only visually.
 *
 * Pure module (no vscode / DOM; the sampling itself is meshio++'s barycentric
 * `interpolate`, shared with the spatial mesh comparison through
 * `sampleNodalFieldAt`). A sample is COVERED when it lies inside the mesh and
 * every node of the cell it fell in carries a value; everything else is a gap
 * (`null`), never 0 — a line that leaves the domain, or crosses a region where
 * the field was never written, must show as a break rather than a fabricated
 * flat stretch.
 */

import { FieldData, MdpaModel } from "./types";
import { sampleNodalFieldAt } from "./meshCompare";
import { componentColumnNames } from "./dataTable";

export type Vec3 = [number, number, number];

export const PROBE_MAX_SAMPLES = 100_000;

export interface ProbeParams {
  /** The polyline's vertices (at least two, not all equal). */
  points: Vec3[];
  /** Equidistant samples along it, both ends included (2 … 100 000, default 101). */
  samples?: number;
  variable: string;
}

export interface ProbeRow {
  /** Arclength from the first vertex. */
  distance: number;
  position: Vec3;
  /** One entry per component; `null` = uncovered (a gap). */
  values: (number | null)[];
}

export interface ProbeResult {
  variable: string;
  components: number;
  /** Column names, exactly the Data table's (`T`, `VEL_X`, `H_0` …). */
  columns: string[];
  /** Total length of the polyline. */
  length: number;
  rows: ProbeRow[];
  covered: number;
  uncovered: number;
}

/** Equidistant points along a polyline, with their arclength; both ends included. */
export function samplePolyline(points: Vec3[], samples: number): { positions: Float64Array; distances: number[]; length: number } {
  if (points.length < 2) throw new Error("A path needs at least two points.");
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v))) throw new Error("Every path point must be three finite numbers.");
  }
  if (!Number.isInteger(samples) || samples < 2 || samples > PROBE_MAX_SAMPLES) {
    throw new Error(`samples must be an integer from 2 to ${PROBE_MAX_SAMPLES}.`);
  }
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]));
  }
  const length = cum[cum.length - 1];
  if (!(length > 0)) throw new Error("The path has zero length.");
  const positions = new Float64Array(samples * 3);
  const distances: number[] = [];
  let seg = 0;
  for (let i = 0; i < samples; i++) {
    const s = (i / (samples - 1)) * length;
    while (seg < points.length - 2 && s > cum[seg + 1]) seg++;
    const span = cum[seg + 1] - cum[seg];
    const u = span > 0 ? (s - cum[seg]) / span : 0;
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = points[seg][k] + u * (points[seg + 1][k] - points[seg][k]);
    distances.push(s);
  }
  return { positions, distances, length };
}

export async function probeAlongPath(model: MdpaModel, params: ProbeParams): Promise<ProbeResult> {
  const field: FieldData | undefined = model.fields.find((f) => f.kind === "Nodal" && f.variable === params.variable);
  if (!field) {
    const elsewhere = model.fields.find((f) => f.variable === params.variable);
    throw new Error(
      elsewhere
        ? `"${params.variable}" is a ${elsewhere.kind} field; a probe samples a NODAL field — move it to the nodes with Average field first.`
        : `No nodal field named "${params.variable}".`
    );
  }
  const { positions, distances, length } = samplePolyline(params.points, params.samples ?? 101);
  const { values, covered } = await sampleNodalFieldAt(model, field, positions);
  const c = Math.max(1, field.components);
  const rows: ProbeRow[] = [];
  let ok = 0;
  for (let i = 0; i < distances.length; i++) {
    const v: (number | null)[] = [];
    for (let k = 0; k < c; k++) v.push(covered[i] ? values[i * c + k] : null);
    if (covered[i]) ok++;
    rows.push({ distance: distances[i], position: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]], values: v });
  }
  return {
    variable: field.variable,
    components: field.components,
    columns: componentColumnNames(field.variable, field.components),
    length,
    rows,
    covered: ok,
    uncovered: rows.length - ok,
  };
}

/** The probe as CSV: distance, x, y, z, then one column per component; a gap is an empty cell. */
export function probeToCsv(r: ProbeResult): string {
  const lines = [["distance", "x", "y", "z", ...r.columns].join(",")];
  for (const row of r.rows) {
    lines.push([row.distance, ...row.position, ...row.values.map((v) => (v === null ? "" : v))].join(","));
  }
  return lines.join("\n") + "\n";
}
