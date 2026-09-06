import { MeshAnalysisMessage, runMeshAnalysis } from "./meshAnalysis";
import * as vscode from "vscode";
import {
  PendingFrame,
  saveFrameSequence,
  saveScreenshot,
  saveVideo,
} from "./mediaExport";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseMdpaFile } from "./parser/mdpaParser";
import { MdpaModel } from "./parser/types";
import { renderPreviewHtml } from "./previewHtml";
import {
  ExportContext,
  MenuMessage,
  runMenu,
  saveMesh,
  saveMeshToPath,
  pickMergeMeshFile,
  MESH_PICK_TARGETS,
} from "./meshExport";
import {
  MeshPreviewDocument,
  backupOps,
  restoreOpsFromBackup,
  saveDocument,
} from "./meshDocument";
import { OperationHistory, replayWithProgress, saveOps, loadOps } from "./opHistory";
import {
  meshSourceBytes,
  shouldSummarize,
  summarizeMeshFile,
  SUMMARY_THRESHOLD_MB_DEFAULT,
} from "./parser/meshSummary";
import { MmgRunOptions } from "./parser/operations";
import { createOpRunner } from "./opApply";
import { PtController, PtAction } from "./ptController";
import { CaseState } from "./problemtype/types";
import { takePendingOps } from "./problemArchive";
import { FlowgraphController } from "./flowgraphController";
import { RunManager } from "./runManager";
import { RecentMeshStore } from "./recentMeshes";

class MdpaDocument extends MeshPreviewDocument {}

export class MdpaEditorProvider implements vscode.CustomEditorProvider<MdpaDocument> {
  public static readonly viewType = "kratos.mdpaPreview";

  /**
   * Marks the tab dirty. Deliberately a `CustomDocumentContentChangeEvent` and
   * never a `CustomDocumentEditEvent`: the latter hands VS Code ownership of
   * the undo stack, and `OperationHistory` would become a second cursor that
   * has to stay in lockstep with it through `clear`, three `load` sites and
   * `revertTo` — none of which VS Code's stack can express, and none of which
   * anything in this repo could test (there is no VS Code integration harness).
   * `Ctrl+Z` is delivered instead by `kratos.mesh.undo`, gated on
   * `activeCustomEditorId` exactly as `Ctrl+S`/`Ctrl+O`/`Ctrl+E` already are.
   *
   * The cost, stated rather than hidden: the marker is a one-way latch,
   * cleared only by a save or File ▸ Revert File. Undoing back to zero
   * operations leaves it set — which over-prompts rather than under-prompts.
   */
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<MdpaDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private activePanel: vscode.WebviewPanel | undefined;
  /** Document bound to the active panel, so Save can target its uri. */
  private activeDocument: MdpaDocument | undefined;
  /** File-menu handler bound to the active panel (Command-Palette parity). */
  private activeMenuHandler: ((msg: MenuMessage) => void) | undefined;
  /** Problemtype controller bound to the active panel (Command-Palette parity). */
  private activePtController: PtController | undefined;
  /** Reload handler bound to the active panel (Command-Palette parity). */
  private activeReloadHandler: (() => void) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly flowgraph: FlowgraphController,
    private readonly runs: RunManager,
    private readonly recents: RecentMeshStore
  ) {
    context.subscriptions.push(this._onDidChangeCustomDocument);
  }

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

  /**
   * Saves the active preview through VS Code, so the dirty marker clears.
   *
   * `workspace.save(uri)` rather than `workbench.action.files.save`: it names
   * the editor to save, so it works when the request came from the webview's
   * own File menu and focus is nowhere near the tab.
   */
  public dispatchSave(): boolean {
    if (!this.activeDocument) return false;
    // The latch marks this as a save the user asked for; see saveDocument.
    this.activeDocument.saveRequested = true;
    void vscode.workspace.save(this.activeDocument.uri);
    return true;
  }

  /** Undo/redo on the active preview (the Ctrl+Z / Ctrl+Shift+Z commands). */
  public dispatchHistory(action: "undo" | "redo"): boolean {
    const hooks = this.activeDocument?.hooks;
    if (!hooks) return false;
    if (action === "undo") hooks.undo();
    else hooks.redo();
    return true;
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<MdpaDocument> {
    // A hot-exit backup is an operation recipe waiting for the first base model
    // this panel parses; resolveCustomEditor consumes it there.
    return new MdpaDocument(uri, await restoreOpsFromBackup(openContext.backupId));
  }

  public async saveCustomDocument(
    document: MdpaDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await saveDocument(document);
  }

  public async saveCustomDocumentAs(
    document: MdpaDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await saveDocument(document, destination);
  }

  public async revertCustomDocument(
    document: MdpaDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.hooks?.revert();
  }

  public backupCustomDocument(
    document: MdpaDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Thenable<vscode.CustomDocumentBackup> {
    return backupOps(document, context);
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
    // Remembered for the sidebar's "Recent Meshes" list. Here rather than in
    // each caller because every route to a preview — the Open dialog, the
    // Explorer, a problem archive, a recents row — arrives through this method.
    this.recents.record(fsPath);

    let disposed = false;
    let parseInProgress = false;
    let pendingParse = false;
    /** Reason of a parse that was coalesced behind an in-flight one. */
    let pendingParseReason: "initial" | "reload" = "initial";
    let lastModel: MdpaModel | undefined;
    /** Sticky for the panel's lifetime once the user presses Open full mesh anyway. */
    let userForcedFull = false;
    /** What the last load decided, so a reload cannot flip modes. See shouldSummarize. */
    let summaryShown = false;
    const history = new OperationHistory();
    /**
     * Marks the tab unsaved. One rule for every mutation site: dirty means
     * "operations are applied that the file on disk does not have". So a
     * clamped undo at cursor 0, or a Clear that empties the stack, never
     * claims unsaved work — while a stack that is already non-empty stays
     * marked, which is the documented latch.
     */
    const markDirty = (): void => {
      if (history.appliedCount() > 0) {
        this._onDidChangeCustomDocument.fire({ document });
      }
    };
    const ptController = new PtController(
      fsPath,
      () => lastModel,
      (m) => {
        if (!disposed) void webviewPanel.webview.postMessage(m);
      },
      this.runs
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

    // Apply a newly requested operation, or a queued batch of several; params
    // ride along on the message. MMG ops (and any batch) stream their state
    // into the sidebar's inline loading bar (`opProgress` messages) and are
    // cancellable via `opCancel` → abort. Shared with vtkEditorProvider.ts,
    // which used to duplicate this block byte-for-byte (see src/opApply.ts).
    const opRunner = createOpRunner({
      history,
      webviewPanel,
      getLastModel: () => lastModel,
      isDisposed: () => disposed,
      rerender: rerenderFromHistory,
      onHistoryChanged: markDirty,
    });

    // Full-history replay behind a cancellable notification (loaded recipes and
    // Load-problem pending ops replay from scratch and may re-run MMG).
    const replayHistory = (): Thenable<void> => replayWithProgress(rerenderFromHistory);

    /**
     * Re-applies the surviving edit stack onto a freshly parsed base, then
     * re-renders — behind a cancellable notification, which is why the caller
     * must not route a replay of ZERO ops through here: it would flash a toast
     * on every watcher tick.
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
        // Above the threshold, report the file's shape instead of building a
        // model of it. Deliberately BEFORE parseMdpaFile: the point is not to
        // pay for the parse, the arrays or the postMessage.
        const thresholdMb = vscode.workspace
          .getConfiguration("kratos")
          .get<number>("preview.summaryThresholdMb", SUMMARY_THRESHOLD_MB_DEFAULT);
        const fileSize = await meshSourceBytes(fsPath);
        if (shouldSummarize({ fileSize, thresholdMb, reason, userForcedFull, summaryShown })) {
          const summary = await summarizeMeshFile(fsPath);
          summaryShown = true;
          if (!disposed) {
            webviewPanel.webview.postMessage({ type: "meshSummary", fileName, summary });
            // The catalog and saved case are model-independent, so the case
            // sidebar still works; everything below is not, and is skipped.
            // `takePendingOps` in particular is consume-once — reaching it here
            // would silently destroy a Load-problem edit recipe.
            if (!ptInitialized) {
              ptInitialized = true;
              void ptController.refresh();
            }
            // A summarized document never becomes dirty, so VS Code would drop
            // the backup on close without a word. Make it a visible choice.
            const waiting = document.restoredOps?.length ?? 0;
            if (waiting > 0) {
              vscode.window.showWarningMessage(
                `${waiting} restored edit operation(s) are waiting for this mesh. Choose ` +
                  "\u201cOpen full mesh anyway\u201d to re-apply them \u2014 closing this tab discards them."
              );
            }
          }
          return;
        }
        summaryShown = false;
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
        // Two questions, and they used to share one boolean — which is how a
        // re-parse came to destroy work.
        //
        // FIRST: is this a genuinely new document, or a re-read of the same
        // one? Only a panel that has never adopted a base is new — `fsPath` is
        // fixed for this panel's lifetime and one document has one panel
        // (`supportsMultipleEditorsPerDocument: false`). Asking anything else
        // here — as `reason === "reload" && appliedCount() > 0` did — reaches
        // `setBase`, which resets `ops` as well as the cursor: with every op
        // undone it wiped a redo tail the sidebar was still offering, and a
        // parse queued behind the mesh-summary restore wiped the whole
        // just-restored recipe, applied ops included.
        if (history.hasBase()) history.rebase(model);
        else history.setBase(model);
        // SECOND: is there anything to replay? Read AFTER the branch above,
        // since `setBase` zeroes the cursor. At cursor 0 there is nothing to
        // run and `replayAndPost` would flash its cancellable notification for
        // a no-op, so the freshly parsed model is posted directly — legitimate
        // because with nothing applied a replay returns the bare base anyway.
        const replayNeeded = history.appliedCount() > 0;
        if (!disposed) {
          // With edits to re-apply, replayAndPost sends the ONE model message
          // (camera preserved) — posting the raw parse first would reset the
          // camera and flash the un-edited mesh.
          if (!replayNeeded) {
            webviewPanel.webview.postMessage({ type: "model", model, fileName });
            webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
          }
          if (!ptInitialized) {
            // Catalog + saved case are model-independent; send them once.
            ptInitialized = true;
            void ptController.refresh();
          }
          if (replayNeeded) {
            await replayAndPost("Re-applying operations…");
          }
          // A hot-exit backup, or a Load-problem extraction, left an edit
          // recipe for this mesh. Both are consume-once, and both are consumed
          // here even when only one is used — leaving either in place would let
          // a later parse replay it a second time.
          //
          // The backup WINS when both are present: it is strictly newer AND
          // already contains the pending recipe, since a Load-problem replay
          // goes through the same history the backup was then serialised from.
          // Replaying both would apply every operation twice.
          const pending = takePendingOps(fsPath);
          const restored = document.takeRestoredOps();
          const recipe = restored ?? pending;
          if (recipe && recipe.length > 0) {
            history.load(recipe);
            await replayHistory();
            // The file on disk has none of these edits, so the tab is correctly
            // unsaved from the moment it opens.
            markDirty();
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
        this.activeDocument = document;
        this.activeMenuHandler = handleMenu;
        this.activeReloadHandler = handleReload;
        this.activePtController = ptController;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
        this.activeDocument = undefined;
        this.activeMenuHandler = undefined;
        this.activeReloadHandler = undefined;
        this.activePtController = undefined;
      }
    });

    // Builds the export context for the File menu; reads source text so a
    // same-format MDPA Save can preserve Properties blocks verbatim.
    const exportCtx = (): ExportContext | undefined => {
      if (!lastModel) {
        vscode.window.showWarningMessage(
          summaryShown
            ? "Only a header summary is loaded for this file. Choose \u201cOpen full mesh anyway\u201d first."
            : "The mesh is still loading; try again."
        );
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
      // Save is routed through VS Code rather than straight to `saveMesh`,
      // because only VS Code can clear the dirty marker it set — a direct call
      // would write the file and leave the tab looking unsaved forever.
      if (msg.type === "menuSave") {
        // The latch marks this as a save the user asked for; see saveDocument.
        document.saveRequested = true;
        void vscode.workspace.save(document.uri);
        return;
      }
      void runMenu(msg, exportCtx, this.context);
    };
    this.activeMenuHandler = handleMenu;
    this.activePtController = ptController;

    const doUndo = (): void => {
      history.undo();
      markDirty();
      void rerenderFromHistory();
    };
    const doRedo = (): void => {
      history.redo();
      markDirty();
      void rerenderFromHistory();
    };

    /**
     * What the custom-editor lifecycle and the undo/redo commands get to see:
     * they are handed only a document, while everything they need lives in this
     * closure.
     *
     * Deliberately NOT cleared in `onDidDispose`, unlike the `active*` fields
     * below: closing a dirty tab makes VS Code show its own save prompt and
     * call `saveCustomDocument` DURING teardown, and nothing these close over
     * needs a live webview — `saveMesh` wants only the model, the path and the
     * source text.
     */
    document.hooks = {
      ops: () => history.appliedOps(),
      save: async () => {
        const ctx = exportCtx();
        return ctx ? saveMesh(ctx, this.context) : false;
      },
      saveAs: async (destination) => {
        const ctx = exportCtx();
        return ctx ? saveMeshToPath(ctx, destination.fsPath) : false;
      },
      revert: async () => {
        history.clear();
        await postModel("reload");
      },
      undo: doUndo,
      redo: doRedo,
    };
    this.activeDocument = document;

    const pendingFrames: PendingFrame[] = [];

    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        void postModel();
      } else if (msg?.type === "meshSummaryOpenFull") {
        userForcedFull = true;
        // "initial" on purpose: the base, the history and the pending ops were
        // never set up, and it is this run that must pick the recipe up.
        void postModel("initial");
      } else if (msg?.type === "setTheme") {
        const valid = ["auto", "dark", "light", "scientific"];
        if (valid.includes(msg.theme)) {
          void this.context.globalState.update("sceneTheme", msg.theme);
        }
      } else if (msg?.type === "screenshot") {
        void saveScreenshot(msg.data as string, fsPath);
      } else if (msg?.type === "recordVideo") {
        void saveVideo(
          new Uint8Array(msg.data as ArrayLike<number>),
          fsPath,
          (msg.frames as number) ?? 0
        );
      } else if (msg?.type === "recordFrame") {
        // Buffered here rather than in the webview: the same bytes, held where
        // tens of megabytes is unremarkable, and written after one dialog.
        pendingFrames.push({
          index: msg.index as number,
          total: msg.total as number,
          dataUrl: msg.data as string,
        });
      } else if (msg?.type === "recordFramesDone") {
        const frames = pendingFrames.splice(0, pendingFrames.length);
        void saveFrameSequence(frames, fsPath);
      } else if (msg?.type === "menuReload") {
        handleReload();
      } else if (
        msg?.type === "menuOpen" ||
        msg?.type === "menuSave" ||
        msg?.type === "menuSaveAs" ||
        msg?.type === "menuExport" ||
        msg?.type === "menuExportPart" ||
        msg?.type === "menuExportSkin" ||
        msg?.type === "menuExportTable" ||
        msg?.type === "menuExportSeries" ||
        msg?.type === "menuSaveProblem" ||
        msg?.type === "menuLoadProblem"
      ) {
        handleMenu(msg as MenuMessage);
      } else if (msg?.type === "ptState") {
        ptController.onState(msg.state as CaseState);
      } else if (msg?.type === "ptGenerate") {
        ptController.dispatch("generate");
      } else if (msg?.type === "ptStop") {
        ptController.dispatch("stop");
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
          // `target` names the requesting sidebar form, and rides back on the
          // reply so a second form's Browse button cannot land its pick in the
          // merge form's field. Absent = mergeMesh, the original caller.
          const target = typeof msg.target === "string" ? msg.target : "mergeMesh";
          const spec = MESH_PICK_TARGETS[target] ?? MESH_PICK_TARGETS.mergeMesh;
          const picked = await pickMergeMeshFile(spec.multi, spec.title);
          if (picked) {
            void webviewPanel.webview.postMessage({
              type: "mergeMeshPicked",
              target,
              paths: picked,
            });
          }
        })();
      } else if (msg?.type === "applyOp") {
        void opRunner.applyOperation(msg as Record<string, unknown>);
      } else if (msg?.type === "applyBatch") {
        void opRunner.applyBatch(msg as { ops?: unknown[] });
      } else if (msg?.type === "opCancel") {
        opRunner.cancel();
      } else if (msg?.type === "meshAnalysis") {
        // Read-only: no history entry, no re-render. The wasm is host-only, so
        // these two panels ask rather than compute — see src/meshAnalysis.ts.
        void (async () => {
          const reply = await runMeshAnalysis(msg as MeshAnalysisMessage, lastModel);
          if (!disposed) void webviewPanel.webview.postMessage(reply);
        })();
      } else if (msg?.type === "opUndo") {
        doUndo();
      } else if (msg?.type === "opRedo") {
        doRedo();
      } else if (msg?.type === "opReapply") {
        // Runs the ops a frame change passed over (see MmgRunOptions.skipAsyncOps).
        if (history.hasBase()) void replayAndPost("Re-applying operations…");
      } else if (msg?.type === "opClear") {
        // No markDirty: an empty stack is never dirty. The marker itself stays
        // latched until a save or File ▸ Revert File — see the emitter's note.
        history.clear();
        void rerenderFromHistory();
      } else if (msg?.type === "opRevertTo") {
        // Reverts BOTH ways: a row below the cursor redoes up to that step, so
        // this can take a clean history from 0 back to N applied.
        history.revertTo(msg.index as number);
        markDirty();
        void rerenderFromHistory();
      } else if (msg?.type === "saveOps") {
        void saveOps(history, fsPath);
      } else if (msg?.type === "loadOps") {
        void (async () => {
          if (await loadOps(history, fsPath)) {
            await replayHistory();
            markDirty();
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
      saveSub.dispose();
      viewStateSub.dispose();
      msgSub.dispose();
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      // `document.hooks` is deliberately left in place — see where it is set.
      if (this.activeDocument === document) {
        this.activeDocument = undefined;
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
    return renderPreviewHtml({
      webview,
      extensionUri: this.context.extensionUri,
      title: "MDPA Preview",
      theme: savedTheme,
      withFlowgraph: true,
    });
  }
}

