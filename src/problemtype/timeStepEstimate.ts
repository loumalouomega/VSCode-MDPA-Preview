// Pure (no vscode/DOM) transient time-step and output-budget guidance.
//
// The estimate is a convective (Courant) time scale, dt = safety * Co * h / |U|,
// shown as GUIDANCE: it is not a stability guarantee for implicit, diffusive or
// structural solvers, and user-entered values always stay authoritative.
import { MdpaModel } from "../parser/types";
import { computeMeshSize } from "../parser/meshSize";

export type LengthBasis = "mean-edge" | "shortest-edge" | "volume" | "bbox";

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

function extents(model: MdpaModel): [number, number, number] | undefined {
  const b = model.bounds as { min: number[]; max: number[] } | undefined;
  if (!b) return undefined;
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  if (![dx, dy, dz].every(Number.isFinite)) return undefined;
  return [dx, dy, dz];
}

/**
 * Geometry-only fallback when the mesh has no measurable elements
 * (point-only, empty or unknown cell types): `computeMeshSize` reports
 * `analyzedCount === 0` and there is no cell edge to measure.
 *
 * Order mirrors Magnusim's `estimate_delta_t` sizing-then-bounding-box chain:
 * a bounding-box volume (3D) or area (2D) per node first, then the
 * bounding-box diagonal per node. Both assume a roughly uniform mesh and say
 * so in `limitation`: a cube-root volume is NOT sufficient for highly
 * anisotropic or clustered meshes, so the result stays guidance with an
 * explicit fallback basis rather than a fabricated cell size.
 */
export function fallbackLength(model: MdpaModel): { length: number; basis: LengthBasis; limitation: string } | undefined {
  const n = model.nodeCount;
  if (!(n >= 2)) return undefined;
  const e = extents(model);
  if (!e) return undefined;
  const [dx, dy, dz] = e;
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(diag) || !(diag > 0)) return undefined;
  if (model.is3D) {
    const vol = dx * dy * dz;
    if (Number.isFinite(vol) && vol > 0) {
      return {
        length: Math.cbrt(vol / n),
        basis: "volume",
        limitation:
          "No measurable elements, so h is the cube root of the bounding-box volume per node — " +
          "a geometry-only fallback assuming a roughly uniform mesh, which may overestimate " +
          "the stable step for anisotropic or clustered meshes.",
      };
    }
  } else {
    const area = dx * dy;
    if (Number.isFinite(area) && area > 0) {
      return {
        length: Math.sqrt(area / n),
        basis: "volume",
        limitation:
          "No measurable elements, so h is the square root of the bounding-box area per node — " +
          "a geometry-only fallback assuming a roughly uniform mesh, which may overestimate " +
          "the stable step for anisotropic or clustered meshes.",
      };
    }
  }
  const root = model.is3D ? Math.cbrt(n) : Math.sqrt(n);
  if (!Number.isFinite(root) || !(root > 0)) return undefined;
  return {
    length: diag / root,
    basis: "bbox",
    limitation:
      "No measurable elements and no usable bounding-box volume, so h is the bounding-box " +
      "diagonal per node — a geometry-only fallback assuming a roughly uniform mesh, which " +
      "may overestimate the stable step for anisotropic or clustered meshes.",
  };
}

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
  let basis: LengthBasis = "mean-edge";
  let length = meanEdge;
  let limitation: string | undefined;
  if (size.analyzedCount === 0 || !Number.isFinite(meanEdge) || !(meanEdge > 0)) {
    const fb = fallbackLength(model);
    if (!fb) {
      return { available: false, reason: "The mesh has no measurable elements." };
    }
    basis = fb.basis;
    length = fb.length;
    limitation = fb.limitation;
  } else if (Number.isFinite(shortest) && shortest > 0 && meanEdge / shortest > THIN_CELL_RATIO) {
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
  const basisText =
    est.basis === "mean-edge"
      ? "mean edge of the smallest element"
      : est.basis === "shortest-edge"
        ? "shortest edge"
        : est.basis === "volume"
          ? "bounding-box volume per node (fallback, no measurable elements)"
          : "bounding-box diagonal per node (fallback, no measurable elements)";
  const lines = [
    `Convective estimate: dt ≈ ${fmt(est.dt)} (Co ${fmt(est.courant)} × safety ${fmt(est.safety)}, ` +
      `h = ${fmt(est.length)} ${basisText}, |U| = ${fmt(est.refVelocity)}).`,
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

export interface TimeSteppingIssue {
  severity: "error" | "warning";
  message: string;
}

/**
 * Validates the fluid problemtype's fixed/adaptive time-stepping values before
 * generation. The emitted keys match Kratos' `FluidDynamicsApplication`
 * `NavierStokesMonolithicSolver.GetDefaultParameters` (`automatic_time_step`,
 * `CFL_number`, `minimum_delta_time`, `maximum_delta_time`, `time_step`,
 * checked 2026-10-01 against Kratos master): `FluidSolver._ComputeDeltaTime`
 * reads `time_step` for a fixed run and the `EstimateDtUtility` (built from
 * the whole `time_stepping` block) for an adaptive one, while
 * `_ComputeInitialDeltaTime` starts an adaptive run at `minimum_delta_time`.
 * The utility clamps its CFL estimate into `[minimum_delta_time,
 * maximum_delta_time]`, which is what the min/max and out-of-range checks
 * below mirror. The only intentional default difference is
 * `maximum_delta_time` (0.1 here vs 0.01 upstream): a user default, not a
 * solver requirement. No Kratos runtime is needed: this is pure value
 * validation, and a missing runtime never blocks generation.
 */
export function validateFluidTimeStepping(values: Record<string, unknown>): TimeSteppingIssue[] {
  const out: TimeSteppingIssue[] = [];
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const mode = values.timeStepMode;
  if (mode !== undefined && mode !== "fixed" && mode !== "adaptive") {
    out.push({ severity: "error", message: `Time stepping mode "${String(mode)}" is unknown (expected "fixed" or "adaptive").` });
    return out;
  }
  const dt = num(values.timeStep);
  if (dt === undefined || !(dt > 0)) {
    out.push({ severity: "error", message: "Time step must be a positive number." });
  }
  if (mode === "adaptive") {
    const co = num(values.courantTarget);
    const lo = num(values.minDeltaTime);
    const hi = num(values.maxDeltaTime);
    if (co === undefined || !(co > 0)) {
      out.push({ severity: "error", message: "Target Courant number must be a positive number." });
    }
    if (lo === undefined || !(lo > 0)) {
      out.push({ severity: "error", message: "Min. time step must be a positive number." });
    }
    if (hi === undefined || !(hi > 0)) {
      out.push({ severity: "error", message: "Max. time step must be a positive number." });
    }
    if (lo !== undefined && hi !== undefined && lo > 0 && hi > 0 && lo > hi) {
      out.push({ severity: "error", message: "Min. time step exceeds Max. time step." });
    }
    if (dt !== undefined && dt > 0 && lo !== undefined && hi !== undefined && lo > 0 && hi > 0 && lo <= hi) {
      if (dt < lo || dt > hi) {
        out.push({
          severity: "warning",
          message:
            "Time step is outside [Min., Max.]; Kratos starts an adaptive run at " +
            "minimum_delta_time and clamps the CFL estimate into that interval.",
        });
      }
    }
  }
  return out;
}
