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
 *   rename …). The six polyMesh files are rewritten by the ordinary writer,
 *   and every file keyed by the OLD index order blocks the save by name:
 *   `faceZones`, `pointZones`, `sets/`, `cellLevel`, `pointLevel`,
 *   `refinementHistory`, `surfaceIndex`, `<time>/polyMesh`, and any
 *   time-directory field with a `nonuniform` (or compressed/binary) list.
 *
 * Field files are never replaced wholesale: an existing `<time>/<VAR>` whose
 * values changed gets only its `internalField` entry replaced (geometry mode),
 * so `dimensions` and the real `boundaryField` survive; a field that has no
 * file yet is written new with `zeroGradient` patches, as an export does.
 *
 * Multi-region (`constant/<region>/polyMesh`) and decomposed (`processorN/`)
 * cases are refused by name. Item 13 stays open for them.
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
  listOpenFoamProcessors,
  listOpenFoamRegions,
  listOpenFoamTimes,
  openFoamCaseDir,
  parseAsciiLabelList,
  wouldOverwriteOpenFoamCase,
} from "./openfoamCase";
import { qualifyingVolumeFields, replaceInternalField, volumeCellIdsInWriteOrder } from "./openfoamFieldWrite";
import { leafPatchParts } from "./openfoamWrite";
import { isSafeEntryName } from "./problemZip";
import type { MdpaDiagnostic, MdpaModel } from "./types";
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
  "faceZones",
  "pointZones",
  "cellLevel",
  "pointLevel",
  "refinementHistory",
  "surfaceIndex",
  "pointProcAddressing",
  "faceProcAddressing",
  "cellProcAddressing",
  "boundaryProcAddressing",
]);

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

/**
 * Decides whether `model` may be written back over its own case and builds
 * exactly the files to write. Never touches the disk beyond reading.
 */
export async function planOpenFoamInPlaceSave(opts: PlanOptions): Promise<InPlacePlan> {
  const caseDir = openFoamCaseDir(opts.markerPath);
  const polyMesh = path.join(caseDir, OPENFOAM_POLYMESH_DIR);
  const refusals: InPlaceRefusal[] = [];
  const diagnostics: MdpaDiagnostic[] = [];

  // ---- shape: single region only ------------------------------------------------
  for (const r of listOpenFoamRegions(caseDir)) {
    refusals.push({
      path: rel("constant", r),
      reason: "a multi-region case cannot be saved in place yet; the writer produces one constant/polyMesh",
    });
  }
  for (const n of listOpenFoamProcessors(caseDir)) {
    refusals.push({
      path: `processor${n}`,
      reason: "a decomposed case cannot be saved in place yet; the writer produces no processorN/ tree",
    });
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
          openfoam: {
            patchTypes: { ...asRead?.patchTypes, ...own?.patchTypes },
            patchDictionaries: { ...asRead?.patchDictionaries, ...own?.patchDictionaries },
          },
        },
      };
      const result = await writeMeshFileAsync(model2, ".foam", {
        name: stem,
        onWarning: (w: string) => diagnostics.push({ line: 0, message: w }),
      });
      for (const c of result.companions) {
        if ((OWNED_POLYMESH as readonly string[]).some((n) => c.name === rel(OPENFOAM_POLYMESH_DIR, n))) writes.push(c);
      }
      diagnostics.push({ line: 0, message: "OpenFOAM in-place save: constant/polyMesh rewritten (topology changed)." });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  // ---- fields in the displayed time directory ----------------------------------
  const timeDir = path.join(caseDir, timeName);
  for (const q of qualifyingVolumeFields(opts.model, fieldDiagnostics, true)) {
    const v = q.field.variable;
    const file = path.join(timeDir, v);
    const before = baseline.fields.find((f) => f.kind === "Elemental" && f.variable === v);
    const unchanged =
      before !== undefined &&
      before.values.length === q.field.values.length &&
      before.values.every((x, i) => x === q.field.values[i]);
    if (unchanged) continue;
    if (exists(file)) {
      if (mode !== "geometry") {
        diagnostics.push({ line: 0, message: `OpenFOAM in-place save: ${timeName}/${v} exists and is kept as it is (cell order changed, so its values cannot be matched).` });
        continue;
      }
      const next = replaceInternalField(await read(file), q.cls, q.kind, q.rows);
      if (next === undefined) {
        diagnostics.push({ line: 0, message: `OpenFOAM in-place save: ${timeName}/${v} could not be edited safely (binary, or a different class) and is kept as it is.` });
        continue;
      }
      writes.push({ name: rel(timeName, v), data: enc.encode(next) });
    } else if (exists(`${file}.gz`)) {
      diagnostics.push({ line: 0, message: `OpenFOAM in-place save: ${timeName}/${v}.gz exists and is kept as it is.` });
    } else {
      const patchNames = leafPatchParts(opts.model.subModelParts).map((p) => p.name);
      const bnd = patchNames.map((n) => `    ${n}\n    {\n        type            zeroGradient;\n    }\n`).join("");
      const dims = (q.field.dimensions?.exponents ?? [0, 0, 0, 0, 0, 0, 0]).join(" ");
      const text =
        `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${q.cls};\n    object      ${v};\n}\n\n` +
        `dimensions      [${dims}];\n\ninternalField   nonuniform List<${q.kind}>\n${q.rows.length}\n(\n${q.rows.join("\n")}\n)\n;\n\n` +
        `boundaryField\n{\n${bnd}}\n`;
      writes.push({ name: rel(timeName, v), data: enc.encode(text) });
    }
  }
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
