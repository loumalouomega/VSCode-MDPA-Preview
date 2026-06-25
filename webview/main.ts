import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";

import { EntityBlock, EntityKind, MdpaModel, SubModelPart } from "../src/parser/types";
import { computeMeshQuality, QualityReport } from "../src/parser/meshQuality";
import { computeIsoSurface } from "../src/parser/isoSurface";
import { buildPolyData, Cell, prepareNodes, PreparedNodes } from "./meshBuilder";
import { OutlineNode, renderOutline } from "./outline";
import { renderQualityPanel } from "./qualityPanel";
import { FieldMode, FieldPanelState, renderFieldPanel } from "./fieldPanel";
import { buildFieldInfo, FieldInfo, vectorAt } from "./fieldData";
import { contourAttach, configureScalarMapper, buildIsoPolyData } from "./fieldRender";
import { buildGlyphActor, QuiverData } from "./quiver";
import { DEFAULT_COLORMAP, colorAt } from "./colormaps";
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

const fieldPanelEl = document.createElement("div");
fieldPanelEl.id = "field-panel";
fieldPanelEl.style.display = "none";
viewport.appendChild(fieldPanelEl);

// --- VTK scene ----------------------------------------------------------
const grw: any = vtkGenericRenderWindow.newInstance({
  background: getThemeBackground(document.body.dataset.theme ?? "auto") ?? readThemeBackground(),
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

let currentTheme: string = document.body.dataset.theme ?? "auto";

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
const CUT_CAP_ID = "cut:cap";
const CUT_CAP_COLOR: RGB = [0.72, 0.72, 0.72];

// Field visualization state.
const FIELD_CONTOUR_ID = "field:contour";
const FIELD_QUIVER_ID = "field:quiver";
const FIELD_ISO_ID = "field:iso";
const FIELD_LAYER_IDS = [FIELD_CONTOUR_ID, FIELD_QUIVER_ID, FIELD_ISO_ID];
let fieldInfos: FieldInfo[] = [];
let fieldVisible = false;
let fieldDimmed = false; // base layers forced to wireframe while a field is shown
let currentColormap = DEFAULT_COLORMAP;
const fieldState = {
  selectedKey: "",
  mode: "contour" as FieldMode,
  isoValue: 0,
  scale: 1,
};

applyTheme(currentTheme);

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
    case "field":
      toggleFieldPanel();
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
  // Base layers are recreated solid; any prior field dimming no longer applies.
  fieldDimmed = false;
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
        entityId: block.entityIds[i],
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

  // Rebuild field lookups; keep the selection if the variable still exists.
  fieldInfos = model.fields.map(buildFieldInfo);
  if (!fieldInfos.some((i) => i.key === fieldState.selectedKey)) {
    fieldState.selectedKey = fieldInfos[0]?.key ?? "";
    resetFieldStateForSelection();
  }

  renderStats();
  resetCamera();

  if (cutActive) {
    updateCutPlane();
    applyClipToMappers();
    buildCutCap();
    renderWindow.render();
  }
  // Refresh the quality panel against the new model if it is open.
  if (qualityVisible) showQualityPanel();
  // Refresh the field panel against the new model if it is open.
  if (fieldVisible) showFieldPanel();
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
  if (cutActive) mapper.addClippingPlane(clipPlane);
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

function applyTheme(name: string): void {
  currentTheme = name;

  const bg = getThemeBackground(name) ?? readThemeBackground();
  renderer.setBackground(bg[0], bg[1], bg[2]);

  const palette = getThemePalette(name);
  for (const [id, layer] of layers) {
    if (id === QUALITY_HIGHLIGHT_ID || id === FIND_HIGHLIGHT_ID) continue;
    if (layer.paletteIndex < 0) continue;
    const color = palette[layer.paletteIndex % palette.length];
    layer.color = color;
    const prop = layer.actor.getProperty();
    prop.setColor(color[0], color[1], color[2]);
    prop.setEdgeColor(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5);
    const swatch = document.querySelector<HTMLElement>(
      `.outline-swatch[data-layer-id="${CSS.escape(id)}"]`
    );
    if (swatch) {
      swatch.style.background =
        `rgb(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)})`;
    }
  }

  renderWindow.render();
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
    // Keep highlights and cap solid; wireframe on the fan triangulation looks wrong.
    if (id === FIND_HIGHLIGHT_ID || id === CUT_CAP_ID) continue;
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
    if (layer.id === CUT_CAP_ID) continue; // cap lives on the plane; do not clip it
    const mapper = layer.actor.getMapper();
    if (!mapper) continue;
    mapper.removeAllClippingPlanes();
    if (cutActive) mapper.addClippingPlane(clipPlane);
  }
  renderWindow.render();
}

// --- Cut cap: fills the cross-section so the mesh looks solid -----------

type Vec3 = [number, number, number];
type Vec2 = [number, number];

/** Two orthonormal vectors [u, v] that span the plane perpendicular to `nrm`. */
function planeBasis(nrm: Vec3): [Vec3, Vec3] {
  const seed: Vec3 =
    Math.abs(nrm[0]) <= Math.abs(nrm[1]) && Math.abs(nrm[0]) <= Math.abs(nrm[2])
      ? [1, 0, 0]
      : Math.abs(nrm[1]) <= Math.abs(nrm[2])
      ? [0, 1, 0]
      : [0, 0, 1];
  const dot = seed[0]*nrm[0] + seed[1]*nrm[1] + seed[2]*nrm[2];
  const u: Vec3 = [seed[0]-dot*nrm[0], seed[1]-dot*nrm[1], seed[2]-dot*nrm[2]];
  const uLen = Math.sqrt(u[0]**2 + u[1]**2 + u[2]**2);
  u[0] /= uLen; u[1] /= uLen; u[2] /= uLen;
  const v: Vec3 = [
    nrm[1]*u[2] - nrm[2]*u[1],
    nrm[2]*u[0] - nrm[0]*u[2],
    nrm[0]*u[1] - nrm[1]*u[0],
  ];
  return [u, v];
}

/**
 * Ear-clipping triangulation of a simple (non-self-intersecting) 2D polygon.
 * Returns index triples into `pts2D`.  Handles non-convex polygons correctly.
 */
function earClip(pts2D: Vec2[]): Array<[number, number, number]> {
  const n = pts2D.length;
  if (n === 3) return [[0, 1, 2]];

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts2D[i], [bx, by] = pts2D[(i+1)%n];
    area2 += ax*by - bx*ay;
  }
  const indices = Array.from({length: n}, (_, i) => i);
  if (area2 < 0) indices.reverse(); // normalise to CCW

  const cross2D = (ax:number,ay:number,bx:number,by:number,cx:number,cy:number) =>
    (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);

  const inTri = (px:number,py:number,ax:number,ay:number,bx:number,by:number,cx:number,cy:number) =>
    cross2D(ax,ay,bx,by,px,py) > 0 &&
    cross2D(bx,by,cx,cy,px,py) > 0 &&
    cross2D(cx,cy,ax,ay,px,py) > 0;

  const result: Array<[number,number,number]> = [];
  let maxIter = n*n + n;

  while (indices.length > 3 && maxIter-- > 0) {
    const m = indices.length;
    let earFound = false;
    for (let i = 0; i < m; i++) {
      const iA = indices[(i-1+m)%m], iB = indices[i], iC = indices[(i+1)%m];
      const [ax,ay] = pts2D[iA], [bx,by] = pts2D[iB], [cx,cy] = pts2D[iC];
      if (cross2D(ax,ay,bx,by,cx,cy) < 1e-12) continue; // reflex or degenerate
      let blocked = false;
      for (let j = 0; j < m; j++) {
        const iP = indices[j];
        if (iP === iA || iP === iB || iP === iC) continue;
        const [px,py] = pts2D[iP];
        if (inTri(px,py,ax,ay,bx,by,cx,cy)) { blocked = true; break; }
      }
      if (!blocked) {
        result.push([iA, iB, iC]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) break; // degenerate polygon — exit safely
  }
  if (indices.length === 3) result.push([indices[0], indices[1], indices[2]]);
  return result;
}

// Computes plane–polygon intersections directly from polydata (no vtkCutter).
function buildCutCap(): void {
  removeLayer(CUT_CAP_ID);
  if (!cutActive) return;

  const nrm = clipPlane.getNormal() as Vec3;
  const orig = clipPlane.getOrigin() as Vec3;
  const [uAxis, vAxis] = planeBasis(nrm);

  const SKIP = new Set([CUT_CAP_ID, QUALITY_HIGHLIGHT_ID, FIND_HIGHLIGHT_ID, ...FIELD_LAYER_IDS]);
  const capPoints: number[] = [];
  const capPolys: number[] = [];

  for (const [id, layer] of layers) {
    if (SKIP.has(id) || !layer.visible || !layer.built) continue;
    const mapper = layer.actor.getMapper();
    if (!mapper) continue;
    const pd = mapper.getInputData();
    if (!pd) continue;
    const polysData = pd.getPolys()?.getData();
    if (!polysData || polysData.length === 0) continue;
    const pts: Float32Array = pd.getPoints().getData();

    // Signed distance from the cut plane for every point in this layer
    const nPts = pts.length / 3;
    const dist = new Float64Array(nPts);
    for (let i = 0; i < nPts; i++) {
      dist[i] =
        nrm[0] * (pts[i * 3]     - orig[0]) +
        nrm[1] * (pts[i * 3 + 1] - orig[1]) +
        nrm[2] * (pts[i * 3 + 2] - orig[2]);
    }

    // Walk every polygon face; collect one segment per crossed face
    type Pt3 = [number, number, number];
    const segs: Array<[Pt3, Pt3]> = [];
    let pi = 0;
    while (pi < polysData.length) {
      const n = polysData[pi++];
      // Read vertex IDs for this face
      const vids: number[] = [];
      for (let j = 0; j < n; j++) vids.push(polysData[pi++]);
      if (n < 3) continue;

      // Linear interpolation of crossing point on edge (ia → ib)
      const lerp = (ia: number, ib: number): Pt3 => {
        const da = dist[ia], db = dist[ib];
        const t = da / (da - db);
        return [
          pts[ia * 3]     + t * (pts[ib * 3]     - pts[ia * 3]),
          pts[ia * 3 + 1] + t * (pts[ib * 3 + 1] - pts[ia * 3 + 1]),
          pts[ia * 3 + 2] + t * (pts[ib * 3 + 2] - pts[ia * 3 + 2]),
        ];
      };

      // Collect the (exactly 2, for a triangle) edges that cross the plane
      const cross: Pt3[] = [];
      for (let e = 0; e < n; e++) {
        const ia = vids[e], ib = vids[(e + 1) % n];
        if ((dist[ia] > 0) !== (dist[ib] > 0)) cross.push(lerp(ia, ib));
      }
      if (cross.length === 2) segs.push([cross[0], cross[1]]);
    }

    if (segs.length === 0) continue;

    // Deduplicate segment endpoints by floating-point string key (O(n))
    // Two edge-crossing points are identical when they come from the same mesh edge.
    const ptKey = (p: Pt3) => `${p[0]}_${p[1]}_${p[2]}`;
    const keyToIdx = new Map<string, number>();
    const dedupPts: Pt3[] = [];
    const getIdx = (p: Pt3): number => {
      const k = ptKey(p);
      if (keyToIdx.has(k)) return keyToIdx.get(k)!;
      const idx = dedupPts.length;
      dedupPts.push(p);
      keyToIdx.set(k, idx);
      return idx;
    };

    // Build adjacency from deduplicated point IDs
    const adj = new Map<number, number[]>();
    for (const [p0, p1] of segs) {
      const a = getIdx(p0), b = getIdx(p1);
      if (a === b) continue;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }

    // Walk adjacency chains → one loop per connected component
    const visited = new Set<number>();
    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      const chain: number[] = [start];
      visited.add(start);
      let cur = start;
      let found = true;
      while (found) {
        found = false;
        for (const next of (adj.get(cur) ?? [])) {
          if (!visited.has(next)) {
            chain.push(next);
            visited.add(next);
            cur = next;
            found = true;
            break;
          }
        }
      }
      if (chain.length < 3) continue;

      // Ear-clip triangulate — correct for non-convex cross-sections
      const loop3D: Vec3[] = chain.map(idx => dedupPts[idx]);
      const loop2D: Vec2[] = loop3D.map(([x, y, z]) => [
        uAxis[0]*(x-orig[0]) + uAxis[1]*(y-orig[1]) + uAxis[2]*(z-orig[2]),
        vAxis[0]*(x-orig[0]) + vAxis[1]*(y-orig[1]) + vAxis[2]*(z-orig[2]),
      ]);
      const triangles = earClip(loop2D);
      if (triangles.length === 0) continue;

      const base = capPoints.length / 3;
      for (const [x, y, z] of loop3D) capPoints.push(x, y, z);
      for (const [iA, iB, iC] of triangles) {
        capPolys.push(3, base + iA, base + iB, base + iC);
      }
    }
  }

  if (capPolys.length === 0) return;

  const capPd = vtkPolyData.newInstance();
  capPd.getPoints().setData(new Float32Array(capPoints), 3);
  capPd.getPolys().setData(new Uint32Array(capPolys));

  const capMapper = vtkMapper.newInstance();
  capMapper.setInputData(capPd);
  // Scalar coloring must be off so the actor property colour (gray) is used.
  capMapper.setScalarVisibility(false);
  // Polygon offset ensures the cap always renders in front of coplanar mesh
  // faces (e.g. element-block boundaries exactly on the cut plane).
  // These methods are added at runtime by implementCoincidentTopologyMethods
  // but are not reflected in the vtk.js TypeScript stubs, so cast to any.
  (capMapper as any).setResolveCoincidentTopologyToPolygonOffset();
  (capMapper as any).setRelativeCoincidentTopologyPolygonOffsetParameters(-2, -2);
  const capActor = vtkActor.newInstance();
  capActor.setMapper(capMapper);
  const prop = capActor.getProperty();
  prop.setColor(CUT_CAP_COLOR[0], CUT_CAP_COLOR[1], CUT_CAP_COLOR[2]);
  prop.setEdgeVisibility(false);
  prop.setAmbient(0.3);
  prop.setDiffuse(0.7);

  // Register WITHOUT a clip plane — the cap sits exactly on the plane;
  // applying the clip plane to its mapper would erase it.
  const capLayer: Layer = {
    id: CUT_CAP_ID, actor: capActor, color: CUT_CAP_COLOR,
    paletteIndex: -1, visible: true, built: true,
  };
  capActor.setVisibility(true);
  renderer.addActor(capActor);
  actors.push(capActor);
  layers.set(CUT_CAP_ID, capLayer);
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
  buildCutCap();
  renderWindow.render();
}

cutSlider.addEventListener("input", () => {
  updateCutPlane();
  buildCutCap();
  renderWindow.render();
});

document.querySelectorAll('input[name="cut-axis"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    cutAxis = Number((radio as HTMLInputElement).value) as 0 | 1 | 2;
    updateCutPlane();
    buildCutCap();
    renderWindow.render();
  });
});

document.getElementById("cut-flip")?.addEventListener("click", function () {
  cutFlipped = !cutFlipped;
  this.classList.toggle("active", cutFlipped);
  updateCutPlane();
  buildCutCap();
  renderWindow.render();
});

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
  else if (action === "cut") setCut(!cutActive);
  else if (action === "wireframe") {
    setWireframe(!wireframe);
    target.classList.toggle("active", wireframe);
  } else if (action === "nodeIds") setNodeIds(!showNodeIds);
  else if (action === "quality") toggleQualityPanel();
  else if (action === "find") toggleFindBar();
  else if (action === "field") toggleFieldPanel();
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

// --- Field visualization ------------------------------------------------
function selectedFieldInfo(): FieldInfo | undefined {
  return fieldInfos.find((i) => i.key === fieldState.selectedKey);
}

// True when the model carries volume cells (isosurface yields surfaces, not lines).
function modelHasVolume(): boolean {
  if (!model) return false;
  for (const block of model.blocks) {
    if (isVolumeBlock(block)) return true;
  }
  return false;
}

// Picks a sensible default mode + iso value for the current selection.
function resetFieldStateForSelection(): void {
  const info = selectedFieldInfo();
  if (!info) return;
  fieldState.isoValue = (info.scalarMin + info.scalarMax) / 2;
  if (info.isVector) {
    fieldState.mode = "quiver";
  } else if (fieldState.mode === "quiver") {
    // A scalar field cannot use quiver; fall back to contour.
    fieldState.mode = "contour";
  }
}

function toggleFieldPanel(): void {
  if (fieldVisible) hideFieldPanel();
  else showFieldPanel();
}

function showFieldPanel(): void {
  if (!model) return;
  renderFieldPanelUI();
  fieldPanelEl.style.display = "";
  fieldVisible = true;
  document.querySelector('#toolbar button[data-action="field"]')?.classList.add("active");
  applyFieldMode();
}

function hideFieldPanel(): void {
  fieldPanelEl.style.display = "none";
  fieldVisible = false;
  removeFieldLayers();
  restoreFieldBase();
  document.querySelector('#toolbar button[data-action="field"]')?.classList.remove("active");
}

function renderFieldPanelUI(): void {
  const state: FieldPanelState = {
    infos: fieldInfos,
    selectedKey: fieldState.selectedKey,
    mode: fieldState.mode,
    colormap: currentColormap,
    isoValue: fieldState.isoValue,
    scale: fieldState.scale,
    hasVolume: modelHasVolume(),
  };
  renderFieldPanel(fieldPanelEl, state, {
    onClose: () => hideFieldPanel(),
    onSelectVariable: (key) => {
      fieldState.selectedKey = key;
      resetFieldStateForSelection();
      renderFieldPanelUI();
      applyFieldMode();
    },
    onSelectMode: (mode) => {
      fieldState.mode = mode;
      renderFieldPanelUI();
      applyFieldMode();
    },
    onSelectColormap: (name) => {
      currentColormap = name;
      renderFieldPanelUI();
      applyFieldMode();
    },
    onIsoValue: (v) => {
      fieldState.isoValue = v;
      scheduleIsoRebuild();
    },
    onScale: (v) => {
      fieldState.scale = v;
      applyFieldMode();
    },
  });
}

// Removes any field overlay layers.
function removeFieldLayers(): void {
  for (const id of FIELD_LAYER_IDS) removeLayer(id);
}

// Forces base mesh layers to wireframe so the field overlay reads clearly.
function dimFieldBase(): void {
  fieldDimmed = true;
  for (const [id, layer] of layers) {
    if (FIELD_LAYER_IDS.includes(id) || id === CUT_CAP_ID) continue;
    layer.actor.getProperty().setRepresentation(1);
  }
}

function restoreFieldBase(): void {
  if (!fieldDimmed) return;
  fieldDimmed = false;
  const rep = wireframe ? 1 : 2;
  for (const [id, layer] of layers) {
    if (FIELD_LAYER_IDS.includes(id) || id === CUT_CAP_ID) continue;
    layer.actor.getProperty().setRepresentation(rep);
  }
  renderWindow.render();
}

// Registers a pre-built actor as a field layer (no lazy cells, no palette color).
function registerFieldLayer(id: string, actor: any): void {
  removeLayer(id);
  const layer: Layer = {
    id,
    actor,
    color: [1, 1, 1],
    paletteIndex: -1,
    visible: true,
    built: true,
  };
  actor.setVisibility(true);
  renderer.addActor(actor);
  actors.push(actor);
  layers.set(id, layer);
  if (cutActive) {
    const mapper = actor.getMapper();
    if (mapper) mapper.addClippingPlane(clipPlane);
  }
}

// Collects render cells for the given entity kinds (or all blocks).
function collectCells(kinds: EntityKind[] | "all"): Cell[] {
  const cells: Cell[] = [];
  if (!model) return cells;
  for (const block of model.blocks) {
    if (kinds !== "all" && !kinds.includes(block.kind)) continue;
    for (let i = 0; i < block.count; i++) {
      cells.push({
        cellType: block.vtkCellType,
        nodeIds: block.connectivity.subarray(i * block.stride, (i + 1) * block.stride),
        entityId: block.entityIds[i],
      });
    }
  }
  return cells;
}

// Rebuilds whichever field overlay matches the current mode.
function applyFieldMode(): void {
  removeFieldLayers();
  const info = selectedFieldInfo();
  if (!info || !prepared || !model) {
    restoreFieldBase();
    renderWindow.render();
    return;
  }
  if (fieldState.mode === "contour") buildContourLayer(info);
  else if (fieldState.mode === "quiver" && info.isVector) buildQuiverLayer(info);
  else if (fieldState.mode === "iso" && !info.isVector) buildIsoLayer(info);

  if (layers.has(FIELD_CONTOUR_ID) || layers.has(FIELD_QUIVER_ID) || layers.has(FIELD_ISO_ID)) {
    dimFieldBase();
  } else {
    restoreFieldBase();
  }
  renderWindow.render();
}

function buildContourLayer(info: FieldInfo): void {
  const kinds: EntityKind[] | "all" =
    info.field.kind === "Elemental" ? ["Elements"] : info.field.kind === "Conditional" ? ["Conditions"] : "all";
  const cells = collectCells(kinds);
  const built = buildPolyData(prepared!, cells, contourAttach(info));
  if (!built) return;
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(built.polyData);
  configureScalarMapper(mapper, info, currentColormap);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setEdgeVisibility(false);
  registerFieldLayer(FIELD_CONTOUR_ID, actor);
}

function buildQuiverLayer(info: FieldInfo): void {
  const data = buildQuiverData(info);
  if (!data || data.points.length === 0) return;
  const scaleFactor = quiverBaseScale(info) * fieldState.scale;
  const actor = buildGlyphActor(data, scaleFactor, currentColormap, info.scalarMin, info.scalarMax);
  registerFieldLayer(FIELD_QUIVER_ID, actor);
}

function buildIsoLayer(info: FieldInfo): void {
  const result = computeIsoSurface(model!, info.field, fieldState.isoValue);
  if (result.points.length === 0) return;
  const pd = buildIsoPolyData(result);
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(pd);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const span = info.scalarMax - info.scalarMin;
  const t = span > 0 ? (fieldState.isoValue - info.scalarMin) / span : 0.5;
  const c = colorAt(currentColormap, t);
  const prop = actor.getProperty();
  prop.setColor(c[0], c[1], c[2]);
  prop.setEdgeVisibility(false);
  if (result.is2D) prop.setLineWidth(2);
  registerFieldLayer(FIELD_ISO_ID, actor);
}

// Anchor points (node coords or cell centroids), vectors and magnitudes.
function buildQuiverData(info: FieldInfo): QuiverData | undefined {
  if (!prepared) return undefined;
  const pts: number[] = [];
  const vecs: number[] = [];
  const mags: number[] = [];
  const centroidMap =
    info.field.kind === "Elemental" ? elementById : info.field.kind === "Conditional" ? conditionById : undefined;

  for (let i = 0; i < info.field.ids.length; i++) {
    const id = info.field.ids[i];
    const vec = vectorAt(info, id);
    if (!vec) continue;
    let anchor: [number, number, number] | undefined;
    if (info.field.kind === "Nodal") {
      anchor = nodeCoord(id);
    } else {
      const cell = centroidMap?.get(id);
      if (cell) anchor = cellCentroid(cell);
    }
    if (!anchor) continue;
    pts.push(anchor[0], anchor[1], anchor[2]);
    vecs.push(vec[0], vec[1], vec[2]);
    mags.push(Math.hypot(vec[0], vec[1], vec[2]));
  }
  return {
    points: Float32Array.from(pts),
    vectors: Float32Array.from(vecs),
    magnitudes: Float32Array.from(mags),
  };
}

function nodeCoord(nodeId: number): [number, number, number] | undefined {
  if (!prepared) return undefined;
  const idx = prepared.index.get(nodeId);
  if (idx === undefined) return undefined;
  const o = idx * 3;
  return [prepared.coords[o], prepared.coords[o + 1], prepared.coords[o + 2]];
}

function cellCentroid(cell: Cell): [number, number, number] | undefined {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (let i = 0; i < cell.nodeIds.length; i++) {
    const c = nodeCoord(cell.nodeIds[i]);
    if (!c) continue;
    x += c[0];
    y += c[1];
    z += c[2];
    n++;
  }
  if (n === 0) return undefined;
  return [x / n, y / n, z / n];
}

// Default arrow scale: largest arrow ≈ 5% of the model bounding-box diagonal.
function quiverBaseScale(info: FieldInfo): number {
  if (!model) return 1;
  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const maxMag = info.scalarMax > 0 ? info.scalarMax : 1;
  return (0.05 * (diag || 1)) / maxMag;
}

// Debounced isosurface rebuild for slider drags.
let isoFrame: number | undefined;
function scheduleIsoRebuild(): void {
  if (isoFrame !== undefined) return;
  isoFrame = requestAnimationFrame(() => {
    isoFrame = undefined;
    applyFieldMode();
  });
}

// --- Find entity --------------------------------------------------------
// While a find highlight is active, all other layers are forced to wireframe
// so the highlighted entity stands out clearly.
function applyFindWireframe(): void {
  for (const [id, layer] of layers) {
    if (id === CUT_CAP_ID) continue; // keep cap solid
    layer.actor.getProperty().setRepresentation(id === FIND_HIGHLIGHT_ID ? 2 : 1);
  }
  renderWindow.render();
}

function restoreWireframe(): void {
  const rep = wireframe ? 1 : 2;
  for (const [id, layer] of layers) {
    if (id === FIND_HIGHLIGHT_ID || id === CUT_CAP_ID) continue;
    layer.actor.getProperty().setRepresentation(rep);
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

((): void => {
  const themeSelectEl = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (!themeSelectEl) return;
  themeSelectEl.value = currentTheme;
  themeSelectEl.addEventListener("change", () => {
    const name = themeSelectEl.value;
    applyTheme(name);
    vscode.postMessage({ type: "setTheme", theme: name });
  });
})();

vscode.postMessage({ type: "ready" });
