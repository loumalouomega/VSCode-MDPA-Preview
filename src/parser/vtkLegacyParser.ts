import * as fs from "node:fs";
import * as readline from "node:readline";
import { EntityBlock, FieldData, MdpaDiagnostic, MdpaModel } from "./types";

// ---- Helpers -----------------------------------------------------------------

function tokenizeNums(line: string): number[] {
  const parts = line.split(/\s+/);
  const out: number[] = [];
  for (const p of parts) {
    if (!p) continue;
    const n = Number(p);
    if (!isNaN(n)) out.push(n);
  }
  return out;
}

// ---- Internal staging --------------------------------------------------------

interface StagingField {
  kind: "Nodal" | "Elemental";
  name: string;
  nComp: number;
  nTuples: number;
  values: number[];
}

// ---- Parser class ------------------------------------------------------------

class VtkLegacyParser {
  private lineNum = 0;
  private headerCount = 0;
  private isBinary = false;
  readonly diagnostics: MdpaDiagnostic[] = [];

  // Token collection
  private collecting = false;
  private collectBuf: number[] = [];
  private collectNeed = 0;
  private collectDone: ((tokens: number[]) => void) | null = null;

  // Geometry staging
  private nPoints = 0;
  private rawCoords: number[] = [];
  private nCells = 0;
  private cellTokenTotal = 0;
  private rawCells: number[] = [];
  private rawCellTypes: number[] = [];

  // Data section staging
  private dataKind: "Nodal" | "Elemental" | null = null;
  private nFieldArraysLeft = 0;
  private scalarName = "";
  private scalarNComp = 1;
  private lookupPending = false;
  readonly stagingFields: StagingField[] = [];

  // "header" → "top" → "data_top" / "field_next"
  private mode: "header" | "top" | "data_top" | "field_next" = "header";

  feedLine(raw: string): void {
    this.lineNum++;
    // VTK files don't use // comments, but strip defensively
    const ci = raw.indexOf("//");
    const line = (ci >= 0 ? raw.slice(0, ci) : raw).trim();
    if (!line) return;

    if (this.mode === "header") {
      this.headerCount++;
      if (this.headerCount === 3) {
        // Line 3 is the format specifier: ASCII or BINARY
        if (line.toUpperCase() === "BINARY") {
          this.isBinary = true;
          this.diag("Binary VTK format is not supported; only ASCII is previewed.");
        }
        this.mode = "top";
      }
      return;
    }

    if (this.isBinary) return;

    if (this.collecting) {
      for (const n of tokenizeNums(line)) {
        if (this.collectBuf.length < this.collectNeed) this.collectBuf.push(n);
      }
      if (this.collectBuf.length >= this.collectNeed) {
        this.collecting = false;
        const cb = this.collectDone!;
        this.collectDone = null;
        cb(this.collectBuf);
      }
      return;
    }

    this.processKeyword(line);
  }

  finish(): MdpaModel {
    return buildModel(
      this.nPoints,
      this.rawCoords,
      this.nCells,
      this.rawCells,
      this.rawCellTypes,
      this.stagingFields,
      this.diagnostics
    );
  }

  private beginCollect(n: number, done: (toks: number[]) => void): void {
    this.collectBuf = [];
    this.collectNeed = n;
    this.collectDone = done;
    this.collecting = n > 0;
    if (n === 0) done([]);
  }

  private diag(msg: string): void {
    this.diagnostics.push({ line: this.lineNum, message: msg });
  }

  private processKeyword(line: string): void {
    const toks = line.split(/\s+/);
    const kw = toks[0].toUpperCase();

    // POINT_DATA and CELL_DATA can appear from any mode
    if (kw === "POINT_DATA") {
      this.dataKind = "Nodal";
      this.mode = "data_top";
      this.nFieldArraysLeft = 0;
      this.lookupPending = false;
      return;
    }
    if (kw === "CELL_DATA") {
      this.dataKind = "Elemental";
      this.mode = "data_top";
      this.nFieldArraysLeft = 0;
      this.lookupPending = false;
      return;
    }

    if (this.mode === "top") {
      if (kw === "DATASET") return; // already know it's UNSTRUCTURED_GRID
      if (kw === "POINTS") {
        this.nPoints = parseInt(toks[1], 10) || 0;
        this.beginCollect(this.nPoints * 3, (t) => { this.rawCoords = t; });
        return;
      }
      if (kw === "CELLS") {
        this.nCells = parseInt(toks[1], 10) || 0;
        this.cellTokenTotal = parseInt(toks[2], 10) || 0;
        this.beginCollect(this.cellTokenTotal, (t) => { this.rawCells = t; });
        return;
      }
      if (kw === "CELL_TYPES") {
        const n = parseInt(toks[1], 10) || 0;
        this.beginCollect(n, (t) => { this.rawCellTypes = t; });
        return;
      }
      // Ignore other top-level sections (FIELD at top-level, etc.)
      return;
    }

    if (this.mode === "data_top" || this.mode === "field_next") {
      this.processDataKeyword(kw, toks);
    }
  }

  private processDataKeyword(kw: string, toks: string[]): void {
    // LOOKUP_TABLE must be consumed before other keywords
    if (this.lookupPending) {
      if (kw === "LOOKUP_TABLE") {
        this.lookupPending = false;
        const nT = this.dataKind === "Nodal" ? this.nPoints : this.nCells;
        const name = this.scalarName;
        const nComp = this.scalarNComp;
        const kind = this.dataKind!;
        this.beginCollect(nT * nComp, (t) => {
          this.stagingFields.push({ kind, name, nComp, nTuples: nT, values: t });
          this.mode = "data_top";
        });
      } else {
        // Unexpected — reset
        this.lookupPending = false;
        this.diag(`Expected LOOKUP_TABLE, got: ${toks.join(" ")}`);
        this.processDataKeyword(kw, toks);
      }
      return;
    }

    if (kw === "FIELD") {
      // FIELD FieldData N
      this.nFieldArraysLeft = parseInt(toks[2], 10) || 0;
      this.mode = this.nFieldArraysLeft > 0 ? "field_next" : "data_top";
      return;
    }

    if (this.mode === "field_next" && this.nFieldArraysLeft > 0) {
      // Array header: NAME nComp nTuples type
      const name = toks[0];
      const nComp = parseInt(toks[1], 10) || 1;
      const nTuples = parseInt(toks[2], 10) || 0;
      const kind = this.dataKind!;
      this.nFieldArraysLeft--;
      const remaining = this.nFieldArraysLeft;
      this.beginCollect(nComp * nTuples, (t) => {
        this.stagingFields.push({ kind, name, nComp, nTuples, values: t });
        this.mode = remaining > 0 ? "field_next" : "data_top";
      });
      return;
    }

    if (kw === "SCALARS") {
      // SCALARS name type [numComp]
      this.scalarName = toks[1] ?? "SCALAR";
      this.scalarNComp = toks[3] ? (parseInt(toks[3], 10) || 1) : 1;
      this.lookupPending = true;
      return;
    }

    if (kw === "VECTORS") {
      const name = toks[1] ?? "VECTORS";
      const nT = this.dataKind === "Nodal" ? this.nPoints : this.nCells;
      const kind = this.dataKind!;
      this.beginCollect(nT * 3, (t) => {
        this.stagingFields.push({ kind, name, nComp: 3, nTuples: nT, values: t });
        this.mode = "data_top";
      });
      return;
    }

    if (kw === "TENSORS") {
      const name = toks[1] ?? "TENSORS";
      const nT = this.dataKind === "Nodal" ? this.nPoints : this.nCells;
      const kind = this.dataKind!;
      this.beginCollect(nT * 9, (t) => {
        this.stagingFields.push({ kind, name, nComp: 9, nTuples: nT, values: t });
        this.mode = "data_top";
      });
      return;
    }
    // Unknown keyword inside data section — ignore
  }
}

// ---- Model builder -----------------------------------------------------------

function buildModel(
  nPoints: number,
  rawCoords: number[],
  nCells: number,
  rawCells: number[],
  rawCellTypes: number[],
  stagingFields: StagingField[],
  diagnostics: MdpaDiagnostic[]
): MdpaModel {
  // Nodes: synthesise 1-based IDs for the 0-based VTK POINTS list
  const nodeIds = new Int32Array(nPoints);
  for (let i = 0; i < nPoints; i++) nodeIds[i] = i + 1;
  const coords = new Float32Array(rawCoords.length);
  for (let i = 0; i < rawCoords.length; i++) coords[i] = rawCoords[i];

  // Cells: parse the flat CELLS token stream, group by VTK cell type
  const nCellsActual = Math.min(nCells, rawCellTypes.length);
  if (rawCellTypes.length !== nCells && nCells > 0) {
    diagnostics.push({
      line: 0,
      message: `CELL_TYPES count (${rawCellTypes.length}) differs from CELLS count (${nCells}); using ${nCellsActual}.`,
    });
  }

  const byType = new Map<
    number,
    { entityIds: number[]; connectivity: number[]; stride: number }
  >();
  let cellPos = 0;
  let gid = 1;

  for (let c = 0; c < nCellsActual; c++) {
    const cellType = rawCellTypes[c];
    const stride = Math.round(rawCells[cellPos++] ?? 0);
    const endPos = cellPos + stride;
    const conn1: number[] = [];
    for (let k = cellPos; k < endPos; k++) {
      conn1.push(Math.round(rawCells[k] ?? 0) + 1); // 0-based → 1-based
    }
    cellPos = endPos;

    let blk = byType.get(cellType);
    if (!blk) {
      blk = { entityIds: [], connectivity: [], stride };
      byType.set(cellType, blk);
    }
    blk.entityIds.push(gid++);
    for (const n of conn1) blk.connectivity.push(n);
  }

  const blocks: EntityBlock[] = [];
  for (const [vtkCellType, blk] of byType) {
    blocks.push({
      kind: "Elements",
      name: `VtkCell_${vtkCellType}`,
      vtkCellType,
      count: blk.entityIds.length,
      stride: blk.stride,
      entityIds: new Int32Array(blk.entityIds),
      propertyIds: undefined,
      connectivity: new Int32Array(blk.connectivity),
    });
  }

  // Fields: synthesise 1-based sequential IDs matching the VTK tuple order
  const fields: FieldData[] = stagingFields.map((sf) => {
    const ids = new Int32Array(sf.nTuples);
    for (let i = 0; i < sf.nTuples; i++) ids[i] = i + 1;
    const values = new Float64Array(sf.values.length);
    for (let i = 0; i < sf.values.length; i++) values[i] = sf.values[i];
    return {
      kind: sf.kind,
      variable: sf.name,
      components: sf.nComp,
      ids,
      values,
    };
  });

  // Bounds and is3D
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let hasZ = false;
  for (let i = 0; i < nPoints; i++) {
    const x = rawCoords[i * 3] ?? 0;
    const y = rawCoords[i * 3 + 1] ?? 0;
    const z = rawCoords[i * 3 + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (z !== 0) hasZ = true;
  }
  if (!isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0; minZ = 0; maxZ = 0; }

  return {
    nodeCount: nPoints,
    nodeIds,
    coords,
    blocks,
    subModelParts: [],
    meta: [],
    fields,
    diagnostics,
    is3D: hasZ,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

// ---- Public API --------------------------------------------------------------

/** Parse an ASCII legacy VTK string (DATASET UNSTRUCTURED_GRID) → MdpaModel. */
export function parseVtk(text: string): MdpaModel {
  const parser = new VtkLegacyParser();
  for (const line of text.split(/\r?\n/)) {
    parser.feedLine(line);
  }
  return parser.finish();
}

/** Async streaming parse from disk with optional progress callback. */
export async function parseVtkFile(
  fsPath: string,
  onProgress?: (phase: "read", bytesRead: number, totalBytes: number) => void
): Promise<MdpaModel> {
  const stat = await fs.promises.stat(fsPath);
  const totalBytes = stat.size;
  let bytesRead = 0;

  return new Promise<MdpaModel>((resolve, reject) => {
    const parser = new VtkLegacyParser();
    const stream = fs.createReadStream(fsPath);
    stream.on("data", (chunk) => {
      bytesRead += chunk.length;
      onProgress?.("read", bytesRead, totalBytes);
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => parser.feedLine(line));
    rl.on("close", () => resolve(parser.finish()));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}
