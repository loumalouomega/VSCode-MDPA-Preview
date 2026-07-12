import { test } from "node:test";
import assert from "node:assert/strict";

import { computeKratosEnv, defaultPythonPath } from "../problemtype/kratosEnv";

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
