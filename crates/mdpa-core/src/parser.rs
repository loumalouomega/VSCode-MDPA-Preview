//! High-speed streaming MDPA parser and summary scanner matching `src/parser/mdpaParser.ts`.

use std::collections::{HashMap, HashSet};

use crate::constraints::{parse_constraint_row, ConstraintBlock};
use crate::geometry_map::{decode_type_name, EntityKind};
use crate::num_fmt::{parse_f64_token, parse_i32_token, parse_strict_i32, trim_ascii_bytes};
use crate::properties::{add_property_line, PropertySet, PropertyTable};
use crate::types::{
    BlockMeta, BoundsMeta, FieldMeta, MdpaDiagnostic, MdpaScanBlock, MdpaScanField, MdpaScanPart,
    MdpaScanPartCounts, MdpaScanResult, MetaBlock, ParsedModelMeta, SubModelPartMeta,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubListKey {
    NodeIds,
    ElementIds,
    ConditionIds,
    GeometryIds,
    ConstraintIds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldBlockKind {
    Nodal,
    Elemental,
    Conditional,
}

impl FieldBlockKind {
    fn as_str(self) -> &'static str {
        match self {
            FieldBlockKind::Nodal => "Nodal",
            FieldBlockKind::Elemental => "Elemental",
            FieldBlockKind::Conditional => "Conditional",
        }
    }
}

pub struct ParsedBlock {
    pub kind: EntityKind,
    pub name: String,
    pub vtk_cell_type: Option<u32>,
    pub stride: usize,
    pub entity_ids: Vec<i32>,
    pub property_ids: Option<Vec<i32>>,
    pub connectivity: Vec<i32>,
}

struct StagingField {
    kind: FieldBlockKind,
    variable: String,
    ids: Vec<i32>,
    /// Flat row values; `row_lens[i]` gives the length of row `i`.
    flat_values: Vec<f64>,
    row_lens: Vec<u32>,
    max_components: usize,
    fixed: Vec<u8>,
    is_nodal: bool,
}

pub struct ParsedField {
    pub kind: &'static str,
    pub variable: String,
    pub components: usize,
    pub ids: Vec<i32>,
    pub values: Vec<f64>,
    pub fixed: Option<Vec<u8>>,
}

struct StagingSubModelPart {
    name: String,
    path: String,
    node_ids: Vec<i32>,
    element_ids: Vec<i32>,
    condition_ids: Vec<i32>,
    geometry_ids: Vec<i32>,
    constraint_ids: Vec<i32>,
    children: Vec<usize>, // indices into `all_subparts`
}

enum FrameKind {
    Unknown,
    Nodes,
    Block(usize),
    SubModelPart(usize),
    ListTarget { part_idx: usize, key: SubListKey },
    Field { meta_idx: usize, field_idx: usize },
    Constraints { meta_idx: usize, constraint_idx: usize },
    Properties { meta_idx: usize, prop_idx: Option<usize> },
    PropNested { prop_idx: Option<usize>, table_idx: Option<usize> },
    Meta(usize),
    Ignored,
}

struct Frame {
    block_type: String,
    kind: FrameKind,
}

pub struct ParsedModel {
    pub meta: ParsedModelMeta,
    pub node_ids: Vec<i32>,
    pub coords: Vec<f32>,
    pub blocks: Vec<ParsedBlock>,
    pub fields: Vec<ParsedField>,
    pub subpart_id_arrays: Vec<Vec<i32>>,
}

fn entity_kind(s: &str) -> Option<EntityKind> {
    match s {
        "Elements" => Some(EntityKind::Elements),
        "Conditions" => Some(EntityKind::Conditions),
        "Geometries" => Some(EntityKind::Geometries),
        _ => None,
    }
}

fn sublist_key(s: &str) -> Option<SubListKey> {
    match s {
        "SubModelPartNodes" => Some(SubListKey::NodeIds),
        "SubModelPartElements" => Some(SubListKey::ElementIds),
        "SubModelPartConditions" => Some(SubListKey::ConditionIds),
        "SubModelPartGeometries" => Some(SubListKey::GeometryIds),
        "SubModelPartConstraints" => Some(SubListKey::ConstraintIds),
        _ => None,
    }
}

fn field_kind(s: &str) -> Option<FieldBlockKind> {
    match s {
        "NodalData" => Some(FieldBlockKind::Nodal),
        "ElementalData" => Some(FieldBlockKind::Elemental),
        "ConditionalData" => Some(FieldBlockKind::Conditional),
        _ => None,
    }
}

fn is_meta_type(s: &str) -> bool {
    matches!(
        s,
        "ModelPartData"
            | "Properties"
            | "Table"
            | "NodalData"
            | "ElementalData"
            | "ConditionalData"
            | "Constraints"
            | "Mesh"
            | "MeshData"
            | "MeshNodes"
            | "MeshElements"
            | "MeshConditions"
            | "SubModelPartData"
            | "SubModelPartTables"
            | "SubModelPartProperties"
    )
}

/// Strip `//` comment from raw line bytes.
#[inline]
fn strip_comment_bytes(line: &[u8]) -> &[u8] {
    let mut i = 0;
    let len = line.len();
    while i + 1 < len {
        if line[i] == b'/' && line[i + 1] == b'/' {
            return &line[..i];
        }
        i += 1;
    }
    line
}

/// Iterator over ASCII-whitespace-separated tokens in a byte slice.
#[inline]
fn next_token<'a>(slice: &mut &'a [u8]) -> Option<&'a [u8]> {
    let b = *slice;
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= b.len() {
        *slice = &[];
        return None;
    }
    let start = i;
    while i < b.len() && !b[i].is_ascii_whitespace() {
        i += 1;
    }
    *slice = &b[i..];
    Some(&b[start..i])
}

pub struct MdpaParser {
    line_no: usize,
    node_ids: Vec<i32>,
    coords: Vec<f32>,
    block_index: HashMap<(EntityKind, String), usize>,
    blocks: Vec<ParsedBlock>,
    all_subparts: Vec<StagingSubModelPart>,
    root_subparts: Vec<usize>,
    meta: Vec<MetaBlock>,
    properties: Vec<PropertySet>,
    constraint_blocks: Vec<ConstraintBlock>,
    staging_fields: Vec<StagingField>,
    diagnostics: Vec<MdpaDiagnostic>,
    stack: Vec<Frame>,
    pending: Vec<u8>,
}

impl MdpaParser {
    pub fn new() -> Self {
        Self {
            line_no: 0,
            node_ids: Vec::new(),
            coords: Vec::new(),
            block_index: HashMap::new(),
            blocks: Vec::new(),
            all_subparts: Vec::new(),
            root_subparts: Vec::new(),
            meta: Vec::new(),
            properties: Vec::new(),
            constraint_blocks: Vec::new(),
            staging_fields: Vec::new(),
            diagnostics: Vec::new(),
            stack: Vec::new(),
            pending: Vec::new(),
        }
    }

    /// Feed a raw UTF-8 byte chunk (streaming). Lines split across chunks are buffered.
    pub fn feed_chunk(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let mut start = 0usize;
        if !self.pending.is_empty() {
            if let Some(nl) = chunk.iter().position(|&b| b == b'\n') {
                self.pending.extend_from_slice(&chunk[..nl]);
                let mut line = std::mem::take(&mut self.pending);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.feed_line_bytes(&line);
                // Reclaim allocation without freeing
                line.clear();
                self.pending = line;
                start = nl + 1;
            } else {
                self.pending.extend_from_slice(chunk);
                return;
            }
        }

        let rest = &chunk[start..];
        let mut line_start = 0usize;
        for (i, &b) in rest.iter().enumerate() {
            if b == b'\n' {
                let mut line = &rest[line_start..i];
                if line.last() == Some(&b'\r') {
                    line = &line[..line.len() - 1];
                }
                self.feed_line_bytes(line);
                line_start = i + 1;
            }
        }
        if line_start < rest.len() {
            self.pending.extend_from_slice(&rest[line_start..]);
        }
    }

    /// Parse a complete buffer in one shot (matches `text.split(/\r?\n/)` line numbering).
    pub fn parse_all_bytes(bytes: &[u8]) -> ParsedModel {
        let mut parser = Self::new();
        // Estimate capacities from file size to minimize Vec reallocations on large meshes
        let est_lines = bytes.len() / 36;
        if est_lines > 4096 {
            parser.node_ids.reserve(est_lines / 4);
            parser.coords.reserve((est_lines / 4) * 3);
        }

        let mut line_start = 0usize;
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                let mut line = &bytes[line_start..i];
                if line.last() == Some(&b'\r') {
                    line = &line[..line.len() - 1];
                }
                parser.feed_line_bytes(line);
                line_start = i + 1;
            }
        }
        // Always process the trailing slice after the last '\n' (matches `text.split(/\r?\n/)`)
        let mut tail = &bytes[line_start..];
        if tail.last() == Some(&b'\r') {
            tail = &tail[..tail.len() - 1];
        }
        parser.feed_line_bytes(tail);

        parser.finish_internal()
    }

    /// Finish a streamed parse (flushes any remaining bytes in `pending`).
    pub fn finish_stream(mut self) -> ParsedModel {
        if !self.pending.is_empty() {
            let mut line = std::mem::take(&mut self.pending);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.feed_line_bytes(&line);
        }
        self.finish_internal()
    }

    pub fn feed_line_str(&mut self, line: &str) {
        self.feed_line_bytes(line.as_bytes());
    }

    #[inline]
    pub fn feed_line_bytes(&mut self, raw_line: &[u8]) {
        self.line_no += 1;
        let stripped = trim_ascii_bytes(strip_comment_bytes(raw_line));
        if stripped.is_empty() {
            return;
        }

        // Fast check for Begin / End (only match when followed by whitespace or EOL)
        let mut cursor = stripped;
        let Some(head) = next_token(&mut cursor) else {
            return;
        };

        if head == b"Begin" {
            let s = String::from_utf8_lossy(stripped);
            let tokens: Vec<&str> = s.split_whitespace().collect();
            self.handle_begin(&tokens);
            return;
        }
        if head == b"End" {
            let s = String::from_utf8_lossy(stripped);
            let tokens: Vec<&str> = s.split_whitespace().collect();
            self.handle_end(&tokens);
            return;
        }

        self.handle_data(stripped, head, cursor);
    }

    fn property_set_in_scope(&self) -> Option<usize> {
        for f in self.stack.iter().rev() {
            match f.kind {
                FrameKind::Properties { prop_idx, .. } => return prop_idx,
                _ => {}
            }
        }
        None
    }

    fn top_submodel_part(&self) -> Option<usize> {
        for f in self.stack.iter().rev() {
            if let FrameKind::SubModelPart(idx) = f.kind {
                return Some(idx);
            }
        }
        None
    }

    fn handle_begin(&mut self, tokens: &[&str]) {
        let Some(&block_type) = tokens.get(1) else {
            self.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: "`Begin` without a block type.".to_string(),
            });
            self.stack.push(Frame {
                block_type: "<unknown>".to_string(),
                kind: FrameKind::Unknown,
            });
            return;
        };
        let args = &tokens[2..];

        // Trap door: anything opened inside a Properties block stays inside it.
        if let Some(enclosing) = self.stack.last() {
            if matches!(
                enclosing.kind,
                FrameKind::Properties { .. } | FrameKind::PropNested { .. }
            ) {
                let owner = self.property_set_in_scope();
                if block_type == "Table" {
                    if let Some(prop_idx) = owner {
                        let table = PropertyTable {
                            args: args.iter().map(|s| (*s).to_string()).collect(),
                            rows: Vec::new(),
                        };
                        let table_idx = self.properties[prop_idx].tables.len();
                        self.properties[prop_idx].tables.push(table);
                        self.stack.push(Frame {
                            block_type: block_type.to_string(),
                            kind: FrameKind::PropNested {
                                prop_idx: Some(prop_idx),
                                table_idx: Some(table_idx),
                            },
                        });
                        return;
                    }
                }
                self.stack.push(Frame {
                    block_type: block_type.to_string(),
                    kind: FrameKind::PropNested {
                        prop_idx: None,
                        table_idx: None,
                    },
                });
                return;
            }
        }

        if block_type == "Properties" {
            let id = args.first().and_then(|s| parse_strict_i32(s));
            if id.is_none() {
                self.diagnostics.push(MdpaDiagnostic {
                    line: self.line_no,
                    message: format!(
                        "\"Begin Properties {}\" has no readable id; its values are ignored.",
                        args.join(" ")
                    ),
                });
            }
            let label = if args.is_empty() {
                block_type.to_string()
            } else {
                format!("{} {}", block_type, args.join(" "))
            };
            let meta_idx = self.meta.len();
            self.meta.push(MetaBlock {
                label,
                line_count: 0,
            });
            let mut prop_idx = None;
            if let Some(id_val) = id {
                if self.properties.iter().any(|p| p.id == id_val) {
                    self.diagnostics.push(MdpaDiagnostic {
                        line: self.line_no,
                        message: format!(
                            "Duplicate \"Begin Properties {}\"; the first block's values are kept.",
                            id_val
                        ),
                    });
                } else {
                    prop_idx = Some(self.properties.len());
                    self.properties.push(PropertySet::empty(id_val));
                }
            }
            self.stack.push(Frame {
                block_type: block_type.to_string(),
                kind: FrameKind::Properties { meta_idx, prop_idx },
            });
            return;
        }

        if block_type == "Nodes" {
            self.stack.push(Frame {
                block_type: "Nodes".to_string(),
                kind: FrameKind::Nodes,
            });
        } else if let Some(kind) = entity_kind(block_type) {
            let name = args.first().copied().unwrap_or("<unnamed>");
            let key = (kind, name.to_string());
            let block_idx = if let Some(&idx) = self.block_index.get(&key) {
                idx
            } else {
                let vtk_cell_type = decode_type_name(name, Some(kind));
                let idx = self.blocks.len();
                self.blocks.push(ParsedBlock {
                    kind,
                    name: name.to_string(),
                    vtk_cell_type,
                    stride: 0,
                    entity_ids: Vec::new(),
                    property_ids: if kind == EntityKind::Geometries {
                        None
                    } else {
                        Some(Vec::new())
                    },
                    connectivity: Vec::new(),
                });
                self.block_index.insert(key, idx);
                idx
            };
            self.stack.push(Frame {
                block_type: block_type.to_string(),
                kind: FrameKind::Block(block_idx),
            });
        } else if block_type == "SubModelPart" {
            let name = args.first().copied().unwrap_or("<unnamed>");
            let parent = self.top_submodel_part();
            let path = match parent {
                Some(pidx) => format!("{}/{}", self.all_subparts[pidx].path, name),
                None => name.to_string(),
            };
            let part_idx = self.all_subparts.len();
            self.all_subparts.push(StagingSubModelPart {
                name: name.to_string(),
                path,
                node_ids: Vec::new(),
                element_ids: Vec::new(),
                condition_ids: Vec::new(),
                geometry_ids: Vec::new(),
                constraint_ids: Vec::new(),
                children: Vec::new(),
            });
            if let Some(pidx) = parent {
                self.all_subparts[pidx].children.push(part_idx);
            } else {
                self.root_subparts.push(part_idx);
            }
            self.stack.push(Frame {
                block_type: "SubModelPart".to_string(),
                kind: FrameKind::SubModelPart(part_idx),
            });
        } else if let Some(key) = sublist_key(block_type) {
            if let Some(part_idx) = self.top_submodel_part() {
                self.stack.push(Frame {
                    block_type: block_type.to_string(),
                    kind: FrameKind::ListTarget { part_idx, key },
                });
            } else {
                self.diagnostics.push(MdpaDiagnostic {
                    line: self.line_no,
                    message: format!("{} outside any SubModelPart.", block_type),
                });
                self.stack.push(Frame {
                    block_type: block_type.to_string(),
                    kind: FrameKind::Ignored,
                });
            }
        } else if let Some(kind) = field_kind(block_type) {
            let variable = args.first().copied().unwrap_or("<unnamed>").to_string();
            let label = if args.is_empty() {
                block_type.to_string()
            } else {
                format!("{} {}", block_type, args.join(" "))
            };
            let meta_idx = self.meta.len();
            self.meta.push(MetaBlock {
                label,
                line_count: 0,
            });
            let field_idx = self.staging_fields.len();
            self.staging_fields.push(StagingField {
                kind,
                variable,
                ids: Vec::new(),
                flat_values: Vec::new(),
                row_lens: Vec::new(),
                max_components: 1,
                fixed: Vec::new(),
                is_nodal: kind == FieldBlockKind::Nodal,
            });
            self.stack.push(Frame {
                block_type: block_type.to_string(),
                kind: FrameKind::Field {
                    meta_idx,
                    field_idx,
                },
            });
        } else if block_type == "Constraints" {
            let label = if args.is_empty() {
                block_type.to_string()
            } else {
                format!("{} {}", block_type, args.join(" "))
            };
            let meta_idx = self.meta.len();
            self.meta.push(MetaBlock {
                label,
                line_count: 0,
            });
            let constraint_idx = self.constraint_blocks.len();
            self.constraint_blocks.push(ConstraintBlock::empty(args));
            self.stack.push(Frame {
                block_type: block_type.to_string(),
                kind: FrameKind::Constraints {
                    meta_idx,
                    constraint_idx,
                },
            });
        } else if is_meta_type(block_type) {
            let label = if args.is_empty() {
                block_type.to_string()
            } else {
                format!("{} {}", block_type, args.join(" "))
            };
            let meta_idx = self.meta.len();
            self.meta.push(MetaBlock {
                label,
                line_count: 0,
            });
            self.stack.push(Frame {
                block_type: block_type.to_string(),
                kind: FrameKind::Meta(meta_idx),
            });
        } else {
            self.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: format!("Unknown block type \"{}\"; contents ignored.", block_type),
            });
            self.stack.push(Frame {
                block_type: block_type.to_string(),
                kind: FrameKind::Ignored,
            });
        }
    }

    fn handle_end(&mut self, tokens: &[&str]) {
        let end_type = tokens.get(1).copied();
        match self.stack.pop() {
            None => {
                self.diagnostics.push(MdpaDiagnostic {
                    line: self.line_no,
                    message: format!("Stray \"End {}\".", end_type.unwrap_or("")),
                });
            }
            Some(frame) => {
                if let Some(et) = end_type {
                    if frame.block_type != et && frame.block_type != "<unknown>" {
                        self.diagnostics.push(MdpaDiagnostic {
                            line: self.line_no,
                            message: format!(
                                "\"End {}\" does not match open block \"{}\".",
                                et, frame.block_type
                            ),
                        });
                    }
                }
            }
        }
    }

    #[inline]
    fn handle_data(&mut self, line: &[u8], head: &[u8], mut cursor: &[u8]) {
        let Some(frame) = self.stack.last() else {
            self.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: "Data line outside any block.".to_string(),
            });
            return;
        };

        match frame.kind {
            FrameKind::Nodes => {
                let Some(tx) = next_token(&mut cursor) else {
                    self.diagnostics.push(MdpaDiagnostic {
                        line: self.line_no,
                        message: "Node line needs id X Y Z.".to_string(),
                    });
                    return;
                };
                let Some(ty) = next_token(&mut cursor) else {
                    self.diagnostics.push(MdpaDiagnostic {
                        line: self.line_no,
                        message: "Node line needs id X Y Z.".to_string(),
                    });
                    return;
                };
                let Some(tz) = next_token(&mut cursor) else {
                    self.diagnostics.push(MdpaDiagnostic {
                        line: self.line_no,
                        message: "Node line needs id X Y Z.".to_string(),
                    });
                    return;
                };
                let id = parse_i32_token(head).unwrap_or(0);
                let x = parse_f64_token(tx) as f32;
                let y = parse_f64_token(ty) as f32;
                let z = parse_f64_token(tz) as f32;
                self.node_ids.push(id);
                self.coords.push(x);
                self.coords.push(y);
                self.coords.push(z);
            }
            FrameKind::Block(bidx) => {
                let b = &mut self.blocks[bidx];
                let id = parse_i32_token(head).unwrap_or(0);
                if b.kind == EntityKind::Geometries {
                    let conn_start = b.connectivity.len();
                    while let Some(tok) = next_token(&mut cursor) {
                        b.connectivity.push(parse_i32_token(tok).unwrap_or(0));
                    }
                    let count_n = b.connectivity.len() - conn_start;
                    if b.stride == 0 {
                        b.stride = count_n;
                    }
                    b.entity_ids.push(id);
                } else {
                    let prop_id = match next_token(&mut cursor) {
                        Some(tok) => parse_i32_token(tok).unwrap_or(0),
                        None => 0,
                    };
                    let conn_start = b.connectivity.len();
                    while let Some(tok) = next_token(&mut cursor) {
                        b.connectivity.push(parse_i32_token(tok).unwrap_or(0));
                    }
                    let count_n = b.connectivity.len() - conn_start;
                    if b.stride == 0 {
                        b.stride = count_n;
                    }
                    b.entity_ids.push(id);
                    if let Some(ref mut pids) = b.property_ids {
                        pids.push(prop_id);
                    }
                }
            }
            FrameKind::ListTarget { part_idx, key } => {
                if let Some(id) = parse_i32_token(head) {
                    let part = &mut self.all_subparts[part_idx];
                    match key {
                        SubListKey::NodeIds => part.node_ids.push(id),
                        SubListKey::ElementIds => part.element_ids.push(id),
                        SubListKey::ConditionIds => part.condition_ids.push(id),
                        SubListKey::GeometryIds => part.geometry_ids.push(id),
                        SubListKey::ConstraintIds => part.constraint_ids.push(id),
                    }
                }
            }
            FrameKind::Field {
                meta_idx,
                field_idx,
            } => {
                self.meta[meta_idx].line_count += 1;
                self.parse_field_record(field_idx, head, cursor);
            }
            FrameKind::PropNested {
                prop_idx,
                table_idx,
            } => {
                if let (Some(pidx), Some(tidx)) = (prop_idx, table_idx) {
                    let mut row = Vec::new();
                    let n0 = parse_f64_token(head);
                    if n0.is_finite() {
                        row.push(n0);
                        let mut ok = true;
                        while let Some(tok) = next_token(&mut cursor) {
                            let n = parse_f64_token(tok);
                            if !n.is_finite() {
                                ok = false;
                                break;
                            }
                            row.push(n);
                        }
                        if ok {
                            self.properties[pidx].tables[tidx].rows.push(row);
                        }
                    }
                }
            }
            FrameKind::Properties { meta_idx, prop_idx } => {
                self.meta[meta_idx].line_count += 1;
                if let Some(pidx) = prop_idx {
                    let line_str = String::from_utf8_lossy(line);
                    let head_str = String::from_utf8_lossy(head);
                    let line_no = self.line_no;
                    let diags = &mut self.diagnostics;
                    add_property_line(&mut self.properties[pidx], &head_str, &line_str, |msg| {
                        diags.push(MdpaDiagnostic {
                            line: line_no,
                            message: msg,
                        });
                    });
                }
            }
            FrameKind::Constraints {
                meta_idx,
                constraint_idx,
            } => {
                self.meta[meta_idx].line_count += 1;
                let line_str = String::from_utf8_lossy(line);
                let line_no = self.line_no;
                let diags = &mut self.diagnostics;
                let row = parse_constraint_row(&line_str, |m| {
                    diags.push(MdpaDiagnostic {
                        line: line_no,
                        message: format!("Constraints: {}", m),
                    });
                });
                self.constraint_blocks[constraint_idx].rows.push(row);
            }
            FrameKind::Meta(meta_idx) => {
                self.meta[meta_idx].line_count += 1;
            }
            FrameKind::Unknown | FrameKind::SubModelPart(_) | FrameKind::Ignored => {}
        }
    }

    fn parse_field_record(&mut self, field_idx: usize, head: &[u8], cursor: &[u8]) {
        let kind = self.staging_fields[field_idx].kind;
        let is_nodal = self.staging_fields[field_idx].is_nodal;

        let Some(id) = parse_i32_token(head) else {
            let head_str = String::from_utf8_lossy(head);
            self.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: format!("Invalid {}Data entity id \"{}\".", kind.as_str(), head_str),
            });
            return;
        };

        let rest_bytes = trim_ascii_bytes(cursor);

        // Fast scalar path (no '(' in rest_bytes)
        if !rest_bytes.contains(&b'(') {
            let mut fixed: u8 = 0;
            let val: f64;
            if rest_bytes.is_empty() {
                fixed = 1;
                val = 1.0;
            } else {
                let mut c = rest_bytes;
                let t0 = next_token(&mut c).unwrap();
                if is_nodal {
                    if let Some(t1) = next_token(&mut c) {
                        fixed = if parse_i32_token(t0).unwrap_or(0) != 0 {
                            1
                        } else {
                            0
                        };
                        val = parse_f64_token(t1);
                    } else {
                        val = parse_f64_token(t0);
                    }
                } else {
                    val = parse_f64_token(t0);
                }
            }

            if val.is_nan() {
                self.diagnostics.push(MdpaDiagnostic {
                    line: self.line_no,
                    message: format!("Invalid {}Data value for entity {}.", kind.as_str(), id),
                });
                return;
            }

            let f = &mut self.staging_fields[field_idx];
            f.ids.push(id);
            f.flat_values.push(val);
            f.row_lens.push(1);
            if is_nodal {
                f.fixed.push(fixed);
            }
            return;
        }

        // Vector path: has '('
        let paren_start = rest_bytes.iter().position(|&b| b == b'(').unwrap();
        let paren_end = rest_bytes[paren_start + 1..]
            .iter()
            .position(|&b| b == b')')
            .map(|rel| paren_start + 1 + rel);
        let inner = match paren_end {
            Some(end) => &rest_bytes[paren_start + 1..end],
            None => &rest_bytes[paren_start + 1..],
        };

        let mut vals: Vec<f64> = Vec::with_capacity(6);
        let mut any_nan = false;
        for part in inner.split(|&b| b == b',') {
            let p = trim_ascii_bytes(part);
            if p.is_empty() {
                continue;
            }
            let n = parse_f64_token(p);
            if n.is_nan() {
                any_nan = true;
                break;
            }
            vals.push(n);
        }

        if vals.is_empty() || any_nan {
            self.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: format!("Invalid {}Data value for entity {}.", kind.as_str(), id),
            });
            return;
        }

        let mut fixed: u8 = 0;
        if is_nodal {
            let bracket = rest_bytes.iter().position(|&b| b == b'[');
            let lead_end = bracket.unwrap_or(paren_start);
            let lead = trim_ascii_bytes(&rest_bytes[..lead_end]);
            if !lead.is_empty() && lead.iter().all(|b| b.is_ascii_digit()) {
                if parse_i32_token(lead).unwrap_or(0) != 0 {
                    fixed = 1;
                }
            }
        }

        let f = &mut self.staging_fields[field_idx];
        if vals.len() > f.max_components {
            f.max_components = vals.len();
        }
        f.ids.push(id);
        f.row_lens.push(vals.len() as u32);
        f.flat_values.extend_from_slice(&vals);
        if is_nodal {
            f.fixed.push(fixed);
        }
    }

    fn finish_internal(mut self) -> ParsedModel {
        if !self.stack.is_empty() {
            self.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: format!(
                    "{} block(s) not closed by end of file.",
                    self.stack.len()
                ),
            });
        }

        let node_count = self.node_ids.len();

        let block_metas: Vec<BlockMeta> = self
            .blocks
            .iter()
            .map(|b| BlockMeta {
                kind: b.kind.as_str().to_string(),
                name: b.name.clone(),
                vtk_cell_type: b.vtk_cell_type,
                count: b.entity_ids.len(),
                stride: b.stride,
                has_property_ids: b.property_ids.is_some(),
            })
            .collect();

        // Build SubModelPart tree with post-order unionWithChildren
        let mut subpart_id_arrays: Vec<Vec<i32>> = Vec::new();
        let sub_model_parts: Vec<SubModelPartMeta> = self
            .root_subparts
            .iter()
            .map(|&idx| {
                build_submodel_part_meta(&self.all_subparts, idx, &mut subpart_id_arrays)
            })
            .collect();

        // Finalize fields
        let mut fields: Vec<ParsedField> = Vec::with_capacity(self.staging_fields.len());
        let mut field_metas: Vec<FieldMeta> = Vec::with_capacity(self.staging_fields.len());
        for f in self.staging_fields {
            let components = f.max_components;
            let count = f.ids.len();
            let values = if components == 1 && f.flat_values.len() == count {
                f.flat_values
            } else {
                let mut out = vec![0.0_f64; count * components];
                let mut src_off = 0usize;
                for (i, &rlen) in f.row_lens.iter().enumerate() {
                    let rlen = rlen as usize;
                    let dst_off = i * components;
                    out[dst_off..dst_off + rlen]
                        .copy_from_slice(&f.flat_values[src_off..src_off + rlen]);
                    src_off += rlen;
                }
                out
            };
            field_metas.push(FieldMeta {
                kind: f.kind.as_str().to_string(),
                variable: f.variable.clone(),
                components,
                has_fixed: f.is_nodal,
            });
            fields.push(ParsedField {
                kind: f.kind.as_str(),
                variable: f.variable,
                components,
                ids: f.ids,
                values,
                fixed: if f.is_nodal { Some(f.fixed) } else { None },
            });
        }

        // Bounds + dimensionality (computed from f32 coords, matching TS Float32Array)
        let mut is_3d = false;
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for i in 0..node_count {
            let x = self.coords[i * 3] as f64;
            let y = self.coords[i * 3 + 1] as f64;
            let z = self.coords[i * 3 + 2] as f64;
            if x < min[0] {
                min[0] = x;
            }
            if y < min[1] {
                min[1] = y;
            }
            if z < min[2] {
                min[2] = z;
            }
            if x > max[0] {
                max[0] = x;
            }
            if y > max[1] {
                max[1] = y;
            }
            if z > max[2] {
                max[2] = z;
            }
            if z.abs() > 1e-12 {
                is_3d = true;
            }
        }
        if node_count == 0 {
            min = [0.0, 0.0, 0.0];
            max = [0.0, 0.0, 0.0];
        }

        let meta = ParsedModelMeta {
            node_count,
            blocks: block_metas,
            sub_model_parts,
            meta: self.meta,
            fields: field_metas,
            diagnostics: self.diagnostics,
            is_3d,
            bounds: BoundsMeta { min, max },
            properties: if self.properties.is_empty() {
                None
            } else {
                Some(self.properties)
            },
            constraints: if self.constraint_blocks.is_empty() {
                None
            } else {
                Some(self.constraint_blocks)
            },
        };

        ParsedModel {
            meta,
            node_ids: self.node_ids,
            coords: self.coords,
            blocks: self.blocks,
            fields,
            subpart_id_arrays,
        }
    }
}

fn union_with_children(own: &[i32], children_arrays: &[&[i32]]) -> Vec<i32> {
    if children_arrays.is_empty() {
        return own.to_vec();
    }
    let mut set: HashSet<i32> = HashSet::with_capacity(own.len());
    let mut own_has_dups = false;
    for &id in own {
        if !set.insert(id) {
            own_has_dups = true;
        }
    }
    for &child in children_arrays {
        for &id in child {
            set.insert(id);
        }
    }
    if set.len() == own.len() && !own_has_dups {
        return own.to_vec();
    }
    let mut out: Vec<i32> = set.into_iter().collect();
    out.sort_unstable();
    out
}

fn build_submodel_part_meta(
    all: &[StagingSubModelPart],
    idx: usize,
    arrays: &mut Vec<Vec<i32>>,
) -> SubModelPartMeta {
    let s = &all[idx];
    let children: Vec<SubModelPartMeta> = s
        .children
        .iter()
        .map(|&cidx| build_submodel_part_meta(all, cidx, arrays))
        .collect();

    let node_ids = {
        let child_refs: Vec<&[i32]> = children
            .iter()
            .map(|c| arrays[c.node_ids_idx].as_slice())
            .collect();
        union_with_children(&s.node_ids, &child_refs)
    };
    let node_ids_idx = arrays.len();
    arrays.push(node_ids);

    let element_ids = {
        let child_refs: Vec<&[i32]> = children
            .iter()
            .map(|c| arrays[c.element_ids_idx].as_slice())
            .collect();
        union_with_children(&s.element_ids, &child_refs)
    };
    let element_ids_idx = arrays.len();
    arrays.push(element_ids);

    let condition_ids = {
        let child_refs: Vec<&[i32]> = children
            .iter()
            .map(|c| arrays[c.condition_ids_idx].as_slice())
            .collect();
        union_with_children(&s.condition_ids, &child_refs)
    };
    let condition_ids_idx = arrays.len();
    arrays.push(condition_ids);

    let geometry_ids = {
        let child_refs: Vec<&[i32]> = children
            .iter()
            .map(|c| arrays[c.geometry_ids_idx].as_slice())
            .collect();
        union_with_children(&s.geometry_ids, &child_refs)
    };
    let geometry_ids_idx = arrays.len();
    arrays.push(geometry_ids);

    let constraint_ids = {
        let child_refs: Vec<&[i32]> = children
            .iter()
            .map(|c| arrays[c.constraint_ids_idx].as_slice())
            .collect();
        union_with_children(&s.constraint_ids, &child_refs)
    };
    let constraint_ids_idx = arrays.len();
    arrays.push(constraint_ids);

    SubModelPartMeta {
        name: s.name.clone(),
        path: s.path.clone(),
        node_ids_idx,
        element_ids_idx,
        condition_ids_idx,
        geometry_ids_idx,
        constraint_ids_idx,
        children,
    }
}

// ---- Summary scanner (exact port of MdpaSummaryScanner) ----

struct ScanFrame {
    block_type: String,
    is_properties: bool,
    prop_nested: bool,
    counting: bool,
    count: usize,
    entity: Option<(EntityKind, String)>,
    field: Option<(FieldBlockKind, String)>,
    list: Option<SubListKey>,
    is_part: bool,
}

pub struct MdpaSummaryScanner {
    stack: Vec<ScanFrame>,
    part_stack: Vec<String>,
    line_no: usize,
    result: MdpaScanResult,
    pending: Vec<u8>,
}

impl MdpaSummaryScanner {
    pub fn new() -> Self {
        Self {
            stack: Vec::new(),
            part_stack: Vec::new(),
            line_no: 0,
            result: MdpaScanResult {
                node_count: 0,
                blocks: Vec::new(),
                parts: Vec::new(),
                fields: Vec::new(),
                property_ids: Vec::new(),
                constraint_blocks: Vec::new(),
                diagnostics: Vec::new(),
            },
            pending: Vec::new(),
        }
    }

    pub fn feed_chunk(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let mut start = 0usize;
        if !self.pending.is_empty() {
            if let Some(nl) = chunk.iter().position(|&b| b == b'\n') {
                self.pending.extend_from_slice(&chunk[..nl]);
                let mut line = std::mem::take(&mut self.pending);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.feed_line_bytes(&line);
                line.clear();
                self.pending = line;
                start = nl + 1;
            } else {
                self.pending.extend_from_slice(chunk);
                return;
            }
        }

        let rest = &chunk[start..];
        let mut line_start = 0usize;
        for (i, &b) in rest.iter().enumerate() {
            if b == b'\n' {
                let mut line = &rest[line_start..i];
                if line.last() == Some(&b'\r') {
                    line = &line[..line.len() - 1];
                }
                self.feed_line_bytes(line);
                line_start = i + 1;
            }
        }
        if line_start < rest.len() {
            self.pending.extend_from_slice(&rest[line_start..]);
        }
    }

    #[inline]
    pub fn feed_line_bytes(&mut self, raw_line: &[u8]) {
        self.line_no += 1;
        let stripped = trim_ascii_bytes(strip_comment_bytes(raw_line));
        if stripped.is_empty() {
            return;
        }
        let mut cursor = stripped;
        let Some(head) = next_token(&mut cursor) else {
            return;
        };
        if head == b"Begin" {
            let s = String::from_utf8_lossy(stripped);
            let tokens: Vec<&str> = s.split_whitespace().collect();
            self.begin(&tokens);
            return;
        }
        if head == b"End" {
            self.end();
            return;
        }
        if let Some(top) = self.stack.last_mut() {
            if top.counting {
                top.count += 1;
            }
        }
    }

    fn begin(&mut self, tokens: &[&str]) {
        let Some(&block_type) = tokens.get(1) else {
            self.stack.push(ScanFrame {
                block_type: "<unknown>".to_string(),
                is_properties: false,
                prop_nested: false,
                counting: false,
                count: 0,
                entity: None,
                field: None,
                list: None,
                is_part: false,
            });
            return;
        };
        let args = &tokens[2..];

        if let Some(enclosing) = self.stack.last() {
            if enclosing.is_properties || enclosing.prop_nested {
                self.stack.push(ScanFrame {
                    block_type: block_type.to_string(),
                    is_properties: false,
                    prop_nested: true,
                    counting: false,
                    count: 0,
                    entity: None,
                    field: None,
                    list: None,
                    is_part: false,
                });
                return;
            }
        }

        if block_type == "Properties" {
            if let Some(id) = args.first().and_then(|a| parse_i32_token(a.as_bytes())) {
                self.result.property_ids.push(id);
            }
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: true,
                prop_nested: false,
                counting: false,
                count: 0,
                entity: None,
                field: None,
                list: None,
                is_part: false,
            });
            return;
        }
        if block_type == "Nodes" {
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: false,
                prop_nested: false,
                counting: true,
                count: 0,
                entity: None,
                field: None,
                list: None,
                is_part: false,
            });
            return;
        }
        if let Some(kind) = entity_kind(block_type) {
            let name = args.first().copied().unwrap_or(block_type).to_string();
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: false,
                prop_nested: false,
                counting: true,
                count: 0,
                entity: Some((kind, name)),
                field: None,
                list: None,
                is_part: false,
            });
            return;
        }
        if let Some(kind) = field_kind(block_type) {
            let variable = args.first().copied().unwrap_or("").to_string();
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: false,
                prop_nested: false,
                counting: true,
                count: 0,
                entity: None,
                field: Some((kind, variable)),
                list: None,
                is_part: false,
            });
            return;
        }
        if let Some(list) = sublist_key(block_type) {
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: false,
                prop_nested: false,
                counting: true,
                count: 0,
                entity: None,
                field: None,
                list: Some(list),
                is_part: false,
            });
            return;
        }
        if block_type == "SubModelPart" {
            let name = args.first().copied().unwrap_or("").to_string();
            self.part_stack.push(name);
            let path = self.part_stack.join("/");
            self.result.parts.push(MdpaScanPart {
                path,
                counts: MdpaScanPartCounts::default(),
            });
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: false,
                prop_nested: false,
                counting: false,
                count: 0,
                entity: None,
                field: None,
                list: None,
                is_part: true,
            });
            return;
        }
        if block_type == "Constraints" {
            self.result
                .constraint_blocks
                .push(args.first().copied().unwrap_or("").to_string());
            self.stack.push(ScanFrame {
                block_type: block_type.to_string(),
                is_properties: false,
                prop_nested: false,
                counting: true,
                count: 0,
                entity: None,
                field: None,
                list: None,
                is_part: false,
            });
            return;
        }
        self.stack.push(ScanFrame {
            block_type: block_type.to_string(),
            is_properties: false,
            prop_nested: false,
            counting: false,
            count: 0,
            entity: None,
            field: None,
            list: None,
            is_part: false,
        });
    }

    fn end(&mut self) {
        let Some(frame) = self.stack.pop() else {
            self.result.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: "`End` without a matching `Begin`.".to_string(),
            });
            return;
        };
        if frame.block_type == "Nodes" {
            self.result.node_count += frame.count;
            return;
        }
        if let Some((kind, name)) = frame.entity {
            let kind_str = kind.as_str();
            if let Some(found) = self
                .result
                .blocks
                .iter_mut()
                .find(|b| b.kind == kind_str && b.name == name)
            {
                found.count += frame.count;
            } else {
                self.result.blocks.push(MdpaScanBlock {
                    kind: kind_str.to_string(),
                    name,
                    count: frame.count,
                });
            }
            return;
        }
        if let Some((kind, variable)) = frame.field {
            let kind_str = kind.as_str();
            if !self
                .result
                .fields
                .iter()
                .any(|f| f.kind == kind_str && f.variable == variable)
            {
                self.result.fields.push(MdpaScanField {
                    kind: kind_str.to_string(),
                    variable,
                });
            }
            return;
        }
        if let Some(list) = frame.list {
            let cur_path = self.part_stack.join("/");
            if let Some(part) = self.result.parts.iter_mut().find(|p| p.path == cur_path) {
                let slot = match list {
                    SubListKey::NodeIds => &mut part.counts.node_ids,
                    SubListKey::ElementIds => &mut part.counts.element_ids,
                    SubListKey::ConditionIds => &mut part.counts.condition_ids,
                    SubListKey::GeometryIds => &mut part.counts.geometry_ids,
                    SubListKey::ConstraintIds => &mut part.counts.constraint_ids,
                };
                *slot = Some(slot.unwrap_or(0) + frame.count);
            }
            return;
        }
        if frame.is_part {
            self.part_stack.pop();
        }
    }

    pub fn finish(mut self) -> MdpaScanResult {
        if !self.pending.is_empty() {
            let mut line = std::mem::take(&mut self.pending);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.feed_line_bytes(&line);
        }
        if !self.stack.is_empty() {
            self.result.diagnostics.push(MdpaDiagnostic {
                line: self.line_no,
                message: format!(
                    "{} block(s) left unclosed at end of file.",
                    self.stack.len()
                ),
            });
        }
        self.result
    }
}
