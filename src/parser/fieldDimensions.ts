/**
 * Physical dimensions of a field (former roadmap item 12) — pure, no `vscode`/DOM/fs, bundled into
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

/**
 * The dimensions of a spatial derivative: each `d/dx` divides by a length, so
 * the m exponent drops by `power` (1 for a gradient/divergence/curl, 2 for a
 * Hessian). A derivative also drops any gauge/absolute `reference` — it
 * cancels in differentiation, so keeping it would mislabel the result — while
 * `convertedFrom` provenance rides along (it still names the ultimate source).
 */
export function derivativeDimensions(
  from: Pick<FieldData, "dimensions"> | undefined,
  power: 1 | 2
): FieldData["dimensions"] {
  const dims = from?.dimensions;
  if (!dims) return undefined;
  const exponents = dims.exponents.slice();
  exponents[1] -= power;
  return {
    exponents,
    ...(dims.convertedFrom ? { convertedFrom: dims.convertedFrom } : {}),
  };
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

export interface DisplayAlternative {
  /** Unit label shown in the picker, legends and scalar bar. */
  unit: string;
  /** Displayed value = raw value / scale (multiplicative SI scaling only). */
  scale: number;
}

/**
 * Display-unit choices for a known dimension set: the field's own unit
 * first, then same-dimension SI alternatives. Multiplicative scaling ONLY —
 * affine units (°C/°F) are excluded the way `materialCatalog.ts` excludes
 * offsets, and an unknown dimension offers nothing. A single-entry list (K,
 * dimensionless) hides the picker: there is nothing to switch to.
 */
const DISPLAY_TABLE: { base: DimensionExponents; alts: { unit: string; scale: number }[] }[] = [
  { base: [0, 1, 0, 0, 0, 0, 0], alts: [{ unit: "m", scale: 1 }, { unit: "mm", scale: 1000 }, { unit: "km", scale: 0.001 }] },
  { base: [0, 1, -1, 0, 0, 0, 0], alts: [{ unit: "m/s", scale: 1 }, { unit: "km/h", scale: 1 / 3.6 }] },
  { base: PRESSURE, alts: [{ unit: "Pa", scale: 1 }, { unit: "kPa", scale: 1000 }, { unit: "MPa", scale: 1e6 }] },
  { base: [1, -3, 0, 0, 0, 0, 0], alts: [{ unit: "kg/m³", scale: 1 }, { unit: "g/cm³", scale: 1000 }] },
  { base: [0, 0, 0, 1, 0, 0, 0], alts: [{ unit: "K", scale: 1 }] },
  { base: [1, -1, -1, 0, 0, 0, 0], alts: [{ unit: "Pa·s", scale: 1 }, { unit: "mPa·s", scale: 1000 }] },
  { base: KINEMATIC_PRESSURE, alts: [{ unit: "m²/s²", scale: 1 }, { unit: "mm²/s", scale: 1e6 }] },
  { base: DIMENSIONLESS, alts: [{ unit: "1", scale: 1 }] },
];

/** Display-unit choices for a field, or `[]` when its dimensions are unknown. */
export function displayAlternatives(field: Pick<FieldData, "dimensions">): DisplayAlternative[] {
  const d = field.dimensions;
  if (!d) return [];
  const row = DISPLAY_TABLE.find((r) => dimensionsEqual(r.base, d.exponents));
  return row ? row.alts.map((a) => ({ ...a })) : [{ unit: describeExponents(d.exponents), scale: 1 }];
}

/**
 * The divisor for a pane's display-unit choice: `displayed = raw / scale`.
 * Unknown unit names and unknown dimensions fall back to 1 (the field's own
 * numbers), never to a guessed scaling.
 */
export function displayScaleFor(field: Pick<FieldData, "dimensions">, displayUnit?: string): number {
  if (!displayUnit) return 1;
  const found = displayAlternatives(field).find((a) => a.unit === displayUnit);
  return found && found.scale > 0 ? found.scale : 1;
}

/**
 * MED-style unit NAMES to exponents. MED carries free-text unit strings
 * (`UNI`), not exponent vectors, so this is a curated name table, not a unit
 * parser: only unambiguous SI spellings map, and anything else stays UNKNOWN
 * rather than guessed. Scales are irrelevant here — kPa and Pa share
 * exponents — so prefixed forms map to the same set. Deliberately absent:
 * degrees Celsius/Fahrenheit (offsets, not factors — the `materialCatalog.ts`
 * rule) and angular units (dimensionless in SI but not meaningfully so here).
 */
const UNIT_NAMES: { names: string[]; exps: DimensionExponents }[] = [
  { names: ["pa", "kpa", "mpa", "gpa", "bar", "mbar", "n/m2"], exps: PRESSURE },
  { names: ["m", "mm", "cm", "km"], exps: [0, 1, 0, 0, 0, 0, 0] },
  { names: ["m2", "mm2", "cm2"], exps: [0, 2, 0, 0, 0, 0, 0] },
  { names: ["m3", "mm3", "cm3"], exps: [0, 3, 0, 0, 0, 0, 0] },
  { names: ["s", "ms"], exps: [0, 0, 1, 0, 0, 0, 0] },
  { names: ["m/s", "mm/s", "km/h"], exps: [0, 1, -1, 0, 0, 0, 0] },
  { names: ["m/s2"], exps: [0, 1, -2, 0, 0, 0, 0] },
  { names: ["m2/s"], exps: [0, 2, -1, 0, 0, 0, 0] },
  { names: ["m2/s2"], exps: KINEMATIC_PRESSURE },
  { names: ["kg", "g", "t"], exps: [1, 0, 0, 0, 0, 0, 0] },
  { names: ["kg/m3", "g/cm3"], exps: [1, -3, 0, 0, 0, 0, 0] },
  { names: ["pa.s", "pas"], exps: [1, -1, -1, 0, 0, 0, 0] },
  { names: ["k"], exps: [0, 0, 0, 1, 0, 0, 0] },
  { names: ["n", "kn"], exps: [1, 1, -2, 0, 0, 0, 0] },
  { names: ["j", "kj"], exps: [1, 2, -2, 0, 0, 0, 0] },
  { names: ["w", "kw"], exps: [1, 2, -3, 0, 0, 0, 0] },
  { names: ["1"], exps: DIMENSIONLESS },
];

/** Normalizes a free-text unit the way the table is keyed: case, superscripts, spaces and `*`/`^` are spelling, not meaning. */
function normalizeUnitName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/[\s*^·.]/g, "");
}

/** Exponents for a MED-style unit name, or `undefined` when it names nothing unambiguous. */
export function exponentsForUnitName(name: string): number[] | undefined {
  const key = normalizeUnitName(name);
  if (!key) return undefined;
  for (const row of UNIT_NAMES) {
    if (row.names.includes(key)) return row.exps.slice();
  }
  return undefined;
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
  /** Reference density in kg/m^3. Exactly one of `density`/`densityField` is required; never inferred. */
  density?: number;
  /**
   * A scalar field to take the density from, per entity: `values[i] * rho[i]`
   * over the ids both fields define. Must be the same entity kind; a density
   * field whose dimensions are known and not a density is refused, an
   * undimensioned one proceeds with a stated assumption (the
   * `checkCompatible` unverified rule). Gaps on either side stay gaps.
   */
  densityField?: { variable: string; kind?: FieldData["kind"] };
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
 *
 * The density is a scalar or a same-kind scalar FIELD (`densityField`): per-entity products
 * over the ids both define, gaps where either side is missing. A density field with known,
 * non-density dimensions is refused; an undimensioned one is taken on the caller's word
 * and the message says so.
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
  const useField = params.densityField !== undefined;
  if (useField && params.density !== undefined) {
    return { fields: fields.slice(), changed: false, message: "Pass either a density or a density field, not both." };
  }
  let rho: Map<number, number> | undefined;
  let rhoNote: string;
  if (useField) {
    const df = params.densityField!;
    const dmatches = fields.filter((f) => f.variable === df.variable && (!df.kind || f.kind === df.kind));
    if (dmatches.length === 0) {
      return { fields: fields.slice(), changed: false, message: `No density field named "${df.variable}"${df.kind ? ` (${df.kind})` : ""}.` };
    }
    if (dmatches.length > 1) {
      return {
        fields: fields.slice(),
        changed: false,
        message: `"${df.variable}" exists on several entity kinds; pass kind to choose one.`,
      };
    }
    const den = dmatches[0];
    if (den.components !== 1) {
      return { fields: fields.slice(), changed: false, message: `Density field "${den.variable}" has ${den.components} components; a density is a scalar.` };
    }
    if (den.kind !== src.kind) {
      return {
        fields: fields.slice(),
        changed: false,
        message: `Density field "${den.variable}" is ${den.kind} but "${src.variable}" is ${src.kind}; a per-entity product needs the same entity kind.`,
      };
    }
    if (den.dimensions && !dimensionsEqual(den.dimensions.exponents, [1, -3, 0, 0, 0, 0, 0])) {
      return {
        fields: fields.slice(),
        changed: false,
        message: `Density field "${den.variable}" is [${describeExponents(den.dimensions.exponents)}], not a density [kg/m³].`,
      };
    }
    rho = new Map<number, number>();
    for (let r = 0; r < den.ids.length; r++) {
      const v = den.values[r];
      if (Number.isFinite(v) && v > 0) rho.set(den.ids[r], v);
    }
    rhoNote = den.dimensions
      ? `with density field "${den.variable}"`
      : `with density field "${den.variable}" (whose dimensions are unknown, taken on your word)`;
  } else {
    if (!(Number.isFinite(params.density) && (params.density as number) > 0)) {
      return { fields: fields.slice(), changed: false, message: "Density must be a finite positive number (kg/m³); it is never inferred. Pass densityField to use a density field instead." };
    }
    rhoNote = `with density ${params.density} kg/m³`;
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
  const sameSource = (p: NonNullable<typeof prior>): boolean =>
    useField
      ? p.densityField === params.densityField!.variable
      : p.density === params.density;
  if (existing && prior && !sameSource(prior)) {
    const was = prior.densityField ? `density field "${prior.densityField}"` : `density ${prior.density} kg/m³`;
    const now = useField ? `density field "${params.densityField!.variable}"` : `density ${params.density}`;
    return {
      fields: fields.slice(),
      changed: false,
      message:
        `"${output}" was already converted with ${was}; refusing to replace it with ${now}. ` +
        `Choose a different output name, or drop the field first.`,
    };
  }
  if (existing && !prior) {
    return { fields: fields.slice(), changed: false, message: `"${output}" already exists and was not produced by this conversion; choose another output name.` };
  }

  const rowOf = new Map<number, number>();
  for (let r = 0; r < src.ids.length; r++) rowOf.set(src.ids[r], r);
  const order = useField ? [...rho!.keys()].filter((id) => rowOf.has(id)) : Array.from(rowOf.keys());
  if (order.length === 0) {
    return { fields: fields.slice(), changed: false, message: `No entity carries both "${src.variable}" and density field "${params.densityField!.variable}".` };
  }
  const values = new Float64Array(order.length);
  const ids = new Int32Array(order.length);
  order.forEach((id, i) => {
    ids[i] = id;
    values[i] = src.values[rowOf.get(id)!] * (useField ? rho!.get(id)! : (params.density as number));
  });
  const derived: FieldData = {
    kind: src.kind,
    variable: output,
    components: 1,
    ids,
    values,
    dimensions: {
      exponents: PRESSURE.slice(),
      ...(params.reference ? { reference: params.reference } : {}),
      convertedFrom: useField
        ? { variable: src.variable, densityField: params.densityField!.variable }
        : { variable: src.variable, density: params.density as number },
    } satisfies FieldDimensions,
  };
  const next = fields.filter((f) => f !== existing);
  next.push(derived);
  const ref = params.reference ? `, ${params.reference}` : ", reference (gauge/absolute) not stated";
  const uncovered = src.ids.length - order.length;
  return {
    fields: next,
    changed: true,
    message:
      `Converted "${src.variable}" [m²/s²] to "${output}" [Pa] ${rhoNote}${ref}. The original is unchanged.` +
      (uncovered > 0 ? ` ${uncovered} entit${uncovered === 1 ? "y" : "ies"} without a usable density on both sides stayed gaps.` : ""),
  };
}
