// Type-only, so it is erased at compile time and no runtime cycle can form
// between the model and the parser that fills this slot (the same arrangement
// `operations.ts` uses for `OpRecord`/`opLabels.ts`).
import type { PropertySet } from "./propertiesParser";
import type { ConstraintBlock } from "./constraintsParser";

export type EntityKind = "Elements" | "Conditions" | "Geometries";

export interface EntityBlock {
  kind: EntityKind;
  name: string;
  vtkCellType?: number;
  count: number;
  stride: number;
  entityIds: Int32Array;
  propertyIds?: Int32Array;
  connectivity: Int32Array;
}

export interface SubModelPart {
  name: string;
  nodeIds: Int32Array;
  elementIds: Int32Array;
  conditionIds: Int32Array;
  geometryIds: Int32Array;
  constraintIds: Int32Array;
  path: string;
  children: SubModelPart[];
}

export interface MetaBlock {
  label: string;
  lineCount: number;
}

export type FieldBlockKind = "Nodal" | "Elemental" | "Conditional";

/**
 * What a field's numbers physically are (former roadmap item 12; see `fieldDimensions.ts`).
 * `exponents` follow OpenFOAM's order (kg, m, s, K, mol, A, cd). Plain JSON, never a Map:
 * it rides to the webview on `MdpaModel`.
 */
export interface FieldDimensions {
  exponents: number[];
  /** Gauge vs absolute, stated by whoever produced the field — never inferred from the units. */
  reference?: "gauge" | "absolute";
  /** Set on a field derived by `convertFieldUnits`: its source and the density it used. */
  convertedFrom?: { variable: string; density?: number; densityField?: string };
}

export interface FieldData {
  /** Source numeric category; unknown fields are not interpolated implicitly. */
  numericType?: "float" | "integer";
  /**
   * Physical dimensions when the source stated them (today: an OpenFOAM field file).
   * ABSENT MEANS UNKNOWN, never dimensionless.
   */
  dimensions?: FieldDimensions;
  kind: FieldBlockKind;
  variable: string;
  components: number; // 1 = scalar, 3 = vector
  ids: Int32Array;
  values: Float64Array; // row-major, length = ids.length * components
  fixed?: Uint8Array; // nodal is_fixed flag per record (NodalData only)
  /**
   * Webview only: set on a metadata-only field of a staged delivery. `ids` and
   * `values` are empty until the field is requested; the value is the row
   * count the full field will carry.
   */
  pendingRows?: number;
}

export interface MdpaDiagnostic {
  line: number;
  message: string;
}

/**
 * Auxiliary, computed-on-demand mesh data kept *off* `MdpaModel.fields` so it
 * never accidentally serializes to the .mdpa. Populated by `computeMeshSize`
 * (see `meshSize.ts`); future operations (e.g. an MMG remesh metric) can read
 * it. To persist these values into the mesh instead, use the
 * `writeMeshSizeFields` operation, which appends them to `fields`.
 */
export interface DerivedMeshData {
  /** Per-node size (Kratos NODAL_H): min distance to a node sharing an element. */
  nodalH?: FieldData;
  /** Per-element size: mean edge length (element characteristic length). */
  elementSize?: FieldData;
}

export interface MdpaModel {
  nodeCount: number;
  nodeIds: Int32Array;
  coords: Float32Array;
  blocks: EntityBlock[];
  subModelParts: SubModelPart[];
  meta: MetaBlock[];
  fields: FieldData[];
  diagnostics: MdpaDiagnostic[];
  is3D: boolean;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /**
   * Parsed `Begin Properties <id>` values, when the source was a `.mdpa` that
   * had any (see `propertiesParser.ts`).
   *
   * Deliberately **separate from `meta`**, which keeps only a label and a line
   * count and buries the id inside the label string. These are read-from-file
   * source data with their own id space — the one `EntityBlock.propertyIds`
   * points into — so they get a top-level slot of their own.
   *
   * Optional so the ~11 test files that build an `MdpaModel` literal, and every
   * non-mdpa parser, compile untouched. That has one trap worth knowing: an
   * operation that returns `{...model, …}` carries this for free, but one that
   * builds a *full literal* silently drops it with **no type error**. The rule
   * is "wherever `meta` goes, `properties` goes" — grep `meta: model.meta`.
   *
   * Plain JSON data, never a `Map`: this rides to the webview over
   * `postMessage`, and the screenshot harness re-serializes every message
   * through `JSON.stringify`, where a `Map` would become `{}`.
   */
  properties?: PropertySet[];
  /**
   * Parsed `Begin Constraints` blocks, one per SOURCE block, when the source was
   * a `.mdpa` that declared any (see `constraintsParser.ts`).
   *
   * Same optionality and the same trap as `properties` above — an operation
   * returning `{...model, …}` carries it for free, one building a full literal
   * drops it with no type error — but the rule for what to *do* with it is
   * sharper, because this is keyed twice: by NODE id (a constraint's master and
   * slave columns) and by its own CONSTRAINT id space, the one
   * `SubModelPart.constraintIds` points into. So a module that removes or
   * relabels nodes must **maintain or drop it, never merely carry it**; carrying
   * it unchanged past a node removal is what produces a file naming constraints
   * whose nodes are gone.
   *
   * Plain JSON, never a `Map`, for the reason stated on `properties`.
   */
  constraints?: ConstraintBlock[];
  /**
   * Global (scalar) variable SPECS, by output name — e.g. `max_h →
   * {variable: "h", kind: "Nodal", reduction: "max"}` (see `globalReduce.ts`).
   * Written by the `reduceField` op, read by every formula scope (field
   * calculator, remesh sizing, Variables rows).
   *
   * Specs only, never values: every scope-build recomputes from the current
   * fields, so carrying this past a value-changing op is always safe — a spec
   * whose source field is gone simply resolves to NaN and drops out of scope.
   * Same optionality and the same trap as `properties`/`constraints` above:
   * an operation returning `{...model, …}` carries it for free, one building
   * a full literal must add `globals: model.globals` explicitly — "wherever
   * `meta` goes, `globals` go".
   *
   * Plain JSON, never a `Map`, for the reason stated on `properties`.
   */
  globals?: Record<string, import("./globalReduce").GlobalSpec>;
  /**
   * Source-format metadata that has no home in the rest of the model: a
   * MED file's own mesh name/description/units (see `meshioConvert.ts`'s
   * `MeshioMedInfo` and `readMeshioModel`'s use of it in meshio.ts).
   * Reported by MCP `mesh_info`'s conditional `source` section.
   *
   * Unlike `properties`/`constraints`/`globals` above, this describes the
   * FILE AS READ, not the mesh being edited — it carries no entity/id-space
   * reference that a later op could make stale, so an ordinary `{...model,
   * …}` spread carrying it forward is harmless, but it is also not worth
   * maintaining: a builder that returns a full model literal (a remesh
   * rebuild, an extract, a merge) drops it on purpose rather than adding
   * `source: model.source` to every such site, since none of those results
   * is "the same file" any more.
   *
   * Plain JSON, never a `Map`, for the reason stated on `properties`.
   */
  source?: SourceMetadata;
  /**
   * The NURBS side channel the source file carried (meshio++ >= 16.42.0's
   * mfem info, 17.x's cad_json): the patches a NURBS mesh or CAD B-rep was
   * built from, kept beside the model so the IGA derive kinds
   * (`igaRefine`/`igaSample`, deriveMesh.ts) can run without re-reading the
   * file. Set only by the read (meshio.ts's `readModelWith`, which requests
   * `{info: true}` for the formats that carry one — `.cad.json`, `.step`/
   * `.igs` and an MFEM NURBS `.mesh`).
   *
   * LIVE DATA with a sharp rule, the inverse of `properties`' trap: it must be
   * DROPPED by every applied edit, never carried — a mesh an operation changed
   * is no longer the patches' sampling, which is exactly upstream's "refuses a
   * mesh moved or edited since" (the drop happens in one place,
   * operations.ts's `applyOpAsync`). The info itself holds typed arrays
   * (BigInt64Array control-point ids among them), so it survives a worker
   * crossing by structured clone but must NEVER reach `JSON.stringify` —
   * summaries report `format`/`patches`/`faces` only.
   */
  nurbs?: NurbsSideChannel;
  /**
   * The ORIGINAL polyhedral cells of a file whose polyhedra were decomposed into
   * tetrahedra on read (VTU `VTK_POLYHEDRON`, a meshio++ polyhedron block), so a
   * writer that can hold a polyhedron (today the native `.vtu` writer) may emit
   * the real cell instead of its fan. The model itself still holds only the
   * tetrahedra — everything else sees an ordinary tetrahedral mesh.
   *
   * LIVE DATA with the same sharp rule as `nurbs`: a mesh an operation changed
   * no longer matches these cells, so every applied edit that can move a node or
   * a cell id DROPS it (operations.ts's `applyOpAsync` keeps it only across
   * unscoped rigid/scale transforms and field-only ops). Plain typed arrays, so
   * it survives a worker crossing and is never JSON.stringify'd (`mesh_info`
   * reports counts only).
   */
  polyhedra?: PolyhedralTopology;
  /** Optional derived/auxiliary data (mesh size, …); never serialized. */
  derived?: DerivedMeshData;
}

/** See `MdpaModel.polyhedra`. All ids are model ids, not array indices. */
export interface PolyhedralTopology {
  /** Number of polyhedra. */
  count: number;
  /** Node ids of every face corner, face after face. */
  nodes: Int32Array;
  /** Face i spans `nodes[faceOffsets[i]..faceOffsets[i+1])`; length = faces + 1. */
  faceOffsets: Int32Array;
  /** Polyhedron p owns faces `cellOffsets[p]..cellOffsets[p+1]`; length = count + 1. */
  cellOffsets: Int32Array;
  /** Polyhedron p was decomposed into the Elements `childIds[childOffsets[p]..childOffsets[p+1])`. */
  childOffsets: Int32Array;
  childIds: Int32Array;
  /** Ids of the nodes the decomposition invented (a face centre, a cell centre). */
  apexNodeIds: Int32Array;
}

/** See `MdpaModel.nurbs`. */
export interface NurbsSideChannel {
  /** The side channel's own format: an MFEM NURBS mesh or a CAD JSON B-rep. */
  format: "mfem" | "cad_json";
  /** Patch count (both formats), for summaries that must not stringify the info. */
  patches: number;
  /** B-rep face count (cad_json only; an MFEM NURBS mesh has none). */
  faces: number;
  /**
   * The live meshio++ info object (upstream `MfemInfo | CadJsonInfo` shape).
   * Opaque here on purpose: meshio.ts's IGA ops consume it, nothing else
   * touches it.
   */
  info: object;
}

/** See `MdpaModel.source`. */
export interface SourceMetadata {
  format: string;
  meshName?: string;
  description?: string;
  units?: {
    coords?: string;
    time?: string;
    /** Field variable name -> its unit string. */
    fields?: Record<string, string>;
  };
  /**
   * OpenFOAM's own `boundary` dictionary `type` per patch, keyed by the
   * SubModelPart name `applyOpenFoamPatches` (openfoamCase.ts) gave it —
   * `type` has no other home on the model, since a SubModelPart carries no
   * per-part metadata slot. `openfoamWrite.ts` reads it back to keep a
   * keyless type (`patch`/`wall`/`empty`/`symmetry`/`symmetryPlane`)
   * instead of always writing `patch`; a type needing extra keys (e.g.
   * `cyclic`'s `neighbourPatch`) is downgraded to `patch` with a warning,
   * since this extension has nowhere to keep the extra keys either.
   *
   * `patchDictionaries` (former roadmap item 13, delivered 2026-10-19) is that missing home: the patch's
   * remaining statements (`neighbourPatch`, `transform`, `inGroups`, …) as
   * text, keyed identically. With it a non-keyless type is written back
   * whole; without it the downgrade above still applies.
   */
  openfoam?: {
    patchTypes: Record<string, string>;
    patchDictionaries?: Record<string, string>;
  };
}
