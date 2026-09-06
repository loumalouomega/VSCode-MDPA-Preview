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
import { parseMeshFile, readMeshTimeSteps } from "./parser/meshFileParser";
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
import { MdpaModel, SubModelPart } from "./parser/types";
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
import { MmgRunOptions } from "./parser/operations";
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
import { takePendingOps } from "./problemArchive";
import { RecentMeshStore } from "./recentMeshes";

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
    // Remembered for the sidebar's "Recent Meshes" list. Here rather than in
    // each caller because every route to a preview — the Open dialog, the
    // Explorer, a problem archive, a recents row — arrives through this method.
    this.recents.record(fsPath);
    const dir = path.dirname(fsPath);
    const fileName = path.basename(fsPath);
    let disposed = false;
    let loadInProgress = false;
    /** A discover() arrived while one was running; re-run once it finishes. */
    let rediscoverQueued = false;
    let reloadQueued = false;
    let currentGroup: VtkFileGroup | undefined;
    let currentRank = 0;
    // Set instead of currentGroup for a single-file, in-file timeline
    // (currently Exodus) — mutually exclusive with currentGroup.
    let inFileTimeValues: number[] | undefined;
    let lastModel: MdpaModel | undefined;
    /** Sticky for the panel's lifetime once the user presses Open full mesh anyway. */
    let userForcedFull = false;
    /** What the last load decided, so a reload cannot flip modes. See shouldSummarize. */
    let summaryShown = false;
    // Meta of the last frame posted, so an in-place operation can re-post it.
    let lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
    const history = new OperationHistory();
    /**
     * Marks the tab unsaved. One rule for every mutation site: dirty means
     * "operations are applied that the file on disk does not have", so a
     * clamped undo at cursor 0 or a Clear that empties the stack never claims
     * unsaved work.
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
    // Catalog + saved case are model-independent; send them once, after the
    // first frame lands (mirrors the MDPA provider's post-parse refresh).
    const maybeInitPt = (): void => {
      if (!ptInitialized) {
        ptInitialized = true;
        void ptController.refresh();
      }
    };

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

    // Re-render the current frame from the history state (camera preserved).
    const rerenderFromHistory = async (opts?: MmgRunOptions): Promise<void> => {
      if (disposed || !history.hasBase()) return;
      const cur = await history.current(opts);
      if (disposed) return;
      lastModel = cur.model;
      webviewPanel.webview.postMessage({
        type: "vtkFrame",
        model: cur.model,
        frameIndex: lastFrame.frameIndex,
        stepLabel: lastFrame.stepLabel,
        totalFrames: lastFrame.totalFrames,
        midNodes: cur.highlightNodes ?? [],
      });
      webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
    };

    // Apply a newly requested operation, or a queued batch of several; params
    // ride along on the message. MMG ops (and any batch) stream their state
    // into the sidebar's inline loading bar (`opProgress` messages) and are
    // cancellable via `opCancel` → abort. Shared with mdpaEditorProvider.ts,
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
      if (!history.hasBase()) {
        history.setBase(model);
        return { model };
      }
      history.rebase(model);
      // Nothing applied: the tail is kept, but there is nothing to run — and
      // returning here is also what keeps a zero-op replay out of the
      // cancellable notification below.
      if (history.appliedCount() === 0) return { model };
      let out: { model: MdpaModel; highlightNodes?: number[] } = { model };
      const run = async (opts?: MmgRunOptions): Promise<void> => {
        const r = await history.replayOntoBase({ ...opts, skipAsyncOps });
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
        const r = await history.replayOntoBase(opts);
        if (disposed) return;
        lastModel = r.model;
        webviewPanel.webview.postMessage({
          type: "vtkFrame",
          model: r.model,
          frameIndex: lastFrame.frameIndex,
          stepLabel: lastFrame.stepLabel,
          totalFrames: lastFrame.totalFrames,
          midNodes: r.highlightNodes ?? [],
        });
        webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
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
        history.load(recipe);
        await replayHistory();
        // The file on disk has none of these edits.
        markDirty();
      }
    };

    // ---- Frame loading -------------------------------------------------------

    const postFrame = async (
      group: VtkFileGroup,
      frameIndex: number,
      rank: number,
      skipAsyncOps = true
    ): Promise<void> => {
      if (disposed) return;
      const step = group.steps[frameIndex];
      if (step === undefined) return;

      const rootFile = fileFor(group, group.rootPrefix, rank, step);
      if (!rootFile) return;

      try {
        const rootPath = path.join(dir, rootFile);
        const rootModel = await parseMeshFile(
          rootPath,
          (phase, bytesRead, totalBytes) => {
            if (!disposed) {
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

        const adopted = await adoptFrame(rootModel, skipAsyncOps);
        lastModel = adopted.model;
        lastFrame = { frameIndex, stepLabel: step, totalFrames: group.steps.length };
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame",
            model: adopted.model,
            frameIndex,
            stepLabel: step,
            totalFrames: group.steps.length,
            midNodes: adopted.highlightNodes ?? [],
          });
          webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
          maybeInitPt();
          await applyPendingOps();
        }
      } catch (err) {
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    // A single Exodus (or other in-file-timeline format) file carries every
    // step itself, so this re-parses the SAME fsPath with a `timeStep`
    // rather than switching files like postFrame does.
    const postInFileFrame = async (
      frameIndex: number,
      skipAsyncOps = true
    ): Promise<void> => {
      if (disposed) return;
      const timeValues = inFileTimeValues;
      if (!timeValues) return;
      const clamped = Math.min(Math.max(frameIndex, 0), timeValues.length - 1);
      try {
        const model = await parseMeshFile(
          fsPath,
          (phase, bytesRead, totalBytes) => {
            if (!disposed) {
              webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
            }
          },
          { timeStep: clamped }
        );
        const adopted = await adoptFrame(model, skipAsyncOps);
        lastModel = adopted.model;
        lastFrame = {
          frameIndex: clamped,
          stepLabel: String(timeValues[clamped] ?? ""),
          totalFrames: timeValues.length,
        };
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame",
            model: adopted.model,
            frameIndex: clamped,
            stepLabel: lastFrame.stepLabel,
            totalFrames: timeValues.length,
            midNodes: adopted.highlightNodes ?? [],
          });
          webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
          maybeInitPt();
          await applyPendingOps();
        }
      } catch (err) {
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
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
      if (rediscoverDebounce) clearTimeout(rediscoverDebounce);
      rediscoverDebounce = setTimeout(() => void discover("reload"), 500);
    };

    // ---- Initial discovery --------------------------------------------------

    const discover = async (reason: "initial" | "reload" = "initial"): Promise<void> => {
      if (disposed) return;
      if (loadInProgress) {
        // Queue instead of DROPPING: a solver writing steps quickly fires the
        // watcher while a parse is in flight, and dropping the call meant the
        // final state could simply never be shown.
        rediscoverQueued = true;
        if (reason === "reload") reloadQueued = true;
        return;
      }
      loadInProgress = true;
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
        if (shouldSummarize({ fileSize, thresholdMb, reason, userForcedFull, summaryShown })) {
          const summary = await summarizeMeshFile(fsPath);
          summaryShown = true;
          if (!disposed) {
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
        summaryShown = false;

        // One pure decision, shared with fieldSeriesScan's discoverSeriesSteps.
        // This used to be two `includes` over `path.extname`, which reads
        // ".msh" for a GiD "case.post.msh" — matching neither list, so the
        // file silently lost its timeline and its watcher.
        const kind = timelineKindFor(fileName);

        if (kind === "in-file") {
          const timeValues = await readMeshTimeSteps(fsPath);
          if (timeValues.length > 1) {
            inFileTimeValues = timeValues;
            if (!disposed) {
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
            await postInFileFrame(lastFrame.frameIndex, reason !== "reload");
            return;
          }
          inFileTimeValues = undefined; // single/no time step: fall through to the static path below
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
              if (!disposed) {
                webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
              }
            }
          );
          // A watcher re-run reaches here too (the file grew on disk), so the
          // edit stack is kept and re-applied rather than discarded.
          const adopted = await adoptFrame(solo, reason !== "reload");
          lastModel = adopted.model;
          lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
          if (!disposed) {
            webviewPanel.webview.postMessage({
              type: "vtkFrame",
              model: adopted.model,
              frameIndex: 0,
              stepLabel: "",
            totalFrames: 1,
            midNodes: adopted.highlightNodes ?? [],
          });
          webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
          maybeInitPt();
          await applyPendingOps();
          }
          return;
        }

        currentGroup = found.group;
        currentRank = found.rank;
        const frameIndex = found.group.steps.indexOf(found.step);

        if (!disposed) {
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
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        loadInProgress = false;
        if (rediscoverQueued && !disposed) {
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
    }

    // ---- View-state tracking ------------------------------------------------

    const exportCtx = (): ExportContext | undefined => {
      if (!lastModel) {
        vscode.window.showWarningMessage(
          summaryShown
            ? "Only a header summary is loaded for this file. Choose \u201cOpen full mesh anyway\u201d first."
            : "The mesh is still loading; try again."
        );
        return undefined;
      }
      return { model: lastModel, fsPath, ops: history.appliedOps() };
    };
    /** File ▸ Reload from disk / the kratos.mesh.reload command. */
    const handleReload = (): void => {
      void discover("reload");
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
      void runMenu(msg, exportCtx, this.context);
    };
    this.activeMenuHandler = handleMenu;
    this.activeReloadHandler = handleReload;
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
     * What the custom-editor lifecycle and the undo/redo commands get to see —
     * they are handed only a document, while everything they need is here.
     *
     * Deliberately NOT cleared in `onDidDispose`, unlike the `active*` fields:
     * closing a dirty tab makes VS Code show its save prompt and call
     * `saveCustomDocument` DURING teardown, and nothing these close over needs
     * a live webview.
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
        await discover("reload");
      },
      undo: doUndo,
      redo: doRedo,
    };
    this.activeDocument = document;

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
        if (!disposed) {
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
      const group = currentGroup;
      const rank = currentRank;
      const times = inFileTimeValues;
      const steps = group
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
            if (!disposed) {
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
        const applied = history.appliedCount();
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

    // ---- Message handling ---------------------------------------------------

    const pendingFrames: PendingFrame[] = [];

    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        void discover();
      } else if (msg?.type === "meshSummaryOpenFull") {
        userForcedFull = true;
        // "initial" on purpose: the base, the history and the pending ops were
        // never set up, and it is this run that must pick the recipe up.
        void discover("initial");
      } else if (msg?.type === "vtkRequestFrame") {
        const fi = typeof msg.frameIndex === "number" ? msg.frameIndex : 0;
        if (currentGroup) {
          void postFrame(currentGroup, fi, currentRank);
        } else if (inFileTimeValues) {
          void postInFileFrame(fi);
        }
      } else if (msg?.type === "fieldSeries") {
        void runFieldSeries(msg as Record<string, unknown>);
      } else if (msg?.type === "fieldSeriesCancel") {
        seriesAbort?.abort();
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
        if (history.hasBase()) void reapplyAll();
      } else if (msg?.type === "opClear") {
        // No markDirty: an empty stack is never dirty. The marker itself stays
        // latched until a save or File ▸ Revert File.
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

    // ---- Disposal -----------------------------------------------------------

    this.panelsByPath.set(fsPath, {
      reveal: () => webviewPanel.reveal(webviewPanel.viewColumn, true),
      goToLatest: async () => {
        // Re-discover first: the solver has probably written steps since this
        // panel last looked, and discover() is what grows the timeline.
        await discover("reload");
        if (disposed || !currentGroup) return;
        await postFrame(currentGroup, currentGroup.steps.length - 1, currentRank);
      },
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      this.panelsByPath.delete(fsPath);
      // Closing the preview must stop a scan; otherwise the host keeps parsing
      // hundreds of files for a webview that no longer exists.
      seriesAbort?.abort();
      if (rediscoverDebounce) clearTimeout(rediscoverDebounce);
      watcher?.dispose();
      contentWatcher?.dispose();
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
async function mergeSubparts(
  rootModel: MdpaModel,
  group: VtkFileGroup,
  dir: string,
  rank: number,
  step: string,
  rootPrefix: string
): Promise<SubModelPart[]> {
  if (group.subParts.length === 0) return [];

  // Build coord → rootNodeId lookup
  const coordMap = buildCoordMap(rootModel);

  // Build connectivity key → root entityId lookup
  const entityMap = buildEntityMap(rootModel);

  const subModelParts: SubModelPart[] = [];

  for (const subSuffix of group.subParts) {
    const subPrefix = `${rootPrefix}_${subSuffix}`;
    const subFile = fileFor(group, subPrefix, rank, step);
    if (!subFile) continue;

    let subModel: MdpaModel;
    try {
      subModel = await parseMeshFile(path.join(dir, subFile));
    } catch {
      rootModel.diagnostics.push({
        line: 0,
        message: `Could not parse subpart file ${subFile}; subpart omitted.`,
      });
      continue;
    }

    // Map subpart 1-based nodeIds → root nodeIds via coordinates
    const subToRoot = new Array<number>(subModel.nodeCount).fill(0);
    let mismatches = 0;
    for (let i = 0; i < subModel.nodeCount; i++) {
      const key = coordKey(
        subModel.coords[i * 3],
        subModel.coords[i * 3 + 1],
        subModel.coords[i * 3 + 2]
      );
      const rootNodeId = coordMap.get(key);
      if (rootNodeId !== undefined) {
        subToRoot[i] = rootNodeId; // 1-based
      } else {
        mismatches++;
      }
    }

    if (mismatches > 0) {
      rootModel.diagnostics.push({
        line: 0,
        message: `Subpart "${subSuffix}": ${mismatches} of ${subModel.nodeCount} node(s) could not be matched to the root mesh by coordinates.`,
      });
    }

    // Collect matched root nodeIds
    const nodeIds: number[] = [];
    for (const id of subToRoot) {
      if (id > 0) nodeIds.push(id);
    }

    // Map subpart cells → root entityIds via connectivity
    const elementIds: number[] = [];
    for (const blk of subModel.blocks) {
      for (let e = 0; e < blk.count; e++) {
        // Translate 1-based subpart connectivity to root 1-based node ids
        const rootNodes: number[] = [];
        for (let k = 0; k < blk.stride; k++) {
          const subNodeId = blk.connectivity[e * blk.stride + k]; // 1-based in subModel
          const rootNodeId = subToRoot[subNodeId - 1] ?? 0;
          rootNodes.push(rootNodeId);
        }
        const key = connectKey(rootNodes);
        const rootEntityId = entityMap.get(key);
        if (rootEntityId !== undefined) elementIds.push(rootEntityId);
      }
    }

    // Build the path relative to root (dotted notation for display)
    const subName = subSuffix.includes("_")
      ? subSuffix.split("_").pop() ?? subSuffix
      : subSuffix;
    const partPath = `${rootPrefix}.${subSuffix}`;

    subModelParts.push({
      name: subSuffix,
      nodeIds: new Int32Array(nodeIds),
      elementIds: new Int32Array(elementIds),
      conditionIds: new Int32Array(0),
      geometryIds: new Int32Array(0),
      constraintIds: new Int32Array(0),
      path: partPath,
      children: [],
    });
  }

  return subModelParts;
}

function coordKey(x: number, y: number, z: number): string {
  return `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
}

function buildCoordMap(model: MdpaModel): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < model.nodeCount; i++) {
    const key = coordKey(
      model.coords[i * 3],
      model.coords[i * 3 + 1],
      model.coords[i * 3 + 2]
    );
    map.set(key, model.nodeIds[i]);
  }
  return map;
}

function connectKey(nodeIds: number[]): string {
  return [...nodeIds].sort((a, b) => a - b).join(",");
}

function buildEntityMap(model: MdpaModel): Map<string, number> {
  const map = new Map<string, number>();
  for (const blk of model.blocks) {
    for (let e = 0; e < blk.count; e++) {
      const nodes: number[] = [];
      for (let k = 0; k < blk.stride; k++) {
        nodes.push(blk.connectivity[e * blk.stride + k]);
      }
      map.set(connectKey(nodes), blk.entityIds[e]);
    }
  }
  return map;
}

// ---- Utilities ---------------------------------------------------------------

