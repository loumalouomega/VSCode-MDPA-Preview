/**
 * The host half of the view sidecar protocol shared by both preview providers:
 * answering `viewLayersLoad`/posting `viewLayers`, and writing `viewLayersSave`.
 *
 * It exists because the same twenty lines were pasted into each provider and
 * every new sidecar key would have had to be threaded through both copies.
 *
 * View-only: nothing here touches history, `lastModel`, the dirty marker or a
 * document change event — it reads and writes the file beside the mesh and
 * nothing else.
 */

import * as vscode from "vscode";

import { loadViewLayers, saveViewLayers } from "./viewLayersIO";
import { serializeViewState } from "./parser/viewState";

/**
 * One instance per panel. Remembers the last warning text it showed so a
 * condition that repeats on every save (a newer-version sidecar refusing each
 * camera move) is reported once instead of toasting continuously.
 */
export class ViewSidecarHost {
  private lastWarning = "";

  constructor(private readonly webview: vscode.Webview) {}

  private warn(warnings: string[]): void {
    if (warnings.length === 0) return;
    const text = `View layers: ${warnings.join(" ")}`;
    if (text === this.lastWarning) return;
    this.lastWarning = text;
    void vscode.window.showWarningMessage(text);
  }

  /** Reads the sidecar for `fsPath` and posts it to the webview. */
  post(fsPath: string): void {
    const { layers, warnings, outline, view, measures } = loadViewLayers(fsPath);
    this.warn(warnings);
    void this.webview.postMessage({
      type: "viewLayers",
      layers,
      outline,
      view: view ? serializeViewState(view) : undefined,
      measures,
    });
  }

  /** Handles a webview `viewLayersSave`. Keys the message omits keep their on-disk value. */
  save(fsPath: string, msg: { layers?: unknown; outline?: unknown; view?: unknown; measures?: unknown }): void {
    this.warn(saveViewLayers(fsPath, msg.layers, msg.outline, msg.view, msg.measures).warnings);
  }
}
