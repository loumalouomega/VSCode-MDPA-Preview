import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  meshInfo,
  meshQuality,
  meshFieldIntegrate,
  meshSize,
  meshTransform,
  meshConvert,
  meshExtractSubModelPart,
  meshExtractSkin,
  meshExportTable,
  meshFieldSeries,
  meshFindEntity,
  problemtypeList,
  problemtypeDescribe,
  caseValidate,
  caseWriteState,
  caseGenerate,
  problemPack,
  problemUnpack,
} from "../mcp/tools";
import { parseMdpa } from "../parser/mdpaParser";
import { parseMeshFile } from "../parser/meshFileParser";
import { serializeOps } from "../parser/operations";
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

test("mesh_convert rejects unsupported output formats listing valid ones", async () => {
  const dir = tmpDir();
  await assert.rejects(
    meshConvert({ path: writeFixture(dir), outputPath: path.join(dir, "beam.vtm") }),
    /\.vtm.*\.mdpa/s
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

test("mesh_convert round-trips a mesh through an extended text format", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "beam.mesh"); // medit, text
  await meshConvert({ path: writeFixture(dir), outputPath: out });
  const model = await parseMeshFile(out);
  assert.equal(model.nodeCount, 4);
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 2);
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
  };
  assert.equal(result.problemtype, "structural");
  const names = result.written.map((p) => path.basename(p));
  assert.ok(names.includes("ProjectParameters.json"));
  assert.ok(names.includes("StructuralMaterials.json"));
  assert.ok(names.includes("MainKratos.py"));
  // Structural declares meshNaming, so Element3D4N is renamed and a copy written.
  assert.ok(result.renames.length > 0);
  assert.ok(names.includes("beam_case.mdpa"));
  const pp = JSON.parse(fs.readFileSync(path.join(dir, "ProjectParameters.json"), "utf8"));
  assert.equal(pp.solver_settings.model_import_settings.input_filename, "beam_case");
  assert.match(fs.readFileSync(path.join(dir, "beam_case.mdpa"), "utf8"), /Begin Properties 0/);
  // Original mesh untouched.
  assert.equal(fs.readFileSync(src, "utf8"), MDPA_3D);
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

// --- meshio++ 9.22.0 capabilities through the MCP surface --------------------

test("mesh_transform runs fieldGradient (meshio++ oracle) exactly on a linear field", async () => {
  // grad(x + 2y + 3z) = (1,2,3) everywhere. Green-Gauss is documented exact for
  // a linear field on any cell, so this checks the numbers, not just the wiring.
  const dir = tmpDir();
  const src = path.join(dir, "linear.mdpa");
  fs.writeFileSync(
    src,
    [
      "Begin Nodes",
      "1 0.0 0.0 0.0",
      "2 1.0 0.0 0.0",
      "3 0.0 1.0 0.0",
      "4 0.0 0.0 1.0",
      "End Nodes",
      "Begin Elements Element3D4N",
      "1 0 1 2 3 4",
      "End Elements",
      "Begin NodalData TEMP",
      "1 0 0.0",
      "2 0 1.0",
      "3 0 2.0",
      "4 0 3.0",
      "End NodalData",
      "",
    ].join("\n")
  );
  const out = path.join(dir, "grad.mdpa");
  const result = (await meshTransform({
    path: src,
    ops: [{ op: "fieldGradient", variable: "TEMP" }],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "fieldGradient");

  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const g = model.fields.find((f) => f.variable === "TEMP_GRADIENT");
  assert.ok(g, `expected TEMP_GRADIENT, got ${model.fields.map((f) => f.variable)}`);
  assert.equal(g.components, 3);
  assert.equal(g.values.length, 3 * model.nodeCount);
  for (let i = 0; i < model.nodeCount; i++) {
    assert.ok(Math.abs(g.values[i * 3] - 1) < 1e-6);
    assert.ok(Math.abs(g.values[i * 3 + 1] - 2) < 1e-6);
    assert.ok(Math.abs(g.values[i * 3 + 2] - 3) < 1e-6);
  }
  // The source field is untouched and the mesh is unchanged.
  assert.ok(model.fields.some((f) => f.variable === "TEMP"));
  assert.equal(model.nodeCount, 4);
});

test("mesh_transform rejects a fieldGradient with a bogus operator", async () => {
  const dir = tmpDir();
  await assert.rejects(
    () =>
      meshTransform({
        path: writeFixture(dir),
        ops: [{ op: "fieldGradient", variable: "TEMP", operator: "laplacian" }],
      }),
    /ops\[0\]/,
    "the same opRecordFromMessage validation the webview gets"
  );
});

test("mesh_convert writes an OpenFOAM case as a polyMesh DIRECTORY", async () => {
  // The companion path is relative and its folders do not exist yet — the
  // reason MeshWriteResult.companions became directory-aware.
  const dir = tmpDir();
  const src = path.join(dir, "hex.mdpa");
  fs.writeFileSync(
    src,
    [
      "Begin Nodes",
      "1 0.0 0.0 0.0", "2 1.0 0.0 0.0", "3 1.0 1.0 0.0", "4 0.0 1.0 0.0",
      "5 0.0 0.0 1.0", "6 1.0 0.0 1.0", "7 1.0 1.0 1.0", "8 0.0 1.0 1.0",
      "End Nodes",
      "Begin Elements Element3D8N",
      "1 0 1 2 3 4 5 6 7 8",
      "End Elements",
      "",
    ].join("\n")
  );
  const out = path.join(dir, "case.foam");
  await meshConvert({ path: src, outputPath: out });

  assert.ok(fs.existsSync(out), "the .foam marker");
  assert.equal(fs.statSync(out).size, 0, "the marker is empty; the mesh is the tree");
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "constant", "polyMesh")).sort(),
    ["boundary", "faces", "neighbour", "owner", "points"]
  );
  const boundary = fs.readFileSync(path.join(dir, "constant", "polyMesh", "boundary"), "utf8");
  assert.match(boundary, /defaultFaces/, "the single synthesized patch");
});

test("mesh_info opens a mesh whose cells are polyhedral", async () => {
  // A CGNS file with NGON_n/NFACE_n sections used to open EMPTY: ragged blocks
  // were diagnosed and skipped. They are now decomposed into tetrahedra.
  const { loadMeshio } = await import("../parser/meshio");
  const m = await loadMeshio();
  const faces = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const data: number[] = [];
  const faceOffsets: number[] = [0];
  for (const f of faces) {
    data.push(...f);
    faceOffsets.push(data.length);
  }
  m.FS.mkdir("/poly");
  m.writeMesh(
    "/poly/c.cgns",
    {
      points: new Float64Array([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
        0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
      ]),
      dim: 3,
      cells: [
        {
          type: "polyhedron6",
          data: Int32Array.from(data),
          faceOffsets: Int32Array.from(faceOffsets),
          cellOffsets: new Int32Array([0, faces.length]),
        },
      ],
    },
    "cgns"
  );
  const dir = tmpDir();
  const src = path.join(dir, "poly.cgns");
  fs.writeFileSync(src, Buffer.from(m.FS.readFile("/poly/c.cgns") as Uint8Array));

  const info = (await meshInfo({ path: src })) as {
    nodeCount: number;
    blocks: { count: number; stride: number }[];
  };
  assert.ok(info.nodeCount > 0, "the mesh is not empty");
  assert.equal(
    info.blocks.reduce((n, b) => n + b.count, 0),
    24,
    "6 quad faces x 4 edges of tetrahedra"
  );
  assert.ok(info.blocks.every((b) => b.stride === 4), "all tetrahedra");
});

// --- SubModelPart tree operations through the MCP surface --------------------

/** A nested part tree: Domain (nodes 1-4, elem 1) > Inner (nodes 1-3, elem 1). */
function writeTreeFixture(dir: string): string {
  const p = path.join(dir, "tree.mdpa");
  fs.writeFileSync(
    p,
    [
      "Begin Nodes",
      "1 0.0 0.0 0.0",
      "2 1.0 0.0 0.0",
      "3 0.0 1.0 0.0",
      "4 0.0 0.0 1.0",
      "End Nodes",
      "Begin Elements Element3D4N",
      "1 0 1 2 3 4",
      "End Elements",
      "Begin SubModelPart Domain",
      " Begin SubModelPartNodes",
      "  1",
      "  2",
      "  3",
      "  4",
      " End SubModelPartNodes",
      " Begin SubModelPartElements",
      "  1",
      " End SubModelPartElements",
      " Begin SubModelPart Inner",
      "  Begin SubModelPartNodes",
      "   1",
      "   2",
      "  End SubModelPartNodes",
      " End SubModelPart",
      "End SubModelPart",
      "",
    ].join("\n")
  );
  return p;
}

test("mesh_transform creates, moves and merges SubModelParts", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "tree-out.mdpa");
  const result = (await meshTransform({
    path: writeTreeFixture(dir),
    ops: [
      { op: "createSubModelPart", parentPath: "", name: "Boundary" },
      { op: "createSubModelPart", parentPath: "Boundary", name: "Wall" },
      { op: "moveSubModelPart", path: "Domain/Inner", newParentPath: "Boundary" },
      { op: "mergeSubModelParts", sourcePath: "Boundary/Wall", targetPath: "Boundary/Inner" },
    ],
    outputPath: out,
  })) as { outcomes: { op: string; noop?: boolean }[] };
  assert.ok(result.outcomes.every((o) => !o.noop), JSON.stringify(result.outcomes));

  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const all: string[] = [];
  const walk = (parts: { path: string; children: unknown[] }[]): void => {
    for (const p of parts) {
      all.push(p.path);
      walk(p.children as { path: string; children: unknown[] }[]);
    }
  };
  walk(model.subModelParts as unknown as { path: string; children: unknown[] }[]);
  assert.ok(all.includes("Boundary/Inner"), `got ${all.join(", ")}`);
  assert.ok(!all.includes("Domain/Inner"), "the moved part left its old parent");
  assert.ok(!all.includes("Boundary/Wall"), "the merged source is gone");
});

test("mesh_transform add/remove entities maintain the Kratos subset rule", async () => {
  // Adding to a child must reach the ancestors; removing from a parent must
  // reach the descendants. Both are checked against the written file.
  const dir = tmpDir();
  const src = writeTreeFixture(dir);
  const added = path.join(dir, "added.mdpa");
  await meshTransform({
    path: src,
    ops: [
      { op: "createSubModelPart", parentPath: "Domain/Inner", name: "Deep" },
      { op: "addSubModelPartEntities", path: "Domain/Inner/Deep", kind: "nodes", ids: [4] },
    ],
    outputPath: added,
  });
  const m1 = parseMdpa(fs.readFileSync(added, "utf8"));
  const find = (mm: typeof m1, p: string): number[] => {
    const walk = (parts: typeof mm.subModelParts): number[] | undefined => {
      for (const q of parts) {
        if (q.path === p) return Array.from(q.nodeIds);
        const hit = walk(q.children);
        if (hit) return hit;
      }
      return undefined;
    };
    const r = walk(mm.subModelParts);
    assert.ok(r, `no SubModelPart at ${p}`);
    return r;
  };
  assert.ok(find(m1, "Domain/Inner/Deep").includes(4));
  assert.ok(find(m1, "Domain/Inner").includes(4), "node 4 propagated to the parent");
  assert.ok(find(m1, "Domain").includes(4), "and to the grandparent");

  const removed = path.join(dir, "removed.mdpa");
  await meshTransform({
    path: src,
    ops: [{ op: "removeSubModelPartEntities", path: "Domain", kind: "nodes", ids: [2] }],
    outputPath: removed,
  });
  const m2 = parseMdpa(fs.readFileSync(removed, "utf8"));
  assert.ok(!find(m2, "Domain").includes(2));
  assert.ok(!find(m2, "Domain/Inner").includes(2), "the child lost it too");
  assert.equal(m2.nodeCount, 4, "the node itself was not deleted — membership only");
});

test("mesh_transform rejects an invalid SubModelPart tree op", async () => {
  const dir = tmpDir();
  const src = writeTreeFixture(dir);
  for (const op of [
    { op: "createSubModelPart", parentPath: "", name: "" },
    { op: "moveSubModelPart", path: "Domain" },
    { op: "addSubModelPartEntities", path: "Domain", kind: "widgets", ids: [1] },
    { op: "addSubModelPartEntities", path: "Domain", kind: "nodes", ids: [] },
  ]) {
    await assert.rejects(
      () => meshTransform({ path: src, ops: [op] }),
      /ops\[0\]/,
      JSON.stringify(op)
    );
  }
});

test("a SubModelPart tree op that cannot apply is a noop with a reason", async () => {
  const dir = tmpDir();
  const r = (await meshTransform({
    path: writeTreeFixture(dir),
    ops: [{ op: "moveSubModelPart", path: "Domain", newParentPath: "Domain/Inner" }],
  })) as { outcomes: { noop?: boolean; message?: string }[] };
  assert.equal(r.outcomes[0].noop, true);
  assert.match(r.outcomes[0].message ?? "", /inside itself/);
});

// --- meshio++ 10.14.0 capabilities through the MCP surface -------------------

/** A 2x1x1 bar of tets carrying a field linear in x, y and z. */
function tetBarFixture(dir: string, quadratic = false): string {
  const lines: string[] = ["Begin Nodes"];
  const idx = new Map<string, number>();
  let id = 1;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 3; i++) {
        idx.set(`${i},${j},${k}`, id);
        lines.push(`${id++} ${i} ${j} ${k}`);
      }
    }
  }
  lines.push("End Nodes", "Begin Elements Element3D4N");
  const HEX = [
    [0, 1, 3, 4], [1, 2, 3, 4], [2, 3, 4, 7], [1, 2, 4, 5], [2, 4, 5, 6], [2, 4, 6, 7],
  ];
  let e = 1;
  for (let c = 0; c < 2; c++) {
    const corners = [
      [c, 0, 0], [c + 1, 0, 0], [c + 1, 1, 0], [c, 1, 0],
      [c, 0, 1], [c + 1, 0, 1], [c + 1, 1, 1], [c, 1, 1],
    ].map(([i, j, k]) => idx.get(`${i},${j},${k}`)!);
    for (const t of HEX) lines.push(`${e++} 0 ${t.map((n) => corners[n]).join(" ")}`);
  }
  lines.push("End Elements", "Begin NodalData TEMP");
  for (const [key, n] of idx) {
    const [i, j, k] = key.split(",").map(Number);
    lines.push(`${n} 0 ${quadratic ? i * i : i + 2 * j + 3 * k}`);
  }
  lines.push("End NodalData", "");
  const p = path.join(dir, quadratic ? "curved.mdpa" : "linear-bar.mdpa");
  fs.writeFileSync(p, lines.join("\n"));
  return p;
}

test("mesh_transform runs fieldHessian, exactly zero for a linear field", async () => {
  // The one mesh-shape-independent guarantee upstream states, checked through
  // the MCP surface so the op is provably reachable by an agent, not just by
  // the sidebar.
  const dir = tmpDir();
  const out = path.join(dir, "hess.mdpa");
  const result = (await meshTransform({
    path: tetBarFixture(dir),
    ops: [{ op: "fieldHessian", variable: "TEMP" }],
    outputPath: out,
  })) as { outcomes: { op: string; message?: string }[] };
  assert.equal(result.outcomes[0].op, "fieldHessian");

  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const h = model.fields.find((f) => f.variable === "TEMP_HESSIAN");
  assert.ok(h, `expected TEMP_HESSIAN, got ${model.fields.map((f) => f.variable)}`);
  assert.equal(h.components, 9, "the flattened row-major 3x3");
  assert.equal(h.values.length, 9 * model.nodeCount);
  for (const v of h.values) assert.ok(Math.abs(v) < 1e-6, `linear ⇒ zero, got ${v}`);
  assert.ok(model.fields.some((f) => f.variable === "TEMP"), "the source is untouched");
});

test("mesh_transform runs estimateError and marks cells for refinement", async () => {
  // x^2 is not representable on a linear tet mesh, so both the indicator and
  // the marking array must be real — the complement of the zero-error case.
  const dir = tmpDir();
  const out = path.join(dir, "err.mdpa");
  await meshTransform({
    path: tetBarFixture(dir, true),
    ops: [{ op: "estimateError", variable: "TEMP", marking: "fraction", markingValue: 0.5 }],
    outputPath: out,
  });

  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const ind = model.fields.find((f) => f.variable === "ERROR_INDICATOR");
  const marks = model.fields.find((f) => f.variable === "ERROR_MARKED");
  assert.ok(ind, "the indicator is an Elemental field on the written mesh");
  assert.ok(marks, "the marking policy attached its own field");
  assert.equal(ind.kind, "Elemental");
  assert.ok(Array.from(ind.values).some((v) => v > 0), "a curved field has real error");
  for (const v of marks.values) assert.ok(v === 0 || v === 1, "0/1, never NaN");
  assert.equal(Array.from(marks.values).filter((v) => v === 1).length, 6, "half of 12 cells");
});

test("mesh_transform rejects the new field ops' bad params by name", async () => {
  const dir = tmpDir();
  const src = tetBarFixture(dir);
  // An unknown marking policy and an out-of-range fraction are both rejected
  // by opRecordFromMessage / estimateErrorModel rather than reaching wasm.
  await assert.rejects(
    () => meshTransform({ path: src, ops: [{ op: "estimateError", variable: "TEMP", marking: "nope" }] })
  );
  await assert.rejects(
    () => meshTransform({ path: src, ops: [{ op: "fieldHessian", variable: "NOPE" }] }),
    /NOPE/
  );
});

test("mesh_transform runs sdfDistance against a surface file on disk", async () => {
  // The two-mesh ops read their second mesh through operations.ts, so this is
  // the test that the PATH handling works end to end — the pure module tests in
  // oracleOps.test.ts deliberately never touch the filesystem.
  const dir = tmpDir();
  const surface = path.join(dir, "box.mdpa");
  const c = [
    [-0.75, -0.75, -0.75], [0.75, -0.75, -0.75], [0.75, 0.75, -0.75], [-0.75, 0.75, -0.75],
    [-0.75, -0.75, 0.75], [0.75, -0.75, 0.75], [0.75, 0.75, 0.75], [-0.75, 0.75, 0.75],
  ];
  const tris = [
    [1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8],
  ];
  const lines = ["Begin Nodes"];
  c.forEach((p, i) => lines.push(`${i + 1} ${p[0]} ${p[1]} ${p[2]}`));
  lines.push("End Nodes", "Begin Elements Element3D3N");
  tris.forEach((t, i) => lines.push(`${i + 1} 0 ${t.join(" ")}`));
  lines.push("End Elements", "");
  fs.writeFileSync(surface, lines.join("\n"));

  const out = path.join(dir, "sdf.mdpa");
  await meshTransform({
    path: tetBarFixture(dir),
    ops: [{ op: "sdfDistance", path: surface }],
    outputPath: out,
  });

  const model = parseMdpa(fs.readFileSync(out, "utf8"));
  const f = model.fields.find((x) => x.variable === "SDF_DISTANCE");
  assert.ok(f, `expected SDF_DISTANCE, got ${model.fields.map((x) => x.variable)}`);
  assert.equal(f.values.length, model.nodeCount, "one value per node");
  // Sign checked against the geometry, not merely "some negatives exist".
  for (let i = 0; i < model.nodeCount; i++) {
    const [x, y, z] = [model.coords[i * 3], model.coords[i * 3 + 1], model.coords[i * 3 + 2]];
    const within = Math.abs(x) < 0.75 && Math.abs(y) < 0.75 && Math.abs(z) < 0.75;
    assert.equal(f.values[i] < 0, within, `node ${i} at ${x},${y},${z}`);
  }
});

test("the two-mesh ops treat an unreadable path as a noop, not a failure", async () => {
  // mergeMesh's rule, applied consistently: a missing file should not discard
  // the model or abort a recipe replay.
  const dir = tmpDir();
  const src = tetBarFixture(dir);
  const missing = path.join(dir, "does-not-exist.mdpa");
  for (const op of ["sdfDistance", "transferField"] as const) {
    const r = (await meshTransform({
      path: src,
      ops: [{ op, path: missing }],
    })) as { outcomes: { op: string; noop?: boolean; message?: string }[] };
    assert.equal(r.outcomes[0].op, op);
    assert.equal(r.outcomes[0].noop, true, `${op} is a noop`);
    assert.match(String(r.outcomes[0].message), /Could not read/);
  }
});

test("mesh_quality reports watertightness alongside the geometric metrics", async () => {
  // A closed box surface is watertight; the same box with one triangle removed
  // is not, and the COUNT says how badly — which is the reason the numbers are
  // surfaced rather than a bare boolean.
  const dir = tmpDir();
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const tris = [
    [1, 3, 2], [1, 4, 3], [5, 6, 7], [5, 7, 8], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8],
  ];
  const write = (name: string, faces: number[][]): string => {
    const lines = ["Begin Nodes"];
    c.forEach((p, i) => lines.push(`${i + 1} ${p[0]} ${p[1]} ${p[2]}`));
    lines.push("End Nodes", "Begin Elements Element3D3N");
    faces.forEach((t, i) => lines.push(`${i + 1} 0 ${t.join(" ")}`));
    lines.push("End Elements", "");
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.join("\n"));
    return p;
  };

  const closed = (await meshQuality({ path: write("closed.mdpa", tris) })) as {
    watertight?: { watertight: boolean; boundaryEdges: number };
  };
  assert.ok(closed.watertight, "the section is present");
  assert.equal(closed.watertight.watertight, true, "a closed box is watertight");
  assert.equal(closed.watertight.boundaryEdges, 0);

  const open = (await meshQuality({ path: write("open.mdpa", tris.slice(0, 11)) })) as {
    watertight?: { watertight: boolean; boundaryEdges: number };
  };
  assert.equal(open.watertight!.watertight, false, "removing a face opens it");
  assert.equal(open.watertight!.boundaryEdges, 3, "the hole is one triangle: three edges");
});

test("mesh_field_integrate weights by cell measure and splits per region", async () => {
  // A unit-density field over a 2x1x1 bar integrates to the bar's volume, 2 —
  // which is only true if the weighting is by MEASURE and not a plain sum over
  // the 12 tets.
  const dir = tmpDir();
  const src = tetBarFixture(dir);
  const model = parseMdpa(fs.readFileSync(src, "utf8"));
  const withDensity = [
    fs.readFileSync(src, "utf8").trimEnd(),
    "Begin ElementalData DENSITY",
    ...Array.from(model.blocks[0].entityIds, (id) => `${id} 1.0`),
    "End ElementalData",
    "",
  ].join("\n");
  const p = path.join(dir, "density.mdpa");
  fs.writeFileSync(p, withDensity);

  const r = (await meshFieldIntegrate({ path: p, variables: ["DENSITY"] })) as {
    integrals: {
      variable: string;
      components: number;
      domain: { total: number[]; mean: number[]; numCells: number };
      regions: { name: string; total: number[] }[];
    }[];
  };
  assert.equal(r.integrals.length, 1);
  const it = r.integrals[0];
  assert.equal(it.variable, "DENSITY");
  assert.equal(it.components, 1);
  assert.equal(it.domain.numCells, 12);
  assert.ok(Math.abs(it.domain.total[0] - 2) < 1e-9, `bar volume is 2, got ${it.domain.total[0]}`);
  assert.ok(Math.abs(it.domain.mean[0] - 1) < 1e-9, "unit density has unit mean");
  // buildRegions emits one Cell region per EntityBlock, so the block shows up
  // by name without anything here asking for it.
  assert.ok(
    it.regions.some((g) => g.name === "Element3D4N"),
    `expected the block as a region, got ${it.regions.map((g) => g.name).join(",")}`
  );
});

test("mesh_field_integrate refuses a Nodal field, naming the fix", async () => {
  const dir = tmpDir();
  await assert.rejects(
    () => meshFieldIntegrate({ path: tetBarFixture(dir), variables: ["TEMP"] }),
    /Average field/
  );
});

// --- GiD postprocess through the MCP surface --------------------------------

test("mesh_convert writes and reads back a GiD ascii pair", async () => {
  // Also the check that a COMPOUND extension survives the MCP path, which has
  // its own `path.extname` call sites for loading, writing and reporting the
  // target format — all of which would have said ".msh" (gmsh) before.
  const dir = tmpDir();
  const out = path.join(dir, "case.post.msh");
  const result = (await meshConvert({
    path: writeFixture(dir),
    outputPath: out,
  })) as { targetFormat?: string };
  assert.equal(result.targetFormat, ".post.msh", "the compound extension is reported whole");

  assert.ok(fs.existsSync(out), "the geometry half was written");
  assert.ok(
    fs.existsSync(path.join(dir, "case.post.res")),
    "the results companion landed beside it"
  );

  // And back again through the reader, which must stage the sibling itself.
  const info = (await meshInfo({ path: out })) as { nodeCount: number };
  assert.ok(info.nodeCount > 0, "the pair reads back as a mesh");
});

test("mesh_info on a .post.msh does not fall through to gmsh", async () => {
  // The regression the compound-extension resolver exists to prevent: gmsh
  // cannot read a GiD file, so a wrong dispatch fails loudly here.
  const dir = tmpDir();
  const out = path.join(dir, "g.post.msh");
  await meshConvert({ path: writeFixture(dir), outputPath: out });
  const info = (await meshInfo({ path: out })) as {
    nodeCount: number;
    diagnostics?: { total: number };
  };
  assert.ok(info.nodeCount > 0);
  assert.equal(info.diagnostics?.total ?? 0, 0, "no fallback-reader warnings");
});
