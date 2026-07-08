import * as fs from "node:fs";
import * as readline from "node:readline";
import { FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import {
  buildBlocksFromOffsets,
  expandCellField,
  finalizeModel,
} from "./modelBuilder";
import { binaryType } from "./binaryTypes";

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
  const coords = new Float32Array(rawCoords.length);
  for (let i = 0; i < rawCoords.length; i++) coords[i] = rawCoords[i];

  // Cells: convert the legacy [stride, nodes...] token stream into the
  // VTU-style types/offsets/connectivity triple consumed by modelBuilder.
  const nCellsActual = Math.min(nCells, rawCellTypes.length);
  if (rawCellTypes.length !== nCells && nCells > 0) {
    diagnostics.push({
      line: 0,
      message: `CELL_TYPES count (${rawCellTypes.length}) differs from CELLS count (${nCells}); using ${nCellsActual}.`,
    });
  }

  const types: number[] = [];
  const offsets: number[] = [];
  const connectivity: number[] = [];
  let cellPos = 0;
  for (let c = 0; c < nCellsActual; c++) {
    const stride = Math.round(rawCells[cellPos++] ?? 0);
    for (let k = 0; k < stride; k++) {
      connectivity.push(Math.round(rawCells[cellPos + k] ?? 0));
    }
    cellPos += stride;
    types.push(rawCellTypes[c]);
    offsets.push(connectivity.length);
  }

  const { blocks, expansion } = buildBlocksFromOffsets(
    types,
    offsets,
    connectivity,
    diagnostics
  );

  // Fields: synthesise 1-based sequential IDs matching the VTK tuple order
  const fields: FieldData[] = stagingFields.map((sf) => {
    const ids = new Int32Array(sf.nTuples);
    for (let i = 0; i < sf.nTuples; i++) ids[i] = i + 1;
    const values = new Float64Array(sf.values.length);
    for (let i = 0; i < sf.values.length; i++) values[i] = sf.values[i];
    let field: FieldData = {
      kind: sf.kind,
      variable: sf.name,
      components: sf.nComp,
      ids,
      values,
    };
    // Keep cell data aligned when normalization split cells
    if (sf.kind === "Elemental" && sf.nTuples === nCellsActual) {
      let identity = true;
      for (let i = 0; i < expansion.length; i++) {
        if (expansion[i] !== 1) { identity = false; break; }
      }
      if (!identity) field = expandCellField(field, expansion);
    }
    return field;
  });

  return finalizeModel({
    nodeCount: nPoints,
    coords,
    blocks,
    fields,
    diagnostics,
  });
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

/**
 * Parse a BINARY legacy VTK buffer (ASCII keyword lines, big-endian payloads
 * per the legacy spec) → MdpaModel.  Errors are reported as diagnostics.
 */
export function parseVtkLegacyBinary(buf: Buffer): MdpaModel {
  const diagnostics: MdpaDiagnostic[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  let pos = 0;
  let lineNum = 0;

  const readLine = (): string | null => {
    if (pos >= buf.length) return null;
    let nl = buf.indexOf(0x0a, pos);
    if (nl < 0) nl = buf.length;
    const line = buf.subarray(pos, nl).toString("latin1").trim();
    pos = nl + 1;
    lineNum++;
    return line;
  };

  /** Reads `count` big-endian values of the named type; null on failure. */
  const readValues = (count: number, typeName: string): number[] | null => {
    const t = binaryType(typeName);
    if (!t) {
      diagnostics.push({ line: lineNum, message: `Unknown binary data type "${typeName}".` });
      return null;
    }
    if (pos + count * t.size > buf.length) {
      diagnostics.push({
        line: lineNum,
        message: `Truncated binary payload: expected ${count} × ${typeName}.`,
      });
      return null;
    }
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      out[i] = t.read(view, pos, false); // legacy binary is big-endian
      pos += t.size;
    }
    return out;
  };

  let nPoints = 0;
  let rawCoords: number[] = [];
  let nCells = 0;
  let rawCells: number[] = [];
  let rawCellTypes: number[] = [];
  const stagingFields: StagingField[] = [];
  let dataKind: "Nodal" | "Elemental" | null = null;
  let nTuples = 0;
  let headerLeft = 3; // version, title, BINARY

  let line: string | null;
  outer: while ((line = readLine()) !== null) {
    if (!line) continue;
    if (headerLeft > 0) {
      headerLeft--;
      continue;
    }
    const toks = line.split(/\s+/);
    const kw = toks[0].toUpperCase();

    if (kw === "DATASET") continue;
    if (kw === "POINTS") {
      nPoints = parseInt(toks[1], 10) || 0;
      const vals = readValues(nPoints * 3, toks[2] ?? "float");
      if (!vals) break;
      rawCoords = vals;
    } else if (kw === "CELLS") {
      nCells = parseInt(toks[1], 10) || 0;
      const size = parseInt(toks[2], 10) || 0;
      const vals = readValues(size, "int");
      if (!vals) break;
      rawCells = vals;
    } else if (kw === "CELL_TYPES") {
      const n = parseInt(toks[1], 10) || 0;
      const vals = readValues(n, "int");
      if (!vals) break;
      rawCellTypes = vals;
    } else if (kw === "POINT_DATA") {
      dataKind = "Nodal";
      nTuples = parseInt(toks[1], 10) || 0;
    } else if (kw === "CELL_DATA") {
      dataKind = "Elemental";
      nTuples = parseInt(toks[1], 10) || 0;
    } else if (kw === "SCALARS" && dataKind) {
      const name = toks[1] ?? "SCALAR";
      const typeName = toks[2] ?? "float";
      const nComp = toks[3] ? parseInt(toks[3], 10) || 1 : 1;
      // Consume the LOOKUP_TABLE line (skipping blanks)
      let lookup: string | null;
      while ((lookup = readLine()) !== null && !lookup) { /* skip blanks */ }
      if (lookup === null || !lookup.toUpperCase().startsWith("LOOKUP_TABLE")) {
        diagnostics.push({ line: lineNum, message: `Expected LOOKUP_TABLE after SCALARS ${name}.` });
        break;
      }
      const vals = readValues(nTuples * nComp, typeName);
      if (!vals) break;
      stagingFields.push({ kind: dataKind, name, nComp, nTuples, values: vals });
    } else if ((kw === "VECTORS" || kw === "TENSORS") && dataKind) {
      const name = toks[1] ?? kw;
      const nComp = kw === "VECTORS" ? 3 : 9;
      const vals = readValues(nTuples * nComp, toks[2] ?? "float");
      if (!vals) break;
      stagingFields.push({ kind: dataKind, name, nComp, nTuples, values: vals });
    } else if (kw === "FIELD" && dataKind) {
      const nArrays = parseInt(toks[2], 10) || 0;
      for (let a = 0; a < nArrays; a++) {
        let head: string | null;
        while ((head = readLine()) !== null && !head) { /* skip blanks */ }
        if (head === null) break outer;
        const h = head.split(/\s+/);
        const nComp = parseInt(h[1], 10) || 1;
        const nT = parseInt(h[2], 10) || 0;
        const vals = readValues(nComp * nT, h[3] ?? "float");
        if (!vals) break outer;
        stagingFields.push({ kind: dataKind, name: h[0], nComp, nTuples: nT, values: vals });
      }
    }
    // Unknown sections (LOOKUP_TABLE definitions, METADATA, …) are skipped
  }

  return buildModel(
    nPoints,
    rawCoords,
    nCells,
    rawCells,
    rawCellTypes,
    stagingFields,
    diagnostics
  );
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
