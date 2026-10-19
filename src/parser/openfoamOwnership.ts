/**
 * In-place save of a single-region OpenFOAM case (roadmap item 13).
 *
 * An OpenFOAM case is a DIRECTORY, and the meshio++ writer only knows six
 * `constant/polyMesh` files plus a `0/<field>` per field. Everything else in
 * the tree (`system/`, `constant/*`, other time directories, `faceZones`,
 * `sets/`, `processorN/`, …) is somebody else's. This module is the single
 * answer to "may the open model be written back over the case it came from,
 * and which files would that touch?". Every file under the case ends up
 * **rewritten, preserved verbatim, or refused by name**; nothing is deleted.
 *
 * Two facts shape it, both measured:
 *
 * 1. **The baseline is the case on disk now**, re-read with the same options,
 *    not `MdpaModel.source` (most full-literal ops drop `source` on purpose,
 *    see `types.ts`). Comparing the model with the baseline tells which of two
 *    save modes applies.
 * 2. **The reader keeps point order** (`coords[i]` is polyMesh point `i`;
 *    polyhedron apex nodes are appended after them) and the writer reproduces
 *    owner/neighbour/boundary byte-for-byte for a round trip, while it
 *    re-spells `faces` and regenerates `cellZones`.
 *
 * - **geometry** — the mesh's connectivity and patch membership are those of
 *   the baseline: only coordinates and field values differ (translate, scale,
 *   rotate, smooth, fieldCalc). Only `points` is rewritten, point by point:
 *   an unmoved point keeps its original text (the model holds Float32, so
 *   re-spelling every point would change digits nobody edited). Every
 *   index-keyed file stays valid, because no index moved.
 * - **topology** — anything else (refine, crop, remesh, renumber, a patch
 *   rename …). The six polyMesh files plus the writer-owned zone files
 *   (`cellZones`/`faceZones`/`pointZones`, rewritten from the model's genuine
 *   zone parts — blocks and patches never qualify, so no new bogus zone is
 *   added) are rewritten by the ordinary writer, and every remaining file
 *   keyed by the OLD index order blocks the save by name: `sets/`,
 *   `cellLevel`, `pointLevel`, `refinementHistory`, `surfaceIndex`,
 *   `<time>/polyMesh`, and any time-directory field with a `nonuniform` (or
 *   compressed/binary) list. A zone file the model no longer carries would be
 *   deleted by the rewrite, so it blocks until removed explicitly.
 *
 * Field files are never replaced wholesale: an existing `<time>/<VAR>` whose
 * values changed gets only its `internalField` entry replaced (geometry mode),
 * so `dimensions` and the real `boundaryField` survive; a field that has no
 * file yet is written new with `zeroGradient` patches, as an export does.
 *
 * Multi-region (`constant/<region>/polyMesh`) and decomposed (`processorN/`)
 * cases are saved in place for **geometry-only** edits: the merged model's
 * node slice of each region (regions in sorted order, as the reader merges
 * them) or each processor's `pointProcAddressing` maps the model's
 * coordinates back onto the per-region / per-processor `points` files, and
 * every mapping is verified against the file before anything is written.
 * Topology edits and field edits for those shapes stay refused / untouched;
 * item 13 stays open for them.
 *
 * Node-only (it reads the case), but free of `vscode`, so the extension and
 * the MCP server share one rulebook and cannot disagree about a refusal.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { f32str } from "./dataTable";
import { parseMeshFile } from "./meshFileParser";
import type { MeshioCompanionFile } from "./meshio";
import {
  OPENFOAM_POLYMESH_DIR,
  type OpenFoamTimeDir,
  listOpenFoamProcessors,
  listOpenFoamRegions,
  listOpenFoamTimes,
  openFoamCaseDir,
  parseAsciiLabelList,
  parseOpenFoamBoundary,
  wouldOverwriteOpenFoamCase,
} from "./openfoamCase";
import { extractSubModelPart } from "./subModelPartExtract";
import { patchBoundaryEntry, qualifyingVolumeFields, replaceInternalField, volumeCellIdsInWriteOrder } from "./openfoamFieldWrite";
import { writeDecomposedProcessors, processorPatchName } from "./openfoamDecomposedWrite";
import { appendZeroFacePatches, leafPatchParts } from "./openfoamWrite";
import { partitionParts } from "./partitionExport";
import { isSafeEntryName } from "./problemZip";
import type { MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import { cellCategory } from "./writers/writerCommon";
import { writeMeshFileAsync } from "./writers/meshWriter";

export interface InPlaceRefusal {
  /** Case-relative, `/`-separated. */
  path: string;
  reason: string;
}

export type InPlaceMode = "geometry" | "topology" | "unchanged";

export type InPlacePlan =
  | { ok: false; refusals: InPlaceRefusal[] }
  | {
      ok: true;
      mode: InPlaceMode;
      /** Files to write, case-relative. Already complete: callers only write them. */
      writes: MeshioCompanionFile[];
      /** How many existing files are left exactly as they are. */
      preservedCount: number;
      diagnostics: MdpaDiagnostic[];
    };

/** Safety valves for the tree walk: a case is thousands of files, not millions. */
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 12;
/** A field file larger than this is not read just to look for `nonuniform`. */
const MAX_FIELD_BYTES = 512 * 1024 * 1024;

/** The six files `writeMeshioBytes` owns under `constant/polyMesh`. */
const OWNED_POLYMESH = ["points", "faces", "owner", "neighbour", "boundary", "cellZones"] as const;
/** Keyed by point/face/cell INDEX, hence stale after any topology change. */
const INDEX_KEYED_POLYMESH = new Set([
  "sets",
  "cellLevel",
  "pointLevel",
  "refinementHistory",
  "surfaceIndex",
  "pointProcAddressing",
  "faceProcAddressing",
  "cellProcAddressing",
  "boundaryProcAddressing",
]);
/**
 * Zone files the writer owns since the zone integration (roadmap item 13):
 * genuine zone parts round-trip through named regions, so a topology rewrite
 * replaces these files instead of being blocked by them. `sets/` and the
 * level/history files still have no writer home and keep blocking.
 */
const OWNED_ZONES = ["cellZones", "faceZones", "pointZones"] as const;

const rel = (...parts: string[]): string => parts.join("/");

// ---- fingerprints ---------------------------------------------------------------

function feed(h: ReturnType<typeof createHash>, a: ArrayLike<number> & { buffer?: ArrayBufferLike }): void {
  const t = a as unknown as Int32Array;
  h.update(Buffer.from(t.buffer, t.byteOffset, t.byteLength));
}

/**
 * Everything that makes two models index-compatible: node ids in storage
 * order, then every block's kind/name/cell type/ids/connectivity. Coordinates
 * and field values are deliberately NOT part of it.
 */
export function meshKey(model: MdpaModel): string {
  const h = createHash("sha1");
  h.update(`n${model.nodeCount};`);
  feed(h, model.nodeIds);
  for (const b of model.blocks) {
    h.update(`|${b.kind}:${b.name}:${b.vtkCellType ?? ""}:${b.stride}:${b.count};`);
    feed(h, b.entityIds);
    feed(h, b.connectivity);
  }
  return h.digest("hex");
}

/** The patches the writer would produce: leaf parts holding conditions. */
export function patchKey(model: MdpaModel): string {
  const h = createHash("sha1");
  for (const p of leafPatchParts(model.subModelParts)) {
    h.update(`|${p.path}:${p.conditionIds.length};`);
    feed(h, Int32Array.from(p.conditionIds).sort());
  }
  return h.digest("hex");
}

// ---- the tree -------------------------------------------------------------------

interface CaseEntry {
  rel: string;
  size: number;
}

/** Regular files under `caseDir` (symlinks and specials are never followed). */
async function walkCase(caseDir: string, refusals: InPlaceRefusal[]): Promise<CaseEntry[]> {
  const out: CaseEntry[] = [];
  const visit = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH) {
      refusals.push({ path: path.relative(caseDir, dir).split(path.sep).join("/"), reason: "directory nesting is deeper than this check will follow" });
      return false;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (out.length > MAX_ENTRIES) {
        refusals.push({ path: ".", reason: `the case holds more than ${MAX_ENTRIES} files; this check will not enumerate it` });
        return false;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!(await visit(abs, depth + 1))) return false;
      } else if (e.isFile()) {
        const st = await fs.promises.stat(abs);
        out.push({ rel: path.relative(caseDir, abs).split(path.sep).join("/"), size: st.size });
      }
    }
    return true;
  };
  await visit(caseDir, 0);
  return out;
}

// ---- points ---------------------------------------------------------------------

interface PointsLayout {
  text: string;
  /** Offsets of every `(x y z)` triple, including the parentheses. */
  spans: Array<[number, number]>;
}

/** Splits an ASCII `points` file into its text and the position of each point. */
export function parsePointsLayout(text: string): PointsLayout | undefined {
  let from = 0;
  const header = text.indexOf("FoamFile");
  if (header >= 0) {
    const open = text.indexOf("{", header);
    if (open >= 0) {
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) {
          from = i + 1;
          break;
        }
      }
    }
  }
  const countRe = /(\d+)\s*\(/g;
  countRe.lastIndex = from;
  const m = countRe.exec(text);
  if (!m) return undefined;
  const declared = parseInt(m[1], 10);
  const spans: Array<[number, number]> = [];
  const tripleRe = /\(\s*([^()]*?)\s*\)/g;
  tripleRe.lastIndex = m.index + m[0].length;
  for (let t = tripleRe.exec(text); t && spans.length < declared; t = tripleRe.exec(text)) {
    if (t[1].trim().split(/\s+/).length !== 3) return undefined;
    spans.push([t.index, t.index + t[0].length]);
  }
  return spans.length === declared ? { text, spans } : undefined;
}

/**
 * New text for `points` with only the moved points re-spelled. `baseline` and
 * `current` are interleaved xyz; points past `layout.spans.length` are
 * polyhedron apex nodes that exist only in the model and are never written.
 */
export function rewritePoints(
  layout: PointsLayout,
  baseline: ArrayLike<number>,
  current: ArrayLike<number>
): { text: string; moved: number } {
  let moved = 0;
  let out = "";
  let at = 0;
  for (let i = 0; i < layout.spans.length; i++) {
    const k = i * 3;
    if (baseline[k] === current[k] && baseline[k + 1] === current[k + 1] && baseline[k + 2] === current[k + 2]) continue;
    moved++;
    const [s, e] = layout.spans[i];
    out += layout.text.slice(at, s) + `(${f32str(current[k])} ${f32str(current[k + 1])} ${f32str(current[k + 2])})`;
    at = e;
  }
  return { text: out + layout.text.slice(at), moved };
}

// ---- planning -------------------------------------------------------------------

export interface PlanOptions {
  /** `<case>/x.foam` the model was opened from. */
  markerPath: string;
  model: MdpaModel;
  /** Index into the case's numeric time directories the model was read at. */
  timeStep?: number;
}

const read = (p: string): Promise<string> => fs.promises.readFile(p, "utf8");
const exists = (p: string): boolean => fs.existsSync(p);

/** Cell count named by owner/neighbour, or undefined when they are not plain ASCII lists. */
async function declaredCellCount(polyMesh: string): Promise<number | undefined> {
  const labels = async (name: string): Promise<number[] | undefined> => {
    try {
      return parseAsciiLabelList(await read(path.join(polyMesh, name)));
    } catch {
      return undefined;
    }
  };
  const owner = await labels("owner");
  if (!owner) return undefined;
  let max = -1;
  for (const v of owner) if (v > max) max = v;
  const nb = await labels("neighbour");
  if (nb) for (const v of nb) if (v > max) max = v;
  return max + 1;
}

// ---- multi-region and decomposed cases (geometry only) -------------------------------

type Distributed = { regions: string[] } | { processors: number[] };

/** The `i`-th point of a parsed `points` file, rounded to Float32 like the reader does. */
function layoutPoint(layout: PointsLayout, i: number): [number, number, number] | undefined {
  const [s, e] = layout.spans[i];
  const n = layout.text.slice(s + 1, e - 1).trim().split(/\s+/).map(Number);
  return n.length === 3 && n.every(Number.isFinite) ? [Math.fround(n[0]), Math.fround(n[1]), Math.fround(n[2])] : undefined;
}

/**
 * A multi-region or decomposed case, geometry edits only. The model's points
 * are mapped back onto each region's / processor's own `points` file and the
 * mapping is checked against the file first, so a layout assumption that does
 * not hold refuses instead of writing coordinates to the wrong place.
 * A topology or patch change diverts to `planRegionTopology` (multi-region)
 * or `planDecomposedTopology` (decomposed: re-partitioned natively).
 */
/**
 * Field edits for a decomposed case in geometry mode (roadmap item 13): the
 * model's Elemental values sliced per processor through the on-disk
 * cellProcAddressing, replacing internalField surgically like the other
 * shapes. The addressing must partition the reconstructed mesh — each global
 * cell exactly once — or nothing is matched and the fields are kept with a
 * diagnostic. Files that do not exist are never synthesized (processor
 * boundary entries cannot be invented); only the displayed time is touched.
 */
async function planProcessorFields(
  opts: PlanOptions,
  baseline: MdpaModel,
  caseDir: string,
  processors: number[],
  timeName: string,
  diagnostics: MdpaDiagnostic[],
  fieldDiagnostics: MdpaDiagnostic[],
  writes: MeshioCompanionFile[]
): Promise<void> {
  const label = "OpenFOAM in-place save (decomposed)";
  const quals = qualifyingVolumeFields(opts.model, fieldDiagnostics, true);
  if (quals.length === 0) {
    diagnostics.push({ line: 0, message: `${label}: field files are kept as they are; only coordinates are written for this case shape.` });
    return;
  }
  // Global cell position -> entity id, in writer order: the order the
  // cellProcAddressing lists index into, the same positional contract the
  // points path relies on (and verifies per point) for nodes.
  const volumeIds = volumeCellIdsInWriteOrder(baseline);
  const seen = new Array<number>(volumeIds.length).fill(0);
  const maps: Int32Array[] = [];
  for (const n of processors) {
    const addr = `processor${n}/constant/polyMesh/cellProcAddressing`;
    let labels: number[] | undefined;
    try {
      labels = parseAsciiLabelList(await read(path.join(caseDir, ...addr.split("/"))));
    } catch {
      labels = undefined;
    }
    if (!labels || labels.some((v) => !Number.isInteger(v) || v < 0 || v >= volumeIds.length)) {
      diagnostics.push({ line: 0, message: `${label}: ${addr} is missing or unreadable, so fields cannot be matched to processor files and are kept as they are.` });
      return;
    }
    for (const g of labels) seen[g]++;
    maps.push(Int32Array.from(labels));
  }
  if (!seen.every((c) => c === 1)) {
    diagnostics.push({ line: 0, message: `${label}: the processor cell addressing does not partition the reconstructed mesh, so fields cannot be matched to processor files and are kept as they are.` });
    return;
  }
  const enc = new TextEncoder();
  for (const q of quals) {
    const v = q.field.variable;
    for (let i = 0; i < processors.length; i++) {
      const relName = `processor${processors[i]}/${timeName}/${v}`;
      const file = path.join(caseDir, ...relName.split("/"));
      const rows = Array.from(maps[i], (g) => q.rows[g]);
      if (!exists(file)) {
        diagnostics.push({ line: 0, message: `${label}: ${relName} does not exist and processor boundary entries cannot be synthesized; not written.` });
        continue;
      }
      if (exists(`${file}.gz`)) {
        diagnostics.push({ line: 0, message: `${label}: ${relName}.gz exists and is kept as it is.` });
        continue;
      }
      const next = replaceInternalField(await read(file), q.cls, q.kind, rows);
      if (next === undefined) {
        diagnostics.push({ line: 0, message: `${label}: ${relName} could not be edited safely (binary, or a different class) and is kept as it is.` });
        continue;
      }
      writes.push({ name: relName, data: enc.encode(next) });
    }
  }
}

async function planDistributedGeometry(opts: PlanOptions, caseDir: string, shape: Distributed): Promise<InPlacePlan> {
  const regionShape = "regions" in shape;
  const names = regionShape ? shape.regions.map((r) => `constant/${r}`) : shape.processors.map((n) => `processor${n}`);
  const pointsOf = (i: number): string => (regionShape ? `constant/${shape.regions[i]}/polyMesh/points` : `processor${shape.processors[i]}/constant/polyMesh/points`);
  const kind = regionShape ? "multi-region" : "decomposed";
  // Times live at the top level for regions but under each processor for a
  // decomposed case; the displayed time below selects the field scope.
  const times = regionShape
    ? await listOpenFoamTimes(caseDir)
    : await listOpenFoamTimes(path.join(caseDir, `processor${(shape as { processors: number[] }).processors[0]}`));
  const stepIndex = times.length > 0 ? Math.min(Math.max(opts.timeStep ?? 0, 0), times.length - 1) : undefined;
  const timeName = stepIndex !== undefined ? times[stepIndex].name : "0";
  const refuseAll = (reason: string, only?: string[]): InPlacePlan => ({
    ok: false,
    refusals: (only ?? names).map((p) => ({ path: p, reason })),
  });

  let baseline: MdpaModel;
  try {
    baseline = await parseMeshFile(opts.markerPath);
  } catch (e) {
    return { ok: false, refusals: [{ path: ".", reason: `the case on disk cannot be re-read to compare against (${(e as Error).message})` }] };
  }
  if (meshKey(baseline) !== meshKey(opts.model) || patchKey(baseline) !== patchKey(opts.model)) {
    if (regionShape) {
      return planRegionTopology(opts, baseline, caseDir, shape.regions, times, timeName);
    }
    return planDecomposedTopology(opts, baseline, caseDir, shape.processors, times, timeName);
  }
  if (opts.model.nodeCount < baseline.nodeCount) {
    return { ok: false, refusals: [{ path: ".", reason: "the model lost nodes but kept its connectivity; nothing consistent can be written" }] };
  }

  const layouts: PointsLayout[] = [];
  const refusals: InPlaceRefusal[] = [];
  for (let i = 0; i < names.length; i++) {
    const file = pointsOf(i);
    const abs = path.join(caseDir, ...file.split("/"));
    if (!exists(abs)) {
      refusals.push({ path: file, reason: exists(`${abs}.gz`) ? "only a compressed copy exists; it cannot be edited in place — decompress it first" : "the file is missing" });
      continue;
    }
    const layout = parsePointsLayout(await read(abs));
    if (!layout) refusals.push({ path: file, reason: "not an ASCII point list this check can edit (binary or malformed)" });
    else layouts.push(layout);
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // local (file) point index -> global model node index, per region / processor
  const maps: Int32Array[] = [];
  if (regionShape) {
    let offset = 0;
    for (const layout of layouts) {
      const m = new Int32Array(layout.spans.length);
      for (let j = 0; j < m.length; j++) m[j] = offset + j;
      maps.push(m);
      offset += layout.spans.length;
    }
    if (offset !== baseline.nodeCount) {
      return refuseAll(`the regions list ${offset} points but the case read back ${baseline.nodeCount} nodes (polyhedral cells add nodes on read), so their order cannot be mapped`);
    }
  } else {
    for (let i = 0; i < layouts.length; i++) {
      const file = `processor${(shape as { processors: number[] }).processors[i]}/constant/polyMesh/pointProcAddressing`;
      const abs = path.join(caseDir, ...file.split("/"));
      let labels: number[] | undefined;
      try {
        labels = parseAsciiLabelList(await read(abs));
      } catch {
        labels = undefined;
      }
      if (!labels) {
        refusals.push({ path: file, reason: exists(abs) ? "not an ASCII label list this check can read" : "the file is missing, so local points cannot be mapped to the reconstructed mesh" });
      } else if (labels.length !== layouts[i].spans.length) {
        refusals.push({ path: file, reason: `lists ${labels.length} points but the processor's points file has ${layouts[i].spans.length}` });
      } else if (labels.some((v) => !Number.isInteger(v) || v < 0 || v >= baseline.nodeCount)) {
        refusals.push({ path: file, reason: "names a point outside the reconstructed mesh" });
      } else {
        maps.push(Int32Array.from(labels));
      }
    }
    if (refusals.length > 0) return { ok: false, refusals };
  }

  // The mapping must reproduce the file: each point read from disk equals the baseline's node.
  for (let i = 0; i < layouts.length; i++) {
    for (let j = 0; j < layouts[i].spans.length; j++) {
      const p = layoutPoint(layouts[i], j);
      const g = maps[i][j] * 3;
      if (!p || p[0] !== baseline.coords[g] || p[1] !== baseline.coords[g + 1] || p[2] !== baseline.coords[g + 2]) {
        refusals.push({ path: pointsOf(i), reason: `point ${j} does not match the node it maps to in the reconstructed mesh, so the node order cannot be trusted` });
        break;
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const writes: MeshioCompanionFile[] = [];
  const diagnostics: MdpaDiagnostic[] = [];
  const enc = new TextEncoder();
  let moved = 0;
  for (let i = 0; i < layouts.length; i++) {
    const n = layouts[i].spans.length;
    const was = new Float32Array(n * 3);
    const now = new Float32Array(n * 3);
    for (let j = 0; j < n; j++) {
      const g = maps[i][j] * 3;
      for (let c = 0; c < 3; c++) {
        was[j * 3 + c] = baseline.coords[g + c];
        now[j * 3 + c] = opts.model.coords[g + c];
      }
    }
    const r = rewritePoints(layouts[i], was, now);
    if (r.moved > 0) {
      moved += r.moved;
      writes.push({ name: pointsOf(i), data: enc.encode(r.text) });
    }
  }
  // A shared point moved identically in each processor's copy, so counting per file over-counts it.
  if (writes.length > 0) {
    diagnostics.push({
      line: 0,
      message: `OpenFOAM in-place save (${kind}): ${moved} point entr${moved === 1 ? "y" : "ies"} rewritten in ${writes.length} points file(s); every other file in the case is untouched.`,
    });
  }
  if (regionShape) {
    // Field edits per region: surgical internalField replacement in the
    // displayed time's region directories (roadmap item 13).
    const regionFieldDiagnostics: MdpaDiagnostic[] = [];
    for (const region of shape.regions) {
      const sub = extractSubModelPart(opts.model, region);
      const subBase = extractSubModelPart(baseline, region);
      // The whole-model meshKey matched, so both wrappers exist; defensive.
      if (!sub || !subBase) continue;
      await planScopeFields({
        model: sub,
        baseline: subBase,
        caseDir,
        scopeDir: `${timeName}/${region}`,
        scopeLabel: `OpenFOAM in-place save (multi-region: ${region})`,
        mode: "geometry",
        topologyFields: "rewrite",
        diagnostics,
        fieldDiagnostics: regionFieldDiagnostics,
        writes,
      });
    }
    diagnostics.push(...regionFieldDiagnostics);
  } else {
    const processorFieldDiagnostics: MdpaDiagnostic[] = [];
    await planProcessorFields(opts, baseline, caseDir, shape.processors, timeName, diagnostics, processorFieldDiagnostics, writes);
    diagnostics.push(...processorFieldDiagnostics);
  }

  const tree = await walkCase(caseDir, refusals);
  if (refusals.length > 0) return { ok: false, refusals };
  const written = new Set(writes.map((w) => w.name));
  return {
    ok: true,
    mode: writes.length === 0 ? "unchanged" : "geometry",
    writes,
    preservedCount: tree.filter((f) => !written.has(f.rel)).length,
    diagnostics,
  };
}

/**
 * Field files for one scope: the single-region time directory or one
 * region's / processor's. Geometry mode replaces `internalField` surgically
 * (dimensions and the real boundaryField survive); topology mode either keeps
 * files with a diagnostic ("keep", the single-region rule) or rewrites them
 * wholesale from the model's current values ("rewrite", for the distributed
 * shapes whose cell order changed). Files for variables the model does not
 * carry are always preserved.
 */
interface ScopeFieldOptions {
  model: MdpaModel;
  baseline: MdpaModel;
  caseDir: string;
  /** Case-relative directory holding the field files, e.g. "0" or "0/fluid". */
  scopeDir: string;
  scopeLabel: string;
  mode: InPlaceMode;
  topologyFields: "keep" | "rewrite";
  diagnostics: MdpaDiagnostic[];
  fieldDiagnostics: MdpaDiagnostic[];
  writes: MeshioCompanionFile[];
}

/**
 * A fresh ASCII field file from current values (export grammar): used for
 * variables with no file yet, and for wholesale rewrites where the cell
 * order changed. Exported for the native decomposed writer's field files.
 */
export function renderFreshFoamField(v: string, cls: string, kind: string, rows: string[], dims: string, bnd: string): string {
  return (
    `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${cls};\n    object      ${v};\n}\n\n` +
    `dimensions      [${dims}];\n\ninternalField   nonuniform List<${kind}>\n${rows.length}\n(\n${rows.join("\n")}\n)\n;\n\n` +
    `boundaryField\n{\n${bnd}}\n`
  );
}

async function planScopeFields(o: ScopeFieldOptions): Promise<void> {
  const enc = new TextEncoder();
  for (const q of qualifyingVolumeFields(o.model, o.fieldDiagnostics, true)) {
    const v = q.field.variable;
    const file = path.join(o.caseDir, ...o.scopeDir.split("/"), v);
    const relName = [...o.scopeDir.split("/"), v].join("/");
    const before = o.baseline.fields.find((f) => f.kind === "Elemental" && f.variable === v);
    const unchanged =
      before !== undefined &&
      before.values.length === q.field.values.length &&
      before.values.every((x, i) => x === q.field.values[i]);
    if (unchanged) continue;
    const fresh = (): { name: string; data: Uint8Array } => {
      const bnd = leafPatchParts(o.model.subModelParts)
        .map((p) => patchBoundaryEntry(o.model, q.field, p, true))
        .join("");
      const dims = (q.field.dimensions?.exponents ?? [0, 0, 0, 0, 0, 0, 0]).join(" ");
      return { name: relName, data: enc.encode(renderFreshFoamField(v, q.cls, q.kind, q.rows, dims, bnd)) };
    };
    if (exists(file)) {
      if (o.mode !== "geometry") {
        if (o.topologyFields === "rewrite") {
          o.writes.push(fresh());
          o.diagnostics.push({ line: 0, message: `${o.scopeLabel}: ${relName} rewritten from the model's current values (cell order changed).` });
        } else {
          o.diagnostics.push({ line: 0, message: `${o.scopeLabel}: ${relName} exists and is kept as it is (cell order changed, so its values cannot be matched).` });
        }
        continue;
      }
      const next = replaceInternalField(await read(file), q.cls, q.kind, q.rows);
      if (next === undefined) {
        o.diagnostics.push({ line: 0, message: `${o.scopeLabel}: ${relName} could not be edited safely (binary, or a different class) and is kept as it is.` });
        continue;
      }
      o.writes.push({ name: relName, data: enc.encode(next) });
    } else if (exists(`${file}.gz`)) {
      o.diagnostics.push({ line: 0, message: `${o.scopeLabel}: ${relName}.gz exists and is kept as it is.` });
    } else {
      o.writes.push(fresh());
    }
  }
}

/**
 * A multi-region case with topology and/or field edits: each changed region
 * is rewritten from its wrapper part (`extractSubModelPart`) through the
 * ordinary writer, with the region's on-disk patch dictionaries merged in
 * like the single-region path. Unchanged regions keep every byte. Fields
 * follow the decided semantic: surgical `internalField` replacement in
 * geometry (shared helper), wholesale rewrite from the model's values in
 * topology, history in other time directories never rewritten.
 */
async function planRegionTopology(
  opts: PlanOptions,
  baseline: MdpaModel,
  caseDir: string,
  regions: string[],
  times: OpenFoamTimeDir[],
  timeName: string
): Promise<InPlacePlan> {
  const refusals: InPlaceRefusal[] = [];
  const diagnostics: MdpaDiagnostic[] = [];
  const fieldDiagnostics: MdpaDiagnostic[] = [];
  const writes: MeshioCompanionFile[] = [];
  const enc = new TextEncoder();

  // Every volume/surface cell must belong to a region, or a per-region
  // rewrite would silently drop it.
  const covered = new Set<string>();
  const gather = (p: SubModelPart): void => {
    for (const id of p.elementIds) covered.add(`E:${id}`);
    for (const id of p.conditionIds) covered.add(`C:${id}`);
    for (const c of p.children) gather(c);
  };
  for (const p of opts.model.subModelParts) if (regions.includes(p.path)) gather(p);
  const orphaned: string[] = [];
  for (const b of opts.model.blocks) {
    if (b.kind !== "Elements" && b.kind !== "Conditions") continue;
    const tag = b.kind === "Elements" ? "E" : "C";
    for (const id of b.entityIds) {
      if (!covered.has(`${tag}:${id}`)) {
        orphaned.push(`${b.name}#${id}`);
        if (orphaned.length >= 5) break;
      }
    }
    if (orphaned.length >= 5) break;
  }
  if (orphaned.length > 0) {
    return {
      ok: false,
      refusals: [
        {
          path: ".",
          reason: `cells outside any region (${orphaned.join(", ")}) would be dropped by a per-region rewrite; use Export or Save As… instead`,
        },
      ],
    };
  }

  const tree = await walkCase(caseDir, refusals);
  if (refusals.length > 0) return { ok: false, refusals };

  let rewroteMesh = false;
  for (const region of regions) {
    const label = `OpenFOAM in-place save (multi-region: ${region})`;
    const sub = extractSubModelPart(opts.model, region);
    const subBase = extractSubModelPart(baseline, region);
    if (!sub || !subBase) {
      refusals.push({
        path: `constant/${region}`,
        reason: "the region's wrapper part is missing from the model; a per-region rewrite cannot map it — use Export or Save As… instead",
      });
      continue;
    }
    const meshChanged = meshKey(sub) !== meshKey(subBase) || patchKey(sub) !== patchKey(subBase);
    // Fields are checked even for a mesh-identical region: a field-only edit
    // takes the surgical path below with no mesh rewrite.
    const scopeDir = `${timeName}/${region}`;
    const regionPrefix = `constant/${region}/`;
    const carried = new Set(qualifyingVolumeFields(sub, [], true).map((q) => q.field.variable));

    if (meshChanged) {
      rewroteMesh = true;
      // The count before this region's scan: a region that fails reports
      // alongside the others instead of cutting the scan short, so one
      // message names every stranded file.
      const regionFailedBefore = refusals.length;
      // ---- blockers: constant/<region>/ and <time>/<region>/ ----
      for (const f of tree) {
        const underRegion =
          f.rel.startsWith(regionPrefix) ||
          times.some((t) => f.rel.startsWith(`${t.name}/${region}/`));
        if (!underRegion) continue;
        const rest = f.rel.startsWith(regionPrefix)
          ? f.rel.slice(regionPrefix.length)
          : f.rel.slice(f.rel.indexOf(`${region}/`) + `${region}/`.length);
        const inPolyMesh = rest.startsWith("polyMesh/");
        const parts = rest.split("/");
        if (inPolyMesh) {
          if (!f.rel.startsWith(regionPrefix)) {
            // <time>/<region>/polyMesh: a moving-mesh overlay keyed by
            // point/face index, which this edit changes.
            refusals.push({ path: f.rel, reason: "a moving-mesh overlay is keyed by point/face index, which this edit changes" });
            continue;
          }
          if (parts[1] === "sets") {
            refusals.push({ path: f.rel, reason: "a set is keyed by cell/face/point index, which this edit changes" });
          } else if (parts.length === 2) {
            const name = parts[1];
            if (INDEX_KEYED_POLYMESH.has(name)) {
              refusals.push({ path: f.rel, reason: "keyed by cell/face/point index, which this edit changes" });
            } else if (name.endsWith(".gz") && [...OWNED_POLYMESH, ...OWNED_ZONES].some((n) => name === `${n}.gz`)) {
              refusals.push({ path: f.rel, reason: "a compressed copy of a file the rewrite replaces would be left stale beside it — decompress or remove it first" });
            }
          }
          continue;
        }
        // Time-region field files (constant/<region>/ holds no other files
        // that reach here besides dictionaries, which are preserved): the
        // displayed time's carried fields are rewritten wholesale, so they
        // never block; every other index-keyed field file does.
        const timeNameOf = times.find((t) => f.rel.startsWith(`${t.name}/${region}/`))?.name;
        if (timeNameOf === undefined || parts.length !== 1 || parts[0] === "uniform") continue;
        if (parts[0].endsWith(".gz")) {
          refusals.push({ path: f.rel, reason: "a compressed field cannot be inspected, so it may be keyed by cell/face index" });
          continue;
        }
        if (timeNameOf === timeName && carried.has(parts[0])) continue;
        if (f.size > MAX_FIELD_BYTES) {
          refusals.push({ path: f.rel, reason: "too large to check for index-keyed values" });
          continue;
        }
        const text = await read(path.join(caseDir, f.rel));
        if (/FoamFile/.test(text) && (/\bnonuniform\b/.test(text) || /\bformat\s+binary\s*;/.test(text))) {
          refusals.push({ path: f.rel, reason: "holds per-cell or per-face values keyed by the old index order" });
        }
      }
      // A region that already failed reports alongside the others instead of
      // cutting the scan short: one message names every stranded file.
      if (refusals.length > regionFailedBefore) continue;

      // ---- the rewrite, with this region's on-disk patch dictionaries ----
      const boundaryPath = path.join(caseDir, regionPrefix, "polyMesh", "boundary");
      let patchTypes: Record<string, string> = {};
      let patchDictionaries: Record<string, string> = {};
      if (exists(boundaryPath)) {
        const parsed = parseOpenFoamBoundary(await read(boundaryPath), []);
        for (const p of parsed) {
          if (p.type) patchTypes[p.name] = p.type;
          if (p.dict) patchDictionaries[p.name] = p.dict;
        }
      }
      const sub2: MdpaModel = {
        ...sub,
        // extractSubModelPart carries no source; the region's on-disk
        // boundary is authoritative for patch types and dictionaries.
        source: { format: "openfoam", openfoam: { patchTypes, patchDictionaries } },
      };
      const stem = path.basename(opts.markerPath).replace(/\.foam$/i, "") || "case";
      const result = await writeMeshFileAsync(sub2, ".foam", {
        name: stem,
        onWarning: (w: string) => diagnostics.push({ line: 0, message: w }),
      });
      const zeroFaceDiagnostics: MdpaDiagnostic[] = [];
      for (const c of result.companions) {
        const mm = /^constant\/polyMesh\/(.+)$/.exec(c.name);
        if (!mm) continue; // time directories the writer synthesizes are not an in-place write
        const name = `${regionPrefix}polyMesh/${mm[1]}`;
        const owned =
          (OWNED_POLYMESH as readonly string[]).some((n) => mm[1] === n) ||
          (OWNED_ZONES as readonly string[]).some((n) => mm[1] === n);
        if (!owned) continue;
        if (mm[1] === "boundary" && exists(boundaryPath)) {
          const onDisk = parseOpenFoamBoundary(await read(boundaryPath), []);
          const text = appendZeroFacePatches(Buffer.from(c.data).toString("utf8"), onDisk, zeroFaceDiagnostics);
          writes.push({ name, data: enc.encode(text) });
          continue;
        }
        writes.push({ name, data: c.data });
      }
      diagnostics.push(...zeroFaceDiagnostics);
      diagnostics.push({ line: 0, message: `${label}: polyMesh rewritten (topology changed).` });
      for (const zone of OWNED_ZONES) {
        const name = `${regionPrefix}polyMesh/${zone}`;
        if (exists(path.join(caseDir, ...name.split("/"))) && !writes.some((w) => w.name === name)) {
          refusals.push({
            path: name,
            reason: "the model no longer carries these zones, so the rewrite would delete this file — delete it explicitly to confirm, or keep the zones",
          });
        }
      }
      // A region the zone check just failed skips its field phase too; the
      // save is refused either way, and other regions still report.
      if (refusals.length > regionFailedBefore) continue;
    }

    await planScopeFields({
      model: sub,
      baseline: subBase,
      caseDir,
      scopeDir,
      scopeLabel: label,
      mode: meshChanged ? "topology" : "geometry",
      topologyFields: "rewrite",
      diagnostics,
      fieldDiagnostics,
      writes,
    });
  }
  if (refusals.length > 0) return { ok: false, refusals };

  diagnostics.push(...fieldDiagnostics);
  const written = new Set(writes.map((w) => w.name));
  return {
    ok: true,
    mode: writes.length === 0 ? "unchanged" : rewroteMesh ? "topology" : "geometry",
    writes,
    preservedCount: tree.filter((f) => !written.has(f.rel)).length,
    diagnostics,
  };
}

/**
 * A decomposed case with a topology change: re-partition the edited model
 * (space-filling curve; KaHIP is absent under Emscripten) over the same
 * processor count and rewrite every processor natively
 * (`openfoamDecomposedWrite.ts`). A new decomposition, never a patch of the
 * old addressing: the old cell/face/point order no longer exists, so every
 * processor's mesh files and addressing are regenerated together. Fields
 * follow the decided semantic: the displayed time's carried fields rewritten
 * wholesale from the model's values, history elsewhere never rewritten.
 */
async function planDecomposedTopology(
  opts: PlanOptions,
  baseline: MdpaModel,
  caseDir: string,
  processors: number[],
  times: OpenFoamTimeDir[],
  timeName: string
): Promise<InPlacePlan> {
  const refusals: InPlaceRefusal[] = [];
  const diagnostics: MdpaDiagnostic[] = [];
  const fieldDiagnostics: MdpaDiagnostic[] = [];
  const writes: MeshioCompanionFile[] = [];
  const enc = new TextEncoder();
  const sorted = [...processors].sort((a, b) => a - b);

  // ---- re-partition ----
  let owned: number[][];
  try {
    const result = await partitionParts(
      opts.model,
      { nparts: sorted.length, method: "sfc", ghostLayers: 0, seed: 0 },
      diagnostics
    );
    const volumeIds = volumeCellIdsInWriteOrder(opts.model);
    const globalOf = new Map(volumeIds.map((id, g) => [id, g]));
    owned = result.parts.map((p) => {
      const ids: number[] = [];
      for (const b of p.model.blocks) {
        if (b.kind !== "Elements") continue;
        if (cellCategory(b.vtkCellType) !== "volume") {
          throw new Error(`Surface element block "${b.name}" cannot be decomposed.`);
        }
        for (const id of b.entityIds) {
          const g = globalOf.get(id);
          if (g === undefined) throw new Error(`Partition part "${p.partId}" names unknown element ${id}.`);
          ids.push(g);
        }
      }
      return ids;
    });
  } catch (e) {
    return {
      ok: false,
      refusals: [
        {
          path: ".",
          reason: `re-partition for the new decomposition failed (${(e as Error).message}); use Export or Save As… instead`,
        },
      ],
    };
  }

  const meta = mergePatchMeta(baseline.source?.openfoam, opts.model.source?.openfoam);
  const tree = await walkCase(caseDir, refusals);
  if (refusals.length > 0) return { ok: false, refusals };
  const carried = new Set(qualifyingVolumeFields(opts.model, [], true).map((q) => q.field.variable));

  // ---- blockers under processorN/ ----
  for (const f of tree) {
    const m = /^processor(\d+)\/(.*)$/.exec(f.rel);
    if (!m) continue; // top-level files are preserved, never blockers
    const rest = m[2];
    const parts = rest.split("/");
    if (parts[0] === "constant" && parts[1] === "polyMesh") {
      if (parts[2] === "sets") {
        refusals.push({ path: f.rel, reason: "a set is keyed by cell/face/point index, which this edit changes" });
      } else if (parts.length === 3) {
        const name = parts[2];
        // Addressing and zones are rewritten, never blockers; the refinement
        // levels and histories have no writer home and keep blocking.
        if (["cellLevel", "pointLevel", "refinementHistory", "surfaceIndex"].includes(name)) {
          refusals.push({ path: f.rel, reason: "keyed by cell/face/point index, which this edit changes" });
        } else if (name.endsWith(".gz")) {
          refusals.push({ path: f.rel, reason: "a compressed copy of a file the rewrite replaces would be left stale beside it — decompress or remove it first" });
        }
      }
      continue;
    }
    // processorN/<time>/... : overlay refuses; fields refuse unless the
    // displayed time's carried ones, which are rewritten wholesale.
    if (parts.length >= 2 && times.some((t) => t.name === parts[0])) {
      if (parts[1] === "polyMesh") {
        refusals.push({ path: f.rel, reason: "a moving-mesh overlay is keyed by point/face index, which this edit changes" });
        continue;
      }
      if (parts.length !== 2 || parts[1] === "uniform") continue;
      if (parts[1].endsWith(".gz")) {
        refusals.push({ path: f.rel, reason: "a compressed field cannot be inspected, so it may be keyed by cell/face index" });
        continue;
      }
      if (parts[0] === timeName && carried.has(parts[1])) continue;
      if (f.size > MAX_FIELD_BYTES) {
        refusals.push({ path: f.rel, reason: "too large to check for index-keyed values" });
        continue;
      }
      const text = await read(path.join(caseDir, f.rel));
      if (/FoamFile/.test(text) && (/\bnonuniform\b/.test(text) || /\bformat\s+binary\s*;/.test(text))) {
        refusals.push({ path: f.rel, reason: "holds per-cell or per-face values keyed by the old index order" });
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // ---- the rewrite ----
  let written: { files: { name: string; data: Uint8Array }[]; localCells: number[][]; procPatches: string[][] };
  try {
    written = writeDecomposedProcessors(
      opts.model,
      { processors: sorted, owned, patchTypes: meta.patchTypes, patchDictionaries: meta.patchDictionaries },
      diagnostics
    );
  } catch (e) {
    return {
      ok: false,
      refusals: [
        {
          path: ".",
          reason: `the decomposed rewrite failed (${(e as Error).message}); use Export or Save As… instead`,
        },
      ],
    };
  }
  for (const f of written.files) writes.push(f);
  diagnostics.push({ line: 0, message: `OpenFOAM in-place save (decomposed): ${sorted.length} processor(s) rewritten with a new decomposition (topology changed).` });
  // Upstream removes a zone file it has nothing to write; an in-place save
  // never deletes, so a zone file the model no longer carries blocks until
  // removed explicitly.
  for (let i = 0; i < sorted.length; i++) {
    for (const zone of OWNED_ZONES) {
      const name = `processor${sorted[i]}/constant/polyMesh/${zone}`;
      if (exists(path.join(caseDir, ...name.split("/"))) && !writes.some((w) => w.name === name)) {
        refusals.push({
          path: name,
          reason: "the model no longer carries these zones, so the rewrite would delete this file — delete it explicitly to confirm, or keep the zones",
        });
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // ---- fields: wholesale rewrite of the displayed time's carried fields ----
  const quals = qualifyingVolumeFields(opts.model, fieldDiagnostics, true);
  for (const q of quals) {
    const v = q.field.variable;
    const dims = (q.field.dimensions?.exponents ?? [0, 0, 0, 0, 0, 0, 0]).join(" ");
    for (let i = 0; i < sorted.length; i++) {
      const relName = `processor${sorted[i]}/${timeName}/${v}`;
      const rows = written.localCells[i].map((g) => q.rows[g]);
      const realEntries = leafPatchParts(opts.model.subModelParts)
        .map((p) => patchBoundaryEntry(opts.model, q.field, p, true))
        .join("");
      const procEntries = written.procPatches[i]
        .map((name) => `    ${name}\n    {\n        type            processor;\n    }\n`)
        .join("");
      const text = renderFreshFoamField(v, q.cls, q.kind, rows, dims, `${realEntries}${procEntries}`);
      writes.push({ name: relName, data: enc.encode(text) });
    }
    diagnostics.push({ line: 0, message: `OpenFOAM in-place save (decomposed): ${timeName}/${v} rewritten on every processor from the model's current values (cell order changed).` });
  }
  diagnostics.push(...fieldDiagnostics);

  const writtenNames = new Set(writes.map((w) => w.name));
  return {
    ok: true,
    mode: "topology",
    writes,
    preservedCount: tree.filter((f) => !writtenNames.has(f.rel)).length,
    diagnostics,
  };
}

/**
 * Decides whether `model` may be written back over its own case and builds
 * exactly the files to write. Never touches the disk beyond reading.
 */
export async function planOpenFoamInPlaceSave(opts: PlanOptions): Promise<InPlacePlan> {
  const caseDir = openFoamCaseDir(opts.markerPath);
  const polyMesh = path.join(caseDir, OPENFOAM_POLYMESH_DIR);
  const refusals: InPlaceRefusal[] = [];
  const diagnostics: MdpaDiagnostic[] = [];

  // ---- shape ----------------------------------------------------------------------
  const regions = listOpenFoamRegions(caseDir);
  const processors = listOpenFoamProcessors(caseDir);
  if (regions.length > 0 || processors.length > 0) {
    if (regions.length > 0 && (processors.length > 0 || exists(polyMesh))) {
      return {
        ok: false,
        refusals: [
          {
            path: ".",
            reason: "the case mixes regions, a top-level constant/polyMesh and/or processorN/ trees; only a pure multi-region or a pure decomposed case can be saved in place",
          },
        ],
      };
    }
    if (processors.length > 0 && exists(polyMesh)) {
      return {
        ok: false,
        refusals: [{ path: "constant/polyMesh", reason: "a decomposed case also holding a top-level polyMesh is ambiguous; it cannot be saved in place" }],
      };
    }
    return planDistributedGeometry(opts, caseDir, regions.length > 0 ? { regions } : { processors });
  }
  for (const name of ["points", "faces", "owner"]) {
    if (!exists(path.join(polyMesh, name))) {
      refusals.push({
        path: rel(OPENFOAM_POLYMESH_DIR, name),
        reason: exists(path.join(polyMesh, `${name}.gz`))
          ? "only a compressed copy exists; it cannot be edited in place — decompress it first"
          : "the file is missing",
      });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // ---- baseline: the case as it is on disk now ----------------------------------
  const times = await listOpenFoamTimes(caseDir);
  const stepIndex = times.length > 0 ? Math.min(Math.max(opts.timeStep ?? 0, 0), times.length - 1) : undefined;
  const timeName = stepIndex !== undefined ? times[stepIndex].name : "0";
  let baseline: MdpaModel;
  try {
    baseline = await parseMeshFile(opts.markerPath, undefined, stepIndex !== undefined ? { timeStep: stepIndex } : undefined);
  } catch (e) {
    return { ok: false, refusals: [{ path: ".", reason: `the case on disk cannot be re-read to compare against (${(e as Error).message})` }] };
  }

  const sameMesh = meshKey(baseline) === meshKey(opts.model);
  const samePatches = patchKey(baseline) === patchKey(opts.model);
  const mode: InPlaceMode = sameMesh && samePatches ? "geometry" : "topology";

  const tree = await walkCase(caseDir, refusals);
  const fieldDiagnostics: MdpaDiagnostic[] = [];
  const writes: MeshioCompanionFile[] = [];
  const enc = new TextEncoder();

  if (mode === "geometry") {
    if (opts.model.nodeCount < baseline.nodeCount) {
      return { ok: false, refusals: [{ path: ".", reason: "the model lost nodes but kept its connectivity; nothing consistent can be written" }] };
    }
    const pointsPath = path.join(polyMesh, "points");
    const layout = parsePointsLayout(await read(pointsPath));
    if (!layout) {
      refusals.push({ path: rel(OPENFOAM_POLYMESH_DIR, "points"), reason: "not an ASCII point list this check can edit (binary or malformed)" });
    } else if (layout.spans.length > baseline.nodeCount) {
      refusals.push({ path: rel(OPENFOAM_POLYMESH_DIR, "points"), reason: `lists ${layout.spans.length} points but the case read back ${baseline.nodeCount}` });
    } else {
      const { text, moved } = rewritePoints(layout, baseline.coords, opts.model.coords);
      if (moved > 0) {
        writes.push({ name: rel(OPENFOAM_POLYMESH_DIR, "points"), data: enc.encode(text) });
        diagnostics.push({ line: 0, message: `OpenFOAM in-place save: ${moved} of ${layout.spans.length} point(s) rewritten; every other file in the case is untouched.` });
      }
    }
  } else {
    // ---- topology: what the rewrite would leave dangling ------------------------
    const cells = await declaredCellCount(polyMesh);
    const baselineVolume = volumeCellIdsInWriteOrder(baseline).length;
    if (cells === undefined || cells !== baselineVolume) {
      refusals.push({
        path: rel(OPENFOAM_POLYMESH_DIR, "owner"),
        reason:
          cells === undefined
            ? "not an ASCII label list this check can read, so the cell count cannot be verified"
            : `the case has ${cells} cell(s) but ${baselineVolume} were read: polyhedral cells are decomposed on read, so the rewrite could not reproduce them`,
      });
    }
    for (const f of tree) {
      const parts = f.rel.split("/");
      const inPoly = f.rel.startsWith(`${OPENFOAM_POLYMESH_DIR}/`);
      if (inPoly) {
        const sub = parts.slice(2);
        const name = sub[0];
        if (sub.length > 1 && name === "sets") refusals.push({ path: f.rel, reason: "a set is keyed by cell/face/point index, which this edit changes" });
        else if (sub.length === 1 && INDEX_KEYED_POLYMESH.has(name)) refusals.push({ path: f.rel, reason: "keyed by cell/face/point index, which this edit changes" });
        else if (sub.length === 1 && name.endsWith(".gz") && (OWNED_POLYMESH as readonly string[]).includes(name.slice(0, -3))) {
          refusals.push({ path: f.rel, reason: "a compressed copy of a file the rewrite replaces would be left stale beside it — decompress or remove it first" });
        }
        continue;
      }
      const top = parts[0];
      if (parts.length >= 2 && times.some((t) => t.name === top)) {
        if (parts[1] === "polyMesh") {
          refusals.push({ path: f.rel, reason: "a moving-mesh overlay is keyed by point/face index, which this edit changes" });
        } else if (parts.length === 2 && parts[1] !== "uniform") {
          if (f.rel.endsWith(".gz")) {
            refusals.push({ path: f.rel, reason: "a compressed field cannot be inspected, so it may be keyed by cell/face index" });
          } else if (f.size > MAX_FIELD_BYTES) {
            refusals.push({ path: f.rel, reason: "too large to check for index-keyed values" });
          } else {
            const text = await read(path.join(caseDir, f.rel));
            if (/FoamFile/.test(text) && (/\bnonuniform\b/.test(text) || /\bformat\s+binary\s*;/.test(text))) {
              refusals.push({ path: f.rel, reason: "holds per-cell or per-face values keyed by the old index order" });
            }
          }
        }
      }
    }
    if (refusals.length === 0) {
      // The ordinary writer, with the patch dictionaries read back from disk:
      // `source` was probably dropped by whatever op changed the topology.
      const stem = path.basename(opts.markerPath).replace(/\.foam$/i, "") || "case";
      const asRead = baseline.source?.openfoam;
      const own = opts.model.source?.openfoam;
      const model2: MdpaModel = {
        ...opts.model,
        source: {
          format: "openfoam",
          ...opts.model.source,
          openfoam: mergePatchMeta(asRead, own),
        },
      };
      const result = await writeMeshFileAsync(model2, ".foam", {
        name: stem,
        onWarning: (w: string) => diagnostics.push({ line: 0, message: w }),
      });
      const boundaryPath = path.join(polyMesh, "boundary");
      const zeroFaceDiagnostics: MdpaDiagnostic[] = [];
      for (const c of result.companions) {
        if (c.name === rel(OPENFOAM_POLYMESH_DIR, "boundary") && exists(boundaryPath)) {
          // A zero-face patch has no conditions, so the model cannot carry it:
          // keep the ones the case on disk declares.
          const onDisk = parseOpenFoamBoundary(await read(boundaryPath), []);
          const text = appendZeroFacePatches(Buffer.from(c.data).toString("utf8"), onDisk, zeroFaceDiagnostics);
          writes.push({ name: c.name, data: enc.encode(text) });
          continue;
        }
        if (!(OWNED_POLYMESH as readonly string[]).some((n) => c.name === rel(OPENFOAM_POLYMESH_DIR, n))) {
          // Zone files the writer owns: genuine zone parts round-trip through
          // named regions (cellZones/faceZones/pointZones). Anything else the
          // writer leaves beside the case (time directories it synthesizes)
          // is not an in-place write.
          if (!(OWNED_ZONES as readonly string[]).some((n) => c.name === rel(OPENFOAM_POLYMESH_DIR, n))) continue;
        }
        writes.push(c);
      }
      diagnostics.push(...zeroFaceDiagnostics);
      diagnostics.push({ line: 0, message: "OpenFOAM in-place save: constant/polyMesh rewritten (topology changed)." });
      // Upstream removes a zone file it has nothing to write; an in-place
      // save never deletes, so a zone file the model no longer carries
      // blocks the save until it is removed explicitly.
      for (const zone of OWNED_ZONES) {
        const name = rel(OPENFOAM_POLYMESH_DIR, zone);
        if (exists(path.join(polyMesh, zone)) && !writes.some((w) => w.name === name)) {
          refusals.push({
            path: name,
            reason: "the model no longer carries these zones, so the rewrite would delete this file — delete it explicitly to confirm, or keep the zones",
          });
        }
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // ---- fields in the displayed time directory ----------------------------------
  await planScopeFields({
    model: opts.model,
    baseline,
    caseDir,
    scopeDir: timeName,
    scopeLabel: "OpenFOAM in-place save",
    mode,
    topologyFields: "keep",
    diagnostics,
    fieldDiagnostics,
    writes,
  });
  diagnostics.push(...fieldDiagnostics);

  const written = new Set(writes.map((w) => w.name));
  return {
    ok: true,
    mode: writes.length === 0 ? "unchanged" : mode,
    writes,
    preservedCount: tree.filter((f) => !written.has(f.rel)).length,
    diagnostics,
  };
}

/** Patch names, types and dictionaries: the read side's record merged with the model's own. Shared by the single-region and decomposed rewrites. */
function mergePatchMeta(
  asRead?: { patchTypes?: Record<string, string>; patchDictionaries?: Record<string, string> },
  own?: { patchTypes?: Record<string, string>; patchDictionaries?: Record<string, string> }
): { patchTypes: Record<string, string>; patchDictionaries: Record<string, string> } {
  return {
    patchTypes: { ...asRead?.patchTypes, ...own?.patchTypes },
    patchDictionaries: { ...asRead?.patchDictionaries, ...own?.patchDictionaries },
  };
}

/** Writes a plan's files atomically (temp file + rename); nothing else is touched. */
export async function applyInPlacePlan(
  markerPath: string,
  plan: Extract<InPlacePlan, { ok: true }>
): Promise<void> {
  const caseDir = path.resolve(openFoamCaseDir(markerPath));
  for (const w of plan.writes) {
    if (!isSafeEntryName(w.name)) throw new Error(`Refusing to write unsafe path "${w.name}".`);
    const dest = path.join(caseDir, ...w.name.split("/"));
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.kratos-tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, w.data);
    await fs.promises.rename(tmp, dest);
  }
}

/** The refusal text both front ends show: up to `max` file names, then a count. */
export function describeInPlaceRefusals(refusals: readonly InPlaceRefusal[], max = 8): string {
  const shown = refusals.slice(0, max).map((r) => `  • ${r.path} — ${r.reason}`);
  const more = refusals.length > max ? `\n  … and ${refusals.length - max} more` : "";
  return (
    "Saving in place would leave this OpenFOAM case inconsistent, so nothing was written. " +
    `Use Export or Save As… to write a new case directory instead, or resolve:\n${shown.join("\n")}${more}`
  );
}

/**
 * The refusal for any write that is NOT the approved in-place save but would
 * land in the case the model was read from — an export, Save As, a sub-part or
 * partition export, `mesh_convert` onto the source … `undefined` when the
 * destination is elsewhere. One text for the extension and the MCP server.
 */
export function refuseWriteIntoSourceCase(sourceFile: string | undefined, destFsPath: string): string | undefined {
  if (!sourceFile || !wouldOverwriteOpenFoamCase(sourceFile, destFsPath)) return undefined;
  return (
    "That would overwrite this case's constant/polyMesh — the mesh being read. " +
    "Only Save (or an MCP write onto the source with no other output) may rewrite a case in place, " +
    "and it lists what it touches first. Choose a different directory."
  );
}
