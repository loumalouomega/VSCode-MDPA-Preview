/**
 * The beam / line-element predicates (see src/parser/beamElements.ts).
 *
 * The rules pinned here are what the detector, the panel and the renderer all
 * agree on. The most important ones are the NEGATIVE cases: a line cell is also
 * the shape a 2D boundary takes, so the meshes that must keep drawing as plain
 * lines are asserted against the real files, not synthesised approximations.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  beamBlocks,
  beamCellCount,
  beamStats,
  buildBeamSegments,
  defaultBeamRadius,
  hasBeamSection,
  radiusFromArea,
} from "../parser/beamElements";
import { parseMdpa } from "../parser/mdpaParser";
import { parseMeshFile } from "../parser/meshFileParser";
import { MdpaModel } from "../parser/types";

const ROOT = path.resolve(__dirname, "../..");
const FRAME = path.join(ROOT, "src/test/fixtures/mdpa/beam_frame.mdpa");
const CYL_FLUID = path.join(ROOT, "example/MDPA/cylinder_Fluid.mdpa");
const CYL_SOLID = path.join(ROOT, "example/MDPA/cylinder_Solid.mdpa");
const OUTLINE = path.join(ROOT, "example/VTK-XML/outline.vtp");

function mdpa(file: string): MdpaModel {
  return parseMdpa(fs.readFileSync(file, "utf8"));
}

const AREA_BEAM = 0.0201;
const AREA_TRUSS = 0.0005;

// ------------------------------------------------------- must stay plain lines

test("a 2D fluid skin of WallCondition2D2N is NOT a beam mesh", () => {
  const m = mdpa(CYL_FLUID);
  assert.ok(beamCellCount(m) > 0, "the fixture must actually contain line cells");
  assert.equal(hasBeamSection(m), false);
  assert.equal(beamStats(m).withSection, 0);
});

test("a 2D solid boundary of LineCondition2D2N is NOT a beam mesh", () => {
  const m = mdpa(CYL_SOLID);
  assert.ok(beamCellCount(m) > 0);
  assert.equal(hasBeamSection(m), false);
});

test("a bare line polydata wireframe is NOT a beam mesh", async () => {
  const m = await parseMeshFile(OUTLINE);
  assert.ok(beamCellCount(m) > 0);
  // Doubly excluded: no Properties at all (a .vtp parser leaves the slot
  // undefined) and no CROSS_AREA field.
  assert.equal(m.properties, undefined);
  assert.equal(hasBeamSection(m), false);
});

test("a mesh with no line cells at all is not a beam mesh", () => {
  const m = mdpa(path.join(ROOT, "example/MDPA/double_arch.mdpa"));
  assert.equal(beamCellCount(m), 0);
  assert.equal(hasBeamSection(m), false);
});

// -------------------------------------------------------------- the real thing

test("a frame whose Properties declare CROSS_AREA IS a beam mesh", () => {
  const m = mdpa(FRAME);
  assert.equal(hasBeamSection(m), true);
});

test("line blocks are found across every entity kind", () => {
  const m = mdpa(FRAME);
  const blocks = beamBlocks(m);
  assert.deepEqual(
    blocks.map((b) => `${b.kind}/${b.name}`),
    [
      "Elements/CrLinearBeamElement3D2N",
      "Elements/TrussElement3D2N",
      "Conditions/LineCondition2D2N",
    ]
  );
  assert.equal(beamCellCount(m), 8);
});

test("the section is resolved PER CELL, not per block", () => {
  // The fixture's two `Begin Elements TrussElement3D2N` blocks merge into one
  // EntityBlock whose cells carry DIFFERENT property ids — 5 and 6 on
  // Properties 2, and 7 on Properties 3 which declares no CROSS_AREA. A
  // per-block rule would give all three the same section or none.
  const m = mdpa(FRAME);
  const s = beamStats(m);
  assert.equal(s.cells, 8);
  assert.equal(s.withSection, 7, "6 elements + the condition that shares Properties 1");
  assert.equal(s.elementsWithSection, 6, "element 7 is on a property with no CROSS_AREA");
  assert.equal(s.radiusMin, radiusFromArea(AREA_TRUSS));
  assert.equal(s.radiusMax, radiusFromArea(AREA_BEAM));
});

test("a condition sharing a part's Properties does not by itself enable beams", () => {
  // This is the reason the gate is Elements-only. Strip the elements' sections
  // and only the LineCondition2D2N still resolves one — that must not count.
  const src = fs
    .readFileSync(FRAME, "utf8")
    // Normalized first: a checkout with CRLF line endings (Windows) would
    // otherwise silently fail every literal `\n`-terminated replace below.
    .replace(/\r\n/g, "\n")
    // leave Properties 1 (the condition's) alone, blank Properties 2's area
    .replace("    CROSS_AREA 0.0005\n", "");
  const m = parseMdpa(
    src.replace(
      "Begin Elements CrLinearBeamElement3D2N\n1 1 1 2\n2 1 2 5\n3 1 5 3\n4 1 3 4\nEnd Elements",
      "Begin Elements CrLinearBeamElement3D2N\n1 3 1 2\n2 3 2 5\n3 3 5 3\n4 3 3 4\nEnd Elements"
    )
  );
  const s = beamStats(m);
  assert.equal(s.elementsWithSection, 0);
  assert.equal(s.withSection, 1, "only the condition on Properties 1");
  assert.equal(hasBeamSection(m), false);
});

test("an Elemental CROSS_AREA field is used when Properties carry none", () => {
  const m = parseMdpa(
    [
      "Begin Properties 0",
      "End Properties",
      "Begin Nodes",
      "1 0 0 0",
      "2 1 0 0",
      "End Nodes",
      "Begin Elements Element3D2N",
      "1 0 1 2",
      "End Elements",
      "Begin ElementalData CROSS_AREA",
      "1 0.04",
      "End ElementalData",
    ].join("\n")
  );
  assert.equal(hasBeamSection(m), true);
  assert.equal(beamStats(m).radiusMax, radiusFromArea(0.04));
});

test("a zero or negative CROSS_AREA is not a section", () => {
  // Glyph3DMapper clamps a zero scale component to 1e-10, so a zero area would
  // draw an invisible sliver instead of falling back to the panel constant.
  for (const area of ["0.0", "-1.0"]) {
    const m = parseMdpa(
      [
        `Begin Properties 1`,
        `    CROSS_AREA ${area}`,
        `End Properties`,
        "Begin Nodes",
        "1 0 0 0",
        "2 1 0 0",
        "End Nodes",
        "Begin Elements Element3D2N",
        "1 1 1 2",
        "End Elements",
      ].join("\n")
    );
    assert.equal(hasBeamSection(m), false, `CROSS_AREA ${area} must not count`);
  }
});

test("a quadratic edge is a line cell, drawn straight between its end nodes", () => {
  // Known limit of geometryMap, not of this module: only a name WITHOUT a
  // `<d>D<n>N` suffix (here `Line3`) reaches the family fallback and decodes to
  // VTK_QUADRATIC_EDGE. `Line2D3` / `CrLinearBeamElement3D3N` resolve through
  // the primary (dimension, nodeCount) lookup, where "3:3" is a TRIANGLE —
  // the right answer for the far more common `Element3D3N` and an ambiguity
  // the format itself does not resolve. Such a beam is not tubed today.
  const m = parseMdpa(
    [
      "Begin Properties 1",
      "    CROSS_AREA 0.01",
      "End Properties",
      "Begin Nodes",
      "1 0 0 0",
      "2 4 0 0",
      "3 2 1 0",
      "End Nodes",
      "Begin Elements Line3",
      "1 1 1 2 3",
      "End Elements",
    ].join("\n")
  );
  assert.equal(beamBlocks(m).length, 1);
  assert.equal(beamCellCount(m), 1);
  assert.equal(hasBeamSection(m), true);
  // The mid node (2,1,0) is dropped: the tube chords its two end nodes, which
  // is exactly how meshBuilder already draws the underlying line.
  const seg = buildBeamSegments(m, { fallbackRadius: 1 });
  assert.deepEqual(Array.from(seg.centers), [2, 0, 0]);
  assert.deepEqual(Array.from(seg.axes), [4, 0, 0]);
});

// ------------------------------------------------------------- default radius

test("defaultBeamRadius is a fraction of the median element length", () => {
  const m = mdpa(FRAME);
  // All 8 line cells are measured (the constant is the fallback for whatever
  // ends up drawn, conditions included): lengths 3, 2, 2, 3 (frame), two
  // braces of hypot(2,3), a 4 tie and a 4 condition. Sorted, the upper middle
  // of the eight is a brace.
  assert.equal(defaultBeamRadius(m), Math.hypot(2, 3) / 20);
});

test("defaultBeamRadius is always finite and positive", () => {
  const degenerate: MdpaModel[] = [
    // no cells at all
    parseMdpa(["Begin Nodes", "1 0 0 0", "End Nodes"].join("\n")),
    // a single zero-length element
    parseMdpa(
      [
        "Begin Nodes",
        "1 0 0 0",
        "2 0 0 0",
        "End Nodes",
        "Begin Elements Element3D2N",
        "1 0 1 2",
        "End Elements",
      ].join("\n")
    ),
    // nothing whatsoever
    parseMdpa(""),
  ];
  for (const m of degenerate) {
    const r = defaultBeamRadius(m);
    assert.ok(Number.isFinite(r) && r > 0, `radius must be drawable, got ${r}`);
  }
});

// ----------------------------------------------------------------- segments

test("segments carry the midpoint, the full endpoint vector and the radius", () => {
  const m = parseMdpa(
    [
      "Begin Properties 1",
      "    CROSS_AREA 0.0201",
      "End Properties",
      "Begin Nodes",
      "1 0 0 0",
      "2 0 4 0",
      "End Nodes",
      "Begin Elements Element3D2N",
      "1 1 1 2",
      "End Elements",
    ].join("\n")
  );
  const s = buildBeamSegments(m, { fallbackRadius: 1 });
  assert.equal(s.count, 1);
  assert.deepEqual(Array.from(s.centers), [0, 2, 0]);
  // The axis is the FULL vector, not a unit direction: its magnitude is what
  // sizes the tube along its own length.
  assert.deepEqual(Array.from(s.axes), [0, 4, 0]);
  // radii is a Float32Array, so compare at single precision.
  assert.equal(s.radii[0], Math.fround(radiusFromArea(0.0201)));
});

test("segments default the radius only for cells with no section", () => {
  const m = mdpa(FRAME);
  const s = buildBeamSegments(m, { fallbackRadius: 0.5 });
  assert.equal(s.count, 7, "the 7 Elements-kind line cells");
  const defaulted = Array.from(s.radii).filter((r) => r === 0.5);
  assert.equal(defaulted.length, 1, "only element 7, whose property has no CROSS_AREA");
});

test("conditions are excluded unless asked for", () => {
  const m = mdpa(FRAME);
  assert.equal(buildBeamSegments(m, { fallbackRadius: 1 }).count, 7);
  assert.equal(
    buildBeamSegments(m, { fallbackRadius: 1, includeConditions: true }).count,
    8
  );
});

test("a zero-length or dangling segment is skipped, never drawn", () => {
  const m = parseMdpa(
    [
      "Begin Nodes",
      "1 0 0 0",
      "2 0 0 0",
      "3 1 0 0",
      "End Nodes",
      "Begin Elements Element3D2N",
      "1 0 1 2",
      "2 0 3 99",
      "End Elements",
    ].join("\n")
  );
  const s = buildBeamSegments(m, { fallbackRadius: 1 });
  assert.equal(s.count, 0);
  assert.equal(s.skipped, 2);
});

test("coordOf redirects the geometry, which is how the deformed warp works", () => {
  const m = parseMdpa(
    [
      "Begin Nodes",
      "1 0 0 0",
      "2 1 0 0",
      "End Nodes",
      "Begin Elements Element3D2N",
      "1 0 1 2",
      "End Elements",
    ].join("\n")
  );
  const s = buildBeamSegments(m, {
    fallbackRadius: 1,
    coordOf: (id) => (id === 1 ? [0, 0, 0] : [0, 0, 10]),
  });
  assert.deepEqual(Array.from(s.axes), [0, 0, 10]);
  assert.deepEqual(Array.from(s.centers), [0, 0, 5]);
});
