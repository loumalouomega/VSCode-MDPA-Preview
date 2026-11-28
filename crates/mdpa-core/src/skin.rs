//! Boundary-skin extraction for volume/surface meshes (roadmap item 87, Phase 2).
//!
//! Mirrors `src/parser/extractSkin.ts` (`extractSkinModel`): records surface
//! cells first, then walks volume cell faces keyed by sorted corner node IDs
//! `(len, [i32; 4])` without heap allocations per face, keeping faces seen once
//! in first-seen order and grouping them by `(vtk_type, stride)`.

use std::collections::{HashMap, HashSet};

use crate::geometry_map::vtk;

const TET_FACES: &[&[usize]] = &[&[0, 1, 2], &[0, 3, 1], &[0, 2, 3], &[1, 3, 2]];
const HEX_FACES: &[&[usize]] = &[
    &[0, 1, 2, 3],
    &[4, 7, 6, 5],
    &[0, 4, 5, 1],
    &[1, 5, 6, 2],
    &[2, 6, 7, 3],
    &[3, 7, 4, 0],
];
const WEDGE_FACES: &[&[usize]] = &[
    &[0, 1, 2],
    &[3, 5, 4],
    &[0, 3, 4, 1],
    &[1, 4, 5, 2],
    &[2, 5, 3, 0],
];
const PYRAMID_FACES: &[&[usize]] = &[
    &[0, 3, 2, 1],
    &[0, 1, 4],
    &[1, 2, 4],
    &[2, 3, 4],
    &[3, 0, 4],
];

fn corner_count(vtk_type: u32) -> usize {
    match vtk_type {
        vtk::VERTEX => 1,
        vtk::LINE | vtk::QUADRATIC_EDGE => 2,
        vtk::TRIANGLE | vtk::QUADRATIC_TRIANGLE => 3,
        vtk::QUAD | vtk::QUADRATIC_QUAD | vtk::BIQUADRATIC_QUAD | vtk::TETRA | vtk::QUADRATIC_TETRA => 4,
        vtk::PYRAMID | vtk::QUADRATIC_PYRAMID => 5,
        vtk::WEDGE | vtk::QUADRATIC_WEDGE => 6,
        vtk::HEXAHEDRON | vtk::QUADRATIC_HEXAHEDRON | vtk::TRIQUADRATIC_HEXAHEDRON => 8,
        _ => 0,
    }
}

fn volume_faces(vtk_type: u32) -> Option<&'static [&'static [usize]]> {
    match vtk_type {
        vtk::TETRA | vtk::QUADRATIC_TETRA => Some(TET_FACES),
        vtk::HEXAHEDRON | vtk::QUADRATIC_HEXAHEDRON | vtk::TRIQUADRATIC_HEXAHEDRON => Some(HEX_FACES),
        vtk::WEDGE | vtk::QUADRATIC_WEDGE => Some(WEDGE_FACES),
        vtk::PYRAMID | vtk::QUADRATIC_PYRAMID => Some(PYRAMID_FACES),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct FaceKey {
    len: u8,
    ids: [i32; 4],
}

impl FaceKey {
    fn from_slice(slice: &[i32]) -> Self {
        let mut ids = [i32::MAX; 4];
        let n = slice.len().min(4);
        ids[..n].copy_from_slice(&slice[..n]);
        ids[..n].sort_unstable();
        FaceKey { len: n as u8, ids }
    }
}

struct VolumeFaceRecord {
    node_ids: [i32; 4],
    len: u8,
    vtk_type: u32,
    count: u32,
}

pub struct SkinGroup {
    pub vtk_type: u32,
    pub stride: usize,
    pub count: usize,
    pub entity_ids: Vec<i32>,
    pub connectivity: Vec<i32>,
}

pub struct SkinExtractor {
    valid_nodes: HashSet<i32>,
    surface_keys: HashSet<FaceKey>,
    surface_faces: Vec<(u32, [i32; 4], u8)>,
    face_map: HashMap<FaceKey, usize>,
    face_records: Vec<VolumeFaceRecord>,
    groups: Vec<SkinGroup>,
    total_faces: usize,
}

impl SkinExtractor {
    pub fn new(node_ids: &[i32]) -> Self {
        let mut valid_nodes = HashSet::with_capacity(node_ids.len());
        for &id in node_ids {
            valid_nodes.insert(id);
        }
        SkinExtractor {
            valid_nodes,
            surface_keys: HashSet::new(),
            surface_faces: Vec::new(),
            face_map: HashMap::new(),
            face_records: Vec::new(),
            groups: Vec::new(),
            total_faces: 0,
        }
    }

    pub fn add_surface_block(&mut self, vtk_type: u32, connectivity: &[i32], count: usize, stride: usize) {
        let cc = corner_count(vtk_type);
        let corners = (if cc > 0 { cc } else { stride }).min(stride);
        if corners == 0 || corners > 4 {
            return;
        }
        for c in 0..count {
            let base = c * stride;
            if base + corners > connectivity.len() {
                break;
            }
            let slice = &connectivity[base..base + corners];
            if !slice.iter().all(|id| self.valid_nodes.contains(id)) {
                continue;
            }
            let mut arr = [0i32; 4];
            arr[..corners].copy_from_slice(slice);
            self.surface_faces.push((vtk_type, arr, corners as u8));
            self.surface_keys.insert(FaceKey::from_slice(slice));
        }
    }

    pub fn add_volume_block(&mut self, vtk_type: u32, connectivity: &[i32], count: usize, stride: usize) {
        let Some(vfaces) = volume_faces(vtk_type) else {
            return;
        };
        let cc = corner_count(vtk_type);
        let corners = (if cc > 0 { cc } else { stride }).min(stride);
        if corners == 0 || corners > 8 {
            return;
        }
        let mut cell_ids = [0i32; 8];
        for c in 0..count {
            let base = c * stride;
            if base + corners > connectivity.len() {
                break;
            }
            let slice = &connectivity[base..base + corners];
            if !slice.iter().all(|id| self.valid_nodes.contains(id)) {
                continue;
            }
            cell_ids[..corners].copy_from_slice(slice);
            for face in vfaces {
                let flen = face.len();
                let mut f_ids = [0i32; 4];
                for (k, &li) in face.iter().enumerate() {
                    f_ids[k] = cell_ids[li];
                }
                let key = FaceKey::from_slice(&f_ids[..flen]);
                if self.surface_keys.contains(&key) {
                    continue;
                }
                if let Some(&idx) = self.face_map.get(&key) {
                    self.face_records[idx].count += 1;
                } else {
                    let idx = self.face_records.len();
                    self.face_map.insert(key, idx);
                    self.face_records.push(VolumeFaceRecord {
                        node_ids: f_ids,
                        len: flen as u8,
                        vtk_type: if flen == 3 { vtk::TRIANGLE } else { vtk::QUAD },
                        count: 1,
                    });
                }
            }
        }
    }

    pub fn finish(&mut self) -> usize {
        self.groups.clear();
        self.total_faces = 0;
        let mut group_map: HashMap<(u32, usize), usize> = HashMap::new();
        let mut next_id: i32 = 1;

        let mut push_face = |vtk_type: u32, ids: &[i32]| {
            let stride = ids.len();
            let g_idx = if let Some(&idx) = group_map.get(&(vtk_type, stride)) {
                idx
            } else {
                let idx = self.groups.len();
                group_map.insert((vtk_type, stride), idx);
                self.groups.push(SkinGroup {
                    vtk_type,
                    stride,
                    count: 0,
                    entity_ids: Vec::new(),
                    connectivity: Vec::new(),
                });
                idx
            };
            self.groups[g_idx].count += 1;
            self.groups[g_idx].entity_ids.push(next_id);
            next_id += 1;
            self.groups[g_idx].connectivity.extend_from_slice(ids);
            self.total_faces += 1;
        };

        for &(vtk_type, ref arr, len) in &self.surface_faces {
            push_face(vtk_type, &arr[..len as usize]);
        }
        for rec in &self.face_records {
            if rec.count == 1 {
                push_face(rec.vtk_type, &rec.node_ids[..rec.len as usize]);
            }
        }

        self.total_faces
    }

    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    pub fn group_vtk_type(&self, idx: usize) -> u32 {
        self.groups[idx].vtk_type
    }

    pub fn group_stride(&self, idx: usize) -> usize {
        self.groups[idx].stride
    }

    pub fn group_face_count(&self, idx: usize) -> usize {
        self.groups[idx].count
    }

    pub fn group_entity_ids(&self, idx: usize) -> &[i32] {
        &self.groups[idx].entity_ids
    }

    pub fn group_connectivity(&self, idx: usize) -> &[i32] {
        &self.groups[idx].connectivity
    }
}
