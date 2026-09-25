/**
 * Reading an OpenFOAM case.
 *
 * A case is a DIRECTORY — `<case>/constant/polyMesh/{points,faces,owner,…}` —
 * addressed by convention through a 0-byte `<case>/x.foam` marker, which is
 * what ParaView uses and what this extension's own exporter writes. That marker
 * is the only handle a VS Code custom editor can bind to (a custom editor
 * cannot open a folder), and it is also all upstream needs: measured against
 * the live 12.0.0 wasm, `readMesh(p, "openfoam")` matches a `.foam` suffix **by
 * name**, so the marker need not even exist inside the staging filesystem.
 *
 * Three things upstream does not give us, each handled here rather than
 * discovered by a user:
 *
 *  - **Patch names.** A case with `inlet`/`outlet` reads back with `regions: []`
 *    and the patches encoded only as `cell_tags = -(patchIndex + 1)` on the
 *    boundary block. The names live in `constant/polyMesh/boundary`, which is
 *    plain ASCII, so `parseOpenFoamBoundary` recovers them and
 *    `applyOpenFoamPatches` joins them on. Without this a CFD mesh arrives with
 *    anonymous boundaries and cannot be used to assign a boundary condition,
 *    which is most of the reason to open one.
 *  - **Compression.** `writeCompression on` stores `points.gz`; the reader opens
 *    bare names only, so the gunzip happens during staging.
 *  - **What is NOT staged.** Since 11.4.0 upstream crosses zone files as named
 *    regions, and reads multi-region/decomposed cases — but this collector
 *    stages only the mesh files, so those never reach the reader here. Each
 *    still gets a diagnostic, because a mesh that quietly lacks half a case
 *    is worse than one that says so. See `diagnoseIgnored` below and the
 *    tests it names; full zone/multi-region/decomposed integration is a
 *    roadmap item of its own.
 *  - **Time fields.** Since 11.4.0 upstream ALSO attaches time-zero's
 *    `<time>/<field>` dictionaries as point/cell data on a plain read — but
 *    `vol*Field`/`point*Field` dictionaries are still parsed natively here
 *    (see `openfoamFields.ts` and `augmentMeshioWithFoamFields` below), which
 *    overwrite the same keys with the boundary-NaN-filled form the sparse
 *    field path needs. The numeric time directories drive the in-file
 *    timeline as before.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import type { MdpaDiagnostic, MdpaModel, EntityBlock, SubModelPart, FieldData } from "./types";
import type { MeshioInputFile } from "./meshio";
import { isRectangularCellBlock, meshioBlockRowCount, sanitizeVariable, meshioDataToNumbers } from "./meshioConvert";
import type { MeshioMesh } from "./meshioConvert";
import type { OpenFoamParsedField } from "./openfoamFields";
import { sortedUnique } from "./meshioRegions";

/** One numeric time directory: exact spelling plus its numeric value. */
export interface OpenFoamTimeDir {
  name: string;
  value: number;
}

/** True for a numeric OpenFOAM time name (incl. `0`, decimals, exponents, signs). */
export function isOpenFoamTimeName(name: string): boolean {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(name)) return false;
  return Number.isFinite(Number(name));
}

function isExcludedTopLevel(name: string): boolean {
  if (name === "constant" || name === "system") return true;
  if (name.startsWith("processor")) return true;
  if (name.endsWith(".orig")) return true;
  return false;
}

/** Numeric time directories, numerically ordered (name tie-break), best-effort `[]`. */
export function listOpenFoamTimesSync(caseDir: string): OpenFoamTimeDir[] {
  let entries;
  try {
    entries = fs.readdirSync(caseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: OpenFoamTimeDir[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || isExcludedTopLevel(e.name) || !isOpenFoamTimeName(e.name)) continue;
    out.push({ name: e.name, value: Number(e.name) });
  }
  out.sort((a, b) => a.value - b.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Async sibling for the read path (same ordering). */
export async function listOpenFoamTimes(caseDir: string): Promise<OpenFoamTimeDir[]> {
  let entries;
  try {
    entries = await fs.promises.readdir(caseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: OpenFoamTimeDir[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || isExcludedTopLevel(e.name) || !isOpenFoamTimeName(e.name)) continue;
    out.push({ name: e.name, value: Number(e.name) });
  }
  out.sort((a, b) => a.value - b.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Regular files directly inside a time directory (field candidates), sorted.
 *
 * `region` (roadmap item 3, Step 5): a multi-region case's fields live at
 * `<time>/<region>/<field>`, not `<time>/<field>` — the single-region layout
 * this function already served unchanged (`region` omitted).
 */
export function listOpenFoamTimeFieldNames(
  caseDir: string,
  timeName: string,
  region?: string
): string[] {
  let entries;
  try {
    entries = fs.readdirSync(path.join(caseDir, timeName, region ?? ""), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/** Reads `<dir>/<name>`, or inflates `<name>.gz`; undefined when neither exists. */
export function readFoamFile(dir: string, name: string): Buffer | undefined {
  const plain = path.join(dir, name);
  try {
    return fs.readFileSync(plain);
  } catch {
    /* try the compressed form */
  }
  try {
    return zlib.gunzipSync(fs.readFileSync(`${plain}.gz`));
  } catch {
    return undefined;
  }
}

/** The polyMesh files upstream opens, in the order it opens them. */
export const OPENFOAM_POLYMESH_FILES = [
  "points",
  "faces",
  "owner",
  "neighbour",
  "boundary",
] as const;

/**
 * Zone files (roadmap item 3): all optional, and staged separately from
 * OPENFOAM_POLYMESH_FILES rather than added to it, because their absence is
 * the ORDINARY case (most meshes define no zones at all) and must never
 * produce a diagnostic the way a missing `boundary` does. Staged as
 * `mesh.regions` named `cellZones`/`faceZones`/`pointZones` groups since
 * meshio++ >= 11.4.0 (measured live — see meshio.test.ts's "cellZones cross
 * the reader as named Cell regions since 11.4.0"); `regionsToParts` turns
 * them into SubModelParts the same as any other format's named groups.
 */
export const OPENFOAM_ZONE_FILES = ["cellZones", "faceZones", "pointZones"] as const;

/**
 * Measured: without these the read fails naming the missing file. `neighbour`
 * and `boundary` are optional — dropping `boundary` costs the boundary-face
 * block entirely, which is why its absence is a diagnostic rather than silence.
 */
export const OPENFOAM_REQUIRED_FILES = ["points", "faces", "owner"] as const;

/** Where the mesh lives, relative to the case directory. */
export const OPENFOAM_POLYMESH_DIR = "constant/polyMesh";

/** One `constant/polyMesh/boundary` entry. Its INDEX is load-bearing. */
export interface OpenFoamPatch {
  name: string;
  /** `patch` | `wall` | `empty` | `symmetry` | …; "" when the entry omits it. */
  type: string;
  nFaces?: number;
  startFace?: number;
  /** The name was invented because the entry could not be read. */
  synthesized?: boolean;
}

/** `<case>` for `<case>/x.foam`; the argument itself for a directory. */
export function openFoamCaseDir(fsPath: string): string {
  return path.extname(fsPath).toLowerCase() === ".foam" ? path.dirname(fsPath) : fsPath;
}

// ---- boundary ----------------------------------------------------------------

/** Drops `/* … *​/` and `// …` so brace matching cannot trip over them. */
function stripFoamComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Index just past the `{` … `}` starting at `open`, or -1 if unbalanced. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The `boundary` dictionary's patch list, in FILE ORDER.
 *
 * **Never skips an entry, and never throws.** The join downstream is positional
 * — a face tagged `-3` is the third patch — so dropping one malformed entry
 * would silently rename every patch after it, which looks exactly like success.
 * An unreadable entry therefore becomes a `synthesized` placeholder that holds
 * its index. Everything else degrades to a diagnostic and an empty list, the
 * recipe-style tolerance this codebase already uses for untrusted disk input.
 */
export function parseOpenFoamBoundary(
  text: string,
  diagnostics: MdpaDiagnostic[]
): OpenFoamPatch[] {
  const src = stripFoamComments(text);

  // Skip the FoamFile header dictionary if present; a raw list is fine too.
  let from = 0;
  const header = src.indexOf("FoamFile");
  if (header >= 0) {
    const brace = src.indexOf("{", header);
    if (brace >= 0) {
      const end = matchBrace(src, brace);
      if (end > 0) from = end;
    }
  }

  // An entry count may precede the list; keep it only to cross-check.
  const countMatch = /(\d+)\s*\(/.exec(src.slice(from));
  const declared = countMatch ? parseInt(countMatch[1], 10) : undefined;

  const listOpen = src.indexOf("(", from);
  if (listOpen < 0) {
    diagnostics.push({
      line: 0,
      message: "constant/polyMesh/boundary has no patch list; boundary faces stay unnamed.",
    });
    return [];
  }
  // The list's own closing paren: the last one in the file, since patch bodies
  // use braces rather than parens (an `inGroups (wall);` sits inside a body).
  const listClose = src.lastIndexOf(")");
  if (listClose <= listOpen) {
    diagnostics.push({
      line: 0,
      message: "constant/polyMesh/boundary's patch list is not closed; boundary faces stay unnamed.",
    });
    return [];
  }

  const body = src.slice(listOpen + 1, listClose);
  const patches: OpenFoamPatch[] = [];
  const name = /([A-Za-z_][\w.\-]*)\s*\{/g;
  let cursor = 0;
  for (;;) {
    name.lastIndex = cursor;
    const m = name.exec(body);
    if (!m) break;
    const braceAt = body.indexOf("{", m.index);
    const end = matchBrace(body, braceAt);
    if (end < 0) {
      // The index must survive even though the entry cannot be read.
      patches.push({ name: `patch_${patches.length}`, type: "", synthesized: true });
      diagnostics.push({
        line: 0,
        message:
          `constant/polyMesh/boundary: patch "${m[1]}" has an unterminated body; ` +
          `it keeps its position as "patch_${patches.length - 1}" so later patch names stay correct.`,
      });
      break;
    }
    const entry = body.slice(braceAt, end);
    const num = (key: string): number | undefined => {
      const v = new RegExp(`\\b${key}\\s+(\\d+)\\s*;`).exec(entry);
      return v ? parseInt(v[1], 10) : undefined;
    };
    patches.push({
      name: m[1],
      type: /\btype\s+([A-Za-z_]\w*)\s*;/.exec(entry)?.[1] ?? "",
      nFaces: num("nFaces"),
      startFace: num("startFace"),
    });
    cursor = end;
  }

  if (patches.length === 0) {
    diagnostics.push({
      line: 0,
      message: "constant/polyMesh/boundary declares no patches; boundary faces stay unnamed.",
    });
  } else if (declared !== undefined && declared !== patches.length) {
    diagnostics.push({
      line: 0,
      message:
        `constant/polyMesh/boundary declares ${declared} patch(es) but ${patches.length} could be read` +
        (/#include/.test(src) ? " (it uses #include, which is not resolved here)." : "."),
    });
  }
  return patches;
}

/**
 * Parses a plain OpenFOAM `labelList` file (`pointProcAddressing`, etc.): a
 * `FoamFile` header (skipped, same as `parseOpenFoamBoundary`) followed by a
 * count and a parenthesized list of one integer per line. Malformed input is
 * `undefined`, never a throw — a decomposed case's addressing files are
 * read-only bookkeeping we did not write, and a bad one should degrade the
 * reconstruction's cross-checks rather than abort the whole read.
 */
export function parseAsciiLabelList(text: string): number[] | undefined {
  const src = stripFoamComments(text);
  let from = 0;
  const header = src.indexOf("FoamFile");
  if (header >= 0) {
    const brace = src.indexOf("{", header);
    if (brace >= 0) {
      const end = matchBrace(src, brace);
      if (end > 0) from = end;
    }
  }
  const listOpen = src.indexOf("(", from);
  if (listOpen < 0) return undefined;
  const listClose = src.indexOf(")", listOpen);
  if (listClose < 0) return undefined;
  const body = src.slice(listOpen + 1, listClose);
  const out: number[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    const v = Number(t);
    if (!Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

// ---- staging -----------------------------------------------------------------

function polyMeshDir(caseDir: string): string {
  return path.join(caseDir, "constant", "polyMesh");
}

/** Reads `<n>`, or inflates `<n>.gz`; undefined when neither exists. */
function readPolyMeshFile(dir: string, name: string): Buffer | undefined {
  return readFoamFile(dir, name);
}

/** Names what the case contains that this collector does not stage. */
/**
 * Names the parts of a case this reader leaves behind.
 *
 * Since meshio++ 11.4.0 (Tier B2) the READER crosses zone files as named
 * `Region`s — a staged `cellZones` arrives as a SubModelPart — but this
 * collector still stages only `OPENFOAM_POLYMESH_FILES`, so a zone file on
 * disk never reaches the virtual filesystem. That split is deliberate for
 * now: the writer emits a `cellZones` of its own from the block Cell regions
 * (so every export carries one), and staging it back would resurrect a bogus
 * block-named zone part on every re-read of our own output. Full zone
 * integration — staging, patch-type recovery, multi-region and decomposed
 * cases — is a roadmap item of its own, not this adapter.
 *
 * The zone claim still had to be earned, and once rested on an `existsSync`
 * alone, which could be neither wrong nor right for the reason above. It is
 * measured properly by handing the reader a zone file directly, bypassing
 * this collector — see `src/test/meshio.test.ts` ("cellZones cross the reader
 * as named Cell regions since 11.4.0" alongside "the staged polyMesh
 * directory IS the one the reader opens", which keeps "changed nothing" and
 * "was never looked at" separate observations).
 */
/**
 * Region names: every `constant/<name>` directory (other than `polyMesh`
 * itself) that carries its own `<name>/polyMesh` — the multi-region layout
 * upstream's own `read_openfoam` scans for when no top-level
 * `constant/polyMesh` exists (see `read_openfoam`'s `regionProperties`
 * branch in meshioplusplus' openfoam.cpp — that branch only fires to build
 * an error message naming the regions, since `OpenFoamInfo::mRegion` is a
 * C++-only field never bound to JS; this extension's own region reading
 * (Step 5, roadmap item 3) goes around it entirely by reading each region's
 * `constant/<name>/polyMesh` DIRECTORY directly — measured: `read_openfoam`
 * accepts a bare path whose filename is literally `polyMesh`). Sorted for a
 * deterministic merge order.
 */
export function listOpenFoamRegions(caseDir: string): string[] {
  let entries;
  try {
    entries = fs.readdirSync(path.join(caseDir, "constant"), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== "polyMesh")
    .filter((e) => fs.existsSync(path.join(caseDir, "constant", e.name, "polyMesh")))
    .map((e) => e.name)
    .sort();
}

/**
 * A decomposed case's processor ids: every `processorN/` directory (N =
 * digits only) carrying its own `constant/polyMesh` — mirrors upstream's
 * `foam_processor_ids`. Sorted ascending.
 */
export function listOpenFoamProcessors(caseDir: string): number[] {
  let entries;
  try {
    entries = fs.readdirSync(caseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: number[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /^processor(\d+)$/.exec(e.name);
    if (!m) continue;
    if (!fs.existsSync(path.join(caseDir, e.name, "constant", "polyMesh"))) continue;
    ids.push(parseInt(m[1], 10));
  }
  ids.sort((a, b) => a - b);
  return ids;
}

function diagnoseIgnored(caseDir: string, diagnostics: MdpaDiagnostic[]): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(caseDir);
  } catch {
    return;
  }
  if (entries.some((e) => /^processor\d+$/.test(e))) {
    diagnostics.push({
      line: 0,
      message:
        "OpenFOAM: this looks like a decomposed case (processor*/) that ALSO has its own " +
        "constant/polyMesh; the already-reconstructed constant/polyMesh is read, not the " +
        "processor directories.",
    });
  }
  // A time directory holding its own polyMesh is a moving mesh: since time
  // fields are read, the selected step overlays its polyMesh files over
  // constant/polyMesh (missing files fall back to constant). Reported so a
  // partially overridden mesh is not a surprise.
  const times = listOpenFoamTimesSync(caseDir);
  const moving = times.filter((t) => fs.existsSync(path.join(caseDir, t.name, "polyMesh")));
  if (moving.length > 0) {
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: ${moving.length} time ${moving.length === 1 ? "directory" : "directories"} ` +
        `(${moving.map((t) => t.name).join(", ")}) carr${moving.length === 1 ? "ies" : "y"} ` +
        "their own polyMesh; the selected step uses its files over constant/polyMesh.",
    });
  }
  // Multi-region cases keep extra constant/<region>/polyMesh trees ALONGSIDE
  // a top-level constant/polyMesh — an unusual layout (ordinarily a
  // multi-region case has no top-level constant/polyMesh at all, which is
  // the case listOpenFoamRegions/the top-level dispatch reads every region
  // for — see meshFileParser.ts's .foam branch). Only the top-level
  // constant/polyMesh is read here.
  const regions = listOpenFoamRegions(caseDir);
  if (regions.length > 0) {
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: multi-region case (${regions.join(", ")}); only constant/polyMesh is read.`,
    });
  }
}

/**
 * Reads a case's polyMesh into staging entries, plus its patch names.
 *
 * `timeName` selects a step whose `<time>/polyMesh/*` files overlay
 * `constant/polyMesh` file-by-file (a moving mesh commonly overrides only
 * `points`); omitted means constant alone. Throws naming the file when a
 * REQUIRED one is missing, rather than letting the wasm fail: that failure
 * is an `FS.ErrnoError` whose `message` is `undefined`, so the user would
 * see nothing useful.
 *
 * `region` (roadmap item 3, Step 5): reads `constant/<region>/polyMesh`
 * instead of `constant/polyMesh` (its `<time>/<region>/polyMesh` overlay for
 * a moving multi-region mesh), and stages the files at a bare `polyMesh/…`
 * name rather than `constant/polyMesh/…` — the caller then reads them by
 * pointing meshio++'s explicit-format `readMesh` at that staged `polyMesh`
 * DIRECTORY directly (measured against the live wasm: `read_openfoam`
 * accepts any path whose filename is literally `polyMesh`), which is what
 * lets this reuse the exact single-region pipeline per region with no
 * `OpenFoamInfo::mRegion` (a C++-only field, never bound to JS). A region
 * read also skips `diagnoseIgnored`: the caller already knows it is reading
 * one region deliberately, so the "multi-region case; only constant/polyMesh
 * is read" wording (accurate for the DEFAULT-region path) would be actively
 * wrong here.
 */
export async function collectOpenFoamCase(
  caseDir: string,
  diagnostics: MdpaDiagnostic[],
  opts?: { timeName?: string; region?: string }
): Promise<{ files: MeshioInputFile[]; patches: OpenFoamPatch[] }> {
  const region = opts?.region;
  const dir = region ? path.join(caseDir, "constant", region, "polyMesh") : polyMeshDir(caseDir);
  const overlayDir = region
    ? (name: string) => path.join(caseDir, name, region, "polyMesh")
    : (name: string) => path.join(caseDir, name, "polyMesh");
  const overlay = opts?.timeName ? overlayDir(opts.timeName) : undefined;
  const stagePrefix = region ? "polyMesh" : OPENFOAM_POLYMESH_DIR;
  if (!fs.existsSync(dir) && !(overlay && fs.existsSync(overlay))) {
    throw new Error(
      region
        ? `OpenFOAM region "${region}" has no ${path.join("constant", region, "polyMesh")}.`
        : `Not an OpenFOAM case: ${path.join(caseDir, OPENFOAM_POLYMESH_DIR)} does not exist.`
    );
  }
  const files: MeshioInputFile[] = [];
  let patches: OpenFoamPatch[] = [];
  for (const name of OPENFOAM_POLYMESH_FILES) {
    const data = (overlay && readPolyMeshFile(overlay, name)) ?? readPolyMeshFile(dir, name);
    if (!data) {
      if ((OPENFOAM_REQUIRED_FILES as readonly string[]).includes(name)) {
        throw new Error(
          `OpenFOAM case is missing ${region ? `constant/${region}/polyMesh` : OPENFOAM_POLYMESH_DIR}/${name}.`
        );
      }
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM: ${region ? `constant/${region}/polyMesh` : OPENFOAM_POLYMESH_DIR}/${name} is missing` +
          (name === "boundary"
            ? " — the mesh has no boundary faces and its patches cannot be named."
            : "."),
      });
      continue;
    }
    files.push({ name: `${stagePrefix}/${name}`, data: new Uint8Array(data) });
    if (name === "boundary") patches = parseOpenFoamBoundary(data.toString("utf8"), diagnostics);
  }
  // Zone files: staged when present, silently skipped when not (see
  // OPENFOAM_ZONE_FILES' own doc comment for why their absence is routine).
  for (const name of OPENFOAM_ZONE_FILES) {
    const data = (overlay && readPolyMeshFile(overlay, name)) ?? readPolyMeshFile(dir, name);
    if (data) files.push({ name: `${stagePrefix}/${name}`, data: new Uint8Array(data) });
  }
  if (!region) diagnoseIgnored(caseDir, diagnostics);
  return { files, patches };
}

/**
 * Reads a decomposed (`processorN/`) case: stages every processor's own
 * `constant/polyMesh/*` plus its `*ProcAddressing` files at their real
 * on-disk relative layout (`processorN/constant/polyMesh/…`, sibling of the
 * `.foam` marker), which upstream's own `reconstruct_decomposed` (measured
 * against the live wasm — see the roadmap item 3 plan's own probe) merges
 * into one global mesh: points/cells/faces at the ids their processor's
 * `*ProcAddressing` name, a face claimed by two processors becomes an
 * internal face, one claimed by exactly one becomes either a genuine
 * boundary face or is dropped as an inter-processor `processor*` patch face.
 *
 * Patch NAMES have no case-root file to read them from (there is no
 * `constant/polyMesh/boundary` at all), so they are recovered from
 * `processor0`'s own LOCAL `constant/polyMesh/boundary`, filtered to drop
 * `processor*`-typed entries — the OpenFOAM convention `decomposePar`
 * follows is that every processor's local boundary lists every ORIGINAL
 * patch (even ones with zero faces on that processor) in the ORIGINAL
 * order, so processor0's filtered list is expected to line up with the
 * global patch index the reconstruction assigns (ascending by the ORIGINAL,
 * pre-decomposition patch index every processor's `boundaryProcAddressing`
 * names). `nFaces`/`startFace` are stripped from the recovered patches
 * (processor0's own LOCAL counts, meaningless against the GLOBAL
 * reconstructed mesh) so `applyOpenFoamPatches`' own per-patch nFaces
 * cross-check — right for a single-region read — does not fire a false
 * positive here; a coarser cross-check instead compares the RECOVERED patch
 * count against every processor's own `boundaryProcAddressing` (the
 * highest global patch index actually referenced), naming a mismatch as a
 * diagnostic rather than silently mis-naming patches.
 *
 * Verified end-to-end against the live wasm with a hand-built two-processor
 * fixture (two hexahedra sharing one face, split per processor, following
 * meshio++'s own `tests/python/test_openfoam.py` decomposed-case recipe):
 * 12 points, 2 hexahedra, 10 boundary quads (6+6 minus the 2 that became
 * internal) — see `src/test/fixtures/openfoam-decomposed/`.
 */
export async function collectDecomposedOpenFoamCase(
  caseDir: string,
  diagnostics: MdpaDiagnostic[]
): Promise<{ files: MeshioInputFile[]; patches: OpenFoamPatch[] }> {
  const procIds = listOpenFoamProcessors(caseDir);
  if (procIds.length === 0) {
    throw new Error(`Not a decomposed OpenFOAM case: no processorN/constant/polyMesh under ${caseDir}.`);
  }
  const REQUIRED = [...OPENFOAM_REQUIRED_FILES, "pointProcAddressing", "cellProcAddressing", "faceProcAddressing"];
  const OPTIONAL = ["neighbour", "boundary", "boundaryProcAddressing"];
  const files: MeshioInputFile[] = [];
  let maxGlobalPatch = -1;
  let proc0Boundary: Buffer | undefined;
  for (const id of procIds) {
    const dir = path.join(caseDir, `processor${id}`, "constant", "polyMesh");
    for (const name of [...REQUIRED, ...OPTIONAL]) {
      const data = readFoamFile(dir, name);
      if (!data) {
        if ((REQUIRED as readonly string[]).includes(name)) {
          throw new Error(`Decomposed OpenFOAM case: processor${id}/constant/polyMesh/${name} is missing.`);
        }
        continue;
      }
      files.push({
        name: `processor${id}/constant/polyMesh/${name}`,
        data: new Uint8Array(data),
      });
      if (name === "boundary" && id === procIds[0]) proc0Boundary = data;
      if (name === "boundaryProcAddressing") {
        const addr = parseAsciiLabelList(data.toString("utf8"));
        if (addr) for (const v of addr) if (v > maxGlobalPatch) maxGlobalPatch = v;
      }
    }
  }
  let patches: OpenFoamPatch[] = [];
  if (proc0Boundary) {
    const parsed = parseOpenFoamBoundary(proc0Boundary.toString("utf8"), diagnostics);
    patches = parsed
      .filter((p) => !p.type.startsWith("processor"))
      .map((p) => ({ name: p.name, type: p.type, synthesized: p.synthesized }));
  } else {
    diagnostics.push({
      line: 0,
      message: `Decomposed OpenFOAM case: processor${procIds[0]}/constant/polyMesh/boundary is missing; boundary faces stay unnamed.`,
    });
  }
  if (maxGlobalPatch >= 0 && maxGlobalPatch + 1 !== patches.length) {
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM (decomposed): processor${procIds[0]}'s boundary lists ${patches.length} non-processor ` +
        `patch(es), but the processors' own boundaryProcAddressing implies ${maxGlobalPatch + 1}; patch ` +
        "names may not line up with the reconstructed mesh.",
    });
  }
  diagnostics.push({
    line: 0,
    message:
      `OpenFOAM: reconstructed from ${procIds.length} processor director${procIds.length === 1 ? "y" : "ies"} ` +
      "(processor*/); fields under processorN/<time>/ are not reconstructed and are not read.",
  });
  return { files, patches };
}

/** Bytes the case actually occupies — the marker's own size is 0. */
export async function openFoamCaseSize(caseDir: string): Promise<number> {
  const dir = polyMeshDir(caseDir);
  let total = 0;
  const stat = async (p: string): Promise<number> => {
    try {
      return (await fs.promises.stat(p)).size;
    } catch {
      return 0;
    }
  };
  for (const name of [...OPENFOAM_POLYMESH_FILES, ...OPENFOAM_ZONE_FILES]) {
    for (const p of [path.join(dir, name), path.join(dir, `${name}.gz`)]) {
      const s = await stat(p);
      if (s > 0) {
        total += s;
        break;
      }
    }
  }
  // Multi-region (roadmap item 3, Step 5): every constant/<region>/polyMesh
  // participates in the read whenever the default is absent, so it must be
  // able to trip the summary gate too.
  for (const region of listOpenFoamRegions(caseDir)) {
    const rdir = path.join(caseDir, "constant", region, "polyMesh");
    for (const name of [...OPENFOAM_POLYMESH_FILES, ...OPENFOAM_ZONE_FILES]) {
      for (const p of [path.join(rdir, name), path.join(rdir, `${name}.gz`)]) {
        const s = await stat(p);
        if (s > 0) {
          total += s;
          break;
        }
      }
    }
  }
  // Decomposed (roadmap item 3, Step 5): every processorN/constant/polyMesh
  // plus its *ProcAddressing files.
  for (const id of listOpenFoamProcessors(caseDir)) {
    const pdir = path.join(caseDir, `processor${id}`, "constant", "polyMesh");
    for (const name of [
      ...OPENFOAM_POLYMESH_FILES,
      "pointProcAddressing",
      "cellProcAddressing",
      "faceProcAddressing",
      "boundaryProcAddressing",
    ]) {
      for (const p of [path.join(pdir, name), path.join(pdir, `${name}.gz`)]) {
        const s = await stat(p);
        if (s > 0) {
          total += s;
          break;
        }
      }
    }
  }
  // Time fields participate in every frame read, so they count toward the
  // summary gate; a new time directory alone must be able to trip it.
  for (const t of listOpenFoamTimesSync(caseDir)) {
    const td = path.join(caseDir, t.name);
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(td);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(td, e);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile()) total += st.size;
        // Multi-region field files live at <time>/<region>/<field>, one
        // directory level deeper than the flat single-region layout above —
        // "polyMesh" is excluded since it is the (moving-mesh) geometry
        // overlay, counted separately by the loop just below this one.
        else if (st.isDirectory() && e !== "polyMesh") {
          let sub: string[] = [];
          try {
            sub = await fs.promises.readdir(full);
          } catch {
            continue;
          }
          for (const sf of sub) {
            try {
              const sst = await fs.promises.stat(path.join(full, sf));
              if (sst.isFile()) total += sst.size;
            } catch {
              /* gone mid-scan */
            }
          }
        }
      } catch {
        /* gone mid-scan */
      }
    }
    for (const name of OPENFOAM_POLYMESH_FILES) {
      for (const p of [path.join(td, "polyMesh", name), path.join(td, "polyMesh", `${name}.gz`)]) {
        total += await stat(p);
      }
    }
  }
  return total;
}

/**
 * A change stamp over the polyMesh files plus every time directory.
 *
 * The marker is 0 bytes and its mtime never moves when `blockMesh` rewrites the
 * mesh, so anything keyed on the OPENED file (the MCP model cache) would serve a
 * stale model forever. Time field files join the stamp for the same reason: a
 * solver rewriting `1/U` must invalidate the cached frame.
 */
export async function openFoamCaseStamp(caseDir: string): Promise<string> {
  const dir = polyMeshDir(caseDir);
  const parts: string[] = [];
  for (const name of [...OPENFOAM_POLYMESH_FILES, ...OPENFOAM_ZONE_FILES]) {
    for (const p of [path.join(dir, name), path.join(dir, `${name}.gz`)]) {
      try {
        const st = await fs.promises.stat(p);
        parts.push(`${name}:${st.mtimeMs}:${st.size}`);
        break;
      } catch {
        /* not this one */
      }
    }
  }
  // Multi-region / decomposed (roadmap item 3, Step 5): each participates in
  // the read whenever the default constant/polyMesh is absent.
  const regions = listOpenFoamRegions(caseDir);
  parts.push(`regions:${regions.join(",")}`);
  for (const region of regions) {
    const rdir = path.join(caseDir, "constant", region, "polyMesh");
    for (const name of [...OPENFOAM_POLYMESH_FILES, ...OPENFOAM_ZONE_FILES]) {
      for (const p of [path.join(rdir, name), path.join(rdir, `${name}.gz`)]) {
        try {
          const st = await fs.promises.stat(p);
          parts.push(`${region}/${name}:${st.mtimeMs}:${st.size}`);
          break;
        } catch {
          /* not this one */
        }
      }
    }
  }
  const procIds = listOpenFoamProcessors(caseDir);
  parts.push(`processors:${procIds.join(",")}`);
  for (const id of procIds) {
    const pdir = path.join(caseDir, `processor${id}`, "constant", "polyMesh");
    for (const name of [
      ...OPENFOAM_POLYMESH_FILES,
      "pointProcAddressing",
      "cellProcAddressing",
      "faceProcAddressing",
      "boundaryProcAddressing",
    ]) {
      for (const p of [path.join(pdir, name), path.join(pdir, `${name}.gz`)]) {
        try {
          const st = await fs.promises.stat(p);
          parts.push(`processor${id}/${name}:${st.mtimeMs}:${st.size}`);
          break;
        } catch {
          /* not this one */
        }
      }
    }
  }
  const times = listOpenFoamTimesSync(caseDir);
  parts.push(`times:${times.map((t) => t.name).join(",")}`);
  for (const t of times) {
    const td = path.join(caseDir, t.name);
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(td);
    } catch {
      continue;
    }
    for (const e of [...entries].sort()) {
      const full = path.join(td, e);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile()) parts.push(`${t.name}/${e}:${st.mtimeMs}:${st.size}`);
      } catch {
        /* gone mid-scan */
      }
    }
    for (const name of OPENFOAM_POLYMESH_FILES) {
      for (const p of [path.join(td, "polyMesh", name), path.join(td, "polyMesh", `${name}.gz`)]) {
        try {
          const st = await fs.promises.stat(p);
          parts.push(`${t.name}/polyMesh/${name}:${st.mtimeMs}:${st.size}`);
          break;
        } catch {
          /* not this one */
        }
      }
    }
  }
  return parts.join("|");
}

/** True when writing `destPath` would rewrite the polyMesh `sourcePath` came from. */
export function wouldOverwriteOpenFoamCase(sourcePath: string, destPath: string): boolean {
  if (path.extname(sourcePath).toLowerCase() !== ".foam") return false;
  if (path.extname(destPath).toLowerCase() !== ".foam") return false;
  // Directories, not paths: exporting to `<case>/other.foam` rewrites the very
  // same constant/polyMesh, which a path comparison would wave through.
  return path.resolve(openFoamCaseDir(sourcePath)) === path.resolve(openFoamCaseDir(destPath));
}

// ---- field injection ------------------------------------------------------------

/**
 * Injects natively parsed OpenFOAM fields into a raw `MeshioMesh` BEFORE
 * `meshioToModel`, so the existing `kept`/`expansion` machinery keeps
 * cell-data aligned across polygon fans and polyhedron decomposition.
 *
 * Volume values are consumed in meshio block order for rows whose `cell_tags`
 * are non-negative (volume) and NaN-filled for boundary rows; `meshioToModel`
 * then drops the NaN rows via its sparse path. A nonuniform field over more
 * than one distinct volume cell TYPE is refused: the buckets reorder the
 * original cell order and there is no per-cell provenance to recover it, so
 * assigning sequentially would silently misassign. Uniform fields are safe
 * (same tuple everywhere) and point fields never have this problem.
 */
export function augmentMeshioWithFoamFields(
  mesh: MeshioMesh,
  parsed: OpenFoamParsedField[],
  diagnostics: MdpaDiagnostic[]
): void {
  mesh.cell_data ??= {};
  mesh.point_data ??= {};
  const seen = new Set<string>();
  // cell_tags arrive as BigInt64Array since meshio++ 11.2.0; convert at the
  // boundary since Math.round(bigint) throws.
  const rawTags = mesh.cell_data[CELL_TAGS];
  const tagsArrays = rawTags?.map((a) => Float64Array.from(meshioDataToNumbers(a)));

  const volumeTypes = new Set<string>();
  if (tagsArrays) {
    for (let bi = 0; bi < mesh.cells.length; bi++) {
      const cb = mesh.cells[bi];
      const nRows = meshioBlockRowCount(cb);
      const tags = tagsArrays[bi];
      if (!tags || tags.length < nRows) continue;
      let hasVol = false;
      for (let r = 0; r < nRows; r++) {
        if (Math.round(tags[r]) >= 0) {
          hasVol = true;
          break;
        }
      }
      if (hasVol) volumeTypes.add(isRectangularCellBlock(cb) ? cb.type : `ragged:${cb.type}`);
    }
  }
  const mixedVolumeTypes = volumeTypes.size > 1;

  for (const f of parsed) {
    const key = `${f.domain}:${sanitizeVariable(f.object)}`;
    if (seen.has(key)) {
      diagnostics.push({
        line: 0,
        message: `OpenFOAM field "${f.object}": duplicate name; keeping the first.`,
      });
      continue;
    }
    seen.add(key);

    if (f.domain === "point") {
      if (!f.internal) continue;
      const nodeCount = mesh.dim > 0 ? Math.floor(mesh.points.length / mesh.dim) : 0;
      if (nodeCount === 0) {
        diagnostics.push({ line: 0, message: `OpenFOAM field "${f.object}": mesh has no points; skipped.` });
        continue;
      }
      const comps = f.components;
      let arr: Float64Array;
      if (f.internal.kind === "uniform") {
        arr = new Float64Array(nodeCount * comps);
        for (let i = 0; i < nodeCount; i++) arr.set(f.internal.values, i * comps);
      } else {
        if (f.internal.values.length !== nodeCount * comps) {
          diagnostics.push({
            line: 0,
            message:
              `OpenFOAM field "${f.object}": declares ${f.internal.count} value(s) for ${nodeCount} ` +
              `node(s); skipped.`,
          });
          continue;
        }
        arr = new Float64Array(f.internal.values);
      }
      mesh.point_data[f.object] = arr;
      if (comps > 1) {
        mesh.point_data_components ??= {};
        mesh.point_data_components[f.object] = comps;
      }
      continue;
    }

    // Volume domain.
    if (!f.internal) continue;
    if (!tagsArrays) {
      diagnostics.push({
        line: 0,
        message: `OpenFOAM field "${f.object}": no cell_tags to separate volume from boundary; skipped.`,
      });
      continue;
    }
    if (f.internal.kind === "nonuniform" && mixedVolumeTypes) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM field "${f.object}": mixed volume cell types reorder the original cell order, ` +
          `so nonuniform values cannot be assigned safely; skipped.`,
      });
      continue;
    }
    const comps = f.components;
    const perBlock: Float64Array[] = [];
    let ok = true;
    let cursor = 0;
    const internal = f.internal;
    const src = internal.kind === "nonuniform" ? internal.values : undefined;
    const uniform = internal.kind === "uniform" ? internal.values : undefined;
    const declared = internal.kind === "nonuniform" ? internal.count : 0;
    for (let bi = 0; bi < mesh.cells.length; bi++) {
      const nRows = meshioBlockRowCount(mesh.cells[bi]);
      const tags = tagsArrays[bi];
      const out = new Float64Array(nRows * comps);
      if (!tags || tags.length < nRows) {
        ok = false;
        break;
      }
      for (let r = 0; r < nRows; r++) {
        const isVol = Math.round(tags[r]) >= 0;
        if (!isVol) {
          for (let c = 0; c < comps; c++) out[r * comps + c] = NaN;
          continue;
        }
        if (uniform) {
          out.set(uniform, r * comps);
        } else if (src) {
          for (let c = 0; c < comps; c++) out[r * comps + c] = src[cursor * comps + c];
          cursor++;
        }
      }
      perBlock.push(out);
    }
    if (!ok) {
      diagnostics.push({
        line: 0,
        message: `OpenFOAM field "${f.object}": cell_tags do not align with the cell blocks; skipped.`,
      });
      continue;
    }
    if (src && cursor !== declared) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM field "${f.object}": declares ${declared} value(s) for a mesh with ` +
          `${cursor} volume cell(s); skipped.`,
      });
      continue;
    }
    mesh.cell_data[f.object] = perBlock;
    if (comps > 1) {
      mesh.cell_data_components ??= {};
      mesh.cell_data_components[f.object] = comps;
    }
  }
}

/**
 * Builds Conditional fields from parsed uniform `boundaryField` patch values,
 * resolved against the SubModelParts `applyOpenFoamPatches` created. Runs on
 * the finished model (patch Condition IDs exist only there).
 */
export function foamBoundaryFields(
  model: MdpaModel,
  parsed: OpenFoamParsedField[],
  diagnostics: MdpaDiagnostic[]
): FieldData[] {
  const out: FieldData[] = [];
  const seen = new Set<string>();
  for (const f of parsed) {
    if (f.domain !== "vol" || f.boundaryUniform.size === 0) continue;
    const variable = sanitizeVariable(f.object);
    const key = `Conditional:${variable}`;
    if (seen.has(key)) {
      diagnostics.push({
        line: 0,
        message: `OpenFOAM boundary "${f.object}": duplicate name; keeping the first.`,
      });
      continue;
    }
    seen.add(key);
    const ids: number[] = [];
    const values: number[] = [];
    for (const [patch, tuple] of f.boundaryUniform) {
      const part = model.subModelParts.find((p) => p.name === patch || p.path === patch);
      if (!part || part.conditionIds.length === 0) continue;
      for (const id of part.conditionIds) {
        ids.push(id);
        values.push(...tuple);
      }
    }
    if (ids.length === 0) continue;
    out.push({
      kind: "Conditional",
      variable,
      components: f.components,
      ids: new Int32Array(ids),
      values: new Float64Array(values),
    });
  }
  return out;
}

// ---- the join ----------------------------------------------------------------

/** meshio++'s own name for the patch-index array on the boundary block. */
const CELL_TAGS = "cell_tags";

/**
 * Turns the boundary block's `cell_tags` into named `Conditions` SubModelParts.
 *
 * Upstream gives patch membership as `-(patchIndex + 1)` on boundary faces and
 * `0` on interior cells, with the names nowhere — this is where the two halves
 * meet. Runs on the finished model rather than inside `meshioToModel` because
 * the meshio-side region machinery (`regionsToParts`) needs `kept`/`expansion`
 * that only exist in there, produces `elementIds` where these are semantically
 * Conditions, and offers no hook to drop the now-wrong tag field.
 *
 * Blocks are classified by TAG, not by cell type: a boundary that mixes
 * triangles and quads is two blocks, and nothing measured guarantees which
 * order upstream emits them in.
 */
export function applyOpenFoamPatches(
  model: MdpaModel,
  patches: readonly OpenFoamPatch[],
  diagnostics: MdpaDiagnostic[]
): MdpaModel {
  const tagField = model.fields.find(
    (f) => f.kind === "Elemental" && f.variable === CELL_TAGS && f.components === 1
  );
  if (!tagField) {
    if (patches.length > 0) {
      diagnostics.push({
        line: 0,
        message:
          "OpenFOAM: the reader returned no cell_tags array, so the boundary patches " +
          "could not be matched to their names.",
      });
    }
    return model;
  }

  const tagOf = new Map<number, number>();
  for (let i = 0; i < tagField.ids.length; i++) {
    tagOf.set(tagField.ids[i], Math.round(tagField.values[i]));
  }

  // Which blocks are entirely boundary faces?
  const isBoundary = model.blocks.map((b) => {
    if (b.kind !== "Elements" || b.count === 0) return false;
    let neg = 0;
    for (let i = 0; i < b.entityIds.length; i++) {
      if ((tagOf.get(b.entityIds[i]) ?? 0) < 0) neg++;
    }
    if (neg === 0) return false;
    if (neg === b.entityIds.length) return true;
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: block "${b.name}" mixes interior and boundary faces, so it was left as ` +
        "Elements and its patches are unnamed.",
    });
    return false;
  });
  if (!isBoundary.some(Boolean)) return model;

  // Boundary faces become Conditions in their own id space. Surviving Elements
  // keep their ids: sparse ids are legal everywhere here, and assuming the
  // volume blocks come first would be an unearned guess about block order.
  const blocks: EntityBlock[] = [];
  const facesOfPatch = new Map<number, number[]>();
  let undeclared = 0;
  let conditionId = 1;
  for (let bi = 0; bi < model.blocks.length; bi++) {
    const b = model.blocks[bi];
    if (!isBoundary[bi]) {
      blocks.push(b);
      continue;
    }
    const entityIds = new Int32Array(b.entityIds.length);
    for (let i = 0; i < b.entityIds.length; i++) {
      const id = conditionId++;
      entityIds[i] = id;
      const tag = tagOf.get(b.entityIds[i]) ?? 0;
      const idx = -tag - 1;
      if (idx < 0 || idx >= patches.length) {
        undeclared++;
        continue;
      }
      const list = facesOfPatch.get(idx);
      if (list) list.push(id);
      else facesOfPatch.set(idx, [id]);
    }
    blocks.push({ ...b, kind: "Conditions", entityIds });
  }

  if (undeclared > 0) {
    diagnostics.push({
      line: 0,
      message:
        `OpenFOAM: ${undeclared} boundary face(s) carry a patch index that ` +
        "constant/polyMesh/boundary does not declare; they are left unnamed.",
    });
  }

  // Cross-check against the file's own nFaces. This is the only thing standing
  // between a mis-ordered tag convention and every patch being silently
  // misnamed, which would look exactly like success.
  for (let i = 0; i < patches.length; i++) {
    const declared = patches[i].nFaces;
    const got = facesOfPatch.get(i)?.length ?? 0;
    if (declared !== undefined && declared !== got) {
      diagnostics.push({
        line: 0,
        message:
          `OpenFOAM: patch "${patches[i].name}" declares ${declared} face(s) but ${got} ` +
          "were tagged with its index; the patch names may not line up with the mesh.",
      });
      break;
    }
  }

  const used = new Set(model.subModelParts.map((p) => p.path));
  const parts: SubModelPart[] = [];
  // roadmap item 3: keyed by the FINAL (de-duplicated) part name, so
  // openfoamWrite.ts's lookup by SubModelPart name always lands on the
  // right patch even after a `_2` suffix.
  const patchTypes: Record<string, string> = {};
  for (let i = 0; i < patches.length; i++) {
    const ids = facesOfPatch.get(i);
    // A zero-face patch is legal and common; it is not a part worth showing.
    if (!ids || ids.length === 0) continue;
    let name = patches[i].name;
    for (let n = 2; used.has(name); n++) name = `${patches[i].name}_${n}`;
    used.add(name);
    if (patches[i].type.length > 0) patchTypes[name] = patches[i].type;
    parts.push({
      name,
      path: name,
      // Node membership is left empty, matching what a meshio `cell` region
      // produces; the faces carry their own connectivity.
      nodeIds: new Int32Array(0),
      elementIds: new Int32Array(0),
      conditionIds: sortedUnique(ids),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      children: [],
    });
  }

  return {
    ...model,
    blocks,
    // Dropped, not re-keyed: after the flip above it is an Elemental field whose
    // ids partly moved into the condition space, i.e. actively wrong — and
    // `-(index+1)` is not a quantity anyone wants to colour by. The names it
    // encoded are now the SubModelParts.
    fields: model.fields.filter((f) => f !== tagField),
    subModelParts: [...model.subModelParts, ...parts],
    diagnostics: model.diagnostics,
    ...(Object.keys(patchTypes).length > 0
      ? { source: { format: "openfoam", openfoam: { patchTypes } } }
      : {}),
  };
}
