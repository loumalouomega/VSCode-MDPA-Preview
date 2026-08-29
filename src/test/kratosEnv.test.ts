import { test } from "node:test";
import assert from "node:assert/strict";

import { computeKratosEnv, defaultPythonPath, resolveKratosInstall } from "../problemtype/kratosEnv";

test("pip-installed Kratos (no installPath) needs no env", () => {
  assert.deepEqual(computeKratosEnv({ platform: "linux" }), {});
  assert.deepEqual(computeKratosEnv({ platform: "linux", installPath: "" }), {});
});

test("linux: PYTHONPATH + LD_LIBRARY_PATH prepend onto the base env", () => {
  const env = computeKratosEnv({
    platform: "linux",
    installPath: "/opt/kratos/bin/Release/",
    base: { PYTHONPATH: "/existing", LD_LIBRARY_PATH: undefined },
  });
  assert.deepEqual(env, {
    PYTHONPATH: "/opt/kratos/bin/Release:/existing",
    LD_LIBRARY_PATH: "/opt/kratos/bin/Release/libs",
  });
});

test("darwin: uses DYLD_LIBRARY_PATH", () => {
  const env = computeKratosEnv({ platform: "darwin", installPath: "/kratos" });
  assert.equal(env.DYLD_LIBRARY_PATH, "/kratos/libs");
});

test("win32: libs go on PATH with ; delimiter and backslash join", () => {
  const env = computeKratosEnv({
    platform: "win32",
    installPath: "C:\\kratos",
    base: { PATH: "C:\\Windows" },
  });
  assert.deepEqual(env, {
    PYTHONPATH: "C:\\kratos",
    PATH: "C:\\kratos\\libs;C:\\Windows",
  });
});

test("extraEnv overrides verbatim", () => {
  const env = computeKratosEnv({
    platform: "linux",
    installPath: "/kratos",
    extraEnv: { OMP_NUM_THREADS: "4", PYTHONPATH: "/custom" },
  });
  assert.equal(env.OMP_NUM_THREADS, "4");
  assert.equal(env.PYTHONPATH, "/custom");
});

test("defaultPythonPath picks python on windows, python3 elsewhere", () => {
  assert.equal(defaultPythonPath("win32"), "python");
  assert.equal(defaultPythonPath("linux"), "python3");
  assert.equal(defaultPythonPath("darwin"), "python3");
});

test("resolveKratosInstall accepts an install root directly", () => {
  const fsSet = new Set(["/opt/kratos/KratosMultiphysics", "/opt/kratos/libs"]);
  const r = resolveKratosInstall("/opt/kratos/", (p) => fsSet.has(p), "linux");
  assert.equal(r.root, "/opt/kratos");
  assert.equal(r.hasLibs, true);
  assert.equal(r.problem, undefined);
});

test("resolveKratosInstall descends into a source tree's bin/<config>", () => {
  const fsSet = new Set([
    "/home/u/Kratos/bin/Release/KratosMultiphysics",
    "/home/u/Kratos/bin/Release/libs",
  ]);
  const r = resolveKratosInstall("/home/u/Kratos", (p) => fsSet.has(p), "linux");
  assert.equal(r.root, "/home/u/Kratos/bin/Release");
  assert.equal(r.hasLibs, true);
});

test("resolveKratosInstall prefers Release over Debug and reports missing libs", () => {
  const fsSet = new Set([
    "/k/bin/Release/KratosMultiphysics",
    "/k/bin/Debug/KratosMultiphysics",
    "/k/bin/Debug/libs",
  ]);
  const r = resolveKratosInstall("/k", (p) => fsSet.has(p), "linux");
  assert.equal(r.root, "/k/bin/Release");
  assert.equal(r.hasLibs, false);
});

test("resolveKratosInstall rejects a folder with no KratosMultiphysics", () => {
  const r = resolveKratosInstall("/somewhere", () => false, "linux");
  assert.equal(r.root, undefined);
  assert.match(r.problem ?? "", /No KratosMultiphysics/);
});

test("resolveKratosInstall uses backslashes on windows", () => {
  const fsSet = new Set(["C:\\Kratos\\bin\\Release\\KratosMultiphysics"]);
  const r = resolveKratosInstall("C:\\Kratos\\", (p) => fsSet.has(p), "win32");
  assert.equal(r.root, "C:\\Kratos\\bin\\Release");
  assert.equal(r.hasLibs, false);
});

test("computeKratosEnv returns a DELTA, not a whole environment", () => {
  // The empty result is the contract, not an accident: a spawn caller that
  // passes this straight to child_process would hand the child an environment
  // with no PATH at all. It must spread process.env first.
  assert.deepEqual(computeKratosEnv({ platform: "linux" }), {});
  assert.deepEqual(computeKratosEnv({ platform: "win32", base: process.env }), {});
  // With something to say, it says only that — never the inherited variables.
  const withInstall = computeKratosEnv({ platform: "linux", installPath: "/opt/kratos" });
  assert.deepEqual(Object.keys(withInstall).sort(), ["LD_LIBRARY_PATH", "PYTHONPATH"]);
});
