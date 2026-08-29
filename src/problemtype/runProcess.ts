/**
 * The spawn core: starting a Kratos run and reporting how it ended.
 *
 * No vscode import, so it is unit-testable (and so the MCP server could reuse
 * it if `case_run` is ever added). The VS Code glue — the registry, the Output
 * channel, the tree — lives in `src/runManager.ts`.
 *
 * Why spawn rather than a terminal: this exists to report STATUS, and a
 * terminal cannot. `onDidCloseTerminal` fires when the terminal closes, not
 * when the solver exits, so the ordinary case (solver finishes, user leaves the
 * terminal open to read the log) yields no signal at all. Shell integration is
 * better but explicitly best-effort — `exitCode` may be `undefined` and it may
 * never activate, exactly in the Remote-SSH/WSL/conda setups Kratos runs in.
 * spawn gives a guaranteed exit code, a real pid, a real output stream, and
 * cancellation — and, because argv is an array with `shell: false`, it also
 * fixes the quoting bug a string-interpolated command had with any python path
 * containing a space.
 */

import { ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface SpawnRunOptions {
  argv: string[];
  cwd: string;
  /**
   * The DELTA from `computeKratosEnv` — not a whole environment. It is spread
   * over `process.env` here, which is the entire reason this wrapper exists:
   * passing that delta straight to spawn would give the child no PATH and no
   * HOME, and python would never start.
   */
  envDelta: Record<string, string>;
  /** Detached runs survive the extension host; see RunManager.dispose. */
  detached?: boolean;
  /**
   * Append stdout AND stderr straight to this file instead of piping them.
   *
   * The path rather than a file descriptor deliberately: whoever opens the fd
   * must close it, and the correct moment is "once spawn has dup'd it" — a
   * boundary a caller cannot see, and one the synchronous-throw path below
   * returns past, leaking it. Owning the open here also means a log that
   * cannot be created (a read-only case dir) arrives through the existing
   * `spawn-error` channel with a message, instead of throwing at the call site.
   *
   * **`onStdout`/`onStderr` are never called when this is set** — there are no
   * pipes to read. For a detached run the log file IS the output.
   *
   * Opened for APPEND, matching the Output channel's "one per case, reused
   * across runs" lifetime.
   */
  logFile?: string;
  /**
   * Drop the child from this process's event loop so the parent can exit while
   * it runs on.
   *
   * Only effective together with `logFile`: the stdio pipes are themselves
   * ref'd handles, so `child.unref()` alone would still hold the loop open.
   * Deliberately NOT implied by `detached` — the extension sets that too (when
   * `kratos.run.stopOnWindowClose` is false) and means only "do not kill this
   * on window close", not "let it outlive us".
   */
  unref?: boolean;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
}

export type RunExitReason = "exit" | "signal" | "spawn-error";

export interface RunExit {
  reason: RunExitReason;
  exitCode: number | null;
  signal: string | null;
  /** Set when the process could not be started at all (e.g. a wrong python). */
  message?: string;
}

export interface RunHandle {
  pid?: number;
  /** Resolves exactly once, however the process ended. */
  readonly exited: Promise<RunExit>;
  /**
   * Ask it to stop. On posix this escalates SIGINT → SIGTERM → SIGKILL: python
   * turns SIGINT into KeyboardInterrupt, so finalizers run and the last result
   * file is closed rather than truncated. On Windows signals are not real and
   * this is an immediate terminate — callers should say so rather than imply a
   * graceful stop.
   */
  stop(): void;
  /** Immediate, ungraceful — used when the window is closing and we cannot wait. */
  kill(): void;
}

/** How long to wait at each rung of the stop ladder. */
export const STOP_SIGINT_MS = 5000;
export const STOP_SIGTERM_MS = 2000;

export function spawnRun(opts: SpawnRunOptions, platform: string = process.platform): RunHandle {
  const [command, ...args] = opts.argv;
  let child: ChildProcess;
  let settled = false;
  let resolveExit!: (value: RunExit) => void;
  const exited = new Promise<RunExit>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (value: RunExit): void => {
    if (settled) return;
    settled = true;
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    resolveExit(value);
  };
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  // Opened here, closed here — see SpawnRunOptions.logFile. A failure to open
  // is a failure to start, so it takes the same channel a bad python does.
  let logFd: number | undefined;
  if (opts.logFile !== undefined) {
    try {
      logFd = openSync(opts.logFile, "a");
    } catch (err) {
      finish({
        reason: "spawn-error",
        exitCode: null,
        signal: null,
        message: `Could not open the log file ${opts.logFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return { exited, stop: () => undefined, kill: () => undefined };
    }
  }
  // The parent's copy is surplus the moment spawn has dup'd it into the child.
  const closeLog = (): void => {
    if (logFd === undefined) return;
    try {
      closeSync(logFd);
    } catch {
      /* already gone */
    }
    logFd = undefined;
  };

  try {
    child = spawn(command, args, {
      cwd: opts.cwd,
      // The spread is the point — see SpawnRunOptions.envDelta.
      env: { ...process.env, ...opts.envDelta },
      // Never a shell: argv stays an array, so a path with spaces works and
      // nothing in it can be interpreted as shell syntax.
      shell: false,
      detached: opts.detached === true,
      // One fd for both slots, which is what reproduces the single `append`
      // the Output channel gets for stdout and stderr alike.
      stdio: logFd !== undefined ? ["ignore", logFd, logFd] : ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // spawn can throw synchronously for a malformed command.
    finish({
      reason: "spawn-error",
      exitCode: null,
      signal: null,
      message: err instanceof Error ? err.message : String(err),
    });
    closeLog();
    return { exited, stop: () => undefined, kill: () => undefined };
  }
  closeLog();
  if (opts.unref === true) child.unref();

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  if (opts.onStdout) child.stdout?.on("data", (c: string) => opts.onStdout?.(c));
  if (opts.onStderr) child.stderr?.on("data", (c: string) => opts.onStderr?.(c));

  // A failure to start (ENOENT on a wrong pythonPath) arrives here, not as an
  // exit — and it is the single most common real failure, so it must carry a
  // message rather than a bare code.
  child.on("error", (err) => {
    finish({
      reason: "spawn-error",
      exitCode: null,
      signal: null,
      message: err instanceof Error ? err.message : String(err),
    });
  });

  child.on("exit", (code, signal) => {
    finish({
      reason: signal ? "signal" : "exit",
      exitCode: code,
      signal: signal ?? null,
    });
  });

  const signalChild = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };

  return {
    get pid(): number | undefined {
      return child.pid;
    },
    exited,
    stop(): void {
      if (settled) return;
      if (platform === "win32") {
        // No real signals here; this is TerminateProcess either way.
        signalChild("SIGKILL");
        return;
      }
      signalChild("SIGINT");
      termTimer = setTimeout(() => {
        if (!settled) signalChild("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) signalChild("SIGKILL");
        }, STOP_SIGTERM_MS);
      }, STOP_SIGINT_MS);
    },
    kill(): void {
      if (settled) return;
      signalChild("SIGKILL");
    },
  };
}

/** Which rung of the ladder the process actually stopped on. */
export type StopPidOutcome = "already-gone" | "sigint" | "sigterm" | "sigkill" | "alive";

export interface StopPidDeps {
  platform?: string;
  isAlive?(pid: number): boolean;
  signal?(pid: number, sig: NodeJS.Signals): void;
  sleep?(ms: number): Promise<void>;
}

/** How often to re-check between rungs. */
const STOP_POLL_MS = 250;

/**
 * The cross-process counterpart of `RunHandle.stop`, for a pid read off disk.
 *
 * `RunHandle.stop` can fire and forget because it has an exit event to settle
 * it. This has none, so it must POLL between rungs — which is also what lets it
 * return early, and lets it report which signal actually worked.
 *
 * The escalation matters and is not ceremony: SIGINT is what python turns into
 * `KeyboardInterrupt`, so finalizers run and the last result file is closed
 * rather than truncated. `RunManager`'s adopted-run branch used to skip it and
 * SIGKILL immediately; both callers now share this ladder so the two cannot
 * drift.
 *
 * **On Windows there is no graceful rung at all** — signals are not real and
 * this is a single TerminateProcess. Callers must say so rather than imply a
 * clean shutdown they cannot deliver.
 *
 * The deps are injectable so the escalation is testable without waiting 7 s.
 */
export async function stopPid(pid: number, deps: StopPidDeps = {}): Promise<StopPidOutcome> {
  const platform = deps.platform ?? process.platform;
  const alive = deps.isAlive ?? isPidAlive;
  const send = deps.signal ?? ((p: number, sig: NodeJS.Signals) => process.kill(p, sig));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!alive(pid)) return "already-gone";

  const signal = (sig: NodeJS.Signals): boolean => {
    try {
      send(pid, sig);
      return true;
    } catch {
      // ESRCH — it died between the probe and the signal, which is a success.
      return false;
    }
  };

  if (platform === "win32") {
    signal("SIGKILL");
    await sleep(STOP_POLL_MS);
    return alive(pid) ? "alive" : "sigkill";
  }

  const waitFor = async (ms: number): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += STOP_POLL_MS) {
      await sleep(STOP_POLL_MS);
      if (!alive(pid)) return true;
    }
    return false;
  };

  signal("SIGINT");
  if (await waitFor(STOP_SIGINT_MS)) return "sigint";
  signal("SIGTERM");
  if (await waitFor(STOP_SIGTERM_MS)) return "sigterm";
  signal("SIGKILL");
  await sleep(STOP_POLL_MS);
  return alive(pid) ? "alive" : "sigkill";
}

/**
 * Is a pid alive? Signal 0 performs the permission/existence check without
 * delivering anything.
 *
 * The answer is a MAYBE, not a yes: pids are reused, so a true result cannot
 * prove the process is the one recorded. `reconcileStatus` is what turns this
 * into the deliberately hedged `detached` status rather than `running`.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
