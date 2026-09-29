// Pure (no vscode/DOM) transient time-step and output-budget guidance.
//
// The estimate is a convective (Courant) time scale, dt = safety * Co * h / |U|,
// shown as GUIDANCE: it is not a stability guarantee for implicit, diffusive or
// structural solvers, and user-entered values always stay authoritative.
import { MdpaModel } from "../parser/types";
import { computeMeshSize } from "../parser/meshSize";

export type LengthBasis = "mean-edge" | "shortest-edge";

export interface TimeStepInput {
  /** Reference velocity magnitude in mesh length units per second. */
  refVelocity: number;
  /** Target Courant number (default 1). */
  courant?: number;
  /** Multiplies the result; < 1 is more conservative (default 0.9). */
  safety?: number;
  /** Simulation end time; enables step/frame counts. */
  endTime?: number;
  /** Simulated time between output frames; enables frame count and storage. */
  outputInterval?: number;
}

export interface StorageRange {
  minBytes: number;
  maxBytes: number;
  /** How the range was derived; always an approximation. */
  note: string;
}

export type TimeStepEstimate =
  | { available: false; reason: string }
  | {
      available: true;
      dt: number;
      courant: number;
      safety: number;
      refVelocity: number;
      /** Characteristic length used and which definition it is. */
      length: number;
      basis: LengthBasis;
      /** Set when the mesh is thin/anisotropic enough to change the basis. */
      limitation?: string;
      /** Time for the reference velocity to cross the bounding-box diagonal. */
      flowThroughTime: number;
      steps?: number;
      frames?: number;
      storage?: StorageRange;
    };

/** A smallest element whose mean edge exceeds its shortest edge by this factor is thin. */
export const THIN_CELL_RATIO = 2;

function diagonal(model: MdpaModel): number {
  const b = model.bounds as { min: number[]; max: number[] } | undefined;
  if (!b) return NaN;
  let s = 0;
  for (let i = 0; i < 3; i++) s += (b.max[i] - b.min[i]) ** 2;
  return Math.sqrt(s);
}

/** Rough per-frame byte range: binary lower bound to ASCII upper bound. */
export function frameBytesRange(model: MdpaModel): StorageRange {
  let conn = 0;
  let cells = 0;
  for (const b of model.blocks) {
    conn += b.count * b.stride;
    cells += b.count;
  }
  const binary = model.nodeCount * 12 + conn * 4 + cells * 5;
  return {
    minBytes: binary,
    maxBytes: binary * 8,
    note: "geometry only, binary lower bound to ASCII upper bound; field arrays add to it",
  };
}

export function estimateTimeStep(model: MdpaModel, input: TimeStepInput): TimeStepEstimate {
  const u = Math.abs(input.refVelocity);
  if (!Number.isFinite(u) || u === 0) {
    return { available: false, reason: "Reference velocity is zero or not set." };
  }
  const courant = input.courant ?? 1;
  const safety = input.safety ?? 0.9;
  if (!(courant > 0) || !(safety > 0)) {
    return { available: false, reason: "Courant number and safety factor must be positive." };
  }
  const size = computeMeshSize(model);
  const meanEdge = size.elementStats.min;
  const shortest = size.nodalStats.min;
  if (size.analyzedCount === 0 || !Number.isFinite(meanEdge) || !(meanEdge > 0)) {
    return { available: false, reason: "The mesh has no measurable elements." };
  }
  let basis: LengthBasis = "mean-edge";
  let length = meanEdge;
  let limitation: string | undefined;
  if (Number.isFinite(shortest) && shortest > 0 && meanEdge / shortest > THIN_CELL_RATIO) {
    basis = "shortest-edge";
    length = shortest;
    limitation =
      "The smallest element is thin or anisotropic, so its shortest edge is used; " +
      "mean edge length would overestimate the stable step.";
  }
  const dt = (safety * courant * length) / u;
  const diag = diagonal(model);
  const flowThroughTime = Number.isFinite(diag) ? diag / u : NaN;
  const out: TimeStepEstimate = {
    available: true,
    dt,
    courant,
    safety,
    refVelocity: u,
    length,
    basis,
    limitation,
    flowThroughTime,
  };
  if (input.endTime !== undefined && input.endTime > 0) {
    out.steps = Math.ceil(input.endTime / dt);
    if (input.outputInterval !== undefined && input.outputInterval > 0) {
      out.frames = Math.floor(input.endTime / input.outputInterval) + 1;
      const per = frameBytesRange(model);
      out.storage = {
        minBytes: per.minBytes * out.frames,
        maxBytes: per.maxBytes * out.frames,
        note: per.note,
      };
    }
  }
  return out;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(2) : String(Number(v.toPrecision(3)));
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Plain-text guidance lines for the Problemtype section. `currentDt` is the
 * user's own time step: it is compared, never replaced.
 */
export function describeEstimate(est: TimeStepEstimate, currentDt?: number): string[] {
  if (!est.available) return [`Time-step estimate unavailable: ${est.reason}`];
  const lines = [
    `Convective estimate: dt ≈ ${fmt(est.dt)} (Co ${fmt(est.courant)} × safety ${fmt(est.safety)}, ` +
      `h = ${fmt(est.length)} ${est.basis === "mean-edge" ? "mean edge of the smallest element" : "shortest edge"}, |U| = ${fmt(est.refVelocity)}).`,
  ];
  if (est.limitation) lines.push(est.limitation);
  if (currentDt !== undefined && currentDt > 0) {
    lines.push(`Your step is ${fmt(currentDt / est.dt)}× the estimate (guidance only, not a stability guarantee).`);
  }
  if (Number.isFinite(est.flowThroughTime)) lines.push(`Flow-through time ≈ ${fmt(est.flowThroughTime)}.`);
  if (est.steps !== undefined) {
    let budget = `${est.steps} steps at the estimate`;
    if (est.frames !== undefined && est.storage) {
      budget += `; ${est.frames} output frames, ~${fmtBytes(est.storage.minBytes)}–${fmtBytes(est.storage.maxBytes)} (${est.storage.note})`;
    }
    lines.push(budget + ".");
  }
  return lines;
}
