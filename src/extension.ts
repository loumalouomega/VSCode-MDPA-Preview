import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { MdpaEditorProvider } from "./mdpaEditorProvider";
import { VtkEditorProvider } from "./vtkEditorProvider";
import { MenuMessage, exportFormats, openMesh } from "./meshExport";
import { configureMmg } from "./parser/remesh";
import { configureMmgRunner } from "./parser/operations";
import { runMmgInWorker } from "./mmgWorkerClient";

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

  const mdpaProvider = new MdpaEditorProvider(context);
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
    })
  );
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
