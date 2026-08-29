/**
 * Host-side glue for the Problemtype sidebar section: one instance per mdpa
 * preview panel. Owns the problemtype catalog (built-ins + workspace-authored
 * JS/Python definitions), persists the user's case setup to
 * `<stem>.kratoscase.json` next to the mdpa, generates the case files
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
import { CaseState, ProblemtypeRuntime, ProblemtypeSource } from "./problemtype/types";
import { BUILTIN_PROBLEMTYPES } from "./problemtype/builtins";
import { generateCase, resolveDomainSize } from "./problemtype/generate";
import { flattenValues, resolveMeshNaming } from "./problemtype/api";
import { adaptMeshNames } from "./problemtype/meshAdapt";
import { writeMdpa } from "./parser/writers/mdpaWriter";
import { caseFilePath, parseCaseJson, serializeCase } from "./problemtype/caseFile";
import { computeKratosEnv, defaultPythonPath, resolveKratosInstall } from "./problemtype/kratosEnv";

export type PtAction = "generate" | "run" | "openResults";

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

  constructor(
    mdpaFsPath: string,
    private readonly getModel: () => MdpaModel | undefined,
    private readonly post: (msg: unknown) => void
  ) {
    this.fsPath = mdpaFsPath;
    this.stem = path.basename(mdpaFsPath, path.extname(mdpaFsPath));
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
      // Adapt element/condition block names to what the solver expects: when
      // anything differs, a <stem>_case.mdpa copy is written (the original
      // mesh stays untouched) and input_filename points at it.
      const scratch: string[] = []; // generateCase re-reports these warnings
      const domainSize = resolveDomainSize(runtime, model, scratch);
      const bases = resolveMeshNaming(runtime.decl, flattenValues(runtime.decl, state), domainSize);
      const adapted = adaptMeshNames(model, bases, domainSize);
      let caseModel = model;
      let caseStem = this.stem;
      const files: string[] = [];
      if (adapted.renames.length > 0) {
        caseModel = adapted.model;
        caseStem = `${this.stem}_case`;
        let sourceText: string | undefined;
        try {
          sourceText = fs.readFileSync(this.fsPath, "utf8"); // Properties survive verbatim
        } catch {
          /* lossy write without the source text */
        }
        fs.writeFileSync(
          path.join(this.caseDir, `${caseStem}.mdpa`),
          writeMdpa(caseModel, { sourceText })
        );
        files.push(`${caseStem}.mdpa`);
        const summary = adapted.renames.map((r) => `${r.from} → ${r.to}`).join(", ");
        vscode.window.showInformationMessage(
          `Mesh adapted for ${runtime.decl.name} (${caseStem}.mdpa): ${summary}`
        );
      }
      const out = await generateCase(runtime, caseModel, state, caseStem);
      const ppPath = path.join(this.caseDir, "ProjectParameters.json");
      fs.writeFileSync(ppPath, out.projectParameters);
      fs.writeFileSync(path.join(this.caseDir, out.materialsFileName), out.materials);
      fs.writeFileSync(path.join(this.caseDir, "MainKratos.py"), out.mainScript);
      files.push("ProjectParameters.json", out.materialsFileName, "MainKratos.py");
      this.post({ type: "ptStatus", kind: "generated", files });
      const allWarnings = [...adapted.warnings, ...out.warnings];
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

  /** Generates the case files, then runs MainKratos.py in an integrated terminal. */
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
    const env = computeKratosEnv({
      platform: process.platform,
      installPath,
      extraEnv: config.get<Record<string, string>>("extraEnv", {}),
      base: process.env,
    });
    const name = `Kratos: ${this.stem}`;
    // A fresh terminal per run: the old one may hold a finished/stuck process
    // and createTerminal env vars only apply at creation time.
    vscode.window.terminals.find((t) => t.name === name)?.dispose();
    const terminal = vscode.window.createTerminal({ name, cwd: this.caseDir, env });
    terminal.show();
    terminal.sendText(`${python} MainKratos.py`);
    this.post({ type: "ptStatus", kind: "running", message: name });
  }

  /** Opens the first vtk_output result in the VTK preview (timeline follows). */
  private async openResults(): Promise<void> {
    const outDir = path.join(this.caseDir, "vtk_output");
    let names: string[] = [];
    try {
      names = fs.readdirSync(outDir).filter((n) => /\.(vtk|vtu|vtp|vtm)$/i.test(n));
    } catch {
      /* handled below */
    }
    if (names.length === 0) {
      vscode.window.showInformationMessage(
        "No results in vtk_output/ yet — run the case first (results appear as the solver writes steps)."
      );
      return;
    }
    names.sort();
    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(path.join(outDir, names[0])),
      "kratos.vtkPreview",
      vscode.ViewColumn.Beside
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
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
