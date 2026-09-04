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

import * as fs from "node:fs";
import * as path from "node:path";

import { isPidAlive, sendCtrlBreak, spawnRun, stopPid } from "../problemtype/runProcess";

const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "run-process-"));
}

/** Waits for a predicate, polling — for facts an event cannot deliver. */
async function until(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

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

// --- logFile / unref: the detached shape the MCP server needs ---------------

test("logFile captures BOTH streams, and onStdout is never called", async () => {
  const dir = tmpDir();
  const log = path.join(dir, "run.log");
  let piped = "";
  const handle = spawnRun({
    argv: [NODE, "-e", "process.stdout.write('to out\\n'); process.stderr.write('to err\\n')"],
    cwd: dir,
    envDelta: {},
    logFile: log,
    // Passed deliberately: with no pipes there is nothing to read, so this must
    // stay silent rather than half-work.
    onStdout: (c) => {
      piped += c;
    },
    onStderr: (c) => {
      piped += c;
    },
  });
  await handle.exited;
  await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("to err"));
  const text = fs.readFileSync(log, "utf8");
  assert.match(text, /to out/);
  assert.match(text, /to err/);
  assert.equal(piped, "", "onStdout/onStderr must not fire when logFile is set");
});

test("logFile APPENDS, so a second run does not erase the first", async () => {
  const dir = tmpDir();
  const log = path.join(dir, "run.log");
  for (const word of ["first", "second"]) {
    const h = spawnRun({
      argv: [NODE, "-e", `process.stdout.write('${word}\\n')`],
      cwd: dir,
      envDelta: {},
      logFile: log,
    });
    await h.exited;
  }
  await until(() => fs.readFileSync(log, "utf8").includes("second"));
  const text = fs.readFileSync(log, "utf8");
  assert.match(text, /first/);
  assert.match(text, /second/);
});

test("a log file that cannot be opened is a spawn-error, not a throw", async () => {
  // A directory is never openable as a file — the portable stand-in for a
  // read-only case folder.
  const dir = tmpDir();
  const handle = spawnRun({
    argv: [NODE, "-e", "0"],
    cwd: dir,
    envDelta: {},
    logFile: dir,
  });
  const exit = await handle.exited;
  assert.equal(exit.reason, "spawn-error");
  assert.match(exit.message ?? "", /log file/i);
  // The degenerate handle must still be safe to call.
  handle.stop();
  handle.kill();
});

test("unref + logFile lets a child outlive the process that spawned it", async (t) => {
  if (process.platform === "win32") {
    t.skip("process-group semantics differ on win32");
    return;
  }
  // The only honest proof: a node child spawns a detached grandchild the same
  // way we do, then exits. If unref/detached/fd do not all hold, the grandchild
  // dies with it and never writes its second line.
  const dir = tmpDir();
  const marker = path.join(dir, "grandchild.txt");
  const runner = path.join(dir, "runner.js");
  // No escape sequences anywhere in the generated source: one stray level of
  // collapsing puts a real newline inside a quoted string and the grandchild
  // dies of a syntax error, which looks exactly like unref not working.
  const grandchild = [
    "process.stdout.write('alive');",
    "setTimeout(function () { process.stdout.write('outlived'); }, 900);",
  ].join(" ");
  fs.writeFileSync(
    runner,
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const fd = fs.openSync(${JSON.stringify(marker)}, "a");`,
      `const c = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], ` +
        '{ detached: true, stdio: ["ignore", fd, fd] });',
      "fs.closeSync(fd);",
      "c.unref();",
      "setTimeout(function () { process.exit(0); }, 100);",
    ].join("\n")
  );
  const parent = spawnRun({ argv: [NODE, runner], cwd: dir, envDelta: {} });
  await parent.exited;
  assert.ok(
    await until(() => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("outlived")),
    "the grandchild must keep running after its spawner exited"
  );
});

// --- stopPid: the ladder for a pid read off disk ----------------------------

test("stopPid on a pid that is already gone reports so without signalling", async () => {
  const sent: string[] = [];
  const outcome = await stopPid(999_999_999, {
    platform: "linux",
    isAlive: () => false,
    signal: (_p, sig) => sent.push(sig),
    sleep: async () => undefined,
  });
  assert.equal(outcome, "already-gone");
  assert.deepEqual(sent, []);
});

test("stopPid stops at the FIRST rung that works", async () => {
  const sent: string[] = [];
  let alive = true;
  const outcome = await stopPid(1234, {
    platform: "linux",
    isAlive: () => alive,
    signal: (_p, sig) => {
      sent.push(sig);
      if (sig === "SIGINT") alive = false; // python honoured the interrupt
    },
    sleep: async () => undefined,
  });
  assert.equal(outcome, "sigint");
  assert.deepEqual(sent, ["SIGINT"], "a process that stops on SIGINT is never SIGTERMed");
});

test("stopPid escalates SIGINT -> SIGTERM -> SIGKILL when ignored", async () => {
  const sent: string[] = [];
  let alive = true;
  const outcome = await stopPid(1234, {
    platform: "linux",
    isAlive: () => alive,
    signal: (_p, sig) => {
      sent.push(sig);
      if (sig === "SIGKILL") alive = false;
    },
    sleep: async () => undefined,
  });
  assert.equal(outcome, "sigkill");
  assert.deepEqual(sent, ["SIGINT", "SIGTERM", "SIGKILL"]);
});

test("stopPid on win32 tries Ctrl+Break first and reports the rung", async () => {
  const sent: string[] = [];
  let alive = true;
  const outcome = await stopPid(1234, {
    platform: "win32",
    isAlive: () => alive,
    signal: (_p, sig) => {
      sent.push(sig);
    },
    sleep: async () => undefined,
    ctrlBreak: (_p) => {
      sent.push("CTRL_BREAK");
      alive = false; // python honoured the break, like SIGINT on posix
      return true;
    },
  });
  assert.equal(outcome, "ctrlbreak");
  assert.deepEqual(sent, ["CTRL_BREAK"], "a process that stops on the break is never killed");
});

test("stopPid on win32 escalates break -> kill when the break is ignored", async () => {
  const sent: string[] = [];
  let alive = true;
  const outcome = await stopPid(1234, {
    platform: "win32",
    isAlive: () => alive,
    signal: (_p, sig) => {
      sent.push(sig);
      if (sig === "SIGKILL") alive = false;
    },
    sleep: async () => undefined,
    ctrlBreak: (_p) => {
      sent.push("CTRL_BREAK");
      return true; // sent, but the process ignored it
    },
  });
  assert.equal(outcome, "sigkill");
  assert.deepEqual(sent, ["CTRL_BREAK", "SIGKILL"]);
});

test("stopPid on win32 falls through to kill when the break cannot be sent", async () => {
  for (const ctrlBreak of [() => false, () => { throw new Error("no console"); }] as const) {
    const sent: string[] = [];
    let alive = true;
    const outcome = await stopPid(1234, {
      platform: "win32",
      isAlive: () => alive,
      signal: (_p, sig) => {
        sent.push(sig);
        alive = false;
      },
      sleep: async () => undefined,
      ctrlBreak,
    });
    assert.equal(outcome, "sigkill");
    assert.deepEqual(sent, ["SIGKILL"], "an unsent break must not strand the stop");
  }
});

test("stopPid really stops a real process", async (t) => {
  if (process.platform === "win32") {
    t.skip("posix signal semantics");
    return;
  }
  const handle = spawnRun({
    argv: [NODE, "-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(),
    envDelta: {},
  });
  const pid = handle.pid!;
  assert.ok(isPidAlive(pid));
  const outcome = await stopPid(pid);
  await handle.exited;
  assert.ok(outcome === "sigint" || outcome === "sigterm" || outcome === "sigkill", outcome);
  assert.equal(isPidAlive(pid), false);
});

// --- sendCtrlBreak: the win32 graceful rung -----------------------------------

test("sendCtrlBreak refuses degenerate pids without spawning anything", async () => {
  assert.equal(await sendCtrlBreak(0), false);
  assert.equal(await sendCtrlBreak(-1), false);
  assert.equal(await sendCtrlBreak(NaN), false);
});

test("sendCtrlBreak fails soft on an undeliverable break", async () => {
  // No such process group on any platform: no powershell here, or the API
  // refusing there. Either way this is false, never a throw — failing soft is
  // the contract the ladder depends on.
  assert.equal(await sendCtrlBreak(999_999_999), false);
});

test("stop() on win32 ends a real python through KeyboardInterrupt, not kill", async (t) => {
  // THE Phase-1 experiment (Tier 1 item 1): runs only on the Windows CI leg.
  // The file header's "never python" guarantee otherwise stands — python is
  // the one runtime whose Ctrl+Break behaviour is the entire question, and
  // setup-python provides it on the leg. If this goes red, the graceful rung
  // does not exist in practice and the item falls back to documented
  // terminate (Phase 2b) rather than shipping an rung that does nothing.
  if (process.platform !== "win32") {
    t.skip("the Ctrl+Break experiment needs a real Windows box");
    return;
  }
  const dir = tmpDir();
  const marker = path.join(dir, "finalized.txt");
  const script = path.join(dir, "solver.py");
  fs.writeFileSync(
    script,
    [
      "import time",
      "try:",
      "    time.sleep(60)",
      "except KeyboardInterrupt:",
      "    pass",
      "finally:",
      `    open(${JSON.stringify(marker)}, "w").write("finalized\\n")`,
      "",
    ].join("\n")
  );
  const handle = spawnRun({ argv: ["python", script], cwd: dir, envDelta: {} });
  // Let the interpreter reach its sleep before stopping it.
  await new Promise((r) => setTimeout(r, 2000));
  handle.stop();
  await handle.exited;
  assert.equal(isPidAlive(handle.pid!), false, "the process must be gone");
  assert.ok(
    await until(() => fs.existsSync(marker)),
    "the finally block ran: this was an interrupt, not a terminate"
  );
});
