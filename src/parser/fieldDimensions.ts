/**
 * Physical dimensions of a field (roadmap item 12) — pure, no `vscode`/DOM/fs, bundled into
 * both runtimes.
 *
 * A field either KNOWS its dimensions (`FieldData.dimensions` is set — today only an OpenFOAM
 * field file states them, as its seven-exponent `dimensions [..]` vector) or it does not
 * (absent). Absent means UNKNOWN, never "dimensionless": a Kratos `PRESSURE` is in Pa by the
 * problemtype's own convention but nothing in the file says so, and a field named `p` is not
 * evidence of pressure. Nothing here infers a dimension from a name.
 */
import type { FieldData, FieldDimensions } from "./types";

/** OpenFOAM's exponent order: kg, m, s, K, mol, A, cd. */
export type DimensionExponents = readonly number[];

export const DIMENSION_COUNT = 7;
export const DIMENSIONLESS: DimensionExponents = [0, 0, 0, 0, 0, 0, 0];
/** Pa = kg m^-1 s^-2. */
export const PRESSURE: DimensionExponents = [1, -1, -2, 0, 0, 0, 0];
/** Kinematic pressure p/rho, m^2 s^-2 (the OpenFOAM incompressible solvers' `p`). */
export const KINEMATIC_PRESSURE: DimensionExponents = [0, 2, -2, 0, 0, 0, 0];

/**
 * Normalizes an exponent list to seven finite numbers. OpenFOAM writes 5 (no mol/cd) or 7
 * entries; a shorter or longer list, or a non-finite entry, is not a dimension set.
 */
export function normalizeExponents(raw: readonly number[]): number[] | undefined {
  if (raw.length !== 5 && raw.length !== DIMENSION_COUNT) return undefined;
  if (!raw.every(Number.isFinite)) return undefined;
  const out = raw.slice();
  while (out.length < DIMENSION_COUNT) out.push(0);
  return out;
}

export function dimensionsEqual(a: DimensionExponents, b: DimensionExponents): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  }
  return true;
}

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", ".": "·",
};

function superscript(n: number): string {
  return String(n).split("").map((c) => SUPERSCRIPT[c] ?? c).join("");
}

const BASE_UNITS = ["kg", "m", "s", "K", "mol", "A", "cd"] as const;

/** Named combinations worth a short label; everything else is written as an SI product. */
const NAMED: { exps: DimensionExponents; label: string }[] = [
  { exps: PRESSURE, label: "Pa" },
  { exps: KINEMATIC_PRESSURE, label: "m²/s²" },
  { exps: [0, 1, -1, 0, 0, 0, 0], label: "m/s" },
  { exps: [0, 1, 0, 0, 0, 0, 0], label: "m" },
  { exps: [0, 0, 0, 1, 0, 0, 0], label: "K" },
  { exps: [1, -3, 0, 0, 0, 0, 0], label: "kg/m³" },
  { exps: [1, -1, -1, 0, 0, 0, 0], label: "Pa·s" },
  { exps: [0, 2, -1, 0, 0, 0, 0], label: "m²/s" },
];

/** Short human label for an exponent vector: `Pa`, `m²/s²`, `kg·m⁻¹·s⁻²`, or `1` when dimensionless. */
export function describeExponents(exps: DimensionExponents): string {
  if (dimensionsEqual(exps, DIMENSIONLESS)) return "1";
  const named = NAMED.find((n) => dimensionsEqual(n.exps, exps));
  if (named) return named.label;
  const parts: string[] = [];
  for (let i = 0; i < Math.min(exps.length, BASE_UNITS.length); i++) {
    const e = exps[i];
    if (e === 0) continue;
    parts.push(e === 1 ? BASE_UNITS[i] : `${BASE_UNITS[i]}${superscript(e)}`);
  }
  return parts.join("·");
}

/** The unit text for a field, or `undefined` when its dimensions are unknown. */
export function fieldUnitLabel(field: Pick<FieldData, "dimensions">): string | undefined {
  const d = field.dimensions;
  if (!d) return undefined;
  return describeExponents(d.exponents);
}

/** `p [m²/s²]` — the variable with its unit when known, the bare name otherwise. */
export function labelWithUnit(field: Pick<FieldData, "variable" | "dimensions">): string {
  const unit = fieldUnitLabel(field);
  return unit ? `${field.variable} [${unit}]` : field.variable;
}

/** Copies the dimension metadata of `from` onto a rebuilt field literal (the "carry" rule). */
export function carryFieldMeta<T extends Partial<FieldData>>(
  from: Pick<FieldData, "dimensions"> | undefined,
  to: T
): T {
  if (from?.dimensions) to.dimensions = from.dimensions;
  return to;
}

export type DimensionCheck =
  | { status: "ok" }
  | { status: "unverified"; note: string }
  | { status: "mismatch"; a: string; b: string; message: string };

/**
 * Whether two fields may be subtracted/compared. Both known and different is a refusal that
 * points at the explicit conversion; one side unknown proceeds with a note (the extension
 * cannot know, so it says so rather than refusing every Kratos comparison); both unknown is
 * the ordinary case and needs no remark.
 */
export function checkCompatible(
  a: Pick<FieldData, "variable" | "dimensions">,
  b: Pick<FieldData, "variable" | "dimensions">
): DimensionCheck {
  const da = a.dimensions;
  const db = b.dimensions;
  if (da && db) {
    if (dimensionsEqual(da.exponents, db.exponents)) return { status: "ok" };
    const la = describeExponents(da.exponents);
    const lb = describeExponents(db.exponents);
    return {
      status: "mismatch",
      a: la,
      b: lb,
      message:
        `"${a.variable}" is [${la}] but "${b.variable}" is [${lb}]; ` +
        `their difference has no physical meaning. Convert one explicitly first ` +
        `(convertFieldUnits turns a kinematic pressure into Pa with a density you supply).`,
    };
  }
  if (da || db) {
    const known = da ? a : b;
    return {
      status: "unverified",
      note:
        `Dimensions of "${(da ? b : a).variable}" are unknown while "${known.variable}" is ` +
        `[${describeExponents((da ?? db)!.exponents)}]; the comparison assumes they agree.`,
    };
  }
  return { status: "ok" };
}

// ---- explicit conversion -------------------------------------------------------------

export type ConvertFieldUnitsParams = {
  variable: string;
  kind?: FieldData["kind"];
  /** Reference density in kg/m^3. Required, positive and finite; never inferred. */
  density: number;
  /** Name of the derived field; defaults to `<variable>_Pa`. Must differ from `variable`. */
  output?: string;
  /** Gauge vs absolute label for the result. Never inferred; unlabelled when omitted. */
  reference?: "gauge" | "absolute";
};

export type ConvertFieldUnitsOutcome = {
  fields: FieldData[];
  changed: boolean;
  message: string;
};

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Derives a Pa field from a kinematic-pressure field: `values * density`. The source is kept
 * untouched (so a display or export never rewrites original samples) and the result records the
 * density it used. Only a field whose dimensions ARE exactly kinematic pressure converts — a
 * dimensional pressure, any other dimension and an unknown one are refused by name, because
 * multiplying by a density is only meaningful for m²/s².
 */
export function convertFieldUnits(
  fields: readonly FieldData[],
  params: ConvertFieldUnitsParams
): ConvertFieldUnitsOutcome {
  const same = (f: FieldData) =>
    f.variable === params.variable && (!params.kind || f.kind === params.kind);
  const matches = fields.filter(same);
  if (matches.length === 0) {
    return { fields: fields.slice(), changed: false, message: `No field named "${params.variable}"${params.kind ? ` (${params.kind})` : ""}.` };
  }
  if (matches.length > 1) {
    return {
      fields: fields.slice(),
      changed: false,
      message: `"${params.variable}" exists on several entity kinds; pass kind to choose one.`,
    };
  }
  const src = matches[0];
  if (!(Number.isFinite(params.density) && params.density > 0)) {
    return { fields: fields.slice(), changed: false, message: "Density must be a finite positive number (kg/m³); it is never inferred." };
  }
  const output = params.output?.trim() || `${src.variable}_Pa`;
  if (!FIELD_NAME.test(output)) {
    return { fields: fields.slice(), changed: false, message: `"${output}" is not a valid field name (letters, digits, underscore; not starting with a digit).` };
  }
  if (output === src.variable) {
    return { fields: fields.slice(), changed: false, message: "The output must be a new field: the original samples are never overwritten." };
  }
  const dims = src.dimensions;
  if (!dims) {
    return {
      fields: fields.slice(),
      changed: false,
      message:
        `"${src.variable}" has no recorded dimensions, so it is not converted (a name such as p or PRESSURE is not evidence of its units). ` +
        `Only fields read from an OpenFOAM case carry them.`,
    };
  }
  if (dimensionsEqual(dims.exponents, PRESSURE)) {
    return { fields: fields.slice(), changed: false, message: `"${src.variable}" is already [Pa]; nothing to convert.` };
  }
  if (!dimensionsEqual(dims.exponents, KINEMATIC_PRESSURE)) {
    return {
      fields: fields.slice(),
      changed: false,
      message: `"${src.variable}" is [${describeExponents(dims.exponents)}], not a kinematic pressure [m²/s²]; only that converts to Pa.`,
    };
  }
  if (src.components !== 1) {
    return { fields: fields.slice(), changed: false, message: `"${src.variable}" has ${src.components} components; a pressure is a scalar.` };
  }
  const existing = fields.find((f) => f.kind === src.kind && f.variable === output);
  const prior = existing?.dimensions?.convertedFrom;
  if (existing && prior && prior.density !== params.density) {
    return {
      fields: fields.slice(),
      changed: false,
      message:
        `"${output}" was already converted with density ${prior.density} kg/m³; refusing to replace it with ${params.density}. ` +
        `Choose a different output name, or drop the field first.`,
    };
  }
  if (existing && !prior) {
    return { fields: fields.slice(), changed: false, message: `"${output}" already exists and was not produced by this conversion; choose another output name.` };
  }

  const values = new Float64Array(src.values.length);
  for (let i = 0; i < values.length; i++) values[i] = src.values[i] * params.density;
  const derived: FieldData = {
    kind: src.kind,
    variable: output,
    components: 1,
    ids: src.ids,
    values,
    dimensions: {
      exponents: PRESSURE.slice(),
      ...(params.reference ? { reference: params.reference } : {}),
      convertedFrom: { variable: src.variable, density: params.density },
    } satisfies FieldDimensions,
  };
  const next = fields.filter((f) => f !== existing);
  next.push(derived);
  const ref = params.reference ? `, ${params.reference}` : ", reference (gauge/absolute) not stated";
  return {
    fields: next,
    changed: true,
    message: `Converted "${src.variable}" [m²/s²] to "${output}" [Pa] with density ${params.density} kg/m³${ref}. The original is unchanged.`,
  };
}
