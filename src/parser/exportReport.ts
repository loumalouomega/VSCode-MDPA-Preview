/**
 * The structured EXPORT REPORT (roadmap item 6): what survived one particular
 * write, in a shape the extension UI and the MCP tools share.
 *
 * Before this the account of an export was scattered: `exportEligibility`
 * refusals, the writers' `onWarning` strings, `modelToMeshio` diagnostics, and
 * prose in docblocks. Those tell a reader *that* something happened; they do not
 * say, per kind of data, whether it made it into the file. This module does.
 *
 * Two principles carry the design, and both come from the roadmap:
 *
 *  1. **Nothing is `retained` on a guess.** A category's expected status for a
 *     format comes from `FORMAT_FIDELITY`, whose rows are *measured* — the
 *     `exportReport.test.ts` matrix writes a fixture through each listed format,
 *     re-reads it and asserts the table equals what `observeExport` found. A
 *     format with no row reports `unverified`, which is a statement about our
 *     knowledge, not about the file.
 *  2. **The report is checkable.** `observeExport` compares an original model
 *     with a re-read of the output and `verifyReport` grades every claim against
 *     it. That is the same function the tests use, exposed to MCP as `verify`.
 *
 * Pure (no `vscode`/DOM/`fs`/wasm), so the extension host, the MCP server and the
 * tests build the identical report from the same inputs — a UI helper and a tool
 * cannot describe the same export differently.
 */

import type { FieldData, MdpaModel, SubModelPart } from "./types";
import { isNativeExportExtension } from "./writers/exportFormats";
import { MESHIO_WRITE_FORMAT } from "./meshioFormats";
import { EXPORT_FIDELITY_TABLE, MEASURED_CELL_TYPES } from "./exportFidelityTable";
import { EXPORT_REFERENCES } from "./exportReferences";

export const EXPORT_REPORT_VERSION = 1;

/**
 * `retained` — present in the output as it was; `transformed` — present but
 * changed (renumbered, renamed, reordered, narrowed); `omitted` — absent from
 * the output; `unverified` — nothing has established which of those it is.
 */
export type ReportStatus = "retained" | "transformed" | "omitted" | "unverified";

/** The fixed categories; per-field entries use `field:<kind>:<variable>`. */
export type BaseCategory =
  | "nodes"
  | "nodeIds"
  | "connectivity"
  | "entityIds"
  | "blocks"
  | "properties"
  | "constraints"
  | "subModelParts"
  | "fieldDimensions"
  | "globals"
  | "source";

export const BASE_CATEGORIES: readonly BaseCategory[] = [
  "nodes",
  "nodeIds",
  "connectivity",
  "entityIds",
  "blocks",
  "properties",
  "constraints",
  "subModelParts",
  "fieldDimensions",
  "globals",
  "source",
];

const CATEGORY_LABELS: Record<BaseCategory, string> = {
  nodes: "Node coordinates",
  nodeIds: "Node ids",
  connectivity: "Cell connectivity",
  entityIds: "Element/Condition/Geometry ids",
  blocks: "Block names and kinds",
  properties: "Properties",
  constraints: "Constraints",
  subModelParts: "SubModelParts",
  fieldDimensions: "Field dimensions",
  globals: "Global variables",
  source: "Source metadata",
};

export interface ReportCategory {
  /** A `BaseCategory`, or `field:<kind>:<variable>` for one field. */
  id: string;
  label: string;
  status: ReportStatus;
  detail?: string;
  /** How many items of this category the exported model carried. */
  count?: number;
  /** Set by `verifyReport`: did a re-read of the output agree with `status`? */
  verified?: boolean;
}

export interface ReportProvenance {
  /** True when the kernel wrote a provenance block into the file itself (only some formats have a slot). */
  embedded: boolean;
  /** File name (beside the output) of the sidecar report, when one was written. */
  sidecar?: string;
  /** Why provenance is where it is — e.g. that the format has no header slot. */
  note?: string;
}

export interface ExportReport {
  version: number;
  source: { file?: string; format?: string };
  target: {
    file: string;
    /** The extension the file was written as. */
    format: string;
    /** The meshio++ writer key, or `native` for one of our own writers. */
    writer: string;
    companions: string[];
  };
  kernel: { name: "meshio++"; version?: string; backend?: string };
  operations: ReportOperation[];
  categories: ReportCategory[];
  /** Everything the writers and eligibility checks said, in order. */
  warnings: string[];
  provenance: ReportProvenance;
  /** Filled by `verifyReport`: claims the re-read contradicted. Empty means none. */
  unexpected?: string[];
}

export interface ReportOperation {
  op: string;
  label?: string;
  parameters?: unknown;
}

// ---------------------------------------------------------------------------
// Expected fidelity per writer
// ---------------------------------------------------------------------------

const STATUS_OF_CODE = { r: "retained", t: "transformed", o: "omitted" } as const;

/** Categories whose status depends on which cell types the mesh holds. */
const CELL_TYPE_DEPENDENT: ReadonlySet<string> = new Set(["connectivity", "entityIds", "blocks"]);

/** What the measurement of a writer says about one category (or one field shape). */
export interface Expectation {
  status: Exclude<ReportStatus, "unverified"> | "unverified";
  detail?: string;
}

const DEFAULT_DETAIL: Record<string, Partial<Record<"transformed" | "omitted", string>>> = {
  nodeIds: { transformed: "the format numbers nodes by position, so the source's ids are regenerated when the file is read" },
  entityIds: { transformed: "the format does not store Element/Condition/Geometry ids, so they are regenerated when the file is read" },
  blocks: { transformed: "block names and kinds are rebuilt from cell types when the file is read" },
  subModelParts: { transformed: "kept as named groups, but not as the same tree or membership when the file is read back" },
  connectivity: { transformed: "cells are rewritten (dropped or split) by this format" },
  properties: { omitted: "the format has no place for Properties" },
  constraints: { omitted: "the format has no place for constraints" },
  subModelParts_o: { omitted: "the format has no named groups" },
  globals: { omitted: "global variable specs are extension state, not file content" },
  source: { omitted: "source metadata describes the file as read; it is not written" },
  fieldDimensions: { omitted: "the format cannot record field dimensions" },
};

function detailFor(category: string, status: string): string | undefined {
  if (status !== "transformed" && status !== "omitted") return undefined;
  const key = category === "subModelParts" && status === "omitted" ? "subModelParts_o" : category;
  return DEFAULT_DETAIL[key]?.[status as "transformed" | "omitted"];
}

/**
 * What measurement says a writer does with `category`, for THIS model: a
 * cell-type dependent category is only claimed when every block's type was in
 * the measured reference, and a field only when its kind and width were.
 */
export function expectedFor(
  key: string,
  category: string,
  model: MdpaModel,
  field?: FieldData
): Expectation {
  const entry = EXPORT_FIDELITY_TABLE[key];
  if (!entry) return { status: "unverified", detail: "this writer has not been measured" };
  const covering = Object.entries(EXPORT_REFERENCES).filter(([, r]) => model.blocks.every((b) => b.vtkCellType !== undefined && r.cellTypes.includes(b.vtkCellType)));
  // Prefer the narrowest matching fixture; do not use a tetra+triangle loss to
  // describe a tetra-only writer, or extrapolate to a mixed hex/tet mesh.
  const narrowest = Math.min(...covering.map(([, r]) => r.cellTypes.length));
  const ids = covering.length ? covering.filter(([, r]) => r.cellTypes.length === narrowest).map(([id]) => id) : Object.keys(EXPORT_REFERENCES);
  if (!covering.length && (CELL_TYPE_DEPENDENT.has(category) || field)) return { status: "unverified", detail: "cell type the measurement did not cover together in one reference" };
  const rows = ids.map((id) => entry.references[id]);
  const failure = rows.find((r) => r && "unmeasured" in r);
  if (failure || rows.some((r) => !r)) return { status: "unverified", detail: `not measurable on the reference mesh (${ids.join(", ")}): ${failure && "unmeasured" in failure ? failure.unmeasured : "no measurement"}` };
  const codes = rows.map((r) => "unmeasured" in r ? undefined : field ? r.fields[`${field.kind}:${field.components}`] : r.base[category]);
  if (codes.some((c) => !c)) return { status: "unverified", detail: field ? `no measurement for a ${field.components}-component ${field.kind.toLowerCase()} field` : "not covered by the measurement" };
  if (codes.some((c) => c !== codes[0])) return { status: "unverified", detail: "reference meshes disagree; verify this output by re-reading it" };
  const status = STATUS_OF_CODE[codes[0]!];
  return { status, detail: detailFor(category, status) };
}

/** The row for an export, if the format has been measured. */
export function fidelityKey(ext: string, format?: string): string {
  const e = ext.toLowerCase();
  if (!format && isNativeExportExtension(e)) return e;
  return format ?? MESHIO_WRITE_FORMAT[e] ?? e;
}

// ---------------------------------------------------------------------------
// Comparing a model with a re-read of its export
// ---------------------------------------------------------------------------

export interface Observation {
  id: string;
  status: Exclude<ReportStatus, "unverified">;
  detail?: string;
}

const ABS_TOL = 1e-6;
const REL_TOL = 1e-4;

function close(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= ABS_TOL + REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

/** A coordinate key stable under float32 storage and ascii rounding. */
function coordKey(coords: ArrayLike<number>, i: number): string {
  const q = (v: number) => {
    const r = Math.round(v * 1e4) / 1e4;
    return Object.is(r, -0) ? "0" : String(r);
  };
  return `${q(coords[3 * i])},${q(coords[3 * i + 1])},${q(coords[3 * i + 2])}`;
}

/** Canonical JSON: sorted keys, typed arrays as arrays — for comparing plain model data. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (ArrayBuffer.isView(val)) return Array.from(val as unknown as ArrayLike<number>);
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o: Record<string, unknown> = {};
      for (const key of Object.keys(val as object).sort()) o[key] = (val as Record<string, unknown>)[key];
      return o;
    }
    return val;
  });
}

function cellSignatures(model: MdpaModel): Map<string, number> {
  const keys = new Array<string>(model.nodeCount);
  const byId = new Map<number, string>();
  for (let i = 0; i < model.nodeCount; i++) {
    keys[i] = coordKey(model.coords, i);
    byId.set(model.nodeIds[i], keys[i]);
  }
  const sigs = new Map<string, number>();
  for (const b of model.blocks) {
    for (let c = 0; c < b.count; c++) {
      const corners: string[] = [];
      for (let k = 0; k < b.stride; k++) corners.push(byId.get(b.connectivity[c * b.stride + k]) ?? "?");
      corners.sort();
      const sig = `${b.vtkCellType ?? -1}|${corners.join(";")}`;
      sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
    }
  }
  return sigs;
}

function cellTotal(model: MdpaModel): number {
  return model.blocks.reduce((s, b) => s + b.count, 0);
}

function sameSigs(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, n] of a) if (b.get(k) !== n) return false;
  return true;
}

function idSet(model: MdpaModel, kind: "Elements" | "Conditions" | "Geometries"): number[] {
  const out: number[] = [];
  for (const b of model.blocks) if (b.kind === kind) for (let i = 0; i < b.count; i++) out.push(b.entityIds[i]);
  return out.sort((x, y) => x - y);
}

function flattenParts(parts: SubModelPart[], out: SubModelPart[] = []): SubModelPart[] {
  for (const p of parts) {
    out.push(p);
    flattenParts(p.children, out);
  }
  return out;
}

function partShape(p: SubModelPart): string {
  return [p.nodeIds, p.elementIds, p.conditionIds, p.geometryIds, p.constraintIds].map((a) => a.length).join("/");
}

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i])) return false;
  return true;
}

/**
 * Compares the source model with a re-read of the file that was written from it.
 * Only categories the source actually carries are returned — a mesh with no
 * Properties has nothing to retain, and reporting "omitted" for it would be
 * noise, not information.
 */
export function observeExport(original: MdpaModel, reread: MdpaModel): Observation[] {
  const out: Observation[] = [];

  // --- nodes ---------------------------------------------------------------
  {
    const same =
      reread.nodeCount === original.nodeCount &&
      sameNumbers(
        original.coords.subarray(0, 3 * original.nodeCount),
        reread.coords.subarray(0, 3 * reread.nodeCount)
      );
    if (same) out.push({ id: "nodes", status: "retained" });
    else if (reread.nodeCount === 0) out.push({ id: "nodes", status: "omitted" });
    else {
      const a = new Map<string, number>();
      const b = new Map<string, number>();
      for (let i = 0; i < original.nodeCount; i++) a.set(coordKey(original.coords, i), (a.get(coordKey(original.coords, i)) ?? 0) + 1);
      for (let i = 0; i < reread.nodeCount; i++) b.set(coordKey(reread.coords, i), (b.get(coordKey(reread.coords, i)) ?? 0) + 1);
      out.push({
        id: "nodes",
        status: "transformed",
        detail: sameSigs(a, b)
          ? "same points, stored in a different order"
          : `${original.nodeCount} nodes became ${reread.nodeCount}`,
      });
    }
  }

  // --- node ids ------------------------------------------------------------
  {
    const rereadById = new Map<number, string>();
    for (let i = 0; i < reread.nodeCount; i++) rereadById.set(reread.nodeIds[i], coordKey(reread.coords, i));
    let ok = original.nodeCount > 0;
    for (let i = 0; ok && i < original.nodeCount; i++) {
      if (rereadById.get(original.nodeIds[i]) !== coordKey(original.coords, i)) ok = false;
    }
    if (ok) out.push({ id: "nodeIds", status: "retained" });
    else if (reread.nodeCount === 0) out.push({ id: "nodeIds", status: "omitted" });
    else out.push({ id: "nodeIds", status: "transformed", detail: "the file's node ids are not the source's" });
  }

  // --- connectivity --------------------------------------------------------
  const srcCells = cellTotal(original);
  const rerCells = cellTotal(reread);
  let cellsRetained = false;
  if (srcCells > 0) {
    if (sameSigs(cellSignatures(original), cellSignatures(reread))) {
      cellsRetained = true;
      out.push({ id: "connectivity", status: "retained" });
    } else if (rerCells === 0) out.push({ id: "connectivity", status: "omitted" });
    else
      out.push({
        id: "connectivity",
        status: "transformed",
        detail: rerCells === srcCells ? "cells were rewritten (type or nodes changed)" : `${srcCells} cells became ${rerCells}`,
      });

    // --- entity ids (three independent id spaces) ---------------------------
    const mismatched: string[] = [];
    for (const kind of ["Elements", "Conditions", "Geometries"] as const) {
      const a = idSet(original, kind);
      if (a.length === 0) continue;
      const b = idSet(reread, kind);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) mismatched.push(kind);
    }
    if (rerCells === 0) out.push({ id: "entityIds", status: "omitted" });
    else if (mismatched.length === 0 && cellsRetained) out.push({ id: "entityIds", status: "retained" });
    else
      out.push({
        id: "entityIds",
        status: "transformed",
        detail: mismatched.length ? `ids differ for ${mismatched.join(", ")}` : "cells changed, so their ids could not be kept",
      });

    // --- blocks --------------------------------------------------------------
    const names = (m: MdpaModel) => m.blocks.map((b) => `${b.kind}:${b.name}`).sort();
    const na = names(original);
    const nb = names(reread);
    if (rerCells === 0) out.push({ id: "blocks", status: "omitted" });
    else if (na.length === nb.length && na.every((v, i) => v === nb[i])) out.push({ id: "blocks", status: "retained" });
    else out.push({ id: "blocks", status: "transformed", detail: "block names or kinds were regenerated" });
  }

  // --- properties ----------------------------------------------------------
  if (original.properties?.length) {
    const rp = reread.properties ?? [];
    if (rp.length === 0) out.push({ id: "properties", status: "omitted" });
    else if (canon(original.properties) === canon(rp)) out.push({ id: "properties", status: "retained" });
    else out.push({ id: "properties", status: "transformed", detail: `${original.properties.length} sets became ${rp.length}, or their values changed` });
  }

  // --- constraints ---------------------------------------------------------
  if (original.constraints?.length) {
    const rc = reread.constraints ?? [];
    if (rc.length === 0) out.push({ id: "constraints", status: "omitted" });
    else if (canon(original.constraints) === canon(rc)) out.push({ id: "constraints", status: "retained" });
    else out.push({ id: "constraints", status: "transformed", detail: "rows or columns differ after re-reading" });
  }

  // --- SubModelParts -------------------------------------------------------
  // Formats that keep groups at all keep them as named sets, often flattened
  // ("Outer/Inner" written as "Outer.Inner"), so a part is looked for by its
  // path first and its dotted spelling second. A part found by neither is gone,
  // however many block-derived groups the file adds of its own.
  if (original.subModelParts.length) {
    const a = flattenParts(original.subModelParts);
    const b = flattenParts(reread.subModelParts);
    const exact = new Map(b.map((q) => [q.path, q]));
    const missing: string[] = [];
    const flattened: string[] = [];
    let shapesEqual = true;
    for (const p of a) {
      const q = exact.get(p.path);
      if (q) {
        if (partShape(p) !== partShape(q)) shapesEqual = false;
        continue;
      }
      const dotted = exact.get(p.path.split("/").join("."));
      if (dotted) flattened.push(p.path);
      else missing.push(p.path);
    }
    if (missing.length === a.length) {
      out.push({ id: "subModelParts", status: "omitted", detail: "no part of the source is in the file under its own name" });
    } else if (missing.length === 0 && flattened.length === 0 && shapesEqual) {
      out.push({ id: "subModelParts", status: "retained" });
    } else {
      const bits: string[] = [];
      if (flattened.length) bits.push(`flattened to dotted names: ${flattened.join(", ")}`);
      if (missing.length) bits.push(`not in the file: ${missing.join(", ")}`);
      if (!bits.length) bits.push("membership differs after re-reading");
      out.push({ id: "subModelParts", status: "transformed", detail: bits.join("; ") });
    }
  }

  // --- fields --------------------------------------------------------------
  const rereadIdsSame = out.find((o) => o.id === "nodeIds")?.status === "retained";
  for (const f of original.fields) {
    const id = `field:${f.kind}:${f.variable}`;
    const cand = reread.fields.filter((r) => r.variable === f.variable);
    const exact = cand.find((r) => r.kind === f.kind);
    if (cand.length === 0) {
      out.push({ id, status: "omitted" });
      continue;
    }
    const r = exact ?? cand[0];
    if (!exact) {
      out.push({ id, status: "transformed", detail: `re-read as ${r.kind}` });
    } else if (r.components !== f.components) {
      out.push({ id, status: "transformed", detail: `${f.components} components became ${r.components}` });
    } else if (fieldValuesEqual(f, r, rereadIdsSame)) {
      out.push({ id, status: "retained" });
    } else {
      out.push({ id, status: "transformed", detail: "values or coverage differ after re-reading" });
    }
  }
  if (original.fields.some((f) => f.dimensions)) {
    const bad: string[] = [];
    for (const f of original.fields) {
      if (!f.dimensions) continue;
      const r = reread.fields.find((x) => x.variable === f.variable);
      if (!r?.dimensions || canon(r.dimensions.exponents) !== canon(f.dimensions.exponents)) bad.push(f.variable);
    }
    out.push(
      bad.length === 0
        ? { id: "fieldDimensions", status: "retained" }
        : { id: "fieldDimensions", status: "omitted", detail: `not recovered for ${bad.join(", ")}` }
    );
  }

  // --- globals / source ----------------------------------------------------
  if (original.globals && Object.keys(original.globals).length) {
    out.push(
      reread.globals && canon(reread.globals) === canon(original.globals)
        ? { id: "globals", status: "retained" }
        : { id: "globals", status: "omitted" }
    );
  }
  if (original.source) {
    out.push(
      reread.source && canon(reread.source) === canon(original.source)
        ? { id: "source", status: "retained" }
        : { id: "source", status: "omitted" }
    );
  }
  return out;
}

function fieldValuesEqual(a: FieldData, b: FieldData, idsRetained: boolean): boolean {
  if (a.ids.length !== b.ids.length) return false;
  const w = a.components;
  if (idsRetained) {
    const pos = new Map<number, number>();
    for (let i = 0; i < b.ids.length; i++) pos.set(b.ids[i], i);
    for (let i = 0; i < a.ids.length; i++) {
      const j = pos.get(a.ids[i]);
      if (j === undefined) return false;
      for (let c = 0; c < w; c++) if (!close(a.values[i * w + c], b.values[j * w + c])) return false;
    }
    return true;
  }
  return sameNumbers(a.values, b.values);
}

// ---------------------------------------------------------------------------
// Building and grading a report
// ---------------------------------------------------------------------------

export interface ExportReportInput {
  /** The model that was WRITTEN (after any ops), not the file it was opened from. */
  model: MdpaModel;
  /** Output extension (e.g. `.med`). */
  ext: string;
  /** Explicit meshio++ writer key, when the caller forced one. */
  format?: string;
  /** Output file name (a base name; the report never stores machine-absolute paths). */
  targetFile: string;
  companions?: string[];
  sourceFile?: string;
  sourceFormat?: string;
  /** Applied operations, in order. */
  ops?: ReportOperation[];
  warnings?: string[];
  kernelVersion?: string;
  kernelBackend?: string;
  provenance?: ReportProvenance;
}

/** Which categories a model carries — the ones a report has anything to say about. */
export function applicableCategories(model: MdpaModel): ReportCategory[] {
  const out: ReportCategory[] = [];
  const add = (id: BaseCategory, count?: number) =>
    out.push({ id, label: CATEGORY_LABELS[id], status: "unverified", count });
  add("nodes", model.nodeCount);
  add("nodeIds", model.nodeCount);
  const cells = cellTotal(model);
  if (cells > 0) {
    add("connectivity", cells);
    add("entityIds", cells);
    add("blocks", model.blocks.length);
  }
  if (model.properties?.length) add("properties", model.properties.length);
  if (model.constraints?.length) add("constraints", model.constraints.reduce((s, b) => s + b.rows.length, 0));
  if (model.subModelParts.length) add("subModelParts", flattenParts(model.subModelParts).length);
  // One entry per field, named with its kind and width so the report reads on its own.
  for (const f of model.fields) {
    out.push({
      id: `field:${f.kind}:${f.variable}`,
      label: `${f.variable} (${f.kind.toLowerCase()}, ${f.components} component${f.components === 1 ? "" : "s"})`,
      status: "unverified",
      count: f.ids.length,
    });
  }
  if (model.fields.some((f) => f.dimensions)) add("fieldDimensions", model.fields.filter((f) => f.dimensions).length);
  if (model.globals && Object.keys(model.globals).length) add("globals", Object.keys(model.globals).length);
  if (model.source) add("source");
  return out;
}

/**
 * Builds the report for one write. Statuses come from the measured
 * `EXPORT_FIDELITY_TABLE` through `expectedFor`; anything the measurement does
 * not cover for this model stays `unverified`, with the reason in `detail`.
 */
export function buildExportReport(input: ExportReportInput): ExportReport {
  const key = fidelityKey(input.ext, input.format);
  const categories = applicableCategories(input.model).map((c) => {
    const field = c.id.startsWith("field:")
      ? input.model.fields.find((f) => `field:${f.kind}:${f.variable}` === c.id)
      : undefined;
    const e = expectedFor(key, c.id, input.model, field);
    return { ...c, status: e.status, ...(e.detail ? { detail: e.detail } : {}) };
  });
  return {
    version: EXPORT_REPORT_VERSION,
    source: { file: input.sourceFile, format: input.sourceFormat },
    target: {
      file: input.targetFile,
      format: input.ext.toLowerCase(),
      writer: !input.format && isNativeExportExtension(input.ext) ? "native" : key,
      companions: input.companions ?? [],
    },
    kernel: { name: "meshio++", version: input.kernelVersion, backend: input.kernelBackend },
    operations: input.ops ?? [],
    categories,
    warnings: input.warnings ?? [],
    provenance: input.provenance ?? { embedded: false },
  };
}

/**
 * Grades every claim in `report` against what a re-read found. A claim the
 * re-read contradicts is `verified: false` and named in `unexpected` — that is
 * the regression signal, as opposed to an ordinary format limit, which the
 * table already states. An `unverified` claim is replaced by the observation,
 * since the check just established it.
 */
export function verifyReport(report: ExportReport, observed: Observation[]): ExportReport {
  const byId = new Map(observed.map((o) => [o.id, o]));
  const unexpected: string[] = [];
  const categories = report.categories.map((c) => {
    const o = byId.get(c.id);
    if (!o) return c;
    if (c.status === "unverified") return { ...c, status: o.status, detail: o.detail ?? c.detail, verified: true };
    if (c.status === o.status) return { ...c, verified: true };
    unexpected.push(`${c.label}: expected ${c.status}, re-read found ${o.status}${o.detail ? ` (${o.detail})` : ""}`);
    return { ...c, verified: false, detail: o.detail ?? c.detail };
  });
  return { ...report, categories, unexpected };
}

// ---------------------------------------------------------------------------
// Presentation and files
// ---------------------------------------------------------------------------

/** `<output>.kratosexport.json`, named after the FILE so the association is unambiguous. */
export function sidecarFileName(outputBaseName: string): string {
  return `${outputBaseName}.kratosexport.json`;
}

export function serializeReport(report: ExportReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** A bypass writer must not borrow single-mesh measurements for another path. */
export function buildUnverifiedReport(input: Omit<ExportReportInput, "model"> & { model?: MdpaModel }, reason: string): ExportReport {
  const categories: ReportCategory[] = input.model ? applicableCategories(input.model) : [{ id: "payload", label: "Mesh and field payload", status: "unverified" }];
  return {
    version: EXPORT_REPORT_VERSION,
    source: { file: input.sourceFile, format: input.sourceFormat },
    target: { file: input.targetFile, format: input.ext, writer: input.format ?? input.ext, companions: input.companions ?? [] },
    kernel: { name: "meshio++", version: input.kernelVersion, backend: input.kernelBackend },
    operations: input.ops ?? [], categories: categories.map((c) => ({ ...c, status: "unverified", detail: reason })),
    warnings: input.warnings ?? [], provenance: input.provenance ?? { embedded: false },
  };
}

/** Bounded per-step roll-up: category ids still identify each field/loss. */
export function compactExportReport(report: ExportReport) {
  const statuses = (status: ReportStatus) => report.categories.filter((c) => c.status === status).map((c) => c.id);
  const compact = {
    file: report.target.file, format: report.target.format, writer: report.target.writer,
    operations: report.operations,
    source: report.source, companions: report.target.companions, kernel: report.kernel,
    retained: statuses("retained"), transformed: statuses("transformed"), omitted: statuses("omitted"), unverified: statuses("unverified"),
    details: Object.fromEntries(report.categories.filter((c) => c.detail).map((c) => [c.id, c.detail])),
    warnings: report.warnings, unexpected: report.unexpected, provenance: report.provenance,
  };
  // The collection API is a JSON boundary; omit undefined optional keys even
  // in nested metadata, so the in-process and serialized replies agree.
  return JSON.parse(JSON.stringify(compact)) as typeof compact;
}

export type CompactExportReport = ReturnType<typeof compactExportReport>;

/** One associated sidecar for a series, rather than thousands of tiny files. */
export function seriesReportSidecar(targetFile: string, reports: CompactExportReport[], mode: ProvenanceMode): { name: string; text: string } | undefined {
  if (mode !== "sidecar") return undefined;
  const name = sidecarFileName(targetFile);
  for (const report of reports) report.provenance = { ...report.provenance, sidecar: name };
  return { name, text: JSON.stringify({ version: EXPORT_REPORT_VERSION, target: { file: targetFile }, reports }, null, 2) + "\n" };
}

/** Presentation adapter; compact ids are labels when a series has no model. */
export function expandCompactReport(report: CompactExportReport): ExportReport {
  return { version: EXPORT_REPORT_VERSION, source: report.source, target: { file: report.file, format: report.format, writer: report.writer, companions: report.companions }, kernel: report.kernel, operations: report.operations, warnings: report.warnings, provenance: report.provenance, unexpected: report.unexpected,
    categories: (["retained", "transformed", "omitted", "unverified"] as ReportStatus[]).flatMap((status) => report[status].map((id) => ({ id, label: CATEGORY_LABELS[id as BaseCategory] ?? id, status, detail: report.details[id] }))),
  };
}

/** One line for a notification: what did not come through, or that nothing is known to have been lost. */
export function summarizeReport(report: ExportReport): string {
  const counts: Record<ReportStatus, number> = { retained: 0, transformed: 0, omitted: 0, unverified: 0 };
  for (const c of report.categories) counts[c.status]++;
  const lost = report.categories.filter((c) => c.status === "omitted" || c.status === "transformed");
  const parts = [`${counts.retained} retained`];
  if (counts.transformed) parts.push(`${counts.transformed} transformed`);
  if (counts.omitted) parts.push(`${counts.omitted} omitted`);
  if (counts.unverified) parts.push(`${counts.unverified} unverified`);
  const names = lost.slice(0, 4).map((c) => c.label.toLowerCase());
  return `${parts.join(", ")}${names.length ? ` — ${names.join(", ")}${lost.length > 4 ? ", …" : ""}` : ""}`;
}

// ---------------------------------------------------------------------------
// Provenance requests and the finished report
// ---------------------------------------------------------------------------

/**
 * `auto` — embed where the format has a header slot, write nothing else;
 * `sidecar` — also (always) write `<output>.kratosexport.json`; `none` — no
 * provenance and no sidecar. The report itself is always returned/shown.
 */
export type ProvenanceMode = "auto" | "sidecar" | "none";

export const PROVENANCE_MODES: readonly ProvenanceMode[] = ["auto", "sidecar", "none"];

export interface ProvenanceInfo {
  sourceFile?: string;
  sourceFormat?: string;
  ops?: ReportOperation[];
  /** e.g. `Kratos MDPA Preview 4.17.0`. */
  tool?: string;
  kernelVersion?: string;
}

/**
 * What to hand the kernel so it can embed provenance: the source and one note
 * each for the operation chain and the tool. Structurally a `ProvenanceRequest`
 * (meshio.ts); declared here so this module never imports the wasm loader.
 * `undefined` for `none`.
 */
export function provenanceRequest(
  mode: ProvenanceMode,
  info: ProvenanceInfo
): { source?: { file: string; format: string }; notes: { category: string; detail: string }[] } | undefined {
  if (mode === "none") return undefined;
  const notes: { category: string; detail: string }[] = [];
  if (info.ops?.length) notes.push({ category: "operations", detail: info.ops.map((o) => o.op).join(", ") });
  if (info.ops?.some((o) => Object.keys(o).some((k) => k !== "op" && k !== "label"))) notes.push({ category: "parameters", detail: JSON.stringify(info.ops) });
  if (info.tool) notes.push({ category: "tool", detail: info.tool });
  if (info.kernelVersion) notes.push({ category: "kernel", detail: `meshio++ ${info.kernelVersion}` });
  return {
    ...(info.sourceFile ? { source: { file: info.sourceFile, format: info.sourceFormat ?? "unknown" } } : {}),
    notes,
  };
}

/**
 * Settles where provenance ended up and produces the sidecar text when one is
 * due. `embedded` is what the kernel reported back, never an assumption: a
 * format without a header slot yields `embedded: false` and a note saying so,
 * which is what tells the user to ask for the sidecar.
 */
export function finalizeReport(
  report: ExportReport,
  mode: ProvenanceMode,
  embedded: boolean,
  isMeshioWriter: boolean
): { report: ExportReport; sidecar?: { name: string; text: string } } {
  const base = report.target.file.split(/[\\/]/).pop() ?? report.target.file;
  const provenance: ReportProvenance = { embedded: mode !== "none" && embedded };
  if (mode === "none") provenance.note = "provenance was switched off";
  else if (!embedded) {
    provenance.note = "this format has no header slot for a provenance block";
    if (mode === "auto") provenance.note += "; set provenance to \"sidecar\" to record it beside the file";
  }
  if (mode === "sidecar") provenance.sidecar = sidecarFileName(base);
  const finished = { ...report, provenance };
  return mode === "sidecar"
    ? { report: finished, sidecar: { name: provenance.sidecar as string, text: serializeReport(finished) } }
    : { report: finished };
}

// ---------------------------------------------------------------------------
// Capability listing
// ---------------------------------------------------------------------------

export interface ExportFidelityCapabilities {
  version: 2;
  /** What the measurement wrote: the cell types and field shapes a row speaks for. */
  measuredOn: { cellTypes: number[]; fields: string[]; note: string };
  references: typeof EXPORT_REFERENCES;
  writers: Record<
    string,
    | { references: Record<string, { categories: Record<string, Exclude<ReportStatus, "unverified">>; fields: Record<string, Exclude<ReportStatus, "unverified">> } | { unmeasured: string }> }
    | { unmeasured: string }
  >;
}

/** The measured table in words, for `mesh_capabilities`. */
export function exportFidelityCapabilities(): ExportFidelityCapabilities {
  const writers: ExportFidelityCapabilities["writers"] = {};
  const fieldShapes = new Set<string>();
  for (const [key, entry] of Object.entries(EXPORT_FIDELITY_TABLE)) {
    const references: Extract<ExportFidelityCapabilities["writers"][string], { references: unknown }>["references"] = {};
    for (const [id, row] of Object.entries(entry.references)) {
      if ("unmeasured" in row) { references[id] = row; continue; }
      const categories: Record<string, Exclude<ReportStatus, "unverified">> = {};
      for (const [c, code] of Object.entries(row.base)) if (code) categories[c] = STATUS_OF_CODE[code];
      const fields: Record<string, Exclude<ReportStatus, "unverified">> = {};
      for (const [f, code] of Object.entries(row.fields)) {
        fields[f] = STATUS_OF_CODE[code];
        fieldShapes.add(f);
      }
      references[id] = { categories, fields };
    }
    writers[key] = Object.values(references).every((r) => "unmeasured" in r) ? { unmeasured: Object.entries(references).map(([id, r]) => `${id}: ${"unmeasured" in r ? r.unmeasured : ""}`).join("; ") } : { references };
  }
  return {
    version: 2,
    references: EXPORT_REFERENCES,
    measuredOn: {
      cellTypes: [...MEASURED_CELL_TYPES],
      fields: [...fieldShapes].sort(),
      note:
        "Hex/quad, tetra/triangle, tetra-only and triangle-only fixtures. Claims use the narrowest covering reference; mixed or unknown topology and unmeasured field shapes stay unverified.",
    },
    writers,
  };
}
