/**
 * runProcess.ts — the spawn core.
 *
 * These run real child processes, but never Kratos or python: `process.execPath`
 * is node itself, which is guaranteed present, so the whole lifecycle (exit
 * codes, output capture, cancellation, a failed launch) is exercised with no
 * solver and no new dependency.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import test from "node:test";

import { isPidAlive, spawnRun } from "../problemtype/runProcess";

const NODE = process.execPath;

test("a run reports its exit code and its output", async () => {
  let out = "";
  const handle = spawnRun({
    argv: [NODE, "-e", "process.stdout.write('hello from the solver'); process.exit(3)"],
    cwd: os.tmpdir(),
    envDelta: {},
    onStdout: (c) => {
      out += c;
    },
  });
  const exit = await handle.exited;
  assert.equal(exit.reason, "exit");
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.signal, null);
  assert.match(out, /hello from the solver/);
});

test("a successful run reports exit code 0, not a falsy nothing", async () => {
  const handle = spawnRun({
    argv: [NODE, "-e", "process.exit(0)"],
    cwd: os.tmpdir(),
    envDelta: {},
  });
  const exit = await handle.exited;
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.reason, "exit");
});

test("stderr is captured separately from stdout", async () => {
  let out = "";
  let err = "";
  const handle = spawnRun({
    argv: [NODE, "-e", "process.stdout.write('O'); process.stderr.write('E'); process.exit(0)"],
    cwd: os.tmpdir(),
    envDelta: {},
    onStdout: (c) => { out += c; },
    onStderr: (c) => { err += c; },
  });
  await handle.exited;
  assert.equal(out, "O");
  assert.equal(err, "E");
});

test("the env delta is spread over process.env, not substituted for it", async () => {
  // The hazard this whole wrapper exists for: computeKratosEnv returns a DELTA,
  // and a child given only that delta would have no PATH at all.
  let out = "";
  const handle = spawnRun({
    argv: [
      NODE,
      "-e",
      "process.stdout.write(JSON.stringify({extra: process.env.KRATOS_TEST_VAR, inherited: Boolean(process.env.PATH)}))",
    ],
    cwd: os.tmpdir(),
    envDelta: { KRATOS_TEST_VAR: "set-by-delta" },
    onStdout: (c) => { out += c; },
  });
  await handle.exited;
  const seen = JSON.parse(out) as { extra: string; inherited: boolean };
  assert.equal(seen.extra, "set-by-delta", "the delta reaches the child");
  assert.equal(seen.inherited, true, "and the inherited environment survives");
});

test("a launch failure is reported with a message, not a bare code", async () => {
  const handle = spawnRun({
    argv: ["definitely-not-a-real-python-binary-xyz", "MainKratos.py"],
    cwd: os.tmpdir(),
    envDelta: {},
  });
  const exit = await handle.exited;
  assert.equal(exit.reason, "spawn-error");
  assert.equal(exit.exitCode, null);
  // A wrong kratos.pythonPath is the most common real failure, so the message
  // has to survive to the run row rather than being an anonymous non-zero exit.
  assert.ok(exit.message && exit.message.length > 0, "carries the OS error");
  assert.match(exit.message, /ENOENT|not.*found|spawn/i);
});

test("stop() ends a long-running process, and reports the signal", async (t) => {
  if (process.platform === "win32") t.skip("posix signal semantics");
  const handle = spawnRun({
    // Holds the loop open indefinitely without spinning the CPU.
    argv: [NODE, "-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(),
    envDelta: {},
  });
  assert.ok(handle.pid && handle.pid > 0, "a real pid is available while running");
  handle.stop();
  const exit = await handle.exited;
  // Node with no SIGINT handler dies from the signal; either shape is a stop,
  // and the caller's own stopRequested latch is what makes it read "cancelled"
  // rather than "failed".
  assert.ok(exit.reason === "signal" || exit.reason === "exit");
  assert.notEqual(exit.exitCode, 0);
});

test("kill() is immediate, for a window that is closing", async (t) => {
  if (process.platform === "win32") t.skip("posix signal semantics");
  const handle = spawnRun({
    argv: [NODE, "-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(),
    envDelta: {},
  });
  handle.kill();
  const exit = await handle.exited;
  assert.equal(exit.signal, "SIGKILL");
});

test("exited resolves once, whatever happens after", async () => {
  const handle = spawnRun({
    argv: [NODE, "-e", "process.exit(0)"],
    cwd: os.tmpdir(),
    envDelta: {},
  });
  const first = await handle.exited;
  handle.stop();
  handle.kill();
  const second = await handle.exited;
  assert.deepEqual(first, second, "the settled result never changes");
});

test("isPidAlive answers for this process and denies a free pid", () => {
  assert.equal(isPidAlive(process.pid), true);
  // Very high pids are beyond the default max on Linux and macOS.
  assert.equal(isPidAlive(0x7ffffff0), false);
});
