//! Serializable metadata structures exchanged across the WASM boundary.
//! Large numeric arrays (nodeIds, coords, connectivity, field values, subpart IDs)
//! are NEVER serialized through JSON — they cross as bulk-copied TypedArrays.

use serde::{Deserialize, Serialize};

use crate::constraints::ConstraintBlock;
use crate::properties::PropertySet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetaBlock {
    pub label: String,
    #[serde(rename = "lineCount")]
    pub line_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MdpaDiagnostic {
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundsMeta {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockMeta {
    pub kind: String,
    pub name: String,
    #[serde(rename = "vtkCellType", skip_serializing_if = "Option::is_none")]
    pub vtk_cell_type: Option<u32>,
    pub count: usize,
    pub stride: usize,
    #[serde(rename = "hasPropertyIds")]
    pub has_property_ids: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldMeta {
    pub kind: String,
    pub variable: String,
    pub components: usize,
    #[serde(rename = "hasFixed")]
    pub has_fixed: bool,
}

/// Tree node for a SubModelPart; the 5 ID arrays are referenced by index into
/// the flat `subpart_id_arrays` vector on `ParsedMdpa` / `MdpaWriterBuilder`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubModelPartMeta {
    pub name: String,
    pub path: String,
    #[serde(rename = "nodeIdsIdx")]
    pub node_ids_idx: usize,
    #[serde(rename = "elementIdsIdx")]
    pub element_ids_idx: usize,
    #[serde(rename = "conditionIdsIdx")]
    pub condition_ids_idx: usize,
    #[serde(rename = "geometryIdsIdx")]
    pub geometry_ids_idx: usize,
    #[serde(rename = "constraintIdsIdx")]
    pub constraint_ids_idx: usize,
    pub children: Vec<SubModelPartMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedModelMeta {
    #[serde(rename = "nodeCount")]
    pub node_count: usize,
    pub blocks: Vec<BlockMeta>,
    #[serde(rename = "subModelParts")]
    pub sub_model_parts: Vec<SubModelPartMeta>,
    pub meta: Vec<MetaBlock>,
    pub fields: Vec<FieldMeta>,
    pub diagnostics: Vec<MdpaDiagnostic>,
    #[serde(rename = "is3D")]
    pub is_3d: bool,
    pub bounds: BoundsMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<Vec<PropertySet>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Vec<ConstraintBlock>>,
}

// ---- Summary scanner result ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MdpaScanBlock {
    pub kind: String,
    pub name: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MdpaScanPartCounts {
    #[serde(rename = "nodeIds", skip_serializing_if = "Option::is_none")]
    pub node_ids: Option<usize>,
    #[serde(rename = "elementIds", skip_serializing_if = "Option::is_none")]
    pub element_ids: Option<usize>,
    #[serde(rename = "conditionIds", skip_serializing_if = "Option::is_none")]
    pub condition_ids: Option<usize>,
    #[serde(rename = "geometryIds", skip_serializing_if = "Option::is_none")]
    pub geometry_ids: Option<usize>,
    #[serde(rename = "constraintIds", skip_serializing_if = "Option::is_none")]
    pub constraint_ids: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MdpaScanPart {
    pub path: String,
    pub counts: MdpaScanPartCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MdpaScanField {
    pub kind: String,
    pub variable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MdpaScanResult {
    #[serde(rename = "nodeCount")]
    pub node_count: usize,
    pub blocks: Vec<MdpaScanBlock>,
    pub parts: Vec<MdpaScanPart>,
    pub fields: Vec<MdpaScanField>,
    #[serde(rename = "propertyIds")]
    pub property_ids: Vec<i32>,
    #[serde(rename = "constraintBlocks")]
    pub constraint_blocks: Vec<String>,
    pub diagnostics: Vec<MdpaDiagnostic>,
}
