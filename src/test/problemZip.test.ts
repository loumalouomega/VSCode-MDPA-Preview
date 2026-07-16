import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROBLEM_MANIFEST_NAME,
  buildProblemZip,
  parseProblemZip,
  detectMeshEntry,
  isSafeEntryName,
  materialsFileNamesFrom,
} from "../parser/problemZip";
import { createZip } from "../parser/zip";

const enc = (s: string) => Buffer.from(s, "utf8");

test("problem zip round-trips manifest and files", () => {
  const zip = buildProblemZip(
    {
      mesh: "beam.mdpa",
      ops: "beam.ops.json",
      case: "beam.kratoscase.json",
      generated: ["ProjectParameters.json", "StructuralMaterials.json", "MainKratos.py"],
    },
    [
      { name: "beam.mdpa", data: enc("Begin Nodes\nEnd Nodes\n") },
      { name: "beam.ops.json", data: enc('{"version":1,"operations":[]}') },
      { name: "beam.kratoscase.json", data: enc("{}") },
      { name: "ProjectParameters.json", data: enc("{}") },
      { name: "StructuralMaterials.json", data: enc("{}") },
      { name: "MainKratos.py", data: enc("print()") },
    ]
  );
  const parsed = parseProblemZip(zip);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.manifest?.mesh, "beam.mdpa");
  assert.equal(parsed.mesh, "beam.mdpa");
  assert.equal(parsed.ops, "beam.ops.json");
  assert.equal(parsed.manifest?.case, "beam.kratoscase.json");
  assert.deepEqual(parsed.manifest?.generated, [
    "ProjectParameters.json",
    "StructuralMaterials.json",
    "MainKratos.py",
  ]);
  assert.equal(parsed.entries.length, 7); // manifest + 6 files
  assert.ok(parsed.entries.some((e) => e.name === PROBLEM_MANIFEST_NAME));
});

test("parseProblemZip degrades gracefully without a manifest", () => {
  const zip = createZip([
    { name: "notes.txt", data: enc("hi") },
    { name: "part.vtu", data: enc("<xml/>") },
    { name: "part.ops.json", data: enc("{}") },
  ]);
  const parsed = parseProblemZip(zip);
  assert.equal(parsed.manifest, undefined);
  assert.equal(parsed.mesh, "part.vtu");
  assert.equal(parsed.ops, "part.ops.json"); // conventional `<stem>.ops.json`
});

test("parseProblemZip warns on malformed manifest and missing mesh entry", () => {
  const malformed = createZip([
    { name: PROBLEM_MANIFEST_NAME, data: enc("{oops") },
    { name: "m.mdpa", data: enc("") },
  ]);
  const p1 = parseProblemZip(malformed);
  assert.equal(p1.manifest, undefined);
  assert.equal(p1.mesh, "m.mdpa");
  assert.ok(p1.warnings.some((w) => w.includes("malformed")));

  const missing = buildProblemZip({ mesh: "gone.mdpa", generated: [] }, [
    { name: "other.mdpa", data: enc("") },
  ]);
  const p2 = parseProblemZip(missing);
  assert.equal(p2.mesh, "other.mdpa");
  assert.ok(p2.warnings.some((w) => w.includes('"gone.mdpa"')));
});

test("detectMeshEntry prefers .mdpa over other supported formats", () => {
  assert.equal(detectMeshEntry(["a.vtu", "b.mdpa", "c.stl"]), "b.mdpa");
  assert.equal(detectMeshEntry(["a.json", "c.stl"]), "c.stl");
  assert.equal(detectMeshEntry(["a.json", "README"]), undefined);
});

test("detectMeshEntry ignores the too-generic .xml/.dat meshio extensions", () => {
  // These are readable (DOLFIN/Tecplot) but an archive's stray config .xml or
  // data .dat must not be mistaken for the mesh when the manifest is missing.
  assert.equal(detectMeshEntry(["ProjectParameters.xml", "mesh.mdpa"]), "mesh.mdpa");
  assert.equal(detectMeshEntry(["config.xml", "readme.dat"]), undefined);
  // A genuine meshio format is still picked.
  assert.equal(detectMeshEntry(["config.xml", "domain.msh"]), "domain.msh");
});

test("isSafeEntryName rejects zip-slip attempts", () => {
  assert.ok(isSafeEntryName("mesh.mdpa"));
  assert.ok(isSafeEntryName("vtk_output/step_1.vtu"));
  assert.ok(isSafeEntryName("dir/")); // directory entry
  assert.ok(!isSafeEntryName("../evil.sh"));
  assert.ok(!isSafeEntryName("a/../../evil.sh"));
  assert.ok(!isSafeEntryName("/etc/passwd"));
  assert.ok(!isSafeEntryName("C:/windows/system32"));
  assert.ok(!isSafeEntryName("a\\b"));
  assert.ok(!isSafeEntryName("./a"));
  assert.ok(!isSafeEntryName(""));
  assert.ok(!isSafeEntryName("a//b"));
});

test("materialsFileNamesFrom deep-searches ProjectParameters.json", () => {
  const pp = JSON.stringify({
    solver_settings: {
      material_import_settings: { materials_filename: "StructuralMaterials.json" },
      sub_solver: {
        material_import_settings: { materials_filename: "FluidMaterials.json" },
      },
    },
    processes: { list: [{ Parameters: { materials_filename: "StructuralMaterials.json" } }] },
  });
  assert.deepEqual(materialsFileNamesFrom(pp), [
    "StructuralMaterials.json",
    "FluidMaterials.json",
  ]);
  assert.deepEqual(materialsFileNamesFrom("not json"), []);
  assert.deepEqual(materialsFileNamesFrom("{}"), []);
});
