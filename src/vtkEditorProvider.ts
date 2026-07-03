import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseVtkFile } from "./parser/vtkLegacyParser";
import { groupVtkFiles, fileFor, findGroupForFile, VtkFileGroup } from "./parser/vtkFileGroup";
import { MdpaModel, SubModelPart } from "./parser/types";

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

  constructor(private readonly context: vscode.ExtensionContext) {}

  public postToActive(message: unknown): void {
    this.activePanel?.webview.postMessage(message);
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
        const rootModel = await parseVtkFile(
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

        if (!disposed) {
          webviewPanel.webview.postMessage({
            type: "vtkFrame",
            model: rootModel,
            frameIndex,
            stepLabel: step,
            totalFrames: group.steps.length,
          });
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
        const allFiles = await fs.promises.readdir(dir);
        const groups = groupVtkFiles(allFiles);
        const found = findGroupForFile(groups, fileName);

        if (!found) {
          // No Kratos-style siblings — parse just the opened file as a static view
          const solo = await parseVtkFile(
            fsPath,
            (phase, bytesRead, totalBytes) => {
              if (!disposed) {
                webviewPanel.webview.postMessage({ type: "progress", phase, bytesRead, totalBytes });
              }
            }
          );
          if (!disposed) {
            webviewPanel.webview.postMessage({
              type: "vtkFrame",
              model: solo,
              frameIndex: 0,
              stepLabel: "",
              totalFrames: 1,
            });
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

    // ---- Directory watcher --------------------------------------------------

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, "*.vtk")
    );
    const scheduleRediscover = (): void => {
      // Re-run discovery when new VTK files appear (simulation still running)
      void discover();
    };
    watcher.onDidCreate(scheduleRediscover);
    watcher.onDidChange(scheduleRediscover);

    // ---- View-state tracking ------------------------------------------------

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
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
        }
      } else if (msg?.type === "setTheme") {
        const valid = ["auto", "dark", "light", "scientific"];
        if (valid.includes(msg.theme)) {
          void this.context.globalState.update("sceneTheme", msg.theme);
        }
      } else if (msg?.type === "screenshot") {
        void saveScreenshot(msg.data as string, fsPath);
      }
    });

    // ---- Disposal -----------------------------------------------------------

    webviewPanel.onDidDispose(() => {
      disposed = true;
      watcher.dispose();
      viewStateSub.dispose();
      msgSub.dispose();
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
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
    <aside id="sidebar">
      <div id="stats"></div>
      <div id="outline-header">Layers</div>
      <div id="outline"></div>
    </aside>
    <div id="viewport">
      <div id="toolbar">
        <button data-action="reset" title="Reset camera">Reset</button>
        <button data-action="pan" title="Toggle pan mode">Pan</button>
        <button data-action="wireframe" title="Toggle wireframe">Wireframe</button>
        <button data-action="nodeIds" title="Toggle node ids">Node IDs</button>
        <button data-action="quality" title="Compute mesh quality">Quality</button>
        <button data-action="field" title="Visualize field data">Field</button>
        <button data-action="grid" title="Toggle background grid">Grid</button>
        <button data-action="find" title="Find entity by ID">Find</button>
        <button data-action="screenshot" title="Save screenshot as PNG">📷</button>
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
        <button id="find-close" title="Close">×</button>
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
      subModel = await parseVtkFile(path.join(dir, subFile));
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
