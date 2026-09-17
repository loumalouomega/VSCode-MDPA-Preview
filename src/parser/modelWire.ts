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

function toWireField(field: FieldData): FieldData {
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
