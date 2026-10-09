import { MeshAnalysisMessage, runMeshAnalysis } from "./meshAnalysis";
import { createPlotController } from "./plotController";
import { plotPreviews } from "./plotPreviewNavigation";
import { navigatePlotPreview, type PlotRunTarget } from "./parser/plot/navigation";
import { runPlotWorker } from "./plotWorkerClient";
import { stepsFromGroup } from "./parser/fieldSeriesScan";
import { runStreamlinesInWorker } from "./streamlineWorkerClient";
import * as vscode from "vscode";
import { saveScreenshot } from "./mediaExport";
import { RecordingController } from "./recordingController";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseMdpaFile } from "./parser/mdpaParser";
import { groupVtkFiles, fileFor, findGroupForFile, VtkFileGroup } from "./parser/vtkFileGroup";
import { flowBalanceSeries, FlowBalanceSpec } from "./parser/flowBalance";
import { MdpaModel } from "./parser/types";
import { toWireModel } from "./parser/modelWire";
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
import { OperationHistory, replayWithProgress, saveOps, loadOps, saveQueueOps, loadQueueOps } from "./opHistory";
import { DocumentInfoReporter, EngineStatusMessage } from "./documentInfo";
import { engineState, onEngineChange } from "./engineActivity";
import {
  meshSourceBytes,
  shouldSummarize,
  summarizeMeshFile,
  SUMMARY_THRESHOLD_MB_DEFAULT,
} from "./parser/meshSummary";
import { MmgRunOptions, OP_LABELS } from "./parser/operations";
import { createOpRunner } from "./opApply";
import { PtController, PtAction } from "./ptController";
import { CaseState } from "./problemtype/types";
import { takePendingOps } from "./problemArchive";
import { FlowgraphController } from "./flowgraphController";
import { RunManager } from "./runManager";
import { RecentMeshStore } from "./recentMeshes";
import { PreviewSession } from "./previewSession";
import { loadViewLayers, saveViewLayers } from "./viewLayersIO";

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

  /** True while this provider owns the active preview tab. */
  public hasActivePanel(): boolean {
    return this.activePanel !== undefined;
  }

  /** Posts to the active preview; false when this provider has none. */
  public postToActive(message: unknown): boolean {
    if (!this.activePanel) return false;
    void this.activePanel.webview.postMessage(message);
    return true;
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

    // One session per panel (former roadmap item 14): it owns the history, the loaded
    // model, the summary flags, the filename-series timeline, the document
    // chip, the problemtype controller, the op runner, the engine relay and
    // the Flowgraph lifecycle, and publishes the save/revert/undo/redo hooks.
    // The empty shell constructs the same session before any file is known and
    // binds late, keeping its panel instead of opening a second tab.
    const session = new PreviewSession({
      context: this.context,
      flowgraph: this.flowgraph,
      runs: this.runs,
      recents: this.recents,
      panel: webviewPanel,
      onDirty: (doc) => {
        this._onDidChangeCustomDocument.fire({ document: doc });
      },
    });

    let parseInProgress = false;
    let pendingParse = false;
    /** Reason of a parse that was coalesced behind an in-flight one. */
    let pendingParseReason: "initial" | "reload" = "initial";
    let frameGeneration = 0;
    let frameQueue: Promise<void> = Promise.resolve();
    /** View-layers sidecar posted once per bound file (keyed, so a rebind to a
     * different file re-posts instead of clobbering edits with a stale list). */
    let viewLayersPostedFor: string | undefined;
    const ensureViewLayers = (): void => {
      if (viewLayersPostedFor === fsPath || session.disposed) return;
      viewLayersPostedFor = fsPath;
      const { layers, warnings } = loadViewLayers(fsPath);
      if (warnings.length > 0) {
        void vscode.window.showWarningMessage(`View layers: ${warnings.join(" ")}`);
      }
      void webviewPanel.webview.postMessage({ type: "viewLayers", layers });
    };

    /** Posts an edited model in place: a `vtkFrame` while a series is shown, else `model`. */
    const postEdited = (model: MdpaModel, midNodes?: number[]): void => {
      if (session.currentGroup) {
        webviewPanel.webview.postMessage({
          type: "vtkFrame",
          model: toWireModel(model),
          ...session.lastFrame,
          midNodes: midNodes ?? [],
        });
      } else {
        webviewPanel.webview.postMessage({
          type: "model",
          model: toWireModel(model),
          fileName,
          keepCamera: true,
          midNodes: midNodes ?? [],
        });
      }
    };

    // Re-render the preview from the current history state, keeping the camera.
    const rerenderFromHistory = async (opts?: MmgRunOptions): Promise<void> => {
      if (session.disposed || !session.history.hasBase()) return;
      const cur = await session.history.current(opts);
      if (session.disposed) return;
      session.lastModel = cur.model;
      postEdited(cur.model, cur.highlightNodes);
      webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
    };


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
        const r = await session.history.replayOntoBase({ ...runOpts, ...opts });
        if (session.disposed) return;
        session.lastModel = r.model;
        postEdited(r.model, r.highlightNodes);
        webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
        if (r.noops > 0) {
          vscode.window.showWarningMessage(
            `${r.noops} operation(s) no longer apply to the reloaded file; they are kept in the history, marked.`
          );
        }
      }, title);

    /**
     * Adopts a freshly parsed step as the new base, keeping the edit stack and
     * skipping async ops (the VTK provider's `adoptFrame`, same rules): a frame
     * change is not a user edit, so the redo tail and the recipe survive.
     */
    const adoptSeriesFrame = async (
      model: MdpaModel,
      skipAsyncOps: boolean
    ): Promise<{ model: MdpaModel; highlightNodes?: number[] }> => {
      if (!session.history.hasBase()) {
        session.history.setBase(model);
        return { model };
      }
      session.history.rebase(model);
      if (session.history.appliedCount() === 0) return { model };
      let out: { model: MdpaModel; highlightNodes?: number[] } = { model };
      const run = async (opts?: MmgRunOptions): Promise<void> => {
        const r = await session.history.replayOntoBase({ ...opts, skipAsyncOps });
        out = { model: r.model, highlightNodes: r.highlightNodes };
        if (r.noops > 0) {
          vscode.window.showWarningMessage(
            `${r.noops} operation(s) no longer apply to this frame; they are kept in the history, marked.`
          );
        }
      };
      if (skipAsyncOps) await run();
      else await replayWithProgress(run, "Re-applying operations\u2026");
      return out;
    };

    const postSeriesFrame = async (
      group: VtkFileGroup,
      frameIndex: number,
      skipAsyncOps = true,
      requestId?: number,
      generation?: number
    ): Promise<void> => {
      const current = (): boolean => generation === undefined || generation === frameGeneration;
      if (session.disposed || !current()) return;
      const step = group.steps[frameIndex];
      const file = step === undefined ? undefined : fileFor(group, group.rootPrefix, session.currentRank, step);
      if (step === undefined || !file) {
        webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId, message: "Requested step is unavailable." });
        return;
      }
      try {
        const framePath = path.join(path.dirname(fsPath), file);
        const parsed = await parseMdpaFile(framePath, (phase, bytesRead, totalBytes) => {
          if (!session.disposed) webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
        });
        if (!current()) return;
        const first = !session.history.hasBase();
        const adopted = await adoptSeriesFrame(parsed, skipAsyncOps);
        if (!current()) return;
        session.lastModel = adopted.model;
        session.frameFile = framePath;
        session.lastFrame = { frameIndex, stepLabel: step, totalFrames: group.steps.length };
        if (session.disposed) return;
        webviewPanel.webview.postMessage({
          type: "vtkFrame",
          requestId,
          model: toWireModel(adopted.model),
          ...session.lastFrame,
          midNodes: adopted.highlightNodes ?? [],
        });
        webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
        session.ensurePt();
        ensureViewLayers();
        if (first && requestId === undefined) {
          // Consume-once recipes land on the first base only, as in postModel.
          const pending = takePendingOps(fsPath);
          const restored = document.takeRestoredOps();
          const recipe = restored ?? pending;
          if (recipe && recipe.length > 0) {
            session.history.load(recipe);
            await replayHistory();
            session.markDirty();
          }
        }
      } catch (err) {
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: requestId === undefined ? "error" : "vtkFrameError",
            requestId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    let captureLocked = false;
    const postModel = async (reason: "initial" | "reload" = "initial"): Promise<void> => {
      if (captureLocked) { pendingParse = true; if (reason === "reload") pendingParseReason = "reload"; return; }
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
        if (shouldSummarize({ fileSize, thresholdMb, reason, userForcedFull: session.userForcedFull, summaryShown: session.summaryShown })) {
          const summary = await summarizeMeshFile(fsPath);
          session.summaryShown = true;
          if (!session.disposed) {
            webviewPanel.webview.postMessage({ type: "meshSummary", fileName, summary });
            // The catalog and saved case are model-independent, so the case
            // sidebar still works; everything below is not, and is skipped.
            // `takePendingOps` in particular is consume-once — reaching it here
            // would silently destroy a Load-problem edit recipe.
            session.ensurePt();
            ensureViewLayers();
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
        session.summaryShown = false;

        // A sibling series of this mesh becomes a timeline, like a VTK series.
        // Only when the OPENED file is the group's root prefix: a child prefix
        // has no root step file here to show.
        const siblings = await fs.promises.readdir(path.dirname(fsPath));
        const found = findGroupForFile(groupVtkFiles(siblings, [".mdpa"]), fileName);
        if (
          found &&
          found.group.steps.length > 1 &&
          fileFor(found.group, found.group.rootPrefix, found.rank, found.step) === fileName
        ) {
          session.currentGroup = found.group;
          session.currentRank = found.rank;
          if (!session.disposed) {
            webviewPanel.webview.postMessage({
              type: "vtkGroup",
              fileName,
              group: {
                modelPartName: found.group.modelPartName,
                steps: found.group.steps,
                subParts: [],
                ranks: found.group.ranks,
              },
            });
          }
          // A reload keeps the step on screen; the first load shows the opened one.
          const at = reason === "reload" ? Math.min(session.lastFrame.frameIndex, found.group.steps.length - 1) : found.group.steps.indexOf(found.step);
          await postSeriesFrame(found.group, Math.max(at, 0), reason !== "reload");
          return;
        }
        session.currentGroup = undefined;
        session.frameFile = fsPath;
        const model = await parseMdpaFile(
          fsPath,
          (phase, bytesRead, totalBytes) => {
            if (!session.disposed) {
              webviewPanel.webview.postMessage({
                type: "progress",
                phase,
                bytesRead,
                totalBytes,
              });
            }
          }
        );
        session.lastModel = model;
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
        // Captured BEFORE the branch consumes it: a re-read of a document we
        // already had should not move the camera, and the direct post below
        // carries no `keepCamera` of its own — so a solver appending a step
        // used to yank the camera on a clean mesh while preserving it on an
        // edited one, an asymmetry nobody chose.
        const hadBase = session.history.hasBase();
        if (hadBase) session.history.rebase(model);
        else session.history.setBase(model);
        // SECOND: is there anything to replay? Read AFTER the branch above,
        // since `setBase` zeroes the cursor. At cursor 0 there is nothing to
        // run and `replayAndPost` would flash its cancellable notification for
        // a no-op, so the freshly parsed model is posted directly — legitimate
        // because with nothing applied a replay returns the bare base anyway.
        const replayNeeded = session.history.appliedCount() > 0;
        if (!session.disposed) {
          // With edits to re-apply, replayAndPost sends the ONE model message
          // (camera preserved) — posting the raw parse first would reset the
          // camera and flash the un-edited mesh.
          if (!replayNeeded) {
            webviewPanel.webview.postMessage({
              type: "model",
              model: toWireModel(model),
              fileName,
              keepCamera: hadBase,
            });
            webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
          }
          session.ensurePt();
          ensureViewLayers();
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
            session.history.load(recipe);
            await replayHistory();
            // The file on disk has none of these edits, so the tab is correctly
            // unsaved from the moment it opens.
            session.markDirty();
          }
        }
      } catch (err) {
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        parseInProgress = false;
        if (pendingParse && !session.disposed) {
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
      debounce = setTimeout(() => {
        if (captureLocked) { webviewPanel.webview.postMessage({ type: "recordingSourceChanged" }); pendingParse = true; pendingParseReason = "reload"; }
        else void postModel("reload");
      }, 500);
    };
    watcher.onDidChange(scheduleReparse);
    watcher.onDidCreate(scheduleReparse);
    session.track(watcher);
    // Steps written by a running solver extend the series; a change to the
    // step on screen re-reads it. Only siblings of the series grammar matter.
    const seriesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(fsPath), "*.mdpa")
    );
    const onSeriesFile = (uri: vscode.Uri): void => {
      if (session.currentGroup || findGroupForFile(groupVtkFiles([path.basename(uri.fsPath)], [".mdpa"]), path.basename(uri.fsPath))) {
        scheduleReparse();
      }
    };
    session.track(seriesWatcher);
    seriesWatcher.onDidCreate(onSeriesFile);
    seriesWatcher.onDidChange((uri) => {
      if (uri.fsPath === session.frameFile) scheduleReparse();
    });
    seriesWatcher.onDidDelete(onSeriesFile);
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
    session.track(saveSub);

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
        this.activeDocument = document;
        this.activeMenuHandler = handleMenu;
        this.activeReloadHandler = handleReload;
        this.activePtController = session.ptController;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
        this.activeDocument = undefined;
        this.activeMenuHandler = undefined;
        this.activeReloadHandler = undefined;
        this.activePtController = undefined;
      }
    });
    session.track(viewStateSub);

    // Builds the export context for the File menu; reads source text so a
    // same-format MDPA Save can preserve Properties blocks verbatim.
    const exportCtx = (): ExportContext | undefined => {
      if (!session.lastModel) {
        vscode.window.showWarningMessage(
          session.summaryShown
            ? "Only a header summary is loaded for this file. Choose \u201cOpen full mesh anyway\u201d first."
            : "The mesh is still loading; try again."
        );
        return undefined;
      }
      let sourceText: string | undefined;
      try {
        sourceText = fs.readFileSync(session.frameFile ?? fsPath, "utf8");
      } catch {
        /* fall back to a lossy write */
      }
      // While a series is shown, Save targets the step ON SCREEN, never the
      // tab's own file (which may be a different step).
      return { model: session.lastModel, fsPath: session.frameFile ?? fsPath, sourceText, ops: session.history.appliedOps(), reportSink: (reports, show) => { if (!session.disposed) void webviewPanel.webview.postMessage({ type: "exportReport", reports, show }); } };
    };
    /** File ▸ Reload from disk / the kratos.mesh.reload command. */
    const handleReload = (): void => {
      void postModel("reload");
    };

    /** Adds one or more picked meshes through the normal undoable merge op. */
    const importMeshes = async (): Promise<void> => {
      if (!session.history.hasBase() || !session.lastModel) {
        vscode.window.showWarningMessage("The mesh is still loading; try again.");
        return;
      }
      const paths = await pickMergeMeshFile(true, "Import Mesh Files");
      if (!paths || session.disposed) return;
      await session.opRunner?.applyOperation({ op: "mergeMesh", paths });
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
      if (msg.type === "menuImport") {
        void importMeshes();
        return;
      }
      void runMenu(msg, exportCtx, this.context);
    };
    // Bind the session to this document: the history, chip, problemtype
    // controller, op runner and save/revert/undo/redo hooks now live on the
    // shared session (former roadmap item 14) instead of this closure. Deliberately
    // NOT cleared in `onDidDispose` (see `PreviewSession.makeHooks`): closing
    // a dirty tab calls `saveCustomDocument` during teardown.
    session.bindDocument(document, {
      rerender: rerenderFromHistory,
      exportCtx,
      revert: () => postModel("reload"),
    });
    this.activeMenuHandler = handleMenu;
    this.activePtController = session.ptController;
    this.activeDocument = document;

    const recording = new RecordingController(this.context.globalStorageUri.fsPath, fsPath, message => webviewPanel.webview.postMessage(message));
    webviewPanel.onDidDispose(() => recording.dispose());

    // Flow-balance series ("All steps"): the same one-model-at-a-time walk the
    // VTK provider runs — a read-only scan that never adopts a frame, never
    // rebases the history and never touches lastModel. MDPA series are
    // filename-grouped only, so there is no in-file branch here.
    // Steady streamlines (Advanced > Streamlines…): the trace runs in a worker
    // thread so a large seed set never blocks the host, with per-seed progress
    // and real cancellation. A newer request SUPERSEDES the in-flight one (a
    // timeline step re-traces): the previous run resolves its partial result,
    // which the webview drops by sequence tag. An explicit Cancel resolves the
    // partial result under the current tag, so the panel draws what completed.
    let streamlineAbort: AbortController | undefined;
    const runStreamlineAnalysis = async (msg: MeshAnalysisMessage): Promise<void> => {
      streamlineAbort?.abort();
      const abort = new AbortController();
      streamlineAbort = abort;
      try {
        const reply = await runMeshAnalysis(msg, session.lastModel, {
          signal: abort.signal,
          onProgress: (done, total) => {
            if (!session.disposed) {
              void webviewPanel.webview.postMessage({ type: "streamlineProgress", done, total, seq: msg.seq });
            }
          },
          traceRunner: runStreamlinesInWorker,
        });
        if (!session.disposed) void webviewPanel.webview.postMessage(reply);
      } finally {
        if (streamlineAbort === abort) streamlineAbort = undefined;
      }
    };

    let flowSeriesAbort: AbortController | undefined;
    const runFlowSeries = async (msg: Record<string, unknown>): Promise<void> => {
      const reply = (payload: Record<string, unknown>): void => {
        if (!session.disposed) void webviewPanel.webview.postMessage({ type: "flowSeriesResult", ...payload });
      };
      if (flowSeriesAbort) {
        reply({ message: "A flow-balance scan is already running." });
        return;
      }
      const flow = msg.flow as FlowBalanceSpec | undefined;
      if (!flow || !Array.isArray(flow.sections)) {
        reply({ message: "Choose the sections to balance first." });
        return;
      }
      // Snapshot before the first await: the watcher reassigns currentGroup.
      const group = session.currentGroup;
      const rank = session.currentRank;
      if (!group) {
        reply({ message: "This file has no time series to balance." });
        return;
      }
      const dir = path.dirname(fsPath);
      const steps = group.steps.map((step, i) => {
        const file = fileFor(group, group.rootPrefix, rank, step);
        const framePath = file ? path.join(dir, file) : undefined;
        return {
          label: step,
          frameIndex: i,
          load: async () => {
            if (!framePath) throw new Error(`Step "${step}" has no file for this rank.`);
            return parseMdpaFile(framePath);
          },
        };
      });
      flowSeriesAbort = new AbortController();
      try {
        const series = await flowBalanceSeries(steps, flow, {
          signal: flowSeriesAbort.signal,
          onProgress: (done, total, label) => {
            if (!session.disposed) void webviewPanel.webview.postMessage({ type: "flowSeriesProgress", done, total, label });
          },
        });
        const applied = session.history.appliedCount();
        reply({
          series,
          historyNote: applied > 0 ? `${applied} edit operation(s) are not applied to these values.` : undefined,
        });
      } catch (err) {
        reply({ message: err instanceof Error ? err.message : String(err) });
      } finally {
        flowSeriesAbort = undefined;
      }
    };

    let plots: ReturnType<typeof createPlotController> | undefined;
    let plotPreviewReady!: () => void;
    const readyForPlot = new Promise<void>(resolve => { plotPreviewReady = resolve; });
    const unregisterPlot = plotPreviews.register(fsPath, {
      ready: readyForPlot,
      navigate: async (target, current, signal) => {
        // A refused handoff must not cancel a recording or other pending work.
        if(!current() || signal.aborted || session.disposed || captureLocked || parseInProgress || session.summaryShown || session.opRunner?.busy() || session.history.appliedCount() !== 0 || !session.lastModel)throw new Error("The owning preview is edited, recording, busy or unavailable; no navigation was applied.");
        const generation = ++frameGeneration, group = session.currentGroup, rank = session.currentRank, base = session.lastModel;
        const available = () => current() && !signal.aborted && !session.disposed && !captureLocked && !parseInProgress && !session.summaryShown && !session.opRunner?.busy() && session.history.appliedCount() === 0 && !!base && session.lastModel === base && generation === frameGeneration && group === session.currentGroup && rank === session.currentRank;
        await navigatePlotPreview(target, {
          current: available,
          verify: async request => await runPlotWorker({runTarget:request},{signal}) as PlotRunTarget,
          load: async selected => {
            if(selected.timeline === "inFile")throw new Error("This MDPA preview has no in-file timeline.");
            if(selected.timeline === "single")return parseMdpaFile(selected.framePath);
            const step = group && stepsFromGroup(group,path.dirname(fsPath),rank).find(s => s.frameIndex === selected.frameIndex && s.path === selected.framePath && s.label === selected.label);
            if(!step)throw new Error("The owning preview's timeline/rank does not match the verified frame.");
            return step.load();
          },
          commit: (model, selected) => {
            if(session.history.hasBase())session.history.rebase(model);else session.history.setBase(model);
            session.lastModel=model;session.frameFile=selected.framePath;
            session.lastFrame={frameIndex:selected.frameIndex,stepLabel:selected.label,totalFrames:group?.steps.length??1};
            void webviewPanel.webview.postMessage({type:"vtkFrame",model:toWireModel(model),...session.lastFrame,plotNavigation:selected.request});
            void webviewPanel.webview.postMessage({type:"opState",...session.history.state()});
          },
        });
      },
    });
    webviewPanel.onDidDispose(() => { unregisterPlot(); plotPreviewReady(); });
    webviewPanel.onDidDispose(()=>plots?.dispose());
    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        // Forced: a reloaded page has forgotten both, and the dedupe would
        // otherwise swallow the re-post. Before the model so the chip is
        // filled while the mesh is still parsing.
        session.docInfo?.sync(true);
        session.postEngineStatus();
        void postModel().finally(plotPreviewReady);
      } else if (plots?.receive(msg)) {
        // Read-only plot requests belong to this preview, not the active editor.
      } else if (msg?.type === "plotOpen") {
        plots ??= createPlotController(this.context,webviewPanel.webview,undefined,()=>{
          const timeline=JSON.stringify([session.currentGroup?.steps,session.currentRank]);
          return {path:fsPath,model:session.lastModel,frameIndex:session.lastFrame.frameIndex,hasTimeline:(session.currentGroup?.steps.length??0)>1,timelineId:timeline,pick:origin=>{
            if(timeline!==JSON.stringify([session.currentGroup?.steps,session.currentRank])){void webviewPanel.webview.postMessage({type:"plotNotice",message:"Timeline changed; refresh the plot before locating samples."});return;}
            if(!session.disposed)void webviewPanel.webview.postMessage({type:"plotPick",origin});
          }};
        });
        plots.sendContext();void webviewPanel.webview.postMessage({type:"plotReveal",preset:msg.preset});
      } else if (msg?.type === "vtkRequestFrame") {
        const fi = typeof msg.frameIndex === "number" ? msg.frameIndex : 0;
        if (captureLocked && typeof msg.requestId !== "number") return;
        const generation = ++frameGeneration;
        const group = session.currentGroup;
        frameQueue = frameQueue
          .then(async () => {
            if (generation !== frameGeneration) return;
            if (group) await postSeriesFrame(group, fi, true, msg.requestId, generation);
            else void webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId: msg.requestId, message: "Timeline is unavailable." });
          })
          .catch((error) => {
            void webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId: msg.requestId, message: String(error) });
          });
      } else if (msg?.type === "meshSummaryOpenFull") {
        session.userForcedFull = true;
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
      } else if (msg?.type === "recordCaptureLock") {
        captureLocked = Boolean(msg.active);
        if (!captureLocked && pendingParse) { pendingParse = false; void postModel("reload"); }
      } else if (msg?.type === "recording") {
        recording.receive(msg);
      } else if (msg?.type === "menuReload") {
        if (captureLocked) { pendingParse = true; pendingParseReason = "reload"; webviewPanel.webview.postMessage({ type: "recordingSourceChanged" }); }
        else handleReload();
      } else if (
        msg?.type === "menuOpen" ||
        msg?.type === "menuImport" ||
        msg?.type === "menuSave" ||
        msg?.type === "menuSaveAs" ||
        msg?.type === "menuExport" ||
        msg?.type === "menuExportPart" ||
        msg?.type === "menuExportSkin" ||
        msg?.type === "menuExportDerived" ||
        msg?.type === "menuExportSelection" ||
        msg?.type === "menuExportPartitions" ||
        msg?.type === "menuSplitMesh" ||
        msg?.type === "menuExportSimplified" ||
        msg?.type === "menuExportGrid" ||
        msg?.type === "menuExportTable" ||
        msg?.type === "menuExportSeries" ||
        msg?.type === "menuExportAnalysis" ||
        msg?.type === "menuSaveProblem" ||
        msg?.type === "menuLoadProblem"
      ) {
        handleMenu(msg as MenuMessage);
      } else if (msg?.type === "ptState") {
        session.ptController?.onState(msg.state as CaseState);
      } else if (msg?.type === "viewLayersLoad") {
        // View-only sidecar: never touches history, lastModel or the dirty
        // marker — it only re-posts the file beside the mesh.
        viewLayersPostedFor = fsPath;
        const { layers, warnings } = loadViewLayers(fsPath);
        if (warnings.length > 0) {
          void vscode.window.showWarningMessage(`View layers: ${warnings.join(" ")}`);
        }
        void webviewPanel.webview.postMessage({ type: "viewLayers", layers });
      } else if (msg?.type === "viewLayersSave") {
        // Same boundary: a sidecar write is not a mesh edit, so no markDirty,
        // no history, no document change event.
        const { warnings } = saveViewLayers(fsPath, (msg as { layers: unknown }).layers);
        if (warnings.length > 0) {
          void vscode.window.showWarningMessage(`View layers: ${warnings.join(" ")}`);
        }
      } else if (msg?.type === "ptGenerate") {
        session.ptController?.dispatch("generate");
      } else if (msg?.type === "ptStop") {
        session.ptController?.dispatch("stop");
      } else if (msg?.type === "ptRun") {
        session.ptController?.dispatch("run");
      } else if (msg?.type === "ptOpenResults") {
        session.ptController?.dispatch("openResults");
      } else if (msg?.type === "ptPresetSave") {
        void session.ptController?.savePreset(msg as { lawId: string; name: string; values: Record<string, number> });
      } else if (msg?.type === "ptPresetImport") {
        void session.ptController?.importPresets();
      } else if (msg?.type === "ptPresetExport") {
        void session.ptController?.exportPreset(String(msg.preset ?? ""));
      } else if (msg?.type === "flowgraphStart") {
        void session.startFlowgraph();
      } else if (msg?.type === "flowgraphStop") {
        session.stopFlowgraph();
      } else if (msg?.type === "flowgraphExport") {
        void session.ptController?.applyExternalProjectParameters(msg.json as string);
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
        void session.opRunner?.applyOperation(msg as Record<string, unknown>);
      } else if (msg?.type === "applyBatch") {
        void session.opRunner?.applyBatch(msg as { ops?: unknown[] });
      } else if (msg?.type === "opCancel") {
        session.opRunner?.cancel();
      } else if (msg?.type === "meshAnalysis") {
        // Read-only: no history entry, no re-render. The wasm is host-only, so
        // these two panels ask rather than compute — see src/meshAnalysis.ts.
        // Streamlines trace in a worker thread (progress + cancellation above).
        if (msg?.kind === "streamlines") void runStreamlineAnalysis(msg as MeshAnalysisMessage);
        else {
          void (async () => {
            const reply = await runMeshAnalysis(msg as MeshAnalysisMessage, session.lastModel);
            if (!session.disposed) void webviewPanel.webview.postMessage(reply);
          })();
        }
      } else if (msg?.type === "streamlineCancel") {
        streamlineAbort?.abort();
      } else if (msg?.type === "flowSeries") {
        void runFlowSeries(msg as Record<string, unknown>);
      } else if (msg?.type === "flowSeriesCancel") {
        flowSeriesAbort?.abort();
      } else if (msg?.type === "opUndo") {
        session.doUndo();
      } else if (msg?.type === "opRedo") {
        session.doRedo();
      } else if (msg?.type === "opReapply") {
        // Runs the ops a frame change passed over (see MmgRunOptions.skipAsyncOps).
        if (session.history.hasBase()) void replayAndPost("Re-applying operations…");
      } else if (msg?.type === "opClear") {
        // No markDirty: an empty stack is never dirty. The marker itself stays
        // latched until a save or File ▸ Revert File — see the emitter's note.
        session.history.clear();
        session.docInfo?.sync();
        void rerenderFromHistory();
      } else if (msg?.type === "opRevertTo") {
        // Reverts BOTH ways: a row below the cursor redoes up to that step, so
        // this can take a clean history from 0 back to N applied.
        session.history.revertTo(msg.index as number);
        session.markDirty();
        void rerenderFromHistory();
      } else if (msg?.type === "saveOps") {
        void saveOps(session.history, fsPath);
      } else if (msg?.type === "saveQueue") {
        void saveQueueOps(msg.ops as unknown[], fsPath);
      } else if (msg?.type === "loadQueue") {
        void loadQueueOps((m) => void webviewPanel.webview.postMessage(m), fsPath);
      } else if (msg?.type === "loadOps") {
        void (async () => {
          if (await loadOps(session.history, fsPath)) {
            await replayHistory();
            session.markDirty();
          }
        })();
      }
    });

    session.track(msgSub);
    webviewPanel.onDidDispose(() => {
      flowSeriesAbort?.abort();
      streamlineAbort?.abort();
      if (debounce) {
        clearTimeout(debounce);
      }
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      // `document.hooks` is deliberately left in place — see `PreviewSession.makeHooks`.
      if (this.activeDocument === document) {
        this.activeDocument = undefined;
      }
      if (this.activeMenuHandler === handleMenu) {
        this.activeMenuHandler = undefined;
      }
      if (this.activePtController === session.ptController) {
        this.activePtController = undefined;
      }
      session.dispose();
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
