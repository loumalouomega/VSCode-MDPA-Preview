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

export type Vec3 = [number, number, number];
export type StreamSeedKind = "points" | "line" | "plane" | "part";
export type StreamDirection = "forward" | "backward" | "both";

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
  const row = p.map((x) => String(Number(x.toPrecision(9)))).join(" ");
  return text.trim() === "" ? row : `${text.replace(/\s+$/, "")}\n${row}`;
}
