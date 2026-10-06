import { SequenceResampler, ResampleOptions } from "./parser/resampleSequence";
import { sequenceSource, exportResampled, ResampleSourceOptions } from "./parser/resampleFiles";
import { mergeSubparts } from "./parser/seriesSubparts";
import { MeshAnalysisMessage, runMeshAnalysis } from "./meshAnalysis";
import { createPlotController } from "./plotController";
import { plotPreviews } from "./plotPreviewNavigation";
import { navigatePlotPreview, type PlotRunTarget } from "./parser/plot/navigation";
import { runPlotWorker } from "./plotWorkerClient";
import { runStreamlinesInWorker } from "./streamlineWorkerClient";
import * as vscode from "vscode";
import { saveScreenshot } from "./mediaExport";
import { RecordingController } from "./recordingController";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseMeshFile, probeInFileSteps, readMeshTimeSteps } from "./parser/meshFileParser";
import {
  contentWatchGlob,
  TIMELINE_EXTENSIONS,
  timelineKindFor,
  timelineWatchGlob,
} from "./parser/meshFormats";
import {
  meshSourceBytes,
  shouldSummarize,
  summarizeMeshFile,
  SUMMARY_THRESHOLD_MB_DEFAULT,
} from "./parser/meshSummary";
import { groupVtkFiles, fileFor, findGroupForFile, VtkFileGroup } from "./parser/vtkFileGroup";
import { MdpaModel } from "./parser/types";
import { expandCompactReport, type ProvenanceMode } from "./parser/exportReport";
import { toWireModel } from "./parser/modelWire";
import { renderPreviewHtml } from "./previewHtml";
import {
  ExportContext,
  announceReports,
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
import { DocumentInfoReporter, EngineStatusMessage } from "./documentInfo";
import { engineState, onEngineChange } from "./engineActivity";
import { MmgRunOptions, OP_LABELS } from "./parser/operations";
import { createOpRunner } from "./opApply";
import { PtController, PtAction } from "./ptController";
import { CaseState } from "./problemtype/types";
import { FlowgraphController } from "./flowgraphController";
import { RunManager } from "./runManager";
import { FieldSeriesSpec } from "./parser/fieldSeries";
import {
  collectFieldSeries,
  stepsFromGroup,
  stepsFromInFile,
} from "./parser/fieldSeriesScan";
import { flowBalanceSeries, FlowBalanceSpec } from "./parser/flowBalance";
import { takePendingOps } from "./problemArchive";
import { RecentMeshStore } from "./recentMeshes";
import { PreviewSession } from "./previewSession";

// ---- Document ----------------------------------------------------------------

class VtkDocument extends MeshPreviewDocument {}

// ---- Provider ----------------------------------------------------------------

export class VtkEditorProvider implements vscode.CustomEditorProvider<VtkDocument> {
  public static readonly viewType = "kratos.vtkPreview";

  /**
   * Marks the tab dirty. A `CustomDocumentContentChangeEvent`, never a
   * `CustomDocumentEditEvent` — see the matching note in `mdpaEditorProvider.ts`
   * for why VS Code does not get ownership of the undo stack.
   *
   * Note what is NOT a fire site here: `adoptFrame` rebases and replays on
   * every timeline step, and scrubbing a solver's output is not an edit. That
   * is what makes marking a result file dirty acceptable at all.
   */
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<VtkDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private activePanel: vscode.WebviewPanel | undefined;
  /** Document bound to the active panel, so Save can target its uri. */
  private activeDocument: VtkDocument | undefined;
  /**
   * Open panels by file path, so "open the latest results" can reveal and jump
   * an existing preview instead of stacking a new tab per step.
   */
  private readonly panelsByPath = new Map<
    string,
    { reveal(): void; goToLatest(): Promise<void> }
  >();

  /** Paths of the previews currently open — used to find one already showing a
   *  results series so it can be revealed rather than duplicated. */
  public openPanelPaths(): string[] {
    return [...this.panelsByPath.keys()];
  }

  /** Reveals an open preview and moves it to the last step. */
  public revealLatestFrame(fsPath: string): boolean {
    const panel = this.panelsByPath.get(fsPath);
    if (!panel) return false;
    panel.reveal();
    void panel.goToLatest();
    return true;
  }
  /** File-menu handler bound to the active panel (Command-Palette parity). */
  private activeMenuHandler: ((msg: MenuMessage) => void) | undefined;
  /** Reload handler bound to the active panel (Command-Palette parity). */
  private activeReloadHandler: (() => void) | undefined;
  /** Problemtype controller bound to the active panel (Command-Palette parity). */
  private activePtController: PtController | undefined;

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

  /** Runs a File-menu action on the active mesh preview; false if none active. */
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
   * `workspace.save(uri)` names the editor, so it works when the request came
   * from the webview's own File menu and focus is nowhere near the tab.
   */
  public dispatchSave(): boolean {
    if (!this.activeDocument) return false;
    // The latch marks this as a save the user asked for; see saveDocument.
    this.activeDocument.saveRequested = true;
    void vscode.workspace.save(this.activeDocument.uri);
    return true;
  }

  /**
   * The file the active preview is showing, for commands that work on the
   * FILES rather than the parsed model — packing a series into one file is the
   * only one, since every other export path already has an ExportContext.
   */
  public activeFsPath(): string | undefined {
    return this.activeDocument?.uri.fsPath;
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
  ): Promise<VtkDocument> {
    // A hot-exit backup is an operation recipe waiting for the first base model
    // this panel parses; `applyPendingOps` consumes it there.
    return new VtkDocument(uri, await restoreOpsFromBackup(openContext.backupId));
  }

  public async saveCustomDocument(
    document: VtkDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await saveDocument(document);
  }

  public async saveCustomDocumentAs(
    document: VtkDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await saveDocument(document, destination);
  }

  public async revertCustomDocument(
    document: VtkDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    await document.hooks?.revert();
  }

  public backupCustomDocument(
    document: VtkDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Thenable<vscode.CustomDocumentBackup> {
    return backupOps(document, context);
  }

  public resolveCustomEditor(
    document: VtkDocument,
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
    const dir = path.dirname(fsPath);
    const fileName = path.basename(fsPath);

    // One session per panel (roadmap item 14): it owns the history, the loaded
    // model, the summary flags, the timeline state, the document chip, the
    // problemtype controller, the op runner, the engine relay and the Flowgraph
    // lifecycle. The empty shell constructs the same session before any file is
    // known and binds late, keeping its panel instead of opening a second tab.
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

    let loadInProgress = false;
    /** A discover() arrived while one was running; re-run once it finishes. */
    let rediscoverQueued = false;
    let reloadQueued = false;
    let resampler: SequenceResampler | undefined;
    // Catalog + saved case are model-independent; send them once, after the
    // first frame lands (mirrors the MDPA provider's post-parse refresh).
    const maybeInitPt = (): void => {
      session.ensurePt();
    };


    // Re-render the current frame from the history state (camera preserved).
    const rerenderFromHistory = async (opts?: MmgRunOptions): Promise<void> => {
      if (session.disposed || !session.history.hasBase()) return;
      const cur = await session.history.current(opts);
      if (session.disposed) return;
      session.lastModel = cur.model;
      webviewPanel.webview.postMessage({
        type: "vtkFrame",
        model: toWireModel(cur.model),
        frameIndex: session.lastFrame.frameIndex,
        stepLabel: session.lastFrame.stepLabel,
        stepLabelKind: session.lastFrame.stepLabelKind,
        totalFrames: session.lastFrame.totalFrames,
        midNodes: cur.highlightNodes ?? [],
      });
      webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
    };


    // Full-history replay behind a cancellable notification (loaded recipes and
    // Load-problem pending ops replay from scratch and may re-run MMG).
    const replayHistory = (): Thenable<void> => replayWithProgress(rerenderFromHistory);

    /**
     * Adopts a freshly parsed frame as the new base, keeping the edit stack.
     *
     * Stepping the timeline used to call `setBase`, which silently discarded
     * every edit — so a single arrow-key press threw the user's work away. The
     * stack now survives and is re-applied, but the ASYNC ops are skipped: a
     * remesh re-running on every frame would make the timeline unusable. They
     * stay in the history marked, and the Edit section's Re-apply runs them.
     *
     * "The stack" includes the REDO TAIL — the ops past the cursor. A frame
     * change is not a user edit, so it must not truncate the history the way
     * applying a new op deliberately does.
     */
    const adoptFrame = async (
      model: MdpaModel,
      skipAsyncOps: boolean
    ): Promise<{ model: MdpaModel; highlightNodes?: number[] }> => {
      // A genuinely new document — this panel has never adopted a base — is the
      // only thing `setBase` is for: it resets `ops` as well as the cursor.
      // Branching on the CURSOR instead, as this did, meant a single timeline
      // arrow-key press destroyed a redo tail the sidebar was still offering.
      if (!session.history.hasBase()) {
        session.history.setBase(model);
        return { model };
      }
      session.history.rebase(model);
      // Nothing applied: the tail is kept, but there is nothing to run — and
      // returning here is also what keeps a zero-op replay out of the
      // cancellable notification below.
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
      // Skipping the async ops means only cheap, synchronous ones can run, so a
      // progress notification would just flash on every arrow-key press. The
      // full replay (an explicit Reload) keeps its cancellable notification.
      if (skipAsyncOps) await run();
      else await replayWithProgress(run, "Re-applying operations…");
      return out;
    };

    /** Re-runs the whole stack on the CURRENT frame, async ops included. */
    const reapplyAll = (): Thenable<void> =>
      replayWithProgress(async (opts) => {
        const r = await session.history.replayOntoBase(opts);
        if (session.disposed) return;
        session.lastModel = r.model;
        webviewPanel.webview.postMessage({
          type: "vtkFrame",
          model: toWireModel(r.model),
          frameIndex: session.lastFrame.frameIndex,
          stepLabel: session.lastFrame.stepLabel,
        stepLabelKind: session.lastFrame.stepLabelKind,
          totalFrames: session.lastFrame.totalFrames,
          midNodes: r.highlightNodes ?? [],
        });
        webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
      }, "Re-applying operations…");

    /**
     * Replays the edit recipe waiting for this mesh — a hot-exit backup, or a
     * Load-problem extraction — on the first base model this panel loads.
     *
     * Both sources are **consume-once**, and both are consumed here even when
     * only one is used. That discipline is load-bearing rather than tidy: this
     * runs on EVERY frame post, and `OperationHistory.load` resets the cursor
     * to the end of the stack, so a recipe left in place would silently undo
     * the user's undos on every timeline arrow-key press.
     *
     * The backup wins when both are present: it is strictly newer AND already
     * contains the pending recipe (a Load-problem replay goes through the same
     * history the backup was then serialised from), so replaying both would
     * apply every operation twice.
     */
    const applyPendingOps = async (): Promise<void> => {
      const pending = takePendingOps(fsPath);
      const restored = document.takeRestoredOps();
      const recipe = restored ?? pending;
      if (recipe && recipe.length > 0) {
        session.history.load(recipe);
        await replayHistory();
        // The file on disk has none of these edits.
        session.markDirty();
      }
    };

    // ---- Frame loading -------------------------------------------------------

    let frameRequestGeneration = 0;
    let frameQueue: Promise<void> = Promise.resolve();
    let captureLocked = false;
    let captureSourceChanged = false;
    const requestCurrent = (generation?: number): boolean => generation === undefined || generation === frameRequestGeneration;

    const postFrame = async (
      group: VtkFileGroup,
      frameIndex: number,
      rank: number,
      skipAsyncOps = true,
      requestId?: number,
      generation?: number,
      restoring = false
    ): Promise<void> => {
      if (session.disposed || !requestCurrent(generation)) return;
      const step = group.steps[frameIndex];
      if (step === undefined) { webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId, message: "Requested step is unavailable." }); return; }

      const rootFile = fileFor(group, group.rootPrefix, rank, step);
      if (!rootFile) { webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId, message: "Requested source file is missing." }); return; }

      try {
        const rootPath = path.join(dir, rootFile);
        const rootModel = await parseMeshFile(
          rootPath,
          (phase, bytesRead, totalBytes) => {
            if (!session.disposed) {
              webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
            }
          }
        );

        // Merge subpart files into rootModel.subModelParts
        rootModel.subModelParts = await mergeSubparts(
          rootModel,
          group,
          dir,
          rank,
          step,
          group.rootPrefix
        );

        if (!requestCurrent(generation)) return;
        if (captureLocked && captureSourceChanged && !restoring) throw new Error("Source changed during capture.");
        const adopted = await adoptFrame(rootModel, skipAsyncOps);
        if (!requestCurrent(generation)) return;
        session.lastModel = adopted.model;
        session.lastFrame = { frameIndex, stepLabel: step, totalFrames: group.steps.length };
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame", requestId,
            model: toWireModel(adopted.model),
            frameIndex,
            stepLabel: step,
            totalFrames: group.steps.length,
            midNodes: adopted.highlightNodes ?? [],
          });
          webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
          maybeInitPt();
          if (requestId === undefined) await applyPendingOps();
        }
      } catch (err) {
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: requestId === undefined ? "error" : "vtkFrameError", requestId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    const postResampledFrame = async (index: number, requestId?: number, generation?: number): Promise<void> => {
      const sampler = resampler;
      if (!sampler || !requestCurrent(generation)) return;
      const frame = await sampler.frame(index);
      if (sampler !== resampler || !requestCurrent(generation)) return;
      const adopted = await adoptFrame(frame,true);
      if (sampler !== resampler || !requestCurrent(generation)) return;
      session.lastModel=adopted.model;
      session.lastFrame={frameIndex:index,stepLabel:String(sampler.times[index]),totalFrames:sampler.times.length,stepLabelKind:"time"};
      webviewPanel.webview.postMessage({type:"vtkFrame",requestId,model:toWireModel(adopted.model),...session.lastFrame,midNodes:adopted.highlightNodes??[]});
      webviewPanel.webview.postMessage({type:"opState",...session.history.state()});
    };

    // A single Exodus (or other in-file-timeline format) file carries every
    // step itself, so this re-parses the SAME fsPath with a `timeStep`
    // rather than switching files like postFrame does.
    const postInFileFrame = async (
      frameIndex: number,
      skipAsyncOps = true,
      requestId?: number,
      generation?: number,
      restoring = false
    ): Promise<void> => {
      if (session.disposed || !requestCurrent(generation)) return;
      const timeValues = session.inFileTimeValues;
      if (!timeValues) { webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId, message: "Timeline is unavailable." }); return; }
      const clamped = Math.min(Math.max(frameIndex, 0), timeValues.length - 1);
      try {
        const model = await parseMeshFile(
          fsPath,
          (phase, bytesRead, totalBytes) => {
            if (!session.disposed) {
              webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
            }
          },
          { timeStep: clamped }
        );
        if (!requestCurrent(generation)) return;
        if (captureLocked && captureSourceChanged && !restoring) throw new Error("Source changed during capture.");
        const adopted = await adoptFrame(model, skipAsyncOps);
        if (!requestCurrent(generation)) return;
        session.lastModel = adopted.model;
        session.lastFrame = {
          frameIndex: clamped,
          stepLabel: String(timeValues[clamped] ?? ""),
          stepLabelKind: "time",
          totalFrames: timeValues.length,
        };
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame", requestId,
            model: toWireModel(adopted.model),
            frameIndex: clamped,
            stepLabel: session.lastFrame.stepLabel,
        stepLabelKind: session.lastFrame.stepLabelKind,
            totalFrames: timeValues.length,
            midNodes: adopted.highlightNodes ?? [],
          });
          webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
          maybeInitPt();
          if (requestId === undefined) await applyPendingOps();
        }
      } catch (err) {
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: requestId === undefined ? "error" : "vtkFrameError", requestId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    /**
     * Debounced re-discovery for the watchers.
     *
     * Was previously a direct `void discover()` behind a name that promised
     * scheduling — so a solver writing a burst of step files fired one parse per
     * file, and every call landing while a parse was in flight was DROPPED by
     * `loadInProgress` rather than queued (discover now re-runs itself once
     * instead). 500 ms matches the MDPA provider's file watcher.
     */
    let rediscoverDebounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleRediscover = (): void => {
      if (captureLocked) {
        captureSourceChanged = true;
        webviewPanel.webview.postMessage({ type: "recordingSourceChanged" });
        return;
      }
      if (rediscoverDebounce) clearTimeout(rediscoverDebounce);
      rediscoverDebounce = setTimeout(() => void discover("reload"), 500);
    };

    // ---- Initial discovery --------------------------------------------------

    const discover = async (reason: "initial" | "reload" = "initial"): Promise<void> => {
      if (session.disposed) return;
      if (loadInProgress) {
        // Queue instead of DROPPING: a solver writing steps quickly fires the
        // watcher while a parse is in flight, and dropping the call meant the
        // final state could simply never be shown.
        rediscoverQueued = true;
        if (reason === "reload") reloadQueued = true;
        return;
      }
      loadInProgress = true;
      if (resampler) { resampler.clear(); resampler=undefined; ++frameRequestGeneration; }
      try {
        // Above the threshold, report the file's shape instead of loading it.
        // This sits ABOVE the timeline dispatch on purpose: an in-file series
        // returns from that branch without ever reaching the static path, and
        // readMeshTimeSteps below does its own full read of the file.
        const thresholdMb = vscode.workspace
          .getConfiguration("kratos")
          .get<number>("preview.summaryThresholdMb", SUMMARY_THRESHOLD_MB_DEFAULT);
        // Not `stat(fsPath).size`: an OpenFOAM marker is 0 bytes while its
        // mesh is constant/polyMesh/, so the opened file is not the source.
        const fileSize = await meshSourceBytes(fsPath);
        if (shouldSummarize({ fileSize, thresholdMb, reason, userForcedFull: session.userForcedFull, summaryShown: session.summaryShown })) {
          const summary = await summarizeMeshFile(fsPath);
          session.summaryShown = true;
          if (!session.disposed) {
            webviewPanel.webview.postMessage({ type: "meshSummary", fileName, summary });
            // A summarized document never becomes dirty, so VS Code would drop
            // a restored backup on close without a word. Make it a choice.
            const waiting = document.restoredOps?.length ?? 0;
            if (waiting > 0) {
              vscode.window.showWarningMessage(
                `${waiting} restored edit operation(s) are waiting for this mesh. Choose ` +
                  "\u201cOpen full mesh anyway\u201d to re-apply them \u2014 closing this tab discards them."
              );
            }
          }
          // Model-independent, so the case sidebar still works. Everything else
          // the load path does is skipped — `applyPendingOps` most of all, which
          // consumes the pending recipe once and would destroy it here.
          maybeInitPt();
          return;
        }
        session.summaryShown = false;

        // One pure decision, shared with fieldSeriesScan's discoverSeriesSteps.
        // This used to be two `includes` over `path.extname`, which reads
        // ".msh" for a GiD "case.post.msh" — matching neither list, so the
        // file silently lost its timeline and its watcher.
        let kind = timelineKindFor(fileName);
        // .frd/.msh are filename-series formats that may ALSO hold steps in the
        // file itself; probe once, and fall through to the filename grammar
        // when there is nothing inside.
        let probedTimes: number[] = [];
        if (kind === "filename") {
          probedTimes = await probeInFileSteps(fsPath);
          if (probedTimes.length > 1) kind = "in-file";
        }

        if (kind === "in-file") {
          const timeValues = probedTimes.length > 1 ? probedTimes : await readMeshTimeSteps(fsPath);
          if (timeValues.length > 1) {
            session.inFileTimeValues = timeValues;
            session.currentGroup = undefined; // a probe format can switch shape between discoveries
            if (!session.disposed) {
              webviewPanel.webview.postMessage({
                type: "vtkGroup",
                fileName,
                group: {
                  modelPartName: fileName,
                  steps: timeValues.map((t) => String(t)),
                  subParts: [],
                  ranks: [0],
                },
              });
            }
            // A live-growth watcher re-runs discover(); keep the current
            // frame (clamped) rather than jumping back to the first step.
            await postInFileFrame(session.lastFrame.frameIndex, reason !== "reload");
            return;
          }
          session.inFileTimeValues = undefined; // single/no time step: fall through to the static path below
        }

        let found: ReturnType<typeof findGroupForFile>;
        if (kind === "filename") {
          const allFiles = await fs.promises.readdir(dir);
          const groups = groupVtkFiles(allFiles, TIMELINE_EXTENSIONS);
          found = findGroupForFile(groups, fileName);
        }

        if (!found) {
          // No Kratos-style siblings — parse just the opened file as a static view
          const solo = await parseMeshFile(
            fsPath,
            (phase, bytesRead, totalBytes) => {
              if (!session.disposed) {
                webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
              }
            }
          );
          // A watcher re-run reaches here too (the file grew on disk), so the
          // edit stack is kept and re-applied rather than discarded.
          const adopted = await adoptFrame(solo, reason !== "reload");
          session.lastModel = adopted.model;
          session.lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
          if (!session.disposed) {
            webviewPanel.webview.postMessage({
              type: "vtkFrame",
              model: toWireModel(adopted.model),
              frameIndex: 0,
              stepLabel: "",
            totalFrames: 1,
            midNodes: adopted.highlightNodes ?? [],
          });
          webviewPanel.webview.postMessage({ type: "opState", ...session.history.state() });
          maybeInitPt();
          await applyPendingOps();
          }
          return;
        }

        session.currentGroup = found.group;
        session.currentRank = found.rank;
        session.inFileTimeValues = undefined;
        const frameIndex = found.group.steps.indexOf(found.step);

        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkGroup",
            fileName,
            group: {
              modelPartName: found.group.modelPartName,
              steps: found.group.steps,
              subParts: found.group.subParts,
              ranks: found.group.ranks,
            },
          });
        }

        await postFrame(found.group, Math.max(frameIndex, 0), found.rank, reason !== "reload");
      } catch (err) {
        if (!session.disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        loadInProgress = false;
        if (rediscoverQueued && !session.disposed) {
          rediscoverQueued = false;
          const queuedReason = reloadQueued ? "reload" : "initial";
          reloadQueued = false;
          void discover(queuedReason);
        }
      }
    };

    // ---- Directory / file watcher --------------------------------------------

    // Only time-series-capable formats watch for newly written steps, and the
    // pattern comes from the same pure decision discover() branches on — a
    // directory glob for the filename grammar, the file itself (or, for a GiD
    // ascii pair, both halves) for an in-file series, nothing for a static
    // format. The two used to be computed apart with `path.extname`, and a GiD
    // file consequently got no watcher at all.
    let watcher: vscode.FileSystemWatcher | undefined;
    const watchGlob = timelineWatchGlob(fileName);
    if (watchGlob) {
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, watchGlob)
      );
      watcher.onDidCreate(scheduleRediscover);
      watcher.onDidChange(scheduleRediscover);
      watcher.onDidDelete(scheduleRediscover);
      session.track(watcher);
    }

    // A second, different question: can this file's CONTENT change without the
    // file changing? Only an OpenFOAM marker can — it is 0 bytes beside a
    // constant/polyMesh/ that blockMesh rewrites — so without this the preview
    // would sit stale through the whole meshing loop.
    let contentWatcher: vscode.FileSystemWatcher | undefined;
    const contentGlob = contentWatchGlob(fileName);
    if (contentGlob) {
      contentWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, contentGlob)
      );
      contentWatcher.onDidCreate(scheduleRediscover);
      contentWatcher.onDidChange(scheduleRediscover);
      contentWatcher.onDidDelete(scheduleRediscover);
      session.track(contentWatcher);
    }

    // ---- View-state tracking ------------------------------------------------

    const exportCtx = (): ExportContext | undefined => {
      if (!session.lastModel) {
        vscode.window.showWarningMessage(
          session.summaryShown
            ? "Only a header summary is loaded for this file. Choose \u201cOpen full mesh anyway\u201d first."
            : "The mesh is still loading; try again."
        );
        return undefined;
      }
      return { model: session.lastModel, fsPath, ops: session.history.appliedOps(), reportSink: (reports, show) => { if (!session.disposed) void webviewPanel.webview.postMessage({ type: "exportReport", reports, show }); } };
    };
    /** File ▸ Reload from disk / the kratos.mesh.reload command. */
    const handleReload = (): void => {
      if (captureLocked) { captureSourceChanged = true; webviewPanel.webview.postMessage({ type: "recordingSourceChanged" }); return; }
      void discover("reload");
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
      // because only VS Code can clear the dirty marker it set.
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
    // Bind the session to this document (roadmap item 14): the history, chip,
    // problemtype controller, op runner and save/revert/undo/redo hooks now
    // live on the shared session instead of this closure. Deliberately NOT
    // cleared in `onDidDispose` (see `PreviewSession.makeHooks`).
    session.bindDocument(document, {
      rerender: rerenderFromHistory,
      exportCtx,
      revert: () => discover("reload"),
    });
    this.activeMenuHandler = handleMenu;
    this.activeReloadHandler = handleReload;
    this.activePtController = session.ptController;
    this.activeDocument = document;

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

    // ---- Field time series ---------------------------------------------------
    //
    // Read one entity's value for one variable across EVERY step, without
    // going anywhere near postFrame: this must not rebase the edit history,
    // must not overwrite lastModel/lastFrame, and must not repaint the scene.
    // It is the reason route (b) was chosen over walking the timeline.

    let seriesAbort: AbortController | undefined;

    const FIELD_KINDS = ["Nodal", "Elemental", "Conditional"];

    const runFieldSeries = async (msg: Record<string, unknown>): Promise<void> => {
      const reply = (payload: Record<string, unknown>): void => {
        if (!session.disposed) {
          void webviewPanel.webview.postMessage({ type: "fieldSeriesResult", ...payload });
        }
      };
      if (seriesAbort) {
        reply({ message: "A time-series scan is already running." });
        return;
      }
      // Same trust boundary as applyOp: the message is raw webview input.
      const kind = String(msg.kind ?? "");
      const variable = String(msg.variable ?? "");
      const entityId = Number(msg.entityId);
      if (!FIELD_KINDS.includes(kind) || !variable || !Number.isFinite(entityId)) {
        reply({ message: "Invalid time-series request." });
        return;
      }
      const spec: FieldSeriesSpec = {
        kind: kind as FieldSeriesSpec["kind"],
        variable,
        entityId,
      };

      // Snapshot before the first await: discover() reassigns both of these on
      // a 500 ms watcher debounce, so a solver still writing steps could
      // otherwise swap the step list out from under the scan.
      const group = session.currentGroup;
      const rank = session.currentRank;
      const times = session.inFileTimeValues;
      const sampled = resampler ? new SequenceResampler(resampler.source,resampler.options) : undefined;
      const steps = sampled ? sampled.times.map((t,i)=>({label:String(t),frameIndex:i,load:()=>sampled.frame(i)})) : group
        ? stepsFromGroup(group, dir, rank)
        : times
          ? stepsFromInFile(fsPath, times)
          : [];
      if (steps.length === 0) {
        reply({ message: "This file has no time series to plot." });
        return;
      }

      seriesAbort = new AbortController();
      try {
        const series = await collectFieldSeries(steps, spec, {
          signal: seriesAbort.signal,
          onProgress: (done, total, label) => {
            if (!session.disposed) {
              void webviewPanel.webview.postMessage({
                type: "fieldSeriesProgress",
                done,
                total,
                label,
              });
            }
          },
        });
        // The scan reads the files as they are on disk. Applied operations are
        // NOT replayed per step — that would rebase a shared, mutable history
        // from a read-only path and cost roughly what scrubbing the timeline by
        // hand costs. Say so rather than let the numbers quietly disagree with
        // what Inspect shows.
        const applied = session.history.appliedCount();
        reply({
          series,
          historyNote:
            applied > 0
              ? `${applied} edit operation(s) are not applied to these values.`
              : undefined,
        });
      } catch (err) {
        reply({ message: err instanceof Error ? err.message : String(err) });
      } finally {
        seriesAbort = undefined;
      }
    };

    // ---- Flow-balance series ------------------------------------------------
    //
    // The same one-model-at-a-time walk as runFieldSeries, but through
    // `flowBalanceSeries` instead of `collectFieldSeries`: the panel's
    // "All steps" table. Same rules — snapshot before the first await, never
    // touch postFrame/adoptFrame/lastModel, skip mergeSubparts (sections read
    // SubModelParts, which stepsFromGroup already merges), one scan per panel,
    // abort on dispose, partial series on cancel.

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
        if (!session.disposed) {
          void webviewPanel.webview.postMessage({ type: "flowSeriesResult", ...payload });
        }
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

      // Snapshot before the first await (see runFieldSeries).
      const group = session.currentGroup;
      const rank = session.currentRank;
      const times = session.inFileTimeValues;
      const sampled = resampler ? new SequenceResampler(resampler.source,resampler.options) : undefined;
      const steps = sampled ? sampled.times.map((t,i)=>({label:String(t),frameIndex:i,load:()=>sampled.frame(i)})) : group
        ? stepsFromGroup(group, dir, rank)
        : times
          ? stepsFromInFile(fsPath, times)
          : [];
      if (steps.length === 0) {
        reply({ message: "This file has no time series to balance." });
        return;
      }

      flowSeriesAbort = new AbortController();
      try {
        const series = await flowBalanceSeries(steps, flow, {
          signal: flowSeriesAbort.signal,
          onProgress: (done, total, label) => {
            if (!session.disposed) {
              void webviewPanel.webview.postMessage({
                type: "flowSeriesProgress",
                done,
                total,
                label,
              });
            }
          },
        });
        // The scan reads the files as they are on disk; applied operations
        // are NOT replayed per step (see runFieldSeries).
        const applied = session.history.appliedCount();
        reply({
          series,
          historyNote:
            applied > 0
              ? `${applied} edit operation(s) are not applied to these values.`
              : undefined,
        });
      } catch (err) {
        reply({ message: err instanceof Error ? err.message : String(err) });
      } finally {
        flowSeriesAbort = undefined;
      }
    };

    // ---- Message handling ---------------------------------------------------

    const recording = new RecordingController(this.context.globalStorageUri.fsPath, fsPath, message => webviewPanel.webview.postMessage(message));
    webviewPanel.onDidDispose(() => recording.dispose());

    let plots: ReturnType<typeof createPlotController> | undefined;
    let plotPreviewReady!: () => void;
    const readyForPlot = new Promise<void>(resolve => { plotPreviewReady = resolve; });
    const unregisterPlot = plotPreviews.register(fsPath, {
      ready: readyForPlot,
      navigate: async (target, current, signal) => {
        // A refused handoff must not cancel a recording or other pending work.
        if(!current() || signal.aborted || session.disposed || captureLocked || loadInProgress || session.summaryShown || resampler || session.opRunner?.busy() || session.history.appliedCount() !== 0 || !session.lastModel)throw new Error("The owning preview is edited, resampled, recording, busy or unavailable; no navigation was applied.");
        const generation = ++frameRequestGeneration, group = session.currentGroup, rank = session.currentRank, times = session.inFileTimeValues, base = session.lastModel;
        const available = () => current() && !signal.aborted && !session.disposed && !captureLocked && !loadInProgress && !session.summaryShown && !resampler && !session.opRunner?.busy() && session.history.appliedCount() === 0 && !!base && session.lastModel === base && generation === frameRequestGeneration && group === session.currentGroup && rank === session.currentRank && times === session.inFileTimeValues;
        await navigatePlotPreview(target, {
          current: available,
          verify: async request => await runPlotWorker({runTarget:request},{signal}) as PlotRunTarget,
          load: async selected => {
            if(selected.timeline === "inFile"){
              if(!times || String(times[selected.frameIndex]) !== selected.label || selected.framePath !== fsPath)throw new Error("The owning preview's in-file timeline does not match the verified frame.");
              return parseMeshFile(fsPath,undefined,{timeStep:selected.frameIndex});
            }
            if(selected.timeline === "single")return parseMeshFile(selected.framePath);
            const step = group && stepsFromGroup(group,dir,rank).find(s => s.frameIndex === selected.frameIndex && s.path === selected.framePath && s.label === selected.label);
            if(!step)throw new Error("The owning preview's timeline/rank does not match the verified frame.");
            return step.load();
          },
          commit: (model, selected) => {
            if(session.history.hasBase())session.history.rebase(model);else session.history.setBase(model);
            session.lastModel=model;
            session.lastFrame={frameIndex:selected.frameIndex,stepLabel:selected.label,stepLabelKind:selected.timeline==="inFile"?"time":"step",totalFrames:times?.length??group?.steps.length??1};
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
        void discover().finally(plotPreviewReady);
      } else if (plots?.receive(msg)) {
        // Plot execution and dialogs are shared with the standalone workspace.
      } else if (msg?.type === "plotOpen") {
        plots ??= createPlotController(this.context,webviewPanel.webview,undefined,()=>{
          const timeline=JSON.stringify([session.currentGroup?.steps,session.inFileTimeValues,session.currentRank,resampler?.times,resampler?.options]);
          return {path:fsPath,model:session.lastModel,frameIndex:session.lastFrame.frameIndex,hasTimeline:(resampler?.times.length??session.currentGroup?.steps.length??session.inFileTimeValues?.length??0)>1,timelineId:timeline,pick:origin=>{
            if(timeline!==JSON.stringify([session.currentGroup?.steps,session.inFileTimeValues,session.currentRank,resampler?.times,resampler?.options])){void webviewPanel.webview.postMessage({type:"plotNotice",message:"Timeline changed; refresh the plot before locating samples."});return;}
            if(resampler&&origin.frameIndex!==undefined){void webviewPanel.webview.postMessage({type:"plotNotice",message:"Disk histories cannot navigate a resampled timeline. Restore the original timeline first."});return;}
            if(!session.disposed)void webviewPanel.webview.postMessage({type:"plotPick",origin});
          }};
        });
        plots.sendContext();void webviewPanel.webview.postMessage({type:"plotReveal",preset:msg.preset});
      } else if (msg?.type === "meshSummaryOpenFull") {
        session.userForcedFull = true;
        // "initial" on purpose: the base, the history and the pending ops were
        // never set up, and it is this run that must pick the recipe up.
        void discover("initial");
      } else if (msg?.type === "recordCaptureLock") {
        const wasChanged = captureSourceChanged;
        captureLocked = Boolean(msg.active);
        if (captureLocked) captureSourceChanged = false;
        else if (wasChanged) void discover("reload");
      } else if (msg?.type === "vtkCancelFrame") {
        frameRequestGeneration++;
      } else if (["resampleConfigure","resampleOriginal","resampleExport"].includes(msg?.type)) {
        if (captureLocked) return;
        const generation=++frameRequestGeneration;
        frameQueue=frameQueue.then(async()=>{
          if (!requestCurrent(generation)) return;
          if (msg.type === "resampleOriginal") { resampler?.clear();resampler=undefined;await discover();return; }
          const options=msg.options as ResampleOptions & ResampleSourceOptions;
          const source=await sequenceSource(fsPath,options);
          if (!requestCurrent(generation)) return;
          if (msg.type === "resampleExport") {
            const dest=await vscode.window.showSaveDialog({filters:{"PVD series":["pvd"]},title:"Export resampled series"});
            if (!dest) return;
            await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"Resampling sequence…",cancellable:true},async(_progress,token)=>{
              const abort=new AbortController();const sub=token.onCancellationRequested(()=>abort.abort());
              try { const mode=vscode.workspace.getConfiguration("kratos.export").get<ProvenanceMode>("provenance","auto");const result=await exportResampled(source,options,dest.fsPath,abort.signal,mode);announceReports(result.reports.map(expandCompactReport),`Exported ${result.frames} resampled frames.`,exportCtx()?.reportSink); } finally {sub.dispose();}
            });
          } else {
            const next=new SequenceResampler(source,options);
            await next.frame(0);
            if (!requestCurrent(generation)) return;
            resampler?.clear();resampler=next;
            webviewPanel.webview.postMessage({type:"vtkGroup",resampled:true,fileName,group:{modelPartName:fileName,steps:next.times.map(String),subParts:[],ranks:[session.currentRank]}});
            await postResampledFrame(0,undefined,generation);
          }
        }).catch(error=>{ webviewPanel.webview.postMessage({type:"vtkFrameError",message:String(error)});vscode.window.showErrorMessage(String(error)); });
      } else if (msg?.type === "vtkRequestFrame") {
        const fi = typeof msg.frameIndex === "number" ? msg.frameIndex : 0;
        if (captureLocked && typeof msg.requestId !== "number") return;
        const generation = ++frameRequestGeneration;
        frameQueue = frameQueue.then(async () => {
          if (!requestCurrent(generation)) return;
          if (resampler) await postResampledFrame(fi,msg.requestId,generation);
          else if (session.currentGroup) await postFrame(session.currentGroup, fi, session.currentRank, true, msg.requestId, generation, Boolean(msg.restoring));
          else if (session.inFileTimeValues) await postInFileFrame(fi, true, msg.requestId, generation, Boolean(msg.restoring));
          else webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId: msg.requestId, message: "Timeline is unavailable." });
        }).catch(error => webviewPanel.webview.postMessage({ type: "vtkFrameError", requestId: msg.requestId, message: String(error) })).then(() => {});
      } else if (msg?.type === "fieldSeries") {
        void runFieldSeries(msg as Record<string, unknown>);
      } else if (msg?.type === "fieldSeriesCancel") {
        seriesAbort?.abort();
      } else if (msg?.type === "flowSeries") {
        void runFlowSeries(msg as Record<string, unknown>);
      } else if (msg?.type === "flowSeriesCancel") {
        flowSeriesAbort?.abort();
      } else if (msg?.type === "setTheme") {
        const valid = ["auto", "dark", "light", "scientific"];
        if (valid.includes(msg.theme)) {
          void this.context.globalState.update("sceneTheme", msg.theme);
        }
      } else if (msg?.type === "screenshot") {
        void saveScreenshot(msg.data as string, fsPath);
      } else if (msg?.type === "recording") {
        recording.receive(msg);
      } else if (msg?.type === "menuReload") {
        handleReload();
      } else if (msg?.type === "ptState") {
        session.ptController?.onState(msg.state as CaseState);
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
      } else if (msg?.type === "opUndo") {
        session.doUndo();
      } else if (msg?.type === "opRedo") {
        session.doRedo();
      } else if (msg?.type === "opReapply") {
        // Runs the ops a frame change passed over (see MmgRunOptions.skipAsyncOps).
        if (session.history.hasBase()) void reapplyAll();
      } else if (msg?.type === "opClear") {
        // No markDirty: an empty stack is never dirty. The marker itself stays
        // latched until a save or File ▸ Revert File.
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
      } else if (msg?.type === "loadOps") {
        void (async () => {
          if (await loadOps(session.history, fsPath)) {
            await replayHistory();
            session.markDirty();
          }
        })();
      }
    });

    // ---- Disposal -----------------------------------------------------------

    this.panelsByPath.set(fsPath, {
      reveal: () => webviewPanel.reveal(webviewPanel.viewColumn, true),
      goToLatest: async () => {
        // Re-discover first: the solver has probably written steps since this
        // panel last looked, and discover() is what grows the timeline.
        await discover("reload");
        if (session.disposed) return;
        if (session.inFileTimeValues && session.inFileTimeValues.length > 0) {
          await postInFileFrame(session.inFileTimeValues.length - 1);
          return;
        }
        if (!session.currentGroup) return;
        await postFrame(session.currentGroup, session.currentGroup.steps.length - 1, session.currentRank);
      },
    });

    session.track(viewStateSub);
    session.track(msgSub);
    webviewPanel.onDidDispose(() => {
      this.panelsByPath.delete(fsPath);
      // Closing the preview must stop a scan; otherwise the host keeps parsing
      // hundreds of files for a webview that no longer exists.
      seriesAbort?.abort();
      flowSeriesAbort?.abort();
      streamlineAbort?.abort();
      if (rediscoverDebounce) clearTimeout(rediscoverDebounce);
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

  // ---- HTML (shared with MDPA provider) -------------------------------------

  private getHtml(webview: vscode.Webview, savedTheme: string): string {
    return renderPreviewHtml({
      webview,
      extensionUri: this.context.extensionUri,
      title: "VTK Preview",
      theme: savedTheme,
    });
  }
}

// ---- Subpart merging ---------------------------------------------------------

/**
 * Parses each subpart VTK file at the same step and merges them into the root
 * model's subModelParts list via coordinate-key matching.
 *
 * If a subpart's coordinates cannot be matched to the root (precision mismatch
 * or different mesh), the subpart is silently omitted from the SubModelPart
 * list (the caller can inspect rootModel.diagnostics for warnings).
 */
// ---- Utilities ---------------------------------------------------------------
