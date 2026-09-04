/**
 * The standalone, file-less preview — the "Open Empty Preview" action in the
 * Kratos sidebar.
 *
 * It is a LAUNCHER SHELL, not a second editing session. It shows the real
 * chrome over an empty viewport so the extension can be opened with nothing
 * else on screen, and its only working action is File ▸ Open (and Load
 * problem…), which hands off to the ordinary custom editor and then closes the
 * shell — leaving a dead tab sitting behind the real preview would look broken.
 *
 * Making it a full session instead was considered and rejected: each provider's
 * `resolveCustomEditor` is a ~600-line closure over `document.uri.fsPath`
 * (watcher, OperationHistory, opRunner, PtController, flowgraph, timeline
 * state) with no "load a file into this existing panel" entry point to reuse,
 * and there is no integration harness that would catch a regression in it. See
 * doc/roadmap.md's non-goals.
 */

import * as vscode from "vscode";

import { openMesh } from "./meshExport";
import { previewWebviewOptions, renderPreviewHtml } from "./previewHtml";
import { loadProblem } from "./problemArchive";

const VIEW_TYPE = "kratos.emptyPreview";

/** At most one shell at a time — a second would just be another empty viewport. */
let current: vscode.WebviewPanel | undefined;

export function openEmptyPreview(context: vscode.ExtensionContext): void {
  if (current) {
    current.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "Kratos Preview",
    vscode.ViewColumn.Active,
    {
      ...previewWebviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    }
  );
  current = panel;

  panel.webview.html = renderPreviewHtml({
    webview: panel.webview,
    extensionUri: context.extensionUri,
    title: "Kratos Preview",
    theme: context.globalState.get<string>("sceneTheme", "auto"),
    startEmpty: true,
  });

  panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
    if (msg?.type === "setTheme") {
      // The chrome is shared, so the theme picker works here and must persist
      // to the same key every real preview reads.
      const theme = (msg as { theme?: string }).theme;
      if (typeof theme === "string") await context.globalState.update("sceneTheme", theme);
      return;
    }
    if (msg?.type === "menuOpen" || msg?.type === "menuLoadProblem") {
      // Called directly rather than through runMenu, which discards the opened
      // uri — and the uri is the whole point here: a cancelled dialog must
      // leave the shell standing, not close the window the user is looking at.
      const opened =
        msg.type === "menuOpen" ? await openMesh() : await loadProblem();
      if (opened) panel.dispose();
      return;
    }
    if (msg?.type === "ready") return;
    vscode.window.showInformationMessage(
      "Open a mesh first — use File ▸ Open… in this window."
    );
  });

  panel.onDidDispose(() => {
    if (current === panel) current = undefined;
  });
}
