/**
 * Converts an `MdpaModel` into a "wire-safe" shape for `webviewPanel.webview
 * .postMessage()` — VS Code's extension-host↔webview transport loses the
 * *contents* of typed arrays (Int32Array/Float64Array/Uint8Array) once a
 * message carries enough cumulative typed-array volume, while leaving their
 * type tag intact: `Object.prototype.toString.call(field.ids)` still reports
 * `"[object Int32Array]"` on arrival, but `.length` reads 0 and
 * `instanceof Int32Array` is false. Measured directly against a real VS Code
 * instance (not reproducible via same-page postMessage, e.g. the screenshot
 * harness, which never crosses this boundary): a 59-field, ~140k-row-per-
 * field model loses every field's `ids`/`values` this way, while the much
 * smaller `nodeIds`/`coords`/`blocks[].connectivity`/`subModelParts[].*Ids`
 * typed arrays — earlier in the model's property order, and each
 * individually and cumulatively far smaller than `fields` — survive intact.
 *
 * `FieldData.ids`/`.values`/`.fixed` are the only typed arrays in the model
 * whose cumulative volume can plausibly cross that threshold (one entry per
 * node/element/condition, once per field, for potentially dozens of
 * fields) — geometry is already close to fields in per-array size but
 * appears once, not per field. So only field arrays are converted to plain
 * numeric arrays here: the webview only ever does `.length`/indexed access
 * on `field.ids`/`field.values` (see `src/parser/fieldScalars.ts`,
 * `webview/fieldData.ts`), never anything typed-array-specific, so a plain
 * array is a drop-in replacement there. Every other consumer of `MdpaModel`
 * — every `src/parser/*.ts` mesh operation, which relies on
 * `Int32Array`/`Float64Array`-specific methods like `.subarray()` — runs
 * host-side, before this conversion, and is untouched by it.
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */
import { FieldData, MdpaModel } from "./types";

export function toWireModel(model: MdpaModel): MdpaModel {
  return {
    ...model,
    fields: model.fields.map(toWireField),
  };
}

export function toWireField(field: FieldData): FieldData {
  const wire: FieldData = {
    ...field,
    // Deliberately not real typed arrays — see the module doc comment. The
    // webview-side FieldData consumers only ever do `.length`/indexed
    // access, so this cast is safe for every actual reader.
    ids: Array.from(field.ids) as unknown as Int32Array,
    values: Array.from(field.values) as unknown as Float64Array,
  };
  if (field.fixed) {
    wire.fixed = Array.from(field.fixed) as unknown as Uint8Array;
  }
  return wire;
}

/**
 * Total field rows (`ids.length` summed over every field) — the quantity that
 * dominates a posted model's size: a measured 1M-hexahedron block carried
 * ~136 MB of field rows against ~52 MB of geometry.
 */
export function fieldRowCount(model: MdpaModel): number {
  let rows = 0;
  for (const f of model.fields) rows += f.ids.length;
  return rows;
}

/** Above this many field rows an initial load is staged: geometry first, fields after. */
export const STAGED_FIELD_ROWS = 2_000_000;

/**
 * The geometry-first half of a staged delivery: the same model with no fields.
 * The fields follow one message each (`toWireField`), so no single message
 * carries the whole field volume and the first paint does not wait for it.
 */
export function stagedHead(model: MdpaModel): MdpaModel {
  return { ...model, fields: model.fields.map(toWireFieldMeta) };
}

/**
 * A field without its rows: name, kind, components, dimensions and numeric
 * type travel; `ids`/`values` are empty and `pendingRows` says how many rows a
 * later `toWireField` will deliver. The webview asks for the rows when a
 * feature actually reads them.
 */
export function toWireFieldMeta(field: FieldData): FieldData {
  const { fixed: _fixed, ...rest } = field;
  return {
    ...rest,
    ids: [] as unknown as Int32Array,
    values: [] as unknown as Float64Array,
    pendingRows: field.ids.length,
  };
}

/** The `${kind}:${variable}` key the webview uses for a field. */
export function wireFieldKey(field: Pick<FieldData, "kind" | "variable">): string {
  return `${field.kind}:${field.variable}`;
}

/** What a provider spreads into its `model`/`vtkFrame` post. */
export interface WiredModel {
  model: MdpaModel;
  /** Present only for a staged post: how many fields still owe their rows. */
  fieldsPending?: number;
  stageId?: number;
}

export interface FieldStager {
  /**
   * The wire form of `model` for one post. Stages (geometry + field metadata)
   * only when `allowStage` and the field volume is above the threshold; any
   * other post is whole and drops the retained model, so a late `requestField`
   * for an older stage is never answered from stale data.
   */
  wire(model: MdpaModel, allowStage: boolean): WiredModel;
  /** The `modelField` reply for a request, or `undefined` when superseded or unknown. */
  answer(stageId: unknown, key: unknown): { type: "modelField"; stageId: number; key: string; field: FieldData } | undefined;
  clear(): void;
}

/**
 * One per panel. Replaces the inline `stageId`/`stagedModel` pair the MDPA
 * provider carried, so every post path (initial load, edit re-render, VTK
 * frame) shares the same supersession rule: only the newest post is served.
 */
export function createFieldStager(threshold: number = STAGED_FIELD_ROWS): FieldStager {
  let seq = 0;
  let retained: MdpaModel | undefined;
  return {
    wire(model, allowStage) {
      if (allowStage && shouldStageFields(model, threshold)) {
        retained = model;
        return { model: stagedHead(model), fieldsPending: model.fields.length, stageId: ++seq };
      }
      retained = undefined;
      return { model: toWireModel(model) };
    },
    answer(stageId, key) {
      if (!retained || stageId !== seq || typeof key !== "string") return undefined;
      const f = retained.fields.find((x) => wireFieldKey(x) === key);
      return f ? { type: "modelField", stageId: seq, key, field: toWireField(f) } : undefined;
    },
    clear() {
      retained = undefined;
    },
  };
}

/** True when a model's fields are big enough to be delivered after its geometry. */
export function shouldStageFields(model: MdpaModel, threshold: number = STAGED_FIELD_ROWS): boolean {
  return model.fields.length > 0 && fieldRowCount(model) > threshold;
}
