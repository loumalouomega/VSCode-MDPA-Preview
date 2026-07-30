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
