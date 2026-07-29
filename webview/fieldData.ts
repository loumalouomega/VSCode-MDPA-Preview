// Webview-side helpers over a parsed FieldData: id→value lookups and the scalar
// range that drives colormaps, legends and the isosurface slider. For vector
// fields the "scalar" defaults to magnitude but can be switched to a single
// X/Y/Z component (see FieldComponent in src/parser/fieldScalars.ts).

import { FieldData } from "../src/parser/types";
import { FieldComponent, componentScalar, computeFieldRange } from "../src/parser/fieldScalars";

export interface FieldInfo {
  field: FieldData;
  key: string; // `${kind}:${variable}`
  isVector: boolean;
  indexById: Map<number, number>;
  scalarMin: number;
  scalarMax: number;
  /** Per-component [min,max], memoized lazily; index 0=mag,1=X,2=Y,3=Z. */
  rangeCache: [number, number][];
}

export function fieldKey(field: FieldData): string {
  return `${field.kind}:${field.variable}`;
}

function componentSlot(component: FieldComponent): number {
  return component === "mag" ? 0 : component + 1;
}

export function buildFieldInfo(field: FieldData): FieldInfo {
  const isVector = field.components > 1;
  const indexById = new Map<number, number>();
  for (let i = 0; i < field.ids.length; i++) indexById.set(field.ids[i], i);
  const [scalarMin, scalarMax] = computeFieldRange(field, "mag");
  return {
    field,
    key: fieldKey(field),
    isVector,
    indexById,
    scalarMin,
    scalarMax,
    rangeCache: [[scalarMin, scalarMax]],
  };
}

/** The data range for a given component, computed once and memoized on `info`. */
export function rangeForComponent(info: FieldInfo, component: FieldComponent = "mag"): [number, number] {
  const slot = componentSlot(component);
  const cached = info.rangeCache[slot];
  if (cached) return cached;
  const range = computeFieldRange(info.field, component);
  info.rangeCache[slot] = range;
  return range;
}

// Scalar (or magnitude/component) for an entity id, or undefined when absent.
export function scalarAt(
  info: FieldInfo,
  id: number,
  component: FieldComponent = "mag"
): number | undefined {
  const i = info.indexById.get(id);
  if (i === undefined) return undefined;
  return componentScalar(info.field, i, component);
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
