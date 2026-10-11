/**
 * Linked previews — the pure half (no vscode / DOM / vtk; both runtimes bundle
 * it and `node:test` can reach it).
 *
 * Two previews of two independent meshes or runs can be linked so that one
 * viewpoint, field choice, colour range, clip plane or point in physical time
 * drives the other. Every setting is its own switch, because "same camera, own
 * field" is the usual comparison and "same field, own camera" is the second.
 *
 * Two rules carry the whole design:
 *
 *  - **Time is matched by physical time, never by frame index.** Two runs
 *    seldom share a time grid, and silently pairing frame 7 with frame 7
 *    compares different instants. `matchTime` is exact or nearest-within-a-
 *    tolerance, refuses a tie, and says WHY a time has no counterpart so the
 *    panel can disclose it. A series whose steps are plain step numbers has no
 *    physical time and is never linked on time.
 *  - **A linked setting is applied to what the receiving mesh can honour.** A
 *    field the other mesh does not have is reported and the receiver keeps its
 *    own, rather than being blanked.
 */

import { CameraState, isCameraState } from "./cameraState";
import { FieldComponent } from "./fieldScalars";
import { FieldMode, PaneClipState, PaneFieldState, clonePaneClipState, clonePaneFieldState } from "./paneView";

export const LINK_KINDS = ["camera", "field", "range", "clip", "time"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export type TimeMethod = "exact" | "nearest";

export interface LinkSettings {
  camera: boolean;
  field: boolean;
  range: boolean;
  clip: boolean;
  time: boolean;
  timeMethod: TimeMethod;
  /** Largest |Δt| a nearest match may span, in the series' own time unit. Ignored by `exact`. */
  timeTolerance: number;
}

export const DEFAULT_LINK_SETTINGS: LinkSettings = {
  camera: true,
  field: true,
  range: true,
  clip: true,
  time: true,
  timeMethod: "exact",
  timeTolerance: 0,
};

const FIELD_MODES: readonly FieldMode[] = ["contour", "quiver", "iso", "deformed", "threshold"];

/** Tolerant read of untrusted settings: anything malformed falls back to the default for that key. */
export function validateLinkSettings(raw: unknown): LinkSettings {
  const out = { ...DEFAULT_LINK_SETTINGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of LINK_KINDS) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  if (r.timeMethod === "exact" || r.timeMethod === "nearest") out.timeMethod = r.timeMethod;
  if (typeof r.timeTolerance === "number" && Number.isFinite(r.timeTolerance) && r.timeTolerance >= 0) out.timeTolerance = r.timeTolerance;
  return out;
}

// --- Physical-time matching --------------------------------------------------

export type TimeMatch =
  | { ok: true; index: number; time: number; delta: number }
  | { ok: false; reason: string };

/** Equal-enough for "exact": a relative 1e-9, so 0.1 + 0.2 still finds 0.3. */
function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The frame of `times` that answers physical time `t`.
 *
 * `exact` needs an equal time; `nearest` takes the closest one within
 * `tolerance`. Never falls back to a neighbour outside the tolerance, and
 * refuses when two frames are equally near (a tie is a guess).
 */
export function matchTime(times: readonly number[], t: number, method: TimeMethod, tolerance: number): TimeMatch {
  if (!Number.isFinite(t)) return { ok: false, reason: "the time is not a finite number" };
  const finite = times.map((v, i) => [v, i] as const).filter(([v]) => Number.isFinite(v));
  if (finite.length === 0) return { ok: false, reason: "the series has no physical times" };
  if (method === "exact") {
    const hits = finite.filter(([v]) => sameTime(v, t));
    if (hits.length === 0) return { ok: false, reason: `no frame at exactly t = ${t}` };
    if (hits.length > 1) return { ok: false, reason: `several frames share t = ${t}` };
    return { ok: true, index: hits[0][1], time: hits[0][0], delta: 0 };
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) return { ok: false, reason: "the tolerance is not a non-negative number" };
  let best = Infinity;
  const nearest: (readonly [number, number])[] = [];
  for (const entry of finite) {
    const d = Math.abs(entry[0] - t);
    if (d < best - 1e-12) {
      best = d;
      nearest.length = 0;
      nearest.push(entry);
    } else if (Math.abs(d - best) <= 1e-12) nearest.push(entry);
  }
  if (best > tolerance) return { ok: false, reason: `the nearest frame is ${best} away, beyond the tolerance ${tolerance}` };
  if (nearest.length > 1) return { ok: false, reason: `t = ${t} lies exactly between two frames` };
  return { ok: true, index: nearest[0][1], time: nearest[0][0], delta: nearest[0][0] - t };
}

// --- Payloads ----------------------------------------------------------------

export interface FieldLinkPayload {
  selectedKey: string;
  component: FieldComponent;
  modes: FieldMode[];
  deformKey: string;
}
export interface RangeLinkPayload {
  colormap: string;
  rangeOverride?: [number, number];
  log: boolean;
  bands: number;
}

export function fieldPayload(f: PaneFieldState): FieldLinkPayload {
  return { selectedKey: f.selectedKey, component: f.component, modes: [...f.modes], deformKey: f.deformKey };
}
export function rangePayload(f: PaneFieldState): RangeLinkPayload {
  return {
    colormap: f.colormap,
    rangeOverride: f.rangeOverride ? [f.rangeOverride[0], f.rangeOverride[1]] : undefined,
    log: f.log,
    bands: f.bands,
  };
}

/** What the receiving mesh offers a linked field to refer to. */
export interface FieldLinkContext {
  hasKey(key: string): boolean;
  isVector(key: string): boolean;
  components(key: string): number;
}

/** A new field state with the linked field choice applied where this mesh can honour it, plus what was not. */
export function applyFieldPayload(state: PaneFieldState, raw: unknown, ctx: FieldLinkContext): { state: PaneFieldState; notes: string[] } {
  const next = clonePaneFieldState(state);
  const notes: string[] = [];
  if (!raw || typeof raw !== "object") return { state: next, notes: ["The linked field choice was malformed."] };
  const p = raw as Partial<FieldLinkPayload>;
  if (typeof p.selectedKey === "string" && p.selectedKey) {
    if (!ctx.hasKey(p.selectedKey)) {
      notes.push(`Field "${p.selectedKey}" is not in this mesh — kept "${state.selectedKey || "none"}".`);
      return { state: next, notes };
    }
    next.selectedKey = p.selectedKey;
    const w = ctx.components(p.selectedKey);
    const c = p.component;
    next.component = c === "mag" || (typeof c === "number" && Number.isInteger(c) && c >= 0 && c < w) ? c : "mag";
    if (Array.isArray(p.modes)) {
      const modes = new Set<FieldMode>(p.modes.filter((m): m is FieldMode => FIELD_MODES.includes(m as FieldMode)));
      // A vector drives quiver, a scalar drives iso (the Field panel's own rule).
      if (!ctx.isVector(p.selectedKey)) modes.delete("quiver");
      else modes.delete("iso");
      if (modes.size === 0) modes.add("contour");
      next.modes = modes;
    }
  }
  if (typeof p.deformKey === "string") {
    if (!p.deformKey || ctx.hasKey(p.deformKey)) next.deformKey = p.deformKey;
    else notes.push(`Deformation field "${p.deformKey}" is not in this mesh.`);
  }
  return { state: next, notes };
}

export function applyRangePayload(state: PaneFieldState, raw: unknown, colormaps: readonly string[]): { state: PaneFieldState; notes: string[] } {
  const next = clonePaneFieldState(state);
  const notes: string[] = [];
  if (!raw || typeof raw !== "object") return { state: next, notes: ["The linked colour range was malformed."] };
  const p = raw as Partial<RangeLinkPayload>;
  if (typeof p.colormap === "string") {
    if (colormaps.includes(p.colormap)) next.colormap = p.colormap;
    else notes.push(`Colormap "${p.colormap}" is unknown here.`);
  }
  const r = p.rangeOverride;
  if (r === undefined) next.rangeOverride = undefined;
  else if (Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === "number" && Number.isFinite(v))) next.rangeOverride = [r[0], r[1]];
  if (typeof p.log === "boolean") next.log = p.log;
  if (typeof p.bands === "number" && Number.isInteger(p.bands) && p.bands >= 0 && p.bands <= 64) next.bands = p.bands;
  return { state: next, notes };
}

export function validateClipPayload(raw: unknown): PaneClipState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Partial<PaneClipState>;
  const n = c.freeNormal;
  if (typeof c.active !== "boolean" || typeof c.flipped !== "boolean") return undefined;
  if (!(c.axis === 0 || c.axis === 1 || c.axis === 2 || c.axis === "free")) return undefined;
  if (!Array.isArray(n) || n.length !== 3 || !n.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  if (typeof c.t !== "number" || !Number.isFinite(c.t)) return undefined;
  return clonePaneClipState({ active: c.active, axis: c.axis, flipped: c.flipped, freeNormal: [n[0], n[1], n[2]], t: Math.min(1, Math.max(0, c.t)) });
}

export function validateCameraPayload(raw: unknown): CameraState | undefined {
  return isCameraState(raw)
    ? {
        position: [...raw.position] as CameraState["position"],
        focalPoint: [...raw.focalPoint] as CameraState["focalPoint"],
        viewUp: [...raw.viewUp] as CameraState["viewUp"],
        parallelScale: raw.parallelScale,
      }
    : undefined;
}

// --- Saved identity ----------------------------------------------------------

/** The compared runs a view was saved with: peers by path relative to this mesh's folder, forward slashes. */
export interface SavedLink {
  peers: string[];
  settings: LinkSettings;
}

export function validateSavedLink(raw: unknown): { link: SavedLink | undefined; warnings: string[] } {
  if (raw === undefined) return { link: undefined, warnings: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { link: undefined, warnings: ["View sidecar link is malformed — ignored."] };
  const r = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const peers: string[] = [];
  if (Array.isArray(r.peers)) {
    for (const p of r.peers.slice(0, 8)) {
      if (typeof p === "string" && p.length > 0 && p.length < 1024) peers.push(p);
      else warnings.push("View sidecar link has an invalid peer path — dropped.");
    }
  } else warnings.push("View sidecar link peers are not an array — ignored.");
  if (peers.length === 0) return { link: undefined, warnings };
  return { link: { peers, settings: validateLinkSettings(r.settings) }, warnings };
}

/** One line for the panel: "Linked with a.vtu, b.vtu — camera, field, time". */
export function describeLink(peerNames: readonly string[], s: LinkSettings): string {
  if (peerNames.length === 0) return "Not linked.";
  const on = LINK_KINDS.filter((k) => s[k]);
  return `Linked with ${peerNames.join(", ")} — ${on.length ? on.join(", ") : "nothing is shared"}.`;
}
