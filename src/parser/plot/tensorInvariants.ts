/** Pure tensor invariants for plots. A component layout is ALWAYS supplied by the caller: no file states a Voigt order, so none is inferred. No DOM, I/O or vscode. */

export const TENSOR_INVARIANTS = ["trace", "hydrostatic", "vonMises", "j2", "deviatoricNorm", "principalMax", "principalMid", "principalMin", "maxShear"] as const;
export type TensorInvariant = typeof TENSOR_INVARIANTS[number];

/** Component indices of the stored tuple. zz/yz/xz absent means a plane problem: those entries are zero (disclosed by the caller). */
export interface TensorIndices { xx: number; yy: number; zz?: number; xy: number; yz?: number; xz?: number }
export type TensorLayout = "full3x3" | "full2x2" | TensorIndices;
/** "engineering": off-diagonals are stored as engineering shear (gamma = 2 epsilon) and are halved. */
export type TensorShear = "tensor" | "engineering";
export interface TensorSpec { layout: TensorLayout; invariant: TensorInvariant; shear?: TensorShear }

/** Invariants whose unit equals the source field's. j2 and deviatoricNorm-squared style quantities are handled by `invariantUnitPower`. */
export function invariantUnitPower(invariant: TensorInvariant): number { return invariant === "j2" ? 2 : 1; }

export function layoutIndices(layout: TensorLayout): TensorIndices {
  if (layout === "full3x3") return { xx: 0, xy: 1, xz: 2, yy: 4, yz: 5, zz: 8 };
  if (layout === "full2x2") return { xx: 0, xy: 1, yy: 3 };
  return layout;
}
export function layoutWidth(layout: TensorLayout): number | undefined { return layout === "full3x3" ? 9 : layout === "full2x2" ? 4 : undefined; }

export function validateTensorSpec(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return "tensor must be an object.";
  const s = t as Record<string, unknown>;
  if (!TENSOR_INVARIANTS.includes(s.invariant as TensorInvariant)) return `Unknown tensor invariant (use ${TENSOR_INVARIANTS.join(", ")}).`;
  if (s.shear !== undefined && s.shear !== "tensor" && s.shear !== "engineering") return "tensor.shear must be \"tensor\" or \"engineering\".";
  const l = s.layout;
  if (l === "full3x3" || l === "full2x2") return undefined;
  if (!l || typeof l !== "object") return "tensor.layout must be \"full3x3\", \"full2x2\" or explicit component indices.";
  const o = l as Record<string, unknown>, keys = Object.keys(o);
  const allowed = ["xx", "yy", "zz", "xy", "yz", "xz"];
  if (keys.some(k => !allowed.includes(k))) return "tensor.layout has an unknown component name.";
  for (const k of ["xx", "yy", "xy"]) if (o[k] === undefined) return `tensor.layout needs ${k}.`;
  if (keys.some(k => !Number.isInteger(o[k]) || (o[k] as number) < 0 || (o[k] as number) >= 32)) return "tensor.layout indices must be integers 0-31.";
  return undefined;
}

/** Symmetric 3x3 from a stored tuple. Throws naming the problem; returns undefined for a non-finite value (a gap, never 0). */
export function tensorFromTuple(tuple: ArrayLike<number>, layout: TensorLayout, shear: TensorShear = "tensor"): number[] | undefined {
  const ix = layoutIndices(layout), w = layoutWidth(layout);
  if (w !== undefined && tuple.length !== w) throw new Error(`Tensor layout ${layout} needs a ${w}-component field; this field has ${tuple.length}.`);
  const get = (i: number | undefined): number => {
    if (i === undefined) return 0;
    if (i >= tuple.length) throw new Error(`Tensor component index ${i} is outside this ${tuple.length}-component field.`);
    return tuple[i];
  };
  const f = shear === "engineering" ? 0.5 : 1;
  const xx = get(ix.xx), yy = get(ix.yy), zz = get(ix.zz), xy = get(ix.xy) * f, yz = get(ix.yz) * f, xz = get(ix.xz) * f;
  const t = [xx, xy, xz, xy, yy, yz, xz, yz, zz];
  return t.every(Number.isFinite) ? t : undefined;
}

/** Eigenvalues of a symmetric 3x3 (row-major), descending. Closed-form trigonometric solution. */
export function principalValues(t: number[]): [number, number, number] {
  const a = t[0], b = t[4], c = t[8], d = t[1], e = t[5], f = t[2];
  const p1 = d * d + f * f + e * e;
  if (p1 === 0) { const v = [a, b, c].sort((x, y) => y - x); return [v[0], v[1], v[2]]; }
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = [(a - q) / p, d / p, f / p, d / p, (b - q) / p, e / p, f / p, e / p, (c - q) / p];
  const detB = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6]) + B[2] * (B[3] * B[7] - B[4] * B[6]);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  return [e1, 3 * q - e1 - e3, e3];
}

export function invariantOf(t: number[], invariant: TensorInvariant): number {
  const tr = t[0] + t[4] + t[8], m = tr / 3;
  const dev = [t[0] - m, t[1], t[2], t[3], t[4] - m, t[5], t[6], t[7], t[8] - m];
  const dd = dev.reduce((s, v) => s + v * v, 0);
  switch (invariant) {
    case "trace": return tr;
    case "hydrostatic": return m;
    case "j2": return dd / 2;
    case "deviatoricNorm": return Math.sqrt(dd);
    case "vonMises": return Math.sqrt(1.5 * dd);
    case "principalMax": return principalValues(t)[0];
    case "principalMid": return principalValues(t)[1];
    case "principalMin": return principalValues(t)[2];
    case "maxShear": { const v = principalValues(t); return (v[0] - v[2]) / 2; }
  }
}
