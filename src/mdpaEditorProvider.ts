import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseMdpaFile } from "./parser/mdpaParser";
import { MdpaModel } from "./parser/types";
import { TOOLBAR_ICONS } from "./toolbarIcons";
import {
  ADVANCED_MENU_HTML,
  VIEW_MENU_HTML,
  CUT_PANEL_HTML,
  FLOWGRAPH_PANE_HTML,
  MENUBAR_HTML,
  SIDEBAR_HTML,
  TOOLBAR_HTML,
} from "./webviewChrome";
import { ExportContext, MenuMessage, runMenu, pickMergeMeshFile } from "./meshExport";
import { OperationHistory, replayWithProgress, saveOps, loadOps } from "./opHistory";
import { opRecordFromMessage, isAsyncOp, OP_LABELS, MmgRunOptions } from "./parser/operations";
import { PtController, PtAction } from "./ptController";
import { CaseState } from "./problemtype/types";
import { takePendingOps } from "./problemArchive";
import { FlowgraphController } from "./flowgraphController";

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
  /** Problemtype controller bound to the active panel (Command-Palette parity). */
  private activePtController: PtController | undefined;
  /** Reload handler bound to the active panel (Command-Palette parity). */
  private activeReloadHandler: (() => void) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly flowgraph: FlowgraphController
  ) {}

  public postToActive(message: unknown): void {
    this.activePanel?.webview.postMessage(message);
  }

  /** Re-reads the file from disk on the active preview; false if none active. */
  public dispatchReload(): boolean {
    if (!this.activeReloadHandler) return false;
    this.activeReloadHandler();
    return true;
  }

  /** Runs a File-menu action on the active MDPA preview; false if none active. */
  public dispatchMenu(msg: MenuMessage): boolean {
    if (!this.activeMenuHandler) return false;
    this.activeMenuHandler(msg);
    return true;
  }

  /** Runs a case action (generate/run/open results) on the active preview. */
  public dispatchCase(action: PtAction): boolean {
    if (!this.activePtController) return false;
    this.activePtController.dispatch(action);
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
    /** Reason of a parse that was coalesced behind an in-flight one. */
    let pendingParseReason: "initial" | "reload" = "initial";
    let lastModel: MdpaModel | undefined;
    const history = new OperationHistory();
    const ptController = new PtController(
      fsPath,
      () => lastModel,
      (m) => {
        if (!disposed) void webviewPanel.webview.postMessage(m);
      }
    );
    let ptInitialized = false;

    // Flowgraph editor lifecycle for this panel: acquire the shared server,
    // embed it, seed it with the current case, and release on hide/dispose.
    let flowgraphAcquired = false;
    const startFlowgraph = async (): Promise<void> => {
      try {
        const endpoint = await this.flowgraph.acquire();
        flowgraphAcquired = true;
        if (disposed) {
          this.flowgraph.release();
          flowgraphAcquired = false;
          return;
        }
        void webviewPanel.webview.postMessage({
          type: "flowgraphReady",
          url: endpoint.url,
          origin: endpoint.origin,
        });
        // Seed the graph with the current case's ProjectParameters (case → flowgraph).
        const json = await ptController.getProjectParametersJson();
        if (json && !disposed) {
          void webviewPanel.webview.postMessage({ type: "flowgraphLoadParams", json });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!disposed) {
          void webviewPanel.webview.postMessage({ type: "flowgraphError", message });
        }
      }
    };
    const stopFlowgraph = (): void => {
      if (flowgraphAcquired) {
        this.flowgraph.release();
        flowgraphAcquired = false;
      }
    };

    // Re-render the preview from the current history state, keeping the camera.
    const rerenderFromHistory = async (opts?: MmgRunOptions): Promise<void> => {
      if (disposed || !history.hasBase()) return;
      const cur = await history.current(opts);
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
    // MMG ops stream their state into the sidebar's inline loading bar
    // (`opProgress` messages) and are cancellable via `opCancel` → abort.
    let opInFlight = false;
    let opAbort: AbortController | undefined;
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
      const mmgOp = isAsyncOp(rec.op);
      const postProgress = (running: boolean, message?: string): void => {
        if (!disposed && mmgOp) {
          webviewPanel.webview.postMessage({ type: "opProgress", running, op: rec.op, message });
        }
      };
      opInFlight = true;
      try {
        let outcome;
        if (mmgOp) {
          opAbort = new AbortController();
          postProgress(true, `${OP_LABELS[rec.op]}…`);
          outcome = await history.applyNew(rec, {
            onProgress: (message) => postProgress(true, message),
            signal: opAbort.signal,
          });
        } else {
          outcome = await history.applyNew(rec);
        }
        if (outcome.message) {
          // A noop (rejected/cancelled/no-effect op) changes nothing on screen,
          // so make its explanation stand out.
          if (outcome.noop) vscode.window.showWarningMessage(outcome.message);
          else vscode.window.showInformationMessage(outcome.message);
        }
        if (!outcome.noop) await rerenderFromHistory();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Operation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        opInFlight = false;
        opAbort = undefined;
        postProgress(false);
      }
    };

    // Full-history replay behind a cancellable notification (loaded recipes and
    // Load-problem pending ops replay from scratch and may re-run MMG).
    const replayHistory = (): Thenable<void> => replayWithProgress(rerenderFromHistory);

    /**
     * Re-applies the surviving edit stack onto a freshly parsed base, then
     * re-renders. `reason` distinguishes the FIRST parse of a document (a new
     * base: the stack is empty anyway) from a re-read of the same one, where
     * discarding the stack would silently destroy the user's edits — which is
     * precisely what this used to do on every watcher tick.
     */
    const replayAndPost = (title: string, opts?: { skipAsyncOps?: boolean }): Thenable<void> =>
      replayWithProgress(async (runOpts) => {
        const r = await history.replayOntoBase({ ...runOpts, ...opts });
        if (disposed) return;
        lastModel = r.model;
        webviewPanel.webview.postMessage({
          type: "model",
          model: r.model,
          fileName,
          keepCamera: true,
          midNodes: r.highlightNodes ?? [],
        });
        webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
        if (r.noops > 0) {
          vscode.window.showWarningMessage(
            `${r.noops} operation(s) no longer apply to the reloaded file; they are kept in the history, marked.`
          );
        }
      }, title);

    const rebaseAndReplay = async (model: MdpaModel): Promise<void> => {
      history.rebase(model);
      if (history.appliedCount() === 0) return; // nothing to replay
      await replayAndPost("Re-applying operations…");
    };

    const postModel = async (reason: "initial" | "reload" = "initial"): Promise<void> => {
      if (parseInProgress) {
        pendingParse = true;
        // A reload must not decay into a wiping re-parse just because it landed
        // while another parse was running.
        if (reason === "reload") pendingParseReason = "reload";
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
        // A re-read of the SAME document keeps the edit stack and re-applies it;
        // only a genuinely new base throws it away.
        const keepEdits = reason === "reload" && history.appliedCount() > 0;
        if (!keepEdits) history.setBase(model);
        if (!disposed) {
          // With edits to re-apply, rebaseAndReplay posts the ONE model message
          // (camera preserved) — posting the raw parse first would reset the
          // camera and flash the un-edited mesh.
          if (!keepEdits) {
            webviewPanel.webview.postMessage({ type: "model", model, fileName });
            webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
          }
          if (!ptInitialized) {
            // Catalog + saved case are model-independent; send them once.
            ptInitialized = true;
            void ptController.refresh();
          }
          if (keepEdits) {
            await rebaseAndReplay(model);
          }
          // A Load-problem extraction left an edit recipe for this mesh: replay it.
          const pending = takePendingOps(fsPath);
          if (pending && pending.length > 0) {
            history.load(pending);
            await replayHistory();
          }
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
          const queued = pendingParseReason;
          pendingParseReason = "initial";
          void postModel(queued);
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
      debounce = setTimeout(() => void postModel("reload"), 500);
    };
    watcher.onDidChange(scheduleReparse);
    watcher.onDidCreate(scheduleReparse);
    // An atomic save shows up as delete-then-create, so a delete is a reason to
    // re-read rather than to do nothing: if the file came back the re-parse
    // succeeds, and if it is genuinely gone the existing parse-error path says
    // so. Previously this event was simply unhandled.
    watcher.onDidDelete(scheduleReparse);

    // A text editor holds the .mdpa in memory until VS Code flushes it, so the
    // file watcher alone means editing the mesh as text changes nothing on
    // screen until some later write. Saving the document is the signal.
    const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.fsPath === fsPath) scheduleReparse();
    });

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
        this.activeMenuHandler = handleMenu;
        this.activeReloadHandler = handleReload;
    this.activeReloadHandler = handleReload;
        this.activePtController = ptController;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
        this.activeMenuHandler = undefined;
        this.activeReloadHandler = undefined;
        this.activePtController = undefined;
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
      return { model: lastModel, fsPath, sourceText, ops: history.appliedOps() };
    };
    /** File ▸ Reload from disk / the kratos.mesh.reload command. */
    const handleReload = (): void => {
      void postModel("reload");
    };

    const handleMenu = (msg: MenuMessage): void => {
      void runMenu(msg, exportCtx, this.context);
    };
    this.activeMenuHandler = handleMenu;
    this.activePtController = ptController;

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
      } else if (msg?.type === "menuReload") {
        handleReload();
      } else if (
        msg?.type === "menuOpen" ||
        msg?.type === "menuSave" ||
        msg?.type === "menuSaveAs" ||
        msg?.type === "menuExport" ||
        msg?.type === "menuExportPart" ||
        msg?.type === "menuExportSkin" ||
        msg?.type === "menuSaveProblem" ||
        msg?.type === "menuLoadProblem"
      ) {
        handleMenu(msg as MenuMessage);
      } else if (msg?.type === "ptState") {
        ptController.onState(msg.state as CaseState);
      } else if (msg?.type === "ptGenerate") {
        ptController.dispatch("generate");
      } else if (msg?.type === "ptRun") {
        ptController.dispatch("run");
      } else if (msg?.type === "ptOpenResults") {
        ptController.dispatch("openResults");
      } else if (msg?.type === "flowgraphStart") {
        void startFlowgraph();
      } else if (msg?.type === "flowgraphStop") {
        stopFlowgraph();
      } else if (msg?.type === "flowgraphExport") {
        void ptController.applyExternalProjectParameters(msg.json as string);
      } else if (msg?.type === "pickMeshFile") {
        void (async () => {
          const picked = await pickMergeMeshFile();
          if (picked) {
            void webviewPanel.webview.postMessage({ type: "mergeMeshPicked", path: picked });
          }
        })();
      } else if (msg?.type === "applyOp") {
        void applyOperation(msg as Record<string, unknown>);
      } else if (msg?.type === "opCancel") {
        opAbort?.abort();
      } else if (msg?.type === "opUndo") {
        history.undo();
        void rerenderFromHistory();
      } else if (msg?.type === "opRedo") {
        history.redo();
        void rerenderFromHistory();
      } else if (msg?.type === "opReapply") {
        // Runs the ops a frame change passed over (see MmgRunOptions.skipAsyncOps).
        if (history.hasBase()) void replayAndPost("Re-applying operations…");
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
          if (await loadOps(history, fsPath)) await replayHistory();
        })();
      }
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      if (debounce) {
        clearTimeout(debounce);
      }
      watcher.dispose();
      saveSub.dispose();
      viewStateSub.dispose();
      msgSub.dispose();
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      if (this.activeMenuHandler === handleMenu) {
        this.activeMenuHandler = undefined;
      }
      if (this.activePtController === ptController) {
        this.activePtController = undefined;
      }
      stopFlowgraph();
      ptController.dispose();
    });
  }

  private getHtml(webview: vscode.Webview, savedTheme: string): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", file)
      );
    const scriptUri = mediaUri("webview.js");
    const designSystemUri = mediaUri("design-system.css");
    const styleUri = mediaUri("style.css");
    const nonce = getNonce();
    const flowgraphOrientation = vscode.workspace
      .getConfiguration("kratos.flowgraph")
      .get<string>("splitOrientation", "horizontal");
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `worker-src blob:`,
      // The embedded Flowgraph editor is served from a localhost port (or an
      // https tunnel under Remote/Codespaces) resolved via asExternalUri *after*
      // this CSP is baked, so frame-src is scoped by scheme/host rather than the
      // exact port. The iframe document has its own (absent) CSP, so flowgraph's
      // jQuery/CDN/eval load unaffected.
      `frame-src http://localhost:* http://127.0.0.1:* https:`,
      `child-src blob:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${designSystemUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>MDPA Preview</title>
</head>
<body data-theme="${savedTheme}" data-flowgraph-orientation="${flowgraphOrientation}">
  <div id="loading">
    <div id="loading-inner">
      <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
      <div id="loading-label">Reading file…</div>
    </div>
  </div>
  <div id="app" style="display:none">
    ${MENUBAR_HTML}
    <div id="main">
    ${SIDEBAR_HTML}
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
    <div id="viewport">
      <div id="vtk-sub">
      <div id="cut-panel" class="hidden">${CUT_PANEL_HTML}
      </div>
      <div id="toolbar">${TOOLBAR_HTML}
      </div>
      ${VIEW_MENU_HTML}
      ${ADVANCED_MENU_HTML}
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
      ${FLOWGRAPH_PANE_HTML}
    </div>
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
