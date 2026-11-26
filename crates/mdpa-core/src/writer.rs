//! High-speed MDPA serializer matching `src/parser/writers/mdpaWriter.ts` byte-for-byte.

use serde::Deserialize;

use crate::constraints::{group_rows_by_master_count, push_constraint_row, ConstraintBlock};
use crate::num_fmt::push_num;
use crate::properties::{format_property_table_lines, push_property_value, PropertySet};
use crate::types::SubModelPartMeta;

#[derive(Debug, Deserialize)]
pub struct WriteBlockMeta {
    pub kind: String,
    pub name: String,
    pub count: usize,
    pub stride: usize,
}

#[derive(Debug, Deserialize)]
pub struct WriteFieldMeta {
    pub kind: String,
    pub variable: String,
    pub components: usize,
}

#[derive(Debug, Deserialize)]
pub struct WriteModelMeta {
    #[serde(rename = "nodeCount")]
    pub node_count: usize,
    pub blocks: Vec<WriteBlockMeta>,
    #[serde(rename = "subModelParts")]
    pub sub_model_parts: Vec<SubModelPartMeta>,
    pub fields: Vec<WriteFieldMeta>,
    pub properties: Option<Vec<PropertySet>>,
    pub constraints: Option<Vec<ConstraintBlock>>,
    #[serde(rename = "sourceText")]
    pub source_text: Option<String>,
}

pub struct WriteBlockData {
    pub entity_ids: Vec<i32>,
    pub property_ids: Option<Vec<i32>>,
    pub connectivity: Vec<i32>,
}

pub struct WriteFieldData {
    pub ids: Vec<i32>,
    pub values: Vec<f64>,
    pub fixed: Option<Vec<u8>>,
}

pub struct WriteInput {
    pub meta: WriteModelMeta,
    pub node_ids: Vec<i32>,
    pub coords: Vec<f32>,
    pub blocks: Vec<WriteBlockData>,
    pub fields: Vec<WriteFieldData>,
    pub subpart_id_arrays: Vec<Vec<i32>>,
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Match `/^Begin\s+(\w+)/` on trimmed line and return captured word.
fn match_begin_word(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix("Begin")?;
    let mut i = 0;
    let b = rest.as_bytes();
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if i == 0 || i >= b.len() {
        return None;
    }
    let start = i;
    while i < b.len() && is_word_byte(b[i]) {
        i += 1;
    }
    if i == start {
        return None;
    }
    Some(&rest[start..i])
}

/// Match `/^End\b/` on trimmed line.
fn matches_end_word(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("End") else {
        return false;
    };
    rest.is_empty() || !is_word_byte(rest.as_bytes()[0])
}

fn extract_verbatim_blocks<'a>(source_text: &'a str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut buf: Vec<&'a str> = Vec::new();
    for raw_line in source_text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let t = line.trim();
        let begin = match_begin_word(t);
        if depth == 0 {
            if let Some(word) = begin {
                if word == "ModelPartData" || word == "Table" {
                    depth = 1;
                    buf.clear();
                    buf.push(line);
                }
            }
            continue;
        }
        buf.push(line);
        if begin.is_some() {
            depth += 1;
        } else if matches_end_word(t) {
            depth -= 1;
            if depth == 0 {
                out.push(buf.join("\n"));
                buf.clear();
            }
        }
    }
    out
}

fn write_properties(props: &[PropertySet], out: &mut Vec<u8>) {
    let mut ibuf = itoa::Buffer::new();
    let mut line_buf: Vec<u8> = Vec::with_capacity(128);
    for set in props {
        out.extend_from_slice(b"Begin Properties ");
        out.extend_from_slice(ibuf.format(set.id).as_bytes());
        out.push(b'\n');
        for (name, v) in &set.variables {
            line_buf.clear();
            line_buf.extend_from_slice(b"  ");
            line_buf.extend_from_slice(name.as_bytes());
            line_buf.push(b' ');
            push_property_value(&mut line_buf, v);
            // Match JS `.trimEnd()`
            while let Some(&last) = line_buf.last() {
                if last.is_ascii_whitespace() {
                    line_buf.pop();
                } else {
                    break;
                }
            }
            out.extend_from_slice(&line_buf);
            out.push(b'\n');
        }
        for t in &set.tables {
            for l in format_property_table_lines(t) {
                out.extend_from_slice(b"  ");
                out.extend_from_slice(l.as_bytes());
                out.push(b'\n');
            }
        }
        out.extend_from_slice(b"End Properties\n\n");
    }
}

fn write_nodes(node_count: usize, node_ids: &[i32], coords: &[f32], out: &mut Vec<u8>) {
    let mut ibuf = itoa::Buffer::new();
    out.extend_from_slice(b"Begin Nodes\n");
    for i in 0..node_count {
        out.extend_from_slice(b"  ");
        out.extend_from_slice(ibuf.format(node_ids[i]).as_bytes());
        out.push(b' ');
        push_num(out, coords[i * 3] as f64);
        out.push(b' ');
        push_num(out, coords[i * 3 + 1] as f64);
        out.push(b' ');
        push_num(out, coords[i * 3 + 2] as f64);
        out.push(b'\n');
    }
    out.extend_from_slice(b"End Nodes\n\n");
}

fn write_blocks(metas: &[WriteBlockMeta], datas: &[WriteBlockData], out: &mut Vec<u8>) {
    let mut ibuf = itoa::Buffer::new();
    for (bm, bd) in metas.iter().zip(datas.iter()) {
        out.extend_from_slice(b"Begin ");
        out.extend_from_slice(bm.kind.as_bytes());
        out.push(b' ');
        out.extend_from_slice(bm.name.as_bytes());
        out.push(b'\n');

        let geom = bm.kind == "Geometries";
        let stride = bm.stride;
        for c in 0..bm.count {
            out.extend_from_slice(b"  ");
            out.extend_from_slice(ibuf.format(bd.entity_ids[c]).as_bytes());
            if !geom {
                out.push(b' ');
                let prop_id = bd
                    .property_ids
                    .as_ref()
                    .and_then(|p| p.get(c).copied())
                    .unwrap_or(0);
                out.extend_from_slice(ibuf.format(prop_id).as_bytes());
            }
            out.push(b' ');
            let base = c * stride;
            for k in 0..stride {
                if k > 0 {
                    out.push(b' ');
                }
                out.extend_from_slice(ibuf.format(bd.connectivity[base + k]).as_bytes());
            }
            out.push(b'\n');
        }

        out.extend_from_slice(b"End ");
        out.extend_from_slice(bm.kind.as_bytes());
        out.extend_from_slice(b"\n\n");
    }
}

fn write_constraint_header(name: &str, vars: &[&str], out: &mut Vec<u8>) {
    out.extend_from_slice(b"Begin Constraints");
    if !name.is_empty() {
        out.push(b' ');
        out.extend_from_slice(name.as_bytes());
    }
    for v in vars {
        if !v.is_empty() {
            out.push(b' ');
            out.extend_from_slice(v.as_bytes());
        }
    }
    out.push(b'\n');
}

fn write_constraints(blocks: &[ConstraintBlock], out: &mut Vec<u8>) {
    for block in blocks {
        let groups = group_rows_by_master_count(&block.rows);
        let same_var = !block.variables.is_empty()
            && block.variables.iter().all(|v| v == &block.variables[0]);
        if groups.is_empty() {
            let vars: Vec<&str> = block.variables.iter().map(|s| s.as_str()).collect();
            write_constraint_header(&block.name, &vars, out);
            out.extend_from_slice(b"End Constraints\n\n");
            continue;
        }
        for (masters, rows) in &groups {
            let vars: Vec<&str> = if groups.len() > 1 && masters.is_some() && same_var {
                vec![block.variables[0].as_str(); 1 + masters.unwrap()]
            } else {
                block.variables.iter().map(|s| s.as_str()).collect()
            };
            write_constraint_header(&block.name, &vars, out);
            for row in rows {
                out.extend_from_slice(b"  ");
                push_constraint_row(out, row);
                out.push(b'\n');
            }
            out.extend_from_slice(b"End Constraints\n\n");
        }
    }
}

fn write_field(fm: &WriteFieldMeta, fd: &WriteFieldData, out: &mut Vec<u8>) {
    let block_tag: &[u8] = match fm.kind.as_str() {
        "Nodal" => b"NodalData",
        "Elemental" => b"ElementalData",
        "Conditional" => b"ConditionalData",
        other => other.as_bytes(),
    };
    let is_nodal = fm.kind == "Nodal";
    let mut ibuf = itoa::Buffer::new();

    out.extend_from_slice(b"Begin ");
    out.extend_from_slice(block_tag);
    out.push(b' ');
    out.extend_from_slice(fm.variable.as_bytes());
    out.push(b'\n');

    let comps = fm.components;
    for i in 0..fd.ids.len() {
        out.extend_from_slice(b"  ");
        out.extend_from_slice(ibuf.format(fd.ids[i]).as_bytes());
        if is_nodal {
            let fixed = fd.fixed.as_ref().and_then(|f| f.get(i).copied()).unwrap_or(0);
            out.push(b' ');
            out.extend_from_slice(ibuf.format(fixed).as_bytes());
        }
        out.push(b' ');
        if comps == 1 {
            push_num(out, fd.values[i]);
        } else {
            out.push(b'(');
            let base = i * comps;
            for k in 0..comps {
                if k > 0 {
                    out.push(b',');
                }
                push_num(out, fd.values[base + k]);
            }
            out.push(b')');
        }
        out.push(b'\n');
    }

    out.extend_from_slice(b"End ");
    out.extend_from_slice(block_tag);
    out.extend_from_slice(b"\n\n");
}

fn write_subpart_list(tag: &[u8], ids: &[i32], indent: &str, out: &mut Vec<u8>) {
    if ids.is_empty() {
        return;
    }
    let mut ibuf = itoa::Buffer::new();
    out.extend_from_slice(indent.as_bytes());
    out.extend_from_slice(b"Begin ");
    out.extend_from_slice(tag);
    out.push(b'\n');
    for &id in ids {
        out.extend_from_slice(indent.as_bytes());
        out.extend_from_slice(b"  ");
        out.extend_from_slice(ibuf.format(id).as_bytes());
        out.push(b'\n');
    }
    out.extend_from_slice(indent.as_bytes());
    out.extend_from_slice(b"End ");
    out.extend_from_slice(tag);
    out.push(b'\n');
}

fn write_submodel_part(
    part: &SubModelPartMeta,
    arrays: &[Vec<i32>],
    indent: &str,
    out: &mut Vec<u8>,
) {
    out.extend_from_slice(indent.as_bytes());
    out.extend_from_slice(b"Begin SubModelPart ");
    out.extend_from_slice(part.name.as_bytes());
    out.push(b'\n');
    let inner = format!("{}  ", indent);
    write_subpart_list(b"SubModelPartNodes", &arrays[part.node_ids_idx], &inner, out);
    write_subpart_list(
        b"SubModelPartElements",
        &arrays[part.element_ids_idx],
        &inner,
        out,
    );
    write_subpart_list(
        b"SubModelPartConditions",
        &arrays[part.condition_ids_idx],
        &inner,
        out,
    );
    write_subpart_list(
        b"SubModelPartGeometries",
        &arrays[part.geometry_ids_idx],
        &inner,
        out,
    );
    write_subpart_list(
        b"SubModelPartConstraints",
        &arrays[part.constraint_ids_idx],
        &inner,
        out,
    );
    for child in &part.children {
        write_submodel_part(child, arrays, &inner, out);
    }
    out.extend_from_slice(indent.as_bytes());
    out.extend_from_slice(b"End SubModelPart\n");
}

pub fn write_mdpa_bytes(input: &WriteInput) -> Vec<u8> {
    // Estimate output size to avoid reallocations on large meshes
    let total_entities: usize = input.meta.blocks.iter().map(|b| b.count).sum();
    let est_cap = input.meta.node_count * 36 + total_entities * 36 + 1024;
    let mut out = Vec::with_capacity(est_cap);

    if let Some(ref src) = input.meta.source_text {
        for b in extract_verbatim_blocks(src) {
            out.extend_from_slice(b.as_bytes());
            out.extend_from_slice(b"\n\n");
        }
    }

    if let Some(ref props) = input.meta.properties {
        if !props.is_empty() {
            write_properties(props, &mut out);
        } else {
            out.extend_from_slice(b"Begin Properties 0\nEnd Properties\n\n");
        }
    } else {
        out.extend_from_slice(b"Begin Properties 0\nEnd Properties\n\n");
    }

    write_nodes(input.meta.node_count, &input.node_ids, &input.coords, &mut out);
    write_blocks(&input.meta.blocks, &input.blocks, &mut out);

    if let Some(ref constraints) = input.meta.constraints {
        write_constraints(constraints, &mut out);
    }

    for (fm, fd) in input.meta.fields.iter().zip(input.fields.iter()) {
        write_field(fm, fd, &mut out);
    }

    for part in &input.meta.sub_model_parts {
        write_submodel_part(part, &input.subpart_id_arrays, "", &mut out);
        out.push(b'\n');
    }

    out
}
