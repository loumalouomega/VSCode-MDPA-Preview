// Small synthetic mesh builders for the per-operation documentation
// screenshots (capture-op-*.mjs). Each returns a plain MdpaModel (via the
// real finalizeModel from modelBuilder.ts, so bounds/is3D/node ids come out
// exactly as the real parsers would produce them) — no file I/O, so every
// screenshot is reproducible without depending on a curated fixture file.
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { finalizeModel } = require(path.join(ROOT, "out", "parser", "modelBuilder"));

const HEXAHEDRON = 12;
const QUAD = 9;

/** Deterministic PRNG (mulberry32) so screenshots are reproducible across runs. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A grid of nx*ny*nz hexahedra spanning [0,nx*spacing]x[0,ny*spacing]x[0,nz*spacing]. */
export function hexGrid(nx, ny, nz, spacing = 1) {
  const idx = (i, j, k) => i + j * (nx + 1) + k * (nx + 1) * (ny + 1);
  const pointCount = (nx + 1) * (ny + 1) * (nz + 1);
  const coords = new Float32Array(pointCount * 3);
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const p = idx(i, j, k);
        coords[p * 3] = i * spacing;
        coords[p * 3 + 1] = j * spacing;
        coords[p * 3 + 2] = k * spacing;
      }

  const cellCount = nx * ny * nz;
  const connectivity = new Int32Array(cellCount * 8);
  const entityIds = new Int32Array(cellCount);
  let c = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const corners = [
          idx(i, j, k), idx(i + 1, j, k), idx(i + 1, j + 1, k), idx(i, j + 1, k),
          idx(i, j, k + 1), idx(i + 1, j, k + 1), idx(i + 1, j + 1, k + 1), idx(i, j + 1, k + 1),
        ];
        for (let n = 0; n < 8; n++) connectivity[c * 8 + n] = corners[n] + 1; // 1-based ids
        entityIds[c] = c + 1;
        c++;
      }

  const blocks = [
    {
      kind: "Elements",
      name: "Hexahedra3D8",
      vtkCellType: HEXAHEDRON,
      count: cellCount,
      stride: 8,
      entityIds,
      connectivity,
    },
  ];
  return finalizeModel({ nodeCount: pointCount, coords, blocks, fields: [], diagnostics: [] });
}

/**
 * A flat nx*ny quad grid with per-node random Z jitter — a "noisy terrain"
 * whose smoothed result (via smoothModel) visibly settles into a gentle,
 * regular undulation. Deterministic given `seed`.
 */
export function jitteredPlane(nx, ny, spacing = 1, jitter = 0.3, seed = 42) {
  const rnd = seededRandom(seed);
  const idx = (i, j) => i + j * (nx + 1);
  const pointCount = (nx + 1) * (ny + 1);
  const coords = new Float32Array(pointCount * 3);
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const p = idx(i, j);
      coords[p * 3] = i * spacing;
      coords[p * 3 + 1] = j * spacing;
      // Interior nodes jitter freely; boundary nodes jitter less so the patch
      // reads as a pinned, wavy sheet rather than a ragged-edged blob.
      const onBoundary = i === 0 || j === 0 || i === nx || j === ny;
      coords[p * 3 + 2] = (rnd() - 0.5) * 2 * jitter * (onBoundary ? 0.15 : 1);
    }

  const cellCount = nx * ny;
  const connectivity = new Int32Array(cellCount * 4);
  const entityIds = new Int32Array(cellCount);
  let c = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const corners = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
      for (let n = 0; n < 4; n++) connectivity[c * 4 + n] = corners[n] + 1;
      entityIds[c] = c + 1;
      c++;
    }

  const blocks = [
    {
      kind: "Elements",
      name: "Quadrilateral2D4",
      vtkCellType: QUAD,
      count: cellCount,
      stride: 4,
      entityIds,
      connectivity,
    },
  ];
  return finalizeModel({ nodeCount: pointCount, coords, blocks, fields: [], diagnostics: [] });
}

/** Deep-clones a model's mutable parts well enough for a pure transform's input. */
export function cloneModel(model) {
  return {
    ...model,
    nodeIds: Int32Array.from(model.nodeIds),
    coords: Float32Array.from(model.coords),
    blocks: model.blocks.map((b) => ({
      ...b,
      entityIds: Int32Array.from(b.entityIds),
      connectivity: Int32Array.from(b.connectivity),
      propertyIds: b.propertyIds ? Int32Array.from(b.propertyIds) : undefined,
    })),
    fields: model.fields.map((f) => ({
      ...f,
      ids: Int32Array.from(f.ids),
      values: Float64Array.from(f.values),
    })),
  };
}
