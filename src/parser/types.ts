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

export interface FieldData {
  kind: FieldBlockKind;
  variable: string;
  components: number; // 1 = scalar, 3 = vector
  ids: Int32Array;
  values: Float64Array; // row-major, length = ids.length * components
  fixed?: Uint8Array; // nodal is_fixed flag per record (NodalData only)
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
  /** Optional derived/auxiliary data (mesh size, …); never serialized. */
  derived?: DerivedMeshData;
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
}
