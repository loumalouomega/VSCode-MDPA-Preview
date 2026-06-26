import * as vscode from "vscode";
import { MdpaEditorProvider } from "./mdpaEditorProvider";
import { VtkEditorProvider } from "./vtkEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
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
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showInformationMessage(
            "Open a .vtk file first, then run Open VTK Preview."
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

export function deactivate(): void {
  // Nothing to clean up: all disposables are registered on the context.
}
