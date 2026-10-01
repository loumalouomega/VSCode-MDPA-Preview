/**
 * The Streamlines panel's form, as data: what the user typed (kept as text so a
 * half-edited value survives a re-render) and the one function that turns it
 * into a request or an error naming the offending field.
 *
 * Pure and bundled into the webview, which cannot be exercised under
 * `node:test` — so every decision the panel makes about its input lives here,
 * where it can be.
 */

import type { StreamSeeds } from "./streamlines";
import type { PaneClipState } from "./paneView";

export type Vec3 = [number, number, number];
export type StreamSeedKind = "points" | "line" | "plane" | "part";
export type StreamDirection = "forward" | "backward" | "both";

/** View-only line/tube styling for the live overlay. Export still writes line cells. */
export type StreamlineStyleMode = "lines" | "tubes";
export interface StreamlineStyle {
  mode: StreamlineStyleMode;
  /** Polyline width in pixels (lines mode). */
  lineWidth: number;
  /** Tube radius as a fraction of the model's bounding-box diagonal (tubes mode). */
  tubeRadiusFraction: number;
  /** Ring resolution of a tube (tubes mode). */
  tubeSides: number;
}

export function defaultStreamlineStyle(): StreamlineStyle {
  return { mode: "lines", lineWidth: 2.5, tubeRadiusFraction: 0.005, tubeSides: 8 };
}

/** The only widths/radii/sides the panel offers — no free text, so no validation state. */
export const STREAMLINE_LINE_WIDTHS = [1, 1.5, 2, 2.5, 4];
export const STREAMLINE_TUBE_RADIUS_FRACTIONS = [0.002, 0.005, 0.01];
export const STREAMLINE_TUBE_SIDES = [6, 8, 12];

export interface StreamlineForm {
  variable: string;
  seedKind: StreamSeedKind;
  /** One `x y z` (space or comma separated) per line. */
  points: string;
  lineFrom: string;
  lineTo: string;
  lineCount: string;
  planeOrigin: string;
  planeU: string;
  planeV: string;
  planeNu: string;
  planeNv: string;
  part: string;
  direction: StreamDirection;
  /** Blank means the module's own default. */
  maxSteps: string;
  maxLength: string;
  stepFraction: string;
}

export function defaultStreamlineForm(): StreamlineForm {
  return {
    variable: "",
    seedKind: "points",
    points: "",
    lineFrom: "",
    lineTo: "",
    lineCount: "10",
    planeOrigin: "",
    planeU: "",
    planeV: "",
    planeNu: "5",
    planeNv: "5",
    part: "",
    direction: "forward",
    maxSteps: "",
    maxLength: "",
    stepFraction: "",
  };
}

/** `"1 2 3"` / `"1, 2, 3"` -> a finite triple; anything else is undefined. */
export function parseVec3(text: string): Vec3 | undefined {
  const parts = text.trim().split(/[\s,;]+/).filter((s) => s.length > 0);
  if (parts.length !== 3) return undefined;
  const v = parts.map(Number);
  return v.every((x) => Number.isFinite(x)) ? (v as Vec3) : undefined;
}

export interface StreamlineRequest {
  variable: string;
  seeds: StreamSeeds;
  direction: StreamDirection;
  maxSteps?: number;
  maxLength?: number;
  stepFraction?: number;
}

export type StreamlineRequestResult = { ok: true; request: StreamlineRequest } | { ok: false; error: string };

const optionalNumber = (text: string, what: string, integer: boolean): number | undefined | Error => {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return new Error(`${what} must be ${integer ? "a whole number" : "a number"}.`);
  return n;
};

export function buildStreamlineRequest(form: StreamlineForm): StreamlineRequestResult {
  if (!form.variable) return { ok: false, error: "Pick a Nodal vector field to trace." };
  const fail = (error: string): StreamlineRequestResult => ({ ok: false, error });
  let seeds: StreamSeeds;
  switch (form.seedKind) {
    case "points": {
      const rows = form.points.split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0);
      if (rows.length === 0) return fail("Enter at least one seed point (x y z per line), or use Pick seeds.");
      const points: Vec3[] = [];
      for (let i = 0; i < rows.length; i++) {
        const p = parseVec3(rows[i]);
        if (!p) return fail(`Seed point ${i + 1} ("${rows[i]}") is not three numbers.`);
        points.push(p);
      }
      seeds = { kind: "points", points };
      break;
    }
    case "line": {
      const from = parseVec3(form.lineFrom);
      const to = parseVec3(form.lineTo);
      if (!from || !to) return fail("A seed line needs From and To as x y z.");
      const count = Number(form.lineCount);
      if (!Number.isInteger(count) || count < 2) return fail("A seed line needs a count of at least 2.");
      seeds = { kind: "line", from, to, count };
      break;
    }
    case "plane": {
      const origin = parseVec3(form.planeOrigin);
      const u = parseVec3(form.planeU);
      const v = parseVec3(form.planeV);
      if (!origin || !u || !v) return fail("A seed plane needs Origin, U and V as x y z.");
      const nu = Number(form.planeNu);
      const nv = Number(form.planeNv);
      if (!Number.isInteger(nu) || !Number.isInteger(nv) || nu < 1 || nv < 1) return fail("A seed plane needs whole-number counts of at least 1.");
      seeds = { kind: "plane", origin, u, v, nu, nv };
      break;
    }
    case "part": {
      if (!form.part) return fail("Pick a SubModelPart to seed from.");
      seeds = { kind: "part", path: form.part };
      break;
    }
    default:
      return fail("Unknown seed source.");
  }
  const maxSteps = optionalNumber(form.maxSteps, "Max steps", true);
  if (maxSteps instanceof Error) return fail(maxSteps.message);
  const maxLength = optionalNumber(form.maxLength, "Max length", false);
  if (maxLength instanceof Error) return fail(maxLength.message);
  const stepFraction = optionalNumber(form.stepFraction, "Step fraction", false);
  if (stepFraction instanceof Error) return fail(stepFraction.message);
  return { ok: true, request: { variable: form.variable, seeds, direction: form.direction, maxSteps, maxLength, stepFraction } };
}

/** Appends a picked point to the points text, one per line. */
export function appendSeedPoint(text: string, p: Vec3): string {
  const row = formatVec3(p);
  return text.trim() === "" ? row : `${text.replace(/\s+$/, "")}\n${row}`;
}

/** Canonical `x y z` rendering of a point (also what fills the plane fields from the clip plane). */
export function formatVec3(p: Vec3): string {
  return p.map((x) => String(Number(x.toPrecision(9)))).join(" ");
}

export interface ClipBounds {
  min: Vec3;
  max: Vec3;
}

const isIntCount = (n: number, lo: number): boolean => Number.isInteger(n) && n >= lo;

/**
 * A seed lattice on the focused pane's clip plane: axis modes span the two
 * in-plane bounding-box extents at the slider position; the free mode spans
 * the tight in-plane bounding rectangle of the projected bounding box. The
 * clip `flipped` flag only negates the plane normal, never its position, so
 * it does not change the seeds. Throws on a degenerate normal or bad counts.
 */
export function planeSeedsFromClip(bounds: ClipBounds, clip: PaneClipState, nu: number, nv: number): StreamSeeds {
  if (!isIntCount(nu, 1) || !isIntCount(nv, 1)) {
    throw new Error("A seed plane needs whole-number counts of at least 1.");
  }
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  if (!(dx >= 0 && dy >= 0 && dz >= 0) || ![dx, dy, dz].every(Number.isFinite)) {
    throw new Error("The mesh has no finite bounding box to seed from.");
  }
  if (clip.axis !== "free") {
    const axis = clip.axis;
    const pos = bounds.min[axis] + clip.t * (bounds.max[axis] - bounds.min[axis]);
    if (axis === 0) return { kind: "plane", origin: [pos, bounds.min[1], bounds.min[2]], u: [0, dy, 0], v: [0, 0, dz], nu, nv };
    if (axis === 1) return { kind: "plane", origin: [bounds.min[0], pos, bounds.min[2]], u: [dx, 0, 0], v: [0, 0, dz], nu, nv };
    return { kind: "plane", origin: [bounds.min[0], bounds.min[1], pos], u: [dx, 0, 0], v: [0, dy, 0], nu, nv };
  }
  const fn = clip.freeNormal;
  const fl = Math.hypot(fn[0], fn[1], fn[2]);
  if (!(fl > 1e-9)) throw new Error("The clip plane's Free normal is degenerate.");
  let normal: Vec3 = [fn[0] / fl, fn[1] / fl, fn[2] / fl];
  if (clip.flipped) normal = [-normal[0], -normal[1], -normal[2]];
  const corners: Vec3[] = [
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.min[2]],
    [bounds.min[0], bounds.max[1], bounds.min[2]],
    [bounds.min[0], bounds.min[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.max[2]],
    [bounds.min[0], bounds.max[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]],
  ];
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of corners) {
    const d = c[0] * normal[0] + c[1] * normal[1] + c[2] * normal[2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const dist = lo + clip.t * (hi - lo);
  const origin0: Vec3 = [normal[0] * dist, normal[1] * dist, normal[2] * dist];
  // In-plane basis, then the tight bounding rectangle of the projected box.
  const helper: Vec3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const ul = Math.hypot(...cross(normal, helper));
  if (!(ul > 1e-9)) throw new Error("The clip plane's Free normal is degenerate.");
  const uDir: Vec3 = cross(normal, helper).map((x) => x / ul) as Vec3;
  const vDir = cross(normal, uDir);
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const c of corners) {
    const rx = c[0] - origin0[0];
    const ry = c[1] - origin0[1];
    const rz = c[2] - origin0[2];
    const a = rx * uDir[0] + ry * uDir[1] + rz * uDir[2];
    const b = rx * vDir[0] + ry * vDir[1] + rz * vDir[2];
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  const origin: Vec3 = [
    origin0[0] + uDir[0] * minA + vDir[0] * minB,
    origin0[1] + uDir[1] * minA + vDir[1] * minB,
    origin0[2] + uDir[2] * minA + vDir[2] * minB,
  ];
  const u: Vec3 = [uDir[0] * (maxA - minA), uDir[1] * (maxA - minA), uDir[2] * (maxA - minA)];
  const v: Vec3 = [vDir[0] * (maxB - minB), vDir[1] * (maxB - minB), vDir[2] * (maxB - minB)];
  return { kind: "plane", origin, u, v, nu, nv };
}

/**
 * Seed points for the viewport preview markers. Lattice math mirrors
 * `resolveSeeds` in streamlines.ts (which re-validates host-side, including
 * maxSeeds); a SubModelPart has no coordinates without the model, so it
 * previews as nothing — its nodes are already visible in the mesh.
 */
export function previewSeedPoints(seeds: StreamSeeds): Vec3[] | undefined {
  switch (seeds.kind) {
    case "points":
      return seeds.points.map((p) => [p[0], p[1], p[2]]);
    case "line": {
      const out: Vec3[] = [];
      for (let i = 0; i < seeds.count; i++) {
        const t = i / (seeds.count - 1);
        out.push([0, 1, 2].map((k) => seeds.from[k] + t * (seeds.to[k] - seeds.from[k])) as Vec3);
      }
      return out;
    }
    case "plane": {
      const out: Vec3[] = [];
      for (let i = 0; i < seeds.nu; i++) {
        const a = seeds.nu > 1 ? i / (seeds.nu - 1) : 0.5;
        for (let j = 0; j < seeds.nv; j++) {
          const b = seeds.nv > 1 ? j / (seeds.nv - 1) : 0.5;
          out.push([0, 1, 2].map((k) => seeds.origin[k] + a * seeds.u[k] + b * seeds.v[k]) as Vec3);
        }
      }
      return out;
    }
    case "part":
      return undefined;
    default:
      return undefined;
  }
}
