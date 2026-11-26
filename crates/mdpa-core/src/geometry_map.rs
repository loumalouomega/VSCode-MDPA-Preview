//! Exact port of `src/parser/geometryMap.ts` (`decodeTypeName`).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntityKind {
    Elements,
    Conditions,
    Geometries,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Elements => "Elements",
            EntityKind::Conditions => "Conditions",
            EntityKind::Geometries => "Geometries",
        }
    }
}

pub mod vtk {
    pub const VERTEX: u32 = 1;
    pub const LINE: u32 = 3;
    pub const TRIANGLE: u32 = 5;
    pub const QUAD: u32 = 9;
    pub const TETRA: u32 = 10;
    pub const HEXAHEDRON: u32 = 12;
    pub const WEDGE: u32 = 13;
    pub const PYRAMID: u32 = 14;
    pub const QUADRATIC_EDGE: u32 = 21;
    pub const QUADRATIC_TRIANGLE: u32 = 22;
    pub const QUADRATIC_QUAD: u32 = 23;
    pub const QUADRATIC_TETRA: u32 = 24;
    pub const QUADRATIC_HEXAHEDRON: u32 = 25;
    pub const QUADRATIC_WEDGE: u32 = 26;
    pub const QUADRATIC_PYRAMID: u32 = 27;
    pub const BIQUADRATIC_QUAD: u32 = 28;
    pub const TRIQUADRATIC_HEXAHEDRON: u32 = 29;
    pub const QUADRATIC_WEDGE_18: u32 = 32;
}

const FAMILY_WORDS: &[&str] = &[
    "point",
    "line",
    "triangle",
    "quadrilateral",
    "tetrahedra",
    "hexahedra",
    "prism",
    "pyramid",
];

fn by_dim_nodes(dim: u32, nodes: u32) -> Option<u32> {
    match (dim, nodes) {
        (2, 1) => Some(vtk::VERTEX),
        (2, 2) => Some(vtk::LINE),
        (2, 3) => Some(vtk::TRIANGLE),
        (2, 4) => Some(vtk::QUAD),
        (2, 6) => Some(vtk::QUADRATIC_TRIANGLE),
        (2, 8) => Some(vtk::QUADRATIC_QUAD),
        (2, 9) => Some(vtk::BIQUADRATIC_QUAD),
        (3, 1) => Some(vtk::VERTEX),
        (3, 2) => Some(vtk::LINE),
        (3, 3) => Some(vtk::TRIANGLE),
        (3, 4) => Some(vtk::TETRA),
        (3, 5) => Some(vtk::PYRAMID),
        (3, 6) => Some(vtk::WEDGE),
        (3, 8) => Some(vtk::HEXAHEDRON),
        (3, 10) => Some(vtk::QUADRATIC_TETRA),
        (3, 13) => Some(vtk::QUADRATIC_PYRAMID),
        (3, 15) => Some(vtk::QUADRATIC_WEDGE),
        (3, 18) => Some(vtk::QUADRATIC_WEDGE_18),
        (3, 20) => Some(vtk::QUADRATIC_HEXAHEDRON),
        (3, 27) => Some(vtk::TRIQUADRATIC_HEXAHEDRON),
        _ => None,
    }
}

fn by_family_nodes(family: &str, nodes: u32) -> Option<u32> {
    match (family, nodes) {
        ("point", 1) => Some(vtk::VERTEX),
        ("line", 2) => Some(vtk::LINE),
        ("line", 3) => Some(vtk::QUADRATIC_EDGE),
        ("triangle", 3) => Some(vtk::TRIANGLE),
        ("triangle", 6) => Some(vtk::QUADRATIC_TRIANGLE),
        ("quadrilateral", 4) => Some(vtk::QUAD),
        ("quadrilateral", 8) => Some(vtk::QUADRATIC_QUAD),
        ("quadrilateral", 9) => Some(vtk::BIQUADRATIC_QUAD),
        ("tetrahedra", 4) => Some(vtk::TETRA),
        ("tetrahedra", 10) => Some(vtk::QUADRATIC_TETRA),
        ("hexahedra", 8) => Some(vtk::HEXAHEDRON),
        ("hexahedra", 20) => Some(vtk::QUADRATIC_HEXAHEDRON),
        ("hexahedra", 27) => Some(vtk::TRIQUADRATIC_HEXAHEDRON),
        ("prism", 6) => Some(vtk::WEDGE),
        ("prism", 15) => Some(vtk::QUADRATIC_WEDGE),
        ("pyramid", 5) => Some(vtk::PYRAMID),
        ("pyramid", 13) => Some(vtk::QUADRATIC_PYRAMID),
        _ => None,
    }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Match trailing `([23])D(\d+)N$`
fn match_suffix_dim_nodes(s: &str) -> Option<(u32, u32)> {
    let bytes = s.as_bytes();
    if bytes.len() < 4 || *bytes.last()? != b'N' {
        return None;
    }
    let mut i = bytes.len() - 1;
    let digits_end = i;
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
    }
    if i == digits_end || i < 2 {
        return None;
    }
    if bytes[i - 1] != b'D' {
        return None;
    }
    let dim_b = bytes[i - 2];
    if dim_b != b'2' && dim_b != b'3' {
        return None;
    }
    let dim = (dim_b - b'0') as u32;
    let nodes: u32 = s[i..digits_end].parse().ok()?;
    Some((dim, nodes))
}

/// Match first `([23])D`
fn match_first_dim(s: &str) -> Option<u32> {
    let bytes = s.as_bytes();
    for i in 0..bytes.len().saturating_sub(1) {
        if (bytes[i] == b'2' || bytes[i] == b'3') && bytes[i + 1] == b'D' {
            return Some((bytes[i] - b'0') as u32);
        }
    }
    None
}

/// Match `(\d+)N\b` or fallback `(\d+)$`
fn match_node_count(s: &str) -> Option<u32> {
    let bytes = s.as_bytes();
    // First try (\d+)N\b
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'N' {
                let after = i + 1;
                if after == bytes.len() || !is_word_byte(bytes[after]) {
                    if let Ok(n) = s[start..i].parse::<u32>() {
                        return Some(n);
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    // Fallback: (\d+)$
    let mut end = bytes.len();
    let mut start = end;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start < end {
        return s[start..end].parse::<u32>().ok();
    }
    let _ = &mut end;
    None
}

pub fn decode_type_name(raw_name: &str, kind: Option<EntityKind>) -> Option<u32> {
    let name = raw_name.trim();
    let lower = name.to_ascii_lowercase();

    let (dimension, node_count) = if let Some((d, n)) = match_suffix_dim_nodes(name) {
        (Some(d), Some(n))
    } else {
        (match_first_dim(name), match_node_count(name))
    };

    let mut family: Option<&str> = None;
    for &fam in FAMILY_WORDS {
        if lower.contains(fam) {
            family = Some(fam);
            break;
        }
    }

    let mut vtk_cell_type = None;
    if let (Some(d), Some(n)) = (dimension, node_count) {
        if let Some(hit) = by_dim_nodes(d, n) {
            vtk_cell_type = Some(hit);
        }
    }
    if vtk_cell_type.is_none() {
        if let (Some(f), Some(n)) = (family, node_count) {
            vtk_cell_type = by_family_nodes(f, n);
        }
    }

    if kind == Some(EntityKind::Conditions) && dimension == Some(3) {
        if let Some(ct) = vtk_cell_type {
            vtk_cell_type = Some(match ct {
                vtk::TETRA => vtk::QUAD,
                vtk::WEDGE => vtk::QUADRATIC_TRIANGLE,
                vtk::HEXAHEDRON => vtk::QUADRATIC_QUAD,
                other => other,
            });
        } else if node_count == Some(9) {
            vtk_cell_type = Some(vtk::BIQUADRATIC_QUAD);
        }
    }

    vtk_cell_type
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode() {
        assert_eq!(decode_type_name("Element2D3N", Some(EntityKind::Elements)), Some(vtk::TRIANGLE));
        assert_eq!(decode_type_name("LineCondition2D2N", Some(EntityKind::Conditions)), Some(vtk::LINE));
        assert_eq!(decode_type_name("SurfaceCondition3D4N", Some(EntityKind::Conditions)), Some(vtk::QUAD));
        assert_eq!(decode_type_name("SurfaceCondition3D9N", Some(EntityKind::Conditions)), Some(vtk::BIQUADRATIC_QUAD));
        assert_eq!(decode_type_name("Triangle2D3", Some(EntityKind::Geometries)), Some(vtk::TRIANGLE));
        assert_eq!(decode_type_name("Line2D2", Some(EntityKind::Geometries)), Some(vtk::LINE));
        assert_eq!(decode_type_name("TotalLagrangianElement3D10N", Some(EntityKind::Elements)), Some(vtk::QUADRATIC_TETRA));
    }
}
