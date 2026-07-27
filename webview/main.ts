import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";

import { EntityBlock, EntityKind, MdpaModel, SubModelPart } from "../src/parser/types";
import { computeMeshQuality, QualityReport } from "../src/parser/meshQuality";
import { computeMeshSize, MeshSizeResult } from "../src/parser/meshSize";
import { computeMeshNormals, MeshNormals } from "../src/parser/meshNormals";
import { computeIsoSurface } from "../src/parser/isoSurface";
import { computePlaneCut } from "../src/parser/planeCut";
import { buildPolyData, Cell, prepareNodes, PreparedNodes } from "./meshBuilder";
import { OutlineCounts, OutlineExportUI, OutlineNode, renderOutline } from "./outline";
import { TOOLBAR_ICONS } from "../src/toolbarIcons";
import {
  EXPORT_FORMAT_LABELS,
  EXPORT_MENU_GROUPS,
} from "../src/parser/writers/exportFormats";
import { renderQualityPanel } from "./qualityPanel";
import {
  MeshSizeColor,
  MeshSizePanelState,
  MeshSizeWriteTarget,
  renderMeshSizePanel,
} from "./meshSizePanel";
import { FieldMode, FieldPanelState, renderFieldPanel } from "./fieldPanel";
import {
  SpherePanelInfo,
  SpherePanelState,
  renderSpherePanel,
} from "./spherePanel";
import { buildSphereGlyphActor } from "./sphereGlyph";
import {
  defaultSphereRadius,
  radiusField,
  sphereBlocks,
  SphereStats,
  sphereStats,
} from "../src/parser/sphereElements";
import { buildFieldInfo, FieldInfo, vectorAt } from "./fieldData";
import {
  contourAttach,
  configureScalarMapper,
  buildIsoPolyData,
  buildCutCapPolyData,
  buildCutCapEdgePolyData,
  attachCutCapScalars,
} from "./fieldRender";
import { buildGlyphActor, QuiverData } from "./quiver";
import { DEFAULT_COLORMAP, colorAt } from "./colormaps";
import { RGB, getThemePalette, getThemeBackground } from "./themes";
import { OrientationCubeHandle, setupOrientationCube } from "./orientationCube";
import { GridAxes, setupGridAxes } from "./gridAxes";
import { NavControls } from "./navControls";
import { TimelineControl } from "./timeline";
import { initSidebarSections } from "./sidebar";
import { initSidebarResize } from "./sidebarResize";
import { initFileMenu } from "./fileMenu";
import {
  initMeshMod,
  setMeshModFields,
  setMeshModParts,
  setMeshModProgress,
  setMeshModSpheres,
} from "./meshMod";
import { initEditHistory, renderOpHistory } from "./editHistory";
import {
  initProblemtype,
  setProblemtypeCatalog,
  setProblemtypeCase,
  setProblemtypeModel,
  setProblemtypeStatus,
} from "./problemtype";
import {
  initFlowgraphPane,
  showFlowgraphPane,
  loadFlowgraphParams,
} from "./flowgraphPane";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// Per-SubModelPart export dropdown chrome (icon + the same formats the File menu
// offers), passed into the outline tree.
const OUTLINE_EXPORT_UI: OutlineExportUI = {
  icon: TOOLBAR_ICONS.export,
  deleteIcon: TOOLBAR_ICONS.close,
  infoIcon: TOOLBAR_ICONS.info,
  renameIcon: TOOLBAR_ICONS.edit,
  formats: EXPORT_MENU_GROUPS.flatMap((group) =>
    group.extensions.map((ext) => ({
      ext,
      label: EXPORT_FORMAT_LABELS[ext],
      group: group.label,
    }))
  ),
};

/** Recursive (subtree) entity counts for a SubModelPart's info dropdown. */
function subModelPartCounts(part: SubModelPart): OutlineCounts {
  const c: OutlineCounts = {
    nodes: part.nodeIds.length,
    conditions: part.conditionIds.length,
    elements: part.elementIds.length,
    geometries: part.geometryIds.length,
    subModelParts: part.children.length,
  };
  for (const child of part.children) {
    const cc = subModelPartCounts(child);
    c.nodes += cc.nodes;
    c.conditions += cc.conditions;
    c.elements += cc.elements;
    c.geometries += cc.geometries;
    c.subModelParts += cc.subModelParts;
  }
  return c;
}

// A layer that may have been built (polydata exists) or not yet (lazy).
interface Layer {
  id: string;
  actor: any;
  color: RGB;
  paletteIndex: number;
  /**
   * What the USER asked for — what the outline checkbox shows and what
   * snapshotVisibility carries across a rebuild. Never written by an overlay.
   */
  visible: boolean;
  /**
   * Set when an overlay layer stands in for this one and draws it better (the
   * sphere glyphs replacing their one-node blocks, which would otherwise
   * double-draw as points inside every sphere). Kept apart from `visible`
   * precisely so it cannot be mistaken for intent: overloading `visible` would
   * leave the outline checkbox ticked on a hidden layer, and would let
   * snapshotVisibility persist a temporary suppression as a user preference.
   */
  suppressed?: boolean;
  built: boolean;
  // Kept for lazy build
  pendingCells?: Cell[];
}

/** Whether a layer's actor should currently be drawn. */
function layerShouldDraw(layer: Layer): boolean {
  return layer.visible && layer.built && !layer.suppressed;
}

// --- DOM ----------------------------------------------------------------
const loadingEl = document.getElementById("loading") as HTMLElement;
const loadingBarEl = document.getElementById("loading-bar") as HTMLElement;
const loadingLabelEl = document.getElementById("loading-label") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const renderRoot = document.getElementById("render-root") as HTMLElement;
const viewport = document.getElementById("viewport") as HTMLElement;
// The VTK canvas + its overlays live in #vtk-sub, the top/left half of #viewport;
// the embedded Flowgraph editor takes the other half. Overlays and controls
// parent to #vtk-sub so they stay pinned to the mesh view when the split opens.
const vtkSub = (document.getElementById("vtk-sub") as HTMLElement) ?? viewport;
const outlineEl = document.getElementById("outline") as HTMLElement;
const statsEl = document.getElementById("stats") as HTMLElement;

const labelsEl = document.createElement("div");
labelsEl.id = "labels";
vtkSub.appendChild(labelsEl);

const messageEl = document.createElement("div");
messageEl.id = "message";
vtkSub.appendChild(messageEl);

const qualityPanelEl = document.createElement("div");
qualityPanelEl.id = "quality-panel";
qualityPanelEl.style.display = "none";
vtkSub.appendChild(qualityPanelEl);

const meshSizePanelEl = document.createElement("div");
meshSizePanelEl.id = "meshsize-panel";
meshSizePanelEl.style.display = "none";
vtkSub.appendChild(meshSizePanelEl);

const fieldPanelEl = document.createElement("div");
fieldPanelEl.id = "field-panel";
fieldPanelEl.style.display = "none";
vtkSub.appendChild(fieldPanelEl);

const spherePanelEl = document.createElement("div");
spherePanelEl.id = "sphere-panel";
spherePanelEl.style.display = "none";
vtkSub.appendChild(spherePanelEl);

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

// --- Orientation cube + grid --------------------------------------------
// The canvas is created synchronously by grw.setContainer(), so it is
// available immediately after the GenericRenderWindow is initialised.
const vtkCanvas = renderRoot.querySelector("canvas") as HTMLCanvasElement;
const orientationCube: OrientationCubeHandle = setupOrientationCube(
  renderWindow, renderer, grw.getInteractor(), vtkCanvas
);
const gridAxes: GridAxes = setupGridAxes(renderer, document.body.dataset.theme ?? "auto");

// --- Navigation controls (DOM overlay, always visible) ------------------
const navControls = new NavControls(vtkSub, renderer, renderWindow);

// --- Timeline (VTK time-series) -----------------------------------------
const timeline = new TimelineControl(vtkSub, {
  onFrameRequest: (frameIndex) => {
    vscode.postMessage({ type: "vtkRequestFrame", frameIndex });
  },
});

// --- State --------------------------------------------------------------
let model: MdpaModel | undefined;
let prepared: PreparedNodes | undefined;
const layers = new Map<string, Layer>();
let actors: any[] = [];
let wireframe = false;
let panMode = false;
let showNodeIds = false;
let gridVisible = false;
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

// Mesh-size panel state (a Field-like colouring + a box-whisker of element size).
let meshSizeReport: MeshSizeResult | undefined;
let meshSizeVisible = false;
const MESHSIZE_FIELD_ID = "meshsize:field";
const MESHSIZE_SMALL_ID = "meshsize:small";
const MESHSIZE_BIG_ID = "meshsize:big";
const MESHSIZE_LAYER_IDS = [MESHSIZE_FIELD_ID, MESHSIZE_SMALL_ID, MESHSIZE_BIG_ID];
const MESHSIZE_SMALL_COLOR: RGB = [0.23, 0.45, 0.95];
const MESHSIZE_BIG_COLOR: RGB = [0.88, 0.25, 0.19];
const meshSizeState = {
  color: "none" as MeshSizeColor,
  colormap: DEFAULT_COLORMAP,
  showSmall: false,
  showBig: false,
};
// Sphere/particle rendering: one-node cells drawn as real spheres sized by
// RADIUS (or by the panel's constant, since a particle file routinely declares
// none — see src/parser/sphereElements.ts).
const SPHERE_LAYER_ID = "sphere:glyphs";
const SPHERE_COLOR: RGB = [0.78, 0.78, 0.82];
let sphereVisible = false; // panel open
/** Per-model memos, invalidated in buildScene like meshSizeReport. */
let sphereStatsCache: SphereStats | undefined;
let sphereSuggested: number | undefined;
const sphereState = {
  enabled: false,
  scale: 1,
  resolution: 16,
  /** undefined = draw at the suggested radius; a number overrides it. */
  constant: undefined as number | undefined,
  colorByRadius: false,
  colormap: DEFAULT_COLORMAP,
};

/** Counts + radius range of the model's particles (one pass, memoized). */
function spheres(): SphereStats {
  if (!sphereStatsCache) {
    sphereStatsCache = model
      ? sphereStats(model)
      : { blocks: 0, cells: 0, withRadius: 0, radiusMin: 0, radiusMax: 0 };
  }
  return sphereStatsCache;
}

/**
 * The radius to draw a particle at when the mesh gives it none.
 *
 * Lazy: defaultSphereRadius is an O(n) spatial-hash pass, and a mesh whose
 * RADIUS covers every particle never needs it except as the panel's label.
 */
function suggestedRadius(): number {
  if (sphereSuggested === undefined) {
    sphereSuggested = model ? defaultSphereRadius(model) : 1;
  }
  return sphereSuggested;
}

/** The radius actually used for particles with no value of their own. */
function sphereConstant(): number {
  return sphereState.constant ?? suggestedRadius();
}

// Face normals (Advanced > Face normals): arrows at face centroids, the
// standard way to spot an inverted element — it points against its neighbours.
const NORMALS_LAYER_ID = "normals:arrows";
const NORMALS_COLOR: RGB = [0.35, 0.85, 0.45];
const NORMALS_BAD_ID = "normals:inverted";
const NORMALS_BAD_COLOR: RGB = [0.95, 0.25, 0.2];
let normalsVisible = false;
let normalsReport: MeshNormals | undefined;

const FIND_HIGHLIGHT_ID = "find:highlight";
const FIND_HIGHLIGHT_COLOR: RGB = [1.0, 0.95, 0.0];
const CUT_CAP_ID = "cut:cap";
const CUT_CAP_EDGE_ID = "cut:cap-edges";
const CUT_CAP_LAYER_IDS = [CUT_CAP_ID, CUT_CAP_EDGE_ID];
const CUT_CAP_COLOR: RGB = [0.72, 0.72, 0.72];
const CUT_CAP_EDGE_COLOR: RGB = [0.15, 0.15, 0.15];
// Mid-edge nodes inserted by a linear→quadratic conversion, shown as
// semitransparent points in a light blue so the new nodes read as part of the
// mesh while still standing out over it.
const MIDNODES_LAYER_ID = "meshmod:midnodes";
const MIDNODES_COLOR: RGB = [0.5, 0.75, 1.0];
let midNodeIds: number[] = [];

// Field visualization state.
const FIELD_CONTOUR_ID = "field:contour";
const FIELD_QUIVER_ID = "field:quiver";
const FIELD_ISO_ID = "field:iso";
const FIELD_LAYER_IDS = [FIELD_CONTOUR_ID, FIELD_QUIVER_ID, FIELD_ISO_ID];
let fieldInfos: FieldInfo[] = [];
let fieldVisible = false;
let fieldDimmed = false; // base layers forced to wireframe while a field is shown
let currentColormap = DEFAULT_COLORMAP;
// The active modes are an independent set: contour / quiver / iso / deformed can
// be combined. Deformation is a global warp (own vector field + scale) so all
// active field layers render on the deformed geometry.
const fieldState = {
  selectedKey: "",
  modes: new Set<FieldMode>(["contour"]),
  isoValue: 0,
  scale: 1,
  deformKey: "",
  deformScale: 1,
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
      // keepCamera marks an in-place edit/mesh-modification re-render: keep
      // the camera AND the user's layer toggles (new layers get defaults).
      if (msg.keepCamera) snapshotVisibility();
      model = msg.model as MdpaModel;
      midNodeIds = (msg.midNodes as number[] | undefined) ?? [];
      buildScene(!msg.keepCamera);
      setMeshModFields(model.fields);
      setMeshModParts(model.subModelParts);
      setMeshModSpheres(spheres().cells > 0);
      setProblemtypeModel(model.subModelParts);
      hideLoading();
      navControls.show();
      navControls.setBottomOffset(8);
      break;
    case "vtkGroup":
      timeline.show(
        (msg.group as { steps: string[] }).steps.length,
        (msg.group as { steps: string[] }).steps
      );
      navControls.setBottomOffset(44); // 36px timeline bar + 8px gap
      break;
    case "vtkFrame": {
      // Preserve layer visibility across frame switches (outline stays in sync
      // because buildScene consumes the snapshot while rendering the tree).
      snapshotVisibility();
      model = msg.model as MdpaModel;
      midNodeIds = (msg.midNodes as number[] | undefined) ?? [];
      buildScene(false); // preserve camera position between frames
      setMeshModFields(model.fields);
      setMeshModParts(model.subModelParts);
      setMeshModSpheres(spheres().cells > 0);
      hideLoading();
      navControls.show();
      timeline.update(
        msg.frameIndex as number,
        msg.stepLabel as string,
        msg.totalFrames as number
      );
      break;
    }
    case "opState":
      renderOpHistory(msg as unknown as Parameters<typeof renderOpHistory>[0]);
      break;
    case "opProgress":
      setMeshModProgress(
        msg as unknown as { running: boolean; op?: string; message?: string }
      );
      break;
    case "ptCatalog":
      setProblemtypeCatalog(
        msg.problemtypes as Parameters<typeof setProblemtypeCatalog>[0]
      );
      break;
    case "ptCase":
      setProblemtypeCase(msg.state as Parameters<typeof setProblemtypeCase>[0]);
      break;
    case "ptStatus":
      setProblemtypeStatus(
        msg as unknown as { kind: string; files?: string[]; message?: string }
      );
      break;
    case "flowgraphReady":
      showFlowgraphPane(msg.url as string, msg.origin as string);
      break;
    case "flowgraphLoadParams":
      loadFlowgraphParams(msg.json as string);
      break;
    case "flowgraphError":
      setProblemtypeStatus({
        kind: "error",
        message: `Flowgraph: ${msg.message ?? "failed to start"}`,
      });
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
    case "meshSize":
      toggleMeshSizePanel();
      break;
    case "spheres":
      toggleSpherePanel();
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
/** The layer id buildScene gives an EntityBlock (also read by the sphere layer). */
function blockLayerId(block: EntityBlock): string {
  return `block:${block.kind}:${block.name}`;
}

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

/**
 * Per-layer visibility overrides consumed by the next buildScene: an in-place
 * re-render (edit/mesh-modification result, VTK frame change) keeps the user's
 * layer toggles for layers that still exist, while brand-new layers (e.g. the
 * MMG level-set domains) get the normal defaults.
 */
let nextVisOverride: Map<string, boolean> | undefined;

/** Snapshot the current layers' visibility to reapply on the next rebuild. */
function snapshotVisibility(): void {
  nextVisOverride = new Map([...layers.entries()].map(([id, l]) => [id, l.visible]));
}

function buildScene(resetCam = true): void {
  if (!model) return;
  clearScene();
  prepared = prepareNodes(model);
  // A fresh model invalidates any cached quality / mesh-size report.
  qualityReport = undefined;
  meshSizeReport = undefined;
  // A fresh model invalidates the particle stats and the suggested radius; any
  // user-set constant is dropped too, since it was chosen for the old scale.
  sphereStatsCache = undefined;
  sphereSuggested = undefined;
  normalsReport = undefined;
  sphereState.constant = undefined;
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

  // Volume blocks are hidden by default in favour of surface/line blocks —
  // but when the model has ONLY volume blocks (e.g. a pure-tet .mdpa with no
  // Conditions), hiding them would open an empty scene, so show them instead.
  // MMG level-set interfaces don't count as covering surfaces: they cut
  // through the domains rather than skinning them, so they must not hide the
  // split volume (otherwise a level-set result looks like an empty scene).
  const hasSurfaceBlock = model.blocks.some(
    (b) => !isVolumeBlock(b) && !b.name.startsWith("MMG_Interface")
  );

  for (const block of model.blocks) {
    const [color, paletteIndex] = nextColorEntry();
    const id = blockLayerId(block);
    const visible =
      nextVisOverride?.get(id) ?? (!isVolumeBlock(block) || !hasSurfaceBlock);
    const cells: Cell[] = [];
    for (let i = 0; i < block.count; i++) {
      cells.push({
        cellType: block.vtkCellType,
        nodeIds: block.connectivity.subarray(i * block.stride, (i + 1) * block.stride),
      });
    }
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

  // Overlay of quadratic mid-edge nodes (semitransparent points), when a
  // linear→quadratic conversion just ran. Toggleable like any other layer.
  const modNodes: OutlineNode[] = [];
  if (midNodeIds.length > 0) {
    const cells: Cell[] = midNodeIds.map((nid) => ({ cellType: undefined, nodeIds: [nid] }));
    const created = addLayer(MIDNODES_LAYER_ID, cells, MIDNODES_COLOR, true);
    if (created) {
      const prop = layers.get(MIDNODES_LAYER_ID)!.actor.getProperty();
      prop.setOpacity(0.5);
      prop.setPointSize(10);
      prop.setEdgeVisibility(false);
    }
    modNodes.push({
      label: "Quadratic mid-nodes",
      count: midNodeIds.length,
      layerId: created ? MIDNODES_LAYER_ID : undefined,
      visible: true,
      color: MIDNODES_COLOR,
    });
  }

  const roots: OutlineNode[] = [];
  if (blockNodes.length) roots.push({ label: "Mesh", section: true, children: blockNodes });
  if (partNodes.length) roots.push({ label: "SubModelParts", section: true, children: partNodes });
  if (modNodes.length) roots.push({ label: "Mesh Modification", section: true, children: modNodes });
  renderOutline(
    outlineEl,
    roots,
    {
      onToggle: (layerId, visible) => setLayerVisible(layerId, visible),
      onFocus: (layerId) => frameLayer(layerId),
      onExport: (path, ext) =>
        vscode.postMessage({ type: "menuExportPart", format: ext, path }),
      onDelete: (path) =>
        vscode.postMessage({ type: "applyOp", op: "deleteSubModelPart", path }),
      onRename: (path, newName) =>
        vscode.postMessage({ type: "applyOp", op: "renameSubModelPart", path, newName }),
    },
    OUTLINE_EXPORT_UI
  );

  // Rebuild field lookups; keep the selection if the variable still exists.
  fieldInfos = model.fields.map(buildFieldInfo);
  if (!fieldInfos.some((i) => i.key === fieldState.selectedKey)) {
    fieldState.selectedKey = fieldInfos[0]?.key ?? "";
    resetFieldStateForSelection();
  }
  // Keep the deformation field valid (default to the first vector field).
  if (!fieldInfos.some((i) => i.key === fieldState.deformKey && i.isVector)) {
    fieldState.deformKey = fieldInfos.find((i) => i.isVector)?.key ?? "";
  }

  renderStats();
  if (resetCam) resetCamera();

  // Update grid axes bounding box to match the new model.
  const mb = model.bounds;
  gridAxes.updateBounds([mb.min[0], mb.max[0], mb.min[1], mb.max[1], mb.min[2], mb.max[2]]);

  if (cutActive) {
    updateCutPlane();
    applyClipToMappers();
    buildCutCap();
    renderWindow.render();
  }
  // Refresh the quality panel against the new model if it is open.
  if (qualityVisible) showQualityPanel();
  // Refresh the mesh-size panel + overlays against the new model if it is open.
  if (meshSizeVisible) showMeshSizePanel();
  // Refresh the field panel against the new model if it is open.
  if (fieldVisible) showFieldPanel();

  // Particles with a declared radius render as spheres straight away — that IS
  // the mesh, not an analysis overlay. A radius-less point cloud stays as GL
  // points (the panel is still there, offering a constant), so an ordinary
  // point cloud does not silently turn into a ball pit.
  if (spheres().withRadius > 0) sphereState.enabled = true;
  if (sphereState.enabled) applySphereLayer();
  if (sphereVisible) renderSphereUI();
  // clearScene() dropped the arrows; rebuild them against the new model so the
  // toggle survives a timeline step or an edit.
  if (normalsVisible) applyNormalsLayer();

  // Always repaint so an in-place rebuild (e.g. applying an edit with the camera
  // preserved) shows immediately instead of waiting for the next interaction.
  renderWindow.render();

  // The visibility snapshot only applies to the rebuild it was taken for.
  nextVisOverride = undefined;
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
  // SubModelParts are lazy/hidden by default (kept toggled-on across in-place
  // op re-renders via the visibility snapshot).
  const visible = nextVisOverride?.get(id) ?? false;
  const created = addLayer(id, cells, color, visible, paletteIndex);
  const explicitCount = part.elementIds.length + part.conditionIds.length + part.geometryIds.length;
  const total = explicitCount > 0 ? explicitCount : induced ? cells.length : part.nodeIds.length;

  return {
    label: part.name,
    count: total,
    layerId: created ? id : undefined,
    visible,
    color,
    exportPath: part.path,
    counts: subModelPartCounts(part),
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
  layer.actor.setVisibility(layerShouldDraw(layer));
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

  gridAxes.updateTheme(name);
  orientationCube.updateTheme(name);
  navControls.updateTheme(name);
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
    if (id === FIND_HIGHLIGHT_ID || CUT_CAP_LAYER_IDS.includes(id)) continue;
    layer.actor.getProperty().setRepresentation(on ? 1 : 2);
  }
  renderWindow.render();
}

// --- Cut plane ----------------------------------------------------------
const clipPlane = vtkPlane.newInstance();
let cutActive = false;
let cutAxis: 0 | 1 | 2 = 2;
let cutFlipped = false;

// May be absent from a provider's HTML — never assume (a missing element here
// once killed the whole webview at module scope).
const cutPanel = document.getElementById("cut-panel") as HTMLElement | null;
const cutSlider = document.getElementById("cut-slider") as HTMLInputElement | null;
const cutPositionEl = document.getElementById("cut-position") as HTMLElement | null;

function updateCutPlane(): void {
  if (!model) return;
  const b = model.bounds;
  const normals: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const n = normals[cutAxis];
  const normal: [number, number, number] = cutFlipped ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
  const min = b.min[cutAxis];
  const max = b.max[cutAxis];
  const t = Number(cutSlider?.value ?? 50) / 100;
  const pos = min + t * (max - min);
  const origin: [number, number, number] = [0, 0, 0];
  origin[cutAxis] = pos;
  clipPlane.setNormal(normal);
  clipPlane.setOrigin(origin);
  if (cutPositionEl) {
    cutPositionEl.textContent = `${"XYZ"[cutAxis]} = ${pos.toPrecision(4)}`;
  }
}

function applyClipToMappers(): void {
  for (const layer of layers.values()) {
    if (CUT_CAP_LAYER_IDS.includes(layer.id)) continue; // cap lives on the plane; do not clip it
    const mapper = layer.actor.getMapper();
    if (!mapper) continue;
    mapper.removeAllClippingPlanes();
    if (cutActive) mapper.addClippingPlane(clipPlane);
  }
  renderWindow.render();
}

// --- Cut cap: true cross-section of the volume elements ------------------
//
// The rendered polydata is only the outer boundary skin (meshBuilder keeps
// faces owned by exactly one cell), so GPU clipping alone leaves a hollow
// shell. The cap is computed from the original volume cells instead —
// one convex polygon per sectioned element (src/parser/planeCut.ts) — and
// rendered as two actors: the filled section and its element edges.

// Registers a cap actor as a layer WITHOUT a clip plane — the cap sits
// exactly on the plane; clipping its mapper would erase it.
function registerCutCapLayer(id: string, actor: any, color: RGB): void {
  const layer: Layer = {
    id, actor, color,
    paletteIndex: -1, visible: true, built: true,
  };
  actor.setVisibility(true);
  renderer.addActor(actor);
  actors.push(actor);
  layers.set(id, layer);
}

function buildCutCap(): void {
  for (const id of CUT_CAP_LAYER_IDS) removeLayer(id);
  if (!cutActive || !model) return;

  // Computed over the model's volume cells, not the rendered layers, so the
  // section shows even while the volume blocks themselves are hidden
  // (the default — only the boundary skin is visible).
  const cut = computePlaneCut(
    model,
    clipPlane.getOrigin() as [number, number, number],
    clipPlane.getNormal() as [number, number, number]
  );
  if (cut.polyCount === 0) return;

  // Filled section. Colored by the active contour field when one is shown so
  // Cut Plane and Field combine; otherwise neutral gray.
  const capPd = buildCutCapPolyData(cut);
  const capMapper = vtkMapper.newInstance();
  capMapper.setInputData(capPd);
  // Polygon offset ensures the cap always renders in front of coplanar mesh
  // faces (e.g. element-block boundaries exactly on the cut plane).
  // These methods are added at runtime by implementCoincidentTopologyMethods
  // but are not reflected in the vtk.js TypeScript stubs, so cast to any.
  (capMapper as any).setResolveCoincidentTopologyToPolygonOffset();
  (capMapper as any).setRelativeCoincidentTopologyPolygonOffsetParameters(-2, -2);
  const capActor = vtkActor.newInstance();
  capActor.setMapper(capMapper);
  const prop = capActor.getProperty();
  const info = selectedFieldInfo();
  if (fieldVisible && fieldState.modes.has("contour") && info && attachCutCapScalars(capPd, cut, info)) {
    configureScalarMapper(capMapper, info, currentColormap);
  } else {
    capMapper.setScalarVisibility(false);
    prop.setColor(CUT_CAP_COLOR[0], CUT_CAP_COLOR[1], CUT_CAP_COLOR[2]);
  }
  prop.setEdgeVisibility(false);
  prop.setAmbient(0.3);
  prop.setDiffuse(0.7);
  registerCutCapLayer(CUT_CAP_ID, capActor, CUT_CAP_COLOR);

  // Element intersection edges, drawn just above the filled section.
  const edgePd = buildCutCapEdgePolyData(cut);
  const edgeMapper = vtkMapper.newInstance();
  edgeMapper.setInputData(edgePd);
  edgeMapper.setScalarVisibility(false);
  (edgeMapper as any).setResolveCoincidentTopologyToPolygonOffset();
  (edgeMapper as any).setRelativeCoincidentTopologyLineOffsetParameters(-4, -4);
  const edgeActor = vtkActor.newInstance();
  edgeActor.setMapper(edgeMapper);
  const edgeProp = edgeActor.getProperty();
  edgeProp.setColor(CUT_CAP_EDGE_COLOR[0], CUT_CAP_EDGE_COLOR[1], CUT_CAP_EDGE_COLOR[2]);
  edgeProp.setLineWidth(1);
  edgeProp.setAmbient(1);
  edgeProp.setDiffuse(0);
  registerCutCapLayer(CUT_CAP_EDGE_ID, edgeActor, CUT_CAP_EDGE_COLOR);
}

function setCut(on: boolean): void {
  cutActive = on;
  const btn = document.querySelector('#toolbar button[data-action="cut"]');
  btn?.classList.toggle("active", on);
  cutPanel?.classList.toggle("hidden", !on);
  if (on) {
    updateCutPlane();
  }
  applyClipToMappers();
  buildCutCap();
  renderWindow.render();
}

// While scrubbing, the GPU clip (shared vtkPlane) updates every tick for free;
// the cap rebuild walks all volume cells, so it is debounced to animation frames.
let cutFrame: number | undefined;
function scheduleCutCapRebuild(): void {
  if (cutFrame !== undefined) return;
  cutFrame = requestAnimationFrame(() => {
    cutFrame = undefined;
    buildCutCap();
    renderWindow.render();
  });
}

cutSlider?.addEventListener("input", () => {
  updateCutPlane();
  renderWindow.render();
  scheduleCutCapRebuild();
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

// --- Sidebar ------------------------------------------------------------
initSidebarSections();
initSidebarResize();

// --- File (Home) menu ---------------------------------------------------
initFileMenu((msg) => vscode.postMessage(msg));

// --- Mesh Modification sidebar ------------------------------------------
initMeshMod((msg) => vscode.postMessage(msg));

// --- Edit / operation history -------------------------------------------
initEditHistory((msg) => vscode.postMessage(msg));
initProblemtype((msg) => vscode.postMessage(msg));

// --- Embedded Flowgraph editor pane -------------------------------------
const flowgraphOrientation =
  document.body.dataset.flowgraphOrientation === "vertical"
    ? "vertical"
    : "horizontal";
initFlowgraphPane((msg) => vscode.postMessage(msg), flowgraphOrientation);

// --- Toolbar ------------------------------------------------------------
// --- Advanced menu ------------------------------------------------------
// A dropdown for operations that are real but not everyday, so the toolbar does
// not grow a button per niche feature. Items carry the same `data-action` a
// toolbar button would, and are dispatched through the same handler.
const advancedPopupEl = document.getElementById("advanced-popup");

function setAdvancedMenu(open: boolean): void {
  advancedPopupEl?.classList.toggle("hidden", !open);
  document
    .querySelector('#toolbar button[data-action="advanced"]')
    ?.setAttribute("aria-expanded", String(open));
}

function toggleAdvancedMenu(): void {
  setAdvancedMenu(advancedPopupEl?.classList.contains("hidden") ?? false);
}

advancedPopupEl?.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!item) return;
  setAdvancedMenu(false); // a menu item always closes the menu
  dispatchToolbarAction(item.dataset.action);
});

// Dismiss on an outside click or Escape, like the File menu.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (advancedPopupEl?.contains(t)) return;
  if (t.closest('#toolbar button[data-action="advanced"]')) return;
  setAdvancedMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setAdvancedMenu(false);
});

document.getElementById("toolbar")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  dispatchToolbarAction(target.dataset.action, target);
});

function dispatchToolbarAction(action: string | undefined, target?: HTMLElement): void {
  if (action === "reset") resetCamera();
  else if (action === "pan") setPanMode(!panMode);
  else if (action === "cut") setCut(!cutActive);
  else if (action === "wireframe") {
    setWireframe(!wireframe);
    target?.classList.toggle("active", wireframe);
  } else if (action === "nodeIds") setNodeIds(!showNodeIds);
  else if (action === "quality") toggleQualityPanel();
  else if (action === "meshSize") toggleMeshSizePanel();
  else if (action === "advanced") toggleAdvancedMenu();
  else if (action === "spheres") toggleSpherePanel();
  else if (action === "normals") toggleNormals();
  else if (action === "find") toggleFindBar();
  else if (action === "field") toggleFieldPanel();
  else if (action === "grid") {
    gridVisible = !gridVisible;
    gridAxes.setVisible(gridVisible);
    target?.classList.toggle("active", gridVisible);
    renderWindow.render();
  } else if (action === "screenshot") {
    void takeScreenshot();
  }
}

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

// --- Mesh size ----------------------------------------------------------
function toggleMeshSizePanel(): void {
  if (meshSizeVisible) hideMeshSizePanel();
  else showMeshSizePanel();
}

function showMeshSizePanel(): void {
  if (!model) return;
  if (!meshSizeReport) meshSizeReport = computeMeshSize(model);
  renderMeshSizeUI();
  meshSizePanelEl.style.display = "";
  meshSizeVisible = true;
  document.querySelector('#toolbar button[data-action="meshSize"]')?.classList.add("active");
  applyMeshSizeColor();
  applyMeshSizeHighlight();
}

function hideMeshSizePanel(): void {
  meshSizePanelEl.style.display = "none";
  meshSizeVisible = false;
  meshSizeState.color = "none";
  meshSizeState.showSmall = false;
  meshSizeState.showBig = false;
  removeLayer(MESHSIZE_FIELD_ID);
  removeLayer(MESHSIZE_SMALL_ID);
  removeLayer(MESHSIZE_BIG_ID);
  syncBaseDimming();
  if (cutActive) buildCutCap();
  renderWindow.render();
  document.querySelector('#toolbar button[data-action="meshSize"]')?.classList.remove("active");
}

function renderMeshSizeUI(): void {
  if (!meshSizeReport) return;
  const state: MeshSizePanelState = {
    color: meshSizeState.color,
    colormap: meshSizeState.colormap,
    showSmall: meshSizeState.showSmall,
    showBig: meshSizeState.showBig,
  };
  renderMeshSizePanel(meshSizePanelEl, meshSizeReport, state, {
    onClose: () => hideMeshSizePanel(),
    onColor: (c) => {
      meshSizeState.color = c;
      renderMeshSizeUI();
      applyMeshSizeColor();
    },
    onColormap: (name) => {
      meshSizeState.colormap = name;
      renderMeshSizeUI();
      applyMeshSizeColor();
    },
    onToggleSmall: () => {
      meshSizeState.showSmall = !meshSizeState.showSmall;
      renderMeshSizeUI();
      applyMeshSizeHighlight();
    },
    onToggleBig: () => {
      meshSizeState.showBig = !meshSizeState.showBig;
      renderMeshSizeUI();
      applyMeshSizeHighlight();
    },
    onFrame: (which) => {
      if (which === "small") {
        meshSizeState.showSmall = true;
      } else {
        meshSizeState.showBig = true;
      }
      renderMeshSizeUI();
      applyMeshSizeHighlight();
      frameLayer(which === "small" ? MESHSIZE_SMALL_ID : MESHSIZE_BIG_ID);
    },
    onWrite: (target: MeshSizeWriteTarget) => {
      vscode.postMessage({ type: "applyOp", op: "writeMeshSizeFields", target });
    },
  });
}

// Colours the mesh by the nodal / element size field (reusing the contour path).
function applyMeshSizeColor(): void {
  removeLayer(MESHSIZE_FIELD_ID);
  if (meshSizeReport && prepared && model && meshSizeState.color !== "none") {
    const field = meshSizeState.color === "nodal" ? meshSizeReport.nodalH : meshSizeReport.elementSize;
    const info = buildFieldInfo(field);
    const kinds: EntityKind[] | "all" = meshSizeState.color === "element" ? ["Elements"] : "all";
    const built = buildPolyData(prepared, collectCells(kinds), contourAttach(info));
    if (built) {
      const mapper = vtkMapper.newInstance();
      mapper.setInputData(built.polyData);
      configureScalarMapper(mapper, info, meshSizeState.colormap);
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      actor.getProperty().setEdgeVisibility(false);
      registerFieldLayer(MESHSIZE_FIELD_ID, actor);
    }
  }
  syncBaseDimming();
  if (cutActive) buildCutCap();
  renderWindow.render();
}

// Red/blue overlays of the IQR-outlier small / large elements.
function applyMeshSizeHighlight(): void {
  removeLayer(MESHSIZE_SMALL_ID);
  removeLayer(MESHSIZE_BIG_ID);
  if (meshSizeReport && prepared) {
    if (meshSizeState.showSmall) {
      addMeshSizeOverlay(MESHSIZE_SMALL_ID, meshSizeReport.smallElementIds, MESHSIZE_SMALL_COLOR);
    }
    if (meshSizeState.showBig) {
      addMeshSizeOverlay(MESHSIZE_BIG_ID, meshSizeReport.bigElementIds, MESHSIZE_BIG_COLOR);
    }
  }
  renderWindow.render();
}

function addMeshSizeOverlay(id: string, ids: number[], color: RGB): void {
  const cells: Cell[] = [];
  for (const eid of ids) {
    const c = elementById.get(eid);
    if (c) cells.push(c);
  }
  if (cells.length === 0) return;
  addLayer(id, cells, color, true);
  if (wireframe) layers.get(id)?.actor.getProperty().setRepresentation(1);
}

// --- Face normals --------------------------------------------------------

/**
 * Toggles the face-normal arrows.
 *
 * Reuses the quiver arrow glyph verbatim: the anchors are face centroids and
 * the vectors the unit normals, which is exactly the shape buildGlyphActor
 * already draws. Faces flipped relative to a neighbour get a second, red layer
 * so the defect is visible even in a dense field of arrows.
 */
function toggleNormals(): void {
  normalsVisible = !normalsVisible;
  applyNormalsLayer();
}

function applyNormalsLayer(): void {
  removeLayer(NORMALS_LAYER_ID);
  removeLayer(NORMALS_BAD_ID);
  if (!normalsVisible || !model) {
    messageEl.textContent = "";
    renderWindow.render();
    return;
  }
  if (!normalsReport) normalsReport = computeMeshNormals(model);
  const r = normalsReport;
  if (r.count === 0) {
    messageEl.textContent = "No surface or volume faces to take normals from.";
    renderWindow.render();
    return;
  }

  // Arrows ~4% of the bounding diagonal, so they read at any model scale.
  const b = model.bounds;
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const scale = 0.04 * (diag || 1);
  const points = Float32Array.from(r.centroids);
  const vectors = Float32Array.from(r.normals);
  const magnitudes = new Float32Array(r.count).fill(1); // unit normals

  registerFieldLayer(
    NORMALS_LAYER_ID,
    buildGlyphActor({ points, vectors, magnitudes }, scale, currentColormap, 1, 1, NORMALS_COLOR)
  );

  // The inverted cells themselves, in red, so they are findable without
  // squinting at arrow directions.
  if (r.inconsistentIds.length > 0) {
    const cells: Cell[] = [];
    for (const id of r.inconsistentIds) {
      const c = elementById.get(id) ?? conditionById.get(id);
      if (c) cells.push(c);
    }
    if (cells.length > 0) addLayer(NORMALS_BAD_ID, cells, NORMALS_BAD_COLOR, true);
  }

  messageEl.textContent =
    r.inconsistent > 0
      ? `${r.count.toLocaleString()} face normals — ${r.inconsistent} element(s) wound against a neighbour (shown in red).`
      : `${r.count.toLocaleString()} face normals — orientation is consistent.`;
  renderWindow.render();
}

// --- Spheres / particles -------------------------------------------------

function toggleSpherePanel(): void {
  if (sphereVisible) hideSpherePanel();
  else showSpherePanel();
}

function showSpherePanel(): void {
  if (!model) return;
  spherePanelEl.style.display = "";
  sphereVisible = true;
  document.querySelector('#toolbar button[data-action="spheres"]')?.classList.add("active");
  renderSphereUI();
}

function hideSpherePanel(): void {
  spherePanelEl.style.display = "none";
  sphereVisible = false;
  sphereState.enabled = false;
  applySphereLayer();
  document.querySelector('#toolbar button[data-action="spheres"]')?.classList.remove("active");
}

/** What the panel needs to describe the mesh's particles. */
function sphereInfo(): SpherePanelInfo {
  return { ...spheres(), suggested: suggestedRadius() };
}

function renderSphereUI(): void {
  const info = sphereInfo();
  const state: SpherePanelState = { ...sphereState, constant: sphereConstant() };
  // Every control does the same two things after its own one-line assignment.
  const update = (patch: Partial<typeof sphereState>): void => {
    Object.assign(sphereState, patch);
    renderSphereUI();
    applySphereLayer();
  };
  renderSpherePanel(spherePanelEl, info, state, {
    onClose: () => hideSpherePanel(),
    onToggle: () => update({ enabled: !sphereState.enabled }),
    onScale: (v) => update({ scale: v }),
    onResolution: (v) => update({ resolution: v }),
    onConstant: (v) => update({ constant: v }),
    onColorByRadius: () => update({ colorByRadius: !sphereState.colorByRadius }),
    onColormap: (name) => update({ colormap: name }),
    onWrite: () => {
      vscode.postMessage({
        type: "applyOp",
        op: "setElementRadius",
        value: sphereConstant(),
        mode: "absolute",
      });
    },
    onFrame: () => frameLayer(SPHERE_LAYER_ID),
  });
}

/** Rebuilds (or removes) the glyph layer from the current state. */
function applySphereLayer(): void {
  removeLayer(SPHERE_LAYER_ID);
  if (sphereState.enabled && model && prepared) {
    // Deformed shape warps the anchors, exactly as it does for quiver.
    const warp = computeWarpedGeometry();
    const prep = warp?.prepared ?? prepared;
    const info = spheres();
    const data = buildSphereData(prep);
    if (data && data.points.length > 0) {
      const actor = buildSphereGlyphActor(
        data,
        sphereState.scale,
        sphereState.resolution,
        SPHERE_COLOR,
        sphereState.colorByRadius && info.withRadius > 0
          ? {
              colormap: sphereState.colormap,
              min: info.radiusMin,
              max: info.radiusMax > info.radiusMin ? info.radiusMax : info.radiusMin + 1e-12,
            }
          : undefined
      );
      registerFieldLayer(SPHERE_LAYER_ID, actor);
    }
  }
  syncSphereBaseHiding();
  renderWindow.render();
}

/** One anchor + radius per one-node cell. */
function buildSphereData(prep: PreparedNodes):
  | { points: Float32Array; radii: Float32Array }
  | undefined {
  if (!model) return undefined;
  const field = radiusField(model);
  const byId = new Map<number, number>();
  if (field) {
    for (let i = 0; i < field.ids.length; i++) byId.set(field.ids[i], field.values[i]);
  }
  // Sized up front rather than grown as number[]: a DEM file has a million
  // particles, and the boxed intermediate would be ~24 MB of pure churn.
  const total = spheres().cells;
  const points = new Float32Array(total * 3);
  const radii = new Float32Array(total);
  const fallback = sphereConstant();
  let w = 0;
  for (const block of sphereBlocks(model)) {
    for (let c = 0; c < block.count; c++) {
      const anchor = coordOfPrep(prep, block.connectivity[c]);
      if (!anchor) continue;
      const r = byId.get(block.entityIds[c]);
      points[w * 3] = anchor[0];
      points[w * 3 + 1] = anchor[1];
      points[w * 3 + 2] = anchor[2];
      // A cell the field does not cover falls back to the panel constant —
      // that is the whole reason a radius-less particle file renders at all.
      radii[w] = r !== undefined && r > 0 ? r : fallback;
      w++;
    }
  }
  return w === total
    ? { points, radii }
    : { points: points.subarray(0, w * 3), radii: radii.subarray(0, w) };
}

/**
 * Suppresses the base one-node layers while the glyphs stand in for them.
 *
 * Distinct from syncBaseDimming: those layers are not *dimmed under* an overlay,
 * they are *replaced* by it — left drawn they double-draw as GL points inside
 * every sphere. It writes `Layer.suppressed`, never `Layer.visible`, so the
 * outline checkbox keeps showing what the user asked for and snapshotVisibility
 * cannot persist a temporary suppression as a preference across a frame change.
 */
function syncSphereBaseHiding(): void {
  const active = layers.has(SPHERE_LAYER_ID);
  for (const block of model ? sphereBlocks(model) : []) {
    const layer = layers.get(blockLayerId(block));
    if (!layer) continue;
    layer.suppressed = active || undefined;
    layer.actor.setVisibility(layerShouldDraw(layer));
  }
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

// Picks a sensible default iso value + reconciles modes with the new selection.
function resetFieldStateForSelection(): void {
  const info = selectedFieldInfo();
  if (!info) return;
  fieldState.isoValue = (info.scalarMin + info.scalarMax) / 2;
  // Drop modes the newly-selected variable can't drive (quiver needs a vector,
  // iso needs a scalar). Contour + deformed are unaffected here.
  if (!info.isVector) fieldState.modes.delete("quiver");
  if (info.isVector) fieldState.modes.delete("iso");
  // Ensure at least one applicable mode is on so the panel isn't inert.
  if (fieldState.modes.size === 0) {
    fieldState.modes.add(info.isVector ? "quiver" : "contour");
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
  // Cap reverts to its neutral color once the field is gone.
  if (cutActive) {
    buildCutCap();
    renderWindow.render();
  }
}

function renderFieldPanelUI(): void {
  const state: FieldPanelState = {
    infos: fieldInfos,
    selectedKey: fieldState.selectedKey,
    modes: fieldState.modes,
    colormap: currentColormap,
    isoValue: fieldState.isoValue,
    scale: fieldState.scale,
    deformKey: fieldState.deformKey,
    deformScale: fieldState.deformScale,
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
    onToggleMode: (mode) => {
      if (fieldState.modes.has(mode)) fieldState.modes.delete(mode);
      else fieldState.modes.add(mode);
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
    onSelectDeformField: (key) => {
      fieldState.deformKey = key;
      applyFieldMode();
    },
    onDeformScale: (v) => {
      fieldState.deformScale = v;
      applyFieldMode();
    },
  });
}

// Removes any field overlay layers.
function removeFieldLayers(): void {
  for (const id of FIELD_LAYER_IDS) removeLayer(id);
}

// Layers that must never be dimmed when a field / mesh-size colour overlay is shown.
function isOverlayLayer(id: string): boolean {
  return (
    FIELD_LAYER_IDS.includes(id) ||
    CUT_CAP_LAYER_IDS.includes(id) ||
    MESHSIZE_LAYER_IDS.includes(id) ||
    // Deliberately NOT in FIELD_LAYER_IDS: these replace or annotate the base
    // rendering rather than colouring it, so they must neither trigger base
    // dimming nor be dimmed themselves — wireframe spheres and wireframe
    // arrowheads are both unreadable.
    id === SPHERE_LAYER_ID ||
    id === NORMALS_LAYER_ID ||
    id === NORMALS_BAD_ID
  );
}

// Forces base mesh layers to wireframe so a colour overlay reads clearly.
function dimFieldBase(): void {
  fieldDimmed = true;
  for (const [id, layer] of layers) {
    if (isOverlayLayer(id)) continue;
    layer.actor.getProperty().setRepresentation(1);
  }
}

function restoreFieldBase(): void {
  if (!fieldDimmed) return;
  fieldDimmed = false;
  const rep = wireframe ? 1 : 2;
  for (const [id, layer] of layers) {
    if (isOverlayLayer(id)) continue;
    layer.actor.getProperty().setRepresentation(rep);
  }
  renderWindow.render();
}

// Central base-dimming policy: dim while any field or mesh-size colour layer exists.
function syncBaseDimming(): void {
  if (FIELD_LAYER_IDS.some((id) => layers.has(id)) || layers.has(MESHSIZE_FIELD_ID)) {
    dimFieldBase();
  } else {
    restoreFieldBase();
  }
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

// The vector FieldInfo currently selected to drive the deformation, if any.
function selectedDeformInfo(): FieldInfo | undefined {
  return fieldInfos.find((i) => i.key === fieldState.deformKey && i.isVector);
}

// When deformed shape is active, produce a warped copy of the geometry
// (coords += deformScale · displacement). Everything else (topology, fields) is
// shared by reference so all field layers render on the deformed geometry.
function computeWarpedGeometry(): { prepared: PreparedNodes; model: MdpaModel } | null {
  if (!fieldState.modes.has("deformed") || !prepared || !model) return null;
  const info = selectedDeformInfo();
  if (!info) return null;
  const coords = new Float32Array(prepared.coords); // copy (never mutate the reference)
  const scale = fieldState.deformScale;
  for (let i = 0; i < model.nodeCount; i++) {
    const v = vectorAt(info, model.nodeIds[i]);
    if (!v) continue;
    coords[i * 3] += scale * v[0];
    coords[i * 3 + 1] += scale * v[1];
    coords[i * 3 + 2] += scale * v[2];
  }
  return { prepared: { index: prepared.index, coords }, model: { ...model, coords } };
}

// Rebuilds every active field overlay. Modes are combinable: deformed shape is
// a global warp so contour/quiver/iso all render on the deformed geometry;
// deformed + contour share one warped, colored surface layer.
function applyFieldMode(): void {
  removeFieldLayers();
  const info = selectedFieldInfo();
  const deformed = fieldState.modes.has("deformed");
  if ((!info && !deformed) || !prepared || !model) {
    restoreFieldBase();
    renderWindow.render();
    return;
  }
  const warp = computeWarpedGeometry();
  const prep = warp?.prepared ?? prepared;
  const useModel = warp?.model ?? model;

  // Surface layer: shown when contour and/or deformed are active. Colored by
  // the field when contour is on, neutral solid otherwise (pure deformed shape).
  const wantContour = !!info && fieldState.modes.has("contour");
  if (wantContour || deformed) buildSurfaceLayer(info, prep, wantContour);
  if (info?.isVector && fieldState.modes.has("quiver")) buildQuiverLayer(info, prep);
  if (info && !info.isVector && fieldState.modes.has("iso")) buildIsoLayer(info, useModel);

  syncBaseDimming();
  // Re-color the cut cap to match the (possibly changed) field/colormap.
  if (cutActive) buildCutCap();
  renderWindow.render();
}

// The (optionally warped, optionally colored) mesh surface. Deformed shape and
// contour share this single FIELD_CONTOUR_ID layer.
function buildSurfaceLayer(info: FieldInfo | undefined, prep: PreparedNodes, colored: boolean): void {
  const kinds: EntityKind[] | "all" =
    colored && info
      ? info.field.kind === "Elemental"
        ? ["Elements"]
        : info.field.kind === "Conditional"
        ? ["Conditions"]
        : "all"
      : "all";
  const cells = collectCells(kinds);
  const built = buildPolyData(prep, cells, colored && info ? contourAttach(info) : undefined);
  if (!built) return;
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(built.polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setEdgeVisibility(false);
  if (colored && info) {
    configureScalarMapper(mapper, info, currentColormap);
  } else {
    // Neutral deformed-shape surface (no field coloring).
    prop.setColor(0.8, 0.82, 0.88);
  }
  registerFieldLayer(FIELD_CONTOUR_ID, actor);
}

function buildQuiverLayer(info: FieldInfo, prep: PreparedNodes): void {
  const data = buildQuiverData(info, prep);
  if (!data || data.points.length === 0) return;
  const scaleFactor = quiverBaseScale(info) * fieldState.scale;
  const actor = buildGlyphActor(data, scaleFactor, currentColormap, info.scalarMin, info.scalarMax);
  registerFieldLayer(FIELD_QUIVER_ID, actor);
}

function buildIsoLayer(info: FieldInfo, srcModel: MdpaModel): void {
  const result = computeIsoSurface(srcModel, info.field, fieldState.isoValue);
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
// Anchors are read from `prep`, so quiver follows the deformation when active.
function buildQuiverData(info: FieldInfo, prep: PreparedNodes): QuiverData | undefined {
  const pts: number[] = [];
  const vecs: number[] = [];
  const mags: number[] = [];
  const centroidMap =
    info.field.kind === "Elemental" ? elementById : info.field.kind === "Conditional" ? conditionById : undefined;
  const coordOf = (nid: number): [number, number, number] | undefined => coordOfPrep(prep, nid);
  const centroidOf = (cell: Cell): [number, number, number] | undefined => {
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = 0; i < cell.nodeIds.length; i++) {
      const c = coordOf(cell.nodeIds[i]);
      if (!c) continue;
      x += c[0];
      y += c[1];
      z += c[2];
      n++;
    }
    return n === 0 ? undefined : [x / n, y / n, z / n];
  };

  for (let i = 0; i < info.field.ids.length; i++) {
    const id = info.field.ids[i];
    const vec = vectorAt(info, id);
    if (!vec) continue;
    let anchor: [number, number, number] | undefined;
    if (info.field.kind === "Nodal") {
      anchor = coordOf(id);
    } else {
      const cell = centroidMap?.get(id);
      if (cell) anchor = centroidOf(cell);
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

function coordOfPrep(prep: PreparedNodes, nodeId: number): [number, number, number] | undefined {
  const idx = prep.index.get(nodeId);
  if (idx === undefined) return undefined;
  const o = idx * 3;
  return [prep.coords[o], prep.coords[o + 1], prep.coords[o + 2]];
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
    if (CUT_CAP_LAYER_IDS.includes(id)) continue; // keep cap solid
    layer.actor.getProperty().setRepresentation(id === FIND_HIGHLIGHT_ID ? 2 : 1);
  }
  renderWindow.render();
}

function restoreWireframe(): void {
  const rep = wireframe ? 1 : 2;
  for (const [id, layer] of layers) {
    if (id === FIND_HIGHLIGHT_ID || CUT_CAP_LAYER_IDS.includes(id)) continue;
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

// --- Screenshot -------------------------------------------------------------
async function takeScreenshot(): Promise<void> {
  renderWindow.render();
  let dataUrl: string;
  // vtkOpenGLRenderWindow.captureNextImage() handles the WebGL swap-chain timing
  // correctly and returns a Promise<string>. Fall back to canvas.toDataURL if
  // the method is not available in this vtk.js build.
  if (typeof apiRW.captureNextImage === "function") {
    dataUrl = await (apiRW.captureNextImage("image/png") as Promise<string>);
  } else {
    dataUrl = vtkCanvas.toDataURL("image/png");
  }
  vscode.postMessage({ type: "screenshot", data: dataUrl });
}

vscode.postMessage({ type: "ready" });
