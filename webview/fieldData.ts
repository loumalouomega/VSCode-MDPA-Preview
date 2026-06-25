// Webview-side helpers over a parsed FieldData: id→value lookups and the scalar
// range that drives colormaps, legends and the isosurface slider. For vector
// fields the "scalar" is the vector magnitude.

import { FieldData } from "../src/parser/types";

export interface FieldInfo {
  field: FieldData;
  key: string; // `${kind}:${variable}`
  isVector: boolean;
  indexById: Map<number, number>;
  scalarMin: number;
  scalarMax: number;
}

export function fieldKey(field: FieldData): string {
  return `${field.kind}:${field.variable}`;
}

export function buildFieldInfo(field: FieldData): FieldInfo {
  const isVector = field.components > 1;
  const indexById = new Map<number, number>();
  let scalarMin = Infinity;
  let scalarMax = -Infinity;
  for (let i = 0; i < field.ids.length; i++) {
    indexById.set(field.ids[i], i);
    const s = scalarAtIndex(field, i, isVector);
    if (s < scalarMin) scalarMin = s;
    if (s > scalarMax) scalarMax = s;
  }
  if (!Number.isFinite(scalarMin)) {
    scalarMin = 0;
    scalarMax = 0;
  }
  return { field, key: fieldKey(field), isVector, indexById, scalarMin, scalarMax };
}

function scalarAtIndex(field: FieldData, i: number, isVector: boolean): number {
  if (!isVector) return field.values[i];
  let sum = 0;
  const c = field.components;
  for (let k = 0; k < c; k++) {
    const v = field.values[i * c + k];
    sum += v * v;
  }
  return Math.sqrt(sum);
}

// Scalar (or magnitude) for an entity id, or undefined when absent.
export function scalarAt(info: FieldInfo, id: number): number | undefined {
  const i = info.indexById.get(id);
  if (i === undefined) return undefined;
  return scalarAtIndex(info.field, i, info.isVector);
}

// Vector components for an entity id, or undefined when absent / not a vector.
export function vectorAt(info: FieldInfo, id: number): [number, number, number] | undefined {
  if (!info.isVector) return undefined;
  const i = info.indexById.get(id);
  if (i === undefined) return undefined;
  const c = info.field.components;
  const o = i * c;
  return [
    info.field.values[o],
    c > 1 ? info.field.values[o + 1] : 0,
    c > 2 ? info.field.values[o + 2] : 0,
  ];
}
