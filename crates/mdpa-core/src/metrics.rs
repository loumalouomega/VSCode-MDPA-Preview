//! Per-cell solver-oriented element quality metrics (roadmap item 87, Phase 2).
//!
//! Mirrors the shape kernels of `src/parser/elementMetrics.ts` operation for
//! operation so the two agree to floating-point noise. Classification into
//! quality bands, histograms and block medians stay in TypeScript: this module
//! only produces the raw per-cell values, `NaN` meaning "not applicable".

use std::collections::HashMap;

type V3 = [f64; 3];

pub const OUT_PER_CELL: usize = 6; // sj, skew, warp, taper, radius ratio, volume

struct Shape {
    corners: usize,
    dim: usize,
    scale: f64,
    frames: &'static [&'static [usize]],
    faces: &'static [&'static [usize]],
    mids: &'static [(usize, usize, usize)],
}

static TRI_FRAMES: &[&[usize]] = &[&[1, 2], &[2, 0], &[0, 1]];
static TRI_FACES: &[&[usize]] = &[&[0, 1, 2]];
static TRI_MIDS: &[(usize, usize, usize)] = &[(0, 1, 3), (1, 2, 4), (2, 0, 5)];
static QUAD_FRAMES: &[&[usize]] = &[&[1, 3], &[2, 0], &[3, 1], &[0, 2]];
static QUAD_FACES: &[&[usize]] = &[&[0, 1, 2, 3]];
static QUAD_MIDS: &[(usize, usize, usize)] = &[(0, 1, 4), (1, 2, 5), (2, 3, 6), (3, 0, 7)];
static TET_FRAMES: &[&[usize]] = &[&[1, 2, 3], &[0, 3, 2], &[0, 1, 3], &[0, 2, 1]];
static TET_FACES: &[&[usize]] = &[&[0, 1, 2], &[0, 3, 1], &[0, 2, 3], &[1, 3, 2]];
static TET_MIDS: &[(usize, usize, usize)] =
    &[(0, 1, 4), (1, 2, 5), (2, 0, 6), (0, 3, 7), (1, 3, 8), (2, 3, 9)];
static HEX_FRAMES: &[&[usize]] = &[
    &[1, 3, 4],
    &[2, 0, 5],
    &[3, 1, 6],
    &[0, 2, 7],
    &[7, 5, 0],
    &[4, 6, 1],
    &[5, 7, 2],
    &[6, 4, 3],
];
static HEX_FACES: &[&[usize]] = &[
    &[0, 1, 2, 3],
    &[4, 7, 6, 5],
    &[0, 4, 5, 1],
    &[1, 5, 6, 2],
    &[2, 6, 7, 3],
    &[3, 7, 4, 0],
];
static HEX_MIDS: &[(usize, usize, usize)] = &[
    (0, 1, 8),
    (1, 2, 9),
    (2, 3, 10),
    (3, 0, 11),
    (4, 5, 12),
    (5, 6, 13),
    (6, 7, 14),
    (7, 4, 15),
    (0, 4, 16),
    (1, 5, 17),
    (2, 6, 18),
    (3, 7, 19),
];
static WEDGE_FRAMES: &[&[usize]] = &[
    &[2, 1, 3],
    &[0, 2, 4],
    &[1, 0, 5],
    &[4, 5, 0],
    &[5, 3, 1],
    &[3, 4, 2],
];
static NONE: &[&[usize]] = &[];
static NO_MIDS: &[(usize, usize, usize)] = &[];

/// Shape ids shared with `SHAPE_IDS` in `elementMetrics.ts`.
pub const SHAPE_TET: u32 = 5;

fn shape_by_id(id: u32) -> Option<Shape> {
    let s3 = 2.0 / 3f64.sqrt();
    Some(match id {
        1 => Shape { corners: 3, dim: 2, scale: s3, frames: TRI_FRAMES, faces: TRI_FACES, mids: NO_MIDS },
        2 => Shape { corners: 3, dim: 2, scale: s3, frames: TRI_FRAMES, faces: TRI_FACES, mids: TRI_MIDS },
        3 => Shape { corners: 4, dim: 2, scale: 1.0, frames: QUAD_FRAMES, faces: QUAD_FACES, mids: NO_MIDS },
        4 => Shape { corners: 4, dim: 2, scale: 1.0, frames: QUAD_FRAMES, faces: QUAD_FACES, mids: QUAD_MIDS },
        5 => Shape { corners: 4, dim: 3, scale: std::f64::consts::SQRT_2, frames: TET_FRAMES, faces: TET_FACES, mids: NO_MIDS },
        6 => Shape { corners: 4, dim: 3, scale: std::f64::consts::SQRT_2, frames: TET_FRAMES, faces: TET_FACES, mids: TET_MIDS },
        7 => Shape { corners: 8, dim: 3, scale: 1.0, frames: HEX_FRAMES, faces: HEX_FACES, mids: NO_MIDS },
        8 => Shape { corners: 8, dim: 3, scale: 1.0, frames: HEX_FRAMES, faces: HEX_FACES, mids: HEX_MIDS },
        9 => Shape { corners: 6, dim: 3, scale: s3, frames: WEDGE_FRAMES, faces: NONE, mids: NO_MIDS },
        _ => return None,
    })
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
/// `Math.max` semantics: NaN propagates.
fn jsmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}
fn acos_clamped(x: f64) -> f64 {
    // Math.max(-1, Math.min(1, x)) with NaN propagating.
    if x.is_nan() {
        f64::NAN
    } else {
        x.min(1.0).max(-1.0).acos()
    }
}
const RAD2DEG: f64 = 180.0 / std::f64::consts::PI;

fn tangent(pts: &[V3], s: &Shape, c: usize, n: usize) -> V3 {
    for &(a, b, m) in s.mids {
        if (a == c && b == n) || (a == n && b == c) {
            if m < pts.len() {
                let p = pts[m];
                return [
                    4.0 * p[0] - 3.0 * pts[c][0] - pts[n][0],
                    4.0 * p[1] - 3.0 * pts[c][1] - pts[n][1],
                    4.0 * p[2] - 3.0 * pts[c][2] - pts[n][2],
                ];
            }
            break;
        }
    }
    sub(pts[n], pts[c])
}

fn newell(pts: &[V3], face: &[usize]) -> V3 {
    let mut n = [0.0; 3];
    for k in 0..face.len() {
        let a = pts[face[k]];
        let b = pts[face[(k + 1) % face.len()]];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

fn scaled_jacobian(pts: &[V3], s: &Shape) -> f64 {
    let nrm = if s.dim == 2 { Some(newell(pts, s.faces[0])) } else { None };
    let nl = nrm.map(norm).unwrap_or(0.0);
    if s.dim == 2 && nl == 0.0 {
        return f64::NAN;
    }
    let mut worst = f64::INFINITY;
    for c in 0..s.corners {
        let fr = s.frames[c];
        let mut e = [[0.0; 3]; 3];
        let mut lens = [1.0; 3];
        let mut zero = false;
        for (i, &n) in fr.iter().enumerate() {
            e[i] = tangent(pts, s, c, n);
            lens[i] = norm(e[i]);
            if lens[i] == 0.0 {
                zero = true;
            }
        }
        if zero {
            return 0.0;
        }
        let det = if s.dim == 3 {
            dot(cross(e[0], e[1]), e[2])
        } else {
            dot(cross(e[0], e[1]), nrm.unwrap()) / nl
        };
        let mut prod = 1.0;
        for l in lens.iter().take(fr.len()) {
            prod *= *l;
        }
        let v = (det / prod) * s.scale;
        if v < worst {
            worst = v;
        }
    }
    worst
}

fn skewness(pts: &[V3], s: &Shape) -> f64 {
    if s.faces.is_empty() {
        return f64::NAN;
    }
    let mut worst = 0.0;
    for f in s.faces {
        let ideal = if f.len() == 3 { 60.0 } else { 90.0 };
        let n = f.len();
        for k in 0..n {
            let p = pts[f[(k + n - 1) % n]];
            let c = pts[f[k]];
            let q = pts[f[(k + 1) % n]];
            let a = sub(p, c);
            let b = sub(q, c);
            let la = norm(a);
            let lb = norm(b);
            let ang = if la == 0.0 || lb == 0.0 {
                0.0
            } else {
                acos_clamped(dot(a, b) / (la * lb)) * RAD2DEG
            };
            let sk = jsmax((ang - ideal) / (180.0 - ideal), (ideal - ang) / ideal);
            if sk > worst {
                worst = sk;
            }
        }
    }
    worst
}

fn tri_normal(a: V3, b: V3, c: V3) -> V3 {
    cross(sub(b, a), sub(c, a))
}

fn quad_warpage(pts: &[V3], f: &[usize]) -> f64 {
    let (a, b, c, d) = (pts[f[0]], pts[f[1]], pts[f[2]], pts[f[3]]);
    let ang = |n1: V3, n2: V3| -> f64 {
        let l1 = norm(n1);
        let l2 = norm(n2);
        if l1 == 0.0 || l2 == 0.0 {
            return 0.0;
        }
        acos_clamped(dot(n1, n2) / (l1 * l2)) * RAD2DEG
    };
    jsmax(
        ang(tri_normal(a, b, c), tri_normal(a, c, d)),
        ang(tri_normal(a, b, d), tri_normal(b, c, d)),
    )
}

fn quad_taper(pts: &[V3], f: &[usize]) -> f64 {
    let l = |i: usize, j: usize| norm(sub(pts[f[i]], pts[f[j]]));
    let rel = |x: f64, y: f64| {
        let m = jsmax(x, y);
        if m > 0.0 {
            (x - y).abs() / m
        } else {
            0.0
        }
    };
    jsmax(rel(l(0, 1), l(2, 3)), rel(l(1, 2), l(3, 0)))
}

fn over_quads(pts: &[V3], s: &Shape, f: fn(&[V3], &[usize]) -> f64) -> f64 {
    let mut any = false;
    let mut m = f64::NEG_INFINITY;
    for face in s.faces.iter().filter(|f| f.len() == 4) {
        any = true;
        m = jsmax(m, f(pts, face));
    }
    if any {
        m
    } else {
        f64::NAN
    }
}

fn radius_ratio(pts: &[V3]) -> f64 {
    let (p0, p1, p2, p3) = (pts[0], pts[1], pts[2], pts[3]);
    let a = sub(p1, p0);
    let b = sub(p2, p0);
    let c = sub(p3, p0);
    let vol = dot(a, cross(b, c)).abs() / 6.0;
    if vol == 0.0 {
        return 0.0;
    }
    let area = (norm(cross(a, b)) + norm(cross(b, c)) + norm(cross(c, a)) + norm(cross(sub(p2, p1), sub(p3, p1)))) / 2.0;
    let inr = (3.0 * vol) / area;
    let t1 = cross(b, c);
    let t2 = cross(c, a);
    let t3 = cross(a, b);
    let (aa, bb, cc) = (dot(a, a), dot(b, b), dot(c, c));
    let mut num = [0.0; 3];
    for k in 0..3 {
        num[k] = aa * t1[k] + bb * t2[k] + cc * t3[k];
    }
    let circ = norm(num) / (12.0 * vol);
    if circ > 0.0 {
        (3.0 * inr) / circ
    } else {
        0.0
    }
}

/// Holds the node table (id -> row) so many blocks reuse one index.
pub struct MetricsMesh {
    index: HashMap<i32, usize>,
    coords: Vec<f32>,
}

impl MetricsMesh {
    pub fn new(node_ids: &[i32], coords: &[f32]) -> Self {
        let mut index = HashMap::with_capacity(node_ids.len());
        for (i, id) in node_ids.iter().enumerate() {
            index.insert(*id, i);
        }
        MetricsMesh { index, coords: coords.to_vec() }
    }

    /// `decomp_kind`: 0 none, 1 triangles (3 per entry), 2 tetrahedra (4 per entry).
    /// Output: `OUT_PER_CELL` values per cell, `NaN` for not applicable or skipped
    /// cells. Slot 5 (the measure) is finite exactly when the cell was usable.
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
    ) -> Vec<f64> {
        let shape = shape_by_id(shape_id);
        let mut out = vec![f64::NAN; count * OUT_PER_CELL];
        let mut pts: Vec<V3> = Vec::with_capacity(need.max(1));
        for i in 0..count {
            let base = i * stride;
            pts.clear();
            let mut ok = stride >= need || shape.as_ref().map_or(false, |s| stride >= s.corners);
            if ok {
                for k in 0..stride.min(need) {
                    match connectivity.get(base + k).and_then(|id| self.index.get(id)) {
                        Some(&idx) => pts.push([
                            self.coords[idx * 3] as f64,
                            self.coords[idx * 3 + 1] as f64,
                            self.coords[idx * 3 + 2] as f64,
                        ]),
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
            }
            if !ok {
                continue;
            }
            let o = &mut out[i * OUT_PER_CELL..(i + 1) * OUT_PER_CELL];
            if let Some(s) = &shape {
                o[0] = scaled_jacobian(&pts, s);
                o[1] = skewness(&pts, s);
                o[2] = over_quads(&pts, s, quad_warpage);
                o[3] = over_quads(&pts, s, quad_taper);
                if shape_id == SHAPE_TET {
                    o[4] = radius_ratio(&pts);
                }
            }
            if decomp_kind == 2 {
                let mut total = 0.0;
                for t in decomp.chunks_exact(4) {
                    let p = |k: i32| pts.get(k as usize).copied();
                    if let (Some(a), Some(b), Some(c), Some(d)) = (p(t[0]), p(t[1]), p(t[2]), p(t[3])) {
                        total += dot(sub(b, a), cross(sub(c, a), sub(d, a))).abs() / 6.0;
                    }
                }
                o[5] = total;
            } else if decomp_kind == 1 {
                let mut total = 0.0;
                for t in decomp.chunks_exact(3) {
                    let p = |k: i32| pts.get(k as usize).copied();
                    if let (Some(a), Some(b), Some(c)) = (p(t[0]), p(t[1]), p(t[2])) {
                        total += norm(tri_normal(a, b, c)) / 2.0;
                    }
                }
                o[5] = total;
            }
        }
        out
    }
}
