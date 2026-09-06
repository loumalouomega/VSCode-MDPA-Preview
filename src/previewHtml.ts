/**
 * The vscode half of the preview document: resolves media URIs and the
 * persisted scene theme, then hands plain strings to `buildPreviewHtml`.
 *
 * The split exists so the skeleton itself stays in the vscode-free
 * `webviewChrome.ts` (which the webview bundle and the screenshot harness also
 * import) and can be asserted in a plain Node test — the same core/glue shape as
 * `whatsNewCore.ts`/`whatsNew.ts` and `runCore.ts`/`runTreeView.ts`.
 *
 * Both custom-editor providers and the standalone empty panel go through here,
 * so the chrome cannot drift between them.
 */

import * as vscode from "vscode";

import { buildPreviewHtml, getNonce } from "./webviewChrome";

export interface PreviewHtmlContext {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  /** Browser-tab title — the only difference between the two providers. */
  title: string;
  /** The persisted scene theme (`globalState`'s `sceneTheme`). */
  theme: string;
  /**
   * Read the `kratos.flowgraph.splitOrientation` setting and emit it as a body
   * attribute. MDPA only: the VTK provider and the empty panel cannot host a
   * Flowgraph pane, so for them the attribute is absent rather than defaulted.
   */
  withFlowgraph?: boolean;
  /** Show the chrome immediately with no mesh (the standalone empty panel). */
  startEmpty?: boolean;
}

/** The full `<html>` document for a mesh preview webview. */
export function renderPreviewHtml(ctx: PreviewHtmlContext): string {
  const mediaUri = (file: string): string =>
    ctx.webview
      .asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", file))
      .toString();
  return buildPreviewHtml({
    scriptUri: mediaUri("webview.js"),
    designSystemUri: mediaUri("design-system.css"),
    styleUri: mediaUri("style.css"),
    cspSource: ctx.webview.cspSource,
    nonce: getNonce(),
    title: ctx.title,
    theme: ctx.theme,
    flowgraphOrientation: ctx.withFlowgraph
      ? vscode.workspace
          .getConfiguration("kratos.flowgraph")
          .get<string>("splitOrientation", "horizontal")
      : undefined,
    startEmpty: ctx.startEmpty,
  });
}

/** The webview options every preview panel uses; `media/` is its only root. */
export function previewWebviewOptions(
  extensionUri: vscode.Uri
): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  };
}
