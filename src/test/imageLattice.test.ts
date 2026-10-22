import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLattice } from "../parser/render/imageLattice";
import type { MdpaModel } from "../parser/types";

/** An nx*ny*nz lattice of hexahedra; `order` permutes node numbering. */
function lattice(nx: number, ny: number, nz: number, order?: number[], cellType = 12): MdpaModel {
  const n = nx * ny * nz;
  const perm = order ?? Array.from({ length: n }, (_, i) => i);
  const coords = new Float32Array(n * 3);
  const values = new Float64Array(n);
  // storage position p holds lattice slot perm[p]
  for (let p = 0; p < n; p++) {
    const s = perm[p];
    const i = s % nx;
    const j = Math.floor(s / nx) % ny;
    const k = Math.floor(s / (nx * ny));
    coords.set([1 + 0.5 * i, 2 + 0.25 * j, 3 + 2 * k], p * 3);
    values[p] = s;
  }
  const at = (i: number, j: number, k: number): number => perm.indexOf(i + nx * (j + ny * k)) + 1;
  const conn: number[] = [];
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++)
        conn.push(at(i, j, k), at(i + 1, j, k), at(i + 1, j + 1, k), at(i, j + 1, k), at(i, j, k + 1), at(i + 1, j, k + 1), at(i + 1, j + 1, k + 1), at(i, j + 1, k + 1));
  const cellCount = (nx - 1) * (ny - 1) * (nz - 1);
  return {
    nodeCount: n,
    nodeIds: Int32Array.from({ length: n }, (_, i) => i + 1),
    coords,
    blocks: [
      { kind: "Elements", name: "h", vtkCellType: cellType, count: cellCount, stride: 8, entityIds: Int32Array.from({ length: cellCount }, (_, i) => i + 1), connectivity: Int32Array.from(conn) },
    ],
    subModelParts: [],
    meta: [],
    fields: [{ kind: "Nodal", variable: "D", components: 1, ids: Int32Array.from({ length: n }, (_, i) => i + 1), values }],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

test("a dense lattice is detected with its dims, origin, spacing and scalars", () => {
  const l = detectLattice(lattice(4, 3, 2))!;
  assert.deepEqual(l.dims, [4, 3, 2]);
  assert.deepEqual(l.origin, [1, 2, 3]);
  assert.deepEqual(l.spacing, [0.5, 0.25, 2]);
  assert.equal(l.scalars[0].name, "D");
  assert.deepEqual([...l.scalars[0].values], Array.from({ length: 24 }, (_, i) => i));
  assert.deepEqual(l.scalars[0].range, [0, 23]);
});
test("node numbering does not matter: values land in x-fastest order", () => {
  const n = 24;
  const order = Array.from({ length: n }, (_, i) => (i * 7) % n); // a permutation (7 is coprime with 24)
  const l = detectLattice(lattice(4, 3, 2, order))!;
  assert.deepEqual([...l.scalars[0].values], Array.from({ length: n }, (_, i) => i));
});
test("a missing node, a moved node, a non-hex block and no field are all refused", () => {
  const m = lattice(3, 3, 3);
  const bent = { ...m, coords: Float32Array.from(m.coords) };
  bent.coords[3 * 5] += 0.2;
  assert.equal(detectLattice(bent), undefined);
  assert.equal(detectLattice(lattice(3, 3, 3, undefined, 10)), undefined); // tetrahedron blocks
  assert.equal(detectLattice({ ...m, fields: [] }), undefined);
  const sparse = { ...m, blocks: [{ ...m.blocks[0], count: 7 }] };
  assert.equal(detectLattice(sparse), undefined);
  assert.equal(detectLattice({ ...m, nodeCount: 4 }), undefined);
});
test("a flat (2D) lattice has no volume", () => {
  assert.equal(detectLattice(lattice(4, 4, 1)), undefined);
});
