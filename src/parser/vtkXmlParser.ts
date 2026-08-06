/**
 * VTK XML dataset builders: turns a parsed VtkXmlFile into an MdpaModel.
 * Dispatches on the VTKFile `type` attribute (UnstructuredGrid, PolyData,
 * ImageData, StructuredGrid, RectilinearGrid).  All builders are
 * multi-<Piece>-aware, concatenating pieces with node-index offsets.
 *
 * Pure module: no vscode/DOM/vtk imports.
 */

import { FieldBlockKind, FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import {
  buildBlocksFromOffsets,
  expandCellField,
  fieldFromTuples,
  finalizeModel,
} from "./modelBuilder";
import { decomposePolyhedronBlock } from "./polyhedronDecompose";
import {
  decodeDataArray,
  findAll,
  findFirst,
  parseVtkXmlFile,
  VtkXmlFile,
  XmlEl,
} from "./vtkXmlCore";

/** Parse any VTK XML dataset buffer → MdpaModel. Throws on unsupported types. */
export function parseVtkXml(buf: Buffer): MdpaModel {
  const diagnostics: MdpaDiagnostic[] = [];
  const file = parseVtkXmlFile(buf);

  switch (file.datasetType) {
    case "UnstructuredGrid":
      return buildUnstructured(file, diagnostics);
    case "PolyData":
      return buildPolyData(file, diagnostics);
    case "ImageData":
      return buildImageData(file, diagnostics);
    case "StructuredGrid":
      return buildStructuredGrid(file, diagnostics);
    case "RectilinearGrid":
      return buildRectilinearGrid(file, diagnostics);
    default:
      throw new Error(
        `Unsupported VTK XML dataset type "${file.datasetType}".`
      );
  }
}

// VTK cell type ids used by the builders
const VERTEX = 1;
const POLY_VERTEX = 2;
const LINE = 3;
const POLY_LINE = 4;
const TRIANGLE_STRIP = 6;
const POLYGON = 7;
const QUAD = 9;
const TETRA = 10;
const HEXAHEDRON = 12;
/** VTK_POLYHEDRON: face-based, so it is decomposed rather than staged as-is. */
const POLYHEDRON = 42;

/** Hard limit before allocating structured points (a 512³ CT would OOM the host). */
const MAX_STRUCTURED_POINTS = 50_000_000;
const WARN_STRUCTURED_POINTS = 5_000_000;

// ---- Shared staging --------------------------------------------------------------

interface StagingField {
  kind: FieldBlockKind;
  components: number;
  values: number[];
}

class ModelStaging {
  readonly coords: number[] = [];
  readonly types: number[] = [];
  readonly offsets: number[] = [];
  readonly connectivity: number[] = []; // 0-based, already node-offset
  readonly fields = new Map<string, StagingField>();
  nCellsStaged = 0;
  /**
   * Apex nodes invented by decomposing a VTK_POLYHEDRON, each recorded with the
   * node indices whose mean it is — so `finish` can interpolate the nodal
   * fields at them (see addPolyhedron / polyhedronDecompose.ts).
   */
  readonly addedNodeParents: number[][] = [];
  /**
   * Flat cells staged per SOURCE cell, in order. Every path but a decomposed
   * polyhedron contributes exactly one, so this is all 1s for an ordinary file
   * and folding it below is an identity — but a polyhedron stages a whole fan
   * against a single CellData value, which would otherwise go unreplicated.
   */
  readonly flatPerSourceCell: number[] = [];

  get nodeCount(): number {
    return this.coords.length / 3;
  }

  /** Appends decoded Points coords (NumberOfComponents assumed 3). */
  addPoints(values: Float64Array): void {
    for (let i = 0; i < values.length; i++) this.coords.push(values[i]);
  }

  /**
   * Appends one cell given 0-based piece-local node indices.
   *
   * `ownSourceCell` is false only for the tetrahedra a decomposed polyhedron
   * emits — they share their source cell (and so its CellData value) rather
   * than each being one.
   */
  addCell(
    cellType: number,
    localNodes: ArrayLike<number>,
    nodeOffset: number,
    ownSourceCell = true
  ): void {
    this.types.push(cellType);
    for (let i = 0; i < localNodes.length; i++) {
      this.connectivity.push(localNodes[i] + nodeOffset);
    }
    this.offsets.push(this.connectivity.length);
    this.nCellsStaged++;
    if (ownSourceCell) this.flatPerSourceCell.push(1);
  }

  /**
   * Appends one VTK_POLYHEDRON, decomposed into tetrahedra.
   *
   * VTK has no drawable representation of a general polyhedron here and Kratos
   * has no element for one, so the cell is split the same way a polyhedral
   * block read through meshio++ is (polyhedronDecompose.ts) — including the
   * apex nodes that entails.  `faces` is the cell's slice of the VTU `faces`
   * array in VTK's own layout: numFaces, then per face its node count followed
   * by that many GLOBAL (already node-offset) point indices.
   *
   * Returns the number of tetrahedra staged, 0 when the cell is unusable.
   */
  addPolyhedron(faces: ArrayLike<number>, diagnostics: MdpaDiagnostic[]): number {
    const data: number[] = [];
    const faceOffsets: number[] = [0];
    const numFaces = faces[0];
    let at = 1;
    for (let f = 0; f < numFaces; f++) {
      const n = faces[at++];
      if (n === undefined || at + n > faces.length) {
        diagnostics.push({
          line: 0,
          message: "A VTK_POLYHEDRON's `faces` entry is truncated; cell skipped.",
        });
        return 0;
      }
      for (let k = 0; k < n; k++) data.push(faces[at + k]);
      at += n;
      faceOffsets.push(data.length);
    }
    const d = decomposePolyhedronBlock(
      {
        type: `polyhedron${numFaces}`,
        data: Int32Array.from(data),
        faceOffsets: Int32Array.from(faceOffsets),
        cellOffsets: new Int32Array([0, numFaces]),
      },
      Float64Array.from(this.coords),
      3,
      this.nodeCount
    );
    if (d.tetRow.length === 0) return 0;
    for (const p of d.addedPoints) this.coords.push(p);
    for (const parents of d.addedParents) this.addedNodeParents.push(parents);
    for (let t = 0; t < d.tetRow.length; t++) {
      // Already global indices: pass nodeOffset 0.
      this.addCell(TETRA, d.tets.subarray(t * 4, t * 4 + 4), 0, false);
    }
    this.flatPerSourceCell.push(d.tetRow.length); // ONE source cell, N tets
    return d.tetRow.length;
  }

  /** Appends PointData/CellData tuples for one piece. */
  addFieldValues(
    kind: FieldBlockKind,
    name: string,
    components: number,
    values: Float64Array
  ): void {
    const key = `${kind}|${name}`;
    let f = this.fields.get(key);
    if (!f) {
      f = { kind, components, values: [] };
      this.fields.set(key, f);
    }
    for (let i = 0; i < values.length; i++) f.values.push(values[i]);
  }

  finish(diagnostics: MdpaDiagnostic[]): MdpaModel {
    const { blocks, expansion: flatExpansion } = buildBlocksFromOffsets(
      this.types,
      this.offsets,
      this.connectivity,
      diagnostics
    );

    // Fold flat-cell counts back onto SOURCE cells, which is what a CellData
    // array is indexed by. An identity for every file without a polyhedron.
    let expansion: ArrayLike<number> = flatExpansion;
    if (this.flatPerSourceCell.some((n) => n !== 1)) {
      const folded: number[] = [];
      for (let src = 0, flat = 0; src < this.flatPerSourceCell.length; src++) {
        let total = 0;
        for (let k = 0; k < this.flatPerSourceCell[src]; k++) {
          total += flatExpansion[flat++] ?? 0;
        }
        folded.push(total);
      }
      expansion = folded;
    }

    let identity = true;
    for (let i = 0; i < expansion.length; i++) {
      if (expansion[i] !== 1) {
        identity = false;
        break;
      }
    }

    const fields: FieldData[] = [];
    for (const [key, sf] of this.fields) {
      const name = key.slice(key.indexOf("|") + 1);
      // A decomposed polyhedron's apex nodes carry the mean of their
      // generators, so a nodal field stays defined on every node that is drawn.
      if (sf.kind === "Nodal" && this.addedNodeParents.length > 0) {
        interpolateAtAddedNodes(sf, this.addedNodeParents, this.nodeCount);
      }
      let field = fieldFromTuples(sf.kind, name, sf.components, sf.values);
      if (
        sf.kind === "Elemental" &&
        !identity &&
        field.ids.length === expansion.length
      ) {
        field = expandCellField(field, expansion);
      }
      fields.push(field);
    }

    return finalizeModel({
      nodeCount: this.nodeCount,
      coords: new Float32Array(this.coords),
      blocks,
      fields,
      diagnostics,
    });
  }
}

/**
 * Grows a nodal field to cover the apex nodes a polyhedral decomposition added,
 * each taking the mean of its generators. Mutates `sf.values` in place; a
 * generator may itself be an earlier apex, which is why this runs in order.
 */
function interpolateAtAddedNodes(
  sf: StagingField,
  addedParents: readonly number[][],
  nodeCount: number
): void {
  const c = sf.components;
  const existing = Math.floor(sf.values.length / c);
  if (existing !== nodeCount - addedParents.length) return; // not a per-node array
  for (const parents of addedParents) {
    for (let k = 0; k < c; k++) {
      let sum = 0;
      for (const p of parents) sum += sf.values[p * c + k] ?? 0;
      sf.values.push(sum / parents.length);
    }
  }
}

// ---- Piece helpers ----------------------------------------------------------------

function dataArrayByName(parent: XmlEl | undefined, name: string): XmlEl | undefined {
  if (!parent) return undefined;
  return findAll(parent, "DataArray").find((d) => d.attrs.Name === name);
}

/** Decodes a piece's Points into staging; returns false when absent/invalid. */
function addPiecePoints(
  staging: ModelStaging,
  piece: XmlEl,
  file: VtkXmlFile,
  diagnostics: MdpaDiagnostic[]
): boolean {
  const points = findFirst(piece, "Points");
  const da = points ? findFirst(points, "DataArray") : undefined;
  if (!da) {
    diagnostics.push({ line: 0, message: "Piece has no <Points> DataArray; skipped." });
    return false;
  }
  const comps = parseInt(da.attrs.NumberOfComponents ?? "3", 10) || 3;
  const values = decodeDataArray(da, file, diagnostics);
  if (comps === 3) {
    staging.addPoints(values);
  } else {
    // Pad/truncate unusual component counts to xyz
    const n = Math.floor(values.length / comps);
    for (let i = 0; i < n; i++) {
      staging.coords.push(
        values[i * comps] ?? 0,
        comps > 1 ? values[i * comps + 1] : 0,
        comps > 2 ? values[i * comps + 2] : 0
      );
    }
  }
  return true;
}

/** Decodes a piece's PointData/CellData DataArrays into staging fields. */
function addPieceFields(
  staging: ModelStaging,
  piece: XmlEl,
  file: VtkXmlFile,
  diagnostics: MdpaDiagnostic[]
): void {
  for (const [tag, kind] of [
    ["PointData", "Nodal"],
    ["CellData", "Elemental"],
  ] as const) {
    const section = findFirst(piece, tag);
    if (!section) continue;
    for (const da of findAll(section, "DataArray")) {
      const name = da.attrs.Name ?? "unnamed";
      const comps = parseInt(da.attrs.NumberOfComponents ?? "1", 10) || 1;
      staging.addFieldValues(kind, name, comps, decodeDataArray(da, file, diagnostics));
    }
  }
}

// ---- UnstructuredGrid (.vtu) ---------------------------------------------------------

function buildUnstructured(file: VtkXmlFile, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const grid = findFirst(file.root, "UnstructuredGrid");
  if (!grid) throw new Error("Missing <UnstructuredGrid> element.");

  const staging = new ModelStaging();

  for (const piece of findAll(grid, "Piece")) {
    const nodeOffset = staging.nodeCount;
    if (!addPiecePoints(staging, piece, file, diagnostics)) continue;

    const cells = findFirst(piece, "Cells");
    const connectivity = dataArrayByName(cells, "connectivity");
    const offsets = dataArrayByName(cells, "offsets");
    const types = dataArrayByName(cells, "types");
    if (connectivity && offsets && types) {
      const conn = decodeDataArray(connectivity, file, diagnostics);
      const offs = decodeDataArray(offsets, file, diagnostics);
      const typs = decodeDataArray(types, file, diagnostics);
      // A VTK_POLYHEDRON's connectivity holds only the cell's unique point ids;
      // its actual face structure lives in these two arrays, so without them the
      // cell would stage as a meaningless n-node blob (see addPolyhedron).
      const facesEl = dataArrayByName(cells, "faces");
      const faceOffsetsEl = dataArrayByName(cells, "faceoffsets");
      const faces = facesEl ? decodeDataArray(facesEl, file, diagnostics) : undefined;
      const faceOffs = faceOffsetsEl
        ? decodeDataArray(faceOffsetsEl, file, diagnostics)
        : undefined;
      let polyhedra = 0;
      let tets = 0;
      let start = 0;
      let faceStart = 0;
      const nCells = Math.min(offs.length, typs.length);
      for (let c = 0; c < nCells; c++) {
        const end = offs[c];
        if (typs[c] === POLYHEDRON) {
          polyhedra++;
          // faceoffsets is an END offset per cell, -1 for a non-polyhedral one.
          const faceEnd = faceOffs ? faceOffs[c] : -1;
          if (faces && faceEnd > faceStart) {
            const cellFaces = faces.subarray(faceStart, faceEnd);
            // Face node ids are piece-local; addPolyhedron wants global ones.
            const shifted = new Float64Array(cellFaces.length);
            let at = 0;
            shifted[at] = cellFaces[at];
            const numFaces = cellFaces[at++];
            for (let f = 0; f < numFaces && at < cellFaces.length; f++) {
              const n = cellFaces[at];
              shifted[at++] = n;
              for (let k = 0; k < n && at < cellFaces.length; k++, at++) {
                shifted[at] = cellFaces[at] + nodeOffset;
              }
            }
            tets += staging.addPolyhedron(shifted, diagnostics);
            faceStart = faceEnd;
          } else {
            diagnostics.push({
              line: 0,
              message:
                "A VTK_POLYHEDRON cell has no `faces`/`faceoffsets` entry, so its " +
                "shape is unknown; skipped.",
            });
          }
          start = end;
          continue;
        }
        staging.addCell(typs[c], conn.subarray(start, end), nodeOffset);
        start = end;
      }
      if (polyhedra > 0 && tets > 0) {
        diagnostics.push({
          line: 0,
          message:
            `${polyhedra} VTK_POLYHEDRON cell(s) decomposed into ${tets} tetrahedra ` +
            `for display. The original polyhedra are not preserved on export.`,
        });
      }
    }

    addPieceFields(staging, piece, file, diagnostics);
  }

  return staging.finish(diagnostics);
}

// ---- PolyData (.vtp) -------------------------------------------------------------

const POLY_SECTIONS: ReadonlyArray<[tag: string, synthType: number]> = [
  ["Verts", POLY_VERTEX],
  ["Lines", POLY_LINE],
  ["Polys", POLYGON],
  ["Strips", TRIANGLE_STRIP],
];

function buildPolyData(file: VtkXmlFile, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const grid = findFirst(file.root, "PolyData");
  if (!grid) throw new Error("Missing <PolyData> element.");

  const staging = new ModelStaging();

  for (const piece of findAll(grid, "Piece")) {
    const nodeOffset = staging.nodeCount;
    if (!addPiecePoints(staging, piece, file, diagnostics)) continue;

    // CellData tuple order is verts → lines → polys → strips; staging cells in
    // that same order keeps the expansion map aligned.
    for (const [tag, synthType] of POLY_SECTIONS) {
      const section = findFirst(piece, tag);
      const connectivity = dataArrayByName(section, "connectivity");
      const offsets = dataArrayByName(section, "offsets");
      if (!connectivity || !offsets) continue;
      const conn = decodeDataArray(connectivity, file, diagnostics);
      const offs = decodeDataArray(offsets, file, diagnostics);
      let start = 0;
      for (let c = 0; c < offs.length; c++) {
        const end = offs[c];
        staging.addCell(synthType, conn.subarray(start, end), nodeOffset);
        start = end;
      }
    }

    addPieceFields(staging, piece, file, diagnostics);
  }

  return staging.finish(diagnostics);
}

// ---- Structured datasets (.vti / .vts / .vtr) ---------------------------------------

type Extent = [number, number, number, number, number, number];

function parseExtent(s: string | undefined): Extent | null {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map((t) => parseInt(t, 10));
  if (v.length !== 6 || v.some((x) => isNaN(x))) return null;
  return v as Extent;
}

function extentDims(extent: Extent): [number, number, number] {
  return [
    extent[1] - extent[0] + 1,
    extent[3] - extent[2] + 1,
    extent[5] - extent[4] + 1,
  ];
}

/** Throws (hard) or warns (diagnostic) on extents too large to preview. */
function guardStructuredSize(
  extent: Extent,
  diagnostics: MdpaDiagnostic[]
): void {
  const [nx, ny, nz] = extentDims(extent);
  const points = nx * ny * nz;
  if (points > MAX_STRUCTURED_POINTS) {
    throw new Error(
      `Structured grid too large to preview (${points.toLocaleString()} points).`
    );
  }
  if (points > WARN_STRUCTURED_POINTS) {
    diagnostics.push({
      line: 0,
      message: `Large structured grid (${points.toLocaleString()} points); preview may be slow.`,
    });
  }
}

/**
 * Emits the implicit cells of a structured extent: hexahedra for full 3D
 * extents, quads when one axis is collapsed, lines when two are, and a single
 * vertex for a lone point.  Node indexing: i + j*nx + k*nx*ny (VTK order).
 */
function addStructuredCells(
  staging: ModelStaging,
  extent: Extent,
  nodeOffset: number
): void {
  const [nx, ny, nz] = extentDims(extent);
  const idx = (i: number, j: number, k: number): number => i + j * nx + k * nx * ny;

  if (nx >= 2 && ny >= 2 && nz >= 2) {
    for (let k = 0; k + 1 < nz; k++) {
      for (let j = 0; j + 1 < ny; j++) {
        for (let i = 0; i + 1 < nx; i++) {
          staging.addCell(
            HEXAHEDRON,
            [
              idx(i, j, k), idx(i + 1, j, k), idx(i + 1, j + 1, k), idx(i, j + 1, k),
              idx(i, j, k + 1), idx(i + 1, j, k + 1), idx(i + 1, j + 1, k + 1), idx(i, j + 1, k + 1),
            ],
            nodeOffset
          );
        }
      }
    }
    return;
  }

  // 2D: exactly one collapsed axis
  const dims = [nx, ny, nz];
  const varying = [0, 1, 2].filter((a) => dims[a] >= 2);
  if (varying.length === 2) {
    const [a, b] = varying;
    const coord = (u: number, v: number): number => {
      const c = [0, 0, 0];
      c[a] = u;
      c[b] = v;
      return idx(c[0], c[1], c[2]);
    };
    for (let v = 0; v + 1 < dims[b]; v++) {
      for (let u = 0; u + 1 < dims[a]; u++) {
        staging.addCell(
          QUAD,
          [coord(u, v), coord(u + 1, v), coord(u + 1, v + 1), coord(u, v + 1)],
          nodeOffset
        );
      }
    }
    return;
  }

  if (varying.length === 1) {
    const a = varying[0];
    const coord = (u: number): number => {
      const c = [0, 0, 0];
      c[a] = u;
      return idx(c[0], c[1], c[2]);
    };
    for (let u = 0; u + 1 < dims[a]; u++) {
      staging.addCell(LINE, [coord(u), coord(u + 1)], nodeOffset);
    }
    return;
  }

  if (nx * ny * nz === 1) {
    staging.addCell(VERTEX, [0], nodeOffset);
  }
}

function buildImageData(file: VtkXmlFile, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const grid = findFirst(file.root, "ImageData");
  if (!grid) throw new Error("Missing <ImageData> element.");

  const parse3 = (s: string | undefined, fallback: number): [number, number, number] => {
    const v = (s ?? "").trim().split(/\s+/).map(Number);
    return [
      isNaN(v[0]) ? fallback : v[0],
      isNaN(v[1]) ? fallback : v[1],
      isNaN(v[2]) ? fallback : v[2],
    ];
  };
  const origin = parse3(grid.attrs.Origin, 0);
  const spacing = parse3(grid.attrs.Spacing, 1);
  if (grid.attrs.Direction) {
    const d = grid.attrs.Direction.trim().split(/\s+/).map(Number);
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (d.length === 9 && d.some((v, i) => Math.abs(v - identity[i]) > 1e-12)) {
      diagnostics.push({
        line: 0,
        message: "ImageData Direction matrix is not identity and is ignored.",
      });
    }
  }

  const staging = new ModelStaging();

  for (const piece of findAll(grid, "Piece")) {
    const extent = parseExtent(piece.attrs.Extent) ?? parseExtent(grid.attrs.WholeExtent);
    if (!extent) {
      diagnostics.push({ line: 0, message: "ImageData piece has no valid Extent; skipped." });
      continue;
    }
    guardStructuredSize(extent, diagnostics);
    const nodeOffset = staging.nodeCount;
    const [nx, ny, nz] = extentDims(extent);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          staging.coords.push(
            origin[0] + (extent[0] + i) * spacing[0],
            origin[1] + (extent[2] + j) * spacing[1],
            origin[2] + (extent[4] + k) * spacing[2]
          );
        }
      }
    }
    addStructuredCells(staging, extent, nodeOffset);
    addPieceFields(staging, piece, file, diagnostics);
  }

  return staging.finish(diagnostics);
}

function buildStructuredGrid(file: VtkXmlFile, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const grid = findFirst(file.root, "StructuredGrid");
  if (!grid) throw new Error("Missing <StructuredGrid> element.");

  const staging = new ModelStaging();

  for (const piece of findAll(grid, "Piece")) {
    const extent = parseExtent(piece.attrs.Extent) ?? parseExtent(grid.attrs.WholeExtent);
    if (!extent) {
      diagnostics.push({ line: 0, message: "StructuredGrid piece has no valid Extent; skipped." });
      continue;
    }
    guardStructuredSize(extent, diagnostics);
    const nodeOffset = staging.nodeCount;
    if (!addPiecePoints(staging, piece, file, diagnostics)) continue;
    addStructuredCells(staging, extent, nodeOffset);
    addPieceFields(staging, piece, file, diagnostics);
  }

  return staging.finish(diagnostics);
}

function buildRectilinearGrid(file: VtkXmlFile, diagnostics: MdpaDiagnostic[]): MdpaModel {
  const grid = findFirst(file.root, "RectilinearGrid");
  if (!grid) throw new Error("Missing <RectilinearGrid> element.");

  const staging = new ModelStaging();

  for (const piece of findAll(grid, "Piece")) {
    const extent = parseExtent(piece.attrs.Extent) ?? parseExtent(grid.attrs.WholeExtent);
    if (!extent) {
      diagnostics.push({ line: 0, message: "RectilinearGrid piece has no valid Extent; skipped." });
      continue;
    }
    guardStructuredSize(extent, diagnostics);
    const nodeOffset = staging.nodeCount;

    const coordsEl = findFirst(piece, "Coordinates");
    const axes = coordsEl ? findAll(coordsEl, "DataArray") : [];
    if (axes.length < 3) {
      diagnostics.push({
        line: 0,
        message: "RectilinearGrid piece is missing <Coordinates> arrays; skipped.",
      });
      continue;
    }
    const xs = decodeDataArray(axes[0], file, diagnostics);
    const ys = decodeDataArray(axes[1], file, diagnostics);
    const zs = decodeDataArray(axes[2], file, diagnostics);

    for (let k = 0; k < Math.max(zs.length, 1); k++) {
      for (let j = 0; j < Math.max(ys.length, 1); j++) {
        for (let i = 0; i < Math.max(xs.length, 1); i++) {
          staging.coords.push(xs[i] ?? 0, ys[j] ?? 0, zs[k] ?? 0);
        }
      }
    }
    addStructuredCells(staging, extent, nodeOffset);
    addPieceFields(staging, piece, file, diagnostics);
  }

  return staging.finish(diagnostics);
}
