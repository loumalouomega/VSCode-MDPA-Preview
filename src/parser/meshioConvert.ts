/**
 * Bridge between meshio++'s JS mesh object and this extension's MdpaModel.
 *
 * Pure module: no vscode / DOM / wasm imports, so the conversion logic is
 * Node-testable without instantiating the 1.3 MB WASM binary.  meshio.ts owns
 * the wasm and calls in here.
 */

import { buildBlocksFromOffsets, expandCellField, fieldFromTuples, finalizeModel } from "./modelBuilder";
import {
  MESHIO_TO_VTK_ORDER,
  MESHIO_TO_VTK_TYPE,
  VTK_TO_MESHIO_TYPE,
} from "./meshioFormats";
import { FieldData, MdpaDiagnostic, MdpaModel } from "./types";
import { buildCellLayout, cellFieldArray, pointFieldArray } from "./writers/writerCommon";

/** One homogeneous group of cells, as exchanged with the WASM boundary. */
export interface MeshioCellBlock {
  /** meshio++ cell type name, e.g. "triangle", "tetra10". */
  type: string;
  /** Flat, row-major, 0-based connectivity: numCells * nodesPerCell. */
  data: Int32Array;
  nodesPerCell: number;
}

/** A mesh as read from / written to `@meshioplusplus/wasm`. */
export interface MeshioMesh {
  /** Flat, row-major coordinates: numPoints * dim. */
  points: Float64Array;
  /** 2 or 3. */
  dim: number;
  cells: MeshioCellBlock[];
  /** name -> flat, row-major per-point data. */
  point_data?: Record<string, Float64Array>;
  /** name -> one flat array per cell block, positionally aligned with `cells`. */
  cell_data?: Record<string, Float64Array[]>;
  /** name -> scalar/small metadata arrays. */
  field_data?: Record<string, Float64Array>;
}

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
    const comps = Math.round(arr.length / nodeCount);
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
    // `arrays` is aligned with the ORIGINAL mesh.cells, so index it via `kept`
    // — a skipped block in the middle would otherwise shift every value.
    const flat: number[] = [];
    let comps = -1;
    let ok = true;
    for (const bi of kept) {
      const cb = mesh.cells[bi];
      const nCells = cb.nodesPerCell > 0 ? Math.floor(cb.data.length / cb.nodesPerCell) : 0;
      const a = arrays[bi];
      if (!a) {
        ok = false; // no array for a block that produced cells
        break;
      }
      if (nCells === 0) continue;
      const c = Math.round(a.length / nCells);
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
    fields.push(
      expandCellField(
        fieldFromTuples("Elemental", sanitizeVariable(name), comps, flat),
        expansion
      )
    );
  }

  const fdKeys = Object.keys(mesh.field_data ?? {});
  if (fdKeys.length > 0) {
    diagnostics.push({
      line: 0,
      message: `Dropped field_data (${fdKeys.join(", ")}) — no MdpaModel equivalent.`,
    });
  }

  return finalizeModel({ nodeCount, coords, blocks, fields, diagnostics });
}

/**
 * MdpaModel -> meshio++ Mesh.
 *
 * Reuses the writer layer: buildCellLayout already produces exactly meshio's
 * shape (one flat cell list, Elements -> Conditions -> Geometries, 0-based
 * node indices), and point/cellFieldArray build the positional value arrays.
 */
export function modelToMeshio(
  model: MdpaModel,
  diagnostics: MdpaDiagnostic[],
  opts: { dim?: 2 | 3 } = {}
): MeshioMesh {
  const layout = buildCellLayout(model, diagnostics);
  const dim = opts.dim ?? (model.is3D ? 3 : 2);

  const points = new Float64Array(model.nodeCount * dim);
  for (let i = 0; i < model.nodeCount; i++) {
    for (let k = 0; k < dim; k++) points[i * dim + k] = model.coords[i * 3 + k];
  }

  // Group the flat cell list by (vtkType, stride), first-seen order.
  const cells: MeshioCellBlock[] = [];
  /** Per emitted block: the flat cell indices it holds, so cell_data can be sliced. */
  const blockCellIdx: number[][] = [];
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
    const key = `${type}|${stride}`;
    let bi = byKey.get(key);
    if (bi === undefined) {
      bi = cells.length;
      byKey.set(key, bi);
      cells.push({ type, data: new Int32Array(0), nodesPerCell: stride });
      blockCellIdx.push([]);
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
  for (const f of model.fields) {
    if (f.kind !== "Nodal") continue;
    point_data[f.variable] = pointFieldArray(f, model);
  }

  const cell_data: Record<string, Float64Array[]> = {};
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
    cell_data[key] = blockCellIdx.map((idx) => {
      const out = new Float64Array(idx.length * f.components);
      for (let c = 0; c < idx.length; c++) {
        for (let k = 0; k < f.components; k++) {
          out[c * f.components + k] = flat[idx[c] * f.components + k];
        }
      }
      return out;
    });
  }

  return { points, dim, cells, point_data, cell_data };
}
