//! Exact port of `src/parser/constraintsParser.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::num_fmt::{parse_f64_token, push_constraint_num};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ConstraintRow {
    #[serde(rename = "linear")]
    Linear {
        id: i32,
        constant: f64,
        weights: Vec<f64>,
        #[serde(rename = "slaveIds")]
        slave_ids: Vec<i32>,
        #[serde(rename = "masterIds")]
        master_ids: Vec<i32>,
    },
    #[serde(rename = "raw")]
    Raw { text: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConstraintBlock {
    pub name: String,
    pub variables: Vec<String>,
    pub rows: Vec<ConstraintRow>,
}

impl ConstraintBlock {
    pub fn empty(args: &[&str]) -> Self {
        Self {
            name: args.first().copied().unwrap_or("").to_string(),
            variables: args.iter().skip(1).map(|s| (*s).to_string()).collect(),
            rows: Vec::new(),
        }
    }
}

struct BracketSpan<'a> {
    start: usize,
    end: usize,
    payload: &'a str,
    max_depth: usize,
}

fn bracket_span(text: &str) -> Option<BracketSpan<'_>> {
    let start = text.find('[')?;
    let mut depth = 0usize;
    let mut max_depth = 0usize;
    for (offset, b) in text.as_bytes()[start..].iter().enumerate() {
        let i = start + offset;
        if *b == b'[' {
            depth += 1;
            if depth > max_depth {
                max_depth = depth;
            }
        } else if *b == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(BracketSpan {
                    start,
                    end: i,
                    payload: &text[start + 1..i],
                    max_depth,
                });
            }
        }
    }
    None
}

fn number_list(text: &str) -> Option<Vec<f64>> {
    let mut out = Vec::new();
    for part in text.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let n = parse_f64_token(p.as_bytes());
        if !n.is_finite() {
            return None;
        }
        out.push(n);
    }
    if out.is_empty() { None } else { Some(out) }
}

fn is_signed_int(tok: &str) -> bool {
    let b = tok.as_bytes();
    if b.is_empty() {
        return false;
    }
    let start = if b[0] == b'+' || b[0] == b'-' { 1 } else { 0 };
    start < b.len() && b[start..].iter().all(|c| c.is_ascii_digit())
}

pub fn parse_constraint_row<F: FnMut(String)>(line: &str, mut on_diag: F) -> ConstraintRow {
    let text = line.trim();
    let mut make_raw = |why: &str| -> ConstraintRow {
        on_diag(format!("{}; row kept verbatim: \"{}\"", why, text));
        ConstraintRow::Raw {
            text: text.to_string(),
        }
    };

    // Match `^([+-]?\d+)(\s[\s\S]*)$`
    let b = text.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start || i >= b.len() || !text[i..].starts_with(char::is_whitespace) {
        return make_raw("no leading constraint id");
    }
    let Ok(id_i64) = text[..i].parse::<i64>() else {
        return make_raw("unreadable constraint id");
    };
    let id = id_i64 as i32;
    let rest = &text[i..];

    let Some(span) = bracket_span(rest) else {
        return make_raw("no balanced [weights] group");
    };
    if span.max_depth > 1 {
        return make_raw("nested [[…]] relation matrix is not decomposable here");
    }

    let constant_text = rest[..span.start].trim();
    let constant = parse_f64_token(constant_text.as_bytes());
    if constant_text.is_empty()
        || constant_text.chars().any(char::is_whitespace)
        || !constant.is_finite()
    {
        return make_raw("constant column is not a single number");
    }

    let Some(weights) = number_list(span.payload) else {
        return make_raw("[weights] is not a comma-separated list of numbers");
    };

    let tail = rest[span.end + 1..].trim();
    if !tail.is_empty() && bracket_span(tail).is_some() {
        return make_raw("a second [ … ] group follows the weights");
    }

    let mut ids: Vec<i32> = Vec::new();
    let mut valid_tail = !tail.is_empty();
    if valid_tail {
        for tok in tail.split_whitespace() {
            if !is_signed_int(tok) {
                valid_tail = false;
                break;
            }
            if let Ok(v) = tok.parse::<i64>() {
                ids.push(v as i32);
            } else {
                valid_tail = false;
                break;
            }
        }
    }
    if !valid_tail || ids.is_empty() {
        return make_raw("the columns after [weights] are not a run of node ids");
    }
    if ids.len() <= weights.len() {
        return make_raw(&format!(
            "{} weight(s) but only {} trailing node id(s) — no slave column left",
            weights.len(),
            ids.len()
        ));
    }

    let split_at = ids.len() - weights.len();
    let master_ids = ids.split_off(split_at);
    let slave_ids = ids;

    ConstraintRow::Linear {
        id,
        constant,
        weights,
        slave_ids,
        master_ids,
    }
}

pub fn push_constraint_row(out: &mut Vec<u8>, row: &ConstraintRow) {
    match row {
        ConstraintRow::Raw { text } => {
            out.extend_from_slice(text.as_bytes());
        }
        ConstraintRow::Linear {
            id,
            constant,
            weights,
            slave_ids,
            master_ids,
        } => {
            let mut ibuf = itoa::Buffer::new();
            out.extend_from_slice(ibuf.format(*id).as_bytes());
            out.push(b' ');
            push_constraint_num(out, *constant);
            out.extend_from_slice(b" [");
            for (i, &w) in weights.iter().enumerate() {
                if i > 0 {
                    out.extend_from_slice(b", ");
                }
                push_constraint_num(out, w);
            }
            out.push(b']');
            for &sid in slave_ids {
                out.push(b' ');
                out.extend_from_slice(ibuf.format(sid).as_bytes());
            }
            for &mid in master_ids {
                out.push(b' ');
                out.extend_from_slice(ibuf.format(mid).as_bytes());
            }
        }
    }
}

pub fn group_rows_by_master_count<'a>(
    rows: &'a [ConstraintRow],
) -> Vec<(Option<usize>, Vec<&'a ConstraintRow>)> {
    let mut by_count: BTreeMap<usize, Vec<&'a ConstraintRow>> = BTreeMap::new();
    let mut raw: Vec<&'a ConstraintRow> = Vec::new();
    for r in rows {
        match r {
            ConstraintRow::Raw { .. } => raw.push(r),
            ConstraintRow::Linear { master_ids, .. } => {
                by_count.entry(master_ids.len()).or_default().push(r);
            }
        }
    }
    let mut out: Vec<(Option<usize>, Vec<&'a ConstraintRow>)> = by_count
        .into_iter()
        .map(|(k, v)| (Some(k), v))
        .collect();
    if !raw.is_empty() {
        out.push((None, raw));
    }
    out
}
