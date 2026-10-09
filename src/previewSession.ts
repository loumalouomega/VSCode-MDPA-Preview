/**
 * The per-panel preview session (former roadmap item 14).
 *
 * Each preview panel — an MDPA custom editor, a VTK custom editor, or the
 * standalone empty shell — owns exactly one `PreviewSession`. It holds what
 * `resolveCustomEditor` used to close over per panel: the `OperationHistory`,
 * the loaded model, the header-summary flags, the document chip reporter, the
 * problemtype controller, the op runner, the engine relay and the Flowgraph
 * lifecycle. It can be constructed *before* a file is known (the empty shell),
 * then bound late with `bindDocument`, keeping the same `WebviewPanel` and its
 * layout and view state instead of opening a second tab.
 *
 * File decisions (what survives a re-bind) live in the pure
 * `parser/previewSessionCore.ts` so they are Node-testable; this module is the
 * vscode glue and follows the same core/glue split as `opHistoryCore.ts` /
 * `opHistory.ts`. The shared `RunManager` is injected, never owned — run views
 * keep projecting the single registry no matter how many sessions exist.
 */

import * as vscode from "vscode";

import { MdpaModel } from "./parser/types";
import { OperationHistory } from "./opHistory";
import { DocumentInfoReporter, EngineStatusMessage } from "./documentInfo";
import { engineState, onEngineChange } from "./engineActivity";
import { PtController } from "./ptController";
import { createOpRunner, OpRunner } from "./opApply";
import { FlowgraphController } from "./flowgraphController";
import { RunManager } from "./runManager";
import { RecentMeshStore } from "./recentMeshes";
import { MeshPreviewDocument, MeshEditorHooks } from "./meshDocument";
import { ExportContext, saveMesh, saveMeshToPath } from "./meshExport";
import { MmgRunOptions, OP_LABELS } from "./parser/operations";
import { VtkFileGroup } from "./parser/vtkFileGroup";
import {
  bindSessionFileState,
  flagsForBind,
  sessionFileName,
} from "./parser/previewSessionCore";

/** What a session needs that it must not own. */
export interface PreviewSessionDeps {
  context: vscode.ExtensionContext;
  flowgraph: FlowgraphController;
  runs: RunManager;
  recents: RecentMeshStore;
  panel: vscode.WebviewPanel;
  /** Fires the provider's dirty event; a no-op for the empty shell. */
  onDirty: (document: MeshPreviewDocument) => void;
}

/** Format-specific closures a session drives but never implements. */
export interface SessionOps {
  /** Re-renders from the session history (owns `lastModel` + the webview post). */
  rerender: (opts?: MmgRunOptions) => Promise<void>;
  /** Builds the File-menu export context, or warns and returns undefined. */
  exportCtx: () => ExportContext | undefined;
  /** Re-reads the bound file from disk (provider discovery / postModel). */
  revert: () => Promise<void>;
}

export class PreviewSession {
  public history: OperationHistory = new OperationHistory();
  public lastModel: MdpaModel | undefined;
  public fsPath: string | undefined;
  public fileName: string | undefined;
  public userForcedFull = false;
  public summaryShown = false;
  public docInfo: DocumentInfoReporter | undefined;
  public ptController: PtController | undefined;
  public opRunner: OpRunner | undefined;
  public document: MeshPreviewDocument | undefined;
  public ptInitialized = false;
  public disposed = false;
  public flowgraphAcquired = false;
  // Timeline state both providers closed over per panel (filename series,
  // in-file steps, and the frame on screen). Owned here so the empty shell
  // binds the same timeline in place instead of reimplementing it.
  public currentGroup: VtkFileGroup | undefined;
  public currentRank = 0;
  public frameFile: string | undefined;
  public lastFrame: { frameIndex: number; stepLabel: string; totalFrames: number; stepLabelKind?: "time" | "step" } = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
  public inFileTimeValues: number[] | undefined;

  private rerenderFn: SessionOps["rerender"] | undefined;
  private exportCtxFn: SessionOps["exportCtx"] | undefined;
  private revertFn: SessionOps["revert"] | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly engineOff: () => void;

  constructor(private readonly deps: PreviewSessionDeps) {
    this.engineOff = onEngineChange(() => this.postEngineStatus());
  }

  /** The panel this session drives (stable for the panel's lifetime). */
  public get panel(): vscode.WebviewPanel {
    return this.deps.panel;
  }

  /** True once a file is bound; false for a fresh empty shell. */
  public get isBound(): boolean {
    return this.fsPath !== undefined;
  }

  /**
   * Bind (or re-bind) a document, (re-)creating the file-scoped controllers.
   *
   * The history resets only when the file actually changes (`flagsForBind`):
   * a re-bind of the same file — e.g. the empty shell re-resolving — keeps the
   * edit stack, while a different file starts clean so the new file's first
   * parse can `setBase` rather than rebasing unrelated ops onto it.
   */
  public bindDocument(document: MeshPreviewDocument, ops: SessionOps): void {
    const nextFsPath = document.uri.fsPath;
    const { flags, historyReset } = flagsForBind(
      this.fsPath,
      nextFsPath,
      { userForcedFull: this.userForcedFull, summaryShown: this.summaryShown }
    );
    this.userForcedFull = flags.userForcedFull;
    this.summaryShown = flags.summaryShown;
    if (historyReset) {
      this.history = new OperationHistory();
      this.lastModel = undefined;
      this.currentGroup = undefined;
      this.currentRank = 0;
      this.frameFile = nextFsPath;
      this.lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
      this.inFileTimeValues = undefined;
    } else if (this.frameFile === undefined) {
      this.frameFile = nextFsPath;
    }
    this.ptController?.dispose();
    this.document = document;
    this.fsPath = nextFsPath;
    this.fileName = sessionFileName(nextFsPath);
    void bindSessionFileState(nextFsPath);
    this.rerenderFn = ops.rerender;
    this.exportCtxFn = ops.exportCtx;
    this.revertFn = ops.revert;
    this.deps.recents.record(nextFsPath);
    this.docInfo = new DocumentInfoReporter(nextFsPath, this.history, (m) => {
      if (!this.disposed) void this.deps.panel.webview.postMessage(m);
    });
    this.ptController = new PtController(
      nextFsPath,
      () => this.lastModel,
      (m) => {
        if (!this.disposed) void this.deps.panel.webview.postMessage(m);
      },
      this.deps.runs
    );
    this.opRunner = createOpRunner({
      history: this.history,
      webviewPanel: this.deps.panel,
      getLastModel: () => this.lastModel,
      isDisposed: () => this.disposed,
      rerender: (o) => this.rerenderFn?.(o) ?? Promise.resolve(),
      onHistoryChanged: () => this.markDirty(),
    });
    document.hooks = this.makeHooks();
    this.ptInitialized = false;
  }

  /** Own an extra disposable (watchers, subscriptions) for the panel's lifetime. */
  public track(disposable: vscode.Disposable): void {
    this.disposables.push(disposable);
  }

  /** Marks the tab unsaved when edits are applied; the chip syncs every time. */
  public markDirty(): void {
    if (this.document && this.history.appliedCount() > 0) {
      this.deps.onDirty(this.document);
    }
    this.docInfo?.sync();
  }

  /** Relays the process-wide engine activity to this panel only. */
  public postEngineStatus(): void {
    if (this.disposed) return;
    const m: EngineStatusMessage = { type: "engineStatus", state: engineState() };
    void this.deps.panel.webview.postMessage(m);
  }

  /** Sends the problemtype catalog + saved case once per bound file. */
  public ensurePt(): void {
    if (this.ptInitialized) return;
    this.ptInitialized = true;
    void this.ptController?.refresh();
  }

  /** Acquires the shared Flowgraph server and seeds it from the current case. */
  public async startFlowgraph(): Promise<void> {
    try {
      const endpoint = await this.deps.flowgraph.acquire();
      this.flowgraphAcquired = true;
      if (this.disposed) {
        this.deps.flowgraph.release();
        this.flowgraphAcquired = false;
        return;
      }
      void this.deps.panel.webview.postMessage({
        type: "flowgraphReady",
        url: endpoint.url,
        origin: endpoint.origin,
      });
      const json = await this.ptController?.getProjectParametersJson();
      if (json && !this.disposed) {
        void this.deps.panel.webview.postMessage({ type: "flowgraphLoadParams", json });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.disposed) {
        void this.deps.panel.webview.postMessage({ type: "flowgraphError", message });
      }
    }
  }

  /** Releases the shared Flowgraph server when held. */
  public stopFlowgraph(): void {
    if (this.flowgraphAcquired) {
      this.deps.flowgraph.release();
      this.flowgraphAcquired = false;
    }
  }

  /** Undo one op and re-render; a clamped cursor is a no-op. */
  public doUndo(): void {
    this.history.undo();
    this.markDirty();
    void this.rerenderFn?.();
  }

  /**
   * Redo one op and re-render, recording when the crossed op quietly became a
   * noop against a base that changed under it (a watcher tick, a timeline
   * step) instead of leaving the row looking applied.
   */
  public doRedo(): void {
    const before = this.history.appliedCount();
    this.history.redo();
    if (this.history.appliedCount() === before) return;
    this.markDirty();
    const crossed = this.history.appliedCount() - 1;
    void this.rerenderFn?.({
      onOutcome: (index, rec, out) => {
        if (index !== crossed) return;
        this.history.noteStatus(index, out.noop ? "noop" : "applied", out.message);
        if (out.noop) {
          void vscode.window.showWarningMessage(
            out.message ?? `"${OP_LABELS[rec.op]}" no longer applies here; nothing changed.`
          );
        }
      },
    });
  }

  /**
   * What the custom-editor lifecycle and the undo/redo commands see. Kept on
   * the session — not duplicated per provider — and deliberately left in place
   * on dispose: closing a dirty tab calls `saveCustomDocument` during teardown,
   * and nothing here needs a live webview.
   */
  public makeHooks(): MeshEditorHooks {
    return {
      ops: () => this.history.appliedOps(),
      save: async () => {
        const ctx = this.exportCtxFn?.();
        const wrote = ctx ? await saveMesh(ctx, this.deps.context) : false;
        if (wrote) this.docInfo?.markSaved();
        return wrote;
      },
      saveAs: async (destination) => {
        const ctx = this.exportCtxFn?.();
        return ctx ? saveMeshToPath(ctx, destination.fsPath) : false;
      },
      revert: async () => {
        this.history.clear();
        this.docInfo?.markReverted();
        await this.revertFn?.();
      },
      undo: () => this.doUndo(),
      redo: () => this.doRedo(),
    };
  }

  /** Tears down the file-scoped controllers and every tracked disposable. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFlowgraph();
    this.ptController?.dispose();
    this.engineOff();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
