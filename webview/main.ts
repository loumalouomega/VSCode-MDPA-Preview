// Webview entry point: owns the VTK.js scene and the outline panel. Receives a
// parsed MdpaModel from the extension host, builds one renderable layer per
// entity block plus one toggleable overlay layer per SubModelPart, and wires
// the outline checkboxes (activate/deactivate layers) and labels (frame layer).

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";

import { MdpaModel, SubModelPart } from "../src/parser/types";
import { buildPolyData, Cell, prepareNodes, PreparedNodes } from "./meshBuilder";
import { OutlineNode, renderOutline } from "./outline";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

type RGB = [number, number, number];

const PALETTE: RGB[] = [
  [0.26, 0.59, 0.98],
  [0.96, 0.62, 0.1],
  [0.2, 0.73, 0.4],
  [0.91, 0.3, 0.24],
  [0.61, 0.35, 0.71],
  [0.1, 0.74, 0.74],
  [0.85, 0.65, 0.13],
  [0.55, 0.55, 0.6],
];

interface Layer {
  id: string;
  actor: any;
  mapper: any;
  color: RGB;
  visible: boolean;
}

// --- DOM ----------------------------------------------------------------
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
const zoomManip = vtkMouseCameraTrackballZoomManipulator.newInstance({ scrollEnabled: true, dragEnabled: false });
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
  if (showNodeIds) {
    requestLabelUpdate();
  }
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

// --- Message handling ---------------------------------------------------
window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case "model":
      model = msg.model as MdpaModel;
      buildScene();
      break;
    case "resetCamera":
      resetCamera();
      break;
    case "toggleNodeIds":
      setNodeIds(!showNodeIds);
      break;
    case "error":
      messageEl.textContent = `Parse error: ${msg.message}`;
      break;
  }
});

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
  if (!model) {
    return;
  }
  clearScene();
  prepared = prepareNodes(model);

  // Resolve entity ids -> cells, per kind, for SubModelPart layers.
  const elementById = new Map<number, Cell>();
  const conditionById = new Map<number, Cell>();
  const geometryById = new Map<number, Cell>();
  for (const block of model.blocks) {
    const target =
      block.kind === "Elements"
        ? elementById
        : block.kind === "Conditions"
        ? conditionById
        : geometryById;
    for (const e of block.entities) {
      target.set(e.id, { cellType: block.vtkCellType, nodeIds: e.nodeIds });
    }
  }

  // One layer per entity block (visible by default).
  let colorIdx = 0;
  const blockNodes: OutlineNode[] = [];
  for (const block of model.blocks) {
    const color = PALETTE[colorIdx % PALETTE.length];
    colorIdx++;
    const cells: Cell[] = block.entities.map((e) => ({
      cellType: block.vtkCellType,
      nodeIds: e.nodeIds,
    }));
    const id = `block:${block.kind}:${block.name}`;
    const created = addLayer(id, cells, color, true);
    blockNodes.push({
      label: block.name + (block.vtkCellType === undefined ? " (?)" : ""),
      count: block.entities.length,
      layerId: created ? id : undefined,
      visible: true,
      color,
    });
  }

  // One overlay layer per SubModelPart (hidden by default), recursive.
  const partNodes: OutlineNode[] = model.subModelParts.map((p) =>
    buildPartLayer(p, elementById, conditionById, geometryById, () => {
      const c = PALETTE[colorIdx % PALETTE.length];
      colorIdx++;
      return c;
    })
  );

  const roots: OutlineNode[] = [];
  if (blockNodes.length) {
    roots.push({ label: "Mesh", section: true, children: blockNodes });
  }
  if (partNodes.length) {
    roots.push({ label: "SubModelParts", section: true, children: partNodes });
  }
  renderOutline(outlineEl, roots, {
    onToggle: (layerId, visible) => setLayerVisible(layerId, visible),
    onFocus: (layerId) => frameLayer(layerId),
  });

  renderStats();
  resetCamera();

  if (cutActive) {
    updateCutPlane();
    applyClipToMappers();
  }
  findMsgEl.textContent = "";
}

function buildPartLayer(
  part: SubModelPart,
  elementById: Map<number, Cell>,
  conditionById: Map<number, Cell>,
  geometryById: Map<number, Cell>,
  nextColor: () => RGB
): OutlineNode {
  const cells: Cell[] = [];
  for (const eid of part.elementIds) {
    const c = elementById.get(eid);
    if (c) cells.push(c);
  }
  for (const cid of part.conditionIds) {
    const c = conditionById.get(cid);
    if (c) cells.push(c);
  }
  for (const gid of part.geometryIds) {
    const c = geometryById.get(gid);
    if (c) cells.push(c);
  }
  // When no entities are explicitly listed but we have nodes, infer entities
  // whose entire connectivity is contained within this SubModelPart's node set.
  // This handles the common pattern where SubModelParts carry only
  // SubModelPartNodes (e.g. for boundary-condition application) and lets the
  // viewer show the surface/line geometry touching those nodes.
  let induced = false;
  if (cells.length === 0 && part.nodeIds.length > 0) {
    const nodeSet = new Set(part.nodeIds);
    for (const cell of elementById.values()) {
      if (cell.nodeIds.every((nid) => nodeSet.has(nid))) {
        cells.push(cell);
      }
    }
    for (const cell of conditionById.values()) {
      if (cell.nodeIds.every((nid) => nodeSet.has(nid))) {
        cells.push(cell);
      }
    }
    for (const cell of geometryById.values()) {
      if (cell.nodeIds.every((nid) => nodeSet.has(nid))) {
        cells.push(cell);
      }
    }
    induced = cells.length > 0;
  }

  // Final fallback: point cloud when no geometry can be inferred at all.
  if (cells.length === 0 && part.nodeIds.length > 0) {
    for (const nid of part.nodeIds) {
      cells.push({ cellType: undefined, nodeIds: [nid] });
    }
  }

  const color = nextColor();
  const id = `smp:${part.path}`;
  const created = addLayer(id, cells, color, false);
  const explicitCount =
    part.elementIds.length + part.conditionIds.length + part.geometryIds.length;
  const total = explicitCount > 0
    ? explicitCount
    : induced
    ? cells.length
    : part.nodeIds.length;

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

function addLayer(id: string, cells: Cell[], color: RGB, visible: boolean): boolean {
  if (!prepared) {
    return false;
  }
  const built = buildPolyData(prepared, cells);
  if (!built) {
    return false;
  }
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(built.polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setColor(color[0], color[1], color[2]);
  prop.setEdgeVisibility(true);
  prop.setEdgeColor(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5);
  prop.setPointSize(6);
  prop.setLineWidth(1.5);
  actor.setVisibility(visible);
  renderer.addActor(actor);
  actors.push(actor);
  layers.set(id, { id, actor, mapper, color, visible });
  return true;
}

// --- Interaction --------------------------------------------------------
function setLayerVisible(layerId: string, visible: boolean): void {
  const layer = layers.get(layerId);
  if (!layer) {
    return;
  }
  layer.visible = visible;
  layer.actor.setVisibility(visible);
  renderWindow.render();
}

function frameLayer(layerId: string): void {
  const layer = layers.get(layerId);
  if (!layer) {
    return;
  }
  const bounds = layer.actor.getBounds();
  if (bounds && bounds[0] <= bounds[1]) {
    renderer.resetCamera(bounds);
    renderWindow.render();
    if (showNodeIds) {
      requestLabelUpdate();
    }
  }
}

function resetCamera(): void {
  renderer.resetCamera();
  renderWindow.render();
  if (showNodeIds) {
    requestLabelUpdate();
  }
}

function setPanMode(on: boolean): void {
  panMode = on;
  const btn = document.querySelector('#toolbar button[data-action="pan"]');
  btn?.classList.toggle("active", on);
  if (on) {
    applyPanMode();
  } else {
    applyRotateMode();
  }
}

function setWireframe(on: boolean): void {
  wireframe = on;
  // Representation: 1 = wireframe, 2 = surface.
  for (const layer of layers.values()) {
    layer.actor.getProperty().setRepresentation(on ? 1 : 2);
  }
  renderWindow.render();
}

// --- Cut plane ----------------------------------------------------------
const clipPlane = vtkPlane.newInstance();
let cutActive = false;
let cutAxis: 0 | 1 | 2 = 2;
let cutFlipped = false;

const cutPanel = document.getElementById("cut-panel") as HTMLElement;
const cutSlider = document.getElementById("cut-slider") as HTMLInputElement;
const cutPositionEl = document.getElementById("cut-position") as HTMLElement;

function updateCutPlane(): void {
  if (!model) return;
  const b = model.bounds;
  const normals: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const n = normals[cutAxis];
  const normal: [number, number, number] = cutFlipped ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
  const min = b.min[cutAxis];
  const max = b.max[cutAxis];
  const t = Number(cutSlider.value) / 100;
  const pos = min + t * (max - min);
  const origin: [number, number, number] = [0, 0, 0];
  origin[cutAxis] = pos;
  clipPlane.setNormal(normal);
  clipPlane.setOrigin(origin);
  cutPositionEl.textContent = `${"XYZ"[cutAxis]} = ${pos.toPrecision(4)}`;
}

function applyClipToMappers(): void {
  for (const layer of layers.values()) {
    layer.mapper.removeAllClippingPlanes();
    if (cutActive) {
      layer.mapper.addClippingPlane(clipPlane);
    }
  }
  renderWindow.render();
}

function setCut(on: boolean): void {
  cutActive = on;
  const btn = document.querySelector('#toolbar button[data-action="cut"]');
  btn?.classList.toggle("active", on);
  cutPanel.classList.toggle("hidden", !on);
  if (on) {
    updateCutPlane();
  }
  applyClipToMappers();
}

cutSlider.addEventListener("input", () => {
  updateCutPlane();
  renderWindow.render();
});

document.querySelectorAll('input[name="cut-axis"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    cutAxis = Number((radio as HTMLInputElement).value) as 0 | 1 | 2;
    updateCutPlane();
    renderWindow.render();
  });
});

document.getElementById("cut-flip")?.addEventListener("click", function () {
  cutFlipped = !cutFlipped;
  this.classList.toggle("active", cutFlipped);
  updateCutPlane();
  renderWindow.render();
});

// --- Locate node / entity -----------------------------------------------
const findPanel = document.getElementById("find-panel") as HTMLElement;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findMsgEl = document.getElementById("find-msg") as HTMLElement;
let findActive = false;

function setFind(on: boolean): void {
  findActive = on;
  const btn = document.querySelector('#toolbar button[data-action="find"]');
  btn?.classList.toggle("active", on);
  findPanel.classList.toggle("hidden", !on);
  if (on) findInput.focus();
}

function locate(): void {
  if (!model || !prepared) return;
  const id = parseInt(findInput.value.trim(), 10);
  if (isNaN(id)) {
    findMsgEl.textContent = "Enter a numeric ID";
    return;
  }

  const extent = Math.max(
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
    model.bounds.max[2] - model.bounds.min[2]
  ) * 0.05;

  // Node lookup via the prepared index (O(1)).
  const nodeIdx = prepared.index.get(id);
  if (nodeIdx !== undefined) {
    const n = model.nodes[nodeIdx];
    renderer.resetCamera([n.x - extent, n.x + extent, n.y - extent, n.y + extent, n.z - extent, n.z + extent]);
    renderWindow.render();
    findMsgEl.textContent = `Node ${id}: (${n.x.toPrecision(4)}, ${n.y.toPrecision(4)}, ${n.z.toPrecision(4)})`;
    return;
  }

  // Entity lookup across all blocks.
  for (const block of model.blocks) {
    const entity = block.entities.find((e) => e.id === id);
    if (entity) {
      const pts = entity.nodeIds
        .map((nid) => { const i = prepared!.index.get(nid); return i !== undefined ? model!.nodes[i] : undefined; })
        .filter((n): n is NonNullable<typeof n> => n !== undefined);
      if (pts.length === 0) {
        findMsgEl.textContent = `${block.kind.slice(0, -1)} ${id}: no mapped nodes`;
        return;
      }
      const cx = pts.reduce((s, n) => s + n.x, 0) / pts.length;
      const cy = pts.reduce((s, n) => s + n.y, 0) / pts.length;
      const cz = pts.reduce((s, n) => s + n.z, 0) / pts.length;
      renderer.resetCamera([cx - extent, cx + extent, cy - extent, cy + extent, cz - extent, cz + extent]);
      renderWindow.render();
      findMsgEl.textContent = `${block.kind.slice(0, -1)} ${id} in "${block.name}"`;
      return;
    }
  }

  findMsgEl.textContent = `ID ${id} not found`;
}

findInput.addEventListener("keydown", (e) => { if (e.key === "Enter") locate(); });
findInput.addEventListener("input", () => { findMsgEl.textContent = ""; });
document.getElementById("find-go")?.addEventListener("click", locate);

// --- Node id labels -----------------------------------------------------
let labelFrame: number | undefined;
function requestLabelUpdate(): void {
  if (labelFrame !== undefined) {
    return;
  }
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
  if (model.nodes.length > NODE_LABEL_LIMIT) {
    messageEl.textContent = `Node IDs hidden: ${model.nodes.length} nodes exceed the ${NODE_LABEL_LIMIT} label limit.`;
    showNodeIds = false;
    btn?.classList.remove("active");
    return;
  }
  // Pre-create one label element per node.
  for (const n of model.nodes) {
    const el = document.createElement("div");
    el.className = "node-label";
    el.textContent = String(n.id);
    el.dataset.x = String(n.x);
    el.dataset.y = String(n.y);
    el.dataset.z = String(n.z);
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
  if (!showNodeIds) {
    return;
  }
  const size = apiRW.getSize(); // device pixels [w, h]
  const dpr = window.devicePixelRatio || 1;
  const children = labelsEl.children;
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    const x = Number(el.dataset.x);
    const y = Number(el.dataset.y);
    const z = Number(el.dataset.z);
    const disp = apiRW.worldToDisplay(x, y, z, renderer); // origin bottom-left
    const left = disp[0] / dpr;
    const top = (size[1] - disp[1]) / dpr;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
}

// --- Stats panel --------------------------------------------------------
function renderStats(): void {
  if (!model) {
    return;
  }
  const count = (kind: string) =>
    model!.blocks
      .filter((b) => b.kind === kind)
      .reduce((s, b) => s + b.entities.length, 0);
  const unmapped = model.blocks.filter((b) => b.vtkCellType === undefined);
  const b = model.bounds;
  const fmt = (v: number) => (Number.isFinite(v) ? v.toPrecision(4) : "0");

  const rows: string[] = [
    row("Nodes", String(model.nodes.length)),
    row("Elements", String(count("Elements"))),
    row("Conditions", String(count("Conditions"))),
    row("Geometries", String(count("Geometries"))),
    row("SubModelParts", String(countParts(model.subModelParts))),
    row("Dimensionality", model.is3D ? "3D" : "2D"),
    row(
      "Bounds",
      `[${fmt(b.min[0])}, ${fmt(b.min[1])}, ${fmt(b.min[2])}] – [${fmt(
        b.max[0]
      )}, ${fmt(b.max[1])}, ${fmt(b.max[2])}]`
    ),
  ];
  if (unmapped.length) {
    rows.push(
      `<div class="stat-row warn"><span class="stat-key">Unmapped types</span><span>${unmapped
        .map((u) => u.name)
        .join(", ")}</span></div>`
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
  for (const p of parts) {
    n += countParts(p.children);
  }
  return n;
}

// --- Toolbar ------------------------------------------------------------
document.getElementById("toolbar")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const action = target.dataset.action;
  if (action === "reset") {
    resetCamera();
  } else if (action === "pan") {
    setPanMode(!panMode);
  } else if (action === "cut") {
    setCut(!cutActive);
  } else if (action === "find") {
    setFind(!findActive);
  } else if (action === "wireframe") {
    setWireframe(!wireframe);
    target.classList.toggle("active", wireframe);
  } else if (action === "nodeIds") {
    setNodeIds(!showNodeIds);
  }
});

// --- Helpers ------------------------------------------------------------
function readThemeBackground(): RGB {
  const css = getComputedStyle(document.body).backgroundColor;
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length >= 3) {
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
    }
  }
  return [0.12, 0.12, 0.14];
}

// Tell the host we are ready to receive the model.
vscode.postMessage({ type: "ready" });
