/**
 * The standalone, file-less preview — the "Open Empty Preview" action in the
 * Kratos sidebar.
 *
 * It is a session shell, not just a launcher: it owns a `PreviewSession`
 * (former roadmap item 14) constructed before any file is known, over the same chrome
 * as the real previews. `File ▸ Open` picks a mesh and binds it **in place**
 * with `session.bindDocument` — the same session both custom-editor providers
 * construct in `resolveCustomEditor` — so the panel keeps its layout and view
 * state and no second tab opens. A cancelled dialog leaves the shell standing.
 *
 * File ownership stays explicit: the session records the bound path for recent
 * meshes, problem cases and the document chip, and the hot-exit, dirty-marker
 * and save hooks live on the session rather than being duplicated per
 * provider. The shared `RunManager` is injected, never owned. `WebviewPanel`
 * tabs have no VS Code dirty dot, so edits show in the document chip and in a
 * `•` title suffix that clears on save/revert, mimicking the custom-editor
 * latch; window reloads revive the panel through the registered serializer,
 * which re-binds the persisted file and replays its ops recipe.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

import { PreviewSession } from "./previewSession";
import { MeshPreviewDocument } from "./meshDocument";
import { previewWebviewOptions, renderPreviewHtml } from "./previewHtml";
import {
  ExportContext,
  MenuMessage,
  MESH_PICK_TARGETS,
  pickMergeMeshFile,
  runMenu,
} from "./meshExport";
import { loadProblem, registerPendingOps, takePendingOps } from "./problemArchive";
import { FlowgraphController } from "./flowgraphController";
import { RunManager } from "./runManager";
import { RecentMeshStore } from "./recentMeshes";
import { parseMdpaFile } from "./parser/mdpaParser";
import {
  parseMeshFile,
  probeInFileSteps,
  readMeshTimeSteps,
} from "./parser/meshFileParser";
import {
  TIMELINE_EXTENSIONS,
  contentWatchGlob,
  timelineKindFor,
  timelineWatchGlob,
} from "./parser/meshFormats";
import {
  findGroupForFile,
  fileFor,
  groupVtkFiles,
} from "./parser/vtkFileGroup";
import { mergeSubparts } from "./parser/seriesSubparts";
import {
  collectFieldSeries,
  stepsFromGroup,
  stepsFromInFile,
} from "./parser/fieldSeriesScan";
import { flowBalanceSeries, FlowBalanceSpec } from "./parser/flowBalance";
import {
  meshSourceBytes,
  shouldSummarize,
  summarizeMeshFile,
  SUMMARY_THRESHOLD_MB_DEFAULT,
} from "./parser/meshSummary";
import { MdpaModel } from "./parser/types";
import { toWireModel } from "./parser/modelWire";
import { meshExtname } from "./parser/meshFormats";
import { MeshAnalysisMessage, runMeshAnalysis } from "./meshAnalysis";
import { runStreamlinesInWorker } from "./streamlineWorkerClient";
import { replayWithProgress, saveOps, loadOps } from "./opHistory";
import { saveScreenshot } from "./mediaExport";
import { RecordingController } from "./recordingController";
import { createPlotController } from "./plotController";
import { MmgRunOptions } from "./parser/operations";
import {
  dirtyPanelTitle,
  sessionTitleFor,
} from "./parser/previewSessionCore";

export const VIEW_TYPE = "kratos.emptyPreview";

/** Persisted across window reloads so the serializer can re-bind the file. */
const EMPTY_SESSION_KEY = "emptyPreviewSession";

interface PersistedEmptySession {
  fsPath: string;
  ops: ReturnType<PreviewSession["history"]["appliedOps"]>;
}

export interface EmptyPreviewDeps {
  flowgraph: FlowgraphController;
  runs: RunManager;
  recents: RecentMeshStore;
}

/** At most one shell at a time — a second would just be another empty viewport. */
let current: vscode.WebviewPanel | undefined;
let currentSession: PreviewSession | undefined;

function persistSession(
  context: vscode.ExtensionContext,
  session: PreviewSession
): void {
  if (!session.fsPath) {
    void context.globalState.update(EMPTY_SESSION_KEY, undefined);
    return;
  }
  const persisted: PersistedEmptySession = {
    fsPath: session.fsPath,
    ops: session.history.appliedOps(),
  };
  void context.globalState.update(EMPTY_SESSION_KEY, persisted);
}

function readPersisted(context: vscode.ExtensionContext): PersistedEmptySession | undefined {
  const raw = context.globalState.get<PersistedEmptySession>(EMPTY_SESSION_KEY);
  if (!raw || typeof raw.fsPath !== "string" || !Array.isArray(raw.ops)) return undefined;
  return raw;
}

function syncTitle(panel: vscode.WebviewPanel, session: PreviewSession, dirty: boolean): void {
  const base = session.fileName ?? "Kratos Preview";
  panel.title = dirtyPanelTitle(base, dirty);
}

export function openEmptyPreview(
  context: vscode.ExtensionContext,
  deps: EmptyPreviewDeps
): void {
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
  attachEmptyPanel(panel, context, deps);
  panel.onDidDispose(() => {
    if (current === panel) {
      current = undefined;
      currentSession = undefined;
    }
  });
}

/**
 * Revives the shell after a window reload (hot-exit). Re-binds the persisted
 * file, if it still exists, and replays its ops recipe on the first base —
 * the same consume-once discipline the custom editors use.
 */
export async function restoreEmptyPreview(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  deps: EmptyPreviewDeps
): Promise<void> {
  current = panel;
  const bound = attachEmptyPanel(panel, context, deps);
  const persisted = readPersisted(context);
  if (persisted && fs.existsSync(persisted.fsPath)) {
    await bound.bindPickedFile(persisted.fsPath, "initial");
    if (persisted.ops.length > 0 && bound.session.history.hasBase()) {
      bound.session.history.load(persisted.ops);
      await bound.replayHistory();
      bound.session.markDirty();
      bound.syncTitleDirty();
      persistSession(context, bound.session);
    }
  }
  panel.onDidDispose(() => {
    if (current === panel) {
      current = undefined;
      currentSession = undefined;
    }
  });
}

interface AttachedEmpty {
  session: PreviewSession;
  bindPickedFile: (fsPath: string, reason?: "initial" | "reload") => Promise<void>;
  replayHistory: () => Thenable<void>;
  syncTitleDirty: () => void;
}

function attachEmptyPanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  deps: EmptyPreviewDeps
): AttachedEmpty {
  panel.webview.html = renderPreviewHtml({
    webview: panel.webview,
    extensionUri: context.extensionUri,
    title: "Kratos Preview",
    theme: context.globalState.get<string>("sceneTheme", "auto"),
    startEmpty: true,
  });

  const session = new PreviewSession({
    context,
    flowgraph: deps.flowgraph,
    runs: deps.runs,
    recents: deps.recents,
    panel,
    onDirty: () => {
      syncTitle(panel, session, true);
      persistSession(context, session);
    },
  });
  currentSession = session;

  let titleDirty = false;
  const syncTitleDirty = (): void => {
    titleDirty = session.history.appliedCount() > 0;
    syncTitle(panel, session, titleDirty);
  };
  const markClean = (): void => {
    titleDirty = false;
    syncTitle(panel, session, false);
    persistSession(context, session);
  };

  // ---- Loading -----------------------------------------------------------
  let loadInProgress = false;
  let queuedReload = false;
  let fileWatchers: vscode.Disposable[] = [];
  let captureLocked = false;
  let captureSourceChanged = false;

  const isMdpa = (p: string): boolean => meshExtname(p) === ".mdpa";

  const postModelMessage = (model: MdpaModel, keepCamera: boolean): void => {
    const name = session.fileName ?? path.basename(session.fsPath ?? "mesh");
    if (session.currentGroup || session.inFileTimeValues) {
      panel.webview.postMessage({
        type: "vtkFrame",
        model: toWireModel(model),
        ...session.lastFrame,
        midNodes: [],
      });
    } else if (isMdpa(session.fsPath ?? "")) {
      panel.webview.postMessage({
        type: "model",
        model: toWireModel(model),
        fileName: name,
        keepCamera,
      });
    } else {
      panel.webview.postMessage({
        type: "vtkFrame",
        model: toWireModel(model),
        frameIndex: 0,
        stepLabel: "",
        totalFrames: 1,
        midNodes: [],
      });
      session.lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
    }
    panel.webview.postMessage({ type: "opState", ...session.history.state() });
  };

  const rerenderFromHistory = async (opts?: MmgRunOptions): Promise<void> => {
    if (session.disposed || !session.history.hasBase()) return;
    const cur = await session.history.current(opts);
    if (session.disposed) return;
    session.lastModel = cur.model;
    postModelMessage(cur.model, true);
  };

  const replayHistory = (): Thenable<void> => replayWithProgress(rerenderFromHistory);

  const replayAndPost = (title: string): Thenable<void> =>
    replayWithProgress(async (runOpts) => {
      const r = await session.history.replayOntoBase(runOpts);
      if (session.disposed) return;
      session.lastModel = r.model;
      postModelMessage(r.model, true);
      if (r.noops > 0) {
        void vscode.window.showWarningMessage(
          `${r.noops} operation(s) no longer apply to the reloaded file; they are kept in the history, marked.`
        );
      }
    }, title);

  const adoptModel = async (
    model: MdpaModel,
    skipAsyncOps: boolean
  ): Promise<MdpaModel> => {
    if (!session.history.hasBase()) {
      session.history.setBase(model);
      return model;
    }
    session.history.rebase(model);
    if (session.history.appliedCount() === 0) return model;
    const r = await session.history.replayOntoBase({ skipAsyncOps });
    if (r.noops > 0) {
      void vscode.window.showWarningMessage(
        `${r.noops} operation(s) no longer apply here; they are kept in the history, marked.`
      );
    }
    return r.model;
  };

  const applyPendingRecipe = async (): Promise<void> => {
    if (!session.fsPath) return;
    const pending = takePendingOps(session.fsPath);
    if (pending && pending.length > 0) {
      session.history.load(pending);
      await replayHistory();
      session.markDirty();
      persistSession(context, session);
    }
  };

  const postSeriesFrame = async (
    group: NonNullable<PreviewSession["currentGroup"]>,
    frameIndex: number,
    skipAsyncOps: boolean
  ): Promise<void> => {
    if (!session.fsPath || session.disposed) return;
    const dir = path.dirname(session.fsPath);
    const step = group.steps[frameIndex];
    const file = step === undefined ? undefined : fileFor(group, group.rootPrefix, session.currentRank, step);
    if (step === undefined || !file) {
      panel.webview.postMessage({ type: "vtkFrameError", message: "Requested step is unavailable." });
      return;
    }
    try {
      const framePath = path.join(dir, file);
      const parsed = isMdpa(session.fsPath)
        ? await parseMdpaFile(framePath)
        : await (async () => {
            const rootModel = await parseMeshFile(framePath);
            rootModel.subModelParts = await mergeSubparts(
              rootModel,
              group,
              dir,
              session.currentRank,
              step,
              group.rootPrefix
            );
            return rootModel;
          })();
      const adopted = await adoptModel(parsed, skipAsyncOps);
      if (session.disposed) return;
      session.lastModel = adopted;
      session.frameFile = framePath;
      session.lastFrame = { frameIndex, stepLabel: step, totalFrames: group.steps.length };
      panel.webview.postMessage({
        type: "vtkFrame",
        model: toWireModel(adopted),
        ...session.lastFrame,
        midNodes: [],
      });
      panel.webview.postMessage({ type: "opState", ...session.history.state() });
      session.ensurePt();
    } catch (err) {
      if (!session.disposed) {
        panel.webview.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const postInFileFrame = async (frameIndex: number, skipAsyncOps: boolean): Promise<void> => {
    if (!session.fsPath || session.disposed) return;
    const times = session.inFileTimeValues;
    if (!times) {
      panel.webview.postMessage({ type: "vtkFrameError", message: "Timeline is unavailable." });
      return;
    }
    const clamped = Math.min(Math.max(frameIndex, 0), times.length - 1);
    try {
      const model = await parseMeshFile(session.fsPath, undefined, { timeStep: clamped });
      const adopted = await adoptModel(model, skipAsyncOps);
      if (session.disposed) return;
      session.lastModel = adopted;
      session.frameFile = session.fsPath;
      session.lastFrame = {
        frameIndex: clamped,
        stepLabel: String(times[clamped] ?? ""),
        stepLabelKind: "time",
        totalFrames: times.length,
      };
      panel.webview.postMessage({
        type: "vtkFrame",
        model: toWireModel(adopted),
        ...session.lastFrame,
        midNodes: [],
      });
      panel.webview.postMessage({ type: "opState", ...session.history.state() });
      session.ensurePt();
    } catch (err) {
      if (!session.disposed) {
        panel.webview.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const loadBound = async (reason: "initial" | "reload" = "initial"): Promise<void> => {
    const fsPath = session.fsPath;
    if (!fsPath || session.disposed) return;
    if (loadInProgress) {
      if (reason === "reload") queuedReload = true;
      return;
    }
    loadInProgress = true;
    try {
      const thresholdMb = vscode.workspace
        .getConfiguration("kratos")
        .get<number>("preview.summaryThresholdMb", SUMMARY_THRESHOLD_MB_DEFAULT);
      const fileSize = await meshSourceBytes(fsPath);
      if (shouldSummarize({ fileSize, thresholdMb, reason, userForcedFull: session.userForcedFull, summaryShown: session.summaryShown })) {
        const summary = await summarizeMeshFile(fsPath);
        session.summaryShown = true;
        if (!session.disposed) {
          panel.webview.postMessage({
            type: "meshSummary",
            fileName: session.fileName ?? path.basename(fsPath),
            summary,
          });
          session.ensurePt();
          const pending = takePendingOps(fsPath);
          if (pending && pending.length > 0) {
            registerPendingOps(fsPath, pending);
            void vscode.window.showWarningMessage(
              `${pending.length} edit operation(s) are waiting for this mesh. Choose “Open full mesh anyway” to re-apply them.`
            );
          }
        }
        return;
      }
      session.summaryShown = false;
      const fileName = path.basename(fsPath);

      if (isMdpa(fsPath)) {
        const siblings = await fs.promises.readdir(path.dirname(fsPath));
        const found = findGroupForFile(groupVtkFiles(siblings, [".mdpa"]), fileName);
        if (found && found.group.steps.length > 1 && fileFor(found.group, found.group.rootPrefix, found.rank, found.step) === fileName) {
          session.currentGroup = found.group;
          session.currentRank = found.rank;
          session.inFileTimeValues = undefined;
          panel.webview.postMessage({
            type: "vtkGroup",
            fileName,
            group: {
              modelPartName: found.group.modelPartName,
              steps: found.group.steps,
              subParts: [],
              ranks: found.group.ranks,
            },
          });
          const at = reason === "reload" ? Math.min(session.lastFrame.frameIndex, found.group.steps.length - 1) : found.group.steps.indexOf(found.step);
          await postSeriesFrame(found.group, Math.max(at, 0), reason !== "reload");
          return;
        }
        session.currentGroup = undefined;
        session.inFileTimeValues = undefined;
        session.frameFile = fsPath;
        const model = await parseMdpaFile(fsPath, (phase, bytesRead, totalBytes) => {
          if (!session.disposed) panel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
        });
        const hadBase = session.history.hasBase();
        if (hadBase) session.history.rebase(model);
        else session.history.setBase(model);
        if (session.history.appliedCount() > 0) {
          await replayAndPost("Re-applying operations…");
        } else if (!session.disposed) {
          session.lastModel = model;
          panel.webview.postMessage({
            type: "model",
            model: toWireModel(model),
            fileName,
            keepCamera: hadBase,
          });
          panel.webview.postMessage({ type: "opState", ...session.history.state() });
        }
        session.ensurePt();
        await applyPendingRecipe();
        return;
      }

      let kind = timelineKindFor(fileName);
      let probed: number[] = [];
      if (kind === "filename") {
        probed = await probeInFileSteps(fsPath);
        if (probed.length > 1) kind = "in-file";
      }
      if (kind === "in-file") {
        const times = probed.length > 1 ? probed : await readMeshTimeSteps(fsPath);
        if (times.length > 1) {
          session.inFileTimeValues = times;
          session.currentGroup = undefined;
          panel.webview.postMessage({
            type: "vtkGroup",
            fileName,
            group: { modelPartName: fileName, steps: times.map(String), subParts: [], ranks: [0] },
          });
          await postInFileFrame(session.lastFrame.frameIndex, reason !== "reload");
          return;
        }
        session.inFileTimeValues = undefined;
      }
      if (kind === "filename") {
        const dir = path.dirname(fsPath);
        const allFiles = await fs.promises.readdir(dir);
        const found = findGroupForFile(groupVtkFiles(allFiles, TIMELINE_EXTENSIONS), fileName);
        if (found) {
          session.currentGroup = found.group;
          session.currentRank = found.rank;
          panel.webview.postMessage({
            type: "vtkGroup",
            fileName,
            group: {
              modelPartName: found.group.modelPartName,
              steps: found.group.steps,
              subParts: found.group.subParts,
              ranks: found.group.ranks,
            },
          });
          await postSeriesFrame(found.group, Math.max(found.group.steps.indexOf(found.step), 0), reason !== "reload");
          return;
        }
      }
      session.currentGroup = undefined;
      session.inFileTimeValues = undefined;
      session.frameFile = fsPath;
      const solo = await parseMeshFile(fsPath, (phase, bytesRead, totalBytes) => {
        if (!session.disposed) panel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
      });
      const adopted = await adoptModel(solo, reason !== "reload");
      if (session.disposed) return;
      session.lastModel = adopted;
      session.lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
      panel.webview.postMessage({
        type: "vtkFrame",
        model: toWireModel(adopted),
        frameIndex: 0,
        stepLabel: "",
        totalFrames: 1,
        midNodes: [],
      });
      panel.webview.postMessage({ type: "opState", ...session.history.state() });
      session.ensurePt();
      await applyPendingRecipe();
    } catch (err) {
      if (!session.disposed) {
        panel.webview.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      loadInProgress = false;
      if (queuedReload && !session.disposed) {
        queuedReload = false;
        void loadBound("reload");
      }
    }
  };

  const exportCtx = (): ExportContext | undefined => {
    if (!session.lastModel || !session.fsPath) {
      void vscode.window.showWarningMessage(
        session.summaryShown
          ? "Only a header summary is loaded for this file. Choose “Open full mesh anyway” first."
          : "The mesh is still loading; try again."
      );
      return undefined;
    }
    let sourceText: string | undefined;
    if (isMdpa(session.fsPath)) {
      try {
        sourceText = fs.readFileSync(session.frameFile ?? session.fsPath, "utf8");
      } catch {
        /* fall back to a lossy write */
      }
    }
    return {
      model: session.lastModel,
      fsPath: session.frameFile ?? session.fsPath,
      sourceText,
      ops: session.history.appliedOps(),
      reportSink: (reports, show) => {
        if (!session.disposed) void panel.webview.postMessage({ type: "exportReport", reports, show });
      },
    };
  };

  const bindPickedFile = async (pickedFsPath: string, reason: "initial" | "reload" = "initial"): Promise<void> => {
    const doc = new MeshPreviewDocument(vscode.Uri.file(pickedFsPath));
    session.bindDocument(doc, {
      rerender: rerenderFromHistory,
      exportCtx,
      revert: async () => {
        await loadBound("reload");
      },
    });
    for (const w of fileWatchers) w.dispose();
    fileWatchers = [];
    const dir = path.dirname(pickedFsPath);
    const base = path.basename(pickedFsPath);
    const globs = new Set<string>();
    if (isMdpa(pickedFsPath)) {
      globs.add(base);
      globs.add("*.mdpa");
    } else {
      const watch = timelineWatchGlob(base);
      if (watch) globs.add(watch);
      const content = contentWatchGlob(base);
      if (content) globs.add(content);
    }
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (captureLocked) {
        captureSourceChanged = true;
        panel.webview.postMessage({ type: "recordingSourceChanged" });
        return;
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void loadBound("reload"), 500);
    };
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, glob));
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      fileWatchers.push(watcher);
      session.track(watcher);
    }
    const saveSub = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.fsPath === pickedFsPath) schedule();
    });
    fileWatchers.push(saveSub);
    session.track(saveSub);
    panel.title = session.fileName ?? "Kratos Preview";
    persistSession(context, session);
    await loadBound(reason);
    persistSession(context, session);
  };

  // ---- Analyses over the bound model --------------------------------------
  let streamlineAbort: AbortController | undefined;
  const runStreamlineAnalysis = async (msg: MeshAnalysisMessage): Promise<void> => {
    streamlineAbort?.abort();
    const abort = new AbortController();
    streamlineAbort = abort;
    try {
      const reply = await runMeshAnalysis(msg, session.lastModel, {
        signal: abort.signal,
        onProgress: (done, total) => {
          if (!session.disposed) void panel.webview.postMessage({ type: "streamlineProgress", done, total, seq: msg.seq });
        },
        traceRunner: runStreamlinesInWorker,
      });
      if (!session.disposed) void panel.webview.postMessage(reply);
    } finally {
      if (streamlineAbort === abort) streamlineAbort = undefined;
    }
  };

  const seriesSteps = async (): Promise<{ label: string; frameIndex: number; load: () => Promise<MdpaModel> }[]> => {
    if (!session.fsPath) return [];
    if (session.currentGroup) {
      const group = session.currentGroup;
      const rank = session.currentRank;
      const dir = path.dirname(session.fsPath);
      return group.steps.map((step, i) => ({
        label: step,
        frameIndex: i,
        load: async () => {
          const file = fileFor(group, group.rootPrefix, rank, step);
          if (!file) throw new Error(`Step "${step}" has no file for this rank.`);
          if (isMdpa(session.fsPath ?? "")) return parseMdpaFile(path.join(dir, file));
          const rootModel = await parseMeshFile(path.join(dir, file));
          rootModel.subModelParts = await mergeSubparts(rootModel, group, dir, rank, step, group.rootPrefix);
          return rootModel;
        },
      }));
    }
    if (session.inFileTimeValues && session.fsPath) {
      const fsPath = session.fsPath;
      return stepsFromInFile(fsPath, session.inFileTimeValues);
    }
    return [];
  };

  let seriesAbort: AbortController | undefined;
  const runFieldSeries = async (msg: Record<string, unknown>): Promise<void> => {
    const reply = (payload: Record<string, unknown>): void => {
      if (!session.disposed) void panel.webview.postMessage({ type: "fieldSeriesResult", ...payload });
    };
    if (seriesAbort) {
      reply({ message: "A time-series scan is already running." });
      return;
    }
    const kind = String(msg.kind ?? "");
    const variable = String(msg.variable ?? "");
    const entityId = Number(msg.entityId);
    if (!["Nodal", "Elemental", "Conditional"].includes(kind) || !variable || !Number.isFinite(entityId)) {
      reply({ message: "Invalid time-series request." });
      return;
    }
    const steps = await seriesSteps();
    if (steps.length === 0) {
      const single = session.lastModel;
      if (!single || !session.fsPath) {
        reply({ message: "This file has no time series to plot." });
        return;
      }
      reply({ message: "This file has no time series to plot." });
      return;
    }
    seriesAbort = new AbortController();
    try {
      const series = await collectFieldSeries(steps, { kind: kind as "Nodal" | "Elemental" | "Conditional", variable, entityId }, {
        signal: seriesAbort.signal,
        onProgress: (done, total, label) => {
          if (!session.disposed) void panel.webview.postMessage({ type: "fieldSeriesProgress", done, total, label });
        },
      });
      const applied = session.history.appliedCount();
      reply({ series, historyNote: applied > 0 ? `${applied} edit operation(s) are not applied to these values.` : undefined });
    } catch (err) {
      reply({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      seriesAbort = undefined;
    }
  };

  let flowSeriesAbort: AbortController | undefined;
  const runFlowSeries = async (msg: Record<string, unknown>): Promise<void> => {
    const reply = (payload: Record<string, unknown>): void => {
      if (!session.disposed) void panel.webview.postMessage({ type: "flowSeriesResult", ...payload });
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
    const steps = await seriesSteps();
    if (steps.length === 0) {
      reply({ message: "This file has no time series to balance." });
      return;
    }
    flowSeriesAbort = new AbortController();
    try {
      const series = await flowBalanceSeries(steps, flow, {
        signal: flowSeriesAbort.signal,
        onProgress: (done, total, label) => {
          if (!session.disposed) void panel.webview.postMessage({ type: "flowSeriesProgress", done, total, label });
        },
      });
      const applied = session.history.appliedCount();
      reply({ series, historyNote: applied > 0 ? `${applied} edit operation(s) are not applied to these values.` : undefined });
    } catch (err) {
      reply({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      flowSeriesAbort = undefined;
    }
  };

  const recording = new RecordingController(context.globalStorageUri.fsPath, "", (message) => panel.webview.postMessage(message));
  let plots: ReturnType<typeof createPlotController> | undefined;

  const msgSub = panel.webview.onDidReceiveMessage(async (msg: { type?: string } & Record<string, unknown>) => {
    if (msg?.type === "setTheme") {
      const valid = ["auto", "dark", "light", "scientific"];
      if (valid.includes(String(msg.theme))) {
        await context.globalState.update("sceneTheme", String(msg.theme));
      }
      return;
    }
    if (msg?.type === "ready") {
      session.docInfo?.sync(true);
      session.postEngineStatus();
      if (session.isBound) void loadBound("initial");
      return;
    }
    if (msg?.type === "menuOpen") {
      const picked = await pickMergeMeshFile(false, "Open Mesh File");
      if (!picked || picked.length === 0) return;
      await bindPickedFile(picked[0], "initial");
      return;
    }
    if (msg?.type === "menuLoadProblem") {
      const opened = await loadProblem({ open: false });
      if (!opened) return;
      await bindPickedFile(opened.fsPath, "initial");
      return;
    }
    if (!session.isBound) {
      if (msg?.type === "meshSummaryOpenFull") {
        session.userForcedFull = true;
        await loadBound("initial");
        return;
      }
      void vscode.window.showInformationMessage("Open a mesh first — use File ▸ Open… in this window.");
      return;
    }
    if (msg?.type === "meshSummaryOpenFull") {
      session.userForcedFull = true;
      await loadBound("initial");
    } else if (msg?.type === "vtkRequestFrame") {
      const fi = typeof msg.frameIndex === "number" ? msg.frameIndex : 0;
      if (session.currentGroup) await postSeriesFrame(session.currentGroup, fi, true);
      else if (session.inFileTimeValues) await postInFileFrame(fi, true);
      else panel.webview.postMessage({ type: "vtkFrameError", requestId: msg.requestId, message: "Timeline is unavailable." });
    } else if (msg?.type === "menuReload") {
      await loadBound("reload");
    } else if (msg?.type === "menuSave") {
      const wrote = await session.document?.hooks?.save();
      if (wrote) {
        markClean();
        persistSession(context, session);
      }
    } else if (
      msg?.type === "menuOpen" ||
      msg?.type === "menuImport" ||
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
      if (msg.type === "menuOpen") {
        const picked = await pickMergeMeshFile(false, "Open Mesh File");
        if (picked && picked.length > 0) await bindPickedFile(picked[0], "initial");
        return;
      }
      if (msg.type === "menuLoadProblem") {
        const opened = await loadProblem({ open: false });
        if (opened) await bindPickedFile(opened.fsPath, "initial");
        return;
      }
      if (msg.type === "menuImport") {
        const paths = await pickMergeMeshFile(true, "Import Mesh Files");
        if (paths && session.opRunner) await session.opRunner.applyOperation({ op: "mergeMesh", paths });
        persistSession(context, session);
        return;
      }
      await runMenu(msg as MenuMessage, exportCtx, context);
      persistSession(context, session);
    } else if (msg?.type === "screenshot") {
      await saveScreenshot(String(msg.data ?? ""), session.frameFile ?? session.fsPath ?? "mesh");
    } else if (msg?.type === "recordCaptureLock") {
      captureLocked = Boolean(msg.active);
      if (!captureLocked && captureSourceChanged) {
        captureSourceChanged = false;
        await loadBound("reload");
      }
    } else if (msg?.type === "recording") {
      recording.receive(msg as unknown as Parameters<RecordingController["receive"]>[0]);
    } else if (msg?.type === "plotOpen") {
      plots ??= createPlotController(context, panel.webview, undefined, () => ({
        path: session.fsPath ?? "",
        model: session.lastModel,
        frameIndex: session.lastFrame.frameIndex,
        hasTimeline: (session.currentGroup?.steps.length ?? session.inFileTimeValues?.length ?? 1) > 1,
        timelineId: JSON.stringify([session.currentGroup?.steps, session.currentRank]),
        pick: (origin) => {
          if (!session.disposed) void panel.webview.postMessage({ type: "plotPick", origin });
        },
      }));
      plots.sendContext();
      void panel.webview.postMessage({ type: "plotReveal", preset: msg.preset });
    } else if (plots?.receive(msg)) {
      // Read-only plot requests belong to this panel.
    } else if (msg?.type === "ptState") {
      session.ptController?.onState(msg.state as Parameters<NonNullable<PreviewSession["ptController"]>["onState"]>[0]);
    } else if (msg?.type === "ptGenerate" || msg?.type === "ptRun" || msg?.type === "ptOpenResults") {
      session.ptController?.dispatch(msg.type === "ptGenerate" ? "generate" : msg.type === "ptRun" ? "run" : "openResults");
    } else if (msg?.type === "ptStop") {
      session.ptController?.dispatch("stop");
    } else if (msg?.type === "ptPresetSave") {
      await session.ptController?.savePreset(msg as { lawId: string; name: string; values: Record<string, number> });
    } else if (msg?.type === "ptPresetImport") {
      await session.ptController?.importPresets();
    } else if (msg?.type === "ptPresetExport") {
      await session.ptController?.exportPreset(String(msg.preset ?? ""));
    } else if (msg?.type === "flowgraphStart") {
      await session.startFlowgraph();
    } else if (msg?.type === "flowgraphStop") {
      session.stopFlowgraph();
    } else if (msg?.type === "flowgraphExport") {
      await session.ptController?.applyExternalProjectParameters(String(msg.json ?? ""));
    } else if (msg?.type === "pickMeshFile") {
      const target = typeof msg.target === "string" ? msg.target : "mergeMesh";
      const spec = MESH_PICK_TARGETS[target] ?? MESH_PICK_TARGETS.mergeMesh;
      const picked = await pickMergeMeshFile(spec.multi, spec.title);
      if (picked) void panel.webview.postMessage({ type: "mergeMeshPicked", target, paths: picked });
    } else if (msg?.type === "applyOp") {
      await session.opRunner?.applyOperation(msg as Record<string, unknown>);
      syncTitleDirty();
      persistSession(context, session);
    } else if (msg?.type === "applyBatch") {
      await session.opRunner?.applyBatch(msg as { ops?: unknown[] });
      syncTitleDirty();
      persistSession(context, session);
    } else if (msg?.type === "opCancel") {
      session.opRunner?.cancel();
    } else if (msg?.type === "meshAnalysis") {
      if (msg?.kind === "streamlines") await runStreamlineAnalysis(msg as MeshAnalysisMessage);
      else {
        const reply = await runMeshAnalysis(msg as MeshAnalysisMessage, session.lastModel);
        if (!session.disposed) void panel.webview.postMessage(reply);
      }
    } else if (msg?.type === "streamlineCancel") {
      streamlineAbort?.abort();
    } else if (msg?.type === "fieldSeries") {
      await runFieldSeries(msg as Record<string, unknown>);
    } else if (msg?.type === "fieldSeriesCancel") {
      seriesAbort?.abort();
    } else if (msg?.type === "flowSeries") {
      await runFlowSeries(msg as Record<string, unknown>);
    } else if (msg?.type === "flowSeriesCancel") {
      flowSeriesAbort?.abort();
    } else if (msg?.type === "opUndo") {
      session.doUndo();
      persistSession(context, session);
    } else if (msg?.type === "opRedo") {
      session.doRedo();
      persistSession(context, session);
    } else if (msg?.type === "opReapply") {
      if (session.history.hasBase()) await replayAndPost("Re-applying operations…");
    } else if (msg?.type === "opClear") {
      session.history.clear();
      session.docInfo?.sync();
      await rerenderFromHistory();
      persistSession(context, session);
    } else if (msg?.type === "opRevertTo") {
      session.history.revertTo(Number(msg.index));
      session.markDirty();
      await rerenderFromHistory();
      persistSession(context, session);
    } else if (msg?.type === "saveOps") {
      if (session.fsPath) await saveOps(session.history, session.fsPath);
    } else if (msg?.type === "loadOps") {
      if (session.fsPath && (await loadOps(session.history, session.fsPath))) {
        await replayHistory();
        session.markDirty();
        persistSession(context, session);
      }
    }
  });
  session.track(msgSub);
  session.track({ dispose: () => recording.dispose() });
  session.track({ dispose: () => plots?.dispose() });
  panel.onDidDispose(() => {
    persistSession(context, session);
    for (const w of fileWatchers) w.dispose();
    streamlineAbort?.abort();
    seriesAbort?.abort();
    flowSeriesAbort?.abort();
    session.dispose();
  });

  return { session, bindPickedFile, replayHistory, syncTitleDirty };
}
