// Screen-space labelling as data (roadmap item 22 F). Projection and
// declutter are plain typed-array maths so Node can test them and so a label
// pass over 100 000 nodes allocates nothing per point.

/** The pane's rectangle in CSS pixels, y measured from the TOP of the canvas. */
export interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ProjectedPoints {
  /** CSS pixels from the canvas's left edge. */
  x: Float32Array;
  /** CSS pixels from the canvas's top edge. */
  y: Float32Array;
  /** NDC depth, -1 near .. 1 far. */
  z: Float32Array;
  /** 1 when the point is in front of the far plane and inside the tile. */
  inside: Uint8Array;
}

/**
 * Project world points through a row-major 4x4 composite (view x projection)
 * matrix — the layout vtk.js's `getCompositeProjectionMatrix` returns — into a
 * tile. A point behind the camera (w <= 0) is never inside.
 */
export function projectPoints(matrix: ArrayLike<number>, points: Float32Array, tile: TileRect): ProjectedPoints {
  const n = Math.floor(points.length / 3);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const inside = new Uint8Array(n);
  const m = matrix;
  for (let i = 0; i < n; i++) {
    const px = points[i * 3];
    const py = points[i * 3 + 1];
    const pz = points[i * 3 + 2];
    const w = m[12] * px + m[13] * py + m[14] * pz + m[15];
    if (!(w > 0)) continue;
    const nx = (m[0] * px + m[1] * py + m[2] * pz + m[3]) / w;
    const ny = (m[4] * px + m[5] * py + m[6] * pz + m[7]) / w;
    const nz = (m[8] * px + m[9] * py + m[10] * pz + m[11]) / w;
    x[i] = tile.left + (nx * 0.5 + 0.5) * tile.width;
    y[i] = tile.top + (1 - (ny * 0.5 + 0.5)) * tile.height;
    z[i] = nz;
    if (nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1 && nz >= -1 && nz <= 1) inside[i] = 1;
  }
  return { x, y, z, inside };
}

export interface LayoutOptions {
  /** Hard cap on labels returned. */
  maxLabels: number;
  /** Minimum spacing between kept labels, CSS pixels (declutter grid cell). */
  cell: number;
  /** Points to skip, 1 = hidden behind a surface (parallel to the projection). */
  hidden?: Uint8Array;
}

/**
 * The indices to label: inside the tile, not hidden, one per `cell`-sized grid
 * square (the first in index order wins, so the choice is stable across camera
 * moves that do not change which squares are occupied), at most `maxLabels`.
 */
export function layoutLabels(p: ProjectedPoints, tile: TileRect, o: LayoutOptions): number[] {
  const cell = Math.max(1, o.cell);
  const cols = Math.max(1, Math.ceil(tile.width / cell));
  const rows = Math.max(1, Math.ceil(tile.height / cell));
  const taken = new Uint8Array(cols * rows);
  const keep: number[] = [];
  for (let i = 0; i < p.inside.length && keep.length < o.maxLabels; i++) {
    if (!p.inside[i] || (o.hidden && o.hidden[i])) continue;
    const c = Math.floor((p.x[i] - tile.left) / cell);
    const r = Math.floor((p.y[i] - tile.top) / cell);
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const k = r * cols + c;
    if (taken[k]) continue;
    taken[k] = 1;
    keep.push(i);
  }
  return keep;
}

/**
 * Occlusion against a depth snapshot: a point is hidden when something nearer
 * was drawn at its pixel. `depth` holds the buffer's NDC depth per device
 * pixel (row 0 at the BOTTOM, as GL returns it); `scale` converts CSS to device
 * pixels. `eps` absorbs the depth buffer's quantisation.
 */
export function occludedPoints(
  p: ProjectedPoints,
  depth: Float32Array,
  depthWidth: number,
  depthHeight: number,
  scale: number,
  canvasCssHeight: number,
  eps: number
): Uint8Array {
  const hidden = new Uint8Array(p.inside.length);
  for (let i = 0; i < p.inside.length; i++) {
    if (!p.inside[i]) continue;
    const dx = Math.floor(p.x[i] * scale);
    const dy = Math.floor((canvasCssHeight - p.y[i]) * scale);
    if (dx < 0 || dx >= depthWidth || dy < 0 || dy >= depthHeight) continue;
    if (p.z[i] > depth[dy * depthWidth + dx] + eps) hidden[i] = 1;
  }
  return hidden;
}
