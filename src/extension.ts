import * as vscode from "vscode";
import { MdpaEditorProvider } from "./mdpaEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MdpaEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MdpaEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

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
    vscode.commands.registerCommand("kratos.mdpa.resetCamera", () =>
      provider.postToActive({ type: "resetCamera" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.toggleNodeIds", () =>
      provider.postToActive({ type: "toggleNodeIds" })
    ),
    vscode.commands.registerCommand("kratos.mdpa.computeQuality", () =>
      provider.postToActive({ type: "computeQuality" })
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
      provider.postToActive({
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
