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
  const bytes = await writeMeshioBytes(m, ".msh");
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.includes(0), "gmsh output contains NUL bytes — it is binary");
  assert.match(Buffer.from(bytes.subarray(0, 12)).toString("latin1"), /^\$MeshFormat/);

  const back = await readMeshioModel("r.msh", [{ name: "r.msh", data: bytes }], ".msh");
  assert.equal(back.nodeCount, m.nodeCount);
});

test("round-trips through a text format (medit)", async () => {
  const m = await sampleModel();
  const bytes = await writeMeshioBytes(m, ".mesh");
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
  // dolfin's writer is tri/tet-only and drops field data; tetgen writes a pair.
  await assert.rejects(writeMeshioBytes(m, ".xml"), /cannot write/i);
  await assert.rejects(writeMeshioBytes(m, ".node"), /cannot write/i);
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
