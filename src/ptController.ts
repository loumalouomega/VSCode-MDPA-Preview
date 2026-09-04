/**
 * Host-side glue for the Problemtype sidebar section: one instance per mesh
 * preview panel (MDPA or any other mesh format). Owns the problemtype catalog
 * (built-ins + workspace-authored JS/Python definitions), persists the user's
 * case setup to `<stem>.kratoscase.json` next to the mesh, generates the case files
 * (ProjectParameters.json, the materials file, MainKratos.py) and launches the
 * run in an integrated terminal with the configured Kratos environment.
 *
 * The pure generation core lives in src/problemtype/ — this module is the only
 * problemtype file allowed to import vscode.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { MdpaModel } from "./parser/types";
import { meshExtname, meshStem } from "./parser/meshFormats";
import { CaseState, ProblemtypeRuntime, ProblemtypeSource } from "./problemtype/types";
import { BUILTIN_PROBLEMTYPES } from "./problemtype/builtins";
import { generateCase } from "./problemtype/generate";
import { planCaseMesh } from "./problemtype/caseMesh";
import { writeMdpa } from "./parser/writers/mdpaWriter";
import { caseFilePath, parseCaseJson, serializeCase } from "./problemtype/caseFile";
import { RunManager } from "./runManager";
import { caseKeyFor, isLive } from "./problemtype/runCore";
import { computeKratosEnv, defaultPythonPath, resolveKratosInstall } from "./problemtype/kratosEnv";

export type PtAction = "generate" | "run" | "stop" | "openResults";

/** A catalog entry the webview can render (decl only; hooks stay host-side). */
interface CatalogEntry {
  runtime?: ProblemtypeRuntime;
  source: ProblemtypeSource;
  /** Set when a workspace problemtype failed to load (shown disabled). */
  error?: string;
  fileName?: string;
}

export class PtController {
  private readonly fsPath: string;
  private readonly stem: string;
  private catalog: CatalogEntry[] = [];
  private state: CaseState | undefined;
  private saveDebounce: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private readonly subs: vscode.Disposable[] = [];

  constructor(
    meshFsPath: string,
    private readonly getModel: () => MdpaModel | undefined,
    private readonly post: (msg: unknown) => void,
    private readonly runs: RunManager
  ) {
    this.fsPath = meshFsPath;
    // meshStem, not basename+extname: the latter yields `case.post` for a
    // `case.post.msh` source and the next join would double the suffix.
    this.stem = meshStem(meshFsPath);
    // A run outlives this controller, so the status line is driven by the
    // registry's event rather than by whatever run() happened to start.
    this.subs.push(this.runs.onDidChange(() => this.postRunStatus()));
  }

  /** This case's identity in the registry. */
  private get caseKey(): string {
    return caseKeyFor(path.resolve(this.fsPath), process.platform);
  }

  /**
   * Reflects the registry into the sidebar — but only for THIS mesh. A run
   * started from another mesh in the same folder is real and shares the case
   * files, yet this panel can neither stop it nor speak for it; the run view is
   * where cross-case runs are visible.
   */
  private postRunStatus(): void {
    if (this.disposed) return;
    const record = this.runs.latestFor(this.caseKey);
    if (!record) return;
    const running = isLive(record);
    this.post({
      type: "ptStatus",
      kind: record.status,
      running,
      runId: record.id,
      message: record.message,
      step: record.progress?.stepLabel,
      files: record.progress?.fileCount,
      exitCode: record.exitCode,
    });
  }

  private get caseDir(): string {
    return path.dirname(this.fsPath);
  }

  private get caseFilePath(): string {
    return caseFilePath(this.fsPath);
  }

  /** Loads built-ins + workspace problemtypes and posts catalog + saved case. */
  async refresh(): Promise<void> {
    this.catalog = BUILTIN_PROBLEMTYPES.map((runtime) => ({ runtime, source: runtime.source }));
    this.catalog.push(...(await this.discoverExternal()));
    if (this.disposed) return;
    this.post({
      type: "ptCatalog",
      problemtypes: this.catalog.map((e) => ({
        decl: e.runtime?.decl,
        source: e.source,
        error: e.error,
        fileName: e.fileName,
      })),
    });
    this.sendCase();
  }

  /** Workspace-authored problemtypes (.kratos/problemtypes/*.{js,py} + extraPaths). */
  private async discoverExternal(): Promise<CatalogEntry[]> {
    const config = vscode.workspace.getConfiguration("kratos");
    const dirs = config.get<string[]>("problemtypes.extraPaths", [".kratos/problemtypes"]);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const files: string[] = [];
    for (const root of roots) {
      for (const dir of dirs) {
        const abs = path.isAbsolute(dir) ? dir : path.join(root, dir);
        let names: string[];
        try {
          names = fs.readdirSync(abs);
        } catch {
          continue; // directory doesn't exist — nothing to load
        }
        for (const name of names) {
          if (name.endsWith(".js") || name.endsWith(".py")) files.push(path.join(abs, name));
        }
      }
    }
    const entries: CatalogEntry[] = [];
    for (const file of files) {
      const source: ProblemtypeSource = file.endsWith(".py") ? "py" : "js";
      try {
        entries.push(...(await loadExternalFile(file, source)));
      } catch (err) {
        entries.push({
          source,
          error: err instanceof Error ? err.message : String(err),
          fileName: path.basename(file),
        });
      }
    }
    return entries;
  }

  /** Restores the saved case (if any) and posts it to the webview. */
  private sendCase(): void {
    let state: CaseState | undefined;
    try {
      const text = fs.readFileSync(this.caseFilePath, "utf8");
      const parsed = parseCaseJson(text);
      state = parsed.state;
      if (parsed.warnings.length > 0) {
        vscode.window.showWarningMessage(
          `Case file ${path.basename(this.caseFilePath)}: ${parsed.warnings.join(" ")}`
        );
      }
    } catch {
      /* no case file yet */
    }
    this.state = state;
    this.post({ type: "ptCase", state });
  }

  /** Handles a webview `ptState` message: keep + persist (debounced). */
  onState(state: CaseState): void {
    this.state = state;
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
    this.saveDebounce = setTimeout(() => {
      try {
        fs.writeFileSync(this.caseFilePath, serializeCase(state));
      } catch (err) {
        vscode.window.showWarningMessage(
          `Could not save the case file: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, 500);
  }

  /** Routes a palette command / webview button to its handler. */
  dispatch(action: PtAction): void {
    if (action === "generate") void this.generate(true);
    else if (action === "run") void this.run();
    else if (action === "stop") void this.stopRun();
    else void this.openResults();
  }

  private runtimeFor(state: CaseState): ProblemtypeRuntime | undefined {
    return this.catalog.find((e) => e.runtime?.decl.id === state.problemtypeId)?.runtime;
  }

  /**
   * Computes the current case's ProjectParameters.json text WITHOUT touching
   * disk — used to seed the embedded Flowgraph editor (case → flowgraph). Returns
   * undefined when the mesh/case/runtime aren't ready or generation throws.
   */
  async getProjectParametersJson(): Promise<string | undefined> {
    const model = this.getModel();
    const state = this.state;
    if (!model || !state) return undefined;
    const runtime = this.runtimeFor(state);
    if (!runtime) return undefined;
    try {
      const out = await generateCase(runtime, model, state, this.stem);
      return out.projectParameters;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes a ProjectParameters.json produced by the embedded Flowgraph editor
   * back next to the mdpa (flowgraph → case) and reveals it. The JSON is parsed
   * to validate + normalize before writing.
   */
  async applyExternalProjectParameters(json: string): Promise<void> {
    try {
      const pretty = JSON.stringify(JSON.parse(json), null, 2);
      const ppPath = path.join(this.caseDir, "ProjectParameters.json");
      fs.writeFileSync(ppPath, pretty);
      this.post({ type: "ptStatus", kind: "generated", files: ["ProjectParameters.json"] });
      const doc = await vscode.workspace.openTextDocument(ppPath);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "ptStatus", kind: "error", message: `Flowgraph import failed: ${message}` });
    }
  }

  /** Generates + writes the three case files; returns false on failure. */
  private async generate(reveal: boolean): Promise<boolean> {
    const model = this.getModel();
    const state = this.state;
    if (!model) {
      vscode.window.showWarningMessage("The mesh is still loading; try again.");
      return false;
    }
    if (!state) {
      vscode.window.showWarningMessage("Configure a problemtype in the sidebar first.");
      return false;
    }
    const runtime = this.runtimeFor(state);
    if (!runtime) {
      vscode.window.showWarningMessage(`Unknown problemtype "${state.problemtypeId}".`);
      return false;
    }
    try {
      // The solver reads an .mdpa file: an .mdpa source is referenced directly
      // unless the mesh-name adaptation renames a block, while any other
      // source is always converted — see planCaseMesh.
      const isMdpaSource = meshExtname(this.fsPath) === ".mdpa";
      const plan = planCaseMesh(runtime, model, state, this.stem, isMdpaSource);
      const caseModel = plan.caseModel;
      const files: string[] = [];
      if (plan.shouldWriteMesh) {
        let sourceText: string | undefined;
        if (isMdpaSource) {
          try {
            sourceText = fs.readFileSync(this.fsPath, "utf8"); // Properties survive verbatim
          } catch {
            /* lossy write without the source text */
          }
        }
        fs.writeFileSync(
          path.join(this.caseDir, `${plan.caseStem}.mdpa`),
          writeMdpa(caseModel, { sourceText })
        );
        files.push(`${plan.caseStem}.mdpa`);
        if (plan.renames.length > 0) {
          const summary = plan.renames.map((r) => `${r.from} → ${r.to}`).join(", ");
          vscode.window.showInformationMessage(
            `Mesh adapted for ${runtime.decl.name} (${plan.caseStem}.mdpa): ${summary}`
          );
        } else {
          vscode.window.showInformationMessage(
            `Mesh converted for ${runtime.decl.name} (${plan.caseStem}.mdpa); the source file stays untouched.`
          );
        }
      }
      const out = await generateCase(runtime, caseModel, state, plan.caseStem);
      const ppPath = path.join(this.caseDir, "ProjectParameters.json");
      fs.writeFileSync(ppPath, out.projectParameters);
      fs.writeFileSync(path.join(this.caseDir, out.materialsFileName), out.materials);
      fs.writeFileSync(path.join(this.caseDir, "MainKratos.py"), out.mainScript);
      files.push("ProjectParameters.json", out.materialsFileName, "MainKratos.py");
      this.post({ type: "ptStatus", kind: "generated", files });
      const allWarnings = [...plan.warnings, ...out.warnings];
      if (allWarnings.length > 0) {
        vscode.window.showWarningMessage(`Case generated with warnings: ${allWarnings.join(" ")}`);
      }
      if (reveal) {
        const doc = await vscode.workspace.openTextDocument(ppPath);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "ptStatus", kind: "error", message });
      vscode.window.showErrorMessage(`Case generation failed: ${message}`);
      return false;
    }
  }

  /** Generates the case files, then hands the launch to the run registry. */
  private async run(): Promise<void> {
    if (!(await this.generate(false))) return;
    const config = vscode.workspace.getConfiguration("kratos");
    const python =
      config.get<string>("pythonPath", "") || defaultPythonPath(process.platform);
    // A configured install may be the folder itself or a source checkout whose
    // build lives in bin/<config> — resolve to the dir carrying
    // KratosMultiphysics/. An unrecognizable folder still runs (custom
    // layouts), just with a warning.
    let installPath = config.get<string>("installPath", "");
    if (installPath) {
      const resolution = resolveKratosInstall(installPath, fs.existsSync, process.platform);
      if (resolution.root) {
        installPath = resolution.root;
      } else {
        vscode.window.showWarningMessage(
          `kratos.installPath: ${resolution.problem} Running with the folder as-is.`
        );
      }
    }
    const envDelta = computeKratosEnv({
      platform: process.platform,
      installPath,
      extraEnv: config.get<Record<string, string>>("extraEnv", {}),
      base: process.env,
    });
    const launchMode =
      config.get<string>("run.launchMode", "output") === "terminal" ? "terminal" : "output";
    await this.runs.start({
      meshFsPath: this.fsPath,
      caseDir: this.caseDir,
      stem: this.stem,
      python,
      envDelta,
      launchMode,
    });
  }

  /** Stops this case's active run, if it has one. */
  private async stopRun(): Promise<void> {
    const record = this.runs.activeFor(this.caseKey);
    if (!record) {
      vscode.window.showInformationMessage(`No active run for "${this.stem}".`);
      return;
    }
    const detail =
      process.platform === "win32"
        ? "Windows has no graceful interrupt, so the solver is terminated immediately."
        : "The solver is interrupted so it can close the file it is writing.";
    const choice = await vscode.window.showWarningMessage(
      `Stop run "${this.stem}"? Results already in vtk_output/ are kept; the final step may be incomplete.`,
      { modal: true, detail },
      "Stop"
    );
    if (choice !== "Stop") return;
    await this.runs.stop(record.id);
  }

  /** Opens the LATEST vtk_output result in the VTK preview. */
  private async openResults(): Promise<void> {
    // This used to sort file names as strings and open names[0] — so it opened
    // the FIRST step, and "_0_10" sorted before "_0_2". The shared command uses
    // the tested latestResultFile instead.
    const record = this.runs.latestFor(this.caseKey);
    await vscode.commands.executeCommand("kratos.vtk.openLatestResults", this.caseDir, {
      excludeNewest: record !== undefined && record.status !== "finished",
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
    for (const sub of this.subs) sub.dispose();
    this.subs.length = 0;
  }
}

/**
 * Loads one workspace problemtype file. JS runs in a node:vm sandbox; Python
 * runs in pyodide. Both are implemented in later phases and imported lazily so
 * a missing runtime never breaks the preview.
 */
async function loadExternalFile(
  file: string,
  source: ProblemtypeSource
): Promise<CatalogEntry[]> {
  if (source === "js") {
    const { loadJsProblemtypes } = await import("./problemtype/jsLoader");
    const code = fs.readFileSync(file, "utf8");
    return loadJsProblemtypes(code, path.basename(file)).map((runtime) => ({
      runtime,
      source,
      fileName: path.basename(file),
    }));
  }
  const { loadPyProblemtypes } = await import("./problemtype/pyRuntime");
  const code = fs.readFileSync(file, "utf8");
  return (await loadPyProblemtypes(code, path.basename(file))).map((runtime) => ({
    runtime,
    source,
    fileName: path.basename(file),
  }));
}
