/**
 * Derived meshes: a NEW mesh computed from the open one, written out as a file
 * rather than applied as an edit. A slice through a plane, the isosurface of a
 * nodal field, the region of a mesh where a field lies in a window. There is
 * nothing to undo and nothing enters the operation history — the same class as
 * "Export skin" and "Export SubModelPart" — which is why one dispatcher serves
 * the UI export (`menuExportDerived`) and the MCP `mesh_derive` tool alike.
 *
 * Pure module (no vscode / DOM). `slice` and `isosurface` are meshio++ results
 * READ BACK as a new model (the output cells are newly created, so there is no
 * correspondence to preserve — upstream itself drops the named regions); their
 * source is recovered through the parent-cell arrays and written as
 * `SOURCE_ENTITY_ID` / `SOURCE_ENTITY_KIND` fields, so a slice cell still says
 * which cell of the open mesh it was cut from. `threshold` is NATIVE and keeps
 * original ids, Conditions, groups, fields and Properties (see selectCells.ts).
 */

import { EntityKind, FieldBlockKind, FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import { modelToMeshio, meshioToModel, meshioBlockOrder, sanitizeVariable, MeshioMesh } from "./meshioConvert";
import { loadMeshio } from "./meshio";
import { FieldComponent, computeFieldRange } from "./fieldScalars";
import { thresholdCells, ThresholdRule } from "./thresholdCells";
import { restrictToElements, elementMeasures } from "./selectCells";
import { extractSkinModel } from "./extractSkin";
import { decimateModel, DecimateParams } from "./decimate";

export type Vec3 = [number, number, number];

export interface SliceSpec {
  kind: "slice";
  /** A point on the plane. */
  origin: Vec3;
  /** The plane normal (need not be unit). */
  normal: Vec3;
}

export interface IsosurfaceSpec {
  kind: "isosurface";
  /** A NODAL field; a cell field is piecewise constant and has no level set. */
  variable: string;
  values: number[];
  /** A vector field's component, or "mag" (default) for its magnitude. */
  component?: FieldComponent;
}

export interface ThresholdSpec {
  kind: "threshold";
  variable: string;
  fieldKind: FieldBlockKind;
  component?: FieldComponent;
  /** An ABSOLUTE window in the field's own units... */
  range?: [number, number];
  /**
   * ...or a NORMALIZED one in [0, 1] against an explicit reference range
   * (`[lo, hi]`), or against this frame's own data range with `"frame"` — an
   * opt-in, because per-frame rescaling changes the physical threshold from one
   * time step to the next.
   */
  normalized?: { range: [number, number]; reference: [number, number] | "frame" };
  /** For a Nodal field: does a cell need every node in the window ("all", default) or one ("any")? */
  rule?: ThresholdRule;
  /** "region" (default) is the selected volume with original ids; "skin" is its boundary surface. */
  output?: "region" | "skin";
}

/**
 * A simplified COPY of a triangle surface (quadric-error edge collapse, see
 * decimate.ts): survivors keep their entity ids, kinds, property ids and
 * cell-field values; nothing is written back to the open mesh.
 */
export type DecimateSpec = { kind: "decimate" } & DecimateParams;

export type DeriveSpec = SliceSpec | IsosurfaceSpec | ThresholdSpec | DecimateSpec;
export const DERIVE_KINDS = ["slice", "isosurface", "threshold", "decimate"] as const;

export interface DeriveResult {
  model: MdpaModel;
  /** One or two sentences: what was cut, and how much of the source it covers. */
  summary: string;
  /** Appended to the source stem for a default filename. */
  suffix: string;
}

const finite3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Replaces the colon-named upstream provenance fields of a read-back result with our own. */
function withSourceFields(source: MdpaModel, result: MdpaModel, parentFieldName: string, extra: Record<string, string> = {}): MdpaModel {
  const parent = result.fields.find((f) => f.kind === "Elemental" && f.variable === parentFieldName);
  const order = meshioBlockOrder(source);
  const flat: { kind: EntityKind; id: number }[] = [];
  for (const b of order) for (let i = 0; i < b.count; i++) flat.push({ kind: b.kind, id: b.entityIds[i] });
  const drop = new Set([parentFieldName, ...Object.keys(extra)]);
  const fields: FieldData[] = result.fields.filter((f) => !(f.kind === "Elemental" && drop.has(f.variable)));
  if (parent) {
    const ids = parent.ids;
    const srcId = new Float64Array(ids.length);
    const srcKind = new Float64Array(ids.length);
    const kindCode: Record<EntityKind, number> = { Elements: 0, Conditions: 1, Geometries: 2 };
    for (let i = 0; i < ids.length; i++) {
      const p = flat[Math.round(parent.values[i])];
      srcId[i] = p ? p.id : NaN;
      srcKind[i] = p ? kindCode[p.kind] : NaN;
    }
    fields.push(
      { kind: "Elemental", variable: "SOURCE_ENTITY_ID", components: 1, ids, values: srcId },
      { kind: "Elemental", variable: "SOURCE_ENTITY_KIND", components: 1, ids, values: srcKind }
    );
  }
  // Renamed passthroughs (e.g. iso_value -> ISO_VALUE): same ids and values, a legal name.
  for (const [from, to] of Object.entries(extra)) {
    const f = result.fields.find((x) => x.kind === "Elemental" && x.variable === from);
    if (f) fields.push({ ...f, variable: to });
  }
  return { ...result, fields };
}

export async function deriveMesh(model: MdpaModel, spec: DeriveSpec, diagnostics: MdpaDiagnostic[] = []): Promise<DeriveResult> {
  if (model.nodeCount === 0) throw new Error("The mesh has no nodes.");
  switch (spec.kind) {
    case "slice": {
      if (!finite3(spec.origin) || !finite3(spec.normal)) throw new Error("A slice needs a finite origin and normal (3 numbers each).");
      if (spec.normal.every((v) => v === 0)) throw new Error("The slice normal must not be the zero vector.");
      const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
      if (mesh.cells.length === 0) throw new Error("The mesh has no cells to slice.");
      const m = await loadMeshio();
      const cut = m.slice(mesh, spec.origin, spec.normal, true) as MeshioMesh;
      if (cut.cells.length === 0 || cut.cells.every((c) => "data" in c && c.data.length === 0)) {
        throw new Error("The plane does not cut the mesh.");
      }
      const read = withSourceFields(model, meshioToModel(cut, diagnostics), "slice_parent_cell");
      const n = read.blocks.reduce((s, b) => s + b.count, 0);
      return {
        model: read,
        summary: `Slice through (${spec.origin.join(", ")}) with normal (${spec.normal.join(", ")}): ${n} cell(s), ${read.nodeCount} node(s), each tagged with the cell it was cut from (SOURCE_ENTITY_ID/KIND).`,
        suffix: "slice",
      };
    }
    case "isosurface": {
      if (!Array.isArray(spec.values) || spec.values.length === 0 || !spec.values.every((v) => Number.isFinite(v))) {
        throw new Error("An isosurface needs at least one finite isovalue.");
      }
      const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === spec.variable);
      if (!field) {
        const elsewhere = model.fields.find((f) => f.variable === spec.variable);
        throw new Error(
          elsewhere
            ? `"${spec.variable}" is a ${elsewhere.kind} field, which is piecewise constant and has no level set — move it to the nodes with Average field first.`
            : `No nodal field named "${spec.variable}".`
        );
      }
      const comp = spec.component ?? "mag";
      if (comp !== "mag" && (comp < 0 || comp >= field.components)) throw new Error(`"${spec.variable}" has no component ${comp}.`);
      const mesh = modelToMeshio(model, diagnostics, { dim: 3 });
      if (mesh.cells.length === 0) throw new Error("The mesh has no cells to contour.");
      const m = await loadMeshio();
      // Upstream: a NEGATIVE component means the row magnitude (the opposite sense to gradient's "all").
      const surf = m.isosurface(mesh, sanitizeVariable(spec.variable), spec.values, comp === "mag" ? -1 : comp, true) as MeshioMesh;
      if (surf.cells.length === 0 || surf.cells.every((c) => "data" in c && c.data.length === 0)) {
        throw new Error(`No isosurface: ${spec.variable} never crosses ${spec.values.join(", ")}.`);
      }
      const read = withSourceFields(model, meshioToModel(surf, diagnostics), "iso_parent_cell", {
        iso_value: "ISO_VALUE",
        iso_index: "ISO_INDEX",
      });
      const n = read.blocks.reduce((s, b) => s + b.count, 0);
      return {
        model: read,
        summary: `Isosurface of ${spec.variable}${comp === "mag" ? "" : `[${comp}]`} at ${spec.values.join(", ")}: ${n} cell(s), carrying ISO_VALUE, ISO_INDEX and the interpolated nodal fields${comp === "mag" && field.components > 1 ? " (magnitude contours are approximate)" : ""}.`,
        suffix: "iso",
      };
    }
    case "decimate": {
      const r = await decimateModel(model, spec, diagnostics);
      const pct = (100 * r.reduction).toPrecision(3);
      const err = Math.sqrt(r.maxErrorApplied);
      return {
        model: r.model,
        summary:
          `Decimated ${r.facesBefore} → ${r.facesAfter} faces (${pct}% removed), ${r.pointsBefore} → ${r.pointsAfter} nodes. ` +
          `Largest collapse error ${err.toPrecision(3)} (${(100 * r.relativeError).toPrecision(2)}% of the bounding-box diagonal). ` +
          `Surviving faces keep their entity ids, property ids and cell-field values; a node keeps the lowest id merged into it, and its nodal fields are upstream's blend of the endpoints (an approximation for optimal placement).` +
          (r.warnings.length ? ` ${r.warnings.join(" ")}` : ""),
        suffix: "decimated",
      };
    }
    case "threshold": {
      const field = model.fields.find((f) => f.kind === spec.fieldKind && f.variable === spec.variable);
      if (!field) throw new Error(`No ${spec.fieldKind} field named "${spec.variable}".`);
      if ((spec.range === undefined) === (spec.normalized === undefined)) {
        throw new Error("Give either an absolute `range` or a `normalized` window with its reference range, not both or neither.");
      }
      const comp = spec.component ?? "mag";
      if (comp !== "mag" && (comp < 0 || comp >= Math.max(1, field.components))) throw new Error(`"${spec.variable}" has no component ${comp}.`);
      let range: [number, number];
      let basis = "";
      if (spec.range) {
        if (!spec.range.every(Number.isFinite)) throw new Error("The threshold range must be finite.");
        range = spec.range;
      } else {
        const n = spec.normalized!;
        if (!n.range.every(Number.isFinite)) throw new Error("The normalized window must be finite.");
        const ref = n.reference === "frame" ? computeFieldRange(field, field.components > 1 ? comp : "mag") : n.reference;
        if (!ref.every(Number.isFinite) || !(ref[1] > ref[0])) throw new Error("The reference range must be finite with hi > lo.");
        range = [ref[0] + n.range[0] * (ref[1] - ref[0]), ref[0] + n.range[1] * (ref[1] - ref[0])];
        basis =
          n.reference === "frame"
            ? ` (normalized against THIS frame's own range [${ref[0]}, ${ref[1]}] — a per-frame threshold, not a fixed physical one)`
            : ` (normalized ${n.range[0]}–${n.range[1]} of the fixed reference [${ref[0]}, ${ref[1]}])`;
      }
      const lo = Math.min(range[0], range[1]);
      const hi = Math.max(range[0], range[1]);
      const passing = thresholdCells(model, field, field.components > 1 ? comp : "mag", [lo, hi], spec.rule ?? "all");
      if (passing.elementIds.length === 0) throw new Error(`No element has ${spec.variable} in [${lo}, ${hi}].`);
      const total = elementMeasures(model);
      const keep = new Set(passing.elementIds);
      let all = 0;
      let kept = 0;
      for (const [id, v] of total.measure) {
        all += v;
        if (keep.has(id)) kept += v;
      }
      const totalElements = model.blocks.filter((b) => b.kind === "Elements").reduce((s, b) => s + b.count, 0);
      const region = restrictToElements(model, keep);
      const unit = total.dimension === 3 ? "volume" : total.dimension === 2 ? "area" : "length";
      const fraction = all > 0 ? ` — ${((100 * kept) / all).toPrecision(3)}% of the ${unit}` : "";
      let outModel = region.model;
      let skinNote = "";
      if ((spec.output ?? "region") === "skin") {
        const skin = extractSkinModel(region.model);
        if (skin.faces === 0) throw new Error("The selected region has no boundary faces to extract.");
        outModel = skin.model;
        skinNote = ` Boundary surface of that region: ${skin.faces} face(s) (new ids).`;
      }
      const cons = region.droppedConstraints > 0 ? ` ${region.droppedConstraints} constraint(s) reaching outside the region were dropped.` : "";
      return {
        model: outModel,
        summary:
          `Threshold ${spec.variable} ∈ [${lo}, ${hi}]${basis}${field.kind === "Nodal" ? ` (${spec.rule ?? "all"} nodes)` : ""}: ` +
          `${region.keptElements} of ${totalElements} element(s)${fraction}.${skinNote}${cons}`,
        suffix: (spec.output ?? "region") === "skin" ? "threshold_skin" : "threshold",
      };
    }
  }
}

