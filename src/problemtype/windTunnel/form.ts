/**
 * The wizard's form: what the user typed, as text, and the one function that
 * turns it into a request (or says which field is wrong).
 *
 * Text rather than numbers so a half-typed value survives a re-render, the
 * convention `flowBalanceForm.ts` set; `webview/` is untestable under
 * `node:test`, so every decision lives here. Pure: no vscode, no DOM.
 */

import type { WindTunnelParams } from "./plan";
import type { GroundMode } from "./domain";

export interface WindTunnelForm {
  bodyPath: string;
  unit: string;
  rotation: [string, string, string];
  // Tunnel
  upstream: string;
  downstream: string;
  side: string;
  top: string;
  bottom: string;
  ground: GroundMode;
  clearance: string;
  halfModel: boolean;
  // Flow
  speed: string;
  density: string;
  viscosity: string;
  turbulenceIntensity: string;
  // Mesh
  mode: "bodyFitted" | "embedded";
  surfaceSize: string;
  farSize: string;
  yPlus: string;
  firstHeight: string;
  growth: string;
  maxAspect: string;
  wakeLength: string;
  wakeSize: string;
  fit: string;
  // Output
  outputFolder: string;
  stem: string;
  generateCase: boolean;
  overwrite: boolean;
}

export function defaultWindTunnelForm(): WindTunnelForm {
  return {
    bodyPath: "",
    unit: "m",
    rotation: ["0", "0", "0"],
    upstream: "",
    downstream: "",
    side: "",
    top: "",
    bottom: "",
    ground: "free",
    clearance: "",
    halfModel: false,
    speed: "30",
    density: "",
    viscosity: "",
    turbulenceIntensity: "",
    mode: "bodyFitted",
    surfaceSize: "",
    farSize: "",
    yPlus: "",
    firstHeight: "",
    growth: "",
    maxAspect: "",
    wakeLength: "",
    wakeSize: "",
    fit: "",
    outputFolder: "",
    stem: "tunnel",
    generateCase: true,
    overwrite: false,
  };
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string; field?: keyof WindTunnelForm };

/** The request the tools and the host take: the plan inputs, plus the output choice. */
export interface WindTunnelFormRequest extends WindTunnelParams {
  bodyPath: string;
  outputFolder: string;
  stem: string;
  overwrite: boolean;
  generateCase: boolean;
}

const LABELS: Partial<Record<keyof WindTunnelForm, string>> = {
  speed: "Speed",
  density: "Density",
  viscosity: "Viscosity",
  turbulenceIntensity: "Turbulence intensity",
  upstream: "Upstream distance",
  downstream: "Downstream distance",
  side: "Side distance",
  top: "Top distance",
  bottom: "Bottom distance",
  clearance: "Ground clearance",
  surfaceSize: "Surface size",
  farSize: "Far size",
  yPlus: "Target y+",
  firstHeight: "First height",
  growth: "Growth ratio",
  maxAspect: "Maximum aspect ratio",
  wakeLength: "Wake length",
  wakeSize: "Wake size",
  fit: "Surface fit",
};

/** Parses an optional number; empty means "use the default". Without `min` the value must be above zero. */
function optional(form: WindTunnelForm, key: keyof WindTunnelForm, opts: { min?: number } = {}): FormResult<number | undefined> {
  const raw = String(form[key] ?? "").trim();
  if (raw === "") return { ok: true, value: undefined };
  const v = Number(raw);
  const label = LABELS[key] ?? String(key);
  if (!Number.isFinite(v)) return { ok: false, error: `${label} is not a number.`, field: key };
  if (opts.min === undefined ? !(v > 0) : v < opts.min) {
    return { ok: false, error: opts.min === undefined ? `${label} must be above zero.` : `${label} cannot be below ${opts.min}.`, field: key };
  }
  return { ok: true, value: v };
}

export function buildWindTunnelRequest(form: WindTunnelForm): FormResult<WindTunnelFormRequest> {
  if (!form.bodyPath.trim()) return { ok: false, error: "Choose the body surface (an STL, OBJ or PLY file).", field: "bodyPath" };
  const speed = Number(form.speed);
  if (!Number.isFinite(speed) || !(speed > 0)) return { ok: false, error: "Speed must be a number above zero.", field: "speed" };

  const num: Partial<Record<keyof WindTunnelForm, number | undefined>> = {};
  const specs: [keyof WindTunnelForm, { min?: number }][] = [
    ["density", {}], ["viscosity", {}], ["upstream", {}], ["downstream", {}], ["side", {}], ["top", {}], ["bottom", {}],
    ["clearance", { min: 0 }], ["surfaceSize", {}], ["farSize", {}], ["yPlus", {}], ["firstHeight", {}], ["growth", { min: 1 }],
    ["maxAspect", { min: 1 }], ["wakeLength", { min: 0 }], ["wakeSize", {}], ["fit", {}],
  ];
  for (const [key, opts] of specs) {
    const r = optional(form, key, opts);
    if (!r.ok) return r;
    num[key] = r.value;
  }
  const ti = String(form.turbulenceIntensity).trim();
  let turbulenceIntensity: number | undefined;
  if (ti !== "") {
    turbulenceIntensity = Number(ti);
    if (!Number.isFinite(turbulenceIntensity) || turbulenceIntensity < 0 || turbulenceIntensity > 1) {
      return { ok: false, error: "Turbulence intensity is a fraction between 0 and 1 (0.01 = 1%).", field: "turbulenceIntensity" };
    }
  }
  const rotation = form.rotation.map((r) => (r.trim() === "" ? 0 : Number(r)));
  if (rotation.some((r) => !Number.isFinite(r))) return { ok: false, error: "The rotation angles must be numbers in degrees.", field: "rotation" };
  const unitText = form.unit.trim();
  const unit: string | number | undefined = unitText === "" ? undefined : /^[0-9.eE+-]+$/.test(unitText) ? Number(unitText) : unitText;
  if (typeof unit === "number" && !(unit > 0)) return { ok: false, error: "A unit given as a number is metres per unit and must be above zero.", field: "unit" };
  if (!form.outputFolder.trim()) return { ok: false, error: "Choose the folder the mesh and case are written to.", field: "outputFolder" };
  const stem = form.stem.trim().replace(/[^A-Za-z0-9_.-]/g, "_") || "tunnel";

  const tunnel: NonNullable<WindTunnelParams["tunnel"]> = { ground: form.ground, halfModel: form.halfModel };
  for (const k of ["upstream", "downstream", "side", "top", "bottom", "clearance"] as const) {
    const v = num[k];
    if (v !== undefined) tunnel[k] = v;
  }
  const mesh: NonNullable<WindTunnelParams["mesh"]> = { mode: form.mode };
  for (const k of ["surfaceSize", "farSize", "yPlus", "firstHeight", "growth", "maxAspect", "wakeLength", "wakeSize", "fit"] as const) {
    const v = num[k];
    if (v !== undefined) mesh[k] = v;
  }
  return {
    ok: true,
    value: {
      bodyPath: form.bodyPath.trim(),
      unit,
      rotation: rotation as [number, number, number],
      tunnel,
      flow: {
        speed,
        ...(num.density !== undefined ? { density: num.density } : {}),
        ...(num.viscosity !== undefined ? { viscosity: num.viscosity } : {}),
        ...(turbulenceIntensity !== undefined ? { turbulenceIntensity } : {}),
      },
      mesh,
      outputFolder: form.outputFolder.trim(),
      stem,
      overwrite: form.overwrite,
      generateCase: form.generateCase,
    },
  };
}

/** The same request without the output choice: what a plan needs (the output is irrelevant to it). */
export function planRequestOf(form: WindTunnelForm): FormResult<WindTunnelParams & { bodyPath: string }> {
  const r = buildWindTunnelRequest({ ...form, outputFolder: form.outputFolder.trim() || "-" });
  if (!r.ok) return r;
  const { outputFolder: _o, stem: _s, overwrite: _w, generateCase: _g, ...rest } = r.value;
  void _o; void _s; void _w; void _g;
  return { ok: true, value: rest };
}

/** The steps of the wizard, in order, with the one-line promise each makes. */
export const WIZARD_STEPS: { id: "body" | "tunnel" | "flow" | "mesh" | "review"; label: string; hint: string }[] = [
  { id: "body", label: "Body", hint: "The surface to test, its unit and how it sits in the tunnel." },
  { id: "tunnel", label: "Tunnel", hint: "How far the walls are and what the floor is." },
  { id: "flow", label: "Flow", hint: "Speed and fluid." },
  { id: "mesh", label: "Mesh", hint: "Cell sizes and the boundary layer." },
  { id: "review", label: "Generate", hint: "Check the plan, then build the mesh and the case." },
];
