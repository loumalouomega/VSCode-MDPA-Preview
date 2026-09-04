import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { MdpaEditorProvider } from "./mdpaEditorProvider";
import { VtkEditorProvider } from "./vtkEditorProvider";
import { MenuMessage, exportFormats, openMesh } from "./meshExport";
import { TABLE_KINDS } from "./parser/dataTable";
import { loadProblem } from "./problemArchive";
import { PtAction } from "./ptController";
import { resolveKratosInstall } from "./problemtype/kratosEnv";
import { configureMmg } from "./parser/remesh";
import { configureMmgRunner } from "./parser/operations";
import { runMmgInWorker } from "./mmgWorkerClient";
import { FlowgraphController } from "./flowgraphController";
import { RunManager } from "./runManager";
import { registerHomeView } from "./homeView";
import { registerRunTreeView } from "./runTreeView";
import { latestResultFile } from "./problemtype/runCore";
import { TIMELINE_EXTENSIONS } from "./parser/meshFormats";
import { findGroupForFile, groupVtkFiles } from "./parser/vtkFileGroup";
import { showWhatsNewCommand, showWhatsNewIfNeeded } from "./whatsNew";

export function activate(context: vscode.ExtensionContext): void {
  // MMG runs in a worker thread (dist/mmgWorker.js) so the synchronous WASM
  // call never blocks the extension host, progress lines stream live, and the
  // notification's Cancel terminates the thread.
  configureMmgRunner(runMmgInWorker);
  // Fallback wiring for any in-process run: esbuild copies mmg-core.wasm next
  // to the bundle; hand it to the MMG loader directly because its own file
  // lookup breaks once mmg.cjs is bundled. If the copy is missing the loader
  // falls back to its own resolution.
  try {
    configureMmg({
      wasmBinary: fs.readFileSync(path.join(__dirname, "mmg-core.wasm")),
    });
  } catch {
    /* dev layout without the copied wasm */
  }

  // The embedded Flowgraph editor is served by a single shared localhost server,
  // forked on demand and shared across all MDPA panels.
  const flowgraph = new FlowgraphController();
  context.subscriptions.push({ dispose: () => flowgraph.dispose() });

  // The run registry outlives every panel — a solve keeps going when the
  // preview that started it is closed — so it is owned here, exactly like the
  // shared Flowgraph server above.
  const runs = new RunManager(context);
  context.subscriptions.push(runs);
  runs.restore();
  context.subscriptions.push(registerRunTreeView(runs));
  // Entry-point view (Open Mesh File… / Load Problem…); always visible, even
  // with nothing open. Content comes from `viewsWelcome` in package.json.
  context.subscriptions.push(registerHomeView());

  const mdpaProvider = new MdpaEditorProvider(context, flowgraph, runs);
  const vtkProvider = new VtkEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MdpaEditorProvider.viewType,
      mdpaProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),
    vscode.window.registerCustomEditorProvider(
      VtkEditorProvider.viewType,
      vtkProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Post to whichever preview is currently active
  const postToActive = (msg: unknown): void => {
    mdpaProvider.postToActive(msg);
    vtkProvider.postToActive(msg);
  };

  // Route a File-menu action to whichever preview is active (Command-Palette parity).
  const dispatchMenu = (msg: MenuMessage): void => {
    if (mdpaProvider.dispatchMenu(msg) || vtkProvider.dispatchMenu(msg)) return;
    vscode.window.showInformationMessage(
      "Open a mesh preview first to save or export it."
    );
  };

  // Re-read the active preview's file from disk. Applied operations survive and
  // are re-applied to the new contents (see opHistoryCore's rebase).
  const dispatchReload = (): void => {
    if (mdpaProvider.dispatchReload() || vtkProvider.dispatchReload()) return;
    vscode.window.showInformationMessage("Open a mesh preview first to reload it.");
  };

  // Route a case action to the active MDPA preview (problemtypes are MDPA-only).
  const dispatchCase = (action: PtAction): void => {
    if (mdpaProvider.dispatchCase(action)) return;
    vscode.window.showInformationMessage(
      "Open an MDPA preview first to configure and run a Kratos case."
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "kratos.mdpa.openPreview",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showInformationMessage(
            "Open a .mdpa file first, then run Open MDPA Preview."
          );
          return;
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          target,
          MdpaEditorProvider.viewType
        );
      }
    ),
    vscode.commands.registerCommand(
      "kratos.vtk.openPreview",
      async (uri?: vscode.Uri) => {
        // Binary files (.stl, .ply, binary .vtk…) never get an activeTextEditor,
        // so also fall back to the active tab's input URI.
        const target =
          uri ?? vscode.window.activeTextEditor?.document.uri ?? activeTabUri();
        if (!target) {
          vscode.window.showInformationMessage(
            "Open a mesh file first, then run Open VTK Preview."
          );
          return;
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          target,
          VtkEditorProvider.viewType
        );
      }
    ),
    vscode.commands.registerCommand("kratos.mesh.open", () => openMesh()),
    vscode.commands.registerCommand("kratos.mesh.reload", () => dispatchReload()),
    vscode.commands.registerCommand("kratos.mesh.save", () =>
      dispatchMenu({ type: "menuSave" })
    ),
    vscode.commands.registerCommand("kratos.mesh.saveAs", () =>
      dispatchMenu({ type: "menuSaveAs" })
    ),
    vscode.commands.registerCommand("kratos.mesh.export", async () => {
      const pick = await vscode.window.showQuickPick(
        exportFormats().map((f) => ({ label: f.label, description: f.ext, ext: f.ext })),
        { placeHolder: "Export mesh as…" }
      );
      if (pick) dispatchMenu({ type: "menuExport", format: pick.ext });
    }),
    vscode.commands.registerCommand("kratos.mesh.exportSkin", () =>
      dispatchMenu({ type: "menuExportSkin" })
    ),
    vscode.commands.registerCommand("kratos.mesh.exportTable", async () => {
      // The panel carries a kind and a format in its buttons; from the palette
      // both have to be asked for, the way kratos.mesh.export asks for one.
      const kind = await vscode.window.showQuickPick(TABLE_KINDS as string[], {
        placeHolder: "Tabulate which entities?",
      });
      if (!kind) return;
      dispatchMenu({ type: "menuExportTable", kind });
    }),
    vscode.commands.registerCommand("kratos.problem.save", () =>
      dispatchMenu({ type: "menuSaveProblem" })
    ),
    // Load needs no active preview — it opens one from the extracted mesh.
    vscode.commands.registerCommand("kratos.problem.load", () => loadProblem()),
    vscode.commands.registerCommand("kratos.mdpa.resetCamera", () =>
      postToActive({ type: "resetCamera" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.toggleNodeIds", () =>
      postToActive({ type: "toggleNodeIds" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.computeQuality", () =>
      postToActive({ type: "computeQuality" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.fieldVisualization", () =>
      postToActive({ type: "field" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.sphereGlyphs", () =>
      postToActive({ type: "spheres" })
    ),
    // The webview has always handled "beams" and "meshSize"; until these two
    // commands existed nothing posted them, so both panels were reachable only
    // from the Advanced menu while every sibling panel also had a palette entry.
    vscode.commands.registerCommand("kratos.mdpa.beamGlyphs", () =>
      postToActive({ type: "beams" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.meshSize", () =>
      postToActive({ type: "meshSize" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.screenshot", () =>
      postToActive({ type: "takeScreenshot" })
    ),
    vscode.commands.registerCommand("kratos.case.generate", () =>
      dispatchCase("generate")
    ),
    vscode.commands.registerCommand("kratos.case.run", () => dispatchCase("run")),
    vscode.commands.registerCommand("kratos.case.stop", () => dispatchCase("stop")),
    /**
     * Open the newest results for a case folder.
     *
     * Registered but deliberately absent from `contributes.commands`, so it
     * never appears in the palette: it takes arguments and exists only because
     * this is the one place holding both providers. It reveals an already-open
     * preview and jumps it to the last step rather than opening another tab per
     * step, which is what naive `openWith` calls used to do.
     */
    vscode.commands.registerCommand(
      "kratos.vtk.openLatestResults",
      async (caseDir: string, opts?: { excludeNewest?: boolean }) => {
        const outDir = path.join(caseDir, "vtk_output");
        let names: string[] = [];
        try {
          names = await fs.promises.readdir(outDir);
        } catch {
          /* reported below */
        }
        const latest = latestResultFile(names, { excludeNewest: opts?.excludeNewest });
        if (!latest) {
          vscode.window.showInformationMessage(
            "No results in vtk_output/ yet — run the case first (results appear as the solver writes steps)."
          );
          return;
        }
        // Already showing this series? Reveal and jump instead of duplicating.
        const groups = groupVtkFiles(names, TIMELINE_EXTENSIONS);
        for (const open of vtkProvider.openPanelPaths()) {
          if (path.dirname(open) !== outDir) continue;
          if (!findGroupForFile(groups, path.basename(open))) continue;
          if (vtkProvider.revealLatestFrame(open)) return;
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          vscode.Uri.file(path.join(outDir, latest.fileName)),
          "kratos.vtkPreview",
          vscode.ViewColumn.Beside
        );
      }
    ),
    vscode.commands.registerCommand("kratos.case.openResults", () =>
      dispatchCase("openResults")
    ),
    // Point the extension at a custom-compiled Kratos: pick the install root
    // (or a source checkout — bin/<config> is auto-detected), validate it and
    // store it in kratos.installPath. Pip-installed Kratos needs no setting.
    vscode.commands.registerCommand("kratos.case.selectKratosPath", async () => {
      const pick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Use as Kratos install",
        title: "Select the compiled Kratos folder (install root or source checkout)",
      });
      if (!pick || pick.length === 0) return;
      const resolution = resolveKratosInstall(pick[0].fsPath, fs.existsSync, process.platform);
      let chosen = resolution.root;
      if (!chosen) {
        const use = await vscode.window.showWarningMessage(
          resolution.problem ?? "The folder does not look like a Kratos install.",
          { modal: true },
          "Use anyway"
        );
        if (use !== "Use anyway") return;
        chosen = pick[0].fsPath;
      } else if (!resolution.hasLibs) {
        vscode.window.showWarningMessage(
          "The folder has KratosMultiphysics/ but no libs/ — the shared-library path will not be set, so a compiled Kratos may fail to load its native libraries."
        );
      }
      const config = vscode.workspace.getConfiguration("kratos");
      const inWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      const target = inWorkspace
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await config.update("installPath", chosen, target);
      vscode.window.showInformationMessage(
        `kratos.installPath set to "${chosen}" (${inWorkspace ? "workspace" : "user"} settings). ` +
          "Clear the setting to go back to a pip-installed Kratos."
      );
    }),
    vscode.commands.registerCommand("kratos.mdpa.findEntity", async () => {
      const entityType = await vscode.window.showQuickPick(
        ["Node", "Element", "Condition", "Geometry"],
        { placeHolder: "Entity type" }
      );
      if (!entityType) return;
      const raw = await vscode.window.showInputBox({
        prompt: `Enter ${entityType} ID`,
        validateInput: (s) =>
          /^\d+$/.test(s.trim()) ? null : "Must be a positive integer",
      });
      if (raw === undefined) return;
      postToActive({
        type: "locateEntity",
        entityType,
        entityId: Number(raw.trim()),
      });
    }),
    vscode.commands.registerCommand("kratos.mdpa.whatsNew", () =>
      showWhatsNewCommand(context)
    )
  );

  // On startup (onStartupFinished), greet the user with a "What's New" screen
  // when the extension has been upgraded since they last saw it. Fire-and-forget
  // so activation stays synchronous.
  void showWhatsNewIfNeeded(context);
}

/** URI of the active editor tab, whatever editor kind it holds. */
function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputNotebook
  ) {
    return input.uri;
  }
  return undefined;
}

export function deactivate(): void {
  // Nothing to clean up: all disposables are registered on the context.
}
