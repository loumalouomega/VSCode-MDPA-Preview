/**
 * The shared sphere/particle predicates (see src/parser/sphereElements.ts).
 *
 * Pure — no wasm, no fixtures. The rules these pin are what the reader, the
 * writer, the setElementRadius operation and the webview renderer all agree on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultSphereRadius,
  hasSphereRadius,
  radiusField,
  sphereCellCount,
  sphereStats,
} from "../parser/sphereElements";
import { EntityBlock, FieldData, MdpaModel } from "../parser/types";

/** A model of one-node cells at the given xyz triples. */
function particles(coords: number[], opts: { radii?: (number | undefined)[] } = {}): MdpaModel {
  const n = Math.floor(coords.length / 3);
  const ids = Int32Array.from({ length: n }, (_, i) => i + 1);
  const block: EntityBlock = {
    kind: "Elements",
    name: "vertex",
    vtkCellType: 1,
    count: n,
    stride: 1,
    entityIds: ids,
    connectivity: Int32Array.from(ids),
  };

  const fields: FieldData[] = [];
  if (opts.radii) {
    const keep: number[] = [];
    for (let i = 0; i < opts.radii.length; i++) if (opts.radii[i] !== undefined) keep.push(i);
    fields.push({
      kind: "Elemental",
      variable: "RADIUS",
      components: 1,
      ids: Int32Array.from(keep, (i) => i + 1),
      values: Float64Array.from(keep, (i) => opts.radii![i]!),
    });
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], coords[i * 3 + k]);
      max[k] = Math.max(max[k], coords[i * 3 + k]);
    }
  }

  return {
    nodeCount: n,
    nodeIds: ids,
    coords: Float32Array.from(coords),
    blocks: [block],
    subModelParts: [],
    meta: [],
    fields,
    diagnostics: [],
    is3D: min[2] !== max[2],
    bounds: { min, max },
  };
}

/** A 3x3x3 lattice of unit spacing. */
function lattice(spacing = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) out.push(i * spacing, j * spacing, k * spacing);
  return out;
}

test("one-node cells are counted as spheres whether or not they have a radius", () => {
  assert.equal(sphereCellCount(particles(lattice())), 27);
});

test("a radius is detected when it covers only SOME cells", () => {
  // Intersection, not coverage: an Exodus file's SPHERE blocks merge into one
  // EntityBlock and only some of them may declare the attribute.
  const m = particles([0, 0, 0, 1, 0, 0, 2, 0, 0], { radii: [0.5, undefined, undefined] });
  assert.equal(hasSphereRadius(m), true);
  assert.equal(sphereStats(m).withRadius, 1);
});

test("no radius field means no radius", () => {
  const m = particles([0, 0, 0, 1, 0, 0]);
  assert.equal(hasSphereRadius(m), false);
  assert.equal(radiusField(m), undefined);
  assert.equal(sphereStats(m).withRadius, 0);
});

test("a VECTOR field named RADIUS is not a radius", () => {
  const m = particles([0, 0, 0, 1, 0, 0]);
  m.fields.push({
    kind: "Elemental",
    variable: "RADIUS",
    components: 3,
    ids: Int32Array.from([1, 2]),
    values: Float64Array.from([1, 2, 3, 4, 5, 6]),
  });
  assert.equal(radiusField(m), undefined);
  assert.equal(hasSphereRadius(m), false);
});

test("a radius whose ids miss every one-node cell is not a radius", () => {
  const m = particles([0, 0, 0, 1, 0, 0]);
  m.fields.push({
    kind: "Elemental",
    variable: "RADIUS",
    components: 1,
    ids: Int32Array.from([99]), // some other block's cell
    values: Float64Array.from([0.5]),
  });
  assert.equal(hasSphereRadius(m), false);
});

test("defaultSphereRadius is half the nearest-neighbour spacing", () => {
  // Touching particles read as touching — what a peridynamics/DEM lattice is.
  assert.equal(defaultSphereRadius(particles(lattice(1))), 0.5);
  assert.ok(Math.abs(defaultSphereRadius(particles(lattice(0.25))) - 0.125) < 1e-9);
});

test("defaultSphereRadius falls back to a fraction of the diagonal", () => {
  // A lone particle has no spacing to measure, and a degenerate bbox has no
  // diagonal either — neither may return 0 or NaN, or nothing draws at all.
  const single = defaultSphereRadius(particles([0, 0, 0]));
  assert.ok(single > 0 && Number.isFinite(single));

  const degenerate = defaultSphereRadius(particles([1, 1, 1, 1, 1, 1]));
  assert.ok(degenerate > 0 && Number.isFinite(degenerate));

  const empty = defaultSphereRadius(particles([]));
  assert.ok(empty > 0 && Number.isFinite(empty));
});

test("defaultSphereRadius handles a large cloud without an O(n^2) scan", () => {
  // 40k particles on a 1-unit lattice; the spatial hash must keep this instant.
  const coords: number[] = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 40; j++) for (let k = 0; k < 25; k++) coords.push(i, j, k);
  const m = particles(coords);
  assert.equal(sphereCellCount(m), 40000);
  const started = process.hrtime.bigint();
  assert.equal(defaultSphereRadius(m), 0.5);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms — the spacing estimate is not linear`);
});
