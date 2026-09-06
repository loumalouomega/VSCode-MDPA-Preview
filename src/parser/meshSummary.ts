/**
 * What is in a mesh file, without loading it.
 *
 * The preview parses a mesh into an `MdpaModel`, posts it to the webview and
 * builds a scene from it.  For a large file that is exactly the wrong thing to
 * do first: the model is several times the file's size in JS arrays, it is then
 * structured-cloned across `postMessage`, and the window is unresponsive until
 * all of it finishes.  This module answers the cheaper question — how many
 * nodes, which blocks, which data arrays — so a preview can show that and let
 * the user decide.
 *
 * **Cost is a four-valued fact, not a boolean**, and saying so is the point of
 * this module rather than an aside.  A "header summary" costs wildly different
 * things per format, and a UI that implied "instant" for all of them would be
 * lying about three quarters of the table:
 *
 *  - `"header"` — a bounded read.  VTK XML `<Piece>` attributes, a PLY
 *    `element` declaration, a binary STL's facet count at byte 80.
 *  - `"scan"`   — the whole file streamed once with no arrays built.  `.mdpa`
 *    (which declares no counts at all — a block's size is implied by its line
 *    count), `.obj`, ascii STL.  Cheap in memory, not in I/O.
 *  - `"buffered"` — the whole file, plus any siblings, resident as a Buffer AND
 *    copied into the meshio++ MEMFS (~2x file size), but no model built.
 *  - `"read"` — as `"buffered"`, and meshio++ parses the mesh into wasm memory
 *    to answer, then discards it.  The formats whose `readMetadata` falls back.
 *
 * The last two are still worth serving: they skip the JS arrays, the model and
 * the postMessage, which is the actual failure mode.  They are not cheap, and
 * `cost` is how a caller says which it got.  This generalises the honesty
 * `MeshioMetadata.fellBackToFullRead` already encodes for one format family.
 *
 * fs-using but vscode-free, like `meshFileParser.ts`, so all of it is
 * Node-testable (`tsconfig.test.json` covers `src/parser/**`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { MdpaDiagnostic } from "./types";
import {
  HEADER_METADATA_EXTENSIONS,
  meshExtname,
  SUPPORTED_MESH_EXTENSIONS,
  VTK_XML_EXTENSIONS,
} from "./meshFormats";
import { isMeshioReadExtension } from "./meshioFormats";
import { readMeshMetadata, statMeshSource } from "./meshFileParser";

/** How much of a file its summary had to touch.  See the module header. */
export type SummaryCost = "header" | "scan" | "buffered" | "read";

/** One entity grouping a summary could name, with however much it knows. */
export interface MeshSummaryBlock {
  /** Block or cell-type name as the format spells it. */
  type: string;
  count: number;
  /** Omitted when the header does not say (a ragged or unstated block). */
  nodesPerCell?: number;
  /** Elements / Conditions / Geometries, for the formats that distinguish. */
  kind?: string;
}

export interface MeshSummary {
  path: string;
  fileName: string;
  /** Via `meshExtname`, so a compound `.post.msh` resolves correctly. */
  ext: string;
  fileSize: number;
  /**
   * How many bytes of the file the answer actually depended on.  The only
   * honest — and the only testable — statement of cost: a summary claiming
   * `"header"` must have `bytesRead < fileSize`.
   */
  bytesRead: number;
  cost: SummaryCost;
  /** Human phrase naming the mechanism, e.g. "VTK XML header". */
  method: string;
  /** False when a cap truncated the read, so the counts may be partial. */
  exact: boolean;
  datasetType?: string;
  nodeCount?: number;
  cellCount?: number;
  blocks: MeshSummaryBlock[];
  pointDataNames: string[];
  cellDataNames: string[];
  fieldDataNames: string[];
  regions: { name: string; kind?: string; count?: number }[];
  timeValues: number[];
  /** Omitted, never null — "not computed" must not read as a box at the origin. */
  bounds?: { min: number[]; max: number[] };
  extent?: number[];
  /** `.vtm` children, which are an index rather than geometry. */
  children?: { path: string; file: string }[];
  /**
   * What this format's header genuinely cannot say, e.g. `"cell types"`,
   * `"bounds"`.  Without it a `0` or an empty array reads as "none", which is a
   * different and wrong answer — the same trap `MeshioMetadata` avoids by
   * omitting `bboxMin` rather than nulling it.
   */
  unknown: string[];
  notes: string[];
}

// ---- The gate ---------------------------------------------------------------------

/** Default for `kratos.preview.summaryThresholdMb`; the manifest must agree. */
export const SUMMARY_THRESHOLD_MB_DEFAULT = 250;

export interface SummaryGate {
  /** Bytes on disk, of the OPENED file only. */
  fileSize: number;
  /** The setting.  0 (or NaN/negative) means never summarize. */
  thresholdMb: number;
  reason: "initial" | "reload";
  /** The user pressed "Open full mesh anyway" on this panel. */
  userForcedFull: boolean;
  /** What the last decision for this panel was. */
  summaryShown: boolean;
}

/**
 * Whether to summarize rather than parse.  Pure and here, not spelled inline in
 * the two providers, for the reason `timelineKindFor` is: there is no VS Code
 * integration harness in this repo, so a decision made above the vscode line is
 * a decision nothing can test — and this one has four inputs and a safety
 * property, which is exactly the shape that rots when it is duplicated.
 *
 * The order of the checks is itself the design:
 *
 *  - `userForcedFull` wins over everything, for the panel's lifetime.  It is
 *    deliberately NOT persisted: a new panel on the same file summarizes again,
 *    which is what the threshold setting is for.
 *  - A `"reload"` returns whatever the last decision was, which is BOTH halves
 *    of the safety property — a solver's growing output can never flip a live
 *    preview into a summary, and a summarized 4 GB file can never silently
 *    become a full parse on some later watcher tick and hang the window.
 *  - `!(thresholdMb > 0)` is NaN-safe "never", so a garbage setting disables
 *    the feature rather than summarizing everything.
 *  - `>=` so "threshold 250" and a 250 MB file agree with the setting's prose.
 *
 * Known under-trigger, stated rather than fixed: `fileSize` (via
 * `meshSourceBytes` → `statMeshSource`) counts an OpenFOAM case's polyMesh and
 * every companion a read would stage — the GiD pair, tetgen's, EnSight's, an
 * XDMF's heavy data — but a `.vtm`'s children are still counted by the opened
 * index alone, since resolving them means opening each child.
 */
export function shouldSummarize(g: SummaryGate): boolean {
  if (g.userForcedFull) return false;
  if (g.reason === "reload") return g.summaryShown;
  if (!(g.thresholdMb > 0)) return false;
  return g.fileSize >= g.thresholdMb * 1024 * 1024;
}

/**
 * The cost class a path is EXPECTED to take, from its extension alone.
 *
 * An estimate, not the answer: whether a `.vtk` is ascii or binary, and whether
 * a `.vtu` stores its arrays inline or appended, are facts about the bytes.
 * `MeshSummary.cost` is the measured truth; this is what a caller can know
 * before opening the file.
 */
export function summaryCostFor(fsPath: string): SummaryCost {
  const ext = meshExtname(fsPath);
  if (ext === ".mdpa" || ext === ".obj") return "scan";
  if (ext === ".stl") return "header";
  if (ext === ".ply") return "header";
  if (ext === ".vtm") return "header";
  if (ext === ".vtk" || (VTK_XML_EXTENSIONS as readonly string[]).includes(ext)) return "header";
  if (isMeshioReadExtension(ext)) {
    return HEADER_METADATA_EXTENSIONS.includes(ext) ? "buffered" : "read";
  }
  return "scan";
}

/**
 * The bytes a mesh's SOURCE actually occupies — the honest input to
 * `shouldSummarize` and to `MeshSummary.fileSize`.
 *
 * Usually the opened file's own size, but several formats keep their bytes
 * BESIDE it — an OpenFOAM `.foam` marker is 0 bytes while the mesh is
 * `constant/polyMesh/`, a GiD `.post.msh` may sit beside a vastly larger
 * `.post.res`, and an XDMF names its heavy data in a sibling `.h5`. Sized by
 * the opened file alone, a 4 GB mesh compares as tiny and can NEVER be
 * summarized — the exact reverse of what the threshold exists for.
 *
 * `statMeshSource` is the shared answer, so this cannot drift from what a read
 * actually opens.
 */
export async function meshSourceBytes(fsPath: string): Promise<number> {
  return (await statMeshSource(fsPath)).bytes;
}

/** Every extension `summarizeMeshFile` can answer for. */
export const SUMMARIZABLE_EXTENSIONS: readonly string[] = [
  ".mdpa",
  ...SUPPORTED_MESH_EXTENSIONS,
];

function emptySummary(fsPath: string, fileSize: number): MeshSummary {
  return {
    path: fsPath,
    fileName: path.basename(fsPath),
    ext: meshExtname(fsPath),
    fileSize,
    bytesRead: 0,
    cost: "header",
    method: "",
    exact: true,
    blocks: [],
    pointDataNames: [],
    cellDataNames: [],
    fieldDataNames: [],
    regions: [],
    timeValues: [],
    unknown: [],
    notes: [],
  };
}

// ---- Bounded reading ---------------------------------------------------------------

/** Read in 256 KiB steps; a header that needs more than a few of these is rare. */
const CHUNK = 256 * 1024;
/** Give up growing the head at 16 MiB — past that it is not a header. */
const HEAD_CAP = 16 * 1024 * 1024;

interface Head {
  buf: Buffer;
  /** Bytes of the file the answer depends on — the marker offset, not the chunk size. */
  bytesRead: number;
  /** A terminator was found, so the head is complete and the counts are exact. */
  complete: boolean;
}

/**
 * Reads from the start until one of `markers` appears, or the cap is hit.
 *
 * `bytesRead` is the offset just past the marker rather than the amount pulled
 * off disk, because that is the number that means something: it is what the
 * answer depended on, and it is what makes `cost: "header"` a claim a test can
 * falsify.  Reading a 256 KiB chunk to find a marker at byte 900 costs one
 * `read` syscall either way.
 */
async function readHeadUntil(fsPath: string, markers: string[], fileSize: number): Promise<Head> {
  const fd = await fs.promises.open(fsPath, "r");
  try {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(fileSize - total, 0)));
      if (chunk.length === 0) break;
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (bytesRead <= 0) break;
      parts.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      for (const m of markers) {
        const at = buf.indexOf(m);
        if (at >= 0) return { buf, bytesRead: at + m.length, complete: true };
      }
      if (total >= fileSize || total >= HEAD_CAP) {
        return { buf, bytesRead: total, complete: total >= fileSize };
      }
    }
    const buf = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
    return { buf, bytesRead: total, complete: true };
  } finally {
    await fd.close();
  }
}

/** Streams a file line by line, calling `onLine`; returns when it says stop. */
async function scanLines(
  fsPath: string,
  onLine: (line: string) => boolean | void
): Promise<number> {
  const readline = await import("node:readline");
  const stream = fs.createReadStream(fsPath, { encoding: "utf8" });
  let bytes = 0;
  stream.on("data", (c: string | Buffer) => {
    bytes += typeof c === "string" ? Buffer.byteLength(c, "utf8") : c.length;
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (onLine(line) === false) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return bytes;
}

// ---- VTK XML ------------------------------------------------------------------------

function extentCounts(s: string | undefined): { points: number; cells: number; extent?: number[] } | undefined {
  if (!s) return undefined;
  const v = s.trim().split(/\s+/).map((t) => parseInt(t, 10));
  if (v.length !== 6 || v.some((x) => isNaN(x))) return undefined;
  const d = [v[1] - v[0] + 1, v[3] - v[2] + 1, v[5] - v[4] + 1];
  const cells = d.map((n) => Math.max(n - 1, 1));
  return { points: d[0] * d[1] * d[2], cells: cells[0] * cells[1] * cells[2], extent: v };
}

async function summarizeVtkXml(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  s.method = "VTK XML header";
  // Stop at the payload: everything a summary needs is an ATTRIBUTE, and the
  // arrays start here. `</VTKFile>` is the fallback for an inline file, whose
  // "head" is the whole document.
  const head = await readHeadUntil(fsPath, ["<AppendedData", "</VTKFile>"], fileSize);
  s.bytesRead = head.bytesRead;
  s.cost = head.bytesRead < fileSize ? "header" : "scan";
  s.exact = head.complete;
  if (!head.complete) s.notes.push("Header exceeded the read cap; counts may be partial.");

  const { parseVtkXmlFile, findAll, findFirst } = await import("./vtkXmlCore");
  const file = parseVtkXmlFile(head.buf);
  s.datasetType = file.datasetType;

  const pieces = findAll(file.root, "Piece");
  let points = 0;
  let cells = 0;
  for (const p of pieces) {
    const a = p.attrs;
    if (a.NumberOfPoints !== undefined) {
      points += parseInt(a.NumberOfPoints, 10) || 0;
      // PolyData splits its cells across four attributes; UnstructuredGrid has one.
      cells +=
        (parseInt(a.NumberOfCells, 10) || 0) +
        (parseInt(a.NumberOfVerts, 10) || 0) +
        (parseInt(a.NumberOfLines, 10) || 0) +
        (parseInt(a.NumberOfStrips, 10) || 0) +
        (parseInt(a.NumberOfPolys, 10) || 0);
      continue;
    }
    const e = extentCounts(a.Extent);
    if (e) {
      points += e.points;
      cells += e.cells;
      s.extent ??= e.extent;
    }
  }
  const dataset = file.root.children[0];
  if (dataset) {
    const whole = extentCounts(dataset.attrs.WholeExtent);
    if (whole) s.extent ??= whole.extent;
  }
  s.nodeCount = points;
  s.cellCount = cells;

  const names = (tag: string): string[] => {
    const out: string[] = [];
    for (const holder of findAll(file.root, tag)) {
      for (const da of findAll(holder, "DataArray")) {
        const n = da.attrs.Name;
        if (n && !out.includes(n)) out.push(n);
      }
    }
    return out;
  };
  s.pointDataNames = names("PointData");
  s.cellDataNames = names("CellData");
  s.fieldDataNames = names("FieldData");

  // The cell TYPES are a payload DataArray, not an attribute — reading them is
  // exactly the read this whole path exists to avoid.
  s.unknown.push("cell types", "bounds");
  // A header states the cells the FILE declares. `buildBlocksFromOffsets`
  // normalizes the undrawable ones on read — a poly-line fans into segments, a
  // polygon into triangles, a triangle strip into triangles — so the number the
  // opened mesh reports can be larger. PolyData is where that is near-certain
  // (Lines/Strips are poly-cells by definition), but an UnstructuredGrid can do
  // it too, and knowing which needs the `types` array we deliberately do not
  // read. Say so rather than let the two numbers disagree silently.
  s.notes.push(
    "Counts are as declared in the file; poly-lines, polygons and triangle strips " +
      "expand into more cells when the mesh is opened."
  );
  if (findFirst(file.root, "Piece") === undefined) s.notes.push("No <Piece> element found.");
  return s;
}

// ---- Legacy VTK ---------------------------------------------------------------------

/**
 * `POINTS n float` / `CELLS n m` / `CELL_TYPES n` are ascii keyword lines even
 * in a BINARY legacy file, and they sit at the top — so a bounded prefix
 * answers for both flavours with the same code.  Payload bytes between them are
 * binary garbage when read as latin1, which is harmless: they match no keyword.
 */
async function summarizeVtkLegacy(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  const { isBinaryLegacyVtk } = await import("./meshFileParser");
  const binary = await isBinaryLegacyVtk(fsPath);
  s.method = binary ? "legacy VTK header (binary)" : "legacy VTK header (ascii)";
  s.datasetType = "UnstructuredGrid";

  // CELL_TYPES is the last of the three counts, so finding it means we have all
  // of them; without it we fall back to the cap.
  const head = await readHeadUntil(fsPath, ["CELL_TYPES"], fileSize);
  const text = head.buf.toString("latin1");
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(text);
    return m ? parseInt(m[1], 10) : undefined;
  };
  s.nodeCount = num(/^POINTS\s+(\d+)/m);
  s.cellCount = num(/^CELLS\s+(\d+)/m);
  const ds = /^DATASET\s+(\w+)/m.exec(text);
  if (ds) s.datasetType = ds[1];

  // bytesRead is where the last count sits, not the chunk we pulled.
  const ctAt = text.search(/^CELL_TYPES\s+\d+/m);
  s.bytesRead = ctAt >= 0 ? Buffer.byteLength(text.slice(0, ctAt), "latin1") : head.bytesRead;
  s.cost = s.bytesRead < fileSize ? "header" : "scan";
  s.exact = s.nodeCount !== undefined && s.cellCount !== undefined;
  if (!s.exact) s.notes.push("POINTS/CELLS not found in the header prefix.");
  s.unknown.push("cell types", "bounds", "data arrays");
  return s;
}

// ---- Surface formats -----------------------------------------------------------------

/** Reads the first `n` bytes (or the whole file, whichever is smaller). */
async function readPrefix(fsPath: string, n: number): Promise<Buffer> {
  const fd = await fs.promises.open(fsPath, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, n));
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

async function summarizeStl(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  // A binary STL is 84 + 50n bytes with the facet count at byte 80, so its
  // whole answer is O(1). The size equation is checked before the ascii sniff
  // for the same reason stlParser does it in that order: a binary header may
  // legitimately begin with "solid".
  const probe = await readPrefix(fsPath, Math.min(fileSize, 1024));
  const declared = probe.length >= 84 ? probe.readUInt32LE(80) : -1;
  const binary =
    declared >= 0 && 84 + declared * 50 === fileSize
      ? true
      : !/^\s*solid\b/.test(probe.toString("latin1"));

  if (binary) {
    s.method = "binary STL header";
    s.cost = "header";
    s.bytesRead = 84;
    s.cellCount = Math.max(declared, 0);
    s.blocks = [{ type: "triangle", count: s.cellCount, nodesPerCell: 3 }];
    // The vertices are the payload, and STL repeats each one per facet anyway —
    // the node count is a property of welding, not of the file.
    s.unknown.push("node count", "solid names", "bounds");
    return s;
  }

  s.method = "ascii STL scan";
  s.cost = "scan";
  let facets = 0;
  const solids: string[] = [];
  s.bytesRead = await scanLines(fsPath, (line) => {
    const l = line.trim().toLowerCase();
    if (l.startsWith("facet")) facets++;
    else if (l.startsWith("solid")) {
      solids.push(line.trim().slice(5).trim() || `Solid_${solids.length + 1}`);
    }
  });
  s.cellCount = facets;
  s.blocks = [{ type: "triangle", count: facets, nodesPerCell: 3 }];
  s.regions = solids.map((name) => ({ name, kind: "solid" }));
  s.unknown.push("node count", "bounds");
  return s;
}

async function summarizeObj(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  s.method = "OBJ scan";
  s.cost = "scan";
  let v = 0;
  let f = 0;
  let l = 0;
  let p = 0;
  const groups: string[] = [];
  s.bytesRead = await scanLines(fsPath, (line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const kw = t.slice(0, t.search(/\s|$/));
    if (kw === "v") v++;
    else if (kw === "f") f++;
    else if (kw === "l") l++;
    else if (kw === "p") p++;
    else if (kw === "g" || kw === "o") {
      const name = t.slice(kw.length).trim();
      if (name && !groups.includes(name)) groups.push(name);
    }
  });
  s.nodeCount = v;
  s.cellCount = f + l + p;
  s.blocks = [
    { type: "face", count: f },
    { type: "line", count: l },
    { type: "point", count: p },
  ].filter((b) => b.count > 0);
  s.regions = groups.map((name) => ({ name, kind: "group" }));
  s.unknown.push("bounds");
  return s;
}

async function summarizePly(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  s.method = "PLY header";
  const head = await readHeadUntil(fsPath, ["end_header"], fileSize);
  s.bytesRead = head.bytesRead;
  s.cost = head.bytesRead < fileSize ? "header" : "scan";

  const diagnostics: MdpaDiagnostic[] = [];
  const { parsePlyHeader } = await import("./plyParser");
  const parsed = parsePlyHeader(head.buf, diagnostics);
  if (!parsed) {
    s.exact = false;
    for (const d of diagnostics) s.notes.push(d.message);
    return s;
  }
  s.method = `PLY header (${parsed.format})`;
  for (const el of parsed.elements) {
    if (el.name === "vertex") {
      s.nodeCount = el.count;
      s.pointDataNames = el.props.filter((pr) => !pr.isList).map((pr) => pr.name);
    } else {
      s.blocks.push({ type: el.name, count: el.count });
    }
  }
  s.cellCount = s.blocks.reduce((n, b) => n + b.count, 0);
  s.unknown.push("bounds");
  return s;
}

// ---- .vtm ---------------------------------------------------------------------------

async function summarizeVtm(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  s.method = "VTM index";
  s.cost = "header";
  const head = await readHeadUntil(fsPath, ["</VTKFile>"], fileSize);
  s.bytesRead = head.bytesRead;
  const { parseVtmIndex } = await import("./vtkMultiblock");
  const entries = parseVtmIndex(head.buf);
  s.children = entries.map((e) => ({ path: e.path, file: e.file }));
  s.datasetType = "vtkMultiBlockDataSet";
  // Counting the children means opening every one of them — N reads for a
  // format that is itself an index. Deliberately not done.
  s.unknown.push("node count", "cell count", "per-block counts", "bounds");
  return s;
}

// ---- .mdpa --------------------------------------------------------------------------

async function summarizeMdpa(fsPath: string, fileSize: number): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  s.method = "MDPA block scan";
  // Not a header read, and the module header says why: MDPA declares no counts,
  // so this streams the file. What it avoids is the allocation, not the I/O.
  s.cost = "scan";
  const { MdpaSummaryScanner } = await import("./mdpaParser");
  const scanner = new MdpaSummaryScanner();
  s.bytesRead = await scanLines(fsPath, (line) => {
    scanner.feedLine(line);
  });
  const r = scanner.finish();

  s.nodeCount = r.nodeCount;
  s.cellCount = r.blocks.reduce((n, b) => n + b.count, 0);
  s.blocks = r.blocks.map((b) => ({ type: b.name, count: b.count, kind: b.kind }));
  for (const f of r.fields) {
    const target =
      f.kind === "Nodal" ? s.pointDataNames : f.kind === "Elemental" ? s.cellDataNames : s.fieldDataNames;
    if (!target.includes(f.variable)) target.push(f.variable);
  }
  s.regions = r.parts.map((p) => ({
    name: p.path,
    kind: "SubModelPart",
    count: p.counts.nodeIds ?? 0,
  }));
  for (const d of r.diagnostics) s.notes.push(d.message);
  if (r.propertyIds.length) {
    s.notes.push(`Properties: ${r.propertyIds.join(", ")}`);
  }
  if (r.constraintBlocks.length) {
    s.notes.push(`Constraints blocks: ${r.constraintBlocks.length}`);
  }
  // Deliberately not computed: min/max would cost three Number() calls per node
  // line, and this path is cheap precisely because a data line is `n++`.
  s.unknown.push("bounds");
  return s;
}

// ---- meshio++ -----------------------------------------------------------------------

async function summarizeMeshio(fsPath: string, fileSize: number, format?: string): Promise<MeshSummary> {
  const s = emptySummary(fsPath, fileSize);
  const ext = s.ext;
  // The a-priori guess; corrected below from what the reader actually did.
  s.cost = HEADER_METADATA_EXTENSIONS.includes(ext) ? "buffered" : "read";
  // readMeshMetadata slurps the whole file (plus siblings) into a Buffer and
  // copies it into MEMFS, so the honest bytesRead is the file, not a header.
  s.bytesRead = fileSize;

  const { metadata } = await readMeshMetadata(fsPath, format);
  if (metadata.fellBackToFullRead) s.cost = "read";
  s.method =
    `meshio++ readMetadata (${metadata.format})` +
    (metadata.fellBackToFullRead ? " — fell back to a full read" : "");
  s.nodeCount = metadata.numPoints;
  s.cellCount = metadata.numCells;
  s.blocks = metadata.cellBlocks.map((b) => ({
    type: b.type,
    count: b.numCells,
    ...(b.ragged ? {} : { nodesPerCell: b.nodesPerCell }),
  }));
  s.pointDataNames = [...metadata.pointDataNames];
  s.cellDataNames = [...metadata.cellDataNames];
  s.fieldDataNames = [...metadata.fieldDataNames];
  s.regions = metadata.regions.map((r) => ({ name: r.name, kind: r.kind, count: r.numEntries }));
  s.timeValues = [...metadata.timeValues];
  if (metadata.bboxMin !== undefined && metadata.bboxMax !== undefined) {
    s.bounds = { min: [...metadata.bboxMin], max: [...metadata.bboxMax] };
  } else {
    // Absent, never null: "not computed" must not read as a box at the origin.
    s.unknown.push("bounds");
  }
  if (metadata.regions.length === 0 && !metadata.fellBackToFullRead) {
    s.unknown.push("named regions");
  }
  return s;
}

// ---- Dispatcher ---------------------------------------------------------------------

/**
 * What is in this mesh file, without building a model of it.
 *
 * Mirrors `parseMeshFile`'s extension switch, in the same order, plus `.mdpa`
 * (which that switch has no case for — the MDPA provider is separate). The
 * returned `cost`/`bytesRead` say what the answer actually took; see the module
 * header for why that is a first-class part of the result rather than a detail.
 */
export async function summarizeMeshFile(
  fsPath: string,
  opts?: { meshioFormat?: string }
): Promise<MeshSummary> {
  const fileSize = await meshSourceBytes(fsPath);
  const ext = meshExtname(fsPath);

  if (ext === ".mdpa") return summarizeMdpa(fsPath, fileSize);
  if ((VTK_XML_EXTENSIONS as readonly string[]).includes(ext)) {
    return summarizeVtkXml(fsPath, fileSize);
  }
  switch (ext) {
    case ".vtk":
      return summarizeVtkLegacy(fsPath, fileSize);
    case ".vtm":
      return summarizeVtm(fsPath, fileSize);
    case ".stl":
      return summarizeStl(fsPath, fileSize);
    case ".obj":
      return summarizeObj(fsPath, fileSize);
    case ".ply":
      return summarizePly(fsPath, fileSize);
    default:
      if (isMeshioReadExtension(ext)) {
        return summarizeMeshio(fsPath, fileSize, opts?.meshioFormat);
      }
      throw new Error(
        `Cannot summarize "${ext}" (supported: ${SUMMARIZABLE_EXTENSIONS.join(", ")}).`
      );
  }
}
