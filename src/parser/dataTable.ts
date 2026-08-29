/**
 * The data table: every node/element/condition/geometry of a mesh as rows of
 * plain values — coordinates or connectivity, plus every field defined at that
 * entity — and the CSV serialization of the same.
 *
 * Pure: no vscode / DOM / vtk / node imports, so this module is bundled into
 * BOTH runtimes. That is not incidental. The webview panel and the host-side
 * exporter build their table from the same `prepareTable` and the same
 * serializable `TableOptions`, so "what I see" can never drift from "what I
 * exported" — the panel would otherwise have to ship its rows across
 * postMessage (hundreds of MB on a real mesh) for the host to write them.
 *
 * Nothing here computes: `coords`, `EntityBlock.connectivity` and every
 * `FieldData` are already keyed by id the moment a file is parsed. This is
 * layout and serialization over finished data.
 *
 * Two behaviours are stated rather than left to surprise:
 *
 *  - A field's columns appear only when a row of the requested kind actually
 *    carries a value for it. "Geometries have no fields" is false — a
 *    `partition` op attaches PARTITION_INDEX as ONE Elemental field whose ids
 *    span Elements, Conditions and Geometries alike — so the test is overlap,
 *    not kind. It also de-noises a table that would otherwise carry a wall of
 *    permanently blank columns.
 *  - Kratos gives each entity kind its own id space, so Element 1 and
 *    Geometry 1 are different entities that collide in one id→row map. A
 *    field spanning both therefore reads last-write-wins here — exactly as it
 *    already does in the Field panel and in Inspect (webview/fieldData.ts).
 *    Matching that is deliberate: a table disagreeing with the panel beside it
 *    would be worse than the shared ambiguity.
 */

import { EntityBlock, EntityKind, FieldBlockKind, FieldData, MdpaModel, SubModelPart } from "./types";
import type { MembershipIndex } from "./smpMembership";

export type TableKind = "Nodes" | "Elements" | "Conditions" | "Geometries";

export const TABLE_KINDS: TableKind[] = ["Nodes", "Elements", "Conditions", "Geometries"];

export function isTableKind(v: unknown): v is TableKind {
  return typeof v === "string" && (TABLE_KINDS as string[]).includes(v);
}

/** A cell's value. `undefined` is a BLANK — a field not covering this row —
 *  never a 0, which would be a number the mesh does not actually carry. */
export type CellValue = number | string | undefined;

/**
 * How a column serializes. `f32` exists because `MdpaModel.coords` is a
 * Float32Array: reading an element widens it to a double, so `String(v)` for a
 * stored 0.1 prints 0.10000000149011612 — noise in every coordinate of every
 * exported file.
 */
export type ColumnType = "id" | "f32" | "f64" | "text";

/** Serializable — it rides the menuExportTable message so the host rebuilds
 *  exactly the table the panel is showing. */
export interface TableOptions {
  /** Add a "SubModelParts" column (needs the `membership` argument). */
  membership?: boolean;
  /** Restrict rows to the SubModelPart at this dotted path, plus its subtree. */
  submodelpart?: string;
  /** Connectivity as n1..nMax columns instead of one space-joined cell. */
  nodeColumns?: boolean;
}

export interface TableView {
  kind: TableKind;
  columns: string[];
  columnTypes: ColumnType[];
  rowCount: number;
  /** Raw values, never formatted: display precision belongs to the panel and
   *  serialization precision to the writers, so they cannot disagree. */
  row(i: number): CellValue[];
  /** Allocation-free variant — the export path would otherwise allocate one
   *  short-lived array per row, millions of times. Returns `out`. */
  rowInto(i: number, out: CellValue[]): CellValue[];
}

// ---- helpers ----------------------------------------------------------------

const ENTITY_KIND_OF: Record<string, EntityKind> = {
  Elements: "Elements",
  Conditions: "Conditions",
  Geometries: "Geometries",
};

/**
 * Which FieldData kind a table of this entity kind can carry. There is no
 * "Geometrical" member of FieldBlockKind, and the one field that reaches
 * geometries in practice (PARTITION_INDEX) is written as Elemental, so
 * Geometries map there too and the overlap test does the rest.
 */
function fieldKindFor(kind: TableKind): FieldBlockKind {
  if (kind === "Nodes") return "Nodal";
  if (kind === "Conditions") return "Conditional";
  return "Elemental";
}

/** Depth-first lookup by dotted path. Local rather than imported from
 *  subModelPartExtract.ts, which reaches into the writer layer. */
function findPart(parts: SubModelPart[], path: string): SubModelPart | undefined {
  for (const p of parts) {
    if (p.path === path) return p;
    const hit = findPart(p.children, path);
    if (hit) return hit;
  }
  return undefined;
}

/** A part's own ids for `kind`, unioned with every descendant's. */
function subtreeIds(part: SubModelPart, kind: TableKind): Set<number> {
  const out = new Set<number>();
  const walk = (p: SubModelPart): void => {
    const ids =
      kind === "Nodes"
        ? p.nodeIds
        : kind === "Elements"
          ? p.elementIds
          : kind === "Conditions"
            ? p.conditionIds
            : p.geometryIds;
    for (let i = 0; i < ids.length; i++) out.add(ids[i]);
    for (const c of p.children) walk(c);
  };
  walk(part);
  return out;
}

/**
 * Column names for one field.
 *
 * Follows fieldCalc.ts's `NAME_X/_Y/_Z` convention but does NOT inherit its
 * `Math.min(components, 3)` cap: that cap is right for an expression scope and
 * wrong for a table, since `fieldHessian` emits a 9-component field and three
 * columns would silently drop six of them.
 */
function columnsForField(f: FieldData): string[] {
  if (f.components <= 1) return [f.variable];
  if (f.components <= 3) {
    return ["X", "Y", "Z"].slice(0, f.components).map((ax) => `${f.variable}_${ax}`);
  }
  const out: string[] = [];
  for (let c = 0; c < f.components; c++) out.push(`${f.variable}_${c}`);
  return out;
}

function indexById(f: FieldData): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < f.ids.length; i++) map.set(f.ids[i], i);
  return map;
}

interface PreparedField {
  field: FieldData;
  index: Map<number, number>;
  /** Index of this field's first column in `columns`. */
  at: number;
}

// ---- prepareTable -----------------------------------------------------------

/**
 * Builds a random-access view over one entity kind. Every id→index map is
 * built once here, so `row(i)` costs one lookup per column and no scanning.
 */
export function prepareTable(
  model: MdpaModel,
  kind: TableKind,
  opts: TableOptions = {},
  membership?: MembershipIndex
): TableView {
  const columns: string[] = [];
  const columnTypes: ColumnType[] = [];
  const push = (name: string, type: ColumnType): void => {
    columns.push(name);
    columnTypes.push(type);
  };

  const keep =
    opts.submodelpart
      ? (() => {
          const part = findPart(model.subModelParts, opts.submodelpart);
          return part ? subtreeIds(part, kind) : new Set<number>();
        })()
      : undefined;

  const wantParts = Boolean(opts.membership) && membership !== undefined;
  const partMap = wantParts
    ? kind === "Nodes"
      ? membership!.nodes
      : kind === "Elements"
        ? membership!.elements
        : kind === "Conditions"
          ? membership!.conditions
          : membership!.geometries
    : undefined;

  return kind === "Nodes"
    ? prepareNodeTable(model, opts, keep, partMap, columns, columnTypes, push)
    : prepareEntityTable(model, kind, opts, keep, partMap, columns, columnTypes, push);
}

function fieldsFor(
  model: MdpaModel,
  fieldKind: FieldBlockKind,
  columns: string[],
  push: (name: string, type: ColumnType) => void,
  /** Row count and row→id, used for the overlap test. Omitted for Nodes,
   *  where a Nodal field is unambiguously about nodes. */
  rows?: { count: number; idAt(i: number): number }
): PreparedField[] {
  const out: PreparedField[] = [];
  for (const field of model.fields) {
    if (field.kind !== fieldKind) continue;
    const index = indexById(field);
    if (rows && !covers(index, rows)) continue;
    const at = columns.length;
    for (const name of columnsForField(field)) push(name, "f64");
    out.push({ field, index, at });
  }
  return out;
}

/** Does any row of this kind carry a value for the field? Early-exits on the
 *  first hit, which for a field that genuinely belongs to this kind is row 0. */
function covers(index: Map<number, number>, rows: { count: number; idAt(i: number): number }): boolean {
  for (let i = 0; i < rows.count; i++) {
    if (index.has(rows.idAt(i))) return true;
  }
  return false;
}

function readFields(prep: PreparedField[], id: number, out: CellValue[]): void {
  for (const p of prep) {
    const row = p.index.get(id);
    const c = p.field.components;
    if (row === undefined) {
      for (let k = 0; k < c; k++) out[p.at + k] = undefined;
      continue;
    }
    const o = row * c;
    for (let k = 0; k < c; k++) out[p.at + k] = p.field.values[o + k];
  }
}

function prepareNodeTable(
  model: MdpaModel,
  _opts: TableOptions,
  keep: Set<number> | undefined,
  partMap: Map<number, string[]> | undefined,
  columns: string[],
  columnTypes: ColumnType[],
  push: (name: string, type: ColumnType) => void
): TableView {
  // Row i → index into nodeIds/coords. Materialized only when filtering.
  let rowIndex: Int32Array | undefined;
  if (keep) {
    const hits: number[] = [];
    for (let i = 0; i < model.nodeCount; i++) {
      if (keep.has(model.nodeIds[i])) hits.push(i);
    }
    rowIndex = Int32Array.from(hits);
  }
  const rowCount = rowIndex ? rowIndex.length : model.nodeCount;
  const nodeIndex = (i: number): number => (rowIndex ? rowIndex[i] : i);

  push("id", "id");
  push("x", "f32");
  push("y", "f32");
  push("z", "f32");
  if (partMap) push("SubModelParts", "text");
  const partsAt = partMap ? columns.length - 1 : -1;
  const fields = fieldsFor(model, "Nodal", columns, push);

  const rowInto = (i: number, out: CellValue[]): CellValue[] => {
    const n = nodeIndex(i);
    const id = model.nodeIds[n];
    out[0] = id;
    out[1] = model.coords[n * 3];
    out[2] = model.coords[n * 3 + 1];
    out[3] = model.coords[n * 3 + 2];
    if (partMap) out[partsAt] = (partMap.get(id) ?? []).join(";");
    readFields(fields, id, out);
    return out;
  };

  return {
    kind: "Nodes",
    columns,
    columnTypes,
    rowCount,
    row: (i) => rowInto(i, new Array<CellValue>(columns.length)),
    rowInto,
  };
}

function prepareEntityTable(
  model: MdpaModel,
  kind: TableKind,
  opts: TableOptions,
  keep: Set<number> | undefined,
  partMap: Map<number, string[]> | undefined,
  columns: string[],
  columnTypes: ColumnType[],
  push: (name: string, type: ColumnType) => void
): TableView {
  const entityKind = ENTITY_KIND_OF[kind];
  const blocks = model.blocks.filter((b) => b.kind === entityKind);

  // Prefix sum over the blocks, so a row index resolves to (block, offset)
  // without materializing a directory of every row.
  const starts = new Int32Array(blocks.length + 1);
  for (let b = 0; b < blocks.length; b++) starts[b + 1] = starts[b] + blocks[b].count;
  const total = starts[blocks.length];

  let rowIndex: Int32Array | undefined;
  if (keep) {
    const hits: number[] = [];
    for (let b = 0; b < blocks.length; b++) {
      const blk = blocks[b];
      for (let i = 0; i < blk.count; i++) {
        if (keep.has(blk.entityIds[i])) hits.push(starts[b] + i);
      }
    }
    rowIndex = Int32Array.from(hits);
  }
  const rowCount = rowIndex ? rowIndex.length : total;

  // Sequential access — scrolling and export alike — walks forward, so a
  // cursor makes it O(1) and only a jump pays for the binary search.
  let cursor = 0;
  const blockOf = (g: number): number => {
    if (cursor < blocks.length && g >= starts[cursor] && g < starts[cursor + 1]) return cursor;
    if (cursor + 1 < blocks.length && g >= starts[cursor + 1] && g < starts[cursor + 2]) {
      return ++cursor;
    }
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= g) lo = mid;
      else hi = mid - 1;
    }
    cursor = lo;
    return lo;
  };

  const maxStride = blocks.reduce((m, b) => Math.max(m, b.stride), 0);

  push("id", "id");
  push("block", "text");
  const nodesAt = columns.length;
  if (opts.nodeColumns) {
    for (let k = 0; k < maxStride; k++) push(`n${k + 1}`, "id");
  } else {
    push("nodes", "text");
  }
  if (partMap) push("SubModelParts", "text");
  const partsAt = partMap ? columns.length - 1 : -1;

  const idAt = (i: number): number => {
    const g = rowIndex ? rowIndex[i] : i;
    const b = blockOf(g);
    return blocks[b].entityIds[g - starts[b]];
  };
  const fields = fieldsFor(model, fieldKindFor(kind), columns, push, {
    count: rowCount,
    idAt,
  });

  const rowInto = (i: number, out: CellValue[]): CellValue[] => {
    const g = rowIndex ? rowIndex[i] : i;
    const b = blockOf(g);
    const blk = blocks[b];
    const local = g - starts[b];
    const id = blk.entityIds[local];
    out[0] = id;
    out[1] = blk.name;
    writeConnectivity(blk, local, opts.nodeColumns === true, nodesAt, maxStride, out);
    if (partMap) out[partsAt] = (partMap.get(id) ?? []).join(";");
    readFields(fields, id, out);
    return out;
  };

  return {
    kind,
    columns,
    columnTypes,
    rowCount,
    row: (i) => rowInto(i, new Array<CellValue>(columns.length)),
    rowInto,
  };
}

function writeConnectivity(
  blk: EntityBlock,
  local: number,
  perColumn: boolean,
  at: number,
  maxStride: number,
  out: CellValue[]
): void {
  const o = local * blk.stride;
  if (!perColumn) {
    let s = "";
    for (let k = 0; k < blk.stride; k++) s += (k ? " " : "") + blk.connectivity[o + k];
    out[at] = s;
    return;
  }
  // A mesh mixing strides pads the short blocks: a blank is honest where a 0
  // would be a node id the cell does not have.
  for (let k = 0; k < maxStride; k++) {
    out[at + k] = k < blk.stride ? blk.connectivity[o + k] : undefined;
  }
}

/** Row count for a kind without building the view — for the kind selector. */
export function tableRowCount(model: MdpaModel, kind: TableKind, opts: TableOptions = {}): number {
  if (opts.submodelpart) return prepareTable(model, kind, opts).rowCount;
  if (kind === "Nodes") return model.nodeCount;
  const entityKind = ENTITY_KIND_OF[kind];
  let n = 0;
  for (const b of model.blocks) if (b.kind === entityKind) n += b.count;
  return n;
}

// ---- CSV --------------------------------------------------------------------

/**
 * Shortest decimal that round-trips through Float32. `String(f32Value)` prints
 * the double expansion of the stored float (0.1 → 0.10000000149011612), which
 * would put fabricated digits in every coordinate of every exported file.
 */
export function f32str(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(v);
}

const NEEDS_QUOTE = /[",\r\n]/;

function csvField(text: string): string {
  return NEEDS_QUOTE.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCell(v: CellValue, type: ColumnType): string {
  if (v === undefined) return "";
  if (typeof v === "string") return csvField(v);
  // Number → String is the shortest decimal that round-trips a double, so it
  // is both exact and compact; NaN/Infinity print verbatim.
  return type === "f32" ? f32str(v) : String(v);
}

/**
 * CSV text, yielded in chunks. This is the primary serializer and `toCsv` the
 * convenience wrapper, not the reverse: a multi-million-row table is over a
 * gigabyte of text — past V8's maximum string length — so the write path has
 * to stream rather than materialize the file and then save it.
 */
export function* csvChunks(view: TableView, chunkRows = 2000): Generator<string> {
  yield view.columns.map(csvField).join(",") + "\r\n";
  const buf = new Array<CellValue>(view.columns.length);
  const parts: string[] = [];
  for (let i = 0; i < view.rowCount; i++) {
    view.rowInto(i, buf);
    let line = "";
    for (let c = 0; c < buf.length; c++) {
      line += (c ? "," : "") + serializeCell(buf[c], view.columnTypes[c]);
    }
    parts.push(line);
    if (parts.length >= chunkRows) {
      yield parts.join("\r\n") + "\r\n";
      parts.length = 0;
    }
  }
  if (parts.length > 0) yield parts.join("\r\n") + "\r\n";
}

/** Whole-view CSV — tests and small views only; see `csvChunks` for real files. */
export function toCsv(view: TableView): string {
  let out = "";
  for (const chunk of csvChunks(view)) out += chunk;
  return out;
}
