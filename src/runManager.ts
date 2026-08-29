/**
 * The run registry: the one place that knows which Kratos solves are in flight.
 *
 * It lives here rather than in `PtController` for a structural reason — a run
 * outlives the panel that started it, while a `PtController` is created per
 * panel and disposed with it. Ownership therefore mirrors `FlowgraphController`
 * exactly: constructed in `extension.ts`, pushed onto `context.subscriptions`,
 * and injected into the provider.
 *
 * Everything decision-shaped lives below the vscode line in
 * `problemtype/runCore.ts` / `runFile.ts` / `runProcess.ts`, which are
 * unit-tested. This file is deliberately plumbing: registry bookkeeping, Output
 * channels, a `vtk_output/` watcher and one change event.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  LaunchMode,
  RunRecord,
  caseKeyFor,
  displayCommand,
  isLive,
  latestResultFile,
} from "./problemtype/runCore";
import { runFilePath, runLogPath } from "./problemtype/caseFile";
import { parseRunJson, reconcileStatus, serializeRun, sidecarFromRecord } from "./problemtype/runFile";
import { RunHandle, isPidAlive, spawnRun, stopPid } from "./problemtype/runProcess";

/** Mesh paths this window has ever launched from — the pointer set restore()
 *  walks. The sidecar file is the truth; this is only how we find it. */
const SIDECAR_INDEX_KEY = "kratos.runSidecars";

/** Keep a bounded tail of output in memory for the row tooltip. */
const TAIL_LINES = 500;

export interface RunRequest {
  meshFsPath: string;
  caseDir: string;
  stem: string;
  python: string;
  /** computeKratosEnv's DELTA — runProcess spreads process.env over it. */
  envDelta: Record<string, string>;
  launchMode: LaunchMode;
  scriptName?: string;
}

interface LiveRun {
  handle?: RunHandle;
  terminal?: vscode.Terminal;
  tail: string[];
}

export class RunManager implements vscode.Disposable {
  private readonly records: RunRecord[] = [];
  private readonly live = new Map<string, LiveRun>();
  private readonly channels = new Map<string, vscode.OutputChannel>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private counter = 0;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): RunRecord[] {
    return [...this.records].reverse(); // newest first
  }

  get(id: string): RunRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** The live run for a case, if any — what a panel's status line reflects. */
  activeFor(caseKey: string): RunRecord | undefined {
    return [...this.records].reverse().find((r) => r.caseKey === caseKey && isLive(r));
  }

  /** The most recent run for a case, live or not. */
  latestFor(caseKey: string): RunRecord | undefined {
    return [...this.records].reverse().find((r) => r.caseKey === caseKey);
  }

  /** Live runs sharing a directory — they share ProjectParameters.json. */
  liveInDir(caseDir: string): RunRecord[] {
    return this.records.filter((r) => r.caseDir === caseDir && isLive(r));
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(req: RunRequest): Promise<RunRecord | undefined> {
    const meshFsPath = path.resolve(req.meshFsPath);
    const caseKey = caseKeyFor(meshFsPath, process.platform);
    const script = req.scriptName ?? "MainKratos.py";

    // Same case already running: generating has just overwritten the files it
    // is reading, so offer to replace it rather than race.
    const mine = this.activeFor(caseKey);
    if (mine) {
      const choice = await vscode.window.showWarningMessage(
        `A run for "${req.stem}" is already active. Its case files have just been regenerated underneath it.`,
        { modal: true },
        "Stop and restart"
      );
      if (choice !== "Stop and restart") return undefined;
      await this.stop(mine.id);
    }
    // A run this session did not start — the MCP server's `case_run`. It is not
    // in the registry, so without this check we would overwrite its sidecar and
    // destroy the only record of its pid, leaving it running, invisible and
    // unstoppable.
    const foreign = this.foreignLiveRun(req.meshFsPath);
    if (foreign) {
      const who = foreign.launchedBy === "mcp" ? "an MCP client" : "another window";
      const choice = await vscode.window.showWarningMessage(
        `A run for "${req.stem}" started by ${who} may still be active` +
          `${foreign.pid !== undefined ? ` (pid ${foreign.pid})` : ""}. ` +
          `Starting another will replace its status record.`,
        { modal: true },
        "Run anyway"
      );
      if (choice !== "Run anyway") return undefined;
    }
    // A DIFFERENT case in the same folder: they share ProjectParameters.json,
    // MainKratos.py and vtk_output/. Name it rather than silently interleave.
    const neighbours = this.liveInDir(req.caseDir).filter((r) => r.caseKey !== caseKey);
    if (neighbours.length > 0) {
      const names = neighbours.map((r) => r.stem).join(", ");
      const choice = await vscode.window.showWarningMessage(
        `${names} is already running in this folder. Both cases share ProjectParameters.json, MainKratos.py and vtk_output/.`,
        "Run anyway",
        "Cancel"
      );
      if (choice !== "Run anyway") return undefined;
    }

    const argv = [req.python, script];
    const record: RunRecord = {
      id: `${Date.now().toString(36)}-${++this.counter}`,
      caseKey,
      meshFsPath,
      caseDir: req.caseDir,
      stem: req.stem,
      argv,
      launchMode: req.launchMode,
      startedAt: Date.now(),
      status: "starting",
    };
    this.records.push(record);
    this.rememberSidecar(meshFsPath);

    if (req.launchMode === "terminal") this.startInTerminal(record, req);
    else this.startSpawned(record, req);

    this.watchOutput(record);
    this.changed();
    return record;
  }

  private startSpawned(record: RunRecord, req: RunRequest): void {
    const channel = this.channelFor(record);
    channel.appendLine(`\n=== ${new Date(record.startedAt).toLocaleString()} — ${displayCommand(record.argv, process.platform)}`);
    channel.appendLine(`    cwd: ${record.caseDir}`);
    const state: LiveRun = { tail: [] };
    this.live.set(record.id, state);

    const append = (chunk: string): void => {
      channel.append(chunk);
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        state.tail.push(line);
        if (state.tail.length > TAIL_LINES) state.tail.shift();
        record.progress = { ...record.progress, lastLine: line };
      }
    };

    // Opt-out: a detached child survives the window, so it must not be killed.
    const detached = !this.stopOnWindowClose();
    const handle = spawnRun({
      argv: record.argv,
      cwd: record.caseDir,
      envDelta: req.envDelta,
      detached,
      onStdout: append,
      onStderr: append,
    });
    state.handle = handle;
    record.pid = handle.pid;
    record.status = "running";
    this.writeSidecar(record);
    this.changed();

    void handle.exited.then((exit) => {
      record.endedAt = Date.now();
      record.exitCode = exit.exitCode;
      record.signal = exit.signal;
      if (exit.reason === "spawn-error") {
        record.status = "failed";
        // The most common real failure is a wrong kratos.pythonPath; keeping
        // the OS message is what makes it diagnosable from the row.
        record.message = `Could not start ${record.argv[0]}: ${exit.message ?? "unknown error"}`;
        channel.appendLine(`\n[failed to start] ${record.message}`);
      } else if (record.stopRequested || this.sidecarStopRequested(record)) {
        // The latch, not the exit code: a run the user stopped must never wear
        // a failure badge.
        record.status = "cancelled";
        record.message = "Stopped. Results already written to vtk_output/ are kept; the final step may be incomplete.";
        channel.appendLine(`\n[stopped]`);
      } else if (exit.exitCode === 0) {
        record.status = "finished";
        channel.appendLine(`\n[finished] exit 0`);
      } else {
        record.status = "failed";
        record.message = exit.signal
          ? `Ended on signal ${exit.signal}.`
          : `Exited with code ${exit.exitCode}.`;
        channel.appendLine(`\n[failed] ${record.message}`);
      }
      this.live.delete(record.id);
      this.writeSidecar(record);
      this.refreshProgress(record);
      this.changed();
    });
  }

  /**
   * Terminal mode: still registered so it appears in the view, but marked
   * `detached` because a terminal cannot tell us when the solver exits.
   */
  private startInTerminal(record: RunRecord, req: RunRequest): void {
    const name = `Kratos: ${record.stem}`;
    const terminal = vscode.window.createTerminal({
      name,
      cwd: record.caseDir,
      env: req.envDelta,
    });
    terminal.show();
    terminal.sendText(displayCommand(record.argv, process.platform));
    // The handle is KEPT this time — the old code looked terminals up by name
    // globally, which collided across directories.
    this.live.set(record.id, { terminal, tail: [] });
    record.status = "detached";
    record.message = `Running in terminal "${name}" — status is not tracked in this mode.`;
    this.writeSidecar(record);
  }

  async stop(id: string): Promise<void> {
    const record = this.get(id);
    if (!record || !isLive(record)) return;
    // Latch BEFORE signalling so the exit handler can tell a deliberate stop
    // from a crash.
    record.stopRequested = true;
    const state = this.live.get(id);
    if (state?.handle) {
      // Persist the latch before signalling, not just in memory: another
      // process (the MCP server's case_status) may read this file while the
      // stop is in flight, and it is the only record of intent that survives a
      // window reload.
      this.writeSidecar(record);
      state.handle.stop();
      return;
    }
    if (state?.terminal) {
      state.terminal.dispose();
      this.live.delete(id);
      record.status = "cancelled";
      record.endedAt = Date.now();
      record.message = "The terminal was disposed; the process may have survived it.";
      this.writeSidecar(record);
      this.changed();
      return;
    }
    // Adopted from a sidecar: we have a pid but no handle. Use the same ladder
    // RunHandle.stop uses — this used to SIGKILL immediately, which threw away
    // the SIGINT rung that lets python close its last result file cleanly.
    this.writeSidecar(record);
    if (record.pid !== undefined) await stopPid(record.pid);
    record.status = "cancelled";
    record.endedAt = Date.now();
    this.writeSidecar(record);
    this.changed();
  }

  /** Synchronous, for dispose() — which cannot await, so there is no ladder. */
  private stopAll(): void {
    for (const record of this.records) {
      if (!isLive(record)) continue;
      const state = this.live.get(record.id);
      if (state?.handle) {
        record.status = "orphaned";
        record.message = "The window was closed or reloaded while this run was active.";
        record.endedAt = Date.now();
        this.writeSidecar(record);
        state.handle.kill();
      }
    }
  }

  remove(id: string): void {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return;
    const [record] = this.records.splice(i, 1);
    this.disposeWatcher(record.id);
    this.changed();
  }

  clearFinished(): void {
    for (const record of [...this.records]) {
      if (!isLive(record)) this.remove(record.id);
    }
  }

  showLog(id: string): void {
    const record = this.get(id);
    if (!record) return;
    const channel = this.channels.get(record.caseKey);
    if (channel) {
      channel.show(true);
      return;
    }
    // A detached/adopted run tees to a file rather than a channel.
    const log = runLogPath(record.meshFsPath);
    if (fs.existsSync(log)) {
      void vscode.window.showTextDocument(vscode.Uri.file(log), { preview: true });
      return;
    }
    vscode.window.showInformationMessage(`No captured output for "${record.stem}".`);
  }

  // ---- progress -----------------------------------------------------------

  /**
   * Progress comes from `vtk_output/`, never from parsing solver stdout: the
   * generated MainKratos.py prints nothing of its own, every line is upstream
   * Kratos Logger in a format we do not control, and its flush is time-based
   * (10 s) so a parsed bar would stall then jump. The directory listing works
   * identically for a spawned run, a terminal run and an adopted orphan.
   */
  private watchOutput(record: RunRecord): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(record.caseDir, "vtk_output/*")
    );
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (debounce) clearTimeout(debounce);
      // 500 ms, matching the VTK preview's own watcher: a solver writing a
      // burst of step files must not trigger a readdir per file.
      debounce = setTimeout(() => {
        this.refreshProgress(record);
        this.changed();
      }, 500);
    };
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    this.watchers.set(record.id, watcher);
    this.refreshProgress(record);
  }

  private refreshProgress(record: RunRecord): void {
    const outDir = path.join(record.caseDir, "vtk_output");
    let names: string[] = [];
    try {
      names = fs.readdirSync(outDir);
    } catch {
      return;
    }
    const latest = latestResultFile(names);
    record.progress = {
      ...record.progress,
      fileCount: names.length,
      stepLabel: latest?.step,
    };
  }

  private disposeWatcher(id: string): void {
    this.watchers.get(id)?.dispose();
    this.watchers.delete(id);
  }

  // ---- sidecar ------------------------------------------------------------

  private stopOnWindowClose(): boolean {
    return vscode.workspace.getConfiguration("kratos").get<boolean>("run.stopOnWindowClose", true);
  }

  private rememberSidecar(meshFsPath: string): void {
    const seen = this.context.workspaceState.get<string[]>(SIDECAR_INDEX_KEY, []);
    if (seen.includes(meshFsPath)) return;
    void this.context.workspaceState.update(SIDECAR_INDEX_KEY, [...seen, meshFsPath]);
  }

  /**
   * Did somebody else ask this run to stop?
   *
   * Read at exit, because a stop issued from OUTSIDE this process (the MCP
   * `case_stop` tool) can only leave its intent on disk. Without this the exit
   * handler would classify a deliberate stop as `failed`.
   */
  private sidecarStopRequested(record: RunRecord): boolean {
    try {
      const { sidecar } = parseRunJson(fs.readFileSync(runFilePath(record.meshFsPath), "utf8"));
      return sidecar?.runId === record.id && sidecar.stopRequested === true;
    } catch {
      return false;
    }
  }

  /**
   * A live run recorded on disk that this session knows nothing about — i.e.
   * one the MCP server started.
   *
   * `activeFor`/`liveInDir` only consult the in-memory registry, so without
   * this an editor-side run would silently overwrite an MCP run's sidecar and
   * destroy the only record of its pid, leaving it invisible and unstoppable.
   */
  private foreignLiveRun(meshFsPath: string): { pid?: number; launchedBy: string } | undefined {
    try {
      const { sidecar } = parseRunJson(fs.readFileSync(runFilePath(meshFsPath), "utf8"));
      if (!sidecar) return undefined;
      if (this.records.some((r) => r.id === sidecar.runId)) return undefined;
      const alive = sidecar.pid !== undefined ? isPidAlive(sidecar.pid) : undefined;
      const { status } = reconcileStatus(sidecar, alive);
      if (status !== "detached") return undefined;
      return { ...(sidecar.pid !== undefined ? { pid: sidecar.pid } : {}), launchedBy: sidecar.launchedBy };
    } catch {
      return undefined;
    }
  }

  private writeSidecar(record: RunRecord): void {
    try {
      fs.writeFileSync(
        runFilePath(record.meshFsPath),
        serializeRun(sidecarFromRecord(record, "extension"))
      );
    } catch {
      // A read-only folder must not break the run itself.
    }
  }

  /**
   * Re-read what this window launched before it was reloaded.
   *
   * Nothing is ever adopted as `running`: `reconcileStatus` downgrades a live
   * pid to `detached` because pids are reused, so liveness is a maybe.
   */
  restore(): void {
    const seen = this.context.workspaceState.get<string[]>(SIDECAR_INDEX_KEY, []);
    for (const meshFsPath of seen) {
      let text: string;
      try {
        text = fs.readFileSync(runFilePath(meshFsPath), "utf8");
      } catch {
        continue;
      }
      const { sidecar } = parseRunJson(text);
      if (!sidecar) continue;
      const alive = sidecar.pid !== undefined ? isPidAlive(sidecar.pid) : undefined;
      const { status, message } = reconcileStatus(sidecar, alive);
      const record: RunRecord = {
        id: `restored-${sidecar.runId}`,
        caseKey: caseKeyFor(path.resolve(meshFsPath), process.platform),
        meshFsPath,
        caseDir: path.dirname(meshFsPath),
        stem: sidecar.stem || path.basename(meshFsPath),
        argv: sidecar.argv,
        launchMode: sidecar.launchMode,
        startedAt: sidecar.startedAt,
        status,
        message,
        ...(sidecar.pid !== undefined ? { pid: sidecar.pid } : {}),
        ...(sidecar.endedAt !== undefined ? { endedAt: sidecar.endedAt } : {}),
        ...(sidecar.exitCode !== undefined ? { exitCode: sidecar.exitCode } : {}),
      };
      this.records.push(record);
      this.refreshProgress(record);
    }
    if (this.records.length > 0) this.changed();
  }

  // ---- plumbing -----------------------------------------------------------

  /** One channel per CASE, reused across runs: VS Code lists every channel in
   *  the Output dropdown forever, so one per run would accumulate. */
  private channelFor(record: RunRecord): vscode.OutputChannel {
    let channel = this.channels.get(record.caseKey);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`Kratos Run: ${record.stem}`);
      this.channels.set(record.caseKey, channel);
    }
    return channel;
  }

  private changed(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "kratos.hasRuns",
      this.records.length > 0
    );
    this.emitter.fire();
  }

  dispose(): void {
    this.stopAll();
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    for (const c of this.channels.values()) c.dispose();
    this.channels.clear();
    this.emitter.dispose();
  }
}
