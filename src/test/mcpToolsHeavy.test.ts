/**
 * The wasm-heavy tail of the MCP tool suite, split out of `mcpTools.test.ts`.
 *
 * Same mitigation as `meshioOpenfoam.test.ts` (split out of `meshio.test.ts`
 * when PR #94's windows-latest leg died mid-file): `node --test` runs each
 * test FILE in its own child process, and every wasm-backed case loads a
 * fresh meshio++/MMG instance (`loadMeshio()` keeps no cache — see meshio.ts),
 * so a single process accumulates that many committed wasm heaps by the time
 * it reaches its last test. `mcpTools.test.ts` grew past every split's margin
 * once the field/derive/integrate/convert conversions were added; run
 * 35977526015's windows leg killed exactly that file a few subtests from its
 * end. These are the cases that instantiate wasm hardest — field ops,
 * `mesh_derive`, the format round trips — so they carry the split.
 *
 * The cheap helpers and MDPA_3D are copied, not imported: the head file keeps
 * its own copies, and this file must not pull the head in (importing the test
 * file would fire every test in it twice).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { icosphere } from "./fixtures/shapes";
import { writeMdpa } from "../parser/writers/mdpaWriter";

import {
  meshInfo,
  meshTransform,
  meshConvert,
  meshQuality,
  meshFieldIntegrate,
  caseEvaluateQuantity,
  meshDerive,
} from "../mcp/tools";
import { parseMdpa } from "../parser/mdpaParser";
import { parseMeshFile } from "../parser/meshFileParser";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-"));
}

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

function writeFixture(dir: string, name = "beam.mdpa"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, MDPA_3D);
  return p;
}

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
    ["boundary", "cellZones", "faces", "neighbour", "owner", "points"]
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

test("case_evaluate_quantity records a selected, region-scoped scalar with its result revision", async () => {
  const dir = tmpDir();
  const source = path.join(dir, "cantilever.vtk.mdpa");
  fs.writeFileSync(source, `${MDPA_3D.trimEnd()}
Begin NodalData DISPLACEMENT
1 0 [3] (0, 0, 0)
2 0 [3] (0, 0, 0)
3 0 [3] (0, 0, 0)
4 0 [3] (3, 4, 0)
End NodalData
`);
  const result = await caseEvaluateQuantity({
    path: source, runId: "run-1", field: "DISPLACEMENT", kind: "Nodal",
    component: "magnitude", region: "Loaded", reduction: "max", unit: "m",
  }) as {
    version: number; runId: string; source: { path: string; revision: string };
    evaluation: { field: string; kind: string; component: string; region: string; time: number; reduction: string; unit: string };
    quantity: { value: number | null; runId: string; unit: string };
  };
  assert.equal(result.version, 1);
  assert.equal(result.runId, "run-1");
  assert.equal(result.source.path, source);
  assert.match(result.source.revision, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.evaluation, {
    field: "DISPLACEMENT", kind: "Nodal", component: "magnitude", region: "Loaded", time: 0, reduction: "max", unit: "m",
  });
  assert.equal(result.quantity.value, 5);
  assert.equal(result.quantity.runId, "run-1");
  await assert.rejects(() => caseEvaluateQuantity({
    path: source, runId: "run-1", field: "DISPLACEMENT", kind: "Nodal",
    component: "x", region: "Missing", reduction: "max", unit: "m",
  }), /No SubModelPart/);
  await assert.rejects(() => caseEvaluateQuantity({
    path: source, runId: "run-1", field: "DISPLACEMENT", kind: "Nodal",
    component: "scalar", reduction: "max", unit: "m",
  }), /has 3 components/);
  const vtkResult = path.resolve(__dirname, "../../example/VTK/Main_0_6.vtk");
  const vtk = await caseEvaluateQuantity({
    path: vtkResult, runId: "cantilever-run", field: "DISPLACEMENT", kind: "Nodal",
    component: "magnitude", reduction: "max", unit: "mm", time: 0.6,
  }) as { quantity: { value: number | null; runId: string; unit: string; time: number } };
  assert.equal(vtk.quantity.runId, "cantilever-run");
  assert.equal(vtk.quantity.unit, "mm");
  assert.equal(vtk.quantity.time, 0.6);
  assert.ok(vtk.quantity.value !== null && Math.abs(vtk.quantity.value - Math.hypot(1.158, 1, 12)) < 1e-4,
    `expected the maximum vector magnitude of the VTK displacement field, got ${vtk.quantity.value}`);
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

test("mesh_derive builds a grid with no input mesh, samples a sphere's SDF to .vti, and refuses a partial lattice as .vti by name", async () => {
  const dir = tmpDir();
  const grid = (await meshDerive({ kind: "grid", dims: [4, 3, 2], spacing: [0.5, 0.5, 0.5], outputPath: path.join(dir, "grid.vti") })) as { summary: string; nodeCount: number };
  assert.match(grid.summary, /4 × 3 × 2 = 24 cells/);
  const gridBack = await parseMeshFile(path.join(dir, "grid.vti"));
  assert.equal(gridBack.nodeCount, 5 * 4 * 3);
  await assert.rejects(meshDerive({ kind: "voxelize", cellSize: 0.5, outputPath: path.join(dir, "x.vtu") }), /needs a mesh|path/);

  const sphere = path.join(dir, "sphere.mdpa");
  fs.writeFileSync(sphere, writeMdpa(icosphere(1, 2)));
  const sdf = (await meshDerive({ path: sphere, kind: "sdfVolume", cellSize: 0.5, outputPath: path.join(dir, "sdf.vti") })) as { fields: { variable: string }[]; summary: string };
  assert.ok(sdf.fields.some((f) => f.variable === "SDF_DISTANCE"));
  assert.match(fs.readFileSync(path.join(dir, "sdf.vti"), "utf8"), /type="ImageData"/);
  const vox = (await meshDerive({ path: sphere, kind: "voxelize", cellSize: 0.25, fill: "inside", outputPath: path.join(dir, "vox.vtu") })) as { summary: string; blocks: { count: number }[] };
  assert.match(vox.summary, /cells written/);
  assert.ok(vox.blocks[0].count > 0);
  await assert.rejects(meshDerive({ path: sphere, kind: "voxelize", cellSize: 0.25, fill: "inside", outputPath: path.join(dir, "vox.vti") }), /dense regular lattice/);
  await assert.rejects(meshDerive({ path: sphere, kind: "voxelize", cellSize: 0.0001, outputPath: path.join(dir, "big.vtu") }), /over 20,000,000/);
});
