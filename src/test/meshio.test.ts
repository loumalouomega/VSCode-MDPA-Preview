/**
 * End-to-end tests against the real meshio++ WASM binary (like remesh.test.ts
 * runs the real MMG). No skip guard: @meshioplusplus/wasm is a hard dependency
 * and CI should fail loudly if it is missing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseMeshFile } from "../parser/meshFileParser";
import { loadMeshio, readMeshioModel, writeMeshioBytes } from "../parser/meshio";
import { MdpaModel } from "../parser/types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meshio-"));
}

const TRI_OFF = "OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n";

/** A small model to feed the writers, read back through meshio++ itself. */
function sampleModel(): Promise<MdpaModel> {
  return readMeshioModel("s.off", [{ name: "s.off", data: Buffer.from(TRI_OFF) }], ".off");
}

test("reads a meshio-only format into an MdpaModel", async () => {
  const m = await readMeshioModel(
    "a.off",
    [{ name: "a.off", data: Buffer.from(TRI_OFF) }],
    ".off"
  );
  assert.equal(m.nodeCount, 3);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].name, "triangle");
  assert.equal(m.blocks[0].vtkCellType, 5);
  assert.deepEqual(Array.from(m.blocks[0].connectivity), [1, 2, 3]); // 1-based
});

test("writes gmsh as BINARY and reads it back", async () => {
  // The regression a string-only write path would cause: gmsh 4.1 is binary.
  const m = await sampleModel();
  const { data: bytes } = await writeMeshioBytes(m, ".msh");
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.includes(0), "gmsh output contains NUL bytes — it is binary");
  assert.match(Buffer.from(bytes.subarray(0, 12)).toString("latin1"), /^\$MeshFormat/);

  const back = await readMeshioModel("r.msh", [{ name: "r.msh", data: bytes }], ".msh");
  assert.equal(back.nodeCount, m.nodeCount);
});

test("round-trips through a text format (medit)", async () => {
  const m = await sampleModel();
  const { data: bytes } = await writeMeshioBytes(m, ".mesh");
  assert.ok(!bytes.includes(0), "medit output is text");
  const back = await readMeshioModel("r.mesh", [{ name: "r.mesh", data: bytes }], ".mesh");
  assert.equal(back.nodeCount, m.nodeCount);
});

test("an unreadable .msh names every candidate it tried", async () => {
  await assert.rejects(
    readMeshioModel("x.msh", [{ name: "x.msh", data: Buffer.from("garbage") }], ".msh"),
    (e: Error) => {
      // .msh is ambiguous: gmsh (default), then ansys, then freefem.
      assert.match(e.message, /gmsh/);
      assert.match(e.message, /ansys/);
      assert.match(e.message, /freefem/);
      return true;
    }
  );
});

test("an explicit format skips the candidate list", async () => {
  await assert.rejects(
    readMeshioModel("x.msh", [{ name: "x.msh", data: Buffer.from("garbage") }], ".msh", "freefem"),
    (e: Error) => {
      assert.match(e.message, /freefem/);
      assert.ok(!/gmsh/.test(e.message), "the default was not attempted");
      return true;
    }
  );
});

test("writeMeshioBytes refuses a format meshio++ does not write for us", async () => {
  const m = await sampleModel();
  // dolfin's writer is tri/tet-only and drops field data; tetgen and ensight
  // each write a PAIR of files, which our single-path write cannot express.
  await assert.rejects(writeMeshioBytes(m, ".xml"), /cannot write/i);
  await assert.rejects(writeMeshioBytes(m, ".node"), /cannot write/i);
  await assert.rejects(writeMeshioBytes(m, ".case"), /cannot write/i);
  await assert.rejects(writeMeshioBytes(m, ".geo"), /cannot write/i);
});

// meshio++ 6.5.0 added EnSight Gold (.case/.geo) and Triangle (.node/.ele/.poly).
// Writing ensight emits a .case + .geo pair, but the .geo geometry file reads
// standalone — so we can generate one with an explicit "ensight" format and
// round-trip it back through the normal .geo reader path.
test("round-trips an EnSight Gold geometry (.geo)", async () => {
  const m = await sampleModel();
  const { data: bytes } = await writeMeshioBytes(m, ".geo", { format: "ensight" });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, "ensight writes bytes");
  const back = await readMeshioModel("r.geo", [{ name: "r.geo", data: bytes }], ".geo");
  assert.equal(back.nodeCount, m.nodeCount);
});

// Triangle's .poly writes one file (unlike its .node/.ele pair), so it is a
// real export target; reading one back must not throw.
test("round-trips a Triangle .poly (single-file)", async () => {
  const m = await sampleModel();
  const { data: bytes } = await writeMeshioBytes(m, ".poly"); // MESHIO_WRITE_FORMAT[".poly"] = triangle
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, ".poly writes bytes");
  const back = await readMeshioModel("r.poly", [{ name: "r.poly", data: bytes }], ".poly");
  assert.ok(back.nodeCount >= 3, ".poly reads its vertices back");
});

// meshio++ 6.4.0/6.6.0 added the write-only figure formats svg/tikz (a drawing
// of the mesh, not a re-readable mesh). Writing a 2D mesh must produce output.
test("write-only figure formats (.svg/.tikz) emit bytes", async () => {
  const m = await sampleModel(); // a planar triangle
  for (const ext of [".svg", ".tikz"]) {
    const { data: bytes } = await writeMeshioBytes(m, ext);
    assert.ok(bytes instanceof Uint8Array && bytes.length > 0, `${ext} writes bytes`);
    assert.ok(!bytes.includes(0), `${ext} output is text`);
  }
});

test("parseMeshFile routes tetgen's .node/.ele pair together", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "t.node"), "4 3 0 0\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n");
  fs.writeFileSync(path.join(dir, "t.ele"), "1 4 0\n1 1 2 3 4\n");
  // Opening either half must pull in its sibling.
  for (const half of ["t.ele", "t.node"]) {
    const m = await parseMeshFile(path.join(dir, half));
    assert.equal(m.nodeCount, 4, `${half} read 4 nodes`);
  }
});

test("parseMeshFile still throws for a genuinely unknown extension", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "x.zzz");
  fs.writeFileSync(p, "nope");
  await assert.rejects(parseMeshFile(p), /Unsupported mesh file extension "\.zzz"/);
});

// meshio++ 6.1.0 added the field-only formats dex/ip/mff (point_data, no cells).
// We list them read+write; their writers require a nodal field. A write must not
// throw when a nodal field is present, and .dex/.ip read the field back.
// (.mff round-trips to an empty mesh — accepted, still must not throw.)
test("meshio++ 6.1.0 field-only formats (.dex/.ip/.mff) round-trip a nodal field", async () => {
  // A triangle carrying a Nodal field T (the field-only writers need point_data).
  const m = await sampleModel();
  const withField: MdpaModel = {
    ...m,
    fields: [
      {
        kind: "Nodal",
        variable: "T",
        components: 1,
        ids: Int32Array.from([1, 2, 3]),
        values: Float64Array.from([10, 20, 30]),
      },
    ],
  };
  for (const ext of [".dex", ".ip", ".mff"]) {
    const { data: bytes } = await writeMeshioBytes(withField, ext);
    assert.ok(bytes instanceof Uint8Array && bytes.length > 0, `${ext} writes bytes`);
    // Reading back must not throw (geometry-less content is allowed).
    const back = await readMeshioModel(`x${ext}`, [{ name: `x${ext}`, data: bytes }], ext);
    assert.ok(back.nodeCount >= 0, `${ext} reads back`);
  }
});

// --- meshio++ 8.0.0: HDF5/netCDF formats, and XDMF's companion .h5 ----------

// The wasm build gained HDF5 in 8.0.0, so cgns/h5m/hmf/med became reachable.
test("meshio++ 8.0.0 HDF5 formats round-trip (.h5m/.hmf)", async () => {
  const surface = await sampleModel();
  for (const ext of [".h5m", ".hmf"] as const) {
    const { data: bytes, companions } = await writeMeshioBytes(surface, ext);
    assert.ok(bytes instanceof Uint8Array && bytes.length > 0, `${ext} writes bytes`);
    assert.deepEqual(companions, [], `${ext} is a single file`);
    const back = await readMeshioModel(`x${ext}`, [{ name: `x${ext}`, data: bytes }], ext);
    assert.equal(back.nodeCount, surface.nodeCount, `${ext} reads its points back`);
  }
});

// --- meshio++ 9.8.0: CGNS rewritten to a genuine SIDS-compliant subset ------
//
// Before 9.8.0 the writer emitted only the FIRST tetra block it found and
// wrote empty ElementRange/ElementConnectivity for anything else, so every
// non-tetra mesh — including a surface mesh — wrote a file unreadable even by
// this library's own reader. These three cases pin the guarantees the
// rewrite actually makes (see doc/formats/cgns.md upstream): a surface mesh
// round-trips, multiple cell blocks each keep their own section (unlike
// MED, CGNS never consolidates by type), and a wedge's node order round-trips
// unpermuted.

test("meshio++ 9.8.0 CGNS round-trips a surface-only (triangle) mesh", async () => {
  const surface = await sampleModel();
  const { data: bytes, companions } = await writeMeshioBytes(surface, ".cgns");
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, ".cgns writes bytes");
  assert.deepEqual(companions, [], ".cgns is a single file");
  const back = await readMeshioModel("x.cgns", [{ name: "x.cgns", data: bytes }], ".cgns");
  assert.equal(back.nodeCount, surface.nodeCount, ".cgns reads its points back");
  assert.equal(back.blocks.length, 1);
  assert.equal(back.blocks[0].count, surface.blocks[0].count);
});

test("meshio++ 9.8.0 CGNS keeps multiple cell blocks as separate sections", async () => {
  // Two DIFFERENT cell types so our own EntityBlock merge-by-(type,stride)
  // (buildBlocksFromOffsets) can't itself hide a section getting dropped or
  // merged — a real regression here is meshio++'s, not ours.
  const m = await loadMeshio();
  const mesh = {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    dim: 3,
    cells: [
      { type: "triangle", data: new Int32Array([0, 1, 2]), nodesPerCell: 3 },
      { type: "quad", data: new Int32Array([0, 1, 2, 3]), nodesPerCell: 4 },
    ],
  };
  m.writeMesh("/multi.cgns", mesh, "cgns");
  const back = m.readMesh("/multi.cgns", "cgns");
  assert.deepEqual(
    back.cells.map((c) => c.type),
    ["triangle", "quad"],
    "sections stay separate and in order, not consolidated like MED"
  );
  assert.equal(back.cells[0].data.length, 3);
  assert.equal(back.cells[1].data.length, 4);
});

test("meshio++ 9.8.0 CGNS round-trips a wedge with its node order unpermuted", async () => {
  // CGNS's PENTA_6 order is identity (deliberately NOT the {0,2,1,3,5,4} flip
  // MESHIO_TO_VTK_ORDER applies at our own JS<->meshio boundary for VTK
  // interop — see meshioFormats.ts). Round-tripping through our full
  // writeMeshioBytes/readMeshioModel pipeline exercises both boundaries at
  // once: a bug in either place would show up as a swapped corner here.
  // Nodes placed at distinct, identifiable coordinates so a silent
  // permutation is caught by position, not just by count.
  const coords = new Float32Array([
    0, 0, 0, // 0: bottom corner A
    1, 0, 0, // 1: bottom corner B
    0, 1, 0, // 2: bottom corner C
    0, 0, 1, // 3: top corner A
    1, 0, 1, // 4: top corner B
    0, 1, 1, // 5: top corner C
  ]);
  const wedgeModel: MdpaModel = {
    nodeCount: 6,
    nodeIds: new Int32Array([1, 2, 3, 4, 5, 6]),
    coords,
    blocks: [
      {
        kind: "Elements",
        name: "Wedge",
        vtkCellType: 13, // VTK_WEDGE
        count: 1,
        stride: 6,
        entityIds: new Int32Array([1]),
        connectivity: new Int32Array([1, 2, 3, 4, 5, 6]),
      },
    ],
    subModelParts: [],
    meta: [],
    fields: [],
    diagnostics: [],
    is3D: true,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };

  const { data: bytes } = await writeMeshioBytes(wedgeModel, ".cgns");
  const back = await readMeshioModel("w.cgns", [{ name: "w.cgns", data: bytes }], ".cgns");
  assert.equal(back.blocks.length, 1);
  assert.equal(back.blocks[0].vtkCellType, 13);
  assert.equal(back.blocks[0].stride, 6);

  const conn = back.blocks[0].connectivity; // 1-based node ids, local order 0..5
  const idxOf = (id: number) => back.nodeIds.indexOf(id);
  const cornerAt = (localIndex: number) => {
    const i = idxOf(conn[localIndex]);
    return [back.coords[i * 3], back.coords[i * 3 + 1], back.coords[i * 3 + 2]];
  };
  const expected = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
  ];
  for (let k = 0; k < 6; k++) {
    assert.deepEqual(cornerAt(k), expected[k], `corner ${k} kept its position`);
  }
});

// --- meshio++ 9.9.0: shapes and groups cross the boundary -------------------
//
// The release closed the two gaps that made this extension's workarounds
// necessary: data arrays crossed as flat, SHAPELESS Float64Arrays (so an (n,3)
// vector re-entered C++ as (3n,1), which is why MED refused to read its own
// output), and the Exodus writer emitted neither element variables nor
// `eb_names`. These pin what the extension now relies on, against the real
// artifact rather than against the docs.

/** A triangle pair carrying a scalar and a vector at both locations. */
function vectorModel(): MdpaModel {
  const { parseMdpa } = require("../parser/mdpaParser") as typeof import("../parser/mdpaParser");
  return parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 1.0 1.0 0.0",
      " 4 0.0 1.0 0.0",
      "End Nodes",
      "Begin Elements Element2D3N",
      " 1 0 1 2 3",
      " 2 0 1 3 4",
      "End Elements",
      "Begin NodalData TEMPERATURE",
      " 1 0 10.0",
      " 2 0 20.0",
      " 3 0 30.0",
      " 4 0 40.0",
      "End NodalData",
      "Begin NodalData VELOCITY",
      " 1 0 (1.0,2.0,3.0)",
      " 2 0 (4.0,5.0,6.0)",
      " 3 0 (7.0,8.0,9.0)",
      " 4 0 (10.0,11.0,12.0)",
      "End NodalData",
      "Begin SubModelPart Inlet",
      " Begin SubModelPartNodes",
      "  1",
      "  2",
      " End SubModelPartNodes",
      " Begin SubModelPartElements",
      "  1",
      " End SubModelPartElements",
      "End SubModelPart",
      "",
    ].join("\n")
  );
}

test("meshio++ 9.9.0: MED round-trips a vector field (the reason it was read-only)", async () => {
  // Through 9.8.0 this wrote without error and then threw "MED: field data size
  // does not match its declared shape" on the read back, which is why `.med` was
  // excluded from MESHIO_WRITE_FORMAT. A real Kratos mesh almost always carries
  // a vector field, so this one case gates the whole format.
  const model = vectorModel();
  const { data: bytes, companions } = await writeMeshioBytes(model, ".med");
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, ".med writes bytes");
  assert.deepEqual(companions, [], ".med is a single file");

  const back = await readMeshioModel("x.med", [{ name: "x.med", data: bytes }], ".med");
  const v = back.fields.find((f) => f.variable === "VELOCITY");
  assert.ok(v, `expected VELOCITY, got ${back.fields.map((f) => f.variable)}`);
  assert.equal(v.components, 3, "the component width survived, not 3n scalars");
  assert.deepEqual(Array.from(v.values.slice(0, 3)), [1, 2, 3]);
  assert.equal(back.fields.find((f) => f.variable === "TEMPERATURE")?.components, 1);
});

test("meshio++ 9.9.0: a SubModelPart survives a MED export as a family", async () => {
  // Both halves of a part (its nodes and its elements) are written under ONE
  // name, and MED keys a family by name — so they come back as a single part.
  const model = vectorModel();
  const { data: bytes } = await writeMeshioBytes(model, ".med");
  const back = await readMeshioModel("x.med", [{ name: "x.med", data: bytes }], ".med");
  const inlet = back.subModelParts.find((p) => p.path === "Inlet");
  assert.ok(inlet, `expected Inlet, got ${back.subModelParts.map((p) => p.path)}`);
  assert.deepEqual(Array.from(inlet.nodeIds).sort((a, b) => a - b), [1, 2]);
  assert.equal(inlet.elementIds.length, 1);
  // The block's own name rides along as a second, separate group.
  assert.ok(back.subModelParts.some((p) => p.path === "Element2D3N"));
});

test("meshio++ 9.9.0: CGNS carries point data, which it used to drop entirely", async () => {
  const model = vectorModel();
  const { data: bytes } = await writeMeshioBytes(model, ".cgns");
  const back = await readMeshioModel("x.cgns", [{ name: "x.cgns", data: bytes }], ".cgns");
  // A k-component array is split into `<name>_0..k-1` siblings and rejoined on
  // read — CGNS has no component concept, so this is a meshio++ convention.
  assert.equal(back.fields.find((f) => f.variable === "VELOCITY")?.components, 3);
  assert.equal(back.fields.find((f) => f.variable === "TEMPERATURE")?.components, 1);
});

test("meshio++ 9.9.0: Exodus writes ordinary cell data and recovers block names", async () => {
  const model = vectorModel();
  // An Elemental field with no `exodus:attr:` home: a vector, which cannot be an
  // attribute at all. Before 9.9.0 the writer emitted no element variables, so
  // this array was dropped outright.
  model.fields.push({
    kind: "Elemental",
    variable: "FORCE",
    components: 3,
    ids: Int32Array.from([1, 2]),
    values: Float64Array.from([1, 2, 3, 4, 5, 6]),
  });
  const { data: bytes } = await writeMeshioBytes(model, ".exo");
  const back = await readMeshioModel("x.exo", [{ name: "x.exo", data: bytes }], ".exo");

  const force = back.fields.find((f) => f.variable === "FORCE");
  assert.ok(force, `expected FORCE, got ${back.fields.map((f) => f.variable)}`);
  assert.equal(force.components, 3);
  assert.deepEqual(Array.from(force.values), [1, 2, 3, 4, 5, 6]);
  // `eb_names` from the per-block Cell region: the block's real name, where a
  // pre-9.9.0 export came back as the reader's synthetic "Block 0".
  assert.ok(
    back.subModelParts.some((p) => p.path === "Element2D3N"),
    `expected the block name, got ${back.subModelParts.map((p) => p.path)}`
  );
});

test("meshio++ 9.9.0: MED is an options-aware reader, so a lenient retry is reachable", async () => {
  // The retry in readMeshioModel is only useful if the reader sees the flag at
  // all — MED joined upstream's registry_readers_ex at 9.9.0. A file that needs
  // nothing extra must read identically through both paths.
  const m = await loadMeshio();
  assert.equal(m.readerSupportsOptions("med"), true);

  const { data: bytes } = await writeMeshioBytes(vectorModel(), ".med");
  m.FS.writeFile("/lenient.med", bytes as Uint8Array);
  const strict = m.readMesh("/lenient.med", "med");
  const lenient = m.readMeshSelective("/lenient.med", { format: "med", lenient: true });
  assert.deepEqual(Array.from(lenient.points), Array.from(strict.points));
  assert.equal(lenient.regions?.length, strict.regions?.length);
});

test("meshio++ 9.9.0: MED reports no timeValues, so it cannot drive a timeline", async () => {
  // Pins the reason `.med` is absent from IN_FILE_TIMELINE_EXTENSIONS even
  // though its reader honours a `timeStep`: MED is not one of upstream's
  // metadata readers, so a step count is undiscoverable before a read.
  const m = await loadMeshio();
  const { data: bytes } = await writeMeshioBytes(vectorModel(), ".med");
  m.FS.writeFile("/tv.med", bytes as Uint8Array);
  assert.deepEqual(m.readMetadata("/tv.med", "med").timeValues, []);
});

test("header-only metadata: gmsh/xdmf/gid stay cheap, exodus/med/cgns fall back", async () => {
  // The measured table behind HEADER_METADATA_EXTENSIONS (meshFormats.ts):
  // only these readers answer without a full read, so only they may serve a
  // "fast" metadata path. A format that falls back is still CORRECT, just not
  // cheap — the gate this pins is cost, not correctness.
  const m = await loadMeshio();
  const stage = (name: string, data: Uint8Array, companions: { name: string; data: Uint8Array }[] = []) => {
    m.FS.writeFile(`/${name}`, data);
    for (const c of companions) m.FS.writeFile(`/${c.name}`, c.data);
  };
  const model = await sampleModel();
  for (const [ext, fmt] of [["probe.msh", "gmsh"], ["probe.xdmf", "xdmf"], ["probe.post.msh", "gid"]] as const) {
    const { data, companions } = await writeMeshioBytes(model, ext.slice(ext.indexOf(".")) as never, { stem: "probe" });
    stage(ext, data as Uint8Array, companions);
    const md = m.readMetadata(`/${ext}`, fmt) as unknown as {
      numPoints: number; numCells: number; format: string; fellBackToFullRead: boolean;
      cellBlocks: { type: string; numCells: number }[]; regions: unknown[]; bboxMin?: number[];
    };
    assert.equal(md.numPoints, model.nodeCount, `${ext} count`);
    assert.ok(md.numCells > 0, `${ext} cells`);
    assert.equal(md.format, fmt);
    assert.equal(md.fellBackToFullRead, false, `${ext} must stay header-only`);
    assert.deepEqual(md.regions, [], `${ext} maps no regions on the native path`);
    assert.equal(md.bboxMin, undefined, `${ext} computes no bbox on the native path`);
  }
  for (const [ext, fmt] of [["probe2.med", "med"], ["probe2.cgns", "cgns"]] as const) {
    const { data } = await writeMeshioBytes(model, ext.slice(ext.indexOf(".")) as never, { stem: "probe2" });
    stage(ext, data as Uint8Array);
    const md = m.readMetadata(`/${ext}`, fmt) as unknown as { fellBackToFullRead: boolean; numPoints: number };
    assert.equal(md.fellBackToFullRead, true, `${ext} falls back to a full read`);
    assert.equal(md.numPoints, model.nodeCount, `${ext} summary still correct`);
  }
  // Exodus, the format the header preview is most wanted for, is the one that
  // falls back — with rich regions as the consolation. Pinned so a future
  // upstream header path fails loudly instead of silently changing cost.
  const exo = fs.readFileSync(path.resolve(__dirname, "../../src/test/fixtures/exodus/seacas.exo"));
  stage("seacas.exo", exo);
  const emd = m.readMetadata("/seacas.exo", "exodus") as unknown as {
    fellBackToFullRead: boolean; numPoints: number; regions: { name: string }[]; bboxMin?: number[];
  };
  assert.equal(emd.fellBackToFullRead, true);
  assert.equal(emd.numPoints, 12);
  assert.ok(emd.regions.some((r) => r.name === "steel"), "block regions ride the fallback");
  assert.ok(emd.bboxMin !== undefined, "bbox rides the fallback too");
});

test("XDMF returns its companion .h5, named after the destination stem", async () => {
  // Regression: since meshio++ 8.0.0 the wasm XDMF writer puts the heavy
  // arrays in a sibling .h5 and leaves only "<stem>.h5:/data0" references in
  // the XML, so returning the XML alone writes a dangling reference.
  const m = await sampleModel();
  const { data, companions } = await writeMeshioBytes(m, ".xdmf", { stem: "beam" });
  assert.equal(companions.length, 1, "one companion file");
  assert.equal(companions[0].name, "beam.h5");
  assert.ok(companions[0].data.length > 0);

  const xml = Buffer.from(data).toString("utf8");
  assert.match(xml, /beam\.h5:/, "the XML references the companion by that exact name");
  assert.doesNotMatch(xml, /\bout\.h5\b/, "not the old hardcoded MEMFS stem");

  // And the pair actually reads back together.
  const back = await readMeshioModel(
    "beam.xdmf",
    [
      { name: "beam.xdmf", data },
      { name: "beam.h5", data: companions[0].data },
    ],
    ".xdmf"
  );
  assert.equal(back.nodeCount, m.nodeCount);
});

test("a mesh exported to .xdmf writes both files to disk", async () => {
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const m = await sampleModel();
  const dir = tmpDir();
  const dest = path.join(dir, "part.xdmf");
  const { data, companions } = await writeMeshFileAsync(m, ".xdmf", { name: "part" });
  fs.writeFileSync(dest, data);
  for (const c of companions) fs.writeFileSync(path.join(dir, c.name), c.data);

  assert.deepEqual(fs.readdirSync(dir).sort(), ["part.h5", "part.xdmf"]);
  const back = await parseMeshFile(dest);
  assert.equal(back.nodeCount, m.nodeCount, "the written pair re-parses");
});

test("single-file formats report no companions", async () => {
  const m = await sampleModel();
  for (const ext of [".msh", ".mesh", ".vol"]) {
    const { companions } = await writeMeshioBytes(m, ext);
    assert.deepEqual(companions, [], `${ext} writes exactly one file`);
  }
});

// --- meshio++ 9.22.0: the capabilities the 9.9.0 -> 9.22.0 jump added --------
//
// Fourteen minor versions, of which three reach this extension: the OpenFOAM
// polyMesh writer (9.20.0), cgnslib cross-compiled for wasm (9.22.0), and the
// `gradient` operation (9.10.0). Everything else the release notes list is
// either upstream-only or something this extension implements natively.
// Measured against the live artifact, in the style of the 9.9.0 section above.

/** A single hexahedron — OpenFOAM derives its faces from VOLUME cells. */
function hexModel(): MdpaModel {
  const { parseMdpa } = require("../parser/mdpaParser") as typeof import("../parser/mdpaParser");
  return parseMdpa(
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
}

test("meshio++ 9.22.0: cgnslib is linked into the wasm build", async () => {
  // Upstream added this probe precisely because a build that silently dropped
  // the dependency still reads every file meshio++ writes itself, so the
  // regression would only surface on a user's ADF-container file. Asserting it
  // here is what turns "the .wasm carries ~290 KB of cgnslib" into a checked
  // fact rather than a release note.
  const { loadMeshio } = await import("../parser/meshio");
  const m = await loadMeshio();
  assert.equal(typeof m.hasCgnslib, "function", "the binding exists");
  assert.equal(m.hasCgnslib(), true, "ADF containers and CGNS 3.x are reachable");
});

test("meshio++ 9.20.0: .foam writes a polyMesh DIRECTORY, not a sibling file", async () => {
  // The reason MeshioCompanionFile.name carries a relative PATH. The named
  // output is a 0-byte marker and the companions ARE the mesh, so a caller
  // that ignored them would write nothing at all.
  const { data, companions } = await writeMeshioBytes(hexModel(), ".foam", { stem: "case" });
  assert.equal(data.length, 0, "the .foam file itself is an empty marker");
  assert.deepEqual(
    companions.map((c) => c.name).sort(),
    [
      "constant/polyMesh/boundary",
      "constant/polyMesh/faces",
      "constant/polyMesh/neighbour",
      "constant/polyMesh/owner",
      "constant/polyMesh/points",
    ],
    "five polyMesh files, each under its relative directory"
  );
  for (const c of companions) assert.ok(c.data.length > 0, `${c.name} is non-empty`);

  const boundary = Buffer.from(
    companions.find((c) => c.name.endsWith("boundary"))!.data
  ).toString("utf8");
  // No OpenFoamInfo side channel through the generic registry writer, so every
  // case gets the one synthesized patch `blockMesh` itself produces.
  assert.match(boundary, /defaultFaces/, "the synthesized patch is named in boundary");
});

test("a mesh exported to .foam writes the whole tree to disk", async () => {
  // The caller-side half: a companion's folders do not exist yet.
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const dest = path.join(dir, "run.foam");
  const { data, companions } = await writeMeshFileAsync(hexModel(), ".foam", { name: "run" });
  fs.writeFileSync(dest, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  assert.deepEqual(
    fs.readdirSync(path.join(dir, "constant", "polyMesh")).sort(),
    ["boundary", "faces", "neighbour", "owner", "points"]
  );
  assert.ok(fs.existsSync(dest), "the marker sits beside constant/");
});

// ---- reading a case back (the other direction) ------------------------------

/** Writes hexModel() as a real case in a temp dir and returns `<dir>/run.foam`. */
async function writeCase(): Promise<string> {
  const { writeMeshFileAsync } = await import("../parser/writers/meshWriter");
  const dir = tmpDir();
  const dest = path.join(dir, "run.foam");
  const { data, companions } = await writeMeshFileAsync(hexModel(), ".foam", { name: "run" });
  fs.writeFileSync(dest, data);
  for (const c of companions) {
    const p = path.join(dir, c.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c.data);
  }
  return dest;
}

const polyMesh = (marker: string, name: string) =>
  path.join(path.dirname(marker), "constant", "polyMesh", name);

test("an OpenFOAM case round-trips: write a case, then open its marker", async () => {
  // THE gate for this feature. Staging a directory tree is the whole change,
  // and nothing short of reading a real case back proves it works.
  const marker = await writeCase();
  const model = await parseMeshFile(marker);

  assert.equal(model.nodeCount, 8, "the hexahedron's corners");
  const vol = model.blocks.filter((b) => b.kind === "Elements");
  const bnd = model.blocks.filter((b) => b.kind === "Conditions");
  assert.equal(vol.reduce((n, b) => n + b.count, 0), 1, "one volume cell");
  assert.equal(bnd.reduce((n, b) => n + b.count, 0), 6, "six boundary faces, as Conditions");

  // Bounds rather than coordinate order: OpenFOAM renumbers points.
  assert.deepEqual(Array.from(model.bounds.min), [0, 0, 0]);
  assert.deepEqual(Array.from(model.bounds.max), [1, 1, 1]);

  // The patch name our own writer synthesizes, recovered from boundary.
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["defaultFaces"]);
  assert.equal(model.subModelParts[0].conditionIds.length, 6);
  assert.equal(model.subModelParts[0].elementIds.length, 0, "faces are Conditions, not Elements");

  // The tag array did its job and is gone; leaving it would be an Elemental
  // field keyed on ids that moved into the condition space.
  assert.ok(!model.fields.some((f) => f.variable === "cell_tags"));
});

test("real patch names survive, one SubModelPart each", async () => {
  // The only multi-patch exercise, and so the only check on the
  // `-(patchIndex+1)` <-> boundary-file-order convention the join rests on.
  const marker = await writeCase();
  fs.writeFileSync(
    polyMesh(marker, "boundary"),
    [
      "FoamFile", "{", "    version 2.0;", "    format ascii;",
      "    class polyBoundaryMesh;", "    object boundary;", "}",
      "", "2", "(",
      "    inlet", "    {", "        type patch;", "        inGroups (wall);",
      "        nFaces 3;", "        startFace 0;", "    }",
      "    outlet", "    {", "        type wall;",
      "        nFaces 3;", "        startFace 3;", "    }",
      ")", "",
    ].join("\n")
  );
  const model = await parseMeshFile(marker);
  assert.deepEqual(model.subModelParts.map((p) => p.name), ["inlet", "outlet"]);
  const [a, b] = model.subModelParts;
  assert.equal(a.conditionIds.length, 3);
  assert.equal(b.conditionIds.length, 3);
  const overlap = Array.from(a.conditionIds).filter((id) => b.conditionIds.includes(id));
  assert.deepEqual(overlap, [], "the two patches share no face");
  // The nFaces cross-check agreed, so no warning about mismatched patches.
  assert.ok(!model.diagnostics.some((d) => /may not line up/.test(d.message)));
});

test("a writeCompression on case reads through the gunzip", async () => {
  const zlib = await import("node:zlib");
  const marker = await writeCase();
  const pts = polyMesh(marker, "points");
  fs.writeFileSync(`${pts}.gz`, zlib.gzipSync(fs.readFileSync(pts)));
  fs.unlinkSync(pts);

  const model = await parseMeshFile(marker);
  assert.equal(model.nodeCount, 8, "points.gz was inflated during staging");
  assert.deepEqual(Array.from(model.bounds.max), [1, 1, 1]);
});

test("a case without boundary loses its faces, and says so", async () => {
  // Measured upstream behaviour: boundary is optional, and without it the whole
  // boundary-face block disappears rather than arriving unnamed.
  const marker = await writeCase();
  fs.unlinkSync(polyMesh(marker, "boundary"));
  const model = await parseMeshFile(marker);
  assert.equal(model.blocks.filter((b) => b.kind === "Conditions").length, 0);
  assert.equal(model.blocks.reduce((n, b) => n + b.count, 0), 1, "the volume cell survives");
  assert.deepEqual(model.subModelParts, []);
  assert.ok(
    model.diagnostics.some((d) => /boundary is missing/.test(d.message)),
    "the loss is reported rather than silent"
  );
});

test("a missing REQUIRED polyMesh file fails by name", async () => {
  // Without this the failure is an FS.ErrnoError whose message is undefined.
  const marker = await writeCase();
  fs.unlinkSync(polyMesh(marker, "owner"));
  await assert.rejects(parseMeshFile(marker), /owner/);
});

test("staging honours a subdirectory name, with no .foam involved", async () => {
  // Guards stageFiles directly: the staging root moved from "/" to /mio_in and
  // names may now carry directories.
  const off = "OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n";
  const model = await readMeshioModel(
    "sub/dir/s.off",
    [{ name: "sub/dir/s.off", data: new TextEncoder().encode(off) }],
    ".off"
  );
  assert.equal(model.nodeCount, 3);
});

/**
 * The dual-artifact loader (meshio++ >= 8.8.0).
 *
 * The package ships a sequential and an OpenMP/pthreads build and picks between
 * them itself; under Node it picks the threaded one. These two tests pin the
 * consequence for our `locateFile`, which is what actually broke on the 9.3.0
 * upgrade — with a fixed path, EVERY meshio format dies with an opaque
 * LinkError that names neither the file nor the variant.
 */
test("loadMeshio instantiates a coherent variant/binary pair", async () => {
  const { loadMeshio } = await import("../parser/meshio");
  const m = await loadMeshio();
  assert.ok(
    ["seq", "openmp"].includes(m.parallelBackend()),
    `unexpected parallel backend "${m.parallelBackend()}"`
  );
});

test("locateFile is asked for the loaded variant's own filename", async () => {
  // The invariant a fixed-path locateFile violates. Asserting the REQUESTED
  // name matches the LOADED variant is what makes "just return the sequential
  // .wasm" provably wrong, and it holds whichever variant this host picks.
  const { configureMeshio, loadMeshio } = await import("../parser/meshio");
  const dist = path.join(
    path.dirname(require.resolve("@meshioplusplus/wasm/package.json")),
    "dist"
  );
  const requested: string[] = [];
  configureMeshio({
    locateFile: (name: string) => {
      requested.push(name);
      return path.join(dist, path.basename(name));
    },
  });
  try {
    const m = await loadMeshio();
    const expected =
      m.parallelBackend() === "openmp"
        ? "meshioplusplus_wasm_mt.wasm"
        : "meshioplusplus_wasm.wasm";
    assert.ok(
      requested.includes(expected),
      `locateFile was asked for ${JSON.stringify(requested)}, not "${expected}"`
    );
  } finally {
    configureMeshio({}); // never leak the override into the other tests
  }
});

// --- meshio++ 10.14.0: what the 9.22.0 -> 10.14.0 jump actually changes -------
//
// Twelve minor versions plus a major, and the major (v10.0.0) is a
// version-NUMBER bump only — no API, behavior or ABI change. The `index.mjs`
// diff across the whole window is purely additive, and every function this
// extension already called is byte-identical in signature, which is why the
// upgrade needed no call-site edits at all. What it DOES bring is a set of
// operations whose result shape survives our lossy meshio boundary, i.e. new
// Group A oracle material. Pinned here in the style of the 9.22.0 block above.

test("meshio++ 10.14.0: the new oracle-shaped operations are all present", async () => {
  // Each of these returns something whose shape survives modelToMeshio's
  // losses — a per-node tuple, a per-cell array, or a plain number array — so
  // each is adoptable WITHOUT taking meshio++'s mesh back. Asserting they are
  // bound is what stops a wasm rebuild from silently removing the ground the
  // ops built on them stand on.
  const { loadMeshio } = await import("../parser/meshio");
  const m = await loadMeshio();
  for (const name of [
    "hessian", // 10.9.0  — (n,9) per EXISTING node, like gradient
    "estimateError", // 10.10.0 — one Float64 per cell, like partitionLabels
    "sampleDistance", // 10.4.0  — flat coords in, one double per point out
    "conservativeInterpolate", // 10.7.0  — mass-preserving cross-mesh transfer
    "dataIntegrate", // 10.8.0  — read-only totals/means, per Cell region
    "surfaceWatertightCheck", // 10.4.0  — read-only, numbers not a bare flag
  ]) {
    assert.equal(
      typeof (m as unknown as Record<string, unknown>)[name],
      "function",
      `${name} is bound`
    );
  }
});

test("meshio++ 10.14.0: cgnslib is still linked in", async () => {
  // The 9.22.0 assertion, re-run: the ~290 KB dependency is exactly the kind of
  // thing a rebuild drops silently, and the loss only shows on a user's
  // ADF-container file.
  const { loadMeshio } = await import("../parser/meshio");
  const m = await loadMeshio();
  assert.equal(m.hasCgnslib(), true, "ADF containers and CGNS 3.x stay reachable");
});

test("meshio++ 10.14.0: gmsh STILL writes no $PhysicalNames", async () => {
  // The one documented export gap that did NOT close in this window — no gmsh
  // writer change ships between 9.22.0 and 10.14.0. Measured rather than
  // assumed, because the fix landing upstream is exactly the kind of change
  // that should make a stale "SubModelParts do not survive a .msh export" note
  // in CLAUDE.md fail loudly instead of quietly misinforming.
  const { parseMdpa } = require("../parser/mdpaParser") as typeof import("../parser/mdpaParser");
  const model = parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0",
      " 2 1.0 0.0 0.0",
      " 3 0.0 1.0 0.0",
      " 4 0.0 0.0 1.0",
      "End Nodes",
      "Begin Elements Element3D4N",
      " 1 0 1 2 3 4",
      "End Elements",
      "Begin SubModelPart Inlet",
      " Begin SubModelPartNodes",
      "  1",
      "  2",
      "  3",
      " End SubModelPartNodes",
      " Begin SubModelPartElements",
      "  1",
      " End SubModelPartElements",
      "End SubModelPart",
      "",
    ].join("\n")
  );
  const { data } = await writeMeshioBytes(model, ".msh", { stem: "probe" });
  const txt = Buffer.from(data).toString("latin1");
  assert.ok(txt.includes("$MeshFormat"), "it is a gmsh file");
  assert.ok(
    !txt.includes("$PhysicalNames"),
    "still no physical groups on the way out — MED and Abaqus remain the " +
      "formats that carry SubModelParts through an export"
  );
});

// --- meshio++ 10.20.2: what the 10.14.0 -> 10.20.2 jump changes --------------
//
// The `index.mjs` diff across this window is again purely additive (a
// provenance API). What earns the bump is the GiD postprocess format, and one
// behavioural change worth pinning rather than discovering: provenance became
// on-by-default in 10.17.0.

test("meshio++ 10.20.2: GiD is available in BOTH directions", async () => {
  // Writing GiD needs gidpost, which is hard-gated on zlib, and upstream's own
  // release notes describe CI legs that shipped with zlib off — so `gid` being
  // writable in the PUBLISHED artifact is a property of this build, not of the
  // version number, and is exactly the kind of thing a rebuild drops silently.
  // The registry entries in meshioFormats.ts assume both halves.
  const { loadMeshio } = await import("../parser/meshio");
  const m = await loadMeshio();
  const formats = m.availableFormats();
  assert.ok(formats.readers.includes("gid"), "gid reads (ascii needs nothing)");
  assert.ok(formats.writers.includes("gid"), "gid writes (needs gidpost + zlib)");
  assert.equal(m.hasCgnslib(), true, "cgnslib is still linked in");
});

test("meshio++ 10.17.0: provenance is on by default, and stays a COMMENT", async () => {
  // Every meshio++ write now records a provenance line. Pinned because the
  // failure mode would be silent and severe: if it ever became a structural
  // block rather than a comment, files this extension writes could stop being
  // readable by the tools they are written for. Measured across the 10.14 ->
  // 10.20 jump, it only replaces the banner line these formats already had.
  const model = sampleModel();
  const { data } = await writeMeshioBytes(await model, ".msh", { stem: "p" });
  const txt = Buffer.from(data).toString("latin1");
  assert.match(txt, /\$MeshFormat/, "still a well-formed gmsh file");

  // The GiD results file is the clearest case: its provenance line is prefixed
  // with the format's own comment marker, not injected as a record.
  const { parseMdpa } = require("../parser/mdpaParser") as typeof import("../parser/mdpaParser");
  const tet = parseMdpa(
    [
      "Begin Nodes",
      " 1 0.0 0.0 0.0", " 2 1.0 0.0 0.0", " 3 0.0 1.0 0.0", " 4 0.0 0.0 1.0",
      "End Nodes",
      "Begin Elements Element3D4N",
      " 1 0 1 2 3 4",
      "End Elements",
      "",
    ].join("\n")
  );
  const gid = await writeMeshioBytes(tet, ".post.msh", { stem: "case" });
  const res = Buffer.from(
    gid.companions.find((c) => c.name === "case.post.res")!.data
  ).toString("latin1");
  assert.match(res, /^GiD Post Results File/m, "the banner still leads the file");
  for (const line of res.split("\n")) {
    if (/meshio\+\+/.test(line)) {
      assert.match(line, /^#/, `provenance rides a comment line, got: ${line}`);
    }
  }
});
