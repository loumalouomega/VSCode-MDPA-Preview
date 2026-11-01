/**
 * ALE mesh quality over time (roadmap item 46).
 *
 * After an FSI / CoSimulation run the question is whether the mesh solver kept
 * the fluid mesh valid. For every frame, each Element of the mesh's top
 * dimension is measured on its deformed coordinates (`coords + displacement`)
 * and compared with the SAME element at the first usable frame, so an
 * intentionally graded mesh is not flagged:
 *
 *  - `measureRatio`: signed measure (tet-decomposed volume, or signed xy area
 *    for a planar triangle/quad mesh) divided by the reference measure; <= 0
 *    means the element is flat or inverted.
 *  - `shapeRatio`: the element's shape quality (mean ratio of its worst
 *    sub-simplex, signed so an inversion is negative) divided by the reference
 *    quality. 1 = as good as at the reference frame.
 *
 * Read-only; one model at a time like `flowBalanceSeries`. A frame whose node
 * or element count differs from the reference is recorded as an error, never
 * compared by index.
 */
import type { MdpaModel } from "./types";
import type { SeriesStep } from "./fieldSeries";
import { decompositionFor } from "./cellDecomposition";
import { cellCategory } from "./writers/writerCommon";

export const ALE_DEFAULT_VARIABLE = "MESH_DISPLACEMENT";
const ID_LIMIT = 50;

export interface AleFrame {
  label: string;
  frameIndex: number;
  /** Elements compared with the reference. */
  elements?: number;
  /** Elements whose signed measure has the opposite sign to the reference (or is zero). */
  inverted?: number;
  invertedIds?: number[];
  minMeasureRatio?: number;
  minShapeRatio?: number;
  /** Element holding `minShapeRatio`. */
  worstElementId?: number;
  error?: string;
}

export interface AleSeries {
  variable: string;
  frames: AleFrame[];
  /** Frame (row index) with the lowest `minShapeRatio`; undefined when no frame was measured. */
  worstFrame?: number;
  referenceLabel?: string;
  cancelled: boolean;
}

interface Measured {
  ids: Int32Array;
  measure: Float64Array;
  quality: Float64Array;
}

const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len2 = (a: number[]): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];

/** Signed tetrahedron volume and its signed mean-ratio quality. */
function tetQuality(p0: number[], p1: number[], p2: number[], p3: number[]): [number, number] {
  const u = sub(p1, p0), v = sub(p2, p0), w = sub(p3, p0);
  const vol = (u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
  const e = len2(u) + len2(v) + len2(w) + len2(sub(p2, p1)) + len2(sub(p3, p1)) + len2(sub(p3, p2));
  if (!(e > 0)) return [vol, 0];
  const q = (12 * Math.cbrt(9 * vol * vol)) / e;
  return [vol, vol < 0 ? -q : q];
}

/** Signed xy area and its signed quality (4 sqrt(3) A / sum of squared edges). */
function triQuality(p0: number[], p1: number[], p2: number[]): [number, number] {
  const area = 0.5 * ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]));
  const e = len2(sub(p1, p0)) + len2(sub(p2, p1)) + len2(sub(p0, p2));
  return [area, e > 0 ? (4 * Math.sqrt(3) * area) / e : 0];
}

function measureModel(model: MdpaModel, variable: string): Measured {
  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === variable);
  if (!field || field.components < 2) throw new Error(`No nodal vector field "${variable}" in this frame.`);
  const row = new Map<number, number>();
  for (let i = 0; i < field.ids.length; i++) row.set(field.ids[i], i);
  const pos = new Map<number, number[]>();
  for (let i = 0; i < model.nodeCount; i++) {
    const r = row.get(model.nodeIds[i]);
    const d = (k: number): number => (r === undefined || k >= field.components ? 0 : field.values[r * field.components + k]);
    pos.set(model.nodeIds[i], [model.coords[i * 3] + d(0), model.coords[i * 3 + 1] + d(1), model.coords[i * 3 + 2] + d(2)]);
  }
  let volume = false;
  for (const b of model.blocks) if (b.kind === "Elements" && cellCategory(b.vtkCellType) === "volume") volume = true;
  const ids: number[] = [], measure: number[] = [], quality: number[] = [];
  for (const b of model.blocks) {
    if (b.kind !== "Elements") continue;
    const cat = cellCategory(b.vtkCellType);
    if (volume ? cat !== "volume" : cat !== "surface") continue;
    const dec = decompositionFor(b.vtkCellType);
    const pieces = volume ? dec.tets : dec.tris;
    if (!pieces) continue;
    for (let c = 0; c < b.count; c++) {
      const nodes: number[][] = [];
      let ok = true;
      for (let k = 0; k < dec.corners && ok; k++) {
        const p = pos.get(b.connectivity[c * b.stride + k]);
        if (!p) ok = false;
        else nodes.push(p);
      }
      if (!ok) continue;
      let m = 0, q = Infinity;
      for (const t of pieces) {
        const [mm, qq] = volume ? tetQuality(nodes[t[0]], nodes[t[1]], nodes[t[2]], nodes[t[3]]) : triQuality(nodes[t[0]], nodes[t[1]], nodes[t[2]]);
        m += mm;
        if (qq < q) q = qq;
      }
      ids.push(b.entityIds[c]);
      measure.push(m);
      quality.push(q);
    }
  }
  if (ids.length === 0) throw new Error("The frame has no volume or planar surface Elements to measure.");
  return { ids: Int32Array.from(ids), measure: Float64Array.from(measure), quality: Float64Array.from(quality) };
}

/** One frame against the reference. Pure; exported for tests. */
export function compareToReference(ref: Measured, cur: Measured, label: string, frameIndex: number): AleFrame {
  if (ref.ids.length !== cur.ids.length || ref.ids.some((id, i) => id !== cur.ids[i])) {
    return { label, frameIndex, error: "The element set differs from the reference frame (topology changed), so frames are not compared by position." };
  }
  let inverted = 0, minM = Infinity, minQ = Infinity, worst: number | undefined;
  const invertedIds: number[] = [];
  let compared = 0;
  for (let i = 0; i < ref.ids.length; i++) {
    // An element already flat or inverted at the reference has nothing to be compared with.
    if (!(ref.measure[i] !== 0) || !(ref.quality[i] > 0)) continue;
    compared++;
    const mr = cur.measure[i] / ref.measure[i];
    const qr = cur.quality[i] * Math.sign(ref.measure[i]) / ref.quality[i];
    if (!(mr > 0)) {
      inverted++;
      if (invertedIds.length < ID_LIMIT) invertedIds.push(ref.ids[i]);
    }
    if (mr < minM) minM = mr;
    if (qr < minQ) {
      minQ = qr;
      worst = ref.ids[i];
    }
  }
  return { label, frameIndex, elements: compared, inverted, invertedIds, minMeasureRatio: minM, minShapeRatio: minQ, worstElementId: worst };
}

export async function aleQualitySeries(
  steps: SeriesStep[],
  opts: { variable?: string; signal?: AbortSignal; onProgress?(done: number, total: number, label: string): void } = {}
): Promise<AleSeries> {
  const variable = opts.variable ?? ALE_DEFAULT_VARIABLE;
  const frames: AleFrame[] = [];
  let reference: Measured | undefined;
  let referenceLabel: string | undefined;
  let cancelled = false;
  for (let i = 0; i < steps.length; i++) {
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    const step = steps[i];
    opts.onProgress?.(i, steps.length, step.label);
    try {
      const measured = measureModel(await step.load(opts.signal), variable);
      if (!reference) {
        reference = measured;
        referenceLabel = step.label;
      }
      frames.push(compareToReference(reference, measured, step.label, step.frameIndex));
    } catch (err) {
      if (opts.signal?.aborted && err instanceof Error && err.message === "cancelled") {
        cancelled = true;
        break;
      }
      frames.push({ label: step.label, frameIndex: step.frameIndex, error: err instanceof Error ? err.message : String(err) });
    }
  }
  opts.onProgress?.(frames.length, steps.length, "");
  let worstFrame: number | undefined;
  frames.forEach((f, i) => {
    if (f.minShapeRatio !== undefined && (worstFrame === undefined || f.minShapeRatio < frames[worstFrame].minShapeRatio!)) worstFrame = i;
  });
  return { variable, frames, ...(worstFrame !== undefined ? { worstFrame } : {}), ...(referenceLabel ? { referenceLabel } : {}), cancelled };
}
