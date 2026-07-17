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
  /** Optional derived/auxiliary data (mesh size, …); never serialized. */
  derived?: DerivedMeshData;
}
