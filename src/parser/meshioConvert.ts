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
import {
  decomposePolyhedronBlock,
  PolyhedronDecomposition,
} from "./polyhedronDecompose";
import { sliceFieldRows } from "./subModelPartExtract";
import { FieldData, MdpaDiagnostic, MdpaModel, SubModelPart, EntityBlock, EntityKind } from "./types";
import {
  buildCellLayout,
  CellCategory,
  cellCategory,
  CellLayout,
  cellFieldArray,
  nodeIndexMap,
  pointFieldArray, KIND_ORDER } from "./writers/writerCommon";
import {
  MESHIO_ID_KEY,
  MESHIO_KIND_KEY,
  MESHIO_PROPERTY_KEY,
  MESHIO_PART_PREFIX,
} from "./meshioFormats";
import {
  PropertySet,
  PropertyValue,
  PropertyTable,
  parsePropertyValue,
  formatPropertyValue,
} from "./propertiesParser";

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

/**
 * One data array as `@meshioplusplus/wasm` >= 11.2.0 may hand it over: every
 * floating-point dtype canonicalizes to `Float64Array`, every integer dtype
 * to `BigInt64Array` (elements are JS `bigint`, not `number`). A union of
 * concrete iterables (not a bare `ArrayLike`) so callers can iterate it.
 */
export type MeshioDataArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | BigUint64Array
  | number[]
  | bigint[];

/**
 * Copy a wasm data array into plain numbers. BigInt elements (the 11.2.0
 * integer canonicalization) cannot flow into `Float64Array.from`/`set` or
 * arithmetic — `ToNumber(bigint)` throws — so convert element-wise. Float
 * arrays pass through by reference; only integer arrays pay for a copy.
 */
export function meshioDataToNumbers(arr: MeshioDataArray): ArrayLike<number> {
  if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
    return Float64Array.from(arr as BigInt64Array, Number);
  }
  if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "bigint") {
    return (arr as unknown as bigint[]).map(Number);
  }
  return arr as ArrayLike<number>;
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
  point_data?: Record<string, MeshioDataArray>;
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
  cell_data?: Record<string, MeshioDataArray[]>;
  /**
   * Per-entity width of any non-scalar `cell_data` array: one value per
   * ARRAY, not per block — every block of a named array must agree on its
   * component count, which is meshio++'s own mesh-API invariant.
   */
  cell_data_components?: Record<string, number>;
  /** name -> scalar/small metadata arrays. */
  field_data?: Record<string, MeshioDataArray>;
  /** Per-entity width of any non-scalar `field_data` array. */
  field_data_components?: Record<string, number>;
  /**
   * Named groups of points / cells / cell facets (meshio++ >= 8.1.0): gmsh
   * physical groups, Abaqus `*NSET`/`*ELSET`/`*SURFACE`, MED families, …
   * Converted into SubModelParts by meshioRegions.ts.
   */
  regions?: MeshioRegion[];
  /**
   * `Begin Properties` blocks (Kratos material data), carried on the Mesh
   * object itself since meshio++ >= 9.2.0 rather than through a per-format
   * side channel — reachable through the generic registry, unlike a format's
   * `info`. Read into `MdpaModel.properties` by meshioToModel; emitted only
   * under `modelToMeshio`'s `opts.carriers` (see meshioFidelity.ts) — a plain
   * export never sets this, so a `.med`/`.inp` writer is never handed a slot
   * it may not know what to do with.
   */
  propertySets?: MeshioPropertySet[];
  /**
   * Format-specific side-channel metadata a generic Mesh cannot represent —
   * OpenFOAM patch names/types, MED field units, MDPA entity names, and so
   * on — attached by `readMeshSelective(path, {info: true})` and written back
   * via `writeMesh(path, mesh, format, {info})`. Only the OpenFOAM shape is
   * populated by this extension today (see openfoamCase.ts); the union
   * mirrors upstream's so the others slot in without a shape change.
   */
  info?: MeshioMeshInfo;
}

/**
 * One `KEY value` entry of an upstream PropertySet, mirroring
 * `@meshioplusplus/wasm`'s `PropertyValue`. Exactly one of `values`/`text`
 * carries the value: a plain number is a one-element `values`; an inline
 * `Begin Table` is an `(n, k)` `values` with `isTable` set and `key` holding
 * the table header's arguments verbatim; anything else (a constitutive-law
 * name, a bracketed vector/matrix) is kept verbatim in `text`.
 */
export interface MeshioPropertyValue {
  key: string;
  values: Float64Array;
  /** Per-entity width of `values` when `isTable` and `k > 1`. Absent means 1. */
  components?: number;
  /** The value verbatim, when it is not numeric (`values` is then empty). */
  text: string;
  isTable: boolean;
}

/** One `Begin Properties <id>` block, mirroring upstream's `PropertySet`. */
export interface MeshioPropertySet {
  id: number;
  values: MeshioPropertyValue[];
}

/**
 * `MdpaModel.properties` (`PropertySet[]`, propertiesParser.ts) <-> upstream's
 * mesh-level `propertySets` (`MeshioPropertySet[]`). Shared by the carry path
 * (`modelToMeshio`'s `opts.carriers`) and the plain read path (`meshioToModel`
 * reads `mesh.propertySets` unconditionally, for a format — MDPA-through-
 * meshio, or an adopted carry result — that actually declares one).
 *
 * A plain number round-trips through `values`; anything else (a verbatim
 * `CONSTITUTIVE_LAW` name, a Python-cased bool, a bracketed vector/matrix)
 * round-trips through upstream's own `text`, re-using the EXISTING
 * `formatPropertyValue`/`parsePropertyValue` ladder rather than a second
 * spelling of it.
 */
export function toUpstreamPropertySets(sets: readonly PropertySet[]): MeshioPropertySet[] {
  return sets.map((set) => {
    const values: MeshioPropertyValue[] = [];
    for (const key of Object.keys(set.variables)) {
      const v = set.variables[key];
      values.push(
        v.kind === "number"
          ? { key, values: Float64Array.from([v.value]), text: "", isTable: false }
          : { key, values: new Float64Array(0), text: formatPropertyValue(v), isTable: false }
      );
    }
    for (const t of set.tables) {
      const k = t.rows.length > 0 ? t.rows[0].length : undefined;
      values.push({
        key: t.args.join(" "),
        values: Float64Array.from(t.rows.flat()),
        components: k,
        text: "",
        isTable: true,
      });
    }
    return { id: set.id, values };
  });
}

export function fromUpstreamPropertySets(sets: readonly MeshioPropertySet[]): PropertySet[] {
  return sets.map((set) => {
    const variables: Record<string, PropertyValue> = Object.create(null);
    const tables: PropertyTable[] = [];
    for (const v of set.values) {
      if (v.isTable) {
        const k = v.components ?? 1;
        const rows: number[][] = [];
        for (let r = 0; r * k < v.values.length; r++) {
          rows.push(Array.from(v.values.slice(r * k, r * k + k)));
        }
        tables.push({ args: v.key.length > 0 ? v.key.split(/\s+/) : [], rows });
        continue;
      }
      if (v.values.length > 0) {
        variables[v.key] = { kind: "number", value: v.values[0] };
      } else if (v.text.length > 0) {
        variables[v.key] = parsePropertyValue(v.text);
      } else {
        variables[v.key] = { kind: "string", value: "" };
      }
    }
    return { id: set.id, variables, tables };
  });
}

/** OpenFOAM's `info` side channel: a patch's family id, name(s) and type. */
export interface MeshioOpenFoamInfo {
  format: "openfoam";
  patches: { familyId: number; names: string[]; type?: string }[];
}

/**
 * MED's `info` side channel (upstream `MedInfo`): family/group names, units
 * and per-field step/time metadata. `skippedConstructs`/`fieldUnits`/
 * `stepMeta` are populated only on a LENIENT read (upstream: "Lenient-mode
 * only") — the fields the strict reader either represents fully or throws
 * on, so there is nothing to report on a strict success; `meshName`/
 * `description`/`unitTime`/`unitCoords`/`fieldTimeValues` are filled either
 * way. `pointTags`/`cellTags`/`pointTagGroups`/`cellTagGroups` are the same
 * family-id bookkeeping `regionsToParts` already turns into SubModelParts
 * from `mesh.regions` — not re-read from here, since that would be a second,
 * possibly-diverging source of the same grouping.
 */
export interface MeshioMedInfo {
  format: "med";
  pointTags: Record<string, string[]>;
  cellTags: Record<string, string[]>;
  meshName: string;
  description: string;
  unitTime: string;
  unitCoords: string;
  pointTagGroups: Record<string, string>;
  cellTagGroups: Record<string, string>;
  skippedConstructs: string[];
  fieldUnits: Record<string, [string, string]>;
  stepMeta: Record<string, { ndt: number; nor: number; pdt: number }>;
  fieldTimeValues: Record<string, number[]>;
}

/**
 * The union of every format's `info` shape this extension knows about.
 * Upstream's own union additionally has `MdpaInfo`/`AnsysInfo`/`UnvInfo`/
 * `GmshInfo`/`ExodusInfo` — still out of scope, represented by the open
 * `{format: string}` fallback so a future addition is a union member, not a
 * shape change to `MeshioMesh.info`. MED joined the OpenFOAM shape at
 * roadmap item 3's "MED diagnostics" scope — see `readMeshioModel`'s use of
 * it in meshio.ts and `MdpaModel.source` in types.ts.
 */
export type MeshioMeshInfo = MeshioOpenFoamInfo | MeshioMedInfo | { format: string };

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
  const sourceNodeCount = Math.floor(mesh.points.length / dim);

  // Polyhedral blocks are decomposed into tetrahedra, which invents apex nodes
  // (see polyhedronDecompose.ts). Do that FIRST, so the coordinate array can be
  // sized once and the cell loop below only has to copy connectivity.
  const decompositions = new Map<number, PolyhedronDecomposition>();
  const addedCoords: number[] = [];
  const addedParents: number[][] = [];
  for (let bi = 0; bi < mesh.cells.length; bi++) {
    const cb = mesh.cells[bi];
    if (isRectangularCellBlock(cb) || !("cellOffsets" in cb)) continue;
    const d = decomposePolyhedronBlock(
      cb,
      mesh.points,
      dim,
      sourceNodeCount + addedParents.length
    );
    decompositions.set(bi, d);
    addedCoords.push(...d.addedPoints);
    addedParents.push(...d.addedParents);
  }
  const nodeCount = sourceNodeCount + addedParents.length;

  // Flat points -> interleaved xyz; z = 0 for 2D meshes.
  const coords = new Float32Array(nodeCount * 3);
  for (let i = 0; i < sourceNodeCount; i++) {
    coords[i * 3] = mesh.points[i * dim];
    coords[i * 3 + 1] = mesh.points[i * dim + 1];
    coords[i * 3 + 2] = dim === 3 ? mesh.points[i * dim + 2] : 0;
  }
  for (let i = 0; i < addedParents.length; i++) {
    const o = (sourceNodeCount + i) * 3;
    coords[o] = addedCoords[i * 3];
    coords[o + 1] = addedCoords[i * 3 + 1];
    coords[o + 2] = addedCoords[i * 3 + 2];
  }

  const types: number[] = [];
  const offsets: number[] = [];
  const conn: number[] = [];
  /** `${vtkCellType}|${stride}` -> meshio type name, to restore nice block names. */
  const names = new Map<string, string>();
  /** Indices into mesh.cells that produced cells (cell_data is aligned to mesh.cells). */
  const kept: number[] = [];
  /**
   * Flat cells produced per SOURCE row of each kept block, in the same order.
   * Every path but the polyhedral one pushes exactly one, but a decomposed
   * polyhedron pushes a whole fan — and `expansion` (which the region mapping
   * indexes by source row) counts FLAT cells, so the two are folded together
   * after buildBlocksFromOffsets.
   */
  const flatPerRow: number[] = [];

  for (let bi = 0; bi < mesh.cells.length; bi++) {
    const cb = mesh.cells[bi];
    if (!isRectangularCellBlock(cb)) {
      const rows = meshioBlockRowCount(cb);
      if ("rowOffsets" in cb) {
        // A 1-level ragged (polygon) block needs no decomposition at all: the
        // flat arrays below are already end-offset based, and
        // buildBlocksFromOffsets normalizes a POLYGON into triangles/quads/a
        // fan exactly as it does for a VTK PolyData polygon.
        const vtkPolygon = MESHIO_TO_VTK_TYPE.polygon;
        // Buffered, because `flatPerRow` may only gain this block's rows if the
        // block ends up in `kept` — an all-degenerate one is skipped entirely,
        // and leaving its rows behind would shift the fold for every block after.
        const perRow: number[] = [];
        let emitted = 0;
        for (let r = 0; r < rows; r++) {
          const start = cb.rowOffsets[r];
          const end = cb.rowOffsets[r + 1];
          if (end - start < 3) {
            perRow.push(0); // degenerate: no cell, but the row still exists
            continue;
          }
          for (let k = start; k < end; k++) conn.push(cb.data[k]);
          offsets.push(conn.length);
          types.push(vtkPolygon);
          perRow.push(1);
          emitted++;
        }
        if (emitted > 0) {
          for (const n of perRow) flatPerRow.push(n);
          kept.push(bi);
        } else {
          diagnostics.push({
            line: 0,
            message: `Ragged "${cb.type}" cell block (${rows} cell(s)): every row has fewer than 3 nodes; skipped.`,
          });
        }
        continue;
      }
      // A 2-level ragged (polyhedron) block: emit the tetrahedra computed above.
      const d = decompositions.get(bi);
      if (!d || d.tets.length === 0) {
        diagnostics.push({
          line: 0,
          message: `Polyhedral "${cb.type}" cell block (${rows} cell(s)) could not be decomposed; skipped.`,
        });
        continue;
      }
      const perRow = new Array<number>(rows).fill(0);
      for (let t = 0; t < d.tetRow.length; t++) perRow[d.tetRow[t]]++;
      for (let t = 0; t < d.tetRow.length; t++) {
        conn.push(d.tets[t * 4], d.tets[t * 4 + 1], d.tets[t * 4 + 2], d.tets[t * 4 + 3]);
        offsets.push(conn.length);
        types.push(MESHIO_TO_VTK_TYPE.tetra);
      }
      for (const n of perRow) flatPerRow.push(n);
      names.set(`${MESHIO_TO_VTK_TYPE.tetra}|4`, "tetra");
      kept.push(bi);
      diagnostics.push({
        line: 0,
        message:
          `Polyhedral "${cb.type}" cell block: ${rows} cell(s) decomposed into ` +
          `${d.tetRow.length} tetrahedra (${d.addedParents.length} apex node(s) added)` +
          (d.skippedRows > 0 ? `; ${d.skippedRows} cell(s) skipped as not closed` : "") +
          `. The original polyhedra are not preserved on export.`,
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
      flatPerRow.push(1);
    }
    names.set(`${vtk}|${stride}`, cb.type);
    kept.push(bi);
  }

  const { blocks, expansion: flatExpansion } = buildBlocksFromOffsets(
    types,
    offsets,
    conn,
    diagnostics
  );
  // Fold flat-cell counts back onto source rows, so `expansion` keeps meaning
  // "entities this SOURCE row became" — what regionsToParts indexes by.
  const expansion: number[] = [];
  for (let row = 0, flat = 0; row < flatPerRow.length; row++) {
    let total = 0;
    for (let k = 0; k < flatPerRow[row]; k++) total += flatExpansion[flat++] ?? 0;
    expansion.push(total);
  }
  for (const b of blocks) {
    const nice = names.get(`${b.vtkCellType}|${b.stride}`);
    if (nice) b.name = nice; // "triangle" reads better than "VtkCell_5"
  }

  const fields: FieldData[] = [];

  for (const [name, arr] of Object.entries(mesh.point_data ?? {})) {
    if (sourceNodeCount === 0) {
      diagnostics.push({
        line: 0,
        message: `Point data "${name}" dropped — the mesh has no points.`,
      });
      continue;
    }
    // The declared width wins when meshio++ gives one (>= 9.9.0, non-scalar
    // arrays only); dividing is still the answer for a scalar, which never
    // gets an entry, and for any array that predates the components maps.
    const comps =
      mesh.point_data_components?.[name] ?? Math.round(arr.length / sourceNodeCount);
    if (comps < 1 || comps * sourceNodeCount !== arr.length) {
      diagnostics.push({
        line: 0,
        message: `Point data "${name}" has ${arr.length} values for ${sourceNodeCount} nodes; skipped.`,
      });
      continue;
    }
    // ids 1..nodeCount match finalizeModel's synthesized nodeIds. An apex node
    // a polyhedral decomposition invented takes the mean of its generators —
    // the same rule refineMesh.ts uses for a node it created — so the field
    // stays defined on every node of the mesh the viewer actually draws.
    // Integer arrays arrive as BigInt64Array since meshio++ 11.2.0; convert
    // at the boundary since bigint poisons every Float64Array/arithmetic use.
    let values: ArrayLike<number> = meshioDataToNumbers(arr);
    if (addedParents.length > 0) {
      const extended = new Float64Array(comps * nodeCount);
      extended.set(values as ArrayLike<number>);
      for (let i = 0; i < addedParents.length; i++) {
        const parents = addedParents[i];
        const out = (sourceNodeCount + i) * comps;
        for (const p of parents) {
          // A parent may itself be an apex added earlier in the same pass.
          for (let c = 0; c < comps; c++) extended[out + c] += extended[p * comps + c];
        }
        for (let c = 0; c < comps; c++) extended[out + c] /= parents.length;
      }
      values = extended;
    }
    fields.push(fieldFromTuples("Nodal", sanitizeVariable(name), comps, values));
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
      // A ragged block can now be kept too (a polygon block, or a polyhedral
      // one that was decomposed), so the row count comes from the shape-aware
      // helper rather than from `nodesPerCell`. Its per-cell value is
      // replicated to whatever the row became by `expandCellField` below,
      // exactly as for a POLYGON that fanned into triangles.
      const cb = mesh.cells[bi];
      const nCells = meshioBlockRowCount(cb);
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
      // Integer blocks arrive as BigInt64Array since meshio++ 11.2.0 —
      // pushing a bigint into a number[] poisons Float64Array.from downstream.
      const nums = meshioDataToNumbers(a);
      for (let vi = 0; vi < nums.length; vi++) flat.push(nums[vi]);
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

  const model = finalizeModel({
    nodeCount,
    coords,
    blocks: [...blocks, ...conditionBlocks],
    fields,
    diagnostics,
    subModelParts,
  });
  // Read-path fidelity win: `mesh.propertySets` -> `model.properties`,
  // unconditionally (not gated on carriers) — a format that genuinely
  // declares mesh-level Properties (MDPA-through-meshio, or a carry result)
  // should not need an opt-in to be read back.
  if (mesh.propertySets && mesh.propertySets.length > 0) {
    return { ...model, properties: fromUpstreamPropertySets(mesh.propertySets) };
  }
  return model;
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
 * Lost BY DEFAULT, and the reason the mesh OPERATIONS in smoothMesh/
 * reorderMesh/partitionMesh (and five siblings — see `src/parser/
 * meshioAdapter.ts`) use meshio++ as an oracle instead of adopting its
 * returned mesh: `propertyIds`, the Elements/Conditions/Geometries kind of a
 * block, and every original entity id. **Since roadmap item 1, this is no
 * longer an absolute prohibition**: `opts.carriers` (below) emits `mdpa:id` /
 * `kratos:kind` / `gmsh:physical` point/cell data — the first and third are
 * upstream's OWN MDPA id/property-id conventions, the second is this
 * extension's own carrier for the distinction upstream only keeps in a
 * per-format side channel that does not survive an operation — plus
 * `propertySets`, a Mesh-level slot upstream itself carries through
 * shape-preserving operations. `src/parser/meshioFidelity.ts`'s
 * `adoptMeshioMesh` reconstructs a model from a carrier-enabled result,
 * reporting via `FidelityReport` exactly what could and could not be
 * retained. Carriers are OFF by default and never set by `writeMeshioBytes`
 * — an ordinary export must never carry these into a real file. No existing
 * oracle has been converted to adoption: the oracle design remains strictly
 * cheaper and provably safe for the eight operations that have one: adopt
 * exists to unblock the operations that do not (repair, decimate,
 * slice/isosurface-as-meshes, partition export, …).
 *
 * Kratos master/slave **constraints** are lost in both directions on a PLAIN
 * round trip, deliberately without a diagnostic: no other format has the
 * concept, so a warning would fire on every foreign import and say nothing
 * actionable. A read produces a model with no `constraints`, and a write has
 * none to emit — `mdpaWriter` reports the loss at the point where it can be
 * acted on. The carry/adopt path (above) DOES maintain constraints, through
 * the existing `constraintsParser.ts` maintenance helpers — see
 * `meshioFidelity.ts`.
 */
/**
 * The model's blocks in the order `modelToMeshio` emits them — 1:1 with the
 * returned `mesh.cells`.
 *
 * Lives here because this file DEFINES that correspondence. Three oracle
 * modules used to carry a byte-identical private copy of this walk and assign
 * the flattened wasm result with a running cursor, which was correct only while
 * the grouping happened to be 1:1 — and it silently was not for a model with
 * two same-named blocks.
 */
export function meshioBlockOrder(model: MdpaModel): EntityBlock[] {
  return KIND_ORDER.flatMap((kind) =>
    model.blocks.filter((b) => b.kind === kind && b.vtkCellType !== undefined)
  );
}

export function modelToMeshio(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  opts: {
    dim?: 2 | 3;
    exodusAttributes?: boolean;
    /**
     * Emit the fidelity-carrier arrays (`mdpa:id`/`kratos:kind`/
     * `gmsh:physical` point/cell data, `propertySets`) an operation's result
     * can be run back through `meshioFidelity.adoptMeshioMesh` — see that
     * module. **Off by default and never set by `writeMeshioBytes`**: an
     * ordinary export must never carry these into a real file, where they
     * would surface as bogus user-visible fields on a later read.
     */
    carriers?: boolean;
  } = {}
): MeshioMesh {
  const layout = buildCellLayout(model, diagnostics);
  const dim = opts.dim ?? (model.is3D ? 3 : 2);

  const points = new Float64Array(model.nodeCount * dim);
  for (let i = 0; i < model.nodeCount; i++) {
    for (let k = 0; k < dim; k++) points[i * dim + k] = model.coords[i * 3 + k];
  }

  // Group the flat cell list by SOURCE BLOCK IDENTITY, first-seen order. Keeping
  // each EntityBlock a block of its own is what makes the `Cell` region emitted
  // for it cover exactly one meshio block — Exodus's rule for recovering an
  // `eb_names` entry — and stops an `Elements` and a `Conditions` block sharing
  // a cell type from fusing. meshio++ has accepted several blocks of one type
  // since 9.8.0 (MED consolidates them itself on write).
  //
  // Keyed by `blockIndex`, not by name: two distinct blocks can share a name,
  // type and stride (mergeMesh appends the incoming mesh's blocks unrenamed),
  // and fusing those broke every consumer that walks `model.blocks` in
  // parallel — see meshioBlockOrder, which is that walk.
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
    const key = String(cell.blockIndex);
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

  const point_data: Record<string, MeshioDataArray> = {};
  const point_data_components: Record<string, number> = {};
  for (const f of model.fields) {
    if (f.kind !== "Nodal") continue;
    point_data[f.variable] = pointFieldArray(f, model);
    // A flat array carries no shape: without this, meshio++ sees (3n,1) where
    // an (n,3) vector was meant. Only non-scalars get an entry — absent means 1.
    if (f.components > 1) point_data_components[f.variable] = f.components;
  }

  const cell_data: Record<string, MeshioDataArray[]> = {};
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

    // A field that does not cover every cell of its kind is written with 0 in
    // the cells it does not cover — and `cellFieldArray`'s 0 is indistinguishable
    // from a real 0 on read.  The Exodus attribute path escapes this by
    // NaN-filling (which is what makes meshio++ omit an uncovered block
    // entirely), but that path is scalars-only: a vector is left unprefixed on
    // purpose, so a sparse VECTOR always takes the zero-fill branch no matter
    // the target format.  Say so rather than writing fabricated zeros silently.
    //
    // The test is `ids.length` against the id→cell map rather than the exact
    // covered set: `covered` is a Set sized with the mesh, and building one per
    // field on every export would cost real memory on a mesh where the array
    // build below is already the expensive part.  Since the covered cells are a
    // subset of the ids, a short id list is a definite gap, which is the case
    // that actually occurs (a field written for some blocks only).
    if (fill === 0) {
      const kindCells =
        f.kind === "Conditional" ? layout.conditionIdToCell.size : layout.elementIdToCell.size;
      if (kindCells > 0 && f.ids.length < kindCells) {
        diagnostics.push({
          line: 0,
          message:
            `Cell data "${key}" (${f.kind}) covers ${f.ids.length} of ${kindCells} ` +
            `${f.kind === "Conditional" ? "condition" : "element"}(s); the rest are written ` +
            `as 0, which cannot be told from a real 0 when the file is read back.`,
        });
      }
    }

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

  if (opts.carriers) {
    attachFidelityCarriers(model, layout, blockCellIdx, point_data, cell_data);
  }

  const mesh: MeshioMesh = {
    points,
    dim,
    cells,
    point_data,
    point_data_components,
    cell_data,
    cell_data_components,
    regions: buildRegions(model, layout, blockCellIdx, blockNames, diagnostics, opts.carriers),
  };
  if (opts.carriers && model.properties && model.properties.length > 0) {
    mesh.propertySets = toUpstreamPropertySets(model.properties);
  }
  return mesh;
}

/**
 * Attaches the fidelity-carrier arrays in place: `mdpa:id` (node ids, and
 * per-cell entity ids), `kratos:kind` (0/1/2 for Elements/Conditions/
 * Geometries) and `gmsh:physical` (propertyIds, upstream's own MDPA
 * convention for them). Every carrier is `BigInt64Array` — matching what
 * meshio++ 11.2.0 canonicalizes an integer array to on the way BACK, so
 * `adoptMeshioMesh` reads the identical shape whether the mesh never left the
 * process (this function) or made a round trip through the wasm boundary.
 */
function attachFidelityCarriers(
  model: MdpaModel,
  layout: CellLayout,
  blockCellIdx: number[][],
  point_data: Record<string, MeshioDataArray>,
  cell_data: Record<string, MeshioDataArray[]>
): void {
  point_data[MESHIO_ID_KEY] = BigInt64Array.from(model.nodeIds, (id) => BigInt(id));

  // Invert the three id->cell maps once: every laid-out cell belongs to
  // exactly one of them (buildCellLayout's own invariant).
  const cellKind = new Uint8Array(layout.cells.length).fill(255);
  const cellId = new Int32Array(layout.cells.length);
  const KIND_CODE: Record<EntityKind, 0 | 1 | 2> = { Elements: 0, Conditions: 1, Geometries: 2 };
  for (const [id, ci] of layout.elementIdToCell) {
    cellKind[ci] = KIND_CODE.Elements;
    cellId[ci] = id;
  }
  for (const [id, ci] of layout.conditionIdToCell) {
    cellKind[ci] = KIND_CODE.Conditions;
    cellId[ci] = id;
  }
  for (const [id, ci] of layout.geometryIdToCell) {
    cellKind[ci] = KIND_CODE.Geometries;
    cellId[ci] = id;
  }
  const propertyIdOf = (kind: EntityKind): Map<number, number> => {
    const m = new Map<number, number>();
    for (const b of model.blocks) {
      if (b.kind !== kind || !b.propertyIds) continue;
      for (let i = 0; i < b.entityIds.length; i++) m.set(b.entityIds[i], b.propertyIds[i]);
    }
    return m;
  };
  const propMaps: Record<0 | 1 | 2, Map<number, number>> = {
    0: propertyIdOf("Elements"),
    1: propertyIdOf("Conditions"),
    2: propertyIdOf("Geometries"),
  };

  cell_data[MESHIO_ID_KEY] = blockCellIdx.map((idx) =>
    BigInt64Array.from(idx, (ci) => BigInt(cellId[ci]))
  );
  cell_data[MESHIO_KIND_KEY] = blockCellIdx.map((idx) =>
    BigInt64Array.from(idx, (ci) => BigInt(cellKind[ci]))
  );
  cell_data[MESHIO_PROPERTY_KEY] = blockCellIdx.map((idx) =>
    BigInt64Array.from(idx, (ci) => {
      const kind = cellKind[ci] as 0 | 1 | 2;
      return BigInt(propMaps[kind]?.get(cellId[ci]) ?? 0);
    })
  );
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
  diagnostics: MdpaDiagnostic[],
  carriers?: boolean
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
    // A "/" would reach an HDF5 group name in MED, so a plain export uses the
    // dotted spelling Kratos itself uses for a nested model part. The carry
    // path (no file ever involved) instead prefixes with MESHIO_PART_PREFIX
    // and keeps "/" verbatim, which is what lets adoptMeshioMesh (a) tell a
    // part region apart from a block region (block names never contain ":"
    // — Kratos entity names are plain identifiers) and (b) recover the exact
    // nesting rather than guessing it back from dots, which a genuinely
    // dotted group name from a foreign file (see meshioToModel's
    // shouldNestRegions) could make ambiguous.
    const name = uniqueName(
      carriers ? `${MESHIO_PART_PREFIX}${part.path}` : part.path.replace(/\//g, ".")
    );
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
