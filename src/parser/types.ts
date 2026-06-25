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
}
