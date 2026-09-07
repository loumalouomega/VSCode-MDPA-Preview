/**
 * The red-green templates (`parser/refineTemplates.ts`).
 *
 * These tests are the CONFORMITY PROOF, and they are the reason the refiner
 * carries no tie-break rule: they check exhaustively — every admissible mask
 * against every face — that a shared face's split is a function of the refined
 * edges on that face alone, so two cells meeting there cannot disagree. A
 * fixture can only sample a handful of the cases; this covers all of them.
 *
 * Alongside that, the same volume-conservation and non-degeneracy discipline
 * `refineMesh.test.ts` applies to the uniform templates: children must tile the
 * parent exactly, and none may be inverted or flat.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { VtkCellType as C } from "../parser/geometryMap";
import {
  isAdmissible,
  promoteMask,
  splitChildren,
  popcount,
  TET_FACE_MASKS,
  TET_OPPOSITE_MASKS,
  TET_RED_MASK,
} from "../parser/refineTemplates";

// Reference tet, and the derived midpoints 4..9 in edge order.
const TET_CORNERS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const TET_EDGES: [number, number][] = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
const TET_P: [number, number, number][] = [
  ...TET_CORNERS,
  ...TET_EDGES.map(([a, b]) => {
    const p = TET_CORNERS[a];
    const q = TET_CORNERS[b];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] as [number, number, number];
  }),
];

const TRI_CORNERS: [number, number][] = [[0, 0], [1, 0], [0, 1]];
const TRI_EDGES: [number, number][] = [[0, 1], [1, 2], [2, 0]];
const TRI_P: [number, number][] = [
  ...TRI_CORNERS,
  ...TRI_EDGES.map(([a, b]) => {
    const p = TRI_CORNERS[a];
    const q = TRI_CORNERS[b];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number];
  }),
];

const tetVolume = (c: number[]): number => {
  const [a, b, d, e] = c.map((i) => TET_P[i]);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const w = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
  return (
    (u[0] * (v[1] * w[2] - v[2] * w[1]) -
      u[1] * (v[0] * w[2] - v[2] * w[0]) +
      u[2] * (v[0] * w[1] - v[1] * w[0])) /
    6
  );
};

const triArea = (c: number[]): number => {
  const [a, b, d] = c.map((i) => TRI_P[i]);
  return ((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])) / 2;
};

/** Every admissible tet mask, in one list. */
const TET_ADMISSIBLE: number[] = [];
for (let m = 0; m < 64; m++) if (isAdmissible(C.TETRA, m)) TET_ADMISSIBLE.push(m);

// --- the invariant the whole design rests on --------------------------------

/** Faces as corner triples, and the three edge indices bounding each. */
const FACES: { corners: [number, number, number]; edges: [number, number, number] }[] = [
  { corners: [0, 1, 2], edges: [0, 1, 2] },
  { corners: [0, 1, 3], edges: [0, 4, 3] },
  { corners: [0, 2, 3], edges: [2, 5, 3] },
  { corners: [1, 2, 3], edges: [1, 5, 4] },
];

test("there are exactly 15 admissible tet masks, in the five classes", () => {
  assert.equal(TET_ADMISSIBLE.length, 15, TET_ADMISSIBLE.join(","));
  assert.equal(TET_ADMISSIBLE.filter((m) => popcount(m) === 1).length, 6);
  assert.equal(TET_OPPOSITE_MASKS.length, 3);
  assert.equal(TET_FACE_MASKS.length, 4);
  // Every "opposite" mask really is two vertex-disjoint edges.
  for (const m of TET_OPPOSITE_MASKS) {
    const bits = [0, 1, 2, 3, 4, 5].filter((i) => m & (1 << i));
    assert.equal(bits.length, 2);
    const [e, f] = bits.map((i) => TET_EDGES[i]);
    assert.equal(new Set([...e, ...f]).size, 4, `edges ${e} and ${f} must be disjoint`);
  }
});

test("NO admissible mask leaves a face with exactly two refined edges", () => {
  // This is the invariant that removes the tie-break: a face with 0, 1 or 3
  // refined edges has exactly ONE possible split, so both cells meeting there
  // agree without consulting each other. Two refined edges would force a
  // diagonal choice, and nothing in the refiner is equipped to make the same
  // one from both sides.
  for (const mask of TET_ADMISSIBLE) {
    for (const f of FACES) {
      const onFace = f.edges.filter((e) => mask & (1 << e)).length;
      assert.notEqual(
        onFace,
        2,
        `mask ${mask.toString(2).padStart(6, "0")} gives face ${f.corners} two refined edges`
      );
    }
  }
});

/** The one split a face with this refined-edge set can have, as sorted triples. */
function canonicalFaceSplit(
  corners: [number, number, number],
  edges: [number, number, number],
  mask: number
): string[] {
  const mid = (e: number): number => 4 + e;
  const hit = edges.filter((e) => mask & (1 << e));
  const key = (t: number[]): string => [...t].sort((a, b) => a - b).join(",");
  if (hit.length === 0) return [key(corners)];
  if (hit.length === 1) {
    const e = hit[0];
    const [u, v] = TET_EDGES[e];
    const w = corners.find((c) => c !== u && c !== v)!;
    return [key([u, mid(e), w]), key([mid(e), v, w])].sort();
  }
  // three: the medial split
  const [a, b, c] = corners;
  const eAB = edges.find((e) => new Set(TET_EDGES[e]).has(a) && new Set(TET_EDGES[e]).has(b))!;
  const eBC = edges.find((e) => new Set(TET_EDGES[e]).has(b) && new Set(TET_EDGES[e]).has(c))!;
  const eCA = edges.find((e) => new Set(TET_EDGES[e]).has(c) && new Set(TET_EDGES[e]).has(a))!;
  return [
    key([a, mid(eAB), mid(eCA)]),
    key([mid(eAB), b, mid(eBC)]),
    key([mid(eCA), mid(eBC), c]),
    key([mid(eAB), mid(eBC), mid(eCA)]),
  ].sort();
}

test("every mask's trace on every face is the canonical split of that face", () => {
  // The conformity proof, all 15 x 4 cases. If a child's face lands on a parent
  // face, it must be one of the pieces the face's OWN refined edges dictate —
  // which is what makes the trace identical from the neighbour's side, since
  // the neighbour sees the same edges and knows nothing of our local indices.
  for (const mask of TET_ADMISSIBLE) {
    const children = splitChildren(C.TETRA, mask) ?? [[0, 1, 2, 3]];
    for (const f of FACES) {
      // Local indices lying ON this face: its corners and its edges' midpoints.
      const on = new Set<number>([...f.corners, ...f.edges.map((e) => 4 + e)]);
      const trace = new Set<string>();
      for (const cell of children) {
        for (const tri of [
          [cell[0], cell[1], cell[2]],
          [cell[0], cell[1], cell[3]],
          [cell[0], cell[2], cell[3]],
          [cell[1], cell[2], cell[3]],
        ]) {
          if (tri.every((i) => on.has(i))) {
            trace.add([...tri].sort((a, b) => a - b).join(","));
          }
        }
      }
      assert.deepEqual(
        [...trace].sort(),
        canonicalFaceSplit(f.corners, f.edges, mask),
        `mask ${mask.toString(2).padStart(6, "0")} on face ${f.corners}`
      );
    }
  }
});

// --- the templates themselves ------------------------------------------------

test("tet children tile the parent exactly, and none is inverted or flat", () => {
  const parent = tetVolume([0, 1, 2, 3]);
  assert.ok(parent > 0);
  for (const mask of TET_ADMISSIBLE) {
    const children = splitChildren(C.TETRA, mask);
    if (mask === 0) {
      assert.equal(children, undefined, "mask 0 leaves the cell alone");
      continue;
    }
    let sum = 0;
    for (const c of children!) {
      assert.equal(new Set(c).size, 4, `mask ${mask}: a child repeats a corner`);
      const v = tetVolume(c);
      assert.ok(v > 1e-12, `mask ${mask}: child ${c} is inverted or flat (V=${v})`);
      sum += v;
    }
    assert.ok(Math.abs(sum - parent) < 1e-12, `mask ${mask}: ${sum} != ${parent}`);
  }
});

test("child counts are the ones the classes promise", () => {
  const n = (m: number): number => splitChildren(C.TETRA, m)!.length;
  for (let i = 0; i < 6; i++) assert.equal(n(1 << i), 2, `single edge ${i}`);
  for (const m of TET_OPPOSITE_MASKS) assert.equal(n(m), 4, `opposite ${m}`);
  for (const m of TET_FACE_MASKS) assert.equal(n(m), 4, `face ${m}`);
  assert.equal(n(TET_RED_MASK), 8);
});

test("triangle children tile the parent, for all 8 masks and both diagonals", () => {
  const parent = triArea([0, 1, 2]);
  for (let mask = 0; mask < 8; mask++) {
    for (const prefer of [() => true, () => false]) {
      const children = splitChildren(C.TRIANGLE, mask, prefer);
      if (mask === 0) {
        assert.equal(children, undefined);
        continue;
      }
      let sum = 0;
      for (const c of children!) {
        assert.equal(new Set(c).size, 3, `mask ${mask}: a child repeats a corner`);
        const a = triArea(c);
        assert.ok(a > 1e-12, `mask ${mask}: child ${c} is inverted or flat (A=${a})`);
        sum += a;
      }
      assert.ok(Math.abs(sum - parent) < 1e-12, `mask ${mask}: ${sum} != ${parent}`);
    }
  }
});

test("a triangle's two-edge diagonal is a real choice, and both are valid", () => {
  // It is per-cell QUALITY, not conformity: the diagonal is interior to the
  // cell, so no neighbour can disagree with it. Both options must therefore be
  // legal — which is what lets the refiner pick the shorter one freely.
  for (const mask of [0b011, 0b110, 0b101]) {
    const a = splitChildren(C.TRIANGLE, mask, () => true)!;
    const b = splitChildren(C.TRIANGLE, mask, () => false)!;
    assert.equal(a.length, 3);
    assert.equal(b.length, 3);
    assert.notDeepEqual(a, b, `mask ${mask}: the two diagonals should differ`);
  }
});

// --- promotion ---------------------------------------------------------------

test("promotion lands on an admissible mask that contains the original", () => {
  for (let mask = 0; mask < 64; mask++) {
    const up = promoteMask(C.TETRA, mask);
    assert.ok(isAdmissible(C.TETRA, up), `mask ${mask} promoted to inadmissible ${up}`);
    assert.equal(up & mask, mask, `mask ${mask} promoted to ${up}, which drops an edge`);
  }
});

test("promotion is the SMALLEST admissible superset", () => {
  // "Smallest" is what keeps the extra refinement local; promoting everything
  // straight to red would be conforming too, and would flood the mesh.
  for (let mask = 0; mask < 64; mask++) {
    const up = promoteMask(C.TETRA, mask);
    for (const cand of TET_ADMISSIBLE) {
      if ((cand & mask) === mask && popcount(cand) < popcount(up)) {
        assert.fail(`mask ${mask} -> ${up}, but ${cand} is admissible and smaller`);
      }
    }
  }
});

test("an adjacent edge pair promotes to the one face that contains it", () => {
  // Two edges sharing a vertex span three corners, and any three corners of a
  // tet bound a face — so the answer is unique, not a pick.
  const adjacent = [0b000011, 0b001001, 0b110000];
  for (const m of adjacent) {
    assert.equal(popcount(m), 2);
    assert.ok(!TET_OPPOSITE_MASKS.includes(m));
    const up = promoteMask(C.TETRA, m);
    assert.ok(TET_FACE_MASKS.includes(up), `${m} -> ${up} should be a face mask`);
  }
});

test("a triangle mask is never promoted — 2D has no conformity constraint", () => {
  for (let mask = 0; mask < 8; mask++) assert.equal(promoteMask(C.TRIANGLE, mask), mask);
});
