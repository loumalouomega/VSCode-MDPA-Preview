import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";

import { EntityBlock, MdpaModel, SubModelPart } from "../src/parser/types";
import { computeMeshQuality, QualityReport } from "../src/parser/meshQuality";
import { buildPolyData, Cell, prepareNodes, PreparedNodes } from "./meshBuilder";
import { OutlineNode, renderOutline } from "./outline";
import { renderQualityPanel } from "./qualityPanel";
import { RGB, getThemePalette, getThemeBackground } from "./themes";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// A layer that may have been built (polydata exists) or not yet (lazy).
interface Layer {
  id: string;
  actor: any;
  color: RGB;
  paletteIndex: number;
  visible: boolean;
  built: boolean;
  // Kept for lazy build
  pendingCells?: Cell[];
}

// --- DOM ----------------------------------------------------------------
const loadingEl = document.getElementById("loading") as HTMLElement;
const loadingBarEl = document.getElementById("loading-bar") as HTMLElement;
const loadingLabelEl = document.getElementById("loading-label") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const renderRoot = document.getElementById("render-root") as HTMLElement;
const viewport = document.getElementById("viewport") as HTMLElement;
const outlineEl = document.getElementById("outline") as HTMLElement;
const statsEl = document.getElementById("stats") as HTMLElement;

const labelsEl = document.createElement("div");
labelsEl.id = "labels";
viewport.appendChild(labelsEl);

const messageEl = document.createElement("div");
messageEl.id = "message";
viewport.appendChild(messageEl);

const qualityPanelEl = document.createElement("div");
qualityPanelEl.id = "quality-panel";
qualityPanelEl.style.display = "none";
viewport.appendChild(qualityPanelEl);

// --- VTK scene ----------------------------------------------------------
const grw: any = vtkGenericRenderWindow.newInstance({
  background: readThemeBackground(),
});
grw.setContainer(renderRoot);
const renderer: any = grw.getRenderer();
const renderWindow: any = grw.getRenderWindow();
const apiRW: any = grw.getApiSpecificRenderWindow
  ? grw.getApiSpecificRenderWindow()
  : grw.getOpenGLRenderWindow();

// --- Interactor style ---------------------------------------------------
const istyle = vtkInteractorStyleManipulator.newInstance();
const rotateManip = vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 });
const panManipLeft = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1 });
const panManipMiddle = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 });
const zoomManip = vtkMouseCameraTrackballZoomManipulator.newInstance({
  scrollEnabled: true,
  dragEnabled: false,
});
const zoomManipRight = vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3 });

function applyRotateMode(): void {
  istyle.removeAllMouseManipulators();
  istyle.addMouseManipulator(rotateManip);
  istyle.addMouseManipulator(panManipMiddle);
  istyle.addMouseManipulator(zoomManip);
  istyle.addMouseManipulator(zoomManipRight);
}

function applyPanMode(): void {
  istyle.removeAllMouseManipulators();
  istyle.addMouseManipulator(panManipLeft);
  istyle.addMouseManipulator(panManipMiddle);
  istyle.addMouseManipulator(zoomManip);
  istyle.addMouseManipulator(zoomManipRight);
}

applyRotateMode();
grw.getInteractor().setInteractorStyle(istyle);
grw.resize();
new ResizeObserver(() => {
  grw.resize();
  if (showNodeIds) requestLabelUpdate();
}).observe(renderRoot);

// --- State --------------------------------------------------------------
let model: MdpaModel | undefined;
let prepared: PreparedNodes | undefined;
const layers = new Map<string, Layer>();
let actors: any[] = [];
let wireframe = false;
let panMode = false;
let showNodeIds = false;
const NODE_LABEL_LIMIT = 1000;

let currentTheme = "auto";

// Entity id -> cell maps, kept at module scope for quality panel and find-entity lookups.
let elementById = new Map<number, Cell>();
let conditionById = new Map<number, Cell>();
let geometryById = new Map<number, Cell>();
let qualityReport: QualityReport | undefined;
let qualityVisible = false;
const QUALITY_HIGHLIGHT_ID = "quality:highlight";
const QUALITY_HIGHLIGHT_COLOR: RGB = [0.85, 0.16, 0.18];
const FIND_HIGHLIGHT_ID = "find:highlight";
const FIND_HIGHLIGHT_COLOR: RGB = [1.0, 0.95, 0.0];

// --- Loading overlay ----------------------------------------------------
function showLoading(label: string, fraction?: number): void {
  loadingLabelEl.textContent = label;
  if (fraction !== undefined) {
    loadingBarEl.style.width = `${Math.round(fraction * 100)}%`;
  }
  loadingEl.style.display = "";
  appEl.style.display = "none";
}

function hideLoading(): void {
  loadingEl.style.display = "none";
  appEl.style.display = "";
}

// --- Message handling ---------------------------------------------------
window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case "progress":
      showLoading(
        "Reading file…",
        msg.totalBytes > 0 ? msg.bytesRead / msg.totalBytes : undefined
      );
      break;
    case "model":
      model = msg.model as MdpaModel;
      buildScene();
      hideLoading();
      break;
    case "resetCamera":
      resetCamera();
      break;
    case "toggleNodeIds":
      setNodeIds(!showNodeIds);
      break;
    case "computeQuality":
      toggleQualityPanel();
      break;
    case "locateEntity": {
      const { entityType, entityId } = msg as { entityType: string; entityId: number };
      const bar = document.getElementById("find-bar");
      if (bar && !bar.classList.contains("visible")) toggleFindBar();
      const findTypeEl = document.getElementById("find-type") as HTMLSelectElement | null;
      const findStatusEl = document.getElementById("find-status") as HTMLElement | null;
      if (findTypeEl) findTypeEl.value = entityType;
      const err = locateEntity(entityType, entityId);
      if (findStatusEl) findStatusEl.textContent = err ?? "";
      break;
    }
    case "error":
      hideLoading();
      messageEl.textContent = `Parse error: ${msg.message}`;
      break;
  }
});

// --- VTK category check (used to decide default visibility) -------------
function isVolumeBlock(block: EntityBlock): boolean {
  const vt = block.vtkCellType;
  if (vt === undefined) return false;
  // VTK types >= 10 that are 3D volume cells
  const volumeTypes = new Set([10, 12, 13, 14, 24, 25, 26, 27, 29]);
  return volumeTypes.has(vt);
}

// --- Scene construction -------------------------------------------------
function clearScene(): void {
  for (const actor of actors) {
    renderer.removeActor(actor);
  }
  actors = [];
  layers.clear();
  labelsEl.textContent = "";
  messageEl.textContent = "";
}

function buildScene(): void {
  if (!model) return;
  clearScene();
  prepared = prepareNodes(model);
  // A fresh model invalidates any cached quality report.
  qualityReport = undefined;
  // Close the find bar (clearScene already removed all layers including find:highlight).
  const findBar = document.getElementById("find-bar");
  if (findBar?.classList.contains("visible")) {
    findBar.classList.remove("visible");
    document.querySelector<HTMLButtonElement>('#toolbar button[data-action="find"]')
      ?.classList.remove("active");
    const findStatusEl = document.getElementById("find-status");
    if (findStatusEl) findStatusEl.textContent = "";
  }

  // Build id → Cell maps (cheap — no polydata yet)
  elementById = new Map<number, Cell>();
  conditionById = new Map<number, Cell>();
  geometryById = new Map<number, Cell>();
  for (const block of model.blocks) {
    const target =
      block.kind === "Elements"
        ? elementById
        : block.kind === "Conditions"
        ? conditionById
        : geometryById;
    for (let i = 0; i < block.count; i++) {
      target.set(block.entityIds[i], {
        cellType: block.vtkCellType,
        nodeIds: block.connectivity.subarray(i * block.stride, (i + 1) * block.stride),
      });
    }
  }

  let colorIdx = 0;
  const palette = getThemePalette(currentTheme);
  const nextColorEntry = (): [RGB, number] => {
    const idx = colorIdx++;
    return [palette[idx % palette.length], idx];
  };
  const blockNodes: OutlineNode[] = [];

  for (const block of model.blocks) {
    const [color, paletteIndex] = nextColorEntry();
    // Volume blocks hidden by default; surfaces/lines visible.
    const visible = !isVolumeBlock(block);
    const cells: Cell[] = [];
    for (let i = 0; i < block.count; i++) {
      cells.push({
        cellType: block.vtkCellType,
        nodeIds: block.connectivity.subarray(i * block.stride, (i + 1) * block.stride),
      });
    }
    const id = `block:${block.kind}:${block.name}`;
    const created = addLayer(id, cells, color, visible, paletteIndex);
    blockNodes.push({
      label: block.name + (block.vtkCellType === undefined ? " (?)" : ""),
      count: block.count,
      layerId: created ? id : undefined,
      visible,
      color,
    });
  }

  const partNodes: OutlineNode[] = model.subModelParts.map((p) =>
    buildPartLayer(p, elementById, conditionById, geometryById, nextColorEntry)
  );

  const roots: OutlineNode[] = [];
  if (blockNodes.length) roots.push({ label: "Mesh", section: true, children: blockNodes });
  if (partNodes.length) roots.push({ label: "SubModelParts", section: true, children: partNodes });
  renderOutline(outlineEl, roots, {
    onToggle: (layerId, visible) => setLayerVisible(layerId, visible),
    onFocus: (layerId) => frameLayer(layerId),
  });

  renderStats();
  resetCamera();

  // Refresh the quality panel against the new model if it is open.
  if (qualityVisible) showQualityPanel();
}

function allIn(nodeIds: ArrayLike<number>, set: Set<number>): boolean {
  for (let i = 0; i < nodeIds.length; i++) {
    if (!set.has(nodeIds[i])) return false;
  }
  return true;
}

function buildPartLayer(
  part: SubModelPart,
  elementById: Map<number, Cell>,
  conditionById: Map<number, Cell>,
  geometryById: Map<number, Cell>,
  nextColor: () => [RGB, number]
): OutlineNode {
  const cells: Cell[] = [];
  for (let i = 0; i < part.elementIds.length; i++) {
    const c = elementById.get(part.elementIds[i]);
    if (c) cells.push(c);
  }
  for (let i = 0; i < part.conditionIds.length; i++) {
    const c = conditionById.get(part.conditionIds[i]);
    if (c) cells.push(c);
  }
  for (let i = 0; i < part.geometryIds.length; i++) {
    const c = geometryById.get(part.geometryIds[i]);
    if (c) cells.push(c);
  }

  let induced = false;
  if (cells.length === 0 && part.nodeIds.length > 0) {
    const nodeSet = new Set<number>();
    for (let i = 0; i < part.nodeIds.length; i++) nodeSet.add(part.nodeIds[i]);
    for (const cell of elementById.values()) {
      if (allIn(cell.nodeIds, nodeSet)) {
        cells.push(cell);
      }
    }
    for (const cell of conditionById.values()) {
      if (allIn(cell.nodeIds, nodeSet)) {
        cells.push(cell);
      }
    }
    for (const cell of geometryById.values()) {
      if (allIn(cell.nodeIds, nodeSet)) {
        cells.push(cell);
      }
    }
    induced = cells.length > 0;
  }

  if (cells.length === 0 && part.nodeIds.length > 0) {
    for (let i = 0; i < part.nodeIds.length; i++) {
      cells.push({ cellType: undefined, nodeIds: [part.nodeIds[i]] });
    }
  }

  const [color, paletteIndex] = nextColor();
  const id = `smp:${part.path}`;
  // SubModelParts always lazy/hidden
  const created = addLayer(id, cells, color, false, paletteIndex);
  const explicitCount = part.elementIds.length + part.conditionIds.length + part.geometryIds.length;
  const total = explicitCount > 0 ? explicitCount : induced ? cells.length : part.nodeIds.length;

  return {
    label: part.name,
    count: total,
    layerId: created ? id : undefined,
    visible: false,
    color,
    children: part.children.map((child) =>
      buildPartLayer(child, elementById, conditionById, geometryById, nextColor)
    ),
  };
}

// addLayer now defers polydata construction for hidden layers.
function addLayer(id: string, cells: Cell[], color: RGB, visible: boolean, paletteIndex = -1): boolean {
  if (!prepared) return false;

  const actor = vtkActor.newInstance();
  const prop = actor.getProperty();
  prop.setColor(color[0], color[1], color[2]);
  prop.setEdgeVisibility(true);
  prop.setEdgeColor(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5);
  prop.setPointSize(6);
  prop.setLineWidth(1.5);
  actor.setVisibility(false); // always start invisible; set below

  const layer: Layer = { id, actor, color, paletteIndex, visible, built: false, pendingCells: cells };

  if (visible) {
    if (!buildLayerGeometry(layer)) return false;
  }

  actor.setVisibility(visible);
  renderer.addActor(actor);
  actors.push(actor);
  layers.set(id, layer);
  return true;
}

function buildLayerGeometry(layer: Layer): boolean {
  if (layer.built || !prepared || !layer.pendingCells) return layer.built;
  const built = buildPolyData(prepared, layer.pendingCells);
  if (!built) return false;
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(built.polyData);
  layer.actor.setMapper(mapper);
  layer.built = true;
  layer.pendingCells = undefined;
  return true;
}

// --- Interaction --------------------------------------------------------
function setLayerVisible(layerId: string, visible: boolean): void {
  const layer = layers.get(layerId);
  if (!layer) return;
  if (visible && !layer.built) {
    buildLayerGeometry(layer);
  }
  layer.visible = visible;
  layer.actor.setVisibility(visible && layer.built);
  renderWindow.render();
}

function frameLayer(layerId: string): void {
  const layer = layers.get(layerId);
  if (!layer) return;
  const bounds = layer.actor.getBounds();
  if (bounds && bounds[0] <= bounds[1]) {
    renderer.resetCamera(bounds);
    renderWindow.render();
    if (showNodeIds) requestLabelUpdate();
  }
}

function resetCamera(): void {
  renderer.resetCamera();
  renderWindow.render();
  if (showNodeIds) requestLabelUpdate();
}

function setPanMode(on: boolean): void {
  panMode = on;
  const btn = document.querySelector('#toolbar button[data-action="pan"]');
  btn?.classList.toggle("active", on);
  if (on) applyPanMode(); else applyRotateMode();
}

function setWireframe(on: boolean): void {
  wireframe = on;
  for (const [id, layer] of layers) {
    // Keep the find highlight solid for contrast even in wireframe mode.
    if (id === FIND_HIGHLIGHT_ID) continue;
    layer.actor.getProperty().setRepresentation(on ? 1 : 2);
  }
  renderWindow.render();
}

// --- Node id labels -----------------------------------------------------
let labelFrame: number | undefined;
function requestLabelUpdate(): void {
  if (labelFrame !== undefined) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = undefined;
    updateNodeLabels();
  });
}

function setNodeIds(on: boolean): void {
  showNodeIds = on;
  const btn = document.querySelector('#toolbar button[data-action="nodeIds"]');
  btn?.classList.toggle("active", on);
  labelsEl.textContent = "";
  if (!on || !model) {
    messageEl.textContent = "";
    stopLabelLoop();
    return;
  }
  if (model.nodeCount > NODE_LABEL_LIMIT) {
    messageEl.textContent = `Node IDs hidden: ${model.nodeCount} nodes exceed the ${NODE_LABEL_LIMIT} label limit.`;
    showNodeIds = false;
    btn?.classList.remove("active");
    return;
  }
  for (let i = 0; i < model.nodeCount; i++) {
    const el = document.createElement("div");
    el.className = "node-label";
    el.textContent = String(model.nodeIds[i]);
    el.dataset.x = String(model.coords[i * 3]);
    el.dataset.y = String(model.coords[i * 3 + 1]);
    el.dataset.z = String(model.coords[i * 3 + 2]);
    labelsEl.appendChild(el);
  }
  startLabelLoop();
}

let labelLoop: number | undefined;
function startLabelLoop(): void {
  const tick = () => {
    updateNodeLabels();
    labelLoop = requestAnimationFrame(tick);
  };
  labelLoop = requestAnimationFrame(tick);
}
function stopLabelLoop(): void {
  if (labelLoop !== undefined) {
    cancelAnimationFrame(labelLoop);
    labelLoop = undefined;
  }
}

function updateNodeLabels(): void {
  if (!showNodeIds) return;
  const size = apiRW.getSize();
  const dpr = window.devicePixelRatio || 1;
  const children = labelsEl.children;
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    const x = Number(el.dataset.x);
    const y = Number(el.dataset.y);
    const z = Number(el.dataset.z);
    const disp = apiRW.worldToDisplay(x, y, z, renderer);
    el.style.left = `${disp[0] / dpr}px`;
    el.style.top = `${(size[1] - disp[1]) / dpr}px`;
  }
}

// --- Stats panel --------------------------------------------------------
function renderStats(): void {
  if (!model) return;
  const count = (kind: string) =>
    model!.blocks.filter((b) => b.kind === kind).reduce((s, b) => s + b.count, 0);
  const unmapped = model.blocks.filter((b) => b.vtkCellType === undefined);
  const b = model.bounds;
  const fmt = (v: number) => (Number.isFinite(v) ? v.toPrecision(4) : "0");

  const rows: string[] = [
    row("Nodes", String(model.nodeCount)),
    row("Elements", String(count("Elements"))),
    row("Conditions", String(count("Conditions"))),
    row("Geometries", String(count("Geometries"))),
    row("SubModelParts", String(countParts(model.subModelParts))),
    row("Dimensionality", model.is3D ? "3D" : "2D"),
    row(
      "Bounds",
      `[${fmt(b.min[0])}, ${fmt(b.min[1])}, ${fmt(b.min[2])}] – [${fmt(b.max[0])}, ${fmt(b.max[1])}, ${fmt(b.max[2])}]`
    ),
  ];
  if (unmapped.length) {
    rows.push(
      `<div class="stat-row warn"><span class="stat-key">Unmapped types</span><span>${unmapped.map((u) => u.name).join(", ")}</span></div>`
    );
  }
  if (model.diagnostics.length) {
    rows.push(
      `<div class="stat-row warn"><span class="stat-key">Warnings</span><span>${model.diagnostics.length}</span></div>`
    );
  }
  statsEl.innerHTML = rows.join("");
}

function row(key: string, value: string): string {
  return `<div class="stat-row"><span class="stat-key">${key}</span><span>${value}</span></div>`;
}

function countParts(parts: SubModelPart[]): number {
  let n = parts.length;
  for (const p of parts) n += countParts(p.children);
  return n;
}

// --- Toolbar ------------------------------------------------------------
document.getElementById("toolbar")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const action = target.dataset.action;
  if (action === "reset") resetCamera();
  else if (action === "pan") setPanMode(!panMode);
  else if (action === "wireframe") {
    setWireframe(!wireframe);
    target.classList.toggle("active", wireframe);
  } else if (action === "nodeIds") setNodeIds(!showNodeIds);
  else if (action === "quality") toggleQualityPanel();
  else if (action === "find") toggleFindBar();
});

// Wire find-bar controls after DOM is ready.
((): void => {
  const findTypeEl   = document.getElementById("find-type")   as HTMLSelectElement | null;
  const findIdEl     = document.getElementById("find-id")     as HTMLInputElement | null;
  const findGoEl     = document.getElementById("find-go")     as HTMLButtonElement | null;
  const findCloseEl  = document.getElementById("find-close")  as HTMLButtonElement | null;
  const findStatusEl = document.getElementById("find-status") as HTMLElement | null;
  if (!findTypeEl || !findIdEl || !findGoEl || !findCloseEl || !findStatusEl) return;

  const runFind = (): void => {
    const err = locateEntity(findTypeEl.value, Number(findIdEl.value));
    findStatusEl.textContent = err ?? "";
  };

  findGoEl.addEventListener("click", runFind);
  findIdEl.addEventListener("keydown", (e) => { if (e.key === "Enter") runFind(); });
  findCloseEl.addEventListener("click", () => toggleFindBar());
})();

// --- Mesh quality -------------------------------------------------------
function toggleQualityPanel(): void {
  if (qualityVisible) hideQualityPanel();
  else showQualityPanel();
}

function showQualityPanel(): void {
  if (!model) return;
  if (!qualityReport) qualityReport = computeMeshQuality(model);
  renderQualityPanel(qualityPanelEl, qualityReport, {
    onClose: () => hideQualityPanel(),
    onHighlight: (key) => setQualityHighlight(key),
    onClearHighlight: () => setQualityHighlight(null),
    onFrame: () => frameLayer(QUALITY_HIGHLIGHT_ID),
  });
  qualityPanelEl.style.display = "";
  qualityVisible = true;
  document.querySelector('#toolbar button[data-action="quality"]')?.classList.add("active");
}

function hideQualityPanel(): void {
  qualityPanelEl.style.display = "none";
  qualityVisible = false;
  setQualityHighlight(null);
  document
    .querySelector('#toolbar button[data-action="quality"]')
    ?.classList.remove("active");
}

// Builds (or clears) the red overlay of bad elements for the given metric.
function setQualityHighlight(metricKey: string | null): void {
  removeLayer(QUALITY_HIGHLIGHT_ID);
  if (metricKey && qualityReport && prepared) {
    const m = qualityReport.metrics.find((x) => x.key === metricKey);
    if (m && m.badEntityIds.length > 0) {
      const cells: Cell[] = [];
      for (const id of m.badEntityIds) {
        const c = elementById.get(id);
        if (c) cells.push(c);
      }
      if (cells.length > 0) {
        addLayer(QUALITY_HIGHLIGHT_ID, cells, QUALITY_HIGHLIGHT_COLOR, true);
        if (wireframe) {
          layers.get(QUALITY_HIGHLIGHT_ID)?.actor.getProperty().setRepresentation(1);
        }
      }
    }
  }
  renderWindow.render();
}

// --- Find entity --------------------------------------------------------
// While a find highlight is active, all other layers are forced to wireframe
// so the highlighted entity stands out clearly.
function applyFindWireframe(): void {
  for (const [id, layer] of layers) {
    layer.actor.getProperty().setRepresentation(id === FIND_HIGHLIGHT_ID ? 2 : 1);
  }
  renderWindow.render();
}

function restoreWireframe(): void {
  const rep = wireframe ? 1 : 2;
  for (const [id, layer] of layers) {
    if (id !== FIND_HIGHLIGHT_ID) {
      layer.actor.getProperty().setRepresentation(rep);
    }
  }
  renderWindow.render();
}

function toggleFindBar(): void {
  const bar = document.getElementById("find-bar");
  if (!bar) return;
  const open = bar.classList.toggle("visible");
  document.querySelector<HTMLButtonElement>('#toolbar button[data-action="find"]')
    ?.classList.toggle("active", open);
  if (!open) {
    removeLayer(FIND_HIGHLIGHT_ID);
    restoreWireframe();
    const statusEl = document.getElementById("find-status");
    if (statusEl) statusEl.textContent = "";
  }
}

function locateEntity(entityType: string, entityId: number): string | null {
  removeLayer(FIND_HIGHLIGHT_ID);
  if (!model || !prepared) {
    restoreWireframe();
    return "No model loaded";
  }

  let cell: Cell | undefined;
  if (entityType === "Node") {
    if (model.nodeIds.indexOf(entityId) === -1) {
      restoreWireframe();
      return `Node ${entityId} not found`;
    }
    cell = { nodeIds: new Int32Array([entityId]) };
  } else {
    const map =
      entityType === "Element"   ? elementById :
      entityType === "Condition" ? conditionById :
                                   geometryById;
    cell = map.get(entityId);
    if (!cell) {
      restoreWireframe();
      return `${entityType} ${entityId} not found`;
    }
  }

  addLayer(FIND_HIGHLIGHT_ID, [cell], FIND_HIGHLIGHT_COLOR, true);
  applyFindWireframe();
  frameLayer(FIND_HIGHLIGHT_ID);
  return null;
}

function removeLayer(id: string): void {
  const layer = layers.get(id);
  if (!layer) return;
  renderer.removeActor(layer.actor);
  actors = actors.filter((a) => a !== layer.actor);
  layers.delete(id);
}

// --- Helpers ------------------------------------------------------------
function readThemeBackground(): RGB {
  const css = getComputedStyle(document.body).backgroundColor;
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length >= 3) return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  }
  return [0.12, 0.12, 0.14];
}

vscode.postMessage({ type: "ready" });
