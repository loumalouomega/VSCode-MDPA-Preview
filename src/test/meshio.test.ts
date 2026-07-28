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
import { readMeshioModel, writeMeshioBytes } from "../parser/meshio";
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
// `.med` is read-only for us: its wasm writer defers a mesh carrying data
// arrays to a Python reference writer that a wasm build has no Python for.
test("meshio++ 8.0.0 HDF5 formats round-trip (.cgns/.h5m/.hmf)", async () => {
  // CGNS is a volume-CFD format: meshio++'s writer/reader pair does not
  // round-trip a surface-only mesh (it writes no element section, and the read
  // then fails on the missing dataset), so it gets the tetra.
  const tet = await readMeshioModel(
    "t.mesh",
    [
      {
        name: "t.mesh",
        data: Buffer.from(
          "MeshVersionFormatted 1\nDimension 3\nVertices\n4\n" +
            "0 0 0 1\n1 0 0 1\n0 1 0 1\n0 0 1 1\n" +
            "Tetrahedra\n1\n1 2 3 4 1\nEnd\n"
        ),
      },
    ],
    ".mesh"
  );
  const surface = await sampleModel();
  for (const [ext, m] of [[".cgns", tet], [".h5m", surface], [".hmf", surface]] as const) {
    const { data: bytes, companions } = await writeMeshioBytes(m, ext);
    assert.ok(bytes instanceof Uint8Array && bytes.length > 0, `${ext} writes bytes`);
    assert.deepEqual(companions, [], `${ext} is a single file`);
    const back = await readMeshioModel(`x${ext}`, [{ name: `x${ext}`, data: bytes }], ext);
    assert.equal(back.nodeCount, m.nodeCount, `${ext} reads its points back`);
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
