//! Exact port of `src/parser/propertiesParser.ts`.

use serde::{Deserialize, Serialize};

use crate::num_fmt::{format_num_string, parse_f64_token, push_num};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PropertyValue {
    #[serde(rename = "number")]
    Number { value: f64 },
    #[serde(rename = "bool")]
    Bool { value: bool },
    #[serde(rename = "vector")]
    Vector { values: Vec<f64> },
    #[serde(rename = "matrix")]
    Matrix { rows: Vec<Vec<f64>> },
    #[serde(rename = "string")]
    String { value: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertyTable {
    pub args: Vec<String>,
    pub rows: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropertySet {
    pub id: i32,
    /// Preserves insertion order (reconstructed into `Object.create(null)` on the JS side).
    pub variables: Vec<(String, PropertyValue)>,
    pub tables: Vec<PropertyTable>,
}

impl PropertySet {
    pub fn empty(id: i32) -> Self {
        Self {
            id,
            variables: Vec::new(),
            tables: Vec::new(),
        }
    }

    pub fn set_variable(&mut self, name: String, value: PropertyValue) {
        if let Some(entry) = self.variables.iter_mut().find(|(k, _)| k == &name) {
            entry.1 = value;
        } else {
            self.variables.push((name, value));
        }
    }
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

fn unwrap_parens(text: &str) -> Option<&str> {
    let t = text.trim();
    if t.starts_with('(') && t.ends_with(')') && t.len() >= 2 {
        Some(&t[1..t.len() - 1])
    } else {
        None
    }
}

/// Match `^\[\s*(\d+)\s*(?:,\s*(\d+)\s*)?\]\s*(.*)$`
fn parse_dim_spec(text: &str) -> Option<(usize, Option<usize>, &str)> {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let r_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == r_start {
        return None;
    }
    let rows_declared: usize = text[r_start..i].parse().ok()?;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    let cols_declared = if i < bytes.len() && bytes[i] == b',' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let c_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == c_start {
            return None;
        }
        let cols: usize = text[c_start..i].parse().ok()?;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        Some(cols)
    } else {
        None
    };
    if i >= bytes.len() || bytes[i] != b']' {
        return None;
    }
    i += 1;
    let payload = text[i..].trim();
    Some((rows_declared, cols_declared, payload))
}

pub fn parse_property_value<F: FnMut(String)>(raw: &str, mut on_diag: F) -> PropertyValue {
    let text = raw.trim();
    if text.is_empty() {
        return PropertyValue::String {
            value: String::new(),
        };
    }

    if let Some((rows_declared, cols_declared, payload)) = parse_dim_spec(text) {
        if cols_declared.is_none() {
            let values = unwrap_parens(payload).and_then(number_list);
            let Some(values) = values else {
                on_diag(format!(
                    "vector value \"{}\" is not a parenthesised list of numbers.",
                    text
                ));
                return PropertyValue::String {
                    value: text.to_string(),
                };
            };
            if values.len() != rows_declared {
                on_diag(format!(
                    "vector declares [{}] but carries {} value(s); keeping the values as written.",
                    rows_declared,
                    values.len()
                ));
            }
            return PropertyValue::Vector { values };
        }

        let cols_declared = cols_declared.unwrap();
        let Some(outer) = unwrap_parens(payload) else {
            on_diag(format!("matrix value \"{}\" is not parenthesised.", text));
            return PropertyValue::String {
                value: text.to_string(),
            };
        };

        // Match all `\(([^()]*)\)` in `outer`
        let mut rows: Vec<Vec<f64>> = Vec::new();
        let mut bad = false;
        let ob = outer.as_bytes();
        let mut i = 0;
        while i < ob.len() {
            if ob[i] == b'(' {
                let start = i + 1;
                let mut j = start;
                while j < ob.len() && ob[j] != b'(' && ob[j] != b')' {
                    j += 1;
                }
                if j < ob.len() && ob[j] == b')' {
                    if let Some(nums) = number_list(&outer[start..j]) {
                        rows.push(nums);
                    } else {
                        bad = true;
                        break;
                    }
                    i = j + 1;
                } else {
                    i = j;
                }
            } else {
                i += 1;
            }
        }

        if bad || rows.is_empty() {
            on_diag(format!(
                "matrix value \"{}\" does not parse as rows of numbers.",
                text
            ));
            return PropertyValue::String {
                value: text.to_string(),
            };
        }
        if rows.len() != rows_declared || rows.iter().any(|r| r.len() != cols_declared) {
            let lens: Vec<String> = rows.iter().map(|r| r.len().to_string()).collect();
            on_diag(format!(
                "matrix declares [{},{}] but carries {} row(s) of {}; keeping the values as written.",
                rows_declared,
                cols_declared,
                rows.len(),
                lens.join("/")
            ));
        }
        return PropertyValue::Matrix { rows };
    }

    if !text.bytes().any(|b| b.is_ascii_whitespace()) && !text.chars().any(|c| c.is_whitespace()) {
        match text {
            "true" | "True" => return PropertyValue::Bool { value: true },
            "false" | "False" => return PropertyValue::Bool { value: false },
            _ => {}
        }
        let n = parse_f64_token(text.as_bytes());
        if n.is_finite() {
            return PropertyValue::Number { value: n };
        }
    }

    PropertyValue::String {
        value: text.to_string(),
    }
}

pub fn add_property_line<F: FnMut(String)>(
    set: &mut PropertySet,
    first_token: &str,
    line: &str,
    mut on_diag: F,
) {
    if first_token.is_empty() {
        return;
    }
    let rest = line[first_token.len()..].trim();
    let id = set.id;
    let val = parse_property_value(rest, |m| {
        on_diag(format!("Properties {}, {}: {}", id, first_token, m));
    });
    set.set_variable(first_token.to_string(), val);
}

pub fn push_property_value(out: &mut Vec<u8>, v: &PropertyValue) {
    match v {
        PropertyValue::Number { value } => push_num(out, *value),
        PropertyValue::Bool { value } => {
            out.extend_from_slice(if *value { b"True" } else { b"False" });
        }
        PropertyValue::Vector { values } => {
            out.push(b'[');
            let mut ibuf = itoa::Buffer::new();
            out.extend_from_slice(ibuf.format(values.len()).as_bytes());
            out.extend_from_slice(b"] (");
            for (i, &val) in values.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                push_num(out, val);
            }
            out.push(b')');
        }
        PropertyValue::Matrix { rows } => {
            let cols = rows.first().map_or(0, |r| r.len());
            out.push(b'[');
            let mut ibuf = itoa::Buffer::new();
            out.extend_from_slice(ibuf.format(rows.len()).as_bytes());
            out.push(b',');
            out.extend_from_slice(ibuf.format(cols).as_bytes());
            out.extend_from_slice(b"] (");
            for (ri, row) in rows.iter().enumerate() {
                if ri > 0 {
                    out.push(b',');
                }
                out.push(b'(');
                for (ci, &val) in row.iter().enumerate() {
                    if ci > 0 {
                        out.push(b',');
                    }
                    push_num(out, val);
                }
                out.push(b')');
            }
            out.push(b')');
        }
        PropertyValue::String { value } => {
            out.extend_from_slice(value.as_bytes());
        }
    }
}

pub fn format_property_table_lines(t: &PropertyTable) -> Vec<String> {
    let mut lines = Vec::with_capacity(t.rows.len() + 2);
    if t.args.is_empty() {
        lines.push("Begin Table".to_string());
    } else {
        lines.push(format!("Begin Table {}", t.args.join(" ")));
    }
    for row in &t.rows {
        let mut s = String::from("  ");
        for (i, &v) in row.iter().enumerate() {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(&format_num_string(v));
        }
        lines.push(s);
    }
    lines.push("End Table".to_string());
    lines
}
