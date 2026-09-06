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
import { registerRunTreeView } from "./runTreeView";
import { RecentMeshStore } from "./recentMeshes";
import { registerSidebarViews } from "./sidebarViews";
import { openEmptyPreview } from "./emptyPreview";
import { MENU_ACTION_COMMANDS } from "./webviewChrome";
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
  // forked on demand and shared across all mesh preview panels.
  const flowgraph = new FlowgraphController();
  context.subscriptions.push({ dispose: () => flowgraph.dispose() });

  // The run registry outlives every panel — a solve keeps going when the
  // preview that started it is closed — so it is owned here, exactly like the
  // shared Flowgraph server above.
  const runs = new RunManager(context);
  context.subscriptions.push(runs);
  runs.restore();
  context.subscriptions.push(registerRunTreeView(runs));

  // The Kratos activity-bar container's content: the welcome buttons and the
  // recent-mesh list, both reachable with no file open at all. The store is
  // injected into the providers, which are the one choke point every route to
  // opening a mesh already passes through.
  const recents = new RecentMeshStore(context);
  context.subscriptions.push(recents);
  recents.syncContext();
  context.subscriptions.push(registerSidebarViews(recents));

  const mdpaProvider = new MdpaEditorProvider(context, flowgraph, runs, recents);
  const vtkProvider = new VtkEditorProvider(context, flowgraph, runs, recents);

  // `supportsMultipleEditorsPerDocument: false` is load-bearing, not merely
  // tidy: both providers publish ONE hooks object per document (see
  // meshDocument.ts) for the save/revert/backup lifecycle, so a second panel on
  // the same document would overwrite the first's hooks and strand its edits.
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

  // Post to whichever preview is currently active. Short-circuiting rather than
  // calling both: at most one preview is the active editor at a time, since
  // each provider clears its own handle when its panel deactivates.
  const postToActive = (msg: unknown): boolean =>
    mdpaProvider.postToActive(msg) || vtkProvider.postToActive(msg);

  const previewIsOpen = (): boolean =>
    mdpaProvider.hasActivePanel() || vtkProvider.hasActivePanel();

  /**
   * Post to the active preview, or say why nothing happened.
   *
   * The panel and camera commands used to drop the message on the floor — a
   * `?.` on a handle that was undefined — so from a cold window they produced
   * no panel, no error and no clue, while every sibling `dispatch*` path
   * already explained itself. `what` completes "Open a mesh preview first to …".
   */
  const postOrExplain = (msg: unknown, what: string): void => {
    if (postToActive(msg)) return;
    vscode.window.showInformationMessage(`Open a mesh preview first to ${what}.`);
  };

  // Save the active preview THROUGH VS Code, so the dirty marker it set is the
  // one that gets cleared; a direct call to saveMesh would write the file and
  // leave the tab looking permanently unsaved.
  const dispatchSave = (): void => {
    if (mdpaProvider.dispatchSave() || vtkProvider.dispatchSave()) return;
    vscode.window.showInformationMessage("Open a mesh preview first to save it.");
  };

  // Undo/redo the active preview's edit history. The webview cannot do this
  // itself: its keydown handler returns early on any modifier, so Ctrl+Z has to
  // arrive as a keybinding gated on activeCustomEditorId, exactly like Ctrl+S.
  const dispatchHistory = (action: "undo" | "redo"): void => {
    if (mdpaProvider.dispatchHistory(action) || vtkProvider.dispatchHistory(action)) return;
    vscode.window.showInformationMessage(
      `Open a mesh preview first to ${action} a mesh operation.`
    );
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

  // Route a case action to the active mesh preview (any format: non-.mdpa
  // sources generate through a converted <stem>_case.mdpa — see caseMesh.ts).
  const dispatchCase = (action: PtAction): void => {
    if (mdpaProvider.dispatchCase(action) || vtkProvider.dispatchCase(action)) return;
    vscode.window.showInformationMessage(
      "Open a mesh preview first to configure and run a Kratos case."
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
    // Needs no file and no active panel: it opens the chrome over an empty
    // viewport so the extension is usable from a cold window.
    vscode.commands.registerCommand("kratos.preview.openEmpty", () =>
      openEmptyPreview(context)
    ),
    vscode.commands.registerCommand("kratos.mesh.reload", () => dispatchReload()),
    vscode.commands.registerCommand("kratos.mesh.save", () => dispatchSave()),
    // Save As keeps the extension's own dialog rather than deferring to
    // saveCustomDocumentAs: ours falls back to .vtu for a source format with no
    // writer, refuses an OpenFOAM case whose "same path" would rewrite the
    // polyMesh being read, and does not swap the editor for a new file — which
    // VS Code's own Save As does, taking the edit history with it.
    vscode.commands.registerCommand("kratos.mesh.saveAs", () =>
      dispatchMenu({ type: "menuSaveAs" })
    ),
    vscode.commands.registerCommand("kratos.mesh.undo", () => dispatchHistory("undo")),
    vscode.commands.registerCommand("kratos.mesh.redo", () => dispatchHistory("redo")),
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
      postOrExplain({ type: "resetCamera" }, "reset its camera")
    ),
    vscode.commands.registerCommand("kratos.mdpa.toggleNodeIds", () =>
      postOrExplain({ type: "toggleNodeIds" }, "toggle node IDs")
    ),
    vscode.commands.registerCommand("kratos.mdpa.computeQuality", () =>
      postOrExplain({ type: "computeQuality" }, "check mesh quality")
    ),
    vscode.commands.registerCommand("kratos.mdpa.fieldVisualization", () =>
      postOrExplain({ type: "field" }, "visualize a field")
    ),
    vscode.commands.registerCommand("kratos.mdpa.sphereGlyphs", () =>
      postOrExplain({ type: "spheres" }, "show sphere elements")
    ),
    // The webview has always handled "beams" and "meshSize"; until these two
    // commands existed nothing posted them, so both panels were reachable only
    // from the Advanced menu while every sibling panel also had a palette entry.
    vscode.commands.registerCommand("kratos.mdpa.beamGlyphs", () =>
      postOrExplain({ type: "beams" }, "show beam elements")
    ),
    vscode.commands.registerCommand("kratos.mdpa.meshSize", () =>
      postOrExplain({ type: "meshSize" }, "inspect mesh size")
    ),
    vscode.commands.registerCommand("kratos.mdpa.screenshot", () =>
      postOrExplain({ type: "takeScreenshot" }, "take a screenshot")
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
      // Checked up front, not at the post site: this command asks two questions
      // before it posts anything, and answering both only to be told nothing
      // happened is worse than the silence it replaces.
      if (!previewIsOpen()) {
        vscode.window.showInformationMessage("Open a mesh preview first to find an entity.");
        return;
      }
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
      postOrExplain(
        { type: "locateEntity", entityType, entityId: Number(raw.trim()) },
        "find an entity"
      );
    }),
    // Advanced/View menu entries that had no palette route at all. They ride
    // the generic `uiAction` message straight into the webview's own
    // dispatchToolbarAction, so each is one line here and one manifest entry.
    ...(
      [
        ["normals", "show face normals"],
        ["integrals", "integrate a field"],
        ["dataTable", "open the data table"],
        ["lighting", "adjust lighting"],
        ["bookmarks", "manage camera bookmarks"],
        ["record", "record the viewport"],
      ] as const
    ).map(([action, what]) =>
      vscode.commands.registerCommand(MENU_ACTION_COMMANDS[action], () =>
        postOrExplain({ type: "uiAction", action }, what)
      )
    ),
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
