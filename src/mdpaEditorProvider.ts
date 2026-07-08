import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseMdpaFile } from "./parser/mdpaParser";
import { MdpaModel } from "./parser/types";
import { TOOLBAR_ICONS } from "./toolbarIcons";
import { FILE_MENU_HTML, SIDEBAR_HTML } from "./webviewChrome";
import { ExportContext, MenuMessage, runMenu } from "./meshExport";
import { OperationHistory, saveOps, loadOps } from "./opHistory";
import { opRecordFromMessage, isAsyncOp, OP_LABELS } from "./parser/operations";

/** `<span>` wrapping a generated, currentColor-based toolbar icon (see toolbarIcons.ts). */
function icon(id: keyof typeof TOOLBAR_ICONS): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
}

class MdpaDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }
  dispose(): void {}
}

export class MdpaEditorProvider
  implements vscode.CustomReadonlyEditorProvider<MdpaDocument>
{
  public static readonly viewType = "kratos.mdpaPreview";

  private activePanel: vscode.WebviewPanel | undefined;
  /** File-menu handler bound to the active panel (Command-Palette parity). */
  private activeMenuHandler: ((msg: MenuMessage) => void) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public postToActive(message: unknown): void {
    this.activePanel?.webview.postMessage(message);
  }

  /** Runs a File-menu action on the active MDPA preview; false if none active. */
  public dispatchMenu(msg: MenuMessage): boolean {
    if (!this.activeMenuHandler) return false;
    this.activeMenuHandler(msg);
    return true;
  }

  public openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): MdpaDocument {
    return new MdpaDocument(uri);
  }

  public resolveCustomEditor(
    document: MdpaDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    const savedTheme = this.context.globalState.get<string>("sceneTheme", "auto");
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, savedTheme);

    this.activePanel = webviewPanel;

    const fsPath = document.uri.fsPath;
    const fileName = path.basename(fsPath);
    let disposed = false;
    let parseInProgress = false;
    let pendingParse = false;
    let lastModel: MdpaModel | undefined;
    const history = new OperationHistory();

    // Re-render the preview from the current history state, keeping the camera.
    const rerenderFromHistory = async (): Promise<void> => {
      if (disposed || !history.hasBase()) return;
      const cur = await history.current();
      if (disposed) return;
      lastModel = cur.model;
      webviewPanel.webview.postMessage({
        type: "model",
        model: cur.model,
        fileName,
        keepCamera: true,
        midNodes: cur.highlightNodes ?? [],
      });
      webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
    };

    // Apply a newly requested operation; params ride along on the message.
    let opInFlight = false;
    const applyOperation = async (msg: Record<string, unknown>): Promise<void> => {
      if (!history.hasBase() || !lastModel) {
        vscode.window.showWarningMessage("The mesh is still loading; try again.");
        return;
      }
      if (opInFlight) {
        vscode.window.showWarningMessage("An operation is already running; wait for it to finish.");
        return;
      }
      const rec = opRecordFromMessage(msg);
      if (!rec) {
        vscode.window.showWarningMessage("Invalid operation parameters.");
        return;
      }
      opInFlight = true;
      try {
        const outcome = isAsyncOp(rec.op)
          ? await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `${OP_LABELS[rec.op]}…`,
              },
              () => history.applyNew(rec)
            )
          : await history.applyNew(rec);
        if (outcome.message) vscode.window.showInformationMessage(outcome.message);
        if (!outcome.noop) await rerenderFromHistory();
      } finally {
        opInFlight = false;
      }
    };

    const postModel = async (): Promise<void> => {
      if (parseInProgress) {
        pendingParse = true;
        return;
      }
      parseInProgress = true;
      pendingParse = false;
      try {
        const model = await parseMdpaFile(
          fsPath,
          (phase, bytesRead, totalBytes) => {
            if (!disposed) {
              webviewPanel.webview.postMessage({
                type: "progress",
                phase,
                bytesRead,
                totalBytes,
              });
            }
          }
        );
        lastModel = model;
        history.setBase(model);
        if (!disposed) {
          webviewPanel.webview.postMessage({ type: "model", model, fileName });
          webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
        }
      } catch (err) {
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        parseInProgress = false;
        if (pendingParse && !disposed) {
          void postModel();
        }
      }
    };

    // Re-parse when the file changes on disk.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(fsPath), path.basename(fsPath))
    );
    const scheduleReparse = () => {
      if (debounce) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => void postModel(), 500);
    };
    watcher.onDidChange(scheduleReparse);
    watcher.onDidCreate(scheduleReparse);

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
        this.activeMenuHandler = handleMenu;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
        this.activeMenuHandler = undefined;
      }
    });

    // Builds the export context for the File menu; reads source text so a
    // same-format MDPA Save can preserve Properties blocks verbatim.
    const exportCtx = (): ExportContext | undefined => {
      if (!lastModel) {
        vscode.window.showWarningMessage("The mesh is still loading; try again.");
        return undefined;
      }
      let sourceText: string | undefined;
      try {
        sourceText = fs.readFileSync(fsPath, "utf8");
      } catch {
        /* fall back to a lossy write */
      }
      return { model: lastModel, fsPath, sourceText };
    };
    const handleMenu = (msg: MenuMessage): void => {
      void runMenu(msg, exportCtx, this.context);
    };
    this.activeMenuHandler = handleMenu;

    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        void postModel();
      } else if (msg?.type === "setTheme") {
        const valid = ["auto", "dark", "light", "scientific"];
        if (valid.includes(msg.theme)) {
          void this.context.globalState.update("sceneTheme", msg.theme);
        }
      } else if (msg?.type === "screenshot") {
        void saveScreenshot(msg.data as string, fsPath);
      } else if (
        msg?.type === "menuOpen" ||
        msg?.type === "menuSave" ||
        msg?.type === "menuSaveAs" ||
        msg?.type === "menuExport" ||
        msg?.type === "menuExportPart"
      ) {
        handleMenu(msg as MenuMessage);
      } else if (msg?.type === "applyOp") {
        void applyOperation(msg as Record<string, unknown>);
      } else if (msg?.type === "opUndo") {
        history.undo();
        void rerenderFromHistory();
      } else if (msg?.type === "opRedo") {
        history.redo();
        void rerenderFromHistory();
      } else if (msg?.type === "opClear") {
        history.clear();
        void rerenderFromHistory();
      } else if (msg?.type === "opRevertTo") {
        history.revertTo(msg.index as number);
        void rerenderFromHistory();
      } else if (msg?.type === "saveOps") {
        void saveOps(history, fsPath);
      } else if (msg?.type === "loadOps") {
        void (async () => {
          // A loaded recipe replays from scratch and may re-run MMG.
          if (await loadOps(history, fsPath)) {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: "Replaying operations…" },
              () => rerenderFromHistory()
            );
          }
        })();
      }
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      if (debounce) {
        clearTimeout(debounce);
      }
      watcher.dispose();
      viewStateSub.dispose();
      msgSub.dispose();
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      if (this.activeMenuHandler === handleMenu) {
        this.activeMenuHandler = undefined;
      }
    });
  }

  private getHtml(webview: vscode.Webview, savedTheme: string): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", file)
      );
    const scriptUri = mediaUri("webview.js");
    const styleUri = mediaUri("style.css");
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `worker-src blob:`,
      `child-src blob:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>MDPA Preview</title>
</head>
<body data-theme="${savedTheme}">
  <div id="loading">
    <div id="loading-inner">
      <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
      <div id="loading-label">Reading file…</div>
    </div>
  </div>
  <div id="app" style="display:none">
    ${SIDEBAR_HTML}
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
    <div id="viewport">
      ${FILE_MENU_HTML}
      <div id="cut-panel" class="hidden">
        <span style="opacity:0.7;font-size:11px">Axis</span>
        <label><input type="radio" name="cut-axis" value="0"> X</label>
        <label><input type="radio" name="cut-axis" value="1"> Y</label>
        <label><input type="radio" name="cut-axis" value="2" checked> Z</label>
        <button id="cut-flip">Flip</button>
        <input type="range" id="cut-slider" min="0" max="100" value="50" step="0.5">
        <span id="cut-position"></span>
      </div>
      <div id="toolbar">
        <button data-action="reset" title="Reset camera">${icon("reset")} Reset</button>
        <button data-action="pan" title="Toggle pan mode">${icon("pan")} Pan</button>
        <button data-action="cut" title="Toggle clip plane">${icon("cut")} Cut Plane</button>
        <button data-action="wireframe" title="Toggle wireframe">${icon("wireframe")} Wireframe</button>
        <button data-action="nodeIds" title="Toggle node ids">${icon("nodeIds")} Node IDs</button>
        <button data-action="quality" title="Compute mesh quality">${icon("quality")} Quality</button>
        <button data-action="field" title="Visualize field data">${icon("field")} Field</button>
        <button data-action="grid" title="Toggle background grid">${icon("grid")} Grid</button>
        <button data-action="find" title="Find entity by ID">${icon("find")} Find</button>
        <button data-action="screenshot" title="Save screenshot as PNG">${icon("screenshot")}</button>
        <select id="theme-select" title="Scene theme">
          <option value="auto">Auto</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="scientific">Scientific</option>
        </select>
      </div>
      <div id="find-bar">
        <select id="find-type">
          <option>Node</option>
          <option>Element</option>
          <option>Condition</option>
          <option>Geometry</option>
        </select>
        <input id="find-id" type="number" min="1" placeholder="ID" />
        <button id="find-go">Go</button>
        <button id="find-close" title="Close">${icon("close")}</button>
        <span id="find-status"></span>
      </div>
      <div id="render-root"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function saveScreenshot(dataUrl: string, sourceFsPath: string): Promise<void> {
  const stem = path.basename(sourceFsPath, path.extname(sourceFsPath));
  const defaultUri = vscode.Uri.file(
    path.join(path.dirname(sourceFsPath), `${stem}.png`)
  );
  const dest = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { "PNG Image": ["png"] },
    title: "Save Screenshot",
  });
  if (!dest) return;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await require("node:fs").promises.writeFile(dest.fsPath, Buffer.from(base64, "base64"));
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
