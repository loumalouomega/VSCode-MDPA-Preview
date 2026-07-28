import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseMeshFile, readMeshTimeSteps } from "./parser/meshFileParser";
import { IN_FILE_TIMELINE_EXTENSIONS, TIMELINE_EXTENSIONS } from "./parser/meshFormats";
import { groupVtkFiles, fileFor, findGroupForFile, VtkFileGroup } from "./parser/vtkFileGroup";
import { MdpaModel, SubModelPart } from "./parser/types";
import { TOOLBAR_ICONS } from "./toolbarIcons";
import {
  ADVANCED_BUTTON_HTML,
  ADVANCED_MENU_HTML,
  FILE_MENU_HTML,
  FLOWGRAPH_PANE_HTML,
  SIDEBAR_HTML,
} from "./webviewChrome";
import { ExportContext, MenuMessage, runMenu, pickMergeMeshFile } from "./meshExport";
import { OperationHistory, saveOps, loadOps } from "./opHistory";
import { opRecordFromMessage, isAsyncOp, OP_LABELS, MmgRunOptions } from "./parser/operations";
import { takePendingOps } from "./problemArchive";

/** `<span>` wrapping a generated, currentColor-based toolbar icon (see toolbarIcons.ts). */
function icon(id: keyof typeof TOOLBAR_ICONS): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
}

// ---- Document ----------------------------------------------------------------

class VtkDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }
  dispose(): void {}
}

// ---- Provider ----------------------------------------------------------------

export class VtkEditorProvider
  implements vscode.CustomReadonlyEditorProvider<VtkDocument>
{
  public static readonly viewType = "kratos.vtkPreview";

  private activePanel: vscode.WebviewPanel | undefined;
  /** File-menu handler bound to the active panel (Command-Palette parity). */
  private activeMenuHandler: ((msg: MenuMessage) => void) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public postToActive(message: unknown): void {
    this.activePanel?.webview.postMessage(message);
  }

  /** Runs a File-menu action on the active mesh preview; false if none active. */
  public dispatchMenu(msg: MenuMessage): boolean {
    if (!this.activeMenuHandler) return false;
    this.activeMenuHandler(msg);
    return true;
  }

  public openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): VtkDocument {
    return new VtkDocument(uri);
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
    let disposed = false;
    let loadInProgress = false;
    let currentGroup: VtkFileGroup | undefined;
    let currentRank = 0;
    // Set instead of currentGroup for a single-file, in-file timeline
    // (currently Exodus) — mutually exclusive with currentGroup.
    let inFileTimeValues: number[] | undefined;
    let lastModel: MdpaModel | undefined;
    // Meta of the last frame posted, so an in-place operation can re-post it.
    let lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
    const history = new OperationHistory();

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
    const replayWithProgress = (): Thenable<void> =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Replaying operations…",
          cancellable: true,
        },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          await rerenderFromHistory({
            onProgress: (message) => progress.report({ message }),
            signal: abort.signal,
          });
          if (token.isCancellationRequested) {
            vscode.window.showWarningMessage(
              "Replay cancelled — the preview shows a partial result; use Clear or re-load the recipe."
            );
          }
        }
      );

    // A Load-problem extraction left an edit recipe for this mesh: replay it
    // (consumed once, on the first base model this panel loads).
    const applyPendingOps = async (): Promise<void> => {
      const pending = takePendingOps(fsPath);
      if (pending && pending.length > 0) {
        history.load(pending);
        await replayWithProgress();
      }
    };

    // ---- Frame loading -------------------------------------------------------

    const postFrame = async (
      group: VtkFileGroup,
      frameIndex: number,
      rank: number
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

        lastModel = rootModel;
        lastFrame = { frameIndex, stepLabel: step, totalFrames: group.steps.length };
        history.setBase(rootModel);
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame",
            model: rootModel,
            frameIndex,
            stepLabel: step,
            totalFrames: group.steps.length,
          });
          webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
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
    const postInFileFrame = async (frameIndex: number): Promise<void> => {
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
        lastModel = model;
        lastFrame = {
          frameIndex: clamped,
          stepLabel: String(timeValues[clamped] ?? ""),
          totalFrames: timeValues.length,
        };
        history.setBase(model);
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame",
            model,
            frameIndex: clamped,
            stepLabel: lastFrame.stepLabel,
            totalFrames: timeValues.length,
          });
          webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
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

    // ---- Initial discovery --------------------------------------------------

    const discover = async (): Promise<void> => {
      if (loadInProgress || disposed) return;
      loadInProgress = true;
      try {
        const ext = path.extname(fileName).toLowerCase();

        if (IN_FILE_TIMELINE_EXTENSIONS.includes(ext)) {
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
            await postInFileFrame(lastFrame.frameIndex);
            return;
          }
          inFileTimeValues = undefined; // single/no time step: fall through to the static path below
        }

        let found: ReturnType<typeof findGroupForFile>;
        if (TIMELINE_EXTENSIONS.includes(ext)) {
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
          lastModel = solo;
          lastFrame = { frameIndex: 0, stepLabel: "", totalFrames: 1 };
          history.setBase(solo);
          if (!disposed) {
            webviewPanel.webview.postMessage({
              type: "vtkFrame",
              model: solo,
              frameIndex: 0,
              stepLabel: "",
              totalFrames: 1,
            });
            webviewPanel.webview.postMessage({ type: "opState", ...history.state() });
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

        await postFrame(found.group, Math.max(frameIndex, 0), found.rank);
      } catch (err) {
        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        loadInProgress = false;
      }
    };

    // ---- Directory / file watcher --------------------------------------------

    // Only time-series-capable formats watch for newly written step files
    let watcher: vscode.FileSystemWatcher | undefined;
    const initialExt = path.extname(fileName).toLowerCase();
    if (TIMELINE_EXTENSIONS.includes(initialExt)) {
      const glob = `*.{${TIMELINE_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`;
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, glob)
      );
      const scheduleRediscover = (): void => {
        // Re-run discovery when new step files appear (simulation still running)
        void discover();
      };
      watcher.onDidCreate(scheduleRediscover);
      watcher.onDidChange(scheduleRediscover);
    } else if (IN_FILE_TIMELINE_EXTENSIONS.includes(initialExt)) {
      // A single growing file (e.g. a solver still appending time steps to
      // the same Exodus file) — one file, not a directory glob.
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, fileName)
      );
      watcher.onDidChange(() => void discover());
    }

    // ---- View-state tracking ------------------------------------------------

    const exportCtx = (): ExportContext | undefined => {
      if (!lastModel) {
        vscode.window.showWarningMessage("The mesh is still loading; try again.");
        return undefined;
      }
      return { model: lastModel, fsPath, ops: history.appliedOps() };
    };
    const handleMenu = (msg: MenuMessage): void => {
      void runMenu(msg, exportCtx, this.context);
    };
    this.activeMenuHandler = handleMenu;

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
        this.activeMenuHandler = handleMenu;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
        this.activeMenuHandler = undefined;
      }
    });

    // ---- Message handling ---------------------------------------------------

    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        void discover();
      } else if (msg?.type === "vtkRequestFrame") {
        const fi = typeof msg.frameIndex === "number" ? msg.frameIndex : 0;
        if (currentGroup) {
          void postFrame(currentGroup, fi, currentRank);
        } else if (inFileTimeValues) {
          void postInFileFrame(fi);
        }
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
        msg?.type === "menuExportPart" ||
        msg?.type === "menuExportSkin" ||
        msg?.type === "menuSaveProblem" ||
        msg?.type === "menuLoadProblem"
      ) {
        handleMenu(msg as MenuMessage);
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
          if (await loadOps(history, fsPath)) await replayWithProgress();
        })();
      }
    });

    // ---- Disposal -----------------------------------------------------------

    webviewPanel.onDidDispose(() => {
      disposed = true;
      watcher?.dispose();
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

  // ---- HTML (shared with MDPA provider) -------------------------------------

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
      // Mirrors the MDPA provider so the shared webview chrome behaves
      // identically; the embedded Flowgraph editor (MDPA-only) loads from a
      // localhost port or an https tunnel resolved after this CSP is baked.
      `frame-src http://localhost:* http://127.0.0.1:* https:`,
      `child-src blob:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>VTK Preview</title>
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
      <div id="vtk-sub">
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
        ${ADVANCED_BUTTON_HTML}
        <button data-action="screenshot" title="Save screenshot as PNG">${icon("screenshot")}</button>
        <select id="theme-select" title="Scene theme">
          <option value="auto">Auto</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="scientific">Scientific</option>
        </select>
      </div>
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
  await fs.promises.writeFile(dest.fsPath, Buffer.from(base64, "base64"));
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
