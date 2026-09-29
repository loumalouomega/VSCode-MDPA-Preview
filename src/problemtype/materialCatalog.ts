/**
 * Material presets: a small, searchable, user-extensible catalog of parameter
 * values a Kratos constitutive law can be filled from, each carrying its units,
 * reference conditions and source.
 *
 * Pure module (no vscode / DOM / node:*), so all three consumers share it: the
 * webview applies a preset from the Materials form, the case generator refuses a
 * case whose values cannot mean anything, and the MCP server lists and applies
 * presets headlessly. The file-system half (discovering `.kratos/materials/`)
 * lives in `materialLibrary.ts` for the same reason `caseFile.ts` keeps
 * `node:path` out of the webview bundle.
 *
 * Two rules the rest of the extension relies on:
 *
 *  - **A preset is a set of values, not a law.** It names the laws it fits
 *    (`laws`); the law still decides which variables exist, in which units, and
 *    which `constitutive_law` block Kratos gets. Swapping a law never reinterprets
 *    a preset's numbers.
 *  - **An applied preset is a snapshot.** The resolved values are copied into the
 *    case state, so updating the library cannot rewrite a past case and editing a
 *    case never writes back to the library.
 */

import type { FieldSpec, JsonValue, MaterialLawSpec } from "./types";

// --- units --------------------------------------------------------------------

/** What a number counts, so two unit strings can be checked for compatibility. */
export type Quantity =
  | "dimensionless"
  | "density"
  | "length"
  | "time"
  | "mass"
  | "force"
  | "stress"
  | "dynamicViscosity"
  | "kinematicViscosity"
  | "thermalConductivity"
  | "specificHeat";

/**
 * Units per quantity, keyed by an exact spelling, with the factor that converts
 * one unit to the quantity's canonical one. **Factors only, never offsets** —
 * an affine unit (°C, °F) therefore does not belong here, and adding one would
 * silently produce a wrong value. `°C` is deliberately absent: the only
 * temperature in this data model is `reference.temperature`, which is an
 * annotation shown to the user and never converted.
 *
 * `stress` covers both pressure and stiffness modulus (Young's modulus), which
 * share the pascal and are what Kratos's material variables are declared in.
 */
const UNITS: Record<Quantity, { canonical: string; factors: Record<string, number> }> = {
  dimensionless: { canonical: "", factors: { "": 1, "1": 1 } },
  density: {
    canonical: "kg/m³",
    factors: { "kg/m³": 1, "g/cm³": 1000, "g/L": 1, "kg/L": 1000, "lb/ft³": 16.018463373960142 },
  },
  length: { canonical: "m", factors: { m: 1, mm: 1e-3, cm: 1e-2, km: 1000, in: 0.0254, ft: 0.3048 } },
  time: { canonical: "s", factors: { s: 1, ms: 1e-3, min: 60, h: 3600 } },
  mass: { canonical: "kg", factors: { kg: 1, g: 1e-3, t: 1000 } },
  force: { canonical: "N", factors: { N: 1, kN: 1e3, MN: 1e6 } },
  stress: {
    canonical: "Pa",
    factors: { Pa: 1, kPa: 1e3, MPa: 1e6, GPa: 1e9, bar: 1e5, psi: 6894.757293168361, ksi: 6894757.293168361 },
  },
  dynamicViscosity: {
    canonical: "Pa·s",
    factors: { "Pa·s": 1, "Pa s": 1, "mPa·s": 1e-3, cP: 1e-3, P: 0.1 },
  },
  kinematicViscosity: {
    canonical: "m²/s",
    factors: { "m²/s": 1, "m^2/s": 1, "mm²/s": 1e-6, cSt: 1e-6, St: 1e-4, "ft²/s": 0.09290304 },
  },
  thermalConductivity: { canonical: "W/(m·K)", factors: { "W/(m·K)": 1, "W/mK": 1, "W/(m K)": 1, "mW/(m·K)": 1e-3 } },
  specificHeat: { canonical: "J/(kg·K)", factors: { "J/(kg·K)": 1, "J/kgK": 1, "kJ/(kg·K)": 1e3 } },
};

/**
 * Kratos material-variable ids whose unit is known even when the declaration
 * does not spell one out. This is the fallback behind `FieldSpec.unit`; a
 * problemtype that declares its own units never depends on it.
 */
const KNOWN_VARIABLE_UNITS: Record<string, string> = {
  DENSITY: "kg/m³",
  DYNAMIC_VISCOSITY: "Pa·s",
  KINEMATIC_VISCOSITY: "m²/s",
  YOUNG_MODULUS: "Pa",
  BULK_MODULUS: "Pa",
  SHEAR_MODULUS: "Pa",
  THICKNESS: "m",
  CONDUCTIVITY: "W/(m·K)",
  THERMAL_CONDUCTIVITY: "W/(m·K)",
  SPECIFIC_HEAT: "J/(kg·K)",
  HEAT_CAPACITY: "J/(kg·K)",
};

/** Trims and collapses the whitespace a copied unit string tends to carry. */
function normalizeUnit(unit: string): string {
  return unit.trim().replace(/\s+/g, " ");
}

/** The quantity a unit belongs to, or undefined when this table cannot place it. */
export function quantityOf(unit: string | undefined): Quantity | undefined {
  if (unit === undefined) return undefined;
  const key = normalizeUnit(unit);
  for (const [quantity, table] of Object.entries(UNITS)) {
    if (Object.prototype.hasOwnProperty.call(table.factors, key)) return quantity as Quantity;
  }
  return undefined;
}

/** The unit one value of this quantity is written in. */
export function canonicalUnit(quantity: Quantity): string {
  return UNITS[quantity].canonical;
}

/**
 * A field's unit: what the declaration says, else the bracket in its label
 * (`"Density [kg/m³]"`), else the well-known Kratos variable id, else unknown.
 * Unknown is a real answer, not a fallback to "no unit" — see `convertQuantity`.
 */
export function unitOfField(field: FieldSpec): string | undefined {
  if (typeof field.unit === "string") return normalizeUnit(field.unit);
  const bracketed = /\[([^\]]+)\]/.exec(field.label ?? "");
  if (bracketed) return normalizeUnit(bracketed[1]);
  return KNOWN_VARIABLE_UNITS[field.id];
}

export type Conversion =
  | { ok: true; value: number; factor: number; from: string; to: string }
  | { ok: false; reason: string };

/**
 * Converts one value between two unit strings.
 *
 * The conservative cases are deliberate. When either side's unit is unknown this
 * refuses rather than passing the number through: a preset quoted in "kg/m³"
 * must not land in a variable whose declaration says nothing about units, and
 * the reverse is worse. A refusal names the missing or mismatched side so the
 * picker can say which entry to fix.
 */
export function convertQuantity(value: number, from: string | undefined, to: string | undefined): Conversion {
  if (!Number.isFinite(value)) return { ok: false, reason: "is not a finite number" };
  const source = from === undefined ? undefined : normalizeUnit(from);
  const target = to === undefined ? undefined : normalizeUnit(to);
  if (source === undefined || target === undefined) {
    if (source === target) return { ok: true, value, factor: 1, from: "", to: "" };
    const missing = source === undefined ? "the preset value's" : "the material variable's";
    return { ok: false, reason: `cannot be converted — ${missing} unit is not declared` };
  }
  if (source === target) return { ok: true, value, factor: 1, from: source, to: target };
  const quantity = quantityOf(source);
  if (quantity === undefined) return { ok: false, reason: `has unknown unit "${source}"` };
  if (quantityOf(target) !== quantity) {
    return { ok: false, reason: `is a ${quantity} ("${source}") but the variable wants "${target}"` };
  }
  const factors = UNITS[quantity].factors;
  if (factors[target] === undefined) return { ok: false, reason: `has unit "${target}", which is not a known ${quantity}` };
  const factor = factors[source] / factors[target];
  return { ok: true, value: value * factor, factor, from: source, to: target };
}

// --- the catalog --------------------------------------------------------------

export interface MaterialReference {
  temperature?: number;
  temperatureUnit?: "C" | "K";
  pressure?: number;
  pressureUnit?: string;
  note?: string;
}

export interface MaterialSource {
  name: string;
  version?: string;
  url?: string;
  note?: string;
}

/** One catalog row: named, sourced, unit-declared parameter values. */
export interface MaterialPreset {
  id: string;
  name: string;
  /** Law ids these values can fill. A law not listed here cannot consume them. */
  laws: string[];
  /** Values by material-variable id, in `units` (canonical where undeclared). */
  values: Record<string, JsonValue>;
  /** Per-value unit; an undeclared value is read in its variable's canonical unit. */
  units?: Record<string, string>;
  reference?: MaterialReference;
  source: MaterialSource;
  /** The author's own revision counter, so a case can say what it copied. */
  version?: string;
  origin: "builtin" | "user";
  /** The library file a user preset came from, for actionable messages. */
  file?: string;
  /** Why an entry was rejected while parsing a library file. */
  error?: string;
}

/** What a case keeps after applying a preset: the values, frozen. */
export interface MaterialPresetSnapshot {
  id: string;
  name: string;
  /**
   * The laws the row declared compatibility with, kept so a hand-edited case
   * pairing a fluid snapshot with a structural law is still detectable.
   */
  laws: string[];
  version?: string;
  origin: "builtin" | "user";
  source: MaterialSource;
  reference?: MaterialReference;
  /** The resolved values this case uses, copied at apply time. */
  values: Record<string, JsonValue>;
}

/**
 * Ships with the extension. Both rows are quoted as density + kinematic
 * viscosity and deliberately carry no dynamic viscosity: `μ = ρ·ν` is then the
 * only route to `DYNAMIC_VISCOSITY`, which is exactly the conversion a catalog
 * exists to get right. Values are the conventional engineering properties at
 * the stated reference conditions, not measurements of the user's case.
 */
export const BUILTIN_PRESETS: MaterialPreset[] = [
  {
    id: "water-liquid-20c",
    name: "Water (liquid, 20 °C)",
    laws: ["newtonian_3d", "newtonian_2d"],
    values: { DENSITY: 998.2, KINEMATIC_VISCOSITY: 1.004e-6 },
    units: { DENSITY: "kg/m³", KINEMATIC_VISCOSITY: "m²/s" },
    reference: {
      temperature: 20,
      temperatureUnit: "C",
      pressure: 101325,
      pressureUnit: "Pa",
      note: "Pure water at atmospheric pressure. Density from the industrial formulation; viscosity from the IAPWS release, which reproduces the ISO value at 20 °C.",
    },
    source: {
      name: "IAPWS R7-97 (IF97) and IAPWS R12-08 (viscosity of ordinary water substance)",
      version: "1997 / 2008",
      url: "https://iapws.org/public/documents/",
      note: "A published property at one reference state — not a guarantee for your operating range.",
    },
    origin: "builtin",
  },
  {
    id: "air-dry-20c-1atm",
    name: "Air (dry, 20 °C, 1 atm)",
    laws: ["newtonian_3d", "newtonian_2d"],
    values: { DENSITY: 1.2041, KINEMATIC_VISCOSITY: 1.516e-5 },
    units: { DENSITY: "kg/m³", KINEMATIC_VISCOSITY: "m²/s" },
    reference: {
      temperature: 20,
      temperatureUnit: "C",
      pressure: 101325,
      pressureUnit: "Pa",
      note: "Dry air at standard atmospheric pressure. Gas properties scale with absolute pressure and temperature, so these are 1 atm figures only.",
    },
    source: {
      name: "CRC Handbook of Chemistry and Physics — physical constants of dry air",
      version: "97th edition",
      note: "A published property at one reference state — not a guarantee for your operating range.",
    },
    origin: "builtin",
  },
];

/** The unit a preset's value for `id` is written in. */
function presetUnit(preset: MaterialPreset, id: string): string | undefined {
  const declared = preset.units?.[id];
  if (typeof declared === "string") return declared;
  const known = KNOWN_VARIABLE_UNITS[id];
  if (known === undefined) return undefined;
  return canonicalUnit(quantityOf(known) ?? "dimensionless");
}

/** True when the law is one this preset declares itself compatible with. */
export function presetFitsLaw(preset: { laws: string[] }, lawId: string): boolean {
  return preset.laws.length === 0 || preset.laws.includes(lawId);
}

/** Catalog rows a law can consume, best match first. */
export function presetsForLaw(presets: MaterialPreset[], lawId: string): MaterialPreset[] {
  return presets.filter((p) => !p.error && presetFitsLaw(p, lawId));
}

/**
 * The row an id or name resolves to when a preset is APPLIED — the LAST match,
 * so a workspace file that reuses a shipped id wins over it. The list itself
 * still shows both (a user file carries `file`, a shipped row does not), so the
 * override is visible rather than silent.
 */
export function findPreset(presets: MaterialPreset[], key: string): MaterialPreset | undefined {
  let found: MaterialPreset | undefined;
  for (const preset of presets) {
    if (preset.error) continue;
    if (preset.id === key || preset.name === key) found = preset;
  }
  return found;
}

export interface PresetApplication {
  /** The values to write into the material assignment. */
  values: Record<string, JsonValue>;
  conversions: { variable: string; from: string; to: string; factor: number }[];
  derived: { variable: string; formula: string; inputs: { id: string; value: number }[] }[];
  problems: string[];
}

/**
 * Resolves a preset against one law.
 *
 * Direct values win; only what a preset does not carry is derived. The
 * derivation reads the preset's OWN numbers (falling back to the row's density
 * for a kinematic-only preset) and writes the result under the target
 * variable's own key, so applying the same preset again replaces the value
 * rather than compounding it — the `μ = ρ·ν` happens exactly once per
 * application, whatever the row held before.
 */
export function resolvePresetValues(
  law: MaterialLawSpec,
  preset: MaterialPreset,
  current: Record<string, JsonValue> = {}
): PresetApplication {
  const values: Record<string, JsonValue> = { ...current };
  const conversions: PresetApplication["conversions"] = [];
  const derived: PresetApplication["derived"] = [];
  const problems: string[] = [];

  if (!presetFitsLaw(preset, law.id)) {
    problems.push(
      `preset "${preset.name}" does not declare compatibility with law "${law.name || law.id}"`
    );
    return { values, conversions, derived, problems };
  }

  const isNumber = (v: JsonValue | undefined): v is number => typeof v === "number" && Number.isFinite(v);

  // Pass 1 — every value the preset carries directly, converted into the law's unit.
  // `direct` is what pass 2 keys off, NOT whether the row already held the value:
  // re-applying a preset that quotes ν must replace the row's μ, not defer to it.
  const direct = new Set<string>();
  for (const field of law.variables) {
    const raw = preset.values[field.id];
    if (typeof raw !== "number") {
      if (raw !== undefined) {
        problems.push(`${preset.name}: ${field.id} is not a number in the preset`);
      }
      continue;
    }
    const converted = convertQuantity(raw, presetUnit(preset, field.id), unitOfField(field));
    if (!converted.ok) {
      problems.push(`${preset.name}: ${field.id} ${converted.reason}`);
      continue;
    }
    values[field.id] = converted.value;
    direct.add(field.id);
    if (converted.factor !== 1) {
      conversions.push({ variable: field.id, from: converted.from, to: converted.to, factor: converted.factor });
    }
  }

  // Pass 2 — derive what the law asks for and the preset only implies.
  const canonical = (id: string): number | undefined => {
    const raw = preset.values[id];
    if (!isNumber(raw)) return undefined;
    const unit = presetUnit(preset, id);
    const quantity = quantityOf(unit) ?? quantityOf(KNOWN_VARIABLE_UNITS[id]);
    if (quantity === undefined) return raw;
    const converted = convertQuantity(raw, unit, canonicalUnit(quantity));
    return converted.ok ? converted.value : undefined;
  };
  const rho = canonical("DENSITY") ?? (isNumber(current.DENSITY) ? current.DENSITY : undefined);
  const nu = canonical("KINEMATIC_VISCOSITY");
  const mu = canonical("DYNAMIC_VISCOSITY");

  for (const field of law.variables) {
    if (direct.has(field.id)) continue; // the preset quoted it; nothing to derive
    const wants = field.id === "DYNAMIC_VISCOSITY" || quantityOf(unitOfField(field)) === "dynamicViscosity";
    if (wants && mu !== undefined && rho !== undefined) {
      values[field.id] = mu;
      continue;
    }
    if (wants && nu !== undefined && rho !== undefined) {
      values[field.id] = rho * nu;
      derived.push({
        variable: field.id,
        formula: `${field.id} = DENSITY * KINEMATIC_VISCOSITY`,
        inputs: [
          { id: "DENSITY", value: rho },
          { id: "KINEMATIC_VISCOSITY", value: nu },
        ],
      });
      continue;
    }
    if (wants && (nu !== undefined || mu !== undefined)) {
      problems.push(
        `${preset.name}: ${field.id} needs a density to convert from ${nu !== undefined ? "kinematic" : "dynamic"} viscosity, and neither the preset nor this material has one`
      );
      continue;
    }
    const wantsKinematic =
      field.id === "KINEMATIC_VISCOSITY" || quantityOf(unitOfField(field)) === "kinematicViscosity";
    if (wantsKinematic && mu !== undefined && rho !== undefined) {
      values[field.id] = mu / rho;
      derived.push({
        variable: field.id,
        formula: `${field.id} = DYNAMIC_VISCOSITY / DENSITY`,
        inputs: [
          { id: "DYNAMIC_VISCOSITY", value: mu },
          { id: "DENSITY", value: rho },
        ],
      });
    }
  }

  return { values, conversions, derived, problems };
}

// --- validation ---------------------------------------------------------------

export interface MaterialIssue {
  severity: "error" | "warning";
  message: string;
  variable?: string;
}

/** Quantities that have no meaning at or below zero, so a wrong sign is a bug. */
const POSITIVE: ReadonlySet<Quantity> = new Set<Quantity>([
  "density",
  "dynamicViscosity",
  "kinematicViscosity",
  "stress",
]);

/**
 * The one rulebook for a material assignment. The webview row, `case_validate`
 * and the generator all call this, so a value the sidebar flags is exactly a
 * value generation refuses.
 */
export function validateMaterialAssignment(
  law: MaterialLawSpec,
  values: Record<string, JsonValue>,
  preset?: MaterialPresetSnapshot | MaterialPreset
): MaterialIssue[] {
  const issues: MaterialIssue[] = [];
  if (preset && !presetFitsLaw(preset, law.id)) {
    issues.push({
      severity: "error",
      message: `the preset "${preset.name}" is not compatible with the law "${law.name || law.id}"`,
    });
  }
  for (const field of law.variables) {
    const value = values[field.id];
    if (value === undefined) continue;
    if (field.type !== "number" && field.type !== "int") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({
        severity: "error",
        variable: field.id,
        message: `${field.label} is not a finite number`,
      });
      continue;
    }
    const quantity = quantityOf(unitOfField(field));
    if (quantity !== undefined && POSITIVE.has(quantity) && value <= 0) {
      issues.push({
        severity: "error",
        variable: field.id,
        message: `${field.label} must be greater than zero (got ${value})`,
      });
    }
    if (field.id === "POISSON_RATIO" && (value <= -1 || value >= 0.5)) {
      issues.push({
        severity: "warning",
        variable: field.id,
        message: `${field.label} of ${value} is outside the physically admissible range (-1, 0.5)`,
      });
    }
  }
  return issues;
}

// --- library files ------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads one library file tolerantly, like the case-file reader: a rejected
 * entry is reported and skipped, never fatal, because one hand-written row
 * must not hide the rest of a user's library.
 */
export function parsePresetFile(text: string, file?: string): { presets: MaterialPreset[]; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { presets: [], warnings: [`${file ?? "preset file"} is not valid JSON — ignored.`] };
  }
  const entries = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.presets) ? raw.presets : [raw];
  if (entries.length === 0) return { presets: [], warnings: [`${file ?? "preset file"} has no presets.`] };
  const presets: MaterialPreset[] = [];
  entries.forEach((entry, index) => {
    const where = `${file ? `${file} ` : ""}entry ${index + 1}`;
    if (!isRecord(entry)) {
      warnings.push(`${where}: not an object — ignored.`);
      return;
    }
    const problem = describePresetProblem(entry);
    if (problem) {
      warnings.push(`${where}: ${problem}`);
      return;
    }
    presets.push({
      id: String(entry.id),
      name: String(entry.name ?? entry.id),
      laws: Array.isArray(entry.laws) ? entry.laws.filter((l): l is string => typeof l === "string") : [],
      values: entry.values as Record<string, JsonValue>,
      ...(isRecord(entry.units) ? { units: entry.units as Record<string, string> } : {}),
      ...(isRecord(entry.reference) ? { reference: entry.reference as unknown as MaterialReference } : {}),
      source: entry.source as MaterialSource,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      origin: "user",
      ...(file ? { file } : {}),
    });
  });
  return { presets, warnings };
}

/** Returns why an entry is unusable, or undefined when it is fine. */
function describePresetProblem(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.id !== "string" || entry.id.length === 0) return "has no id.";
  if (!isRecord(entry.source) || typeof entry.source.name !== "string" || entry.source.name.length === 0) {
    return "has no source.name — a preset without a source is not a citation.";
  }
  if (!isRecord(entry.values)) return "has no values object.";
  for (const [id, value] of Object.entries(entry.values)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `value ${id} is not a finite number.`;
    }
  }
  if (entry.units !== undefined) {
    if (!isRecord(entry.units)) return "has a units value that is not an object.";
    for (const [id, unit] of Object.entries(entry.units)) {
      if (typeof unit !== "string") return `unit for ${id} is not a string.`;
    }
  }
  if (entry.laws !== undefined && !Array.isArray(entry.laws)) return "has a laws value that is not an array.";
  return undefined;
}

/** The canonical on-disk form: one object, an explicit schema version, the rows. */
export function serializePresetFile(presets: MaterialPreset[]): string {
  const document = {
    version: 1,
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      laws: p.laws,
      values: p.values,
      ...(p.units ? { units: p.units } : {}),
      ...(p.reference ? { reference: p.reference } : {}),
      source: p.source,
      ...(p.version ? { version: p.version } : {}),
    })),
  };
  return JSON.stringify(document, null, 2) + "\n";
}

/** The snapshot a case keeps when a preset is applied to one of its materials. */
export function snapshotOf(preset: MaterialPreset, values: Record<string, JsonValue>): MaterialPresetSnapshot {
  return {
    id: preset.id,
    name: preset.name,
    laws: [...preset.laws],
    ...(preset.version ? { version: preset.version } : {}),
    origin: preset.origin,
    source: { ...preset.source },
    ...(preset.reference ? { reference: { ...preset.reference } } : {}),
    values: { ...values },
  };
}

/**
 * What changed in the library since a case took its snapshot. `undefined` means
 * "still identical", so a re-apply is offered only when there is something to
 * re-apply — and never happens on its own.
 */
export function presetDrift(
  snapshot: MaterialPresetSnapshot,
  current: MaterialPreset | undefined,
  law: MaterialLawSpec
): { variables: string[]; values: Record<string, JsonValue> } | undefined {
  if (!current) return { variables: [], values: { ...snapshot.values } };
  const resolved = resolvePresetValues(law, current, {});
  const variables = law.variables
    .map((f) => f.id)
    .filter((id) => {
      const before = snapshot.values[id];
      const after = resolved.values[id];
      if (typeof before !== "number" || typeof after !== "number") return before !== after;
      const scale = Math.max(Math.abs(before), Math.abs(after));
      return scale > 0 ? Math.abs(before - after) / scale > 1e-9 : before !== after;
    });
  return variables.length > 0 ? { variables, values: resolved.values } : undefined;
}

/** One line describing a preset's reference conditions, for a picker row. */
export function describeReference(reference: MaterialReference | undefined): string | undefined {
  if (!reference) return undefined;
  const parts: string[] = [];
  if (typeof reference.temperature === "number") {
    parts.push(`${reference.temperature} °${reference.temperatureUnit ?? "C"}`);
  }
  if (typeof reference.pressure === "number") {
    const unit = reference.pressureUnit ?? "Pa";
    parts.push(unit === "Pa" ? `${(reference.pressure / 1000).toLocaleString("en-US")} kPa` : `${reference.pressure} ${unit}`);
  }
  if (reference.note) parts.push(reference.note);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
