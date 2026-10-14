import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { resolveCommandPath, overwriteRefusal } from "../parser/commandPath";
import { parseCommandLine } from "../parser/commandParse";

const base = path.resolve("/tmp/case");
test("relative paths resolve against the mesh folder, absolute ones are kept", () => {
  assert.deepEqual(resolveCommandPath("out/a.vtu", base), { ok: true, path: path.join(base, "out", "a.vtu") });
  const abs = path.resolve("/x/y.vtu");
  assert.deepEqual(resolveCommandPath(abs, base), { ok: true, path: abs });
});
test("an export extension is appended when missing and refused when wrong", () => {
  assert.equal((resolveCommandPath("a", base, { ext: ".vtu" }) as any).path, path.join(base, "a.vtu"));
  assert.equal(resolveCommandPath("a.stl", base, { ext: ".vtu" }).ok, false);
  assert.equal(resolveCommandPath("A.VTU", base, { ext: ".vtu" }).ok, true);
});
test("empty, NUL and folder-like paths are refused with a reason", () => {
  for (const bad of ["", "  ", "a\0b", "dir/", undefined]) {
    const r = resolveCommandPath(bad, base);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason.length > 0);
  }
  assert.match(overwriteRefusal("/x/a.vtu"), /overwrite=true/);
});
test("the command line parses path arguments into the posted message", () => {
  const r: any = parseCommandLine("export vtu to=\"out dir/a.vtu\" overwrite=false");
  const act = (r.actions ?? r.steps ?? [r.action])[0] ?? r;
  const msg = JSON.stringify(r);
  assert.match(msg, /out dir\/a\.vtu/);
  assert.match(msg, /"overwrite":false/);
  assert.match(JSON.stringify(parseCommandLine("open meshes/a.vtu")), /"file":"meshes\/a\.vtu"/);
  void act;
});
