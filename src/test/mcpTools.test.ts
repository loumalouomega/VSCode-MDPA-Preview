import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ADOPTING_OPS } from "../parser/adoptingOps";
import { icosphere, tetBar } from "./fixtures/shapes";
import { writeMdpa } from "../parser/writers/mdpaWriter";

import {
  meshInfo,
  meshQuality,
  meshFieldIntegrate,
  caseEvaluateQuantity,
  meshSize,
  meshTransform,
  meshConvert,
  meshExtractSubModelPart,
  meshExtractSkin,
  meshExportTable,
  meshFieldSeries,
  meshPackSeries,
  meshFindEntity,
  meshSelect,
  meshCapabilities,
  meshCurvature,
  meshCompare,
  meshDerive,
  meshProbe,
  meshSplit,
  problemtypeList,
  problemtypeDescribe,
  caseValidate,
  caseWriteState,
  caseGenerate,
  caseRun,
  caseStatus,
  caseStop,
  problemPack,
  problemUnpack,
} from "../mcp/tools";
import { parseMdpa } from "../parser/mdpaParser";
import { writeMeshioBytes } from "../parser/meshio";
import { parseMeshFile } from "../parser/meshFileParser";
import { serializeOps } from "../parser/operations";
import { isPidAlive, stopPid } from "../problemtype/runProcess";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";
import { CaseState } from "../problemtype/types";

// Same shape as problemtypeGenerate.test.ts: one tetrahedron (3D) with a
// volume part and two boundary parts.
const MDPA_3D = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
End Elements

Begin Conditions SurfaceCondition3D3N
1 0 1 2 3
End Conditions

Begin SubModelPart Parts
  Begin SubModelPart Solid
    Begin SubModelPartNodes
    1
    2
    3
    4
    End SubModelPartNodes
    Begin SubModelPartElements
    1
    End SubModelPartElements
  End SubModelPart
End SubModelPart

Begin SubModelPart Support
  Begin SubModelPartNodes
  1
  2
  3
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  End SubModelPartConditions
End SubModelPart

Begin SubModelPart Loaded
  Begin SubModelPartNodes
  4
  End SubModelPartNodes
End SubModelPart
`;

// A unit cube as 6 tetrahedra about the 1-7 diagonal, with one SubModelPart.
// MDPA_3D's single tetrahedron is too degenerate for MMG to level-set (it
// returns STRONGFAILURE), so the level-set test needs a real volume.
const MDPA_CUBE = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
5 0.0 0.0 1.0
6 1.0 0.0 1.0
7 1.0 1.0 1.0
8 0.0 1.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements

Begin SubModelPart Lower
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
  Begin SubModelPartElements
  1
  End SubModelPartElements
End SubModelPart
`;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-"));
}

function writeFixture(dir: string, name = "beam.mdpa"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, MDPA_3D);
  return p;
}

function structuralState(): CaseState {
  const state = defaultCaseState(structural.decl);
  state.assignments = [
    { conditionId: "parts", smpPath: "Parts/Solid", values: {} },
    { conditionId: "displacement", smpPath: "Support", values: { value: [0, 0, 0], constrained: true } },
  ];
  state.materials = [
    { smpPath: "Parts/Solid", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 2.0e11 } },
  ];
  return state;
}

test("mesh_info summarizes counts, blocks, SMP tree and fields", async () => {
  const dir = tmpDir();
  const info = (await meshInfo({ path: writeFixture(dir) })) as {
    nodeCount: number;
    elementCount: number;
    conditionCount: number;
    is3D: boolean;
    blocks: { kind: string; name: string; count: number; stride: number }[];
    subModelParts: { name: string; path: string; children: unknown[]; counts: { nodes: number } }[];
    diagnostics: { total: number };
  };
  assert.equal(info.nodeCount, 4);
  assert.equal(info.elementCount, 1);
  assert.equal(info.conditionCount, 1);
  assert.equal(info.is3D, true);
  assert.deepEqual(
    info.blocks.map((b) => b.name),
    ["Element3D4N", "SurfaceCondition3D3N"]
  );
  const paths = info.subModelParts.map((p) => p.path);
  assert.deepEqual(paths, ["Parts", "Support", "Loaded"]);
  assert.equal(info.diagnostics.total, 0);
  // The whole summary must be JSON-clean: no typed arrays leaking through.
  const roundTrip = JSON.parse(JSON.stringify(info));
  assert.deepEqual(roundTrip, info);
});

test("mesh_info metadataOnly reports a .msh header without parsing", async () => {
  // Synthesized in-test: no committed .msh meshio fixture exists, and the
  // point is the header path, not any particular mesh.
  const dir = tmpDir();
  const model = parseMdpa(MDPA_3D);
  const { data } = await writeMeshioBytes(model, ".msh");
  const msh = path.join(dir, "beam.msh");
  fs.writeFileSync(msh, data as Uint8Array);
  const info = (await meshInfo({ path: msh, metadataOnly: true })) as {
    metadataOnly: boolean;
    resolvedFormat: string;
    nodeCount: number;
    cellCount: number;
    cellBlocks: { type: string; numCells: number }[];
    regions: unknown[];
  };
  assert.equal(info.metadataOnly, true);
  assert.equal(info.resolvedFormat, "gmsh");
  assert.equal(info.nodeCount, 4);
  assert.ok(info.cellCount >= 1);
  assert.ok(info.cellBlocks.length > 0);
  // Since 11.5.0 the gmsh header maps the block Cell regions the write
  // emitted (allocated tags for untagged regions) rather than none.
  assert.ok((info.regions as { name: string }[]).length > 0);
  assert.ok((info.regions as { name: string }[]).every((r) => r.name.length > 0));
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
  // And the fast path leaves the model cache alone: a full report right after
  // still parses rather than serving a shadow.
  const full = (await meshInfo({ path: msh })) as { nodeCount: number; blocks: unknown[] };
  assert.equal(full.nodeCount, 4);
  assert.ok(full.blocks.length > 0);
});

test("mesh_info metadataOnly refuses what it cannot serve cheaply", async () => {
  const exo = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  // Exodus falls back to a full read: refused, not served at header price.
  await assert.rejects(meshInfo({ path: exo, metadataOnly: true }), /falls back|full read/i);
  // Formats with their own parser are not a metadata path at all.
  const dir = tmpDir();
  await assert.rejects(meshInfo({ path: writeFixture(dir), metadataOnly: true }), /own parser/i);
  // A missing file fails the same way either path does.
  const msh = path.join(dir, "nope.msh");
  await assert.rejects(meshInfo({ path: msh, metadataOnly: true }), /not found/i);
  // timeStep names a frame to parse; metadataOnly reports the file header.
  const model = parseMdpa(MDPA_3D);
  const { data } = await writeMeshioBytes(model, ".msh");
  const real = path.join(dir, "beam.msh");
  fs.writeFileSync(real, data as Uint8Array);
  await assert.rejects(meshInfo({ path: real, metadataOnly: true, timeStep: 1 }), /cannot be combined/i);
});

test("mesh_info summary answers for the formats metadataOnly refuses", async () => {
  // The inversion that justifies a second argument rather than widening the
  // first: everything metadataOnly throws for, summary answers, and it says
  // what the answer cost instead of refusing.
  const dir = tmpDir();

  // A native parser's format - metadataOnly rejects this with /own parser/.
  const mdpa = writeFixture(dir);
  const nat = (await meshInfo({ path: mdpa, summary: true })) as {
    summary: boolean; cost: string; nodeCount: number; bytesRead: number; unknown: string[];
  };
  assert.equal(nat.summary, true);
  assert.equal(nat.cost, "scan", "MDPA declares no counts, so it is streamed");
  assert.ok(nat.nodeCount > 0);
  assert.ok(nat.unknown.includes("bounds"), "and it says what it did not compute");

  // A meshio format that falls back - metadataOnly rejects with /full read/.
  const exo = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  const fell = (await meshInfo({ path: exo, summary: true })) as { cost: string; nodeCount: number };
  assert.equal(fell.cost, "read", "reported, not refused");
  assert.ok(fell.nodeCount > 0);

  // And a genuine header read reports as one.
  const model = parseMdpa(MDPA_3D);
  const { data } = await writeMeshioBytes(model, ".msh");
  const msh = path.join(dir, "sum.msh");
  fs.writeFileSync(msh, data as Uint8Array);
  const cheap = (await meshInfo({ path: msh, summary: true })) as { cost: string; nodeCount: number };
  assert.equal(cheap.cost, "buffered");
  assert.equal(cheap.nodeCount, 4);
});

test("mesh_info summary refuses only the combinations that contradict it", async () => {
  const dir = tmpDir();
  const mdpa = writeFixture(dir);
  await assert.rejects(meshInfo({ path: mdpa, summary: true, metadataOnly: true }), /cannot be combined/i);
  await assert.rejects(meshInfo({ path: mdpa, summary: true, timeStep: 1 }), /cannot be combined/i);
});

test("an OpenFOAM case is not served stale from the model cache", async () => {
  // The sharpest hazard .foam introduces: the marker is 0 bytes and its mtime
  // never moves when constant/polyMesh is rewritten, so a cache keyed on the
  // OPENED file would serve the first read forever.
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const marker = path.join(dir, "run.foam");
  const model = parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0", " 2 1.0 0.0 0.0", " 3 1.0 1.0 0.0", " 4 0.0 1.0 0.0",
      " 5 0.0 0.0 1.0", " 6 1.0 0.0 1.0", " 7 1.0 1.0 1.0", " 8 0.0 1.0 1.0",
      "End Nodes",
      "Begin Elements Element3D8N",
      " 1 0 1 2 3 4 5 6 7 8",
      "End Elements",
      "",
    ].join("\n")
  );
  const { data, companions } = await writeMeshFileAsync(model, ".foam", { name: "run" });
  fs.writeFileSync(marker, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }

  const before = (await meshInfo({ path: marker })) as { bounds: { max: number[] } };
  assert.equal(before.bounds.max[0], 1);

  // Rewrite the MESH, leaving the marker untouched — what blockMesh does.
  const pts = path.join(dir, "constant", "polyMesh", "points");
  fs.writeFileSync(pts, fs.readFileSync(pts, "utf8").replace(/\b1(\.0*)?\b(?=[ )])/g, "2"));
  const markerStat = fs.statSync(marker);
  assert.equal(markerStat.size, 0, "the marker still says nothing changed");

  const after = (await meshInfo({ path: marker })) as { bounds: { max: number[] } };
  assert.equal(after.bounds.max[0], 2, "the second read saw the new polyMesh");
});

test("mesh_quality reports metrics with capped bad ids", async () => {
  const dir = tmpDir();
  const report = (await meshQuality({ path: writeFixture(dir), badIdLimit: 5 })) as {
    overallOk: boolean;
    analyzedCount: number;
    metrics: { key: string; badEntityIds: number[]; badEntityTotal: number }[];
  };
  assert.equal(report.analyzedCount, 1);
  assert.ok(report.metrics.length > 0);
  for (const m of report.metrics) {
    assert.ok(m.badEntityIds.length <= 5);
    assert.ok(m.badEntityTotal >= m.badEntityIds.length);
  }
});

test("mesh_size reports nodal + element size statistics", async () => {
  const dir = tmpDir();
  const report = (await meshSize({ path: writeFixture(dir) })) as {
    analyzedCount: number;
    nodalSize: { count: number; min: number };
    elementSize: { median: number };
    smallElementIds: number[];
    bigElementIds: number[];
  };
  assert.equal(report.analyzedCount, 1);
  assert.equal(report.nodalSize.count, 4); // 4 tet nodes
  assert.ok(Math.abs(report.nodalSize.min - 1) < 1e-3); // unit legs
  // Mean of 6 tet edges = (3·1 + 3·√2)/6.
  assert.ok(Math.abs(report.elementSize.median - (3 + 3 * Math.SQRT2) / 6) < 1e-3);
  assert.equal(report.smallElementIds.length, 0);
  assert.equal(report.bigElementIds.length, 0);
});

test("mesh_transform applies ops and writes to outputPath, preserving Properties", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const out = path.join(dir, "beam_scaled.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [
      { op: "scale", sx: 2, sy: 2, sz: 2 },
      { op: "translate", dx: 1, dy: 0, dz: 0 },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean }[]; outputPath: string };
  assert.deepEqual(result.outcomes.map((o) => o.op), ["scale", "translate"]);
  assert.ok(result.outcomes.every((o) => !o.noop));
  const text = fs.readFileSync(out, "utf8");
  assert.match(text, /Begin Properties 0/); // sourceText round-trip
  const model = parseMdpa(text);
  assert.deepEqual(Array.from(model.bounds.min), [1, 0, 0]);
  assert.deepEqual(Array.from(model.bounds.max), [3, 2, 2]);
  // The input file itself is untouched.
  assert.equal(fs.readFileSync(src, "utf8"), MDPA_3D);
});

test("mesh_transform can refine where a field marks, and stays conforming", async () => {
  // The composition this feature exists for, headless: estimateError writes
  // ERROR_MARKED, refine reads it. Written by hand here so the test needs no
  // wasm — what is under test is the selector and the closure, not the
  // estimator.
  const dir = tmpDir();
  const src = path.join(dir, "marked.mdpa");
  fs.writeFileSync(
    src,
    [
      "Begin Properties 0",
      "End Properties",
      "",
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 0.0 1.0 0.0",
      " 4 0.0 0.0 1.0",
      " 5 1.0 1.0 1.0",
      "End Nodes",
      "",
      "Begin Elements Element3D4N",
      " 1 0 1 2 3 4",
      " 2 0 2 3 4 5",
      "End Elements",
      "",
      "Begin ElementalData ERROR_MARKED",
      " 1 1.0",
      " 2 0.0",
      "End ElementalData",
      "",
    ].join("\n")
  );
  const out = path.join(dir, "refined.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "refine", select: { by: "field" } }],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };

  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].noop, false);
  assert.match(result.outcomes[0].message ?? "", /closure pass/);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  // 8 red children of the marked tet + 4 green children closing its neighbour.
  assert.equal(model.blocks[0].count, 12);
});

test("mesh_transform's refine noops with a reason when the field is absent", async () => {
  // Not a failure: estimateError is async and a timeline replay skips it, so a
  // recipe carrying a selective refine has to degrade rather than throw.
  const dir = tmpDir();
  const src = writeFixture(dir);
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "refine", select: { by: "field", variable: "NOPE" } }],
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };
  assert.equal(result.outcomes[0].noop, true);
  assert.match(result.outcomes[0].message ?? "", /NOPE/);
});

test("mesh_transform rejects an invalid op naming its index", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshTransform({
      path: writeFixture(dir),
      ops: [{ op: "scale", sx: 2, sy: 2, sz: 2 }, { op: "shrink" }],
      outputPath: path.join(dir, "out.mdpa"),
    }),
    /ops\[1\].*"shrink"/
  );
});

test("mesh_transform replays a saved recipe file", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const recipePath = path.join(dir, "ops.json");
  fs.writeFileSync(recipePath, serializeOps([{ op: "translate", dx: 0, dy: 0, dz: 5 }], "test"));
  const out = path.join(dir, "moved.mdpa");
  await meshTransform({ path: src, recipePath, outputPath: out });
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.deepEqual(Array.from(model.bounds.min), [0, 0, 5]);
});

test("mesh_transform overwrites the input when outputPath is omitted (and cache follows)", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  await meshInfo({ path: src }); // prime the cache
  await meshTransform({ path: src, ops: [{ op: "scale", sx: 3, sy: 3, sz: 3 }] });
  const info = (await meshInfo({ path: src })) as { bounds: { max: number[] } };
  assert.deepEqual(Array.from(info.bounds.max), [3, 3, 3]);
});

test("mesh_transform runs an MMG remesh (optimize) in-process", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "remeshed.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "remesh", mode: "optimize" }],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "remesh");
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(model.nodeCount >= 4);
});

test("mesh_transform runs a level-set split that keeps materials, and validates rmc", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "ls.mdpa");
  // fieldCalc supplies the nodal φ the level set needs, so the whole thing is
  // one mesh_transform call against the plain fixture.
  const src = path.join(dir, "cube.mdpa");
  fs.writeFileSync(src, MDPA_CUBE);
  const result = (await meshTransform({
    path: src,
    ops: [
      { op: "fieldCalc", expr: "x-0.5", location: "Nodal", output: "PHI" },
      { op: "levelset", variable: "PHI", keepMaterials: true },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[1].op, "levelset");
  assert.ok(!result.outcomes[1].noop, result.outcomes[1].message);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  // keepMaterials means the original block survives instead of collapsing into
  // MMG_Domain_* blocks, and the side rides two generated SubModelParts.
  const names = model.blocks.map((b) => b.name);
  assert.ok(names.includes("Element3D4N"), names.join(","));
  const paths = model.subModelParts.map((p) => p.path);
  assert.ok(paths.includes("MMG_Domain_Inside"), paths.join(","));
  assert.ok(paths.includes("MMG_Domain_Outside"), paths.join(","));

  // MMG range-checks rmc not at all, so opRecordFromMessage must: an
  // out-of-range value has to be rejected rather than silently deleting a domain.
  await assert.rejects(
    meshTransform({
      path: src,
      ops: [{ op: "levelset", variable: "PHI", rmc: 5 }],
      outputPath: path.join(dir, "bad-out.mdpa"),
    }),
    /levelset/
  );
});

test("mesh_transform runs an expr-mode MMG remesh with a statistical formula", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "expr.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "remesh", mode: "expr", sizeExpr: "clamp(0.5*h, mean-1.5*std, mean+1.5*std)" }],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "remesh");
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(model.nodeCount >= 4);
});

test("mesh_transform rejects an expr-mode remesh with an invalid formula", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshTransform({
      path: writeFixture(dir),
      ops: [{ op: "remesh", mode: "expr", sizeExpr: "0.5 * bogus" }],
      outputPath: path.join(dir, "bad.mdpa"),
    }),
    /ops\[0\]: invalid/i
  );
});

test("mesh_transform grades an expr-mode remesh by distance to a boundary/skin surface", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube.mdpa");
  fs.writeFileSync(src, MDPA_CUBE);
  // The cube's own x=0 face (nodes 1, 4, 5, 8), as a standalone surface mesh —
  // this is the "compute an SDF from the skin, use it to refine at the
  // boundary layer" workflow, minus a separate sdfDistance step since "d" is
  // computed inline by the remesh op itself.
  const surface = path.join(dir, "skin.mdpa");
  fs.writeFileSync(
    surface,
    `Begin Nodes
1 0.0 0.0 0.0
2 0.0 1.0 0.0
3 0.0 1.0 1.0
4 0.0 0.0 1.0
End Nodes

Begin Elements Element3D3N
1 0 1 2 3
2 0 1 3 4
End Elements
`
  );
  const out = path.join(dir, "graded.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [
      {
        op: "remesh",
        mode: "expr",
        sizeExpr: "clamp(0.1 + 0.45*d, 0.1, 0.55)",
        distanceSurfacePath: surface,
        hgrad: 3,
      },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "remesh");
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  // Denser near x=0 (close to the skin) than near x=1 (far from it).
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < model.nodeCount; i++) {
    if (model.coords[i * 3] < 0.5) lo++;
    else hi++;
  }
  assert.ok(lo > hi, `expected denser x<0.5 half near the surface: lo=${lo} hi=${hi}`);
});

test("mesh_transform rejects an expr-mode remesh referencing d with no distance surface", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshTransform({
      path: writeFixture(dir),
      ops: [{ op: "remesh", mode: "expr", sizeExpr: "0.1 + 0.4*d" }],
      outputPath: path.join(dir, "bad-d.mdpa"),
    }),
    /ops\[0\]: invalid/i
  );
});

test("mesh_transform reports an unreadable distance surface as a noop, not a throw", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "unreadable.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [
      {
        op: "remesh",
        mode: "expr",
        sizeExpr: "0.1 + 0.4*d",
        distanceSurfacePath: path.join(dir, "does-not-exist.stl"),
      },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].noop, true);
  assert.match(result.outcomes[0].message, /does-not-exist\.stl/);
});

// The cube's own x=0 face (nodes 1, 4, 5, 8), as CONDITIONS of the SAME mesh
// wrapped in a "Skin" SubModelPart — the "distanceSurfacePart" alternative to
// the external-file test above: no second file, the surface is already in
// the model being remeshed.
const MDPA_CUBE_WITH_SKIN = MDPA_CUBE.replace(
  "End SubModelPart\n",
  `End SubModelPart

Begin Conditions SurfaceCondition3D3N
1 0 1 4 8
2 0 1 8 5
End Conditions

Begin SubModelPart Skin
  Begin SubModelPartNodes
  1
  4
  5
  8
  End SubModelPartNodes
  Begin SubModelPartConditions
  1
  2
  End SubModelPartConditions
End SubModelPart
`
);

test("mesh_transform grades an expr-mode remesh by distance to a SubModelPart of the SAME mesh", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  const out = path.join(dir, "graded-part.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [
      {
        op: "remesh",
        mode: "expr",
        sizeExpr: "clamp(0.1 + 0.45*d, 0.1, 0.55)",
        distanceSurfacePart: "Skin",
        hgrad: 3,
      },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "remesh");
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  // Denser near x=0 (the skin's own face) than near x=1 (far from it) —
  // same shape assertion as the external-file test, since the geometry
  // measured against is identical.
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < model.nodeCount; i++) {
    if (model.coords[i * 3] < 0.5) lo++;
    else hi++;
  }
  assert.ok(lo > hi, `expected denser x<0.5 half near the surface: lo=${lo} hi=${hi}`);
});

test("mesh_transform rejects a remesh naming both distanceSurfacePath and distanceSurfacePart", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  await assert.rejects(
    meshTransform({
      path: src,
      ops: [
        {
          op: "remesh",
          mode: "expr",
          sizeExpr: "0.1 + 0.4*d",
          distanceSurfacePath: path.join(dir, "does-not-exist.stl"),
          distanceSurfacePart: "Skin",
        },
      ],
      outputPath: path.join(dir, "bad-both.mdpa"),
    }),
    /ops\[0\]: (invalid|mutually exclusive)/i
  );
});

test("mesh_transform reports a missing distanceSurfacePart as a noop, not a throw", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  const out = path.join(dir, "missing-part.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [
      {
        op: "remesh",
        mode: "expr",
        sizeExpr: "0.1 + 0.4*d",
        distanceSurfacePart: "NoSuchPart",
      },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].noop, true);
  assert.match(result.outcomes[0].message, /NoSuchPart/);
});

test("mesh_transform computes sdfDistance from a SubModelPart of the SAME mesh (no second file)", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  const out = path.join(dir, "sdf-part.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "sdfDistance", part: "Skin", output: "d" }],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].op, "sdfDistance");
  assert.equal(result.outcomes[0].noop, false);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === "d");
  assert.ok(field, "the named output field exists");
  assert.equal(field!.values.length, model.nodeCount);
});

test("mesh_transform computes sdfDistance from the mesh's own exterior skin (no file, no part)", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube.mdpa");
  fs.writeFileSync(src, MDPA_CUBE);
  const out = path.join(dir, "sdf-skin.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "sdfDistance", skin: true, output: "d" }],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].noop, false);
  assert.match(result.outcomes[0].message, /the mesh skin/);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const field = model.fields.find((f) => f.kind === "Nodal" && f.variable === "d");
  assert.ok(field, "the named output field exists");
  // Every node of this cube is ON its skin, so the unsigned magnitude is ~0
  // everywhere — the skin really was the surface measured against.
  for (const v of field!.values) assert.ok(Math.abs(v) < 1e-6, `expected ~0 on the skin, got ${v}`);
});

test("mesh_transform reports sdfDistance to the skin of a surface-only mesh as a noop", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "shell.mdpa");
  fs.writeFileSync(
    src,
    `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
End Nodes

Begin Elements Element2D3N
1 0 1 2 3
End Elements
`
  );
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "sdfDistance", skin: true }],
    outputPath: path.join(dir, "out.mdpa"),
  })) as { outcomes: { noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].noop, true);
  assert.match(result.outcomes[0].message, /no volume cells/);
});

test("mesh_transform chains sdfDistance's own output into a later remesh sizing formula", async () => {
  // The "define a variable, then use it" story: no distanceSurfacePath/Part on
  // the remesh step at all — it reaches "d" only because a PRIOR step in the
  // SAME sequence already computed it onto the mesh.
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  const out = path.join(dir, "chained.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [
      { op: "sdfDistance", part: "Skin", output: "d" },
      { op: "remesh", mode: "expr", sizeExpr: "clamp(0.1 + 0.45*d, 0.1, 0.55)", hgrad: 3 },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].op, "sdfDistance");
  assert.equal(result.outcomes[1].op, "remesh");
  assert.equal(result.outcomes[1].noop, false);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < model.nodeCount; i++) {
    if (model.coords[i * 3] < 0.5) lo++;
    else hi++;
  }
  assert.ok(lo > hi, `expected denser x<0.5 half near the surface: lo=${lo} hi=${hi}`);
});

test("mesh_transform rejects sdfDistance naming both path and part, or neither", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  await assert.rejects(
    meshTransform({
      path: src,
      ops: [{ op: "sdfDistance", path: path.join(dir, "does-not-exist.stl"), part: "Skin" }],
      outputPath: path.join(dir, "bad-both.mdpa"),
    }),
    /ops\[0\]: invalid/i
  );
  await assert.rejects(
    meshTransform({
      path: src,
      ops: [{ op: "sdfDistance" }],
      outputPath: path.join(dir, "bad-neither.mdpa"),
    }),
    /ops\[0\]: invalid/i
  );
});

test("mesh_transform reports a missing sdfDistance part as a noop, not a throw", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "cube-with-skin.mdpa");
  fs.writeFileSync(src, MDPA_CUBE_WITH_SKIN);
  const out = path.join(dir, "missing-sdf-part.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "sdfDistance", part: "NoSuchPart" }],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean; message: string }[] };
  assert.equal(result.outcomes[0].noop, true);
  assert.match(result.outcomes[0].message, /NoSuchPart/);
});

test("mesh_transform runs a remesh with frozen/localSizes (unknown targets warn)", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "frozen.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [
      {
        op: "remesh",
        mode: "optimize",
        frozen: [{ kind: "part", target: "Nope" }],
        localSizes: [{ kind: "block", target: "AlsoNope", hmin: 0.1, hmax: 0.3, hausd: 0.02 }],
      },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "remesh");
  assert.match(result.outcomes[0].message ?? "", /matched nothing/);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(model.nodeCount >= 4);
});

test("mesh_transform rejects a remesh with incomplete localSizes", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshTransform({
      path: writeFixture(dir),
      ops: [
        {
          op: "remesh",
          mode: "hsiz",
          hsiz: 0.2,
          localSizes: [{ kind: "part", target: "P", hmin: 0.1, hmax: 0.3 }],
        },
      ],
      outputPath: path.join(dir, "bad.mdpa"),
    }),
    /ops\[0\]: invalid/i
  );
});

test("mesh_convert writes a .vtu the VTK parser reads back", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "beam.vtu");
  const result = (await meshConvert({ path: writeFixture(dir), outputPath: out })) as {
    targetFormat: string;
    nodeCount: number;
  };
  assert.equal(result.targetFormat, ".vtu");
  const model = await parseMeshFile(out);
  assert.equal(model.nodeCount, 4);
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 2);
});

// A tetrahedron and a wedge (both Element3D*N) so an Elemental field can name
// only the first and leave the second uncovered.
const MDPA_SPARSE = `Begin Properties 0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
5 1.0 1.0 1.0
6 1.0 0.0 1.0
End Nodes

Begin Elements Element3D4N
1 0 1 2 3 4
2 0 2 3 4 5
End Elements

Begin ElementalData DENSITY
1 7850.0
End ElementalData
`;

test("mesh_convert reports the sparse-cell-field zero-fill warning (regression: the write-diagnostics leak)", async () => {
  // Before the shared writeMeshioBytes diagnostics array was wired through
  // writeMeshFileAsync (writers/meshWriter.ts), every modelToMeshio export
  // diagnostic — including this one — was silently discarded: the caller
  // passed onWarning but no diagnostics array, and writeMeshioBytes defaulted
  // to opts.diagnostics ?? [], a throwaway.
  const dir = tmpDir();
  const src = path.join(dir, "sparse.mdpa");
  fs.writeFileSync(src, MDPA_SPARSE);
  const out = path.join(dir, "sparse.med"); // meshio++-routed writer (.vtu is native, bypassing writeMeshioBytes)
  const result = (await meshConvert({ path: src, outputPath: out })) as {
    warnings: string[];
    diagnostics: { total: number; first: { message: string }[] };
  };
  assert.ok(
    result.warnings.some((w) => /DENSITY.*covers 1 of 2 element/.test(w)),
    `expected a sparse-field warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("mesh_convert reports read-side diagnostics from the source file", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "beam.vtu");
  const result = (await meshConvert({ path: writeFixture(dir), outputPath: out })) as {
    diagnostics: { total: number; first: unknown[] };
  };
  assert.equal(result.diagnostics.total, 0);
  assert.deepEqual(result.diagnostics.first, []);
});

test("mesh_extract_submodelpart reports warnings and diagnostics like every other write tool", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "solid.mdpa");
  const result = (await meshExtractSubModelPart({
    path: writeFixture(dir),
    submodelpart: "Support",
    outputPath: out,
  })) as { warnings: string[]; diagnostics: { total: number; first: unknown[] } };
  assert.deepEqual(result.warnings, []);
  assert.equal(result.diagnostics.total, 0);
});

test("mesh_extract_skin reports warnings and diagnostics like every other write tool", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "skin.mdpa");
  const result = (await meshExtractSkin({ path: writeFixture(dir), outputPath: out })) as {
    warnings: string[];
    diagnostics: { total: number; first: unknown[] };
  };
  assert.deepEqual(result.warnings, []);
  assert.equal(result.diagnostics.total, 0);
});

test("mesh_convert writes a .vtm index plus one .vtu per top-level part", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "scene.vtm");
  const result = (await meshConvert({ path: writeFixture(dir), outputPath: out })) as {
    targetFormat: string;
  };
  assert.equal(result.targetFormat, ".vtm");
  // The index plus one companion per top-level part (Parts, Support, Loaded —
  // the fixture's geometry is fully covered, so there is no Base dataset).
  const children = fs.readdirSync(dir).filter((f) => f.endsWith(".vtu")).sort();
  assert.deepEqual(children, ["scene_Loaded.vtu", "scene_Parts.vtu", "scene_Support.vtu"]);
  const back = await parseMeshFile(out);
  assert.deepEqual(
    back.subModelParts.map((p) => p.path).sort(),
    ["Loaded", "Parts", "Support"]
  );
  assert.equal(back.blocks.reduce((n, b) => n + b.count, 0), 2);
});

test("mesh_convert rejects unsupported output formats listing valid ones", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshConvert({ path: writeFixture(dir), outputPath: path.join(dir, "beam.vti") }),
    /\.vti.*\.mdpa/s
  );
});

test("mesh_convert writes a BINARY .msh via meshio++ and reads it back", async () => {
  // Regression guard for the write path: gmsh 4.1 is binary, so the old
  // string-returning writeMeshFile + writeFile(…, "utf8") would corrupt it.
  const dir = tmpDir();
  const out = path.join(dir, "beam.msh");
  const result = (await meshConvert({ path: writeFixture(dir), outputPath: out })) as {
    targetFormat: string;
    nodeCount: number;
  };
  assert.equal(result.targetFormat, ".msh");
  assert.equal(result.nodeCount, 4);

  const bytes = fs.readFileSync(out);
  assert.ok(bytes.includes(0), "gmsh 4.1 output is binary (would be corrupted as utf8)");
  assert.match(bytes.subarray(0, 12).toString("latin1"), /^\$MeshFormat/);

  const back = (await meshInfo({ path: out })) as { nodeCount: number };
  assert.equal(back.nodeCount, 4);
});

test("mesh_convert writes each .msh/.inp flavour via outputFormat", async () => {
  // The flavours the UI QuickPick offers (EXPORT_FORMAT_FLAVOURS) ride the
  // same `format` argument, so this pins the write path the Export menu,
  // per-part export and Export skin now reach.
  const dir = tmpDir();
  const src = path.join(dir, "cube.mdpa");
  fs.writeFileSync(src, MDPA_CUBE);
  const cases = [
    { file: "a.msh", outputFormat: "ansys", inputFormat: "ansys" },
    { file: "f.msh", outputFormat: "freefem", inputFormat: "freefem" },
    { file: "b.inp", outputFormat: "ansysinp", inputFormat: "ansysinp" },
  ] as const;
  for (const c of cases) {
    const out = path.join(dir, c.file);
    const result = (await meshConvert({ path: src, outputPath: out, outputFormat: c.outputFormat })) as {
      targetFormat: string;
      nodeCount: number;
    };
    assert.equal(result.targetFormat, path.extname(c.file));
    assert.equal(result.nodeCount, 8);
    assert.ok(fs.statSync(out).size > 0, `${c.outputFormat} wrote bytes`);
    const back = (await meshInfo({ path: out, inputFormat: c.inputFormat })) as {
      nodeCount: number;
    };
    assert.equal(back.nodeCount, 8, `${c.outputFormat} output reads back whole`);
  }
});

test("mesh_convert round-trips a mesh through an extended text format", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "beam.mesh"); // medit, text
  await meshConvert({ path: writeFixture(dir), outputPath: out });
  const model = await parseMeshFile(out);
  assert.equal(model.nodeCount, 4);
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 2);
});

test("mesh_capabilities reports the live build next to the routing tables", async () => {
  // The headless query roadmap Tier 1 item 1 asks for: readers/writers from
  // the live artifact, per-reader options-awareness, and the extension's own
  // routing (timelines, header-only set, unrouted keys with reasons).
  const caps = (await meshCapabilities()) as {
    packageVersion?: string;
    backend: string;
    hasCgnslib: boolean;
    live: { readers: string[]; writers: string[] };
    readers: { key: string; extensions: string[]; optionsAware: boolean }[];
    unroutedReaders: { key: string; reason: string }[];
    timelines: { inFile: string[]; filename: string[] };
    headerMetadata: string[];
    fidelity: {
      carriers: { key: string; scope: string; recovers: string; upstreamConvention: boolean }[];
      partRegionPrefix: string;
      slots: Record<string, string>;
      raggedCellBlocksSupported: boolean;
      adoptingOperations: string[];
    };
  };
  assert.equal(caps.packageVersion, "15.4.0");
  assert.ok(caps.backend.length > 0);
  assert.equal(caps.hasCgnslib, true);
  // 15.x bump (roadmap item 3): vtkhdf/pvd/pvtu/pvtp/pcd/xyz/lsdyna/frd/gltf
  // joined the live build. 54 readable, 57 writable.
  assert.equal(caps.live.readers.length, 54);
  assert.equal(caps.live.writers.length, 57);
  assert.ok(caps.live.readers.includes("vtm"));
  const byKey = new Map(caps.readers.map((r) => [r.key, r]));
  assert.deepEqual(byKey.get("exodus")?.extensions, [".e", ".ex2", ".exo"]);
  assert.equal(byKey.get("med")?.optionsAware, true);
  assert.equal(byKey.get("cgns")?.optionsAware, true);
  assert.equal(byKey.get("tecplot")?.optionsAware, true);
  assert.equal(byKey.get("su2")?.optionsAware, false);
  assert.equal(byKey.get("frd")?.optionsAware, true);
  assert.equal(byKey.get("vtkhdf")?.optionsAware, true);
  assert.equal(byKey.get("lsdyna")?.optionsAware, false);
  // Deliberately unrouted keys name their reason rather than vanishing.
  const unrouted = new Map(caps.unroutedReaders.map((r) => [r.key, r.reason]));
  for (const key of ["mdpa", "gmsh22", "gltf", "vti", "vts", "vtr", "vtm", "pvd"]) {
    assert.ok((unrouted.get(key) ?? "").length > 0, `${key} names its reason`);
  }
  // The 11.3.0 promotions are visible here too.
  for (const ext of [".med", ".cgns", ".dat", ".tec"]) {
    assert.ok(caps.timelines.inFile.includes(ext), `${ext} drives an in-file timeline`);
    assert.ok(caps.headerMetadata.includes(ext), `${ext} stays header-only`);
  }
  // vtkhdf's 14.0.0 admission (roadmap item 3) — see fixtures/transient/README.md.
  for (const ext of [".vtkhdf", ".hdf"]) {
    assert.ok(caps.timelines.inFile.includes(ext), `${ext} drives an in-file timeline`);
    assert.ok(caps.headerMetadata.includes(ext), `${ext} stays header-only`);
  }
  // Plain JSON throughout: no BigInt, no Maps.
  JSON.stringify(caps);

  // The explicit fidelity adapter (meshioFidelity.ts), published through the
  // same headless query — roadmap item 1's "publish the capability inventory
  // through a headless query" acceptance clause.
  assert.equal(caps.fidelity.partRegionPrefix, "kratos:smp/");
  assert.ok(caps.fidelity.carriers.some((c) => c.key === "mdpa:id" && c.upstreamConvention));
  assert.ok(caps.fidelity.carriers.some((c) => c.key === "kratos:kind" && !c.upstreamConvention));
  assert.equal(caps.fidelity.slots.nodeIds, "carried");
  assert.equal(caps.fidelity.slots.constraints, "reconstructed");
  assert.equal(caps.fidelity.slots.blockNames, "lost");
  assert.equal(caps.fidelity.raggedCellBlocksSupported, false);
  // The published list is the registry in adoptingOps.ts, so "which ops adopt"
  // is a headless-queryable fact rather than a comment.
  assert.deepEqual(caps.fidelity.adoptingOperations, [...ADOPTING_OPS]);
});

test("mesh_capabilities: every routed writer key is live in this build (roadmap item 3)", async () => {
  // The routing tables (MESHIO_WRITE_FORMAT) are hand-maintained and can
  // drift ahead of, or behind, what a given build actually links (a build
  // without gidpost still lists "gid", per its own docblock). This is the
  // headless half of that check: writeMeshioBytes now refuses at write time
  // with a named reason (meshio.ts), and this pins that every key we claim
  // to route IS in fact live, so a future drift fails a test rather than a
  // user's export.
  const caps = (await meshCapabilities()) as {
    live: { writers: string[] };
    writers: Record<string, string>;
  };
  const live = new Set(caps.live.writers);
  for (const [ext, key] of Object.entries(caps.writers)) {
    assert.ok(live.has(key), `${ext} routes to "${key}", which this build actually links`);
  }
});

test("mesh_info reports the extended formats it can now open", async () => {
  const dir = tmpDir();
  const off = path.join(dir, "tri.off");
  fs.writeFileSync(off, "OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n");
  const info = (await meshInfo({ path: off })) as {
    format: string;
    nodeCount: number;
    elementCount: number;
  };
  assert.equal(info.format, ".off");
  assert.equal(info.nodeCount, 3);
  assert.equal(info.elementCount, 1);
});

test("mesh_info reports a MED file's own mesh name, description and units in a conditional source section", async () => {
  const dir = tmpDir();
  const med = path.join(dir, "two-step.med");
  fs.copyFileSync(
    path.resolve(__dirname, "../../src/test/fixtures/transient/two-step.med"),
    med
  );
  const info = (await meshInfo({ path: med })) as {
    format: string;
    source?: { format: string; meshName?: string; description?: string; units?: unknown };
  };
  assert.equal(info.source?.format, "med");
  assert.equal(info.source?.meshName, "mesh");
  assert.equal(info.source?.description, "Mesh created with meshio++");
  assert.equal(info.source?.units, undefined);

  // Conditional, like properties/constraints: an ordinary format's report
  // must not grow a `source` key just because MED now sets one.
  const offInfo = (await meshInfo({
    path: (() => {
      const off = path.join(dir, "tri.off");
      fs.writeFileSync(off, "OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n");
      return off;
    })(),
  })) as { source?: unknown };
  assert.equal(offInfo.source, undefined);
});

test("mesh_convert rejects outputFormat on a native extension instead of ignoring it", async () => {
  // Regression: writeMeshFileAsync used to silently write .vtu when handed
  // format="ansys", so the caller got a format they never asked for.
  const dir = tmpDir();
  await assert.rejects(
    meshConvert({
      path: writeFixture(dir),
      outputPath: path.join(dir, "a.vtu"),
      outputFormat: "ansys",
    }),
    /has no format variants|does not apply/i
  );
});

test("mesh_info rejects inputFormat on a format with its own parser", async () => {
  // Regression: inputFormat used to be silently dropped for .mdpa / native.
  const dir = tmpDir();
  await assert.rejects(
    meshInfo({ path: writeFixture(dir), inputFormat: "gmsh" }),
    /does not apply/i
  );
});

test("mesh_info's inputFormat forces a reader the extension never selects", async () => {
  // .msh defaults to gmsh; ansys/freefem are otherwise unreachable.
  const dir = tmpDir();
  const bad = path.join(dir, "x.msh");
  fs.writeFileSync(bad, "definitely not a mesh");
  await assert.rejects(meshInfo({ path: bad, inputFormat: "freefem" }), (e: Error) => {
    // Only freefem is attempted — gmsh/ansys are not in the message.
    assert.match(e.message, /freefem/);
    assert.ok(!/ansys/.test(e.message), "the candidate list was not used");
    return true;
  });
});

test("mesh_extract_submodelpart slices a part; a miss lists available paths", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const out = path.join(dir, "solid.mdpa");
  const result = (await meshExtractSubModelPart({
    path: src,
    submodelpart: "Parts/Solid",
    outputPath: out,
  })) as { nodeCount: number };
  assert.equal(result.nodeCount, 4);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.blocks.filter((b) => b.kind === "Elements").length, 1);
  await assert.rejects(
    meshExtractSubModelPart({ path: src, submodelpart: "Nope", outputPath: out }),
    /not found.*Parts\/Solid.*Support/s
  );
});

test("mesh_extract_skin extracts the boundary faces of a tetra mesh", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const out = path.join(dir, "skin.mdpa");
  const result = (await meshExtractSkin({ path: src, outputPath: out })) as {
    faces: number;
    nodeCount: number;
    blocks: { kind: string }[];
  };
  assert.ok(result.faces > 0);
  assert.ok(result.blocks.every((b) => b.kind === "Elements"));
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), result.faces);
});

test("mesh_extract_skin rejects a mesh with no volume or surface cells", async () => {
  const dir = tmpDir();
  const pointsOnly = "Begin Nodes\n1 0 0 0\nEnd Nodes\n";
  const src = path.join(dir, "points.mdpa");
  fs.writeFileSync(src, pointsOnly);
  await assert.rejects(
    meshExtractSkin({ path: src, outputPath: path.join(dir, "out.mdpa") }),
    /no boundary faces/i
  );
});

test("mesh_export_table returns bounded JSON rows with field values", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const res = (await meshExportTable({ path: src, kind: "Nodes" })) as {
    columns: string[];
    rowCount: number;
    offset: number;
    rows: (number | string | null)[][];
  };
  assert.deepEqual(res.columns, ["id", "x", "y", "z"]);
  assert.equal(res.rowCount, 4);
  assert.deepEqual(res.rows[3], [4, 0, 0, 1]);
  // JSON-clean: no typed arrays or undefined survive the round trip.
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);

  const page = (await meshExportTable({
    path: src,
    kind: "Nodes",
    offset: 2,
    limit: 1,
  })) as { rows: number[][]; offset: number };
  assert.equal(page.offset, 2);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0][0], 3);

  const elems = (await meshExportTable({
    path: src,
    kind: "Elements",
    membership: true,
  })) as { columns: string[]; rows: (number | string | null)[][] };
  assert.deepEqual(elems.columns, ["id", "block", "nodes", "SubModelParts"]);
  assert.deepEqual(elems.rows[0], [1, "Element3D4N", "1 2 3 4", "Parts/Solid"]);
});

test("mesh_export_table writes CSV and XLSX, and names a bad kind or extension", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);

  const csvPath = path.join(dir, "nodes.csv");
  const csv = (await meshExportTable({
    path: src,
    kind: "Nodes",
    outputPath: csvPath,
  })) as { rowCount: number; columns: string[] };
  assert.equal(csv.rowCount, 4);
  const lines = fs.readFileSync(csvPath, "utf8").trimEnd().split("\r\n");
  assert.equal(lines[0], "id,x,y,z");
  assert.equal(lines.length, 5);
  assert.equal(lines[4], "4,0,0,1");

  const xlsxPath = path.join(dir, "nodes.xlsx");
  await meshExportTable({ path: src, kind: "Nodes", outputPath: xlsxPath });
  // A zip, not a spreadsheet library, is all this needs to prove.
  assert.deepEqual(Array.from(fs.readFileSync(xlsxPath).subarray(0, 2)), [0x50, 0x4b]);

  await assert.rejects(
    meshExportTable({ path: src, kind: "Vertices", outputPath: csvPath }),
    /Unknown kind/
  );
  await assert.rejects(
    meshExportTable({ path: src, kind: "Nodes", outputPath: path.join(dir, "t.vtu") }),
    /Cannot write a table/
  );
});

test("mesh_export_table restricts rows to a SubModelPart subtree", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const res = (await meshExportTable({
    path: src,
    kind: "Nodes",
    submodelpart: "Support",
  })) as { rowCount: number; rows: number[][] };
  assert.equal(res.rowCount, 3);
  assert.deepEqual(
    res.rows.map((r) => r[0]),
    [1, 2, 3]
  );
});

// --- case_run / case_stop -------------------------------------------------
//
// End-to-end with NO python and NO Kratos: argv is [python, scriptName], so
// pointing `python` at process.execPath and writing JavaScript into the script
// runs a real detached child, a real log file and a real signal ladder.

/** Writes a runnable "solver" and the mesh beside it. Returns the mesh path. */
function runFixture(body: string, script = "solver.js"): { dir: string; mesh: string } {
  const dir = tmpDir();
  const mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA_3D);
  fs.writeFileSync(path.join(dir, script), body);
  return { dir, mesh };
}

const runArgs = (mesh: string, over: Record<string, unknown> = {}) => ({
  meshPath: mesh,
  python: process.execPath,
  scriptName: "solver.js",
  generate: false,
  ...over,
});

test("case_run runs a solver to completion and reports its exit code", async () => {
  const { dir, mesh } = runFixture("process.stdout.write('solving'); process.exit(0);");
  const res = (await caseRun(runArgs(mesh))) as {
    status: string;
    exitCode: number | null;
    pid?: number;
    logFile: string;
  };
  assert.equal(res.status, "finished");
  assert.equal(res.exitCode, 0);
  assert.ok(res.pid && res.pid > 0);
  // The output goes to the log file, never through MCP — stdout is the transport.
  assert.match(fs.readFileSync(res.logFile, "utf8"), /solving/);
  // And the sidecar case_status reads is written by the same path.
  const status = (await caseStatus({ meshPath: mesh })) as { status: string; launchedBy: string };
  assert.equal(status.status, "finished");
  assert.equal(status.launchedBy, "mcp");
  assert.ok(fs.existsSync(path.join(dir, "beam.kratosrun.json")));
});

test("queue-managed case_run snapshots into a fresh workspace and retries by request identity", async () => {
  const { dir, mesh } = runFixture("process.exit(0);");
  const runDirectory = path.join(dir, "study-runs", "run-a");
  const args = runArgs(mesh, { requestId: "request-a", ownerId: "study-a", runDirectory });
  const first = (await caseRun(args)) as {
    status: string;
    runId: string;
    executionReceipt: { requestId: string; ownerId: string; jobId: string; state: string; artifacts: { role: string; revision?: string }[] };
  };
  assert.equal(first.status, "finished");
  assert.equal(first.executionReceipt.requestId, "request-a");
  assert.equal(first.executionReceipt.ownerId, "study-a");
  assert.equal(first.executionReceipt.jobId, first.runId);
  assert.equal(first.executionReceipt.state, "succeeded");
  assert.ok(first.executionReceipt.artifacts.some((artifact) => artifact.role === "mesh" && artifact.revision?.startsWith("sha256:")));
  assert.equal(fs.readFileSync(path.join(runDirectory, "beam.mdpa"), "utf8"), fs.readFileSync(mesh, "utf8"));
  assert.ok(fs.existsSync(path.join(runDirectory, "beam.kratosrun.json")));
  assert.equal(fs.existsSync(path.join(dir, "beam.kratosrun.json")), false, "source case remains untouched");

  fs.appendFileSync(mesh, "\n// changed after snapshot\n");
  const retry = (await caseRun(args)) as { runId: string; executionReceipt: { jobId: string; state: string } };
  assert.equal(retry.runId, first.runId, "a duplicate dispatch request is answered by lookup, not another launch");
  assert.equal(retry.executionReceipt.jobId, first.runId);
  assert.equal(retry.executionReceipt.state, "succeeded");
  assert.equal(fs.readFileSync(path.join(runDirectory, "beam.mdpa"), "utf8"), MDPA_3D);
  const status = (await caseStatus({ requestId: "request-a", ownerId: "study-a", runDirectory })) as {
    status: string; executionReceipt: { state: string; jobId: string };
  };
  assert.equal(status.status, "finished");
  assert.equal(status.executionReceipt.jobId, first.runId);
});

test("queue-owned receipt paths are rebased after the containing project moves", async () => {
  const { dir, mesh } = runFixture("process.exit(0);");
  const runDirectory = path.join(dir, "study-runs", "run-move");
  await caseRun(runArgs(mesh, { requestId: "request-move", ownerId: "study-move", runDirectory }));
  const moved = `${dir}-moved`;
  fs.renameSync(dir, moved);
  const movedRunDirectory = path.join(moved, "study-runs", "run-move");
  const status = (await caseStatus({ requestId: "request-move", ownerId: "study-move", runDirectory: movedRunDirectory })) as {
    executionReceipt: { runDirectory: string; meshPath: string; state: string; artifacts: { path: string }[] };
  };
  assert.equal(status.executionReceipt.state, "succeeded");
  assert.equal(status.executionReceipt.runDirectory, movedRunDirectory);
  assert.equal(status.executionReceipt.meshPath, path.join(movedRunDirectory, "beam.mdpa"));
  assert.ok(status.executionReceipt.artifacts.every(artifact => artifact.path.startsWith(movedRunDirectory)));
});

test("queue-managed cancellation is scoped to the recorded owner", async () => {
  const { dir, mesh } = runFixture("setInterval(function () {}, 1000);");
  const runDirectory = path.join(dir, "isolated-run");
  const started = (await caseRun(runArgs(mesh, {
    requestId: "request-cancel", ownerId: "study-owner", runDirectory, waitSeconds: 0,
  }))) as { pid: number };
  await assert.rejects(
    () => caseStop({ requestId: "request-cancel", ownerId: "somebody-else", runDirectory }),
    /ownership mismatch/
  );
  const stopped = (await caseStop({ requestId: "request-cancel", ownerId: "study-owner", runDirectory })) as {
    stopped: boolean; executionReceipt: { state: string; requestId: string; ownerId: string };
  };
  assert.equal(stopped.stopped, true);
  assert.equal(isPidAlive(started.pid), false);
  assert.equal(stopped.executionReceipt.state, "cancelled");
  assert.equal(stopped.executionReceipt.requestId, "request-cancel");
  assert.equal(stopped.executionReceipt.ownerId, "study-owner");
});

test("a non-zero exit is failed, and a missing interpreter carries the OS message", async () => {
  const bad = runFixture("process.exit(7);");
  const res = (await caseRun(runArgs(bad.mesh))) as { status: string; exitCode: number | null };
  assert.equal(res.status, "failed");
  assert.equal(res.exitCode, 7);

  const missing = runFixture("process.exit(0);");
  const res2 = (await caseRun(
    runArgs(missing.mesh, { python: path.join(missing.dir, "no-such-python") })
  )) as { status: string; message?: string };
  assert.equal(res2.status, "failed");
  assert.match(res2.message ?? "", /Could not start/);
});

test("case_run hands off rather than failing when the budget expires", async () => {
  // The whole point of the design: expiry is a documented handoff, not an
  // error, and it must NOT kill the run.
  const { mesh } = runFixture("setInterval(function () {}, 1000);");
  const res = (await caseRun(runArgs(mesh, { waitSeconds: 1 }))) as {
    status: string;
    pid: number;
    exitCode?: number;
    warnings: string[];
  };
  assert.equal(res.status, "running");
  // Its ABSENCE is what tells an agent the run has not ended.
  assert.equal(res.exitCode, undefined);
  assert.ok(res.warnings.some((w) => /Still running/.test(w)));
  assert.equal(isPidAlive(res.pid), true, "expiry must not kill the run");
  await caseStop({ meshPath: mesh });
});

test("waitSeconds:0 returns immediately with a live run", async () => {
  const { mesh } = runFixture("setInterval(function () {}, 1000);");
  const res = (await caseRun(runArgs(mesh, { waitSeconds: 0 }))) as { status: string; pid: number };
  assert.equal(res.status, "running");
  assert.equal(isPidAlive(res.pid), true);
  const status = (await caseStatus({ meshPath: mesh })) as { status: string };
  // case_status only has a pid, so it hedges to `detached` where case_run —
  // which holds the handle — can honestly say `running`.
  assert.equal(status.status, "detached");
  await caseStop({ meshPath: mesh });
});

test("case_run refuses to start over a live run unless forced", async () => {
  const { mesh } = runFixture("setInterval(function () {}, 1000);");
  const first = (await caseRun(runArgs(mesh, { waitSeconds: 0 }))) as { pid: number };
  await assert.rejects(() => caseRun(runArgs(mesh, { waitSeconds: 0 })), /may still be active/);
  const forced = (await caseRun(runArgs(mesh, { waitSeconds: 0, force: true }))) as {
    pid: number;
    warnings: string[];
  };
  assert.ok(forced.warnings.some((w) => /status record has been replaced/.test(w)));
  await stopPid(first.pid);
  await caseStop({ meshPath: mesh });
});

test("case_run refuses an unsupported mesh and a missing script", async () => {
  const dir = tmpDir();
  const txt = path.join(dir, "m.txt");
  fs.writeFileSync(txt, "");
  await assert.rejects(() => caseRun({ meshPath: txt }), /Unsupported mesh format/);

  const mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA_3D);
  await assert.rejects(
    () => caseRun(runArgs(mesh, { scriptName: "nope.js" })),
    /is not in|case_generate/
  );
});

test("case_stop ladders a live run down to cancelled", async () => {
  const { mesh } = runFixture("setInterval(function () {}, 1000);");
  const started = (await caseRun(runArgs(mesh, { waitSeconds: 0 }))) as { pid: number };
  const res = (await caseStop({ meshPath: mesh })) as {
    stopped: boolean;
    outcome: string;
    status: string;
  };
  assert.equal(res.stopped, true);
  assert.notEqual(res.outcome, "alive");
  assert.equal(res.status, "cancelled");
  assert.equal(isPidAlive(started.pid), false);
  // A stop must never wear a failure badge.
  const status = (await caseStatus({ meshPath: mesh })) as { status: string };
  assert.equal(status.status, "cancelled");
});

test("case_stop says so rather than pretending when there is nothing to stop", async () => {
  const dir = tmpDir();
  const mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA_3D);
  const none = (await caseStop({ meshPath: mesh })) as { stopped: boolean; status: string };
  assert.equal(none.stopped, false);
  assert.equal(none.status, "none");

  const { mesh: done } = runFixture("process.exit(0);");
  await caseRun(runArgs(done));
  const ended = (await caseStop({ meshPath: done })) as { stopped: boolean; message?: string };
  assert.equal(ended.stopped, false);
  assert.match(ended.message ?? "", /already ended/);
});

test("case_run's reply survives the JSON round trip register.ts performs", async () => {
  // The first handler to hold a live object (a RunHandle, an fd) — this is what
  // catches one leaking into the blob.
  const { mesh } = runFixture("process.exit(0);");
  const res = await caseRun(runArgs(mesh));
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
});

test("case_status reports no run before one has ever happened", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const res = (await caseStatus({ meshPath: src })) as {
    status: string;
    output: { fileCount: number };
  };
  assert.equal(res.status, "none");
  assert.equal(res.output.fileCount, 0);
});

test("case_status reconciles a stale 'running' record against the OS", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const sidecar = path.join(dir, "beam.kratosrun.json");

  // A record left behind by a window that went away, naming a pid that is gone.
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      version: 1,
      runId: "r1",
      stem: "beam",
      meshFile: src,
      status: "running",
      launchMode: "output",
      argv: ["python3", "MainKratos.py"],
      startedAt: 1,
      pid: 0x7ffffff0,
      launchedBy: "extension",
    })
  );
  const gone = (await caseStatus({ meshPath: src })) as {
    status: string;
    message: string;
  };
  // Never echoed back as "running": that would claim a liveness nothing checked.
  assert.equal(gone.status, "orphaned");
  assert.match(gone.message, /no exit code/);

  // A live pid is a maybe, not a yes — pids are reused.
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      version: 1,
      runId: "r2",
      stem: "beam",
      meshFile: src,
      status: "running",
      launchMode: "output",
      argv: ["python3", "MainKratos.py"],
      startedAt: 1,
      pid: process.pid,
      launchedBy: "extension",
    })
  );
  const live = (await caseStatus({ meshPath: src })) as {
    status: string;
    message: string;
  };
  assert.equal(live.status, "detached");
  assert.match(live.message, /may still be running/);
});

test("case_status summarises vtk_output with the same numeric step ordering", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  fs.mkdirSync(path.join(dir, "vtk_output"));
  for (const n of ["2", "4", "10"]) {
    fs.writeFileSync(path.join(dir, "vtk_output", `beam_0_${n}.vtu`), "");
  }
  fs.writeFileSync(
    path.join(dir, "beam.kratosrun.json"),
    JSON.stringify({
      version: 1,
      runId: "r3",
      stem: "beam",
      meshFile: src,
      status: "finished",
      launchMode: "output",
      argv: ["python3", "MainKratos.py"],
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      launchedBy: "extension",
    })
  );
  const res = (await caseStatus({ meshPath: src })) as {
    status: string;
    exitCode: number;
    output: { fileCount: number; latestStep: string; steps: number };
  };
  assert.equal(res.status, "finished");
  assert.equal(res.exitCode, 0);
  assert.equal(res.output.fileCount, 3);
  // 10, not 4 — the same numeric ordering the viewer uses.
  assert.equal(res.output.latestStep, "10");
  assert.equal(res.output.steps, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
});

test("mesh_field_series reads one node across a filename-grouped series", async () => {
  // The committed Kratos series: Main_0_2 / _0_4 / _0_6, three real steps.
  const src = path.resolve(__dirname, "../../example/VTK/Main_0_2.vtk");
  const res = (await meshFieldSeries({
    path: src,
    entityType: "Node",
    entityId: 4,
    variable: "PRESSURE",
  })) as {
    source: string;
    totalSteps: number;
    labels: string[];
    values: (number[] | null)[];
    present: number;
    components: number;
  };
  assert.equal(res.source, "files");
  assert.equal(res.totalSteps, 3);
  assert.deepEqual(res.labels, ["2", "4", "6"]);
  assert.equal(res.present, 3);
  assert.equal(res.components, 1);
  assert.deepEqual(
    res.values.map((v) => Number((v as number[])[0].toFixed(3))),
    [0.716, 3.032, 6.948]
  );
  // JSON-clean, and gaps survive as null rather than collapsing the array.
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
});

test("mesh_field_series reads an in-file (Exodus) series and writes CSV", async () => {
  const src = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  const dir = tmpDir();
  const out = path.join(dir, "series.csv");
  const res = (await meshFieldSeries({
    path: src,
    entityType: "Node",
    entityId: 1,
    variable: "temperature",
    outputPath: out,
  })) as { source: string; totalSteps: number; values: (number[] | null)[]; present: number };
  assert.equal(res.source, "inFile");
  assert.equal(res.totalSteps, 3);
  assert.equal(res.present, 3);
  // The fixture offsets temperature by 10 per step, so a wrong step is visible.
  assert.deepEqual(
    res.values.map((v) => (v as number[])[0]),
    [0, 10, 20]
  );
  const lines = fs.readFileSync(out, "utf8").trimEnd().split("\r\n");
  assert.equal(lines[0], "step,frame,temperature");
  assert.equal(lines.length, 4);
});

test("mesh_field_series and mesh_pack_series share non-VTK discovery and native PLY fields", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const step of [2, 10]) {
    fs.writeFileSync(path.join(dir, `Heat_0_${step}.ply`), `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property float TEMP
element face 1
property list uchar int vertex_indices
end_header
0 0 0 ${step}
1 0 0 ${step}
0 1 0 ${step}
3 0 1 2
`);
  }
  const src = path.join(dir, "Heat_0_2.ply");
  const series = await meshFieldSeries({ path: src, entityType: "Node", entityId: 1, variable: "TEMP" }) as {
    source: string; labels: string[]; values: number[][];
  };
  assert.equal(series.source, "files");
  assert.deepEqual(series.labels, ["2", "10"]);
  assert.deepEqual(series.values, [[2], [10]]);
  const dest = path.join(dir, "packed.xdmf");
  await meshPackSeries({ path: src, outputPath: dest });
  const packed = await meshFieldSeries({ path: dest, entityType: "Node", entityId: 1, variable: "TEMP" }) as typeof series;
  assert.equal(packed.source, "inFile");
  assert.deepEqual(packed.labels, series.labels);
  assert.deepEqual(packed.values, series.values);
  const missing = await meshFieldSeries({ path: src, entityType: "Node", entityId: 1, variable: "absent" }) as {
    missingField: number; values: null[];
  };
  assert.equal(missing.missingField, 2);
  assert.deepEqual(missing.values, [null, null]);
});

test("mesh_pack_series uses per-frame TetGen companions", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const step of [2, 10]) {
    fs.writeFileSync(path.join(dir, `Tri_0_${step}.node`), "4 3 0 0\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n");
    fs.writeFileSync(path.join(dir, `Tri_0_${step}.ele`), "1 4 0\n1 1 2 3 4\n");
  }
  const dest = path.join(dir, "packed.xdmf");
  await meshPackSeries({ path: path.join(dir, "Tri_0_2.ele"), outputPath: dest });
  for (const timeStep of [0, 1]) {
    const model = await parseMeshFile(dest, undefined, { timeStep });
    assert.equal(model.nodeCount, 4);
    assert.deepEqual([...model.blocks[0].connectivity], [1, 2, 3, 4]);
  }
});

test("mesh_field_series names what is missing instead of returning zeros", async () => {
  const src = path.resolve(__dirname, "../../example/VTK/Main_0_2.vtk");
  const absent = (await meshFieldSeries({
    path: src,
    entityType: "Node",
    entityId: 4,
    variable: "NOT_A_FIELD",
  })) as { present: number; missingField: number; values: (number[] | null)[] };
  assert.equal(absent.present, 0);
  assert.equal(absent.missingField, 3);
  assert.deepEqual(absent.values, [null, null, null]);

  await assert.rejects(
    meshFieldSeries({
      path: src,
      entityType: "Geometry",
      entityId: 1,
      variable: "PRESSURE",
    }),
    /carries no field values/
  );
  await assert.rejects(
    meshFieldSeries({
      path: src,
      entityType: "Node",
      entityId: 4,
      variable: "PRESSURE",
      outputPath: path.join(tmpDir(), "s.vtu"),
    }),
    /Cannot write a series/
  );
});

test("mesh_field_series windows a long series with offset and limit", async () => {
  const src = path.resolve(__dirname, "../../example/VTK/Main_0_2.vtk");
  const res = (await meshFieldSeries({
    path: src,
    entityType: "Node",
    entityId: 4,
    variable: "PRESSURE",
    offset: 1,
    limit: 1,
  })) as { totalSteps: number; offset: number; labels: string[] };
  assert.equal(res.totalSteps, 3, "the full length is still reported");
  assert.equal(res.offset, 1);
  assert.deepEqual(res.labels, ["4"]);
});

test("mesh_transform runs smooth (meshio++ oracle), only moving coordinates", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "smoothed.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "smooth", method: "taubin", iterations: 3 }],
    outputPath: out,
  })) as { outcomes: { op: string }[] };
  assert.equal(result.outcomes[0].op, "smooth");
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.nodeCount, 4);
  assert.equal(model.blocks.find((b) => b.kind === "Elements")?.count, 1);
});

test("mesh_transform runs reorder, permuting nodes without changing the mesh's bounds", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "reordered.mdpa");
  await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "reorder", method: "rcm" }],
    outputPath: out,
  });
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.nodeCount, 4);
  assert.deepEqual(Array.from(model.bounds.max), [1, 1, 1]);
});

test("mesh_transform runs partition, attaching PARTITION_INDEX", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "partitioned.mdpa");
  await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "partition", nparts: 1 }],
    outputPath: out,
  });
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const field = model.fields.find((f) => f.kind === "Elemental" && f.variable === "PARTITION_INDEX");
  assert.ok(field, "PARTITION_INDEX field was attached");
  // Covers every cell kind (the 1 element + the 1 boundary condition), not
  // just Elements — see partitionMesh.ts's KIND_ORDER.
  assert.equal(field!.ids.length, 2);
});

test("mesh_transform refines a tetra into 8 children", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "refined.mdpa");
  await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "refine", levels: 1 }],
    outputPath: out,
  });
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.blocks.find((b) => b.kind === "Elements")?.count, 8);
});

test("mesh_transform simplexify is a noop on an already-simplex mesh", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "simplexified.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "simplexify" }],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean }[] };
  assert.equal(result.outcomes[0].noop, true);
});

test("mesh_transform linearize is a noop on a linear mesh", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "linearized.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [{ op: "linearize" }],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean }[] };
  assert.equal(result.outcomes[0].noop, true);
});

test("mesh_transform crops to a bounding box, dropping cells outside it", async () => {
  // Thin in z: the tetra (needs node 4 at z=1) fails "all", the flat
  // boundary triangle (nodes 1,2,3, all at z=0) survives.
  const dir = tmpDir();
  const out = path.join(dir, "cropped.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [
      { op: "crop", kind: "bbox", lo: [-0.1, -0.1, -0.1], hi: [1.1, 1.1, 0.1], mode: "all" },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean }[] };
  assert.equal(result.outcomes[0].noop, false);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.blocks.find((b) => b.kind === "Elements"), undefined);
  assert.equal(model.blocks.find((b) => b.kind === "Conditions")?.count, 1);
});

test("mesh_transform computes a field via fieldCalc then averages it nodal->elemental", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "calc.mdpa");
  await meshTransform({
    path: writeFixture(dir),
    ops: [
      { op: "fieldCalc", expr: "x + y + z", location: "Nodal", output: "SUM" },
      { op: "averageField", variable: "SUM", direction: "nodalToElemental", target: "Elements" },
    ],
    outputPath: out,
  });
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const nodal = model.fields.find((f) => f.kind === "Nodal" && f.variable === "SUM");
  const elemental = model.fields.find((f) => f.kind === "Elemental" && f.variable === "SUM");
  assert.equal(nodal?.ids.length, 4);
  assert.equal(elemental?.ids.length, 1);
});

test("mesh_transform chains field management: compute, condition to a sibling, rename, then drop the source", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "managed.mdpa");
  const result = (await meshTransform({
    path: writeFixture(dir),
    ops: [
      { op: "fieldCalc", expr: "x + y + z", location: "Nodal", output: "SUM" },
      { op: "conditionField", kind: "Nodal", variable: "SUM", mode: "normalize", output: "SUM_N" },
      { op: "renameField", kind: "Nodal", variable: "SUM_N", newName: "SUM_UNIT" },
      { op: "dropFields", kind: "Nodal", variables: ["SUM"] },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };
  assert.deepEqual(result.outcomes.map((o) => o.noop), [false, false, false, false]);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const nodal = model.fields.filter((f) => f.kind === "Nodal").map((f) => f.variable);
  assert.ok(nodal.includes("SUM_UNIT"));
  assert.ok(!nodal.includes("SUM") && !nodal.includes("SUM_N"));
  const unit = model.fields.find((f) => f.variable === "SUM_UNIT")!;
  assert.equal(Math.min(...unit.values), 0);
  assert.equal(Math.max(...unit.values), 1);
});

test("mesh_quality names WHERE a surface is defective, and mesh_transform repairSurface fixes it", async () => {
  const dir = tmpDir();
  const fixture = path.resolve(__dirname, "../../src/test/fixtures/repair/open_box_hole.mdpa");
  const before = (await meshQuality({ path: fixture, defectLimit: 2 })) as {
    surfaceDefects: {
      surfaceCellCount: number;
      boundaryEdges: { total: number; edges: number[][] };
      inconsistentFaces: { total: number };
    };
  };
  assert.equal(before.surfaceDefects.surfaceCellCount, 10);
  assert.equal(before.surfaceDefects.boundaryEdges.total, 4);
  assert.equal(before.surfaceDefects.boundaryEdges.edges.length, 2, "the list is capped, the total is not");
  assert.equal(before.surfaceDefects.inconsistentFaces.total, 0);

  const out = path.join(dir, "repaired.mdpa");
  const result = (await meshTransform({
    path: fixture,
    ops: [{ op: "repairSurface" }],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };
  assert.equal(result.outcomes[0].noop, false);
  assert.match(result.outcomes[0].message!, /Repair_Fill/);
  const after = (await meshQuality({ path: out })) as { surfaceDefects: { boundaryEdges: { total: number } } };
  assert.equal(after.surfaceDefects.boundaryEdges.total, 0);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(model.subModelParts.find((p) => p.name === "Repair_Fill")?.conditionIds.length, 4);
  // A repaired file records the op as adopting, and the capability list says so.
  const caps = (await meshCapabilities()) as { fidelity: { adoptingOperations: string[] } };
  assert.ok(caps.fidelity.adoptingOperations.includes("repairSurface"));
});

test("mesh_curvature reports statistics and the Gauss-Bonnet check; mesh_transform curvature writes the fields", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "sphere.mdpa");
  fs.writeFileSync(file, writeMdpa(icosphere(2, 2)));
  const r = (await meshCurvature({ path: file, principal: true })) as {
    computed: boolean;
    fields: Record<string, { min: number; max: number; count: number }>;
    gaussBonnetResidual: number;
    eulerCharacteristic: number;
    warnings: string[];
  };
  assert.equal(r.computed, true);
  assert.deepEqual(Object.keys(r.fields), ["CURVATURE_MEAN", "CURVATURE_GAUSSIAN", "CURVATURE_K1", "CURVATURE_K2"]);
  assert.ok(Math.abs(r.fields.CURVATURE_MEAN.min - 0.5) < 0.02 && Math.abs(r.fields.CURVATURE_MEAN.max - 0.5) < 0.02);
  assert.equal(r.fields.CURVATURE_MEAN.count, 162);
  assert.equal(r.eulerCharacteristic, 2);
  assert.ok(Math.abs(r.gaussBonnetResidual) < 1e-9);
  assert.deepEqual(r.warnings, []);
  // The read-only tool wrote nothing; the op does.
  const out = path.join(dir, "with-curvature.mdpa");
  await meshTransform({ path: file, ops: [{ op: "curvature", gaussian: false, outputPrefix: "KAPPA" }], outputPath: out });
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(model.fields.some((f) => f.kind === "Nodal" && f.variable === "KAPPA_MEAN" && f.ids.length === 162));
  assert.ok(!model.fields.some((f) => f.variable === "KAPPA_GAUSSIAN"));
  // A solid is refused with a pointer, not a crash.
  const solid = (await meshCurvature({ path: writeFixture(dir) })) as { computed: boolean; message: string };
  assert.equal(solid.computed, false);
  assert.match(solid.message, /Export skin|mesh_extract_skin|volume/);
});

test("mesh_transform shrinkwraps onto a surface file and applies a smoothed Sobolev displacement", async () => {
  const dir = tmpDir();
  const target = path.join(dir, "plane.mdpa");
  fs.writeFileSync(
    target,
    "Begin Nodes\n1 -5 -5 0\n2 5 -5 0\n3 5 5 0\n4 -5 5 0\nEnd Nodes\nBegin Conditions SurfaceCondition3D3N\n1 0 1 2 3\n2 0 1 3 4\nEnd Conditions\n"
  );
  const src = path.join(dir, "sheet.mdpa");
  fs.writeFileSync(
    src,
    "Begin Nodes\n1 0 0 1\n2 1 0 1\n3 0 1 1\nEnd Nodes\nBegin Elements Element2D3N\n1 0 1 2 3\nEnd Elements\n" +
      "Begin NodalData D\n1 0 (0.1,0,0)\n2 0 (0.1,0,0)\n3 0 (0.1,0,0)\nEnd NodalData\n"
  );
  const out = path.join(dir, "wrapped.mdpa");
  const r = (await meshTransform({
    path: src,
    ops: [
      { op: "sobolevDeform", variable: "D", lengthScale: 0.5 },
      { op: "shrinkwrap", path: target, recordDistance: true },
    ],
    outputPath: out,
  })) as { outcomes: { noop: boolean; message?: string }[] };
  assert.deepEqual(r.outcomes.map((o) => o.noop), [false, false]);
  assert.match(r.outcomes[1].message!, /Projected 3 node\(s\)/);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok([...model.coords].filter((_, i) => i % 3 === 2).every((v) => Math.abs(v) < 1e-6), "all nodes on the plane");
  assert.ok(Math.abs(model.coords[0] - 0.1) < 1e-6, "the Sobolev step moved x by the constant 0.1");
  assert.ok(model.fields.some((f) => f.variable === "SHRINKWRAP_DISTANCE"));
  // An unreadable target is a noop with a reason, not a crash.
  const bad = (await meshTransform({ path: src, ops: [{ op: "shrinkwrap", path: path.join(dir, "missing.stl") }], outputPath: path.join(dir, "x.mdpa") })) as { outcomes: { noop: boolean; message: string }[] };
  assert.equal(bad.outcomes[0].noop, true);
  assert.match(bad.outcomes[0].message, /Could not read/);
});

test("mesh_compare reports the structural difference and writes a difference mesh", async () => {
  const dir = tmpDir();
  const a = writeFixture(dir, "a.mdpa");
  const b = writeFixture(dir, "b.mdpa");
  const same = (await meshCompare({ pathA: a, pathB: b })) as { comparison: { verdict: string; nodes: { moved: number } } };
  assert.equal(same.comparison.verdict, "identical");
  // B: one node moved and a nodal field shifted.
  const bm = parseMdpa(fs.readFileSync(b, "utf8"));
  const coords = Float32Array.from(bm.coords);
  coords[0] += 0.25;
  fs.writeFileSync(b, writeMdpa({ ...bm, coords }));
  const moved = (await meshCompare({ pathA: a, pathB: b, atol: 0.1 })) as { comparison: { verdict: string; nodes: { moved: number; worstId: number } } };
  assert.equal(moved.comparison.verdict, "different");
  assert.equal(moved.comparison.nodes.moved, 1);
  // A field comparison writes the difference mesh.
  const withField = path.join(dir, "fa.mdpa");
  const withField2 = path.join(dir, "fb.mdpa");
  await meshTransform({ path: a, ops: [{ op: "fieldCalc", expr: "x + y + z", location: "Nodal", output: "S" }], outputPath: withField });
  await meshTransform({ path: a, ops: [{ op: "fieldCalc", expr: "x + y + z + 0.5", location: "Nodal", output: "S" }], outputPath: withField2 });
  const out = path.join(dir, "diff.mdpa");
  const r = (await meshCompare({ pathA: withField, pathB: withField2, variable: "S", outputPath: out })) as {
    fieldComparison: { compared: number; maxAbs: number };
    written: string[];
    outputPath: string;
  };
  assert.equal(r.fieldComparison.compared, 4);
  assert.ok(Math.abs(r.fieldComparison.maxAbs - 0.5) < 1e-6);
  assert.deepEqual(r.written, ["Nodal:S_DIFF", "Nodal:S_ABS", "Nodal:S_REL"]);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(model.fields.some((f) => f.variable === "S_ABS" && f.ids.length === 4));
  await assert.rejects(meshCompare({ pathA: a, pathB: b, outputPath: path.join(dir, "z.mdpa") }), /needs a `variable`/);
});

test("mesh_derive writes a slice, an isosurface and a threshold region; mesh_probe samples along a line", async () => {
  const dir = tmpDir();
  // A 2 x 1 x 1 bar of tetrahedra with a nodal T = x.
  const bar = path.join(dir, "bar.mdpa");
  const nodes: string[] = [];
  const at = (i: number, j: number, k: number) => i * 4 + j * 2 + k + 1;
  for (let i = 0; i <= 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) nodes.push(`${at(i, j, k)} ${i} ${j} ${k}`);
  fs.writeFileSync(
    bar,
    "Begin Nodes\n" + nodes.join("\n") + "\nEnd Nodes\nBegin Elements Element3D8N\n" +
      [0, 1].map((i) => `${i + 1} 0 ${at(i, 0, 0)} ${at(i + 1, 0, 0)} ${at(i + 1, 1, 0)} ${at(i, 1, 0)} ${at(i, 0, 1)} ${at(i + 1, 0, 1)} ${at(i + 1, 1, 1)} ${at(i, 1, 1)}`).join("\n") +
      "\nEnd Elements\nBegin NodalData T\n" + nodes.map((s) => `${s.split(" ")[0]} 0 ${s.split(" ")[1]}`).join("\n") + "\nEnd NodalData\n"
  );
  const tets = path.join(dir, "tets.mdpa");
  await meshTransform({ path: bar, ops: [{ op: "simplexify" }], outputPath: tets });

  const slice = (await meshDerive({ path: tets, kind: "slice", origin: [1.5, 0, 0], normal: [1, 0, 0], outputPath: path.join(dir, "slice.vtu") })) as { summary: string; nodeCount: number; fields: { variable: string }[] };
  assert.match(slice.summary, /Slice through/);
  assert.ok(slice.fields.some((f) => f.variable === "SOURCE_ENTITY_ID"));
  assert.ok(fs.existsSync(path.join(dir, "slice.vtu")));

  const iso = (await meshDerive({ path: tets, kind: "isosurface", variable: "T", values: [0.5, 1.5], outputPath: path.join(dir, "iso.vtu") })) as { fields: { variable: string }[] };
  assert.ok(iso.fields.some((f) => f.variable === "ISO_VALUE"));

  const region = (await meshDerive({ path: tets, kind: "threshold", variable: "T", range: [0, 1], outputPath: path.join(dir, "region.mdpa") })) as { summary: string; blocks: { count: number }[] };
  assert.match(region.summary, /50\.0% of the volume/);
  const back = parseMdpa(fs.readFileSync(path.join(dir, "region.mdpa"), "utf8"));
  assert.equal(back.blocks.find((b) => b.kind === "Elements")!.count, 6);
  await assert.rejects(meshDerive({ path: tets, kind: "threshold", variable: "T", outputPath: path.join(dir, "x.mdpa") }), /either an absolute/);
  await assert.rejects(meshDerive({ path: tets, kind: "slice", origin: [0, 0, 0], outputPath: path.join(dir, "x.vtu") }), /normal must be/);

  const csv = path.join(dir, "probe.csv");
  const probe = (await meshProbe({ path: tets, points: [[0, 0.5, 0.5], [3, 0.5, 0.5]], variable: "T", samples: 7, outputPath: csv })) as {
    rows: { distance: number; values: (number | null)[] }[];
    covered: number;
    uncovered: number;
  };
  assert.equal(probe.rows.length, 7);
  assert.ok(probe.covered > 0 && probe.uncovered > 0, "the path leaves the bar");
  assert.equal(probe.rows[0].values[0] !== null && Math.abs((probe.rows[0].values[0] as number) - 0) < 1e-6, true);
  assert.equal(probe.rows[6].values[0], null);
  assert.match(fs.readFileSync(csv, "utf8"), /^distance,x,y,z,T\n/);
  // A static file is a one-step series.
  const all = (await meshProbe({ path: tets, points: [[0, 0.5, 0.5], [2, 0.5, 0.5]], variable: "T", samples: 3, allSteps: true })) as { source: string; steps: { result?: { covered: number } }[] };
  assert.equal(all.source, "single");
  assert.equal(all.steps[0].result!.covered, 3);
  await assert.rejects(meshProbe({ path: tets, points: [[0, 0, 0]], variable: "T" }), /at least two/);
});

test("mesh_probe allSteps walks the committed Kratos series and probes each step", async () => {
  const src = path.resolve(__dirname, "../../example/VTK/Main_0_2.vtk");
  const info = (await meshInfo({ path: src })) as { fields?: { name?: string; variable?: string; kind: string }[]; bounds?: { min: number[]; max: number[] } };
  const nodal = (info.fields ?? []).find((f) => f.kind === "Nodal");
  assert.ok(nodal, "the example series carries a nodal field");
  const variable = (nodal!.variable ?? nodal!.name)!;
  const b = info.bounds!;
  const mid = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
  const out = path.join(tmpDir(), "series-probe.csv");
  const r = (await meshProbe({
    path: src,
    points: [[b.min[0], mid[1], mid[2]], [b.max[0], mid[1], mid[2]]],
    variable,
    samples: 5,
    allSteps: true,
    outputPath: out,
  })) as { source: string; totalSteps: number; steps: { label: string; result?: { rows: unknown[] }; error?: string }[] };
  assert.equal(r.source, "files");
  assert.equal(r.totalSteps, 3);
  assert.equal(r.steps.length, 3);
  assert.ok(r.steps.every((s) => s.result && s.result.rows.length === 5), JSON.stringify(r.steps.map((s) => s.error)));
  const lines = fs.readFileSync(out, "utf8").trim().split("\n");
  assert.match(lines[0], /^step,distance,x,y,z,/);
  assert.equal(lines.length, 1 + 3 * 5);
});

test("mesh_split writes per-part files with a manifest, splits connected bodies, and mesh_capabilities reports the live partitioners", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "bar.mdpa");
  fs.writeFileSync(src, writeMdpa(tetBar(6)));
  const out = path.join(dir, "parts");
  const r = (await meshSplit({ path: src, by: "partition", nparts: 3, ghostLayers: 1, outputDir: out, format: ".vtu" })) as {
    manifestPath: string;
    parts: number;
    idsPreserved: boolean;
    ghostLayers: number;
    files: { part: number; file: string; owned: { Elements: number }; ghost: { Elements: number } }[];
  };
  assert.equal(r.parts, 3);
  assert.equal(r.idsPreserved, true);
  assert.equal(r.ghostLayers, 1);
  for (const f of r.files) assert.ok(fs.existsSync(path.join(out, f.file)), f.file);
  assert.equal(r.files.reduce((s, f) => s + f.owned.Elements, 0), 36, "every element owned exactly once");
  assert.ok(r.files.every((f) => f.ghost.Elements > 0));
  assert.deepEqual(JSON.parse(fs.readFileSync(r.manifestPath, "utf8")).files.map((f: { part: number }) => f.part), [0, 1, 2]);

  // Two bodies, split into two files.
  const bodies = path.join(dir, "bodies.mdpa");
  fs.writeFileSync(
    bodies,
    "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n5 1 1 1\n10 10 0 0\n11 11 0 0\n12 10 1 0\n13 10 0 1\nEnd Nodes\n" +
      "Begin Elements Element3D4N\n1 0 1 2 3 4\n2 0 2 3 4 5\n7 0 10 11 12 13\nEnd Elements\n"
  );
  const s = (await meshSplit({ path: bodies, by: "component", outputDir: path.join(dir, "bodies"), format: ".mdpa" })) as {
    groups: { key: string; file: string; elements: number }[];
  };
  assert.deepEqual(s.groups.map((g) => [g.key, g.elements]), [["component_0", 2], ["component_1", 1]]);
  const back = parseMdpa(fs.readFileSync(path.join(dir, "bodies", s.groups[1].file), "utf8"));
  assert.equal(back.blocks[0].entityIds[0], 7, "the original element id is kept");

  await assert.rejects(meshSplit({ path: src, by: "partition", nparts: 2, method: "kahip", outputDir: out }), /KaHIP is not available/);
  await assert.rejects(meshSplit({ path: src, by: "partition", outputDir: out }), /nparts/);
  await assert.rejects(meshSplit({ path: src, by: "field", outputDir: out }), /variable/);

  const caps = (await meshCapabilities()) as { partitioning: { available: string[]; unavailable: { method: string }[] } };
  assert.ok(caps.partitioning.available.includes("sfc"));
  assert.ok(caps.partitioning.unavailable.some((u) => u.method === "kahip"), "the WebAssembly build has no KaHIP");
});

test("mesh_derive decimate writes a simplified copy that keeps entity ids, and refuses a solid by name", async () => {
  const dir = tmpDir();
  const sphere = path.join(dir, "sphere.mdpa");
  fs.writeFileSync(sphere, writeMdpa(icosphere(1, 3)));
  const r = (await meshDerive({ path: sphere, kind: "decimate", ratio: 0.25, outputPath: path.join(dir, "small.mdpa") })) as { summary: string; blocks: { count: number }[] };
  assert.match(r.summary, /Decimated 1280 → 3\d\d faces/);
  const back = parseMdpa(fs.readFileSync(path.join(dir, "small.mdpa"), "utf8"));
  const total = back.blocks.reduce((s, b) => s + b.count, 0);
  assert.ok(Math.abs(total - 320) <= 2);
  const srcIds = new Set(parseMdpa(fs.readFileSync(sphere, "utf8")).blocks.flatMap((b) => [...b.entityIds]));
  assert.ok(back.blocks.every((b) => [...b.entityIds].every((id) => srcIds.has(id))), "survivors keep their source entity ids");
  await assert.rejects(meshDerive({ path: sphere, kind: "decimate", outputPath: path.join(dir, "x.mdpa") }), /exactly one/);
  await assert.rejects(meshDerive({ path: writeFixture(dir), kind: "decimate", ratio: 0.5, outputPath: path.join(dir, "y.mdpa") }), /volume cells|quadrilateral|Export skin|Simplexify/);
});

test("mesh_transform chains surfaceRemesh, volumeMesh and optimizeVolume, each adopted in place with its identity policy", async () => {
  const dir = tmpDir();
  const sphere = path.join(dir, "sphere.mdpa");
  const model = icosphere(1, 3);
  // A part on the northern faces, to see it survive as boundary conditions on the volume.
  const b = model.blocks[0];
  const north = [...b.entityIds].filter((_, i) => [0, 1, 2].reduce((s, k) => s + model.coords[model.nodeIds.indexOf(b.connectivity[i * 3 + k]) * 3 + 2], 0) / 3 > 0.2);
  fs.writeFileSync(
    sphere,
    writeMdpa({ ...model, subModelParts: [{ name: "North", path: "North", nodeIds: new Int32Array(0), elementIds: new Int32Array(0), conditionIds: Int32Array.from(north), geometryIds: new Int32Array(0), constraintIds: new Int32Array(0), children: [] }] })
  );
  const out = path.join(dir, "volume.mdpa");
  const r = (await meshTransform({
    path: sphere,
    ops: [
      { op: "surfaceRemesh", numClusters: 250 },
      { op: "volumeMesh", cellSize: 0.3 },
      { op: "optimizeVolume" },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };
  assert.equal(r.outcomes[0].noop, false, String(r.outcomes[0].message));
  assert.match(r.outcomes[0].message!, /→ 250 nodes/);
  assert.equal(r.outcomes[1].noop, false, String(r.outcomes[1].message));
  assert.match(r.outcomes[1].message!, /Generated \d+ tetrahedra/);
  // optimizeVolume may legitimately find nothing to improve on a lattice mesh — either outcome is a truthful report.
  assert.match(r.outcomes[2].message!, /Optimized \d+ tetrahedra|Nothing to improve/);
  const back = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(back.blocks.some((x) => x.kind === "Elements" && x.name === "Element3D4N" && x.count > 100));
  const cond = back.blocks.filter((x) => x.kind === "Conditions");
  assert.ok(cond.length >= 1 && cond[0].count > 50, "the boundary is written as Conditions");
  const part = back.subModelParts.find((p) => p.name === "North")!;
  assert.ok(part.conditionIds.length > 0, "the North part survived as boundary conditions");
  const caps = (await meshCapabilities()) as { fidelity: { adoptingOperations: string[] } };
  for (const op of ["surfaceRemesh", "volumeMesh", "optimizeVolume"]) assert.ok(caps.fidelity.adoptingOperations.includes(op));
});

test("mesh_transform rejects a fieldCalc formula referencing an unknown field", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshTransform({
      path: writeFixture(dir),
      ops: [{ op: "fieldCalc", expr: "0.5 * bogus", location: "Nodal", output: "OUT" }],
      outputPath: path.join(dir, "bad.mdpa"),
    }),
    /unknown name "bogus"/i
  );
});

test("mesh_transform merges another mesh file, offsetting ids", async () => {
  // The single-`path` spelling: still accepted, since recipes on disk can
  // predate the extension that reads them.
  const dir = tmpDir();
  const src = writeFixture(dir);
  const other = writeFixture(dir, "other.mdpa");
  const out = path.join(dir, "merged.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "mergeMesh", path: other, name: "Merged" }],
    outputPath: out,
  })) as { outcomes: { op: string }[]; nodeCount: { before: number; after: number } };
  assert.equal(result.outcomes[0].op, "mergeMesh");
  assert.equal(result.nodeCount.after, 8); // 4 + 4, no welding requested
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(
    model.subModelParts.some((p) => p.name === "Merged"),
    "the merged-in geometry is wrapped in its own SubModelPart"
  );
});

test("mesh_transform merges several files in one op, one part per source", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const beam = writeFixture(dir, "beam.mdpa");
  const column = writeFixture(dir, "column.mdpa");
  const out = path.join(dir, "merged-many.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "mergeMesh", paths: [beam, column] }],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean }[]; nodeCount: { after: number } };
  assert.equal(result.outcomes[0].noop, false);
  assert.equal(result.nodeCount.after, 12); // 4 + 4 + 4
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const paths = model.subModelParts.map((p) => p.path);
  assert.ok(paths.includes("beam"), "each source keeps its own part, named from its stem");
  assert.ok(paths.includes("column"));
});

test("mesh_transform renumbers a gappy id space into a gapless run", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const out = path.join(dir, "renumbered.mdpa");
  // Crop first so the surviving ids are genuinely gappy, then compact them.
  const result = (await meshTransform({
    path: src,
    ops: [
      { op: "mergeMesh", paths: [writeFixture(dir, "second.mdpa")] },
      { op: "renumber", target: "all" },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[1].op, "renumber");
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.deepEqual(
    Array.from(model.nodeIds),
    Array.from({ length: model.nodeIds.length }, (_, i) => i + 1),
    "node ids are 1..N with no holes"
  );
  const elems = model.blocks
    .filter((b) => b.kind === "Elements")
    .flatMap((b) => Array.from(b.entityIds));
  assert.deepEqual(elems.slice().sort((a, b) => a - b), [1, 2], "and so are the element ids");
});

test("mesh_pack_series packs a run's step files into one timeline file", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "solve.xdmf");
  const vtkDir = path.resolve(__dirname, "../../example/VTK");
  const res = (await meshPackSeries({ path: vtkDir, outputPath: out })) as {
    steps: number;
    times: number[];
    companions: string[];
    sourceFiles: string[];
  };
  assert.equal(res.steps, 3);
  // The times are the Kratos step numbers from the filenames, not 0..N-1.
  assert.deepEqual(res.times, [2, 4, 6]);
  assert.equal(res.sourceFiles.length, 3);
  assert.ok(fs.existsSync(out));
  // The .h5 is part of the output: an .xdmf without it is unreadable.
  assert.equal(res.companions.length, 1);
  assert.ok(res.companions[0].endsWith("solve.h5") && fs.existsSync(res.companions[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);

  // Reading one file of the series is equivalent to naming the directory.
  const out2 = path.join(dir, "byfile.xdmf");
  const res2 = (await meshPackSeries({
    path: path.join(vtkDir, "Main_0_4.vtk"),
    outputPath: out2,
  })) as { steps: number };
  assert.equal(res2.steps, 3);

  // A single-mesh format cannot hold a series, and the error must say that
  // rather than listing the thirty formats the mesh writer knows.
  await assert.rejects(
    meshPackSeries({ path: vtkDir, outputPath: path.join(dir, "no.vtu") }),
    /Cannot pack a series/
  );
  // A lone file has nothing to combine.
  await assert.rejects(
    meshPackSeries({ path: writeFixture(dir), outputPath: path.join(dir, "x.xdmf") }),
    /No multi-step series/
  );
});

test("mesh_find_entity locates nodes and elements with SMP membership", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const node = (await meshFindEntity({ path: src, entityType: "Node", entityId: 4 })) as {
    coordinates: number[];
    subModelParts: string[];
  };
  assert.deepEqual(node.coordinates, [0, 0, 1]);
  // The "Parts" container lists no nodes of its own — only its child does.
  assert.deepEqual(node.subModelParts, ["Parts/Solid", "Loaded"]);
  const elem = (await meshFindEntity({ path: src, entityType: "Element", entityId: 1 })) as {
    block: string;
    nodeIds: number[];
    subModelParts: string[];
  };
  assert.equal(elem.block, "Element3D4N");
  assert.deepEqual(elem.nodeIds, [1, 2, 3, 4]);
  assert.deepEqual(elem.subModelParts, ["Parts/Solid"]);
  await assert.rejects(meshFindEntity({ path: src, entityType: "Node", entityId: 99 }), /not found/);
});

test("problemtype_list returns built-ins and surfaces workspace load failures", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "broken.js"), "this is not a problemtype");
  const result = (await problemtypeList({ workspaceDirs: [dir] })) as {
    problemtypes: { id?: string; source: string; error?: string }[];
  };
  const ids = result.problemtypes.map((p) => p.id);
  assert.ok(ids.includes("structural"));
  assert.ok(ids.includes("fluid"));
  const broken = result.problemtypes.find((p) => p.error);
  assert.ok(broken, "broken.js should surface as an error entry");
  assert.equal(broken.source, "js");
});

test("problemtype_describe returns the declaration plus a default state", async () => {
  const result = (await problemtypeDescribe({ problemtype: "structural" })) as {
    declaration: { id: string; conditions: { id: string }[] };
    defaultState: { problemtypeId: string; version: number };
  };
  assert.equal(result.declaration.id, "structural");
  assert.ok(result.declaration.conditions.some((c) => c.id === "displacement"));
  assert.equal(result.defaultState.problemtypeId, "structural");
  await assert.rejects(problemtypeDescribe({ problemtype: "nope" }), /Unknown problemtype.*structural/s);
});

test("case_write_state + case_validate round-trip; bad paths become issues", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const write = (await caseWriteState({ meshPath: src, state: structuralState() })) as {
    casePath: string;
  };
  assert.equal(write.casePath, path.join(dir, "beam.kratoscase.json"));
  const ok = (await caseValidate({ meshPath: src })) as { ok: boolean; issues: string[] };
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.ok, true);
  const bad = structuralState();
  bad.assignments.push({ conditionId: "nope", smpPath: "Missing/Part", values: {} });
  const invalid = (await caseValidate({ meshPath: src, state: bad })) as {
    ok: boolean;
    issues: string[];
  };
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((i) => i.includes('"nope"')));
  assert.ok(invalid.issues.some((i) => i.includes("Missing/Part")));
});

test("case_generate writes the case files and the adapted _case.mdpa", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const result = (await caseGenerate({ meshPath: src, state: structuralState() })) as {
    written: string[];
    renames: { from: string; to: string }[];
    problemtype: string;
    preparation: { version: number; sourceMesh: { revision: string }; solverMesh: { revision: string }; inputs: { name: string; revision: string }[] };
  };
  assert.equal(result.problemtype, "structural");
  const names = result.written.map((p) => path.basename(p));
  assert.ok(names.includes("ProjectParameters.json"));
  assert.ok(names.includes("StructuralMaterials.json"));
  assert.ok(names.includes("MainKratos.py"));
  // Structural declares meshNaming, so Element3D4N is renamed and a copy written.
  assert.ok(result.renames.length > 0);
  assert.ok(names.includes("beam_case.mdpa"));
  assert.equal(result.preparation.version, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(result.preparation.sourceMesh.revision));
  assert.ok(/^[a-f0-9]{64}$/.test(result.preparation.solverMesh.revision));
  assert.equal(result.preparation.inputs.some(input => input.name === "MainKratos.py"), true);
  const pp = JSON.parse(fs.readFileSync(path.join(dir, "ProjectParameters.json"), "utf8"));
  assert.equal(pp.solver_settings.model_import_settings.input_filename, "beam_case");
  assert.match(fs.readFileSync(path.join(dir, "beam_case.mdpa"), "utf8"), /Begin Properties 0/);
  // Original mesh untouched.
  assert.equal(fs.readFileSync(src, "utf8"), MDPA_3D);
});

test("case_generate converts a non-.mdpa mesh to a _case.mdpa", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const vtu = path.join(dir, "beam.vtu");
  await meshConvert({ path: src, outputPath: vtu });
  const result = (await caseGenerate({ meshPath: vtu, state: structuralState() })) as {
    written: string[];
    warnings: string[];
  };
  const names = result.written.map((p) => path.basename(p));
  // Always converted: the solver reads .mdpa, and there is no source .mdpa.
  assert.ok(names.includes("beam_case.mdpa"));
  const pp = JSON.parse(fs.readFileSync(path.join(dir, "ProjectParameters.json"), "utf8"));
  assert.equal(pp.solver_settings.model_import_settings.input_filename, "beam_case");
  // The .vtu round trip drops the SubModelParts, so Generate says the
  // assignments have nothing to attach to rather than failing silently.
  assert.ok(result.warnings.some((w) => w.includes("no SubModelParts")));
  // The source mesh is untouched.
  assert.ok(fs.existsSync(vtu));
});

test("case_generate without state falls back to problemtype defaults", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  const result = (await caseGenerate({ meshPath: src, problemtype: "structural" })) as {
    warnings: string[];
  };
  assert.ok(result.warnings.some((w) => w.includes("defaults")));
  await assert.rejects(caseGenerate({ meshPath: writeFixture(dir, "other.mdpa") }), /problemtype/);
});

test("problem_pack bundles mesh, case, recipe and generated files; problem_unpack restores them", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir);
  await caseWriteState({ meshPath: src, state: structuralState() });
  await caseGenerate({ meshPath: src, state: structuralState() });
  fs.writeFileSync(
    path.join(dir, "beam.ops.json"),
    serializeOps([{ op: "scale", sx: 2, sy: 2, sz: 2 }], "beam.mdpa")
  );

  const packed = (await problemPack({ meshPath: src })) as {
    archivePath: string;
    files: string[];
    manifest: { mesh: string; ops?: string; case?: string; generated: string[] };
  };
  assert.equal(packed.archivePath, path.join(dir, "beam.kratosproblem.zip"));
  assert.equal(packed.manifest.mesh, "beam.mdpa");
  assert.equal(packed.manifest.ops, "beam.ops.json");
  assert.equal(packed.manifest.case, "beam.kratoscase.json");
  // The materials file is discovered through ProjectParameters.json.
  assert.ok(packed.manifest.generated.includes("StructuralMaterials.json"));
  assert.ok(packed.manifest.generated.includes("beam_case.mdpa"));
  assert.ok(packed.files.includes("MainKratos.py"));

  const dest = path.join(tmpDir(), "restored");
  const unpacked = (await problemUnpack({ archivePath: packed.archivePath, destDir: dest })) as {
    meshPath?: string;
    opsRecipePath?: string;
    extracted: string[];
  };
  assert.equal(unpacked.meshPath, path.join(dest, "beam.mdpa"));
  assert.equal(unpacked.opsRecipePath, path.join(dest, "beam.ops.json"));
  assert.equal(fs.readFileSync(path.join(dest, "beam.mdpa"), "utf8"), MDPA_3D);
  assert.ok(fs.existsSync(path.join(dest, "ProjectParameters.json")));
  // The manifest stays archive metadata — not extracted.
  assert.ok(!unpacked.extracted.includes("kratosproblem.json"));

  // A second unpack into the same folder refuses without overwrite.
  await assert.rejects(
    problemUnpack({ archivePath: packed.archivePath, destDir: dest }),
    /overwrite/
  );
  await problemUnpack({ archivePath: packed.archivePath, destDir: dest, overwrite: true });

  // The bundled recipe replays through mesh_transform.
  const out = path.join(dest, "beam_scaled.mdpa");
  await meshTransform({ path: unpacked.meshPath!, recipePath: unpacked.opsRecipePath!, outputPath: out });
  const scaled = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.equal(scaled.bounds.max[0], 2);
});

test("problem_pack without case/generated files bundles just the mesh", async () => {
  const dir = tmpDir();
  const src = writeFixture(dir, "solo.mdpa");
  const packed = (await problemPack({ meshPath: src })) as {
    files: string[];
    manifest: { ops?: string; case?: string; generated: string[] };
  };
  assert.deepEqual(packed.files, ["solo.mdpa"]);
  assert.equal(packed.manifest.ops, undefined);
  assert.equal(packed.manifest.case, undefined);
  assert.deepEqual(packed.manifest.generated, []);
  await assert.rejects(problemPack({ meshPath: src, recipePath: path.join(dir, "missing.json") }), /recipe/i);
});

// meshio++ 8.1.0 regions reach the model as SubModelParts, which means the
// grouping tools now work on every format that carries named groups — not
// just .mdpa. No tool code changed; this pins the capability.
test("named groups from a gmsh file are visible to mesh_info and extractable", async () => {
  const src = path.resolve(__dirname, "../../src/test/fixtures/regions/insulated-2.2.msh");
  const info = (await meshInfo({ path: src })) as {
    subModelParts: { path: string; counts: { elements: number } }[];
  };
  assert.deepEqual(
    info.subModelParts.map((p) => p.path).sort(),
    ["convection", "insulation", "wire"]
  );

  const out = path.join(tmpDir(), "wire.mdpa");
  const res = (await meshExtractSubModelPart({
    path: src,
    submodelpart: "wire",
    outputPath: out,
  })) as { blocks: { count: number }[] };
  assert.equal(res.blocks[0].count, 45);
  // The slice is a standalone, re-parseable mesh.
  assert.equal(parseMdpa(fs.readFileSync(out, "utf8")).blocks[0].count, 45);
});

// meshio++ 8.6.0 gave Exodus a time-series concept (ReadOptions.timeStep /
// MeshMetadata.timeValues). mesh_info and mesh_convert thread it through
// loadMesh(), which must also keep the LRU cache from serving a step's
// result under a different step's request.
test("mesh_info reports timeValues and selects the requested step", async () => {
  const src = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  const info0 = (await meshInfo({ path: src })) as {
    timeStep?: number;
    timeValues?: number[];
    fields: { variable: string }[];
  };
  assert.deepEqual(info0.timeValues, [0, 0.5, 1]);
  assert.equal(info0.timeStep, 0);

  const info2 = (await meshInfo({ path: src, timeStep: 2 })) as { timeStep?: number };
  assert.equal(info2.timeStep, 2);
});

test("mesh_info's timeStep bypasses the LRU cache in both directions", async () => {
  // Regression guard for the cache key: path+mtime+size does not distinguish
  // steps, so a cached step-0 read must not be served for step 2 and vice
  // versa — proven via mesh_convert's actual field values below, not just
  // the timeStep number this tool happens to echo back.
  const src = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  await meshInfo({ path: src }); // prime the cache at step 0
  const step2 = (await meshInfo({ path: src, timeStep: 2 })) as { timeStep?: number };
  assert.equal(step2.timeStep, 2);
  const step0Again = (await meshInfo({ path: src })) as { timeStep?: number };
  assert.equal(step0Again.timeStep, 0);
});

test("mesh_info's timeStep is rejected for a format with no time concept", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshInfo({ path: writeFixture(dir), timeStep: 1 }),
    /timeStep is only accepted/i
  );
});

// piece/dropGhosts (roadmap item 3, Step 4/4b): parallel/partitioned VTK XML.
const PVTU_FIXTURE = path.resolve(__dirname, "../../src/test/fixtures/pvtu/two-piece.pvtu");

test("mesh_info's piece selects one .pvtu piece instead of merging", async () => {
  const merged = (await meshInfo({ path: PVTU_FIXTURE })) as { nodeCount: number };
  // Default dropGhosts:true for .pvtu/.pvtp: 3 + 3 points, the ghost cell's
  // duplicate points dropped.
  assert.equal(merged.nodeCount, 6);

  const piece0 = (await meshInfo({ path: PVTU_FIXTURE, piece: 0 })) as { nodeCount: number };
  assert.equal(piece0.nodeCount, 3);

  const piece1 = (await meshInfo({ path: PVTU_FIXTURE, piece: 1, dropGhosts: false })) as {
    nodeCount: number;
  };
  assert.equal(piece1.nodeCount, 6);
});

test("mesh_info's dropGhosts:false on a .pvtu keeps the duplicate cell", async () => {
  const kept = (await meshInfo({ path: PVTU_FIXTURE, dropGhosts: false })) as { nodeCount: number };
  assert.equal(kept.nodeCount, 9);
});

test("mesh_convert's piece writes a single .pvtu piece", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "piece0.mdpa");
  await meshConvert({ path: PVTU_FIXTURE, outputPath: out, piece: 0 });
  const info = (await meshInfo({ path: out })) as { nodeCount: number };
  assert.equal(info.nodeCount, 3);
});

test("mesh_info's piece/dropGhosts bypass the LRU cache in both directions", async () => {
  await meshInfo({ path: PVTU_FIXTURE }); // prime the cache at the default (merged, dropGhosts:true)
  const piece0 = (await meshInfo({ path: PVTU_FIXTURE, piece: 0 })) as { nodeCount: number };
  assert.equal(piece0.nodeCount, 3);
  const defaultAgain = (await meshInfo({ path: PVTU_FIXTURE })) as { nodeCount: number };
  assert.equal(defaultAgain.nodeCount, 6);
});

// region (roadmap item 3, Step 5): a multi-region OpenFOAM case.
const MULTIREGION_FIXTURE = path.resolve(
  __dirname,
  "../../src/test/fixtures/openfoam-multiregion/case/case.foam"
);

test("mesh_info's region selects one OpenFOAM region instead of merging every one", async () => {
  const merged = (await meshInfo({ path: MULTIREGION_FIXTURE })) as { nodeCount: number };
  assert.equal(merged.nodeCount, 16, "both regions merged by default");

  const fluid = (await meshInfo({ path: MULTIREGION_FIXTURE, region: "fluid" })) as { nodeCount: number };
  assert.equal(fluid.nodeCount, 8);

  await assert.rejects(
    meshInfo({ path: MULTIREGION_FIXTURE, region: "nope" }),
    /region "nope" not found.*fluid, solid/s
  );
});

test("mesh_info's region is rejected for a format with no region concept", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshInfo({ path: writeFixture(dir), region: "x" }),
    /region is only accepted for OpenFOAM/i
  );
});

test("mesh_convert's region writes a single OpenFOAM region", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "fluid.mdpa");
  await meshConvert({ path: MULTIREGION_FIXTURE, outputPath: out, region: "fluid" });
  const info = (await meshInfo({ path: out })) as { nodeCount: number };
  assert.equal(info.nodeCount, 8);
});

test("mesh_info's region bypasses the LRU cache in both directions", async () => {
  await meshInfo({ path: MULTIREGION_FIXTURE }); // prime the cache at the default (merged)
  const fluid = (await meshInfo({ path: MULTIREGION_FIXTURE, region: "fluid" })) as { nodeCount: number };
  assert.equal(fluid.nodeCount, 8);
  const defaultAgain = (await meshInfo({ path: MULTIREGION_FIXTURE })) as { nodeCount: number };
  assert.equal(defaultAgain.nodeCount, 16);
});

// OpenFOAM time directories are the in-file timeline for a .foam marker:
// mesh_info lists them and selects one, and mesh_field_series walks them.
test("mesh_info and mesh_field_series see OpenFOAM time directories", async () => {
  const dir = tmpDir();
  const marker = path.join(dir, "run.foam");
  const model = {
    nodeCount: 8,
    nodeIds: new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]),
    coords: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    blocks: [
      {
        kind: "Elements" as const,
        name: "hex",
        vtkCellType: 12,
        count: 1,
        stride: 8,
        entityIds: new Int32Array([1]),
        connectivity: new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
  };
  const { data, companions } = await writeMeshioBytes(model as never, ".foam", { stem: "run" });
  fs.writeFileSync(marker, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  const hdr = (cls: string, obj: string) =>
    `FoamFile\n{\n    version 2.0;\n    format ascii;\n    class ${cls};\n    object ${obj};\n}\n`;
  fs.mkdirSync(path.join(dir, "0"));
  fs.writeFileSync(path.join(dir, "0", "p"), hdr("volScalarField", "p") + "dimensions [0 2 -2 0 0 0 0];\ninternalField uniform 100;\n");
  fs.mkdirSync(path.join(dir, "1"));
  fs.writeFileSync(path.join(dir, "1", "p"), hdr("volScalarField", "p") + "dimensions [0 2 -2 0 0 0 0];\ninternalField uniform 200;\n");

  const info = (await meshInfo({ path: marker })) as {
    timeStep?: number;
    timeValues?: number[];
    fields: { variable: string }[];
  };
  assert.deepEqual(info.timeValues, [0, 1]);
  assert.equal(info.timeStep, 0);
  assert.ok(info.fields.some((f) => f.variable === "p"), "step 0 fields are reported");

  const series = (await meshFieldSeries({ path: marker, entityType: "Element", entityId: 1, variable: "p" })) as {
    source: string;
    values: unknown[];
  };
  assert.equal(series.source, "inFile");
  assert.deepEqual(series.values, [[100], [200]]);

  // A solver rewriting a field must not be served the cached frame.
  fs.writeFileSync(path.join(dir, "1", "p"), hdr("volScalarField", "p") + "dimensions [0 2 -2 0 0 0 0];\ninternalField uniform 300;\n");
  const series2 = (await meshFieldSeries({ path: marker, entityType: "Element", entityId: 1, variable: "p" })) as {
    values: unknown[];
  };
  assert.deepEqual(series2.values, [[100], [300]]);
});

test("an out-of-range timeStep surfaces meshio++'s real error, naming the count", async () => {
  const src = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  await assert.rejects(meshInfo({ path: src, timeStep: 99 }), /out of range|3 steps/i);
});

test("mesh_convert selects a time step of the input before writing", async () => {
  const src = path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo");
  const dir = tmpDir();
  const out0 = path.join(dir, "step0.vtu");
  const out2 = path.join(dir, "step2.vtu");
  await meshConvert({ path: src, outputPath: out0, timeStep: 0 });
  await meshConvert({ path: src, outputPath: out2, timeStep: 2 });
  const m0 = await parseMeshFile(out0);
  const m2 = await parseMeshFile(out2);
  const temp = (m: typeof m0) => m.fields.find((f) => f.variable === "temperature")!.values;
  assert.notDeepEqual(Array.from(temp(m0)), Array.from(temp(m2)));
});

// --- spheres / particles (issue #63) -------------------------------------

const DCB = path.resolve(__dirname, "../../src/test/fixtures/exodus/DCBmodel_PD_solid.e");

test("mesh_info reports the parsed Properties of an mdpa", async () => {
  const dir = tmpDir();
  const f = path.join(dir, "props.mdpa");
  fs.writeFileSync(
    f,
    [
      "Begin Properties 0",
      "End Properties",
      "Begin Properties 1",
      "    DENSITY 2700.0",
      "    CROSS_AREA 0.01",
      "    COMPUTE_LUMPED_MASS_MATRIX False",
      "    VOLUME_ACCELERATION [3] (0,0,-9.8)",
      "    CONSTITUTIVE_LAW LinearElastic3DLaw",
      "    Begin Table TEMPERATURE VISCOSITY",
      "        200. 2e-6",
      "    End Table",
      "End Properties",
      "Begin Nodes",
      "1 0 0 0",
      "2 1 0 0",
      "End Nodes",
      "Begin Elements Element3D2N",
      "1 1 1 2",
      "End Elements",
    ].join("\n")
  );
  const info = (await meshInfo({ path: f })) as {
    properties?: { id: number; values: Record<string, unknown>; tables?: unknown[] }[];
  };
  assert.ok(info.properties, "an mdpa with Properties must report them");
  assert.deepEqual(info.properties.map((p) => p.id), [0, 1]);
  const one = info.properties[1];
  // Values arrive unwrapped: the JSON type carries the kind.
  assert.equal(one.values.DENSITY, 2700);
  assert.equal(one.values.CROSS_AREA, 0.01);
  assert.equal(one.values.COMPUTE_LUMPED_MASS_MATRIX, false);
  assert.deepEqual(one.values.VOLUME_ACCELERATION, [0, 0, -9.8]);
  assert.equal(one.values.CONSTITUTIVE_LAW, "LinearElastic3DLaw");
  assert.deepEqual(one.tables, [{ columns: ["TEMPERATURE", "VISCOSITY"], rows: 1 }]);
});

test("mesh_info reports the parsed Constraints of an mdpa", async () => {
  const dir = tmpDir();
  const f = path.join(dir, "mpc.mdpa");
  fs.writeFileSync(
    f,
    [
      "Begin Nodes",
      "1 0 0 0",
      "2 1 0 0",
      "3 0 1 0",
      "End Nodes",
      "Begin Elements Element2D3N",
      "1 0 1 2 3",
      "End Elements",
      "Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X",
      "1 0.0 [0.5] 1 2",
      "2 0.0 [0.25, 0.25] 1 2 3",
      "End Constraints",
      "Begin SubModelPart Tied",
      "  Begin SubModelPartConstraints",
      "  1",
      "  7",
      "  End SubModelPartConstraints",
      "End SubModelPart",
    ].join("\n")
  );
  const info = (await meshInfo({ path: f })) as {
    constraints?: {
      blocks: { name: string; variables: string[]; count: number; idRange?: number[] }[];
      total: number;
      verbatimRows: number;
      undefinedIds: number[];
    };
    subModelParts: { counts: Record<string, number> }[];
  };
  assert.ok(info.constraints, "an mdpa with Constraints must report them");
  assert.equal(info.constraints.total, 2);
  assert.equal(info.constraints.verbatimRows, 0);
  assert.deepEqual(info.constraints.blocks[0].variables, ["DISPLACEMENT_X"]);
  assert.deepEqual(info.constraints.blocks[0].idRange, [1, 2]);
  // The id the part lists but no block defines — a file Kratos cannot read
  // back, and invisible from the counts alone.
  assert.deepEqual(info.constraints.undefinedIds, [7]);
  assert.equal(info.subModelParts[0].counts.constraints, 2);
  // No typed arrays leaked into the section.
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
});

test("mesh_info omits the constraints section for a format that has none", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "src.mdpa");
  const f = path.join(dir, "m.vtu");
  fs.writeFileSync(src, MDPA_3D);
  await meshConvert({ path: src, outputPath: f });
  const info = (await meshInfo({ path: f })) as { constraints?: unknown };
  assert.equal(info.constraints, undefined);
});

test("mesh_info omits the properties section for a format that has none", async () => {
  // Every non-mdpa parser leaves the slot undefined, so those reports are
  // byte-identical to what they were before Properties were parsed.
  const dir = tmpDir();
  const src = path.join(dir, "src.mdpa");
  const f = path.join(dir, "m.vtu");
  fs.writeFileSync(src, MDPA_3D);
  await meshConvert({ path: src, outputPath: f });
  const info = (await meshInfo({ path: f })) as { properties?: unknown };
  assert.equal(info.properties, undefined);
});

test("mesh_info reports a beams section, and separates skins from members", async () => {
  const frame = path.resolve(__dirname, "../../src/test/fixtures/mdpa/beam_frame.mdpa");
  const info = (await meshInfo({ path: frame })) as {
    beams?: {
      blocks: number;
      cells: number;
      sectioned: number;
      elementsSectioned: number;
      suggestedRadius: number;
    };
  };
  assert.ok(info.beams, "a frame of line elements must report them");
  assert.equal(info.beams.cells, 8);
  assert.equal(info.beams.sectioned, 7);
  // The gate the viewer uses: the LineCondition2D2N shares Properties 1 and so
  // resolves a section, but never counts towards turning the rendering on.
  assert.equal(info.beams.elementsSectioned, 6);
  assert.ok(info.beams.suggestedRadius > 0);

  // The negative case, on a real file: a 2D fluid mesh whose boundary is ~400
  // WallCondition2D2N has line cells and no sections whatsoever.
  const skin = (await meshInfo({
    path: path.resolve(__dirname, "../../example/MDPA/cylinder_Fluid.mdpa"),
  })) as { beams?: { cells: number; sectioned: number; elementsSectioned: number } };
  assert.ok(skin.beams!.cells > 0);
  assert.equal(skin.beams!.sectioned, 0);
  assert.equal(skin.beams!.elementsSectioned, 0);
});

test("mesh_info omits the beams section for a mesh with no line cells", async () => {
  const dir = tmpDir();
  const f = path.join(dir, "m.mdpa");
  fs.writeFileSync(f, MDPA_3D);
  const info = (await meshInfo({ path: f })) as { beams?: unknown };
  assert.equal(info.beams, undefined);
});

test("mesh_info reports a spheres section for a particle mesh", async () => {
  const info = (await meshInfo({ path: DCB })) as {
    spheres?: {
      blocks: number;
      cells: number;
      radiusField: boolean;
      radiusCoverage: number;
      suggestedRadius: number;
    };
  };
  assert.ok(info.spheres, "a SPHERE mesh must report its particles");
  assert.equal(info.spheres.cells, 504);
  assert.equal(info.spheres.blocks, 1); // the four Exodus blocks merge on read
  // The whole reason setElementRadius may CREATE the field: this real file has
  // no radius, so an agent needs to know to author one.
  assert.equal(info.spheres.radiusField, false);
  assert.equal(info.spheres.radiusCoverage, 0);
  assert.ok(info.spheres.suggestedRadius > 0);
});

test("mesh_info omits the spheres section for an ordinary mesh", async () => {
  const dir = tmpDir();
  const info = (await meshInfo({ path: writeFixture(dir) })) as { spheres?: unknown };
  assert.equal(info.spheres, undefined);
});

test("mesh_info reports isolated nodes referenced by no cell", async () => {
  const dir = tmpDir();
  const f = path.join(dir, "stray.mdpa");
  fs.writeFileSync(
    f,
    [
      "Begin Nodes",
      "1 0 0 0",
      "2 1 0 0",
      "3 5 5 0",
      "End Nodes",
      "Begin Elements Element2D2N",
      "1 1 1 2",
      "End Elements",
      "Begin SubModelPart LoneNodes",
      "  Begin SubModelPartNodes",
      "  3",
      "  End SubModelPartNodes",
      "End SubModelPart",
    ].join("\n")
  );
  const info = (await meshInfo({ path: f })) as {
    isolatedNodes?: { count: number; ids: number[] };
  };
  assert.ok(info.isolatedNodes, "a mesh with a stray node must report it");
  assert.equal(info.isolatedNodes.count, 1);
  assert.deepEqual(info.isolatedNodes.ids, [3]);
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
});

test("mesh_info omits the isolatedNodes section when every node is used", async () => {
  const dir = tmpDir();
  const info = (await meshInfo({ path: writeFixture(dir) })) as { isolatedNodes?: unknown };
  assert.equal(info.isolatedNodes, undefined);
});

test("mesh_transform can set a radius on a particle mesh", async () => {

  const dir = tmpDir();
  const out = path.join(dir, "particles.vtu");
  const result = (await meshTransform({
    path: DCB,
    outputPath: out,
    ops: [{ op: "setElementRadius", value: 0.136, mode: "absolute" }],
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };
  assert.deepEqual(result.outcomes.map((o) => o.op), ["setElementRadius"]);
  assert.equal(result.outcomes[0].noop, false);
  assert.match(result.outcomes[0].message ?? "", /504 element\(s\).*field created/);

  const back = await parseMeshFile(out);
  const f = back.fields.find((x) => x.variable === "RADIUS");
  assert.ok(f, `expected RADIUS, got ${back.fields.map((x) => x.variable)}`);
  assert.equal(f.ids.length, 504);
  assert.equal(f.values[0], 0.136);
});

test("mesh_convert writes Exodus, and a radius survives it", async () => {
  const dir = tmpDir();
  const withRadius = path.join(dir, "r.vtu");
  await meshTransform({
    path: DCB,
    outputPath: withRadius,
    ops: [{ op: "setElementRadius", value: 0.25, mode: "absolute" }],
  });
  const exo = path.join(dir, "r.exo");
  await meshConvert({ path: withRadius, outputPath: exo });
  const back = await parseMeshFile(exo);
  const f = back.fields.find((x) => x.variable === "RADIUS");
  assert.ok(f, "the exodus:attr: prefix must be restored on write and stripped on read");
  assert.equal(f.values[0], 0.25);
});

// --- mesh_select and the property/selection ops ------------------------------

const SEL_MDPA = `Begin Properties 7
 DENSITY 2700.0
End Properties

Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 1.0 1.0 0.0
4 0.0 1.0 0.0
End Nodes

Begin NodalData TEMP
1 0 100
2 0 190
3 0 200
4 0 40
End NodalData

Begin Elements Element2D3N
1 7 1 2 3
2 7 3 4 1
End Elements
`;

function writeSelFixture(dir: string, name = "sel.mdpa"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, SEL_MDPA);
  return p;
}

test("mesh_select resolves field/part/property seeds per kind", async () => {
  const dir = tmpDir();
  const p = writeSelFixture(dir);
  // Nodal field, all-rule: element 1 (100,190,200) passes [90,210]; element 2 has 40 -> fails
  const field = (await meshSelect({ path: p, seed: { kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 90, hi: 210 } })) as {
    counts: { elements: number };
    elementIds: number[];
    conditionIds: number[];
  };
  assert.deepEqual(field.counts, { elements: 1, conditions: 0, geometries: 0, total: 1 });
  assert.deepEqual(field.elementIds, [1]);
  const part = (await meshSelect({
    path: p,
    seed: { kind: "property", propertyId: 7 },
  })) as { elementIds: number[] };
  assert.deepEqual(part.elementIds.sort(), [1, 2]);
  // a seed that names nothing fails by name
  await assert.rejects(
    () => meshSelect({ path: p, seed: { kind: "field", variable: "NOPE", blockKind: "Nodal", lo: 0, hi: 1 } }),
    /no Nodal field named "NOPE"/
  );
  // outputPath writes the uncapped ids
  const outPath = path.join(dir, "sel.json");
  const withOut = (await meshSelect({ path: p, seed: { kind: "property", propertyId: 7 }, outputPath: outPath })) as { outputPath: string };
  assert.equal(withOut.outputPath, outPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(outPath, "utf8")).elementIds, [1, 2]);
});

test("mesh_transform edits Properties in place: set, clone, assign, delete", async () => {
  const dir = tmpDir();
  const src = writeSelFixture(dir);
  const out = path.join(dir, "sel_edited.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [
      { op: "createProperty", name: "CROSS_AREA", value: { kind: "number", value: 1e-4 } },
      { op: "cloneProperty", propertyId: 7 }, // -> id 9 (createProperty took 8)
      { op: "assignProperty", propertyId: 9, kind: "Elements", ids: [1] },
      { op: "setProperty", propertyId: 9, name: "DENSITY", value: 3050 },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean }[] };
  assert.ok(result.outcomes.every((o) => !o.noop));
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.ok(model.properties);
  const clone = model.properties!.find((s) => s.id === 9); // clone took the next free id
  assert.ok(clone, "clone created a second set");
  assert.equal((clone!.variables.DENSITY as { value: number }).value, 3050);
  assert.ok(model.properties!.find((s) => s.id === 8)!.variables.CROSS_AREA);
  const elements = model.blocks.find((b) => b.kind === "Elements")!;
  assert.equal(elements.propertyIds?.[0], 9);
  assert.equal(elements.propertyIds?.[1], 7);
  // delete is refused while element 2 still references 7 — has to be an outcome noop
  const refused = (await meshTransform({
    path: out,
    ops: [{ op: "deleteProperty", propertyId: 7 }],
    outputPath: out,
  })) as { outcomes: { noop: boolean; message?: string }[] };
  assert.equal(refused.outcomes[0].noop, true);
  assert.match(refused.outcomes[0].message ?? "", /still assigned/);
});

test("mesh_transform chains a select seed into createSubModelPartFromSelection", async () => {
  const dir = tmpDir();
  const src = writeSelFixture(dir);
  const out = path.join(dir, "sel_part.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "createSubModelPartFromSelection", parentPath: "", name: "Hot", seed: { kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 90, hi: 210, rule: "all" } }],
    outputPath: out,
  })) as { outcomes: { noop: boolean; message?: string }[] };
  assert.ok(!result.outcomes[0].noop);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const hot = model.subModelParts.find((s) => s.name === "Hot");
  assert.ok(hot);
  assert.deepEqual(Array.from(hot.elementIds), [1]);
  assert.deepEqual(Array.from(hot.nodeIds), [1, 2, 3]);
  // parent propagation: Domain-like root parts gain the ids too via the tree
});

test("mesh_transform deletes selected entities and keeps the other id spaces", async () => {
  const dir = tmpDir();
  const src = writeSelFixture(dir);
  const out = path.join(dir, "sel_deleted.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "deleteEntities", elements: [2] }],
    outputPath: out,
  })) as { outcomes: { op: string; noop: boolean; message?: string }[] };
  assert.ok(!result.outcomes[0].noop);
  assert.match(result.outcomes[0].message ?? "", /1\/1 elements/);
  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  assert.deepEqual(
    model.blocks.find((b) => b.kind === "Elements")!.entityIds,
    new Int32Array([1]),
    "element 2 is gone; element 1 keeps its id"
  );
  // nothing else was in the fixture; an EMPTY delete is refused at the record
  // level (opRecordFromMessage), which mesh_transform surfaces as a named error
  await assert.rejects(
    () => meshTransform({ path: out, ops: [{ op: "deleteEntities" }], outputPath: out }),
    /deleteEntities/
  );
});
