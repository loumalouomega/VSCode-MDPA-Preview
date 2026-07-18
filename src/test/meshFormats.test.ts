/**
 * Cross-checks the format lists that are maintained by hand in more than one
 * place. Nothing else asserts these agree, and adding meshio++ took them from
 * 10 to 36 entries each — the point where drift stops being theoretical.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  MESHIO_EXTENSIONS,
  STATIC_EXTENSIONS,
  SUPPORTED_MESH_EXTENSIONS,
  TIMELINE_EXTENSIONS,
} from "../parser/meshFormats";
import {
  MESHIO_EXPORT_EXTENSIONS,
  MESHIO_READ_CANDIDATES,
  MESHIO_READ_EXTENSIONS,
  MESHIO_READER_KEYS,
  MESHIO_WRITER_KEYS,
  MESHIO_WRITE_FORMAT,
  MESHIO_TO_VTK_TYPE,
  VTK_TO_MESHIO_TYPE,
  meshioSiblingNames,
} from "../parser/meshioFormats";
import {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
  EXPORT_MENU_GROUPS,
  NATIVE_EXPORT_EXTENSIONS,
} from "../parser/writers/exportFormats";

/** out/test/ -> repo root, the same walk pyRuntime.ts uses. */
function packageJson(): any {
  const p = path.join(__dirname, "..", "..", "package.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

test("customEditor selectors match SUPPORTED_MESH_EXTENSIONS", () => {
  const pkg = packageJson();
  const editor = pkg.contributes.customEditors.find(
    (e: any) => e.viewType === "kratos.vtkPreview"
  );
  assert.ok(editor, "kratos.vtkPreview custom editor is declared");
  const patterns: string[] = editor.selector.map((s: any) => s.filenamePattern);
  // activationEvents is [] — these selectors are what activate the extension,
  // so a format missing here simply never opens.
  const fromPkg = patterns.map((p) => p.replace(/^\*/, ""));
  assert.deepEqual(sorted(fromPkg), sorted(SUPPORTED_MESH_EXTENSIONS));
});

test("both menu when-clauses match SUPPORTED_MESH_EXTENSIONS", () => {
  const pkg = packageJson();
  const clauses: string[] = [];
  for (const group of ["editor/title", "explorer/context"]) {
    for (const item of pkg.contributes.menus[group] ?? []) {
      if (item.command === "kratos.vtk.openPreview") clauses.push(item.when);
    }
  }
  assert.equal(clauses.length, 2, "editor/title + explorer/context both present");
  for (const when of clauses) {
    const m = /\/\^\\\.\(([^)]+)\)\$\/i/.exec(when);
    assert.ok(m, `when-clause carries an extension alternation: ${when}`);
    const exts = m[1].split("|").map((e) => `.${e}`);
    assert.deepEqual(sorted(exts), sorted(SUPPORTED_MESH_EXTENSIONS));
  }
});

test("SUPPORTED_MESH_EXTENSIONS is exactly its three parts, no duplicates", () => {
  const parts = [...TIMELINE_EXTENSIONS, ...STATIC_EXTENSIONS, ...MESHIO_EXTENSIONS];
  assert.deepEqual(sorted(SUPPORTED_MESH_EXTENSIONS), sorted(parts));
  assert.equal(
    new Set(SUPPORTED_MESH_EXTENSIONS).size,
    SUPPORTED_MESH_EXTENSIONS.length,
    "no extension is claimed twice"
  );
});

test("meshio++ is additive: it never claims an extension we parse natively", () => {
  // The invariant behind the whole design — our parsers carry things meshio++
  // drops (OBJ g/o groups, PLY vertex fields, VTK timeline/multiblock).
  const native = new Set([...TIMELINE_EXTENSIONS, ...STATIC_EXTENSIONS]);
  const overlap = MESHIO_READ_EXTENSIONS.filter((e) => native.has(e));
  assert.deepEqual(overlap, []);
  assert.ok(!MESHIO_READ_EXTENSIONS.includes(".mdpa"), "mdpa stays ours");
});

test("EXPORT_FORMAT_LABELS is exhaustive and every label is non-empty", () => {
  for (const ext of EXPORTABLE_EXTENSIONS) {
    const label = EXPORT_FORMAT_LABELS[ext];
    assert.ok(label && label.length > 0, `${ext} has a label`);
  }
  assert.deepEqual(
    sorted(Object.keys(EXPORT_FORMAT_LABELS)),
    sorted(EXPORTABLE_EXTENSIONS)
  );
});

test("EXPORTABLE_EXTENSIONS is native + meshio, with no duplicates", () => {
  assert.deepEqual(
    sorted(EXPORTABLE_EXTENSIONS),
    sorted([...NATIVE_EXPORT_EXTENSIONS, ...MESHIO_EXPORT_EXTENSIONS])
  );
  assert.equal(new Set(EXPORTABLE_EXTENSIONS).size, EXPORTABLE_EXTENSIONS.length);
});

test("MESHIO_WRITE_FORMAT keys match MESHIO_EXPORT_EXTENSIONS", () => {
  assert.deepEqual(sorted(Object.keys(MESHIO_WRITE_FORMAT)), sorted(MESHIO_EXPORT_EXTENSIONS));
});

test("every meshio write target is a real writer key", () => {
  for (const [ext, key] of Object.entries(MESHIO_WRITE_FORMAT)) {
    assert.ok(MESHIO_WRITER_KEYS.includes(key), `${ext} -> "${key}" is a writer`);
  }
});

test("every read candidate is a real reader key, default first", () => {
  for (const [ext, keys] of Object.entries(MESHIO_READ_CANDIDATES)) {
    assert.ok(keys.length > 0, `${ext} has at least one candidate`);
    for (const key of keys) {
      assert.ok(MESHIO_READER_KEYS.includes(key), `${ext} -> "${key}" is a reader`);
    }
    assert.equal(new Set(keys).size, keys.length, `${ext} candidates are distinct`);
  }
  // The two extensions meshio++ cannot disambiguate; defaults per
  // js_bindings.cpp's extension_defaults().
  assert.equal(MESHIO_READ_CANDIDATES[".msh"][0], "gmsh");
  assert.equal(MESHIO_READ_CANDIDATES[".inp"][0], "abaqus");
});

test("write-excluded formats stay excluded, for the documented reasons", () => {
  // dolfin's writer is tri/tet-only and drops all field data; tetgen and
  // ensight each write a PAIR of files, which a single-path write cannot express.
  assert.ok(!(".xml" in MESHIO_WRITE_FORMAT), "dolfin .xml is read-only for us");
  assert.ok(!(".ele" in MESHIO_WRITE_FORMAT), "tetgen .ele is read-only for us");
  assert.ok(!(".node" in MESHIO_WRITE_FORMAT), "tetgen .node is read-only for us");
  assert.ok(!(".case" in MESHIO_WRITE_FORMAT), "ensight .case is read-only for us");
  assert.ok(!(".geo" in MESHIO_WRITE_FORMAT), "ensight .geo is read-only for us");
  // .vtp has our own native writer, so meshio++'s is not routed through here.
  assert.ok(!(".vtp" in MESHIO_WRITE_FORMAT), "vtp stays ours");
  // openfoam is directory-based and read-only: no extension maps to it.
  assert.ok(!MESHIO_WRITER_KEYS.includes("openfoam"));
  assert.ok(MESHIO_READER_KEYS.includes("openfoam"));
  for (const keys of Object.values(MESHIO_READ_CANDIDATES)) {
    assert.ok(!keys.includes("openfoam"));
  }
});

test("EXPORT_MENU_GROUPS only lists exportable extensions, none twice", () => {
  const seen = new Set<string>();
  for (const group of EXPORT_MENU_GROUPS) {
    for (const ext of group.extensions) {
      assert.ok(
        (EXPORTABLE_EXTENSIONS as readonly string[]).includes(ext),
        `${ext} (in "${group.label}") is exportable`
      );
      assert.ok(!seen.has(ext), `${ext} appears in only one group`);
      seen.add(ext);
    }
  }
});

test("the meshio <-> VTK cell type maps are consistent inverses", () => {
  for (const [name, vtk] of Object.entries(MESHIO_TO_VTK_TYPE)) {
    assert.equal(VTK_TO_MESHIO_TYPE[vtk], name, `${name} <-> ${vtk} round-trips`);
  }
  assert.equal(
    new Set(Object.values(MESHIO_TO_VTK_TYPE)).size,
    Object.keys(MESHIO_TO_VTK_TYPE).length,
    "no two meshio types share a VTK id (the inverse would be lossy)"
  );
});

test("meshioSiblingNames pairs multi-file formats and nothing else", () => {
  assert.deepEqual(meshioSiblingNames("t.node", ".node"), ["t.node", "t.ele"]);
  assert.deepEqual(meshioSiblingNames("t.ele", ".ele"), ["t.node", "t.ele"]);
  // stem = path minus its LAST dot, per tetgen.cpp's node_ele_paths().
  assert.deepEqual(meshioSiblingNames("bunny.1.ele", ".ele"), ["bunny.1.node", "bunny.1.ele"]);
  // ensight .case needs its .geo geometry sibling (and vice versa is harmless).
  assert.deepEqual(meshioSiblingNames("m.case", ".case"), ["m.case", "m.geo"]);
  assert.deepEqual(meshioSiblingNames("m.geo", ".geo"), ["m.case", "m.geo"]);
  // a triangle .poly may defer its vertices to a sibling .node.
  assert.deepEqual(meshioSiblingNames("p.poly", ".poly"), ["p.poly", "p.node"]);
  assert.deepEqual(meshioSiblingNames("a.msh", ".msh"), []);
  assert.deepEqual(meshioSiblingNames("a.vtu", ".vtu"), []);
});
