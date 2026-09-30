/**
 * Steady streamlines of a solved NODAL vector field (roadmap item 9).
 *
 * A streamline is the curve tangent to the field at every point of one frozen
 * frame: `dx/ds = v(x) / |v(x)|`, integrated here by classical RK4 in ARC
 * LENGTH, so the step is a distance rather than a time and does not shrink
 * where the flow is slow. The field is interpolated barycentrically inside the
 * containing simplex of a pure-JS locator (`cellLocator.ts`). meshio++ is not
 * involved at all: its `interpolate` re-converts the whole model per call,
 * which is unusable inside an integrator loop, and no streamline binding
 * exists to route to.
 *
 * Every way a line can end is reported, never hidden: it left the domain, it
 * met a node with no value, it ran into a stagnation point, or it hit one of
 * the caps the caller set. A seed that produces no segment at all is listed
 * with the reason rather than silently dropped. These are STEADY streamlines of
 * one frame; a transient pathline needs time interpolation and is a different
 * feature.
 *
 * Pure module: no vscode / DOM / vtk.js / wasm imports.
 */

import { buildCellLocator, CellLocator, Vec3 } from "./cellLocator";
import { EntityBlock, FieldData, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { finalizeModel } from "./modelBuilder";
import { VtkCellType } from "./geometryMap";
import { findSubModelPart } from "./subModelPartExtract";

/** Why a streamline ended. The numbers are what `STREAM_TERMINATION` stores in an exported file. */
export const STREAM_TERMINATION = {
  maxLength: 0,
  maxSteps: 1,
  leftDomain: 2,
  stagnation: 3,
  missingData: 4,
  seedOutside: 5,
  immediateStop: 6,
} as const;
export type StreamTermination = (typeof STREAM_TERMINATION)[keyof typeof STREAM_TERMINATION];

export const STREAM_TERMINATION_LABELS: Record<number, string> = {
  0: "reached the maximum length",
  1: "reached the maximum number of steps",
  2: "left the domain",
  3: "reached a stagnation point (speed below the tolerance)",
  4: "met a node with no field value",
  5: "seed lies outside the domain",
  6: "stopped immediately (zero speed at the seed)",
};

export const STREAM_DEFAULT_MAX_STEPS = 2000;
export const STREAM_MAX_STEPS_LIMIT = 100_000;
export const STREAM_DEFAULT_MAX_SEEDS = 1000;
export const STREAM_MAX_SEEDS_LIMIT = 10_000;
/** Hard ceiling on the vertices of one result, so seeds x steps cannot exhaust memory. */
export const STREAM_MAX_POINTS = 2_000_000;
export const STREAM_DEFAULT_STEP_FRACTION = 0.25;
/** A speed below `minSpeed` x the field's largest magnitude counts as stagnant. */
export const STREAM_DEFAULT_MIN_SPEED = 1e-6;

export type StreamSeeds =
  | { kind: "points"; points: Vec3[] }
  /** `count` equidistant points from `from` to `to`, both ends included. */
  | { kind: "line"; from: Vec3; to: Vec3; count: number }
  /** An `nu` x `nv` lattice `origin + i/(nu-1)·u + j/(nv-1)·v` (a single row/column sits at the middle). */
  | { kind: "plane"; origin: Vec3; u: Vec3; v: Vec3; nu: number; nv: number }
  /** The nodes of a SubModelPart and its subtree. */
  | { kind: "part"; path: string };

export interface StreamlineParams {
  /** A Nodal field with 2 or 3 components. */
  variable: string;
  seeds: StreamSeeds;
  /** Default `forward`. `both` traces the two halves as two separate lines per seed. */
  direction?: "forward" | "backward" | "both";
  maxSteps?: number;
  /** Total arc length per line; default five bounding-box diagonals. */
  maxLength?: number;
  /** Step as a fraction of the containing cell's size, in (0, 1]; default 0.25. */
  stepFraction?: number;
  /** Stagnation tolerance relative to the field's largest magnitude; default 1e-6. */
  minSpeed?: number;
  maxSeeds?: number;
}

export interface Streamline {
  /** Index into the resolved seed list (0-based). */
  seedIndex: number;
  /** +1 forward, -1 backward. */
  direction: 1 | -1;
  termination: StreamTermination;
  /** Vertices, flat xyz. */
  points: Float64Array;
  /** |v| at each vertex. */
  speed: Float64Array;
  /** v at each vertex, flat xyz (the field's own direction, not the traversal's). */
  velocity: Float64Array;
  /** Arc length from the seed, along the traversal. */
  arclength: Float64Array;
}

export interface RejectedSeed {
  seedIndex: number;
  direction: 1 | -1;
  point: Vec3;
  termination: StreamTermination;
}

export interface StreamlineResult {
  variable: string;
  components: number;
  seeds: Vec3[];
  lines: Streamline[];
  /** Seeds that yielded no segment, with the reason. */
  rejected: RejectedSeed[];
  /** Emitted lines per termination code. */
  terminationCounts: Record<number, number>;
  /** True when the caller aborted; `lines` is what completed before that. */
  cancelled: boolean;
  /** True when the vertex ceiling stopped the run early. */
  truncated: boolean;
  maxLength: number;
  maxSteps: number;
  stepFraction: number;
  /** The absolute speed below which a line stagnates. */
  speedTolerance: number;
}

export interface StreamlineOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const finite3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Resolves a seed specification to points, refusing more than `maxSeeds` rather than truncating. */
export function resolveSeeds(model: MdpaModel, seeds: StreamSeeds, maxSeeds: number): Vec3[] {
  const out: Vec3[] = [];
  const fail = (n: number): never => {
    throw new Error(`${n} seeds exceed the limit of ${maxSeeds}. Lower the seed count or raise maxSeeds (at most ${STREAM_MAX_SEEDS_LIMIT}).`);
  };
  const add = (p: Vec3): void => {
    if (out.length >= maxSeeds) fail(out.length + 1);
    out.push(p);
  };
  switch (seeds.kind) {
    case "points": {
      if (!Array.isArray(seeds.points) || seeds.points.length === 0) throw new Error("Give at least one seed point.");
      for (const p of seeds.points) {
        if (!finite3(p)) throw new Error("Every seed point must be three finite numbers.");
        add([p[0], p[1], p[2]]);
      }
      return out;
    }
    case "line": {
      if (!finite3(seeds.from) || !finite3(seeds.to)) throw new Error("A seed line needs finite `from` and `to` points.");
      if (!Number.isInteger(seeds.count) || seeds.count < 2) throw new Error("A seed line needs an integer count of at least 2.");
      if (seeds.count > maxSeeds) fail(seeds.count);
      for (let i = 0; i < seeds.count; i++) {
        const t = i / (seeds.count - 1);
        add([0, 1, 2].map((k) => seeds.from[k] + t * (seeds.to[k] - seeds.from[k])) as Vec3);
      }
      return out;
    }
    case "plane": {
      if (!finite3(seeds.origin) || !finite3(seeds.u) || !finite3(seeds.v)) throw new Error("A seed plane needs a finite origin and two in-plane edge vectors u and v.");
      if (!Number.isInteger(seeds.nu) || !Number.isInteger(seeds.nv) || seeds.nu < 1 || seeds.nv < 1) {
        throw new Error("A seed plane needs integer nu and nv of at least 1.");
      }
      if (seeds.nu * seeds.nv > maxSeeds) fail(seeds.nu * seeds.nv);
      for (let i = 0; i < seeds.nu; i++) {
        const a = seeds.nu > 1 ? i / (seeds.nu - 1) : 0.5;
        for (let j = 0; j < seeds.nv; j++) {
          const b = seeds.nv > 1 ? j / (seeds.nv - 1) : 0.5;
          add([0, 1, 2].map((k) => seeds.origin[k] + a * seeds.u[k] + b * seeds.v[k]) as Vec3);
        }
      }
      return out;
    }
    case "part": {
      const part = findSubModelPart(model, seeds.path);
      if (!part) throw new Error(`No SubModelPart "${seeds.path}".`);
      const ids = new Set<number>();
      const walk = (p: SubModelPart): void => {
        for (const id of p.nodeIds) ids.add(id);
        p.children.forEach(walk);
      };
      walk(part);
      if (ids.size === 0) throw new Error(`SubModelPart "${seeds.path}" lists no nodes to seed from.`);
      if (ids.size > maxSeeds) fail(ids.size);
      const index = new Map<number, number>();
      for (let i = 0; i < model.nodeCount; i++) index.set(model.nodeIds[i], i);
      for (const id of ids) {
        const i = index.get(id);
        if (i === undefined) continue;
        add([model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]]);
      }
      if (out.length === 0) throw new Error(`None of the nodes of "${seeds.path}" exist in the mesh.`);
      return out;
    }
    default:
      throw new Error("Unknown seed kind.");
  }
}

/** The Nodal vector field a trace reads, or an error that says what to do instead. */
export function requireVelocityField(model: MdpaModel, variable: string): FieldData {
  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === variable);
  if (!field) {
    const other = model.fields.find((f) => f.variable === variable);
    if (other) throw new Error(`"${variable}" is an ${other.kind} field; streamlines need a Nodal vector field. Run Average field first.`);
    const vectors = model.fields.filter((f) => f.kind === "Nodal" && (f.components === 2 || f.components === 3)).map((f) => f.variable);
    throw new Error(`No Nodal field "${variable}".` + (vectors.length ? ` Nodal vector fields: ${vectors.join(", ")}.` : " The mesh has no Nodal vector field."));
  }
  if (field.components !== 2 && field.components !== 3) {
    throw new Error(`"${variable}" has ${field.components} component${field.components === 1 ? "" : "s"}; streamlines need a 2- or 3-component vector field.`);
  }
  return field;
}

/** Nodal vector fields a trace could read (the UI's picker). */
export function velocityFieldNames(model: MdpaModel): string[] {
  return model.fields.filter((f) => f.kind === "Nodal" && (f.components === 2 || f.components === 3)).map((f) => f.variable);
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type Status = "ok" | "outside" | "missing";

export async function traceStreamlines(model: MdpaModel, params: StreamlineParams, opts: StreamlineOptions = {}): Promise<StreamlineResult> {
  const field = requireVelocityField(model, params.variable);
  const maxSteps = params.maxSteps ?? STREAM_DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > STREAM_MAX_STEPS_LIMIT) {
    throw new Error(`maxSteps must be an integer from 1 to ${STREAM_MAX_STEPS_LIMIT}.`);
  }
  const maxSeeds = params.maxSeeds ?? STREAM_DEFAULT_MAX_SEEDS;
  if (!Number.isInteger(maxSeeds) || maxSeeds < 1 || maxSeeds > STREAM_MAX_SEEDS_LIMIT) {
    throw new Error(`maxSeeds must be an integer from 1 to ${STREAM_MAX_SEEDS_LIMIT}.`);
  }
  const stepFraction = params.stepFraction ?? STREAM_DEFAULT_STEP_FRACTION;
  if (!(stepFraction > 0 && stepFraction <= 1)) throw new Error("stepFraction must be in (0, 1].");
  const minSpeed = params.minSpeed ?? STREAM_DEFAULT_MIN_SPEED;
  if (!(minSpeed >= 0 && Number.isFinite(minSpeed))) throw new Error("minSpeed must be a non-negative number.");
  const diag = Math.hypot(
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
    model.bounds.max[2] - model.bounds.min[2]
  );
  const maxLength = params.maxLength ?? 5 * diag;
  if (!(maxLength > 0 && Number.isFinite(maxLength))) throw new Error("maxLength must be a positive number.");
  const direction = params.direction ?? "forward";
  if (direction !== "forward" && direction !== "backward" && direction !== "both") throw new Error(`Unknown direction "${direction}".`);

  const seeds = resolveSeeds(model, params.seeds, maxSeeds);
  const locator: CellLocator | null = buildCellLocator(model);
  if (!locator) throw new Error("The mesh has no cell with an interior (triangle, quad or volume cell) to interpolate in.");

  const c = field.components;
  const rowOf = new Map<number, number>();
  for (let r = 0; r < field.ids.length; r++) rowOf.set(field.ids[r], r);
  let maxMag = 0;
  for (let r = 0; r < field.ids.length; r++) {
    const m = Math.hypot(field.values[r * c], field.values[r * c + 1], c === 3 ? field.values[r * c + 2] : 0);
    if (Number.isFinite(m) && m > maxMag) maxMag = m;
  }
  const speedTolerance = minSpeed * maxMag;

  const result: StreamlineResult = {
    variable: params.variable,
    components: c,
    seeds,
    lines: [],
    rejected: [],
    terminationCounts: {},
    cancelled: false,
    truncated: false,
    maxLength,
    maxSteps,
    stepFraction,
    speedTolerance,
  };

  // Field value at p into `v`; `cellSize` is left at the containing simplex's size.
  let cellSize = 0;
  const v: Vec3 = [0, 0, 0];
  const sample = (p: Vec3): Status => {
    const hit = locator.locate(p);
    if (!hit) return "outside";
    const ids = hit.simplex.ids;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < ids.length; k++) {
      const row = rowOf.get(ids[k]);
      if (row === undefined) return "missing";
      const a = field.values[row * c];
      const b = field.values[row * c + 1];
      const d = c === 3 ? field.values[row * c + 2] : 0;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(d)) return "missing";
      const w = hit.weights[k];
      x += w * a;
      y += w * b;
      z += w * d;
    }
    v[0] = x;
    v[1] = y;
    v[2] = z;
    cellSize = locator.sizeOf(hit.simplex);
    return "ok";
  };

  // Unit tangent at p along the traversal, or a failure. `null` = stagnant.
  const tangent = (p: Vec3, sign: number, out: Vec3): Status | "stagnant" => {
    const s = sample(p);
    if (s !== "ok") return s;
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (!(speed > speedTolerance) || speed === 0) return "stagnant";
    out[0] = (sign * v[0]) / speed;
    out[1] = (sign * v[1]) / speed;
    out[2] = (sign * v[2]) / speed;
    return "ok";
  };

  const k1: Vec3 = [0, 0, 0];
  const k2: Vec3 = [0, 0, 0];
  const k3: Vec3 = [0, 0, 0];
  const k4: Vec3 = [0, 0, 0];
  const probe: Vec3 = [0, 0, 0];
  const next: Vec3 = [0, 0, 0];
  const MAX_HALVINGS = 6;

  const trace = (seedIndex: number, seed: Vec3, sign: 1 | -1): void => {
    const start = sample(seed);
    if (start !== "ok") {
      result.rejected.push({
        seedIndex,
        direction: sign,
        point: seed,
        termination: start === "outside" ? STREAM_TERMINATION.seedOutside : STREAM_TERMINATION.missingData,
      });
      return;
    }
    if (!(Math.hypot(v[0], v[1], v[2]) > speedTolerance)) {
      result.rejected.push({ seedIndex, direction: sign, point: seed, termination: STREAM_TERMINATION.immediateStop });
      return;
    }
    const pts: number[] = [seed[0], seed[1], seed[2]];
    const spd: number[] = [Math.hypot(v[0], v[1], v[2])];
    const vel: number[] = [v[0], v[1], v[2]];
    const arc: number[] = [0];
    const p: Vec3 = [seed[0], seed[1], seed[2]];
    let length = 0;
    let steps = 0;
    let termination: StreamTermination = STREAM_TERMINATION.maxSteps;
    while (true) {
      if (steps >= maxSteps) { termination = STREAM_TERMINATION.maxSteps; break; }
      if (length >= maxLength * (1 - 1e-12)) { termination = STREAM_TERMINATION.maxLength; break; }
      sample(p); // refreshes cellSize for the step at p (p is known to be inside)
      const h0 = Math.min(stepFraction * cellSize, maxLength - length);
      let h = h0;
      let failure: Status | "stagnant" = "ok";
      let done = false;
      let hUsed = 0;
      for (let attempt = 0; attempt <= MAX_HALVINGS && !done; attempt++, h /= 2) {
        failure = tangent(p, sign, k1);
        if (failure !== "ok") break; // the start point itself is invalid: stop, do not halve
        for (let i = 0; i < 3; i++) probe[i] = p[i] + 0.5 * h * k1[i];
        failure = tangent(probe, sign, k2);
        if (failure !== "ok") continue;
        for (let i = 0; i < 3; i++) probe[i] = p[i] + 0.5 * h * k2[i];
        failure = tangent(probe, sign, k3);
        if (failure !== "ok") continue;
        for (let i = 0; i < 3; i++) probe[i] = p[i] + h * k3[i];
        failure = tangent(probe, sign, k4);
        if (failure !== "ok") continue;
        for (let i = 0; i < 3; i++) next[i] = p[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        const end = sample(next);
        if (end !== "ok") { failure = end; continue; }
        done = true;
        hUsed = h;
      }
      if (!done) {
        termination =
          failure === "outside" ? STREAM_TERMINATION.leftDomain
          : failure === "missing" ? STREAM_TERMINATION.missingData
          : STREAM_TERMINATION.stagnation;
        break;
      }
      length += hUsed;
      steps++;
      p[0] = next[0]; p[1] = next[1]; p[2] = next[2];
      const s = Math.hypot(v[0], v[1], v[2]);
      pts.push(p[0], p[1], p[2]);
      spd.push(s);
      vel.push(v[0], v[1], v[2]);
      arc.push(length);
      if (!(s > speedTolerance)) { termination = STREAM_TERMINATION.stagnation; break; }
    }
    if (pts.length < 6) {
      result.rejected.push({ seedIndex, direction: sign, point: seed, termination });
      return;
    }
    result.lines.push({
      seedIndex,
      direction: sign,
      termination,
      points: Float64Array.from(pts),
      speed: Float64Array.from(spd),
      velocity: Float64Array.from(vel),
      arclength: Float64Array.from(arc),
    });
    result.terminationCounts[termination] = (result.terminationCounts[termination] ?? 0) + 1;
  };

  const signs: (1 | -1)[] = direction === "forward" ? [1] : direction === "backward" ? [-1] : [1, -1];
  let vertices = 0;
  let lastYield = Date.now();
  for (let i = 0; i < seeds.length; i++) {
    if (opts.signal?.aborted) { result.cancelled = true; break; }
    if (vertices >= STREAM_MAX_POINTS) { result.truncated = true; break; }
    for (const sign of signs) {
      const before = result.lines.length;
      trace(i, seeds[i], sign);
      if (result.lines.length > before) vertices += result.lines[result.lines.length - 1].speed.length;
    }
    opts.onProgress?.(i + 1, seeds.length);
    if (Date.now() - lastYield > 40) {
      await yieldToLoop();
      lastYield = Date.now();
    }
  }
  return result;
}

/** One sentence per fact: how many lines, how they ended, which seeds gave none. */
export function describeStreamlines(r: StreamlineResult): string {
  const parts: string[] = [`${r.lines.length} streamline${r.lines.length === 1 ? "" : "s"} of "${r.variable}" from ${r.seeds.length} seed${r.seeds.length === 1 ? "" : "s"}`];
  const ends = Object.entries(r.terminationCounts)
    .map(([code, n]) => `${n} ${STREAM_TERMINATION_LABELS[Number(code)]}`)
    .join("; ");
  if (ends) parts.push(`ended: ${ends}`);
  if (r.rejected.length) {
    const by = new Map<number, number>();
    for (const x of r.rejected) by.set(x.termination, (by.get(x.termination) ?? 0) + 1);
    parts.push(`no line for ${r.rejected.length}: ${[...by].map(([code, n]) => `${n} ${STREAM_TERMINATION_LABELS[code]}`).join("; ")}`);
  }
  if (r.truncated) parts.push(`stopped early at the ${STREAM_MAX_POINTS.toLocaleString("en-US")}-vertex ceiling`);
  if (r.cancelled) parts.push("cancelled; partial result");
  return parts.join(". ") + ".";
}

/** Flat arrays for drawing: legacy `[n, i0..]` polylines over one shared point array. */
export function streamlinePolylines(r: StreamlineResult): {
  points: Float32Array;
  lines: Uint32Array;
  speed: Float32Array;
  termination: Uint8Array;
} {
  let n = 0;
  for (const l of r.lines) n += l.speed.length;
  const points = new Float32Array(n * 3);
  const speed = new Float32Array(n);
  const lines = new Uint32Array(n + r.lines.length);
  const termination = new Uint8Array(r.lines.length);
  let base = 0;
  let w = 0;
  r.lines.forEach((l, li) => {
    const m = l.speed.length;
    lines[w++] = m;
    for (let i = 0; i < m; i++) {
      points[(base + i) * 3] = l.points[i * 3];
      points[(base + i) * 3 + 1] = l.points[i * 3 + 1];
      points[(base + i) * 3 + 2] = l.points[i * 3 + 2];
      speed[base + i] = l.speed[i];
      lines[w++] = base + i;
    }
    termination[li] = l.termination;
    base += m;
  });
  return { points, lines, speed, termination };
}

/**
 * The lines as a standalone mesh: one node per vertex (nodes are NOT shared
 * where two lines meet at a seed), one `Line2D2N` element per segment. Per-point
 * samples are Nodal fields; per-line facts are Elemental fields repeated over
 * the line's segments and stored as numbers (a `FieldData` holds no text — the
 * codes are in `STREAM_TERMINATION` and the summary names the source frame).
 */
export function streamlinesToModel(r: StreamlineResult, diagnostics: MdpaDiagnostic[] = []): MdpaModel {
  let nodeCount = 0;
  let segCount = 0;
  for (const l of r.lines) {
    nodeCount += l.speed.length;
    segCount += l.speed.length - 1;
  }
  const coords = new Float32Array(nodeCount * 3);
  const conn = new Int32Array(segCount * 2);
  const entityIds = new Int32Array(segCount);
  const nodeIds = new Int32Array(nodeCount);
  const speed = new Float64Array(nodeCount);
  const velocity = new Float64Array(nodeCount * 3);
  const arclength = new Float64Array(nodeCount);
  const seed = new Float64Array(segCount);
  const termination = new Float64Array(segCount);
  const dir = new Float64Array(segCount);
  const lineNo = new Float64Array(segCount);
  let node = 0;
  let seg = 0;
  r.lines.forEach((l, li) => {
    const m = l.speed.length;
    const first = node;
    for (let i = 0; i < m; i++, node++) {
      nodeIds[node] = node + 1;
      for (let k = 0; k < 3; k++) {
        coords[node * 3 + k] = l.points[i * 3 + k];
        velocity[node * 3 + k] = l.velocity[i * 3 + k];
      }
      speed[node] = l.speed[i];
      arclength[node] = l.arclength[i];
    }
    for (let i = 0; i < m - 1; i++, seg++) {
      entityIds[seg] = seg + 1;
      conn[seg * 2] = first + i + 1;
      conn[seg * 2 + 1] = first + i + 2;
      seed[seg] = l.seedIndex;
      termination[seg] = l.termination;
      dir[seg] = l.direction;
      lineNo[seg] = li + 1;
    }
  });
  const block: EntityBlock = {
    kind: "Elements",
    name: "Line2D2N",
    vtkCellType: VtkCellType.LINE,
    count: segCount,
    stride: 2,
    entityIds,
    connectivity: conn,
  };
  const nodal = (variable: string, components: number, values: Float64Array): FieldData => ({ kind: "Nodal", variable, components, ids: nodeIds, values });
  const elemental = (variable: string, values: Float64Array): FieldData => ({ kind: "Elemental", variable, components: 1, ids: entityIds, values });
  return finalizeModel({
    nodeCount,
    coords,
    nodeIds,
    blocks: segCount > 0 ? [block] : [],
    fields: [
      nodal("STREAM_SPEED", 1, speed),
      nodal("STREAM_VELOCITY", 3, velocity),
      nodal("STREAM_ARCLENGTH", 1, arclength),
      elemental("STREAM_LINE", lineNo),
      elemental("STREAM_SEED", seed),
      elemental("STREAM_TERMINATION", termination),
      elemental("STREAM_DIRECTION", dir),
    ],
    diagnostics,
  });
}
