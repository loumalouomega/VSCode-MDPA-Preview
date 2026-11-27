//! WASM entry points for `mdpa-core` (Roadmap item 87).

pub mod constraints;
pub mod geometry_map;
pub mod metrics;
pub mod skin;
pub mod num_fmt;
pub mod parser;
pub mod properties;
pub mod types;
pub mod writer;

use wasm_bindgen::prelude::*;

use crate::parser::{MdpaParser, MdpaSummaryScanner, ParsedModel};
use crate::writer::{
    write_mdpa_bytes, WriteBlockData, WriteFieldData, WriteInput, WriteModelMeta,
};

/// Result of parsing an MDPA document. Holds typed arrays in WASM linear memory
/// until extracted via bulk-copy getters and freed.
#[wasm_bindgen]
pub struct WasmParsedMdpa {
    inner: ParsedModel,
}

#[wasm_bindgen]
impl WasmParsedMdpa {
    #[wasm_bindgen(js_name = metaJson)]
    pub fn meta_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.meta).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = nodeIds)]
    pub fn node_ids(&self) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.node_ids.as_slice())
    }

    #[wasm_bindgen(js_name = coords)]
    pub fn coords(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.inner.coords.as_slice())
    }

    #[wasm_bindgen(js_name = blockEntityIds)]
    pub fn block_entity_ids(&self, idx: usize) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.blocks[idx].entity_ids.as_slice())
    }

    #[wasm_bindgen(js_name = blockPropertyIds)]
    pub fn block_property_ids(&self, idx: usize) -> Option<js_sys::Int32Array> {
        self.inner.blocks[idx]
            .property_ids
            .as_ref()
            .map(|p| js_sys::Int32Array::from(p.as_slice()))
    }

    #[wasm_bindgen(js_name = blockConnectivity)]
    pub fn block_connectivity(&self, idx: usize) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.blocks[idx].connectivity.as_slice())
    }

    #[wasm_bindgen(js_name = fieldIds)]
    pub fn field_ids(&self, idx: usize) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.fields[idx].ids.as_slice())
    }

    #[wasm_bindgen(js_name = fieldValues)]
    pub fn field_values(&self, idx: usize) -> js_sys::Float64Array {
        js_sys::Float64Array::from(self.inner.fields[idx].values.as_slice())
    }

    #[wasm_bindgen(js_name = fieldFixed)]
    pub fn field_fixed(&self, idx: usize) -> Option<js_sys::Uint8Array> {
        self.inner.fields[idx]
            .fixed
            .as_ref()
            .map(|f| js_sys::Uint8Array::from(f.as_slice()))
    }

    #[wasm_bindgen(js_name = subpartIds)]
    pub fn subpart_ids(&self, flat_idx: usize) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.subpart_id_arrays[flat_idx].as_slice())
    }
}

/// Parse an entire UTF-8 MDPA buffer in one shot.
#[wasm_bindgen(js_name = parseMdpaBytes)]
pub fn parse_mdpa_bytes(bytes: &[u8]) -> WasmParsedMdpa {
    WasmParsedMdpa {
        inner: MdpaParser::parse_all_bytes(bytes),
    }
}

/// Streaming MDPA parser for `parseMdpaFile` (accepts raw UTF-8 byte chunks or lines).
#[wasm_bindgen]
pub struct WasmMdpaStreamParser {
    inner: Option<MdpaParser>,
}

#[wasm_bindgen]
impl WasmMdpaStreamParser {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Some(MdpaParser::new()),
        }
    }

    #[wasm_bindgen(js_name = feedChunk)]
    pub fn feed_chunk(&mut self, chunk: &[u8]) {
        if let Some(ref mut p) = self.inner {
            p.feed_chunk(chunk);
        }
    }

    #[wasm_bindgen(js_name = feedLine)]
    pub fn feed_line(&mut self, line: &str) {
        if let Some(ref mut p) = self.inner {
            p.feed_line_str(line);
        }
    }

    pub fn finish(&mut self) -> Result<WasmParsedMdpa, JsValue> {
        let p = self
            .inner
            .take()
            .ok_or_else(|| JsValue::from_str("parser already finished"))?;
        Ok(WasmParsedMdpa {
            inner: p.finish_stream(),
        })
    }
}

/// Streaming summary scanner (`MdpaSummaryScanner`).
#[wasm_bindgen]
pub struct WasmMdpaSummaryScanner {
    inner: Option<MdpaSummaryScanner>,
}

#[wasm_bindgen]
impl WasmMdpaSummaryScanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Some(MdpaSummaryScanner::new()),
        }
    }

    #[wasm_bindgen(js_name = feedChunk)]
    pub fn feed_chunk(&mut self, chunk: &[u8]) {
        if let Some(ref mut s) = self.inner {
            s.feed_chunk(chunk);
        }
    }

    #[wasm_bindgen(js_name = feedLine)]
    pub fn feed_line(&mut self, line: &str) {
        if let Some(ref mut s) = self.inner {
            s.feed_line_bytes(line.as_bytes());
        }
    }

    #[wasm_bindgen(js_name = finishJson)]
    pub fn finish_json(&mut self) -> Result<String, JsValue> {
        let s = self
            .inner
            .take()
            .ok_or_else(|| JsValue::from_str("scanner already finished"))?;
        serde_json::to_string(&s.finish()).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

/// Builder for serializing an `MdpaModel` to UTF-8 bytes without JSON-encoding numeric arrays.
#[wasm_bindgen]
pub struct WasmMdpaWriter {
    input: WriteInput,
}

#[wasm_bindgen]
impl WasmMdpaWriter {
    #[wasm_bindgen(constructor)]
    pub fn new(meta_json: &str) -> Result<WasmMdpaWriter, JsValue> {
        let meta: WriteModelMeta =
            serde_json::from_str(meta_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let blocks = Vec::with_capacity(meta.blocks.len());
        let fields = Vec::with_capacity(meta.fields.len());
        Ok(Self {
            input: WriteInput {
                meta,
                node_ids: Vec::new(),
                coords: Vec::new(),
                blocks,
                fields,
                subpart_id_arrays: Vec::new(),
            },
        })
    }

    #[wasm_bindgen(js_name = setNodes)]
    pub fn set_nodes(&mut self, node_ids: &[i32], coords: &[f32]) {
        self.input.node_ids = node_ids.to_vec();
        self.input.coords = coords.to_vec();
    }

    #[wasm_bindgen(js_name = addBlock)]
    pub fn add_block(
        &mut self,
        entity_ids: &[i32],
        property_ids: Option<Vec<i32>>,
        connectivity: &[i32],
    ) {
        self.input.blocks.push(WriteBlockData {
            entity_ids: entity_ids.to_vec(),
            property_ids,
            connectivity: connectivity.to_vec(),
        });
    }

    #[wasm_bindgen(js_name = addField)]
    pub fn add_field(&mut self, ids: &[i32], values: &[f64], fixed: Option<Vec<u8>>) {
        self.input.fields.push(WriteFieldData {
            ids: ids.to_vec(),
            values: values.to_vec(),
            fixed,
        });
    }

    #[wasm_bindgen(js_name = addSubpartIds)]
    pub fn add_subpart_ids(&mut self, ids: &[i32]) {
        self.input.subpart_id_arrays.push(ids.to_vec());
    }

    #[wasm_bindgen(js_name = buildBytes)]
    pub fn build_bytes(&self) -> js_sys::Uint8Array {
        let bytes = write_mdpa_bytes(&self.input);
        js_sys::Uint8Array::from(bytes.as_slice())
    }
}

/// Solver element-quality kernels (Phase 2). One node table, many blocks.
#[wasm_bindgen]
pub struct WasmMetricsMesh {
    inner: crate::metrics::MetricsMesh,
}

#[wasm_bindgen]
impl WasmMetricsMesh {
    #[wasm_bindgen(constructor)]
    pub fn new(node_ids: &[i32], coords: &[f32]) -> WasmMetricsMesh {
        WasmMetricsMesh { inner: crate::metrics::MetricsMesh::new(node_ids, coords) }
    }

    /// Six values per cell: scaledJacobian, skewness, warpage, taper, radiusRatio,
    /// measure. `NaN` = not applicable.
    #[wasm_bindgen(js_name = block)]
    #[allow(clippy::too_many_arguments)]
    pub fn block(
        &self,
        connectivity: &[i32],
        count: usize,
        stride: usize,
        shape_id: u32,
        need: usize,
        decomp_kind: u32,
        decomp: &[i32],
    ) -> js_sys::Float64Array {
        let v = self.inner.block(connectivity, count, stride, shape_id, need, decomp_kind, decomp);
        js_sys::Float64Array::from(v.as_slice())
    }
}

/// Boundary-skin extraction (roadmap item 87, Phase 2).
#[wasm_bindgen]
pub struct WasmSkinExtractor {
    inner: crate::skin::SkinExtractor,
}

#[wasm_bindgen]
impl WasmSkinExtractor {
    #[wasm_bindgen(constructor)]
    pub fn new(node_ids: &[i32]) -> WasmSkinExtractor {
        WasmSkinExtractor { inner: crate::skin::SkinExtractor::new(node_ids) }
    }

    #[wasm_bindgen(js_name = addSurfaceBlock)]
    pub fn add_surface_block(&mut self, vtk_type: u32, connectivity: &[i32], count: usize, stride: usize) {
        self.inner.add_surface_block(vtk_type, connectivity, count, stride);
    }

    #[wasm_bindgen(js_name = addVolumeBlock)]
    pub fn add_volume_block(&mut self, vtk_type: u32, connectivity: &[i32], count: usize, stride: usize) {
        self.inner.add_volume_block(vtk_type, connectivity, count, stride);
    }

    #[wasm_bindgen(js_name = finish)]
    pub fn finish(&mut self) -> usize {
        self.inner.finish()
    }

    #[wasm_bindgen(js_name = groupCount)]
    pub fn group_count(&self) -> usize {
        self.inner.group_count()
    }

    #[wasm_bindgen(js_name = groupVtkType)]
    pub fn group_vtk_type(&self, idx: usize) -> u32 {
        self.inner.group_vtk_type(idx)
    }

    #[wasm_bindgen(js_name = groupStride)]
    pub fn group_stride(&self, idx: usize) -> usize {
        self.inner.group_stride(idx)
    }

    #[wasm_bindgen(js_name = groupFaceCount)]
    pub fn group_face_count(&self, idx: usize) -> usize {
        self.inner.group_face_count(idx)
    }

    #[wasm_bindgen(js_name = groupEntityIds)]
    pub fn group_entity_ids(&self, idx: usize) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.group_entity_ids(idx))
    }

    #[wasm_bindgen(js_name = groupConnectivity)]
    pub fn group_connectivity(&self, idx: usize) -> js_sys::Int32Array {
        js_sys::Int32Array::from(self.inner.group_connectivity(idx))
    }
}
