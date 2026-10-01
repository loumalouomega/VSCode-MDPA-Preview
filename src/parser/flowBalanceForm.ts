/**
 * The Flow balance panel's form, as data: what the user typed (kept as text so
 * a half-edited value survives a re-render) and the one function that turns it
 * into a request, or an error naming the offending field.
 *
 * Pure and bundled into the webview, which cannot be exercised under
 * `node:test` — so every decision the panel makes about its input lives here.
 */

import type { FlowBalanceSpec, FlowOrientation } from "./flowBalance";

export interface FlowSectionRow {
  /** Label; blank means the part's path. */
  name: string;
  /** SubModelPart path; blank = not chosen yet. */
  part: string;
}

export interface FlowBalanceForm {
  /** Nodal vector field; "" = no flux (pressure only). */
  velocity: string;
  /** Nodal scalar field; "" = no pressure. */
  pressure: string;
  sections: FlowSectionRow[];
  orientation: FlowOrientation;
  /** Blank = no mass flux. */
  density: string;
  /** Blank = no Pa conversion (means/drop stay in the field's own units). */
  pressureDensity: string;
  /** Label only for a converted pressure; "" = unstated. */
  pressureReference: "" | "gauge" | "absolute";
  /** Section labels for the pressure drop; "" = none. */
  dropFrom: string;
  dropTo: string;
}

export function defaultFlowBalanceForm(): FlowBalanceForm {
  return {
    velocity: "",
    pressure: "",
    sections: [{ name: "", part: "" }, { name: "", part: "" }],
    orientation: "outward",
    density: "",
    pressureDensity: "",
    pressureReference: "",
    dropFrom: "",
    dropTo: "",
  };
}

/** The label a section row will carry in the result. */
export const flowSectionLabel = (row: FlowSectionRow): string => row.name.trim() || row.part;

export type FlowRequestResult = { ok: true; spec: FlowBalanceSpec } | { ok: false; error: string };

export function buildFlowBalanceRequest(form: FlowBalanceForm): FlowRequestResult {
  const fail = (error: string): FlowRequestResult => ({ ok: false, error });
  if (!form.velocity && !form.pressure) return fail("Pick a velocity field, a pressure field, or both.");
  const rows = form.sections.filter((r) => r.part !== "" || r.name.trim() !== "");
  if (rows.length === 0) return fail("Choose at least one section (a SubModelPart of Conditions).");
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].part === "") return fail(`Section ${i + 1} has no SubModelPart.`);
    const label = flowSectionLabel(rows[i]);
    if (seen.has(label)) return fail(`Two sections are called "${label}"; give each its own name.`);
    seen.add(label);
  }
  let density: number | undefined;
  if (form.density.trim() !== "") {
    density = Number(form.density);
    if (!Number.isFinite(density) || density <= 0) return fail("Density must be a positive number (or blank for no mass flux).");
    if (!form.velocity) return fail("A density only gives a mass flux together with a velocity field.");
  }
  let pressureDensity: number | undefined;
  if (form.pressureDensity.trim() !== "") {
    pressureDensity = Number(form.pressureDensity);
    if (!Number.isFinite(pressureDensity) || pressureDensity <= 0) return fail("Pressure density must be a positive number (or blank for no Pa conversion).");
    if (!form.pressure) return fail("A pressure density only converts together with a pressure field.");
  }
  if (form.pressureReference !== "" && !form.pressureDensity.trim()) return fail("A pressure reference only labels a Pa conversion.");
  let pressureReference: FlowBalanceSpec["pressureReference"];
  if (form.pressureReference === "gauge" || form.pressureReference === "absolute") pressureReference = form.pressureReference;
  let pressureDrop: FlowBalanceSpec["pressureDrop"];
  if (form.dropFrom !== "" || form.dropTo !== "") {
    if (form.dropFrom === "" || form.dropTo === "") return fail("A pressure drop needs both a From and a To section.");
    if (form.dropFrom === form.dropTo) return fail("A pressure drop needs two different sections.");
    if (!seen.has(form.dropFrom) || !seen.has(form.dropTo)) return fail("The pressure-drop sections must be among the sections above.");
    if (!form.pressure) return fail("A pressure drop needs a pressure field.");
    pressureDrop = { from: form.dropFrom, to: form.dropTo };
  }
  return {
    ok: true,
    spec: {
      sections: rows.map((r) => ({ name: flowSectionLabel(r), part: r.part })),
      velocity: form.velocity || null,
      pressure: form.pressure || null,
      density,
      orientation: form.orientation,
      pressureDrop,
      pressureDensity,
      pressureReference,
    },
  };
}
