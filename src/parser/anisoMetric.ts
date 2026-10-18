/**
 * Anisotropic metric assembly from a Hessian field. Pure module (no
 * vscode / DOM / wasm) so it stays Node-testable; consumed by `remesh.ts`'s
 * `aniso` mode and unit-tested here.
 *
 * MMG consumes a symmetric positive-definite metric M per vertex as 6
 * components (m11, m12, m13, m22, m23, m33) with
 * `setSolSize(..., MMG5_Tensor)` + `setTensorSols` + `IPARAM_anisosize`.
 * The Hessian of a solution is symmetric but almost never positive-definite,
 * so the assembly is: symmetrize → eigendecompose → take absolute values →
 * clamp to the [hmin, hmax] size band → reassemble. The clamping is part of
 * the operation, not a detail: without it a near-zero eigenvalue asks for an
 * infinite element and a huge one for a zero-size element.
 *
 * Scale handling: the tensor is scale-invariant. The largest |eigenvalue|
 * maps to hmin (finest resolution where the curvature is strongest) and
 * anything at or below (1/hmax^2)/s maps to hmax, where
 * s = (1/hmin^2) / max|λ|. A flat field (max|λ| == 0) yields an isotropic
 * hmax metric — nothing to resolve, so go coarse. Non-finite Hessian input
 * is dealt with by the caller (remesh.ts falls back to the local edge size),
 * but this module never returns a non-finite metric: a defensive isotropic
 * hmax comes back instead.
 */

export interface Eigen3 {
  /** Eigenvalues, descending |λ|. */
  values: [number, number, number];
  /** Eigenvectors as columns: vectors[i] belongs to values[i]. */
  vectors: [[number, number, number], [number, number, number], [number, number, number]];
}

/**
 * Eigendecomposition of a symmetric 3x3, given as the 6 upper-triangular
 * components [m11, m12, m13, m22, m23, m33]. Cyclic Jacobi rotations to a
 * 1e-12 off-diagonal tolerance (a few sweeps for 3x3).
 */
export function eigSym3(m: ArrayLike<number>): Eigen3 {
  // Working copy as a full matrix.
  const a: number[][] = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const v: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p][q];
        off += apq * apq;
        if (Math.abs(apq) < 1e-15) continue;
        const app = a[p][p];
        const aqq = a[q][q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
    if (off < 1e-24) break;
  }
  // Sort by descending |λ|, carrying the (column) eigenvectors along.
  const order = [0, 1, 2].sort((i, j) => Math.abs(a[j][j]) - Math.abs(a[i][i]));
  return {
    values: [a[order[0]][order[0]], a[order[1]][order[1]], a[order[2]][order[2]]],
    vectors: [
      [v[0][order[0]], v[1][order[0]], v[2][order[0]]],
      [v[0][order[1]], v[1][order[1]], v[2][order[1]]],
      [v[0][order[2]], v[1][order[2]], v[2][order[2]]],
    ],
  };
}

/**
 * Builds one MMG tensor-metric row [m11, m12, m13, m22, m23, m33] from a
 * Hessian given as 9 row-major components. `hmin`/`hmax` are absolute edge
 * lengths bounding the resulting element sizes.
 */
export function metricFromHessian(
  hess9: ArrayLike<number>,
  hmin: number,
  hmax: number
): Float64Array {
  const lo = 1 / (hmax * hmax);
  const hi = 1 / (hmin * hmin);
  // Symmetrize: the upstream Hessian is a composition of two gradients, so
  // numerical asymmetry is noise, not information.
  const sym: number[] = [
    hess9[0], (hess9[1] + hess9[3]) / 2, (hess9[2] + hess9[6]) / 2,
    hess9[4], (hess9[5] + hess9[7]) / 2,
    hess9[8],
  ];
  if (!sym.every(Number.isFinite)) {
    return new Float64Array([lo, 0, 0, lo, 0, lo]);
  }
  const { values, vectors } = eigSym3(sym);
  const lamMax = Math.abs(values[0]);
  if (!(lamMax > 0)) {
    return new Float64Array([lo, 0, 0, lo, 0, lo]);
  }
  const s = hi / lamMax;
  const mu = values.map((l) => Math.min(hi, Math.max(lo, Math.abs(l) * s)));
  // M = R diag(mu) Rᵀ, upper triangle in MMG order.
  const out = new Float64Array(6);
  const idx: Array<[number, number, number]> = [[0, 0, 0], [0, 1, 1], [0, 2, 2], [1, 1, 3], [1, 2, 4], [2, 2, 5]];
  for (const [i, j, o] of idx) {
    let sum = 0;
    for (let k = 0; k < 3; k++) sum += vectors[k][i] * mu[k] * vectors[k][j];
    out[o] = sum;
  }
  return out;
}

// --- wall-layer metric --------------------------------------------------------

/**
 * A boundary-layer size law, as a function of the distance `d` to the wall.
 *
 * MMG makes tetrahedra, not prisms, so a "layer" here is a stretch: the size
 * across the wall (along the distance gradient) is small and grows with the
 * distance the way a geometric layer stack does, while the size along the wall
 * stays larger. For a first height `h1` and a growth ratio `r`, the layer
 * thickness at distance `d` is `h1 + (r - 1) d` — the continuous form of the
 * geometric series, which is what a metric (a field, not a count of layers) can
 * express.
 */
export interface WallLayerSpec {
  /** Cell height across the wall, at the wall. */
  firstHeight: number;
  /** Layer growth ratio r >= 1 (default 1.2). */
  growth?: number;
  /** Cell size along the wall, at the wall. Default `maxAspect * firstHeight`. */
  tangentialSize?: number;
  /** Growth of the along-wall size per unit distance (default 0.25). */
  tangentialGrowth?: number;
  /** Largest size anywhere (the far field). */
  hmax: number;
  /** Largest allowed ratio between the along-wall and across-wall size (default 50). */
  maxAspect?: number;
}

export interface WallSizes {
  /** Size across the wall. */
  normal: number;
  /** Size along the wall. */
  tangential: number;
}

export function wallLayerSizes(distance: number, spec: WallLayerSpec, cap?: number): WallSizes {
  const d = Math.abs(distance);
  const growth = Math.max(1, spec.growth ?? 1.2);
  const aspect = Math.max(1, spec.maxAspect ?? 50);
  const normal = Math.min(spec.hmax, spec.firstHeight + (growth - 1) * d);
  const wall = spec.tangentialSize ?? aspect * spec.firstHeight;
  let tangential = Math.min(spec.hmax, wall + (spec.tangentialGrowth ?? 0.25) * d);
  // Never narrower than across, never more stretched than the aspect limit.
  tangential = Math.max(normal, Math.min(tangential, aspect * normal));
  // An outside size field (a refined wake, say) can only make cells smaller.
  if (cap !== undefined && Number.isFinite(cap) && cap > 0) {
    return { normal: Math.min(normal, cap), tangential: Math.min(tangential, cap) };
  }
  return { normal, tangential };
}

/**
 * One MMG tensor row [m11, m12, m13, m22, m23, m33] for a node at distance
 * `distance` from the wall, whose distance gradient is `gradient`:
 * `M = n nᵀ / h_n² + (I - n nᵀ) / h_t²`. A gradient that is zero or not finite
 * (the medial axis, a failed node) has no wall direction, so it gets the
 * isotropic metric of the along-wall size.
 */
export function metricFromWall(gradient: ArrayLike<number>, distance: number, spec: WallLayerSpec, cap?: number): Float64Array {
  const { normal, tangential } = wallLayerSizes(distance, spec, cap);
  const lt = 1 / (tangential * tangential);
  const gx = gradient[0];
  const gy = gradient[1];
  const gz = gradient[2];
  const len = Math.hypot(gx, gy, gz);
  if (!Number.isFinite(len) || len < 0.3) return new Float64Array([lt, 0, 0, lt, 0, lt]);
  const n = [gx / len, gy / len, gz / len];
  const ln = 1 / (normal * normal);
  const k = ln - lt;
  return new Float64Array([
    lt + k * n[0] * n[0],
    k * n[0] * n[1],
    k * n[0] * n[2],
    lt + k * n[1] * n[1],
    k * n[1] * n[2],
    lt + k * n[2] * n[2],
  ]);
}

/** Cell count of a geometric stack that reaches `thickness` from `firstHeight` with ratio `growth`. */
export function layersToThickness(firstHeight: number, growth: number, thickness: number): number {
  if (!(firstHeight > 0) || !(thickness > 0)) return 0;
  if (growth <= 1 + 1e-9) return Math.ceil(thickness / firstHeight);
  return Math.ceil(Math.log(1 + (thickness * (growth - 1)) / firstHeight) / Math.log(growth));
}
