/**
 * Pure eligibility checks for DOLFIN/TetGen/EnSight — see the module's own
 * doc comment for why they need one at all (each writer raises or silently
 * drops cells rather than reporting what it needs).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import {
  dolfinEligibility,
  ensightEligibility,
  exportEligibility,
  tetgenEligibility,
} from "../parser/writers/exportEligibility";

const TRIANGLE_2D = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Conditions LineCondition2D2N
1 0 1 2
End Conditions

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`;

const TET_3D = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements
`;

const HEX_3D = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D8N
1 0 1 2 3 4 5 6 7 8
End Elements
`;

const MIXED_TET_HEX = TET_3D.replace("End Nodes", `5 1.0 1.0 0.0\n6 0.0 0.0 1.0\n7 1.0 0.0 1.0\n8 1.0 1.0 1.0\nEnd Nodes`) +
  `Begin Elements Element3D8N\n2 0 1 2 5 3 6 7 8 4\nEnd Elements\n`;

test("dolfin: accepts a triangle mesh, refuses one with no simplices", () => {
  const tri = parseMdpa(TRIANGLE_2D);
  const r1 = dolfinEligibility(tri);
  assert.equal(r1.ok, true);
  // The LineCondition2D2N block is not a triangle/tetrahedron and is dropped.
  assert.equal(r1.warnings.length, 1);
  assert.match(r1.warnings[0], /simplicial-only/i);

  const hex = parseMdpa(HEX_3D);
  const r2 = dolfinEligibility(hex);
  assert.equal(r2.ok, false);
  assert.match(r2.reason ?? "", /triangles or tetrahedra/i);
});

test("dolfin: a mixed mesh keeps the simplices and warns about the rest", () => {
  const mixed = parseMdpa(MIXED_TET_HEX);
  const r = dolfinEligibility(mixed);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /simplicial-only/i);
});

test("dolfin: warns that fields scatter into sibling files", () => {
  const withField = parseMdpa(
    TET_3D + "\nBegin ElementalData DENSITY\n1 7850.0\nEnd ElementalData\n"
  );
  const r = dolfinEligibility(withField);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /companion/i.test(w)));
});

test("tetgen: needs 3D points and at least one tetrahedron", () => {
  const flat = parseMdpa(TRIANGLE_2D);
  const r1 = tetgenEligibility(flat);
  assert.equal(r1.ok, false);
  assert.match(r1.reason ?? "", /3D points/i);

  const hex = parseMdpa(HEX_3D);
  const r2 = tetgenEligibility(hex);
  assert.equal(r2.ok, false);
  assert.match(r2.reason ?? "", /tetrahedra/i);

  const tet = parseMdpa(TET_3D);
  const r3 = tetgenEligibility(tet);
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.warnings, []);
});

test("tetgen: a mixed mesh keeps the tets and warns about the rest", () => {
  const mixed = parseMdpa(MIXED_TET_HEX);
  const r = tetgenEligibility(mixed);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /tetrahedra only/i);
});

test("ensight: always eligible for an ordinary mesh, warns fields are dropped", () => {
  const tri = parseMdpa(TRIANGLE_2D);
  const r = ensightEligibility(tri);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);

  const withField = parseMdpa(
    TRIANGLE_2D + "\nBegin NodalData TEMP\n1 20.0\n2 20.0\n3 20.0\nEnd NodalData\n"
  );
  const r2 = ensightEligibility(withField);
  assert.equal(r2.ok, true);
  assert.ok(r2.warnings.some((w) => /only geometry/i.test(w)));
});

test("exportEligibility dispatches by extension, case-insensitively, and is a noop elsewhere", () => {
  const tet = parseMdpa(TET_3D);
  assert.equal(exportEligibility(tet, ".XML")?.ok, true);
  assert.equal(exportEligibility(tet, ".ele")?.ok, true);
  assert.equal(exportEligibility(tet, ".node")?.ok, true);
  assert.equal(exportEligibility(tet, ".case")?.ok, true);
  assert.equal(exportEligibility(tet, ".geo")?.ok, true);
  assert.equal(exportEligibility(tet, ".vtu"), undefined);
  assert.equal(exportEligibility(tet, ".mdpa"), undefined);
});
