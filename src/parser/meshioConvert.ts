/**
 * Bridge between meshio++'s JS mesh object and this extension's MdpaModel.
 *
 * Pure module: no vscode / DOM / wasm imports, so the conversion logic is
 * Node-testable without instantiating the 1.3 MB WASM binary.  meshio.ts owns
 * the wasm and calls in here.
 */

import { buildBlocksFromOffsets, expandCellField, fieldFromTuples, finalizeModel } from "./modelBuilder";
import {
  EXODUS_ATTRIBUTE_PREFIX,
  MESHIO_TO_VTK_ORDER,
  MESHIO_TO_VTK_TYPE,
  VTK_TO_MESHIO_TYPE,
} from "./meshioFormats";
import { MeshioRegion, regionsToParts } from "./meshioRegions";
import { sliceFieldRows } from "./subModelPartExtract";
import { FieldData, MdpaDiagnostic, MdpaModel, SubModelPart } from "./types";
import {
  buildCellLayout,
  CellCategory,
  cellCategory,
  CellLayout,
  cellFieldArray,
  nodeIndexMap,
  pointFieldArray,
} from "./writers/writerCommon";

/** One homogeneous, uniform-node-count group of cells. */
export interface MeshioCellBlock {
  /** meshio++ cell type name, e.g. "triangle", "tetra10". */
  type: string;
  /** Flat, row-major, 0-based connectivity: numCells * nodesPerCell. */
  data: Int32Array;
  nodesPerCell: number;
}

/**
 * A 1-level ragged (jagged polygon) group of cells: rows of varying node
 * count, so there is no single `nodesPerCell`.  `data` is every row's node
 * ids concatenated; `rowOffsets` is each cell's start index into `data`
 * (length numCells + 1).  Crosses the WASM boundary since meshio++ 8.7.0 —
 * previously rejected there outright with a JS error.
 */
export interface MeshioPolygonCellBlock {
  type: string; // "polygon" | "polygon2"
  data: Int32Array;
  rowOffsets: Int32Array;
}

/**
 * A 2-level ragged (polyhedron) group of cells: each cell is a list of
 * faces, each face a list of node ids.  `cellOffsets` is each cell's start
 * index into the face list (length numCells + 1).  Crosses the WASM boundary
 * since meshio++ 8.7.0, but no C++ format writer accepts one yet.
 */
export interface MeshioPolyhedronCellBlock {
  type: string;
  data: Int32Array;
  faceOffsets: Int32Array;
  cellOffsets: Int32Array;
}

/** A cell block as `@meshioplusplus/wasm` >= 8.7.0 may hand it over. */
export type MeshioAnyCellBlock =
  | MeshioCellBlock
  | MeshioPolygonCellBlock
  | MeshioPolyhedronCellBlock;

/** True for a uniform (fixed node-count) block; false for a ragged one. */
export function isRectangularCellBlock(
  cb: MeshioAnyCellBlock
): cb is MeshioCellBlock {
  return typeof (cb as MeshioCellBlock).nodesPerCell === "number";
}

/**
 * Cells in a block, whichever of the three shapes it is.  0 for a
 * degenerate rectangular block (nodesPerCell === 0).
 */
export function meshioBlockRowCount(cb: MeshioAnyCellBlock): number {
  if (isRectangularCellBlock(cb)) {
    return cb.nodesPerCell > 0 ? Math.floor(cb.data.length / cb.nodesPerCell) : 0;
  }
  const offsets =
    "rowOffsets" in cb ? cb.rowOffsets : (cb as MeshioPolyhedronCellBlock).cellOffsets;
  return Math.max(0, offsets.length - 1);
}

/** A mesh as read from / written to `@meshioplusplus/wasm`. */
export interface MeshioMesh {
  /** Flat, row-major coordinates: numPoints * dim. */
  points: Float64Array;
  /** 2 or 3. */
  dim: number;
  /**
   * Ragged (polygon/polyhedron) blocks may appear here since meshio++ 8.7.0.
   * meshioToModel diagnoses and skips them — this extension's mesh preview
   * has no ragged-cell rendering path — but must count their rows correctly
   * so a block's global cell index (which region entries are defined
   * against) isn't shifted for every block that follows it.
   */
  cells: MeshioAnyCellBlock[];
  /** name -> flat, row-major per-point data. */
  point_data?: Record<string, Float64Array>;
  /**
   * Per-entity width of any `point_data` array that is not a scalar
   * (meshio++ >= 9.9.0).  A flat typed array carries no shape, so without
   * this an (n,3) field re-enters C++ as (3n,1) — which is what used to make
   * MED reject its own output and every object-based meshio++ operation
   * silently pass a vector field through untouched.  A name ABSENT here has
   * one component, so a scalar-only mesh needs no entry at all; `readMesh`
   * likewise writes entries only for genuinely multi-component arrays.
   */
  point_data_components?: Record<string, number>;
  /** name -> one flat array per cell block, positionally aligned with `cells`. */
  cell_data?: Record<string, Float64Array[]>;
  /**
   * Per-entity width of any non-scalar `cell_data` array: one value per
   * ARRAY, not per block — every block of a named array must agree on its
   * component count, which is meshio++'s own mesh-API invariant.
   */
  cell_data_components?: Record<string, number>;
  /** name -> scalar/small metadata arrays. */
  field_data?: Record<string, Float64Array>;
  /** Per-entity width of any non-scalar `field_data` array. */
  field_data_components?: Record<string, number>;
  /**
   * Named groups of points / cells / cell facets (meshio++ >= 8.1.0): gmsh
   * physical groups, Abaqus `*NSET`/`*ELSET`/`*SURFACE`, MED families, …
   * Converted into SubModelParts by meshioRegions.ts.
   */
  regions?: MeshioRegion[];
}

/**
 * `field_data` keys that are format bookkeeping rather than user data, so they
 * are dropped silently instead of being reported.
 *
 * `exodus:time` is the time of the step the reader returned (meshio++ >= 9.9.0
 * sets it on EVERY Exodus read), so without this the "Dropped field_data"
 * diagnostic would fire for every Exodus file with something the user never
 * put there.
 */
const INTERNAL_FIELD_DATA_KEYS = new Set(["exodus:time"]);

/**
 * meshio field names may contain characters Kratos variables cannot
 * (gmsh injects "gmsh:physical", "gmsh:geometrical", "gmsh:dim_tags").
 * mdpaWriter emits `Begin ElementalData ${variable}` verbatim, so an
 * unsanitized name would produce an unparseable .mdpa.
 */
export function sanitizeVariable(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(clean) ? `_${clean}` : clean || "FIELD";
}

/**
 * Drop every tuple whose value is not finite, yielding a SPARSE field.
 *
 * meshio++ carries an Exodus per-element attribute as one `cell_data` array
 * spanning every block, filling NaN for the blocks that do not declare it — so
 * a file where only the SPHERE blocks have a RADIUS arrives mostly-NaN. Left
 * alone, that NaN becomes a real value: writerCommon's `num()` maps it to "0",
 * so a .mdpa or .vtu export would claim every non-sphere cell has radius 0.
 *
 * Filtering by VALUE rather than by block is what keeps this correct after
 * buildBlocksFromOffsets has merged several meshio blocks into one EntityBlock.
 * Every consumer downstream is already sparse-safe (fields are id-keyed).
 */
function dropNonFinite(field: FieldData): FieldData {
  const { components } = field;
  const rows: number[] = [];
  for (let i = 0; i < field.ids.length; i++) {
    let ok = true;
    for (let c = 0; c < components; c++) {
      if (!Number.isFinite(field.values[i * components + c])) {
        ok = false;
        break;
      }
    }
    if (ok) rows.push(i);
  }
  // The common case: nothing to drop, so keep the array identity.
  return rows.length === field.ids.length ? field : sliceFieldRows(field, rows);
}

/**
 * meshio++ Mesh -> MdpaModel.
 *
 * Cells are re-flattened into VTU-style (types, end-offsets, 0-based
 * connectivity) and handed to buildBlocksFromOffsets rather than being turned
 * into EntityBlocks directly: meshio's blocks are already homogeneous, but the
 * helper also normalizes `polygon` into triangles/quads, converts 0-based ->
 * 1-based, and — critically — returns the `expansion` map that is the only
 * correct way to keep cell_data aligned across that split.
 */
export function meshioToModel(
  mesh: MeshioMesh,
  diagnostics: MdpaDiagnostic[]
): MdpaModel {
  const dim = mesh.dim === 2 ? 2 : 3;
  const nodeCount = Math.floor(mesh.points.length / dim);

  // Flat points -> interleaved xyz; z = 0 for 2D meshes.
  const coords = new Float32Array(nodeCount * 3);
  for (let i = 0; i < nodeCount; i++) {
    coords[i * 3] = mesh.points[i * dim];
    coords[i * 3 + 1] = mesh.points[i * dim + 1];
    coords[i * 3 + 2] = dim === 3 ? mesh.points[i * dim + 2] : 0;
  }

  const types: number[] = [];
  const offsets: number[] = [];
  const conn: number[] = [];
  /** `${vtkCellType}|${stride}` -> meshio type name, to restore nice block names. */
  const names = new Map<string, string>();
  /** Indices into mesh.cells that produced cells (cell_data is aligned to mesh.cells). */
  const kept: number[] = [];

  for (let bi = 0; bi < mesh.cells.length; bi++) {
    const cb = mesh.cells[bi];
    if (!isRectangularCellBlock(cb)) {
      // Ragged (polygon/polyhedron) blocks cross the WASM boundary since
      // meshio++ 8.7.0, but this extension's mesh preview has no ragged-cell
      // rendering path.  Diagnose with an accurate count rather than silently
      // contributing zero cells — `nodesPerCell` is undefined here, so
      // treating this block as rectangular would compute nCells=0 and drop it
      // without a trace.  NOT added to `kept`: meshioRegions.ts's rowCount()
      // still counts its rows so later blocks' global cell indices don't shift.
      diagnostics.push({
        line: 0,
        message:
          `Ragged "${cb.type}" cell block (${meshioBlockRowCount(cb)} cell(s)) is not ` +
          `supported by this extension's mesh preview; skipped. Convert with ` +
          `meshio++'s convert_cells("simplexify") first to view it.`,
      });
      continue;
    }
    const stride = cb.nodesPerCell;
    const nCells = stride > 0 ? Math.floor(cb.data.length / stride) : 0;
    const vtk = MESHIO_TO_VTK_TYPE[cb.type];
    if (vtk === undefined) {
      diagnostics.push({
        line: 0,
        message: `Cell type "${cb.type}" has no VTK equivalent; ${nCells} cell(s) skipped.`,
      });
      continue;
    }
    const perm = MESHIO_TO_VTK_ORDER[cb.type];
    for (let c = 0; c < nCells; c++) {
      for (let k = 0; k < stride; k++) {
        // perm[k] = the meshio-order index belonging at VTK position k.
        conn.push(cb.data[c * stride + (perm ? perm[k] : k)]);
      }
      offsets.push(conn.length); // end-offsets
      types.push(vtk);
    }
    names.set(`${vtk}|${stride}`, cb.type);
    kept.push(bi);
  }

  const { blocks, expansion } = buildBlocksFromOffsets(types, offsets, conn, diagnostics);
  for (const b of blocks) {
    const nice = names.get(`${b.vtkCellType}|${b.stride}`);
    if (nice) b.name = nice; // "triangle" reads better than "VtkCell_5"
  }

  const fields: FieldData[] = [];

  for (const [name, arr] of Object.entries(mesh.point_data ?? {})) {
    if (nodeCount === 0) {
      diagnostics.push({
        line: 0,
        message: `Point data "${name}" dropped — the mesh has no points.`,
      });
      continue;
    }
    // The declared width wins when meshio++ gives one (>= 9.9.0, non-scalar
    // arrays only); dividing is still the answer for a scalar, which never
    // gets an entry, and for any array that predates the components maps.
    const comps = mesh.point_data_components?.[name] ?? Math.round(arr.length / nodeCount);
    if (comps < 1 || comps * nodeCount !== arr.length) {
      diagnostics.push({
        line: 0,
        message: `Point data "${name}" has ${arr.length} values for ${nodeCount} nodes; skipped.`,
      });
      continue;
    }
    // ids 1..nodeCount match finalizeModel's synthesized nodeIds.
    fields.push(fieldFromTuples("Nodal", sanitizeVariable(name), comps, arr));
  }

  for (const [name, arrays] of Object.entries(mesh.cell_data ?? {})) {
    // One declared width for the WHOLE array (meshio++ >= 9.9.0), not one per
    // block — so it is read outside the loop and each block is checked against
    // it. Absent (a scalar, or a pre-9.9.0 artifact) falls back to dividing.
    const declared = mesh.cell_data_components?.[name];
    // `arrays` is aligned with the ORIGINAL mesh.cells, so index it via `kept`
    // — a skipped block in the middle would otherwise shift every value.
    const flat: number[] = [];
    let comps = -1;
    let ok = true;
    for (const bi of kept) {
      // `kept` only ever holds rectangular blocks (ragged ones `continue`d
      // above before being pushed), so this narrows safely.
      const cb = mesh.cells[bi] as MeshioCellBlock;
      const nCells = cb.nodesPerCell > 0 ? Math.floor(cb.data.length / cb.nodesPerCell) : 0;
      const a = arrays[bi];
      if (!a) {
        ok = false; // no array for a block that produced cells
        break;
      }
      if (nCells === 0) continue;
      const c = declared ?? Math.round(a.length / nCells);
      if (c < 1 || c * nCells !== a.length) {
        ok = false; // ragged against its own block, or a bogus declared width
        break;
      }
      if (comps < 0) comps = c;
      else if (c !== comps) {
        ok = false;
        break;
      }
      for (const v of a) flat.push(v);
    }
    if (!ok || comps < 1) {
      diagnostics.push({
        line: 0,
        message: `Cell data "${name}" does not align with the cell blocks; skipped.`,
      });
      continue;
    }
    // Strip the Exodus per-element-attribute namespace, so a SPHERE's radius is
    // plainly RADIUS (also a real Kratos variable) rather than the unusable
    // exodus_attr_RADIUS sanitizeVariable would otherwise produce. The prefix
    // is re-applied only when writing Exodus — see `exodusAttributes` below.
    const bare = name.startsWith(EXODUS_ATTRIBUTE_PREFIX)
      ? name.slice(EXODUS_ATTRIBUTE_PREFIX.length)
      : name;
    const field = dropNonFinite(
      expandCellField(
        fieldFromTuples("Elemental", sanitizeVariable(bare), comps, flat),
        expansion
      )
    );
    if (field.ids.length === 0) {
      // Every value was NaN — an attribute no block in this file declares.
      // Keeping it would put a permanently empty entry in the field pickers.
      diagnostics.push({
        line: 0,
        message: `Cell data "${name}" has no finite values; skipped.`,
      });
      continue;
    }
    fields.push(field);
  }

  const fdKeys = Object.keys(mesh.field_data ?? {}).filter(
    (k) => !INTERNAL_FIELD_DATA_KEYS.has(k)
  );
  if (fdKeys.length > 0) {
    diagnostics.push({
      line: 0,
      message: `Dropped field_data (${fdKeys.join(", ")}) — no MdpaModel equivalent.`,
    });
  }

  // Named groups -> SubModelParts. Side regions also materialize their facets
  // as Conditions blocks, which is what makes an Abaqus *SURFACE (or an Exodus
  // side set) a visible, framable, exportable layer rather than an index list.
  const { subModelParts, conditionBlocks } = regionsToParts({
    regions: mesh.regions,
    cells: mesh.cells,
    kept,
    expansion,
    nodeCount,
    diagnostics,
  });

  return finalizeModel({
    nodeCount,
    coords,
    blocks: [...blocks, ...conditionBlocks],
    fields,
    diagnostics,
    subModelParts,
  });
}

/**
 * MdpaModel -> meshio++ Mesh.
 *
 * Reuses the writer layer: buildCellLayout already produces exactly meshio's
 * shape (one flat cell list, Elements -> Conditions -> Geometries, 0-based
 * node indices), and point/cellFieldArray build the positional value arrays.
 *
 * Three things beyond geometry cross the boundary, each needed by a format that
 * would otherwise silently lose it:
 *  - `*_data_components`, so a vector field keeps its shape (meshio++ >= 9.9.0);
 *  - `regions`, so block names and SubModelParts survive (see buildRegions);
 *  - the `exodus:attr:` namespace for scalar cell fields, when writing Exodus.
 *
 * Still lost, and the reason the mesh OPERATIONS in smoothMesh/reorderMesh/
 * partitionMesh use meshio++ as an oracle instead of adopting its returned
 * mesh: `propertyIds`, the Elements/Conditions/Geometries kind of a block, and
 * every original entity id.
 */
export function modelToMeshio(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  opts: { dim?: 2 | 3; exodusAttributes?: boolean } = {}
): MeshioMesh {
  const layout = buildCellLayout(model, diagnostics);
  const dim = opts.dim ?? (model.is3D ? 3 : 2);

  const points = new Float64Array(model.nodeCount * dim);
  for (let i = 0; i < model.nodeCount; i++) {
    for (let k = 0; k < dim; k++) points[i * dim + k] = model.coords[i * 3 + k];
  }

  // Group the flat cell list by (vtkType, stride, SOURCE BLOCK), first-seen
  // order. Including the source block is what keeps each EntityBlock a block of
  // its own on the way out, so the `Cell` region emitted for it covers exactly
  // one meshio block — Exodus's rule for recovering an `eb_names` entry. It
  // also stops an `Elements` and a `Conditions` block that happen to share a
  // cell type from being fused into one. meshio++ has accepted several blocks
  // of one type since 9.8.0 (MED consolidates them itself on write).
  const cells: MeshioCellBlock[] = [];
  /** Per emitted block: the flat cell indices it holds, so cell_data can be sliced. */
  const blockCellIdx: number[][] = [];
  /** Per emitted block: the source EntityBlock's name, for its `Cell` region. */
  const blockNames: string[] = [];
  const byKey = new Map<string, number>();
  const dropped = new Map<number, number>();

  for (let ci = 0; ci < layout.cells.length; ci++) {
    const cell = layout.cells[ci];
    const type = VTK_TO_MESHIO_TYPE[cell.type];
    if (type === undefined) {
      dropped.set(cell.type, (dropped.get(cell.type) ?? 0) + 1);
      continue;
    }
    const stride = cell.nodes.length;
    const key = `${type}|${stride}|${cell.blockName}`;
    let bi = byKey.get(key);
    if (bi === undefined) {
      bi = cells.length;
      byKey.set(key, bi);
      cells.push({ type, data: new Int32Array(0), nodesPerCell: stride });
      blockCellIdx.push([]);
      blockNames.push(cell.blockName);
    }
    blockCellIdx[bi].push(ci);
  }
  for (const [vtk, n] of dropped) {
    diagnostics.push({
      line: 0,
      message: `VTK cell type ${vtk} has no meshio++ equivalent; ${n} cell(s) skipped.`,
    });
  }

  // Fill connectivity, undoing the meshio<->VTK permutation.
  for (let bi = 0; bi < cells.length; bi++) {
    const block = cells[bi];
    const idx = blockCellIdx[bi];
    const stride = block.nodesPerCell;
    const data = new Int32Array(idx.length * stride);
    const perm = MESHIO_TO_VTK_ORDER[block.type];
    for (let c = 0; c < idx.length; c++) {
      const nodes = layout.cells[idx[c]].nodes;
      for (let k = 0; k < stride; k++) {
        // perm maps meshio -> VTK; writing back we invert it. [0,2,1,3,5,4] is
        // self-inverse, so perm[k] serves both directions.
        if (perm) data[c * stride + perm[k]] = nodes[k];
        else data[c * stride + k] = nodes[k];
      }
    }
    block.data = data;
  }

  const point_data: Record<string, Float64Array> = {};
  const point_data_components: Record<string, number> = {};
  for (const f of model.fields) {
    if (f.kind !== "Nodal") continue;
    point_data[f.variable] = pointFieldArray(f, model);
    // A flat array carries no shape: without this, meshio++ sees (3n,1) where
    // an (n,3) vector was meant. Only non-scalars get an entry — absent means 1.
    if (f.components > 1) point_data_components[f.variable] = f.components;
  }

  const cell_data: Record<string, Float64Array[]> = {};
  const cell_data_components: Record<string, number> = {};
  for (const f of model.fields) {
    if (f.kind === "Nodal") continue;
    const flat = cellFieldArray(f, layout);
    // Elemental and Conditional share meshio's single cell_data namespace.
    let key = f.variable;
    if (key in cell_data) {
      key = `${f.variable}_${f.kind}`;
      diagnostics.push({
        line: 0,
        message: `Cell data "${f.variable}" (${f.kind}) renamed to "${key}" to avoid a collision.`,
      });
    }

    // Exodus has two homes for a per-cell array and they mean different things:
    // `attrib{k}` per-element ATTRIBUTES (constant in time, one value per
    // element — where a particle RADIUS belongs, and reachable only through the
    // `exodus:attr:` namespace) and element VARIABLES (per time step, any
    // component count, written from ordinary cell_data since meshio++ 9.9.0).
    // So a scalar is prefixed into the attribute namespace and the cells it does
    // not cover are filled with NaN rather than cellFieldArray's 0 — NaN is what
    // makes meshio++ leave a block's attribute out entirely, which is what lets
    // a file where only some blocks carry a radius round-trip unchanged instead
    // of gaining a bogus all-zero attribute. A vector is left unprefixed on
    // purpose: an attribute cannot hold it (meshio++ raises rather than
    // truncating, since 9.9.0 tests the product of all trailing dimensions),
    // and as an element variable it survives whole. One caveat that stays
    // ours to know: meshio++ warn-and-skips an unprefixed cell_data array that
    // does not cover EVERY block, so a sparse vector field can still be lost.
    let fill = 0;
    if (opts.exodusAttributes && f.components === 1) {
      key = `${EXODUS_ATTRIBUTE_PREFIX}${key}`;
      fill = NaN;
    }
    if (f.components > 1) cell_data_components[key] = f.components;

    const covered = fill === 0 ? undefined : coveredCells(f, layout);
    cell_data[key] = blockCellIdx.map((idx) => {
      const out = new Float64Array(idx.length * f.components);
      for (let c = 0; c < idx.length; c++) {
        const has = covered ? covered.has(idx[c]) : true;
        for (let k = 0; k < f.components; k++) {
          out[c * f.components + k] = has ? flat[idx[c] * f.components + k] : fill;
        }
      }
      return out;
    });
  }

  return {
    points,
    dim,
    cells,
    point_data,
    point_data_components,
    cell_data,
    cell_data_components,
    regions: buildRegions(model, layout, blockCellIdx, blockNames, diagnostics),
  };
}

/**
 * The `Cell`/`Point` regions that carry this model's grouping out to the
 * formats that model one: MED families, Abaqus `*NSET`/`*ELSET`, and — since
 * meshio++ 9.9.0 — Exodus `eb_names`.  Without them an export replaces every
 * name with the reader's synthetic `Block N` and loses the SubModelParts.
 *
 * Two kinds are emitted:
 *  - one `cell` region per emitted block, named after its `EntityBlock`. This
 *    is the only one Exodus can use: its writer accepts a region whose entries
 *    are exactly one block's contiguous global range, which the (type, stride,
 *    block) grouping above guarantees.
 *  - one `cell` + one `point` region per SubModelPart (recursively), so the
 *    grouping survives to MED/Abaqus.
 *
 * Entries are global BLOCK-MAJOR cell indices — the same numbering the read
 * path (meshioRegions.ts) undoes — ascending and de-duplicated.  Names are
 * de-duplicated too (first wins, later ones get `_2`…): several formats key
 * their groups by name and would otherwise merge two unrelated ones.
 *
 * Not expressible, deliberately: `Side` regions (nothing here describes a
 * facet group; the read path materializes those as real Conditions blocks
 * instead) and a format-native `tag` (a Kratos SubModelPart has no integer id).
 */
function buildRegions(
  model: MdpaModel,
  layout: CellLayout,
  blockCellIdx: number[][],
  blockNames: string[],
  diagnostics: MdpaDiagnostic[]
): MeshioRegion[] {
  // flat cell index -> global block-major index in the emitted blocks.
  const globalOf = new Map<number, number>();
  let base = 0;
  for (const idx of blockCellIdx) {
    for (let c = 0; c < idx.length; c++) globalOf.set(idx[c], base + c);
    base += idx.length;
  }

  const regions: MeshioRegion[] = [];
  const used = new Set<string>();
  const uniqueName = (name: string): string => {
    let out = name;
    for (let n = 2; used.has(out); n++) out = `${name}_${n}`;
    used.add(out);
    return out;
  };
  // Upstream canonicalizes an added region this way too; doing it here keeps a
  // duplicated id in a hand-written SubModelPart from becoming a duplicate
  // entry, and makes the emitted regions deterministic for the tests.
  const canonical = (values: readonly number[]): Int32Array =>
    Int32Array.from([...new Set(values)].sort((a, b) => a - b));

  for (let bi = 0; bi < blockCellIdx.length; bi++) {
    if (blockCellIdx[bi].length === 0) continue;
    regions.push({
      name: uniqueName(blockNames[bi]),
      kind: "cell",
      dim: cellRegionDim(blockCellIdx[bi], layout),
      tag: -1,
      entries: canonical(blockCellIdx[bi].map((ci) => globalOf.get(ci) as number)),
    });
  }

  const nodeIndex = nodeIndexMap(model);
  const walk = (part: SubModelPart): void => {
    // A "/" would reach an HDF5 group name in MED, so the nesting separator is
    // the dotted spelling Kratos itself uses for a nested model part.
    const name = uniqueName(part.path.replace(/\//g, "."));
    const cellIdx: number[] = [];
    for (const [ids, map] of [
      [part.elementIds, layout.elementIdToCell],
      [part.conditionIds, layout.conditionIdToCell],
      [part.geometryIds, layout.geometryIdToCell],
    ] as const) {
      for (const id of ids) {
        const ci = map.get(id);
        // An id whose cell was skipped (unknown VTK type, dangling node) has no
        // global index, so it simply cannot be named — dropping it is the only
        // option that keeps the remaining entries pointing at the right cells.
        if (ci !== undefined && globalOf.has(ci)) cellIdx.push(ci);
      }
    }
    const pointEntries: number[] = [];
    for (const id of part.nodeIds) {
      const i = nodeIndex.get(id);
      if (i !== undefined) pointEntries.push(i);
    }
    if (cellIdx.length > 0) {
      regions.push({
        name,
        kind: "cell",
        dim: cellRegionDim(cellIdx, layout),
        tag: -1,
        entries: canonical(cellIdx.map((ci) => globalOf.get(ci) as number)),
      });
    }
    if (pointEntries.length > 0) {
      // Same name as the part's cell region on purpose: a format that keys its
      // groups by name (MED, Abaqus) treats the pair as one group, and the read
      // path already merges same-named regions back into a single part.
      regions.push({
        name,
        kind: "point",
        dim: 0,
        tag: -1,
        entries: canonical(pointEntries),
      });
    }
    if (cellIdx.length === 0 && pointEntries.length === 0) {
      diagnostics.push({
        line: 0,
        message: `SubModelPart "${part.path}" holds no writable entity; no named group emitted.`,
      });
    }
    for (const child of part.children) walk(child);
  };
  for (const part of model.subModelParts) walk(part);

  return regions;
}

/**
 * The topological dimension a `cell` region declares: 3/2/1/0 when every cell
 * agrees, else -1 ("the format does not say").  gmsh is the consumer that
 * cares — a physical group is per-dimension there.
 */
function cellRegionDim(cellIdx: readonly number[], layout: CellLayout): number {
  let dim = -1;
  for (const ci of cellIdx) {
    const d = CELL_CATEGORY_DIM[cellCategory(layout.cells[ci].type)];
    if (dim === -1) dim = d;
    else if (dim !== d) return -1;
  }
  return dim;
}

const CELL_CATEGORY_DIM: Record<CellCategory, number> = {
  volume: 3,
  surface: 2,
  line: 1,
  point: 0,
  unknown: -1,
};

/**
 * The flat cell indices a (sparse) cell field actually has a value for.
 *
 * cellFieldArray returns a dense array with 0 where the field is silent, which
 * is indistinguishable from a real 0. Callers that must tell the two apart —
 * only the Exodus attribute path, so far — use this alongside it.
 */
function coveredCells(field: FieldData, layout: CellLayout): Set<number> {
  const map = field.kind === "Conditional" ? layout.conditionIdToCell : layout.elementIdToCell;
  const out = new Set<number>();
  for (const id of field.ids) {
    const cell = map.get(id);
    if (cell !== undefined) out.add(cell);
  }
  return out;
}
