import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkRenderer from "@kitware/vtk.js/Rendering/Core/Renderer";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import vtkCellPicker from "@kitware/vtk.js/Rendering/Core/CellPicker";

import { EntityBlock, EntityKind, MdpaModel, SubModelPart } from "../src/parser/types";
import { computeMeshQuality, QualityReport } from "../src/parser/meshQuality";
import { computeMeshSize, MeshSizeResult } from "../src/parser/meshSize";
import { computeMeshNormals, MeshNormals } from "../src/parser/meshNormals";
import {
  FieldIntegral,
  IntegralPanelState,
  renderIntegralPanel,
} from "./integralPanel";
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
import { activeComponent, FieldPanelState, renderFieldPanel } from "./fieldPanel";
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
import { buildBeamGlyphActor } from "./beamGlyph";
import { BeamPanelInfo, BeamPanelState, renderBeamPanel } from "./beamPanel";
import {
  BeamStats,
  beamStats,
  buildBeamSegments,
  defaultBeamRadius,
} from "../src/parser/beamElements";
import { buildFieldInfo, FieldInfo, rangeForComponent, scalarAt, vectorAt } from "./fieldData";
import {
  contourAttach,
  configureScalarMapper,
  buildIsoPolyData,
  buildCutCapPolyData,
  buildCutCapEdgePolyData,
  attachCutCapScalars,
  ScalarStyle,
} from "./fieldRender";
import { buildGlyphActor, QuiverData } from "./quiver";
import { DEFAULT_COLORMAP, colorAt, getColormap, makeCtfFromStops } from "./colormaps";
import { FieldComponent, effectiveRange, spacedIsoValues, transformStops } from "../src/parser/fieldScalars";
import { ScalarBar, setupScalarBar } from "./scalarBar";
import { compositeLegend, LegendSpec } from "./screenshotLegend";
import { thresholdCells } from "../src/parser/thresholdCells";
import { resolvePick } from "../src/parser/pickResolve";
import { buildMembershipIndex, MembershipIndex } from "../src/parser/smpMembership";
import { findIsolatedNodeIds } from "../src/parser/isolatedNodes";
import { VtkCellType } from "../src/parser/geometryMap";
import {
  InspectPanelState,
  InspectSelection,
  MeasureResult,
  renderInspectPanel,
} from "./inspectPanel";
import {
  DEFAULT_LIGHTING_STATE,
  LightingState,
  renderLightingPanel,
} from "./lightingPanel";
import {
  BookmarksPanelState,
  CameraBookmark,
  renderBookmarksPanel,
} from "./bookmarksPanel";
import { SeriesPanelState, renderSeriesPanel } from "./seriesPanel";
import { RecordPanelState, renderRecordPanel } from "./recordPanel";
import { canRecordVideo, runRecording } from "./videoRecord";
import {
  DEFAULT_RECORD_SETTINGS,
  RecordSettings,
  buildRecordPlan,
} from "../src/parser/recordPlan";
import { FieldSeries, seriesToCsv } from "../src/parser/fieldSeries";
import {
  DataTablePanelState,
  PAGE_ROWS,
  renderDataTablePanel,
} from "./dataTablePanel";
import {
  TABLE_KINDS,
  TableKind,
  TableOptions,
  TableView,
  prepareTable,
  tableRowCount,
} from "../src/parser/dataTable";
import {
  PANE_LAYOUTS,
  PANE_LAYOUT_LABELS,
  PaneLayoutId,
  PaneViewport,
  isPaneLayout,
  paneCssRect,
  paneViewports,
} from "../src/parser/paneLayout";
import {
  ClipAxis,
  PaneClipState,
  PaneFieldState,
  clonePaneClipState,
  clonePaneFieldState,
  defaultPaneClipState,
  defaultPaneFieldState,
  paneLabel,
  reconcilePaneStates,
} from "../src/parser/paneView";
import { CameraState } from "../src/parser/cameraState";
import { RGB, getThemePalette, getThemeBackground } from "./themes";
import { OrientationCubeHandle, setupOrientationCube, snapCamera } from "./orientationCube";
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
  setMergeMeshPaths,
} from "./meshMod";
import { initEditHistory, renderOpHistory } from "./editHistory";
import { initOpQueue } from "./opQueue";
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
  opacityIcon: TOOLBAR_ICONS.opacity,
  organizeIcon: TOOLBAR_ICONS.tree,
  formats: EXPORT_MENU_GROUPS.flatMap((group) =>
    group.extensions.map((ext) => ({
      ext,
      label: EXPORT_FORMAT_LABELS[ext],
      group: group.label,
    }))
  ),
};

/** Every SubModelPart path, for the organize menu's move/merge destinations. */
function allSubModelPartPaths(model: MdpaModel): string[] {
  const out: string[] = [];
  const walk = (parts: SubModelPart[]): void => {
    for (const p of parts) {
      out.push(p.path);
      walk(p.children);
    }
  };
  walk(model.subModelParts);
  return out;
}

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

/**
 * One pane's view of a layer: its own actor AND its own mapper over the
 * layer's single shared vtkPolyData.
 *
 * A mapper per pane rather than an actor per pane because `addClippingPlane`
 * is a MAPPER method (vtkAbstractMapper) — a per-pane clip has no other shape.
 * It costs nothing on the GPU: a single actor added to N renderers already
 * builds N OpenGL actor nodes, each of which calls `addMissingNode(getMapper())`
 * against its OWN `_renderableChildMap` (Rendering/SceneGraph/ViewNode.js), so
 * there were always N OpenGL mapper nodes and N VBOs. What is genuinely shared
 * — the polydata, i.e. everything buildPolyData computes — still is.
 */
interface PaneProp {
  actor: any;
  mapper?: any;
}

// A layer that may have been built (polydata exists) or not yet (lazy).
interface Layer {
  id: string;
  /** One entry per pane, parallel to `panes`. */
  props: PaneProp[];
  /** Built once by buildLayerGeometry; every pane's mapper reads this one. */
  polyData?: any;
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
  /**
   * Set only for the base Elements/Conditions/Geometries block layers — the
   * homogeneous ones a picked cell can be unambiguously resolved against (a
   * SubModelPart layer mixes kinds and ids can collide across them, so those
   * stay unpickable — see the Inspect click handler). Drives both whether the
   * actor is pickable and which `elementById`/`conditionById`/`geometryById`
   * map a resolved entity id is looked up in.
   */
  pickKind?: EntityKind;
  /** Pick maps (see meshBuilder.ts), present only when pickKind is set and the layer is built. */
  pointGlobalIds?: Int32Array;
  cellEntityIds?: Int32Array;
  /** 0..1, default 1 (opaque) — set by the outline row's opacity popover. */
  opacity: number;
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

const beamPanelEl = document.createElement("div");
beamPanelEl.id = "beam-panel";
beamPanelEl.style.display = "none";
vtkSub.appendChild(beamPanelEl);

const integralPanelEl = document.createElement("div");
integralPanelEl.id = "integral-panel";
integralPanelEl.style.display = "none";
vtkSub.appendChild(integralPanelEl);

const inspectPanelEl = document.createElement("div");
inspectPanelEl.id = "inspect-panel";
inspectPanelEl.style.display = "none";
vtkSub.appendChild(inspectPanelEl);

const lightingPanelEl = document.createElement("div");
lightingPanelEl.id = "lighting-panel";
lightingPanelEl.style.display = "none";
vtkSub.appendChild(lightingPanelEl);

const bookmarksPanelEl = document.createElement("div");
bookmarksPanelEl.id = "bookmarks-panel";
bookmarksPanelEl.style.display = "none";
vtkSub.appendChild(bookmarksPanelEl);

const dataTablePanelEl = document.createElement("div");
dataTablePanelEl.id = "data-table-panel";
dataTablePanelEl.style.display = "none";
vtkSub.appendChild(dataTablePanelEl);

// Pane borders + focus cue for the split view. Inside #render-root so its
// percentages match the canvas exactly, and non-interactive so clicks reach
// the canvas beneath.
const paneChromeEl = document.createElement("div");
paneChromeEl.id = "pane-chrome";
paneChromeEl.style.display = "none";
renderRoot.appendChild(paneChromeEl);

const seriesPanelEl = document.createElement("div");
seriesPanelEl.id = "series-panel";
seriesPanelEl.style.display = "none";
vtkSub.appendChild(seriesPanelEl);

const recordPanelEl = document.createElement("div");
recordPanelEl.id = "record-panel";
recordPanelEl.style.display = "none";
vtkSub.appendChild(recordPanelEl);

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

// --- Split view: panes ----------------------------------------------------
//
// A pane is a VIEWPORT RECT on this one render window, not a second canvas:
// vtk.js draws N vtkRenderers into a single window, each with its own camera,
// and every pane shares the SAME vtkActor instances (verified: ViewNode.js
// gives each view node its own _renderableChildMap, so one actor under two
// renderers builds two OpenGL nodes over one mapper — geometry is never
// duplicated). Almost everything a split view normally has to hand-roll is
// native here: the interactor routes each event to the renderer under the
// pointer (findPokedRenderer -> InteractorStyle's `pokedRenderer`), the
// manipulators normalize drags by the poked renderer's own viewport size, and
// vtkPicker clips to it — so there is no input gate, no sensitivity fudge and
// no pane-relative NDC math anywhere in this file.
//
// What is per-pane and what is not: the CAMERA, the FIELD settings and the
// CLIP plane are per-pane; which layers exist, their visibility, colour,
// opacity and display mode are global, because those are edited from one
// outline tree with one checkbox per layer and the want here is different
// fields, not different layer sets.
interface Pane {
  renderer: any;
  /** Per-pane cube axes: the actor binds a camera at construction. */
  grid: GridAxes;
  /** Everything the Field panel edits — see src/parser/paneView.ts. */
  field: PaneFieldState;
  /** Everything the nav card's Clip group edits. */
  clip: PaneClipState;
  /** This pane's clipping plane; clipping planes live on the mapper, which is
   *  why every layer carries a mapper per pane (see PaneProp). */
  clipPlane: any;
  /**
   * The field overlays this pane draws (contour / quiver / iso:N / threshold
   * and the two cut-cap actors), added ONLY to this pane's renderer. They are
   * deliberately not in the global `layers` map: they differ per pane in
   * geometry, not merely in properties.
   */
  overlays: Map<string, any>;
  /** In-scene legend, one per pane since each pane colours by its own field. */
  scalarBar: ScalarBar;
  /** Whether this pane's base layers are forced to wireframe under an overlay. */
  dimmed: boolean;
}
let paneLayout: PaneLayoutId = "1x1";
const panes: Pane[] = [];

// No renderer-level opt-in needed for the per-layer opacity sliders (see
// setLayerOpacity): this vtk.js version always routes any actor with
// opacity < 1 through vtkOrderIndependentTranslucentPass automatically
// (Rendering/OpenGL/ForwardPass.js — gated on the actor's own translucency,
// not on any renderer flag). renderer.setUseDepthPeeling/
// setMaximumNumberOfPeels/setOcclusionRatio are vestigial on this version —
// OrderIndependentTranslucentPass.js never reads them — so they're
// deliberately not called here; doing so would suggest they matter when they
// don't. Known caveat verified against this repo's own precedent (the
// pre-existing 0.5-opacity quadratic mid-node overlay): under a software
// WebGL2 rasterizer (e.g. headless/CI, or a remote/WSL VS Code session with
// no GPU passthrough), the OIT composite can render translucent layers at
// full opacity instead of blending — a vtk.js/driver limitation, not
// something this extension can work around from the outside.

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
  renderWindow, focusedRenderer, grw.getInteractor(), vtkCanvas
);
// Pane 0 is the renderer that already existed, so a single-pane session is
// byte-for-byte the previous behaviour.
panes.push(makePane(renderer, document.body.dataset.theme ?? "auto"));
renderer.setViewport(...paneViewports("1x1")[0]);

/** A pane over an existing renderer, with default (or seeded) view state. */
function makePane(r: any, theme: string, seed?: Pane): Pane {
  return {
    renderer: r,
    grid: setupGridAxes(r, theme),
    field: seed ? clonePaneFieldState(seed.field) : defaultPaneFieldState(DEFAULT_COLORMAP),
    clip: seed ? clonePaneClipState(seed.clip) : defaultPaneClipState(),
    clipPlane: vtkPlane.newInstance(),
    overlays: new Map<string, any>(),
    scalarBar: setupScalarBar(r, theme),
    dimmed: false,
  };
}

/**
 * The pane every pane-scoped action applies to: the one the pointer last
 * pressed or released in.
 *
 * vtk.js tracks a poked renderer per pointer event, and that is the right
 * answer WHILE the pointer is over the canvas — but it is not a latch.
 * `handlePointerLeave` re-runs `findPokedRenderer` with the leave coordinates,
 * which are outside every viewport, and that falls through to
 * `interactiveren ?? viewportren ?? rc[0]` — some other renderer entirely
 * (vtkOrientationMarkerWidget adds one of its own to this window). So the
 * moment the pointer moves off the canvas to reach the toolbar, the Field
 * panel or the nav card, `getCurrentRenderer()` stops naming the pane the user
 * was working in — which is precisely when a Reset, a Frame, a clip drag or a
 * field change is about to be issued for it.
 *
 * Hence the latch: `latchFocusedPane` records the pane on a canvas press or
 * release, and it stays recorded until the next one. vtk.js keeps routing its
 * OWN orbit/pan/zoom by the live poked renderer, which is correct — that is
 * hover behaviour, and it never has to survive leaving the canvas.
 */
let focusedPaneIdx = 0;

function focusedPaneIndex(): number {
  return focusedPaneIdx < panes.length ? focusedPaneIdx : 0;
}

/** Records the pane under the pointer, if the poked renderer is one. */
function latchFocusedPane(): void {
  const current = grw.getInteractor().getCurrentRenderer();
  const i = panes.findIndex((p) => p.renderer === current);
  if (i >= 0) focusedPaneIdx = i;
}

function focusedRenderer(): any {
  return panes[focusedPaneIndex()].renderer;
}

/**
 * The pane every panel edits: the one you last touched.
 *
 * The same rule Reset, Frame, the camera bookmarks and the 1-6 view shortcuts
 * already follow, extended to the Field panel and the Clip group — rather than
 * a second, independent "current pane" selector that could disagree with the
 * focus border.
 */
function focusedPane(): Pane {
  return panes[focusedPaneIndex()];
}

/** Run something on every pane — geometry is shared, view state is not. */
function eachPane(fn: (pane: Pane, index: number) => void): void {
  panes.forEach(fn);
}

/** Run something on a layer's actor/mapper in every pane. */
function eachProp(layer: Layer, fn: (prop: PaneProp, index: number) => void): void {
  layer.props.forEach(fn);
}

/** A layer's actor in the focused pane — for bounds, which are camera-free. */
function focusedProp(layer: Layer): PaneProp | undefined {
  return layer.props[focusedPaneIndex()];
}

/** Sets one property on a layer's actor in every pane. */
function eachLayerProperty(layer: Layer, fn: (prop: any) => void): void {
  for (const p of layer.props) fn(p.actor.getProperty());
}

/**
 * The pane borders, as DOM.
 *
 * Panes are viewport rects on one canvas, so there is nothing to hit-test and
 * nothing to drag — these divs are `pointer-events: none` decoration sized in
 * percentages, and they double as the focus cue (which pane Reset/Frame will
 * act on), which the dividers alone could not show.
 */
function syncPaneChrome(): void {
  paneChromeEl.textContent = "";
  paneChromeEl.style.display = paneLayout === "1x1" ? "none" : "";
  if (paneLayout === "1x1") return;
  const focused = focusedPaneIndex();
  paneViewports(paneLayout).forEach((v: PaneViewport, i: number) => {
    const box = document.createElement("div");
    box.className = i === focused ? "pane-box focused" : "pane-box";
    const r = paneCssRect(v);
    box.style.left = `${r.left}%`;
    box.style.top = `${r.top}%`;
    box.style.width = `${r.width}%`;
    box.style.height = `${r.height}%`;
    paneChromeEl.appendChild(box);
  });
}

function syncLayoutMenu(): void {
  for (const id of PANE_LAYOUTS) {
    document
      .querySelector(`[data-action="layout:${id}"]`)
      ?.classList.toggle("active", id === paneLayout);
  }
}

/** Copies a camera so a new pane starts where the kept one is, then diverges. */
function copyCamera(from: any, to: any): void {
  const a = from.getActiveCamera();
  const b = to.getActiveCamera();
  b.setPosition(...(a.getPosition() as number[]));
  b.setFocalPoint(...(a.getFocalPoint() as number[]));
  b.setViewUp(...(a.getViewUp() as number[]));
  b.setParallelProjection(a.getParallelProjection());
  b.setParallelScale(a.getParallelScale());
  to.resetCameraClippingRange();
}

/**
 * Switch the pane layout.
 *
 * The FOCUSED pane survives as pane 0 in both directions, so the view you were
 * working in is never the one thrown away. New panes are seeded from it and
 * then diverge; surplus panes are removed from the render window and deleted,
 * because accumulating renderers across layout switches is the obvious leak.
 */
function setPaneLayout(next: PaneLayoutId): void {
  if (next === paneLayout) return;
  const rects = paneViewports(next);
  const keepIndex = focusedPaneIndex();
  const keep = panes[keepIndex];
  // Field + clip state for the new layout: the kept pane's, cloned onto every
  // new pane so a split starts identical and then diverges — the same promise
  // copyCamera makes for the camera.
  const states = reconcilePaneStates(
    panes.map((p) => ({ field: p.field, clip: p.clip })),
    keepIndex,
    rects.length,
    DEFAULT_COLORMAP
  );

  // Drop the panes that are going away (never the kept one), with everything
  // they own: their overlays, their per-pane layer actors, grid and legend.
  for (let i = panes.length - 1; i >= 0; i--) {
    const pane = panes[i];
    if (pane === keep) continue;
    clearPaneOverlays(pane);
    for (const layer of layers.values()) {
      const prop = layer.props[i];
      if (!prop) continue;
      pane.renderer.removeActor(prop.actor);
      prop.actor.delete();
      layer.props.splice(i, 1);
    }
    pane.grid.dispose();
    pane.scalarBar.dispose();
    renderWindow.removeRenderer(pane.renderer);
    pane.renderer.delete();
    panes.splice(i, 1);
  }

  for (let i = panes.length; i < rects.length; i++) {
    const r: any = vtkRenderer.newInstance();
    renderWindow.addRenderer(r);
    const pane = makePane(r, currentTheme, keep);
    pane.grid.setVisible(gridVisible);
    if (model) {
      const mb = model.bounds;
      pane.grid.updateBounds([mb.min[0], mb.max[0], mb.min[1], mb.max[1], mb.min[2], mb.max[2]]);
    }
    panes.push(pane);
    // Each layer gains an actor+mapper for the new pane over its EXISTING
    // polydata — geometry is still built once, per layer, not once per pane.
    for (const layer of layers.values()) {
      const prop = makeLayerProp(layer, i);
      prop.actor.setVisibility(layerShouldDraw(layer));
      layer.props[i] = prop;
      r.addActor(prop.actor);
    }
    copyCamera(keep.renderer, r);
  }

  paneLayout = next;
  focusedPaneIdx = 0; // the kept pane is always pane 0 after a layout switch
  panes.forEach((p, i) => {
    p.field = states[i].field;
    p.clip = states[i].clip;
    p.renderer.setViewport(...rects[i]);
    p.renderer.setBackground(...(keep.renderer.getBackground() as number[]));
    updateClipPlane(p);
    applyClipToPane(p);
  });
  // Rebuild what the seeded state says each pane should be showing.
  eachPane((p) => {
    if (fieldVisible) applyFieldMode(p);
    if (p.clip.active) buildCutCap(p);
  });
  // Glyph overlays (spheres, beams, normals, the mesh-size colour surface)
  // are built by a factory rather than from a shared polydata, so a new pane
  // has no actor for them until they are rebuilt.
  rebuildGlobalOverlays();
  syncPaneDimming();
  syncPaneChrome();
  syncLayoutMenu();
  lastFocusedPane = 0;
  syncClipUI();
  if (fieldVisible) renderFieldPanelUI();
  // Node ids are projected against one camera, so they are only meaningful in
  // a single pane — see setNodeIds.
  if (showNodeIds) setNodeIds(showNodeIds);
  renderWindow.render();
}

/**
 * Rebuilds the global overlay layers whose actors come from a factory rather
 * than from a layer's shared polydata (see registerGlobalOverlay), so a newly
 * added pane draws them too.
 */
function rebuildGlobalOverlays(): void {
  if (meshSizeState.color !== "none") applyMeshSizeColor();
  if (normalsVisible) applyNormalsLayer();
  if (sphereState.enabled) applySphereLayer();
  if (beamState.enabled) applyBeamLayer();
}

/** Puts each pane's actor for a layer into that pane's renderer. */
function attachLayerToPanes(layer: Layer): void {
  layer.props.forEach((prop, i) => panes[i]?.renderer.addActor(prop.actor));
}

/** Removes a layer's actors from every pane and deletes them. */
function detachLayerFromPanes(layer: Layer): void {
  layer.props.forEach((prop, i) => {
    panes[i]?.renderer.removeActor(prop.actor);
    prop.actor.delete();
  });
  layer.props = [];
}

// --- Navigation controls (DOM overlay, always visible) ------------------
const navControls = new NavControls(vtkSub, focusedRenderer, renderWindow);

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

// Data table: every entity of one kind as rows of plain values. The view is
// memoized like qualityReport/meshSizeReport and invalidated in buildScene.
let dataTableView: TableView | undefined;
let dataTableVisible = false;
/** Whether the VTK timeline bar is docked at the bottom (see syncNavOffset). */
let timelineVisible = false;
/**
 * How many steps the timeline has. Separate from `timelineVisible`, which is
 * set for ANY vtkGroup including a single-step one that TimelineControl then
 * hides — and a one-step "series" is not something to plot.
 */
let timelineFrameCount = 0;
/** The step the scene is showing, for the chart's "you are here" rule. */
let currentFrameIndex = 0;

// --- Recording ------------------------------------------------------------
let recordVisible = false;
let recordSettings: RecordSettings = { ...DEFAULT_RECORD_SETTINGS };
let recordProgress: { done: number; total: number } | undefined;
let recordCancelled = false;
let recordMessage: string | undefined;
/**
 * Resolved at the end of the `vtkFrame` handler — the only point in this file
 * that knows a requested frame is actually ON SCREEN. `vtkRequestFrame` has no
 * correlation id and the host answers it fire-and-forget, so a recorder that
 * did not await this would capture whichever frame happened to have landed.
 */
let pendingFrame: { index: number; resolve: () => void } | undefined;
/** Suppresses the loading overlay, which sets `#app { display: none }` and
 *  would blank the canvas mid-capture. */
let recordingActive = false;

// --- Time series ---------------------------------------------------------
let seriesVisible = false;
let seriesState: SeriesPanelState | undefined;
const TABLE_MARKER_ID = "table:marker";
const TABLE_MARKER_COLOR: RGB = [1.0, 0.85, 0.1];
const dataTableState = {
  kind: "Nodes" as TableKind,
  opts: {} as TableOptions,
  page: 0,
  focusRow: undefined as number | undefined,
  selectedId: undefined as number | undefined,
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

// Beam/line rendering: line cells drawn as real tubes sized by their section
// (CROSS_AREA from the cell's Properties, or the panel's constant — see
// src/parser/beamElements.ts).
//
// Unlike the sphere layer this does NOT suppress the base line layers, and that
// is deliberate on two counts. registerGlobalOverlay forces setPickable(false), so
// suppressing them would make an entire beam frame uninspectable and
// unfindable — and unlike a particle cloud, a frame IS the model you click on.
// SubModelPart layers also mix line, surface and volume cells in one actor, so
// a whole-layer suppression could not remove just the lines from them anyway.
// It is safe to leave them: a line lies exactly on its tube's axis, i.e.
// strictly interior, so the depth test hides it wherever the tube is more than
// about a pixel wide — and where it is not, the line is precisely the fallback
// you want.
const BEAM_LAYER_ID = "beam:glyphs";
const BEAM_COLOR: RGB = [0.72, 0.76, 0.85];
let beamVisible = false; // panel open
/** Per-model memos, invalidated in buildScene like sphereStatsCache. */
let beamStatsCache: BeamStats | undefined;
let beamSuggested: number | undefined;
const beamState = {
  enabled: false,
  /** Multiplies the RADIUS only, never the length — see buildBeamGlyphActor. */
  thickness: 1,
  resolution: 12,
  /** undefined = draw at the suggested radius; a number overrides it. */
  constant: undefined as number | undefined,
  includeConditions: false,
  colorBySection: false,
  colormap: DEFAULT_COLORMAP,
};

/** Counts + section range of the model's line cells (one pass, memoized). */
function beams(): BeamStats {
  if (!beamStatsCache) {
    beamStatsCache = model
      ? beamStats(model)
      : {
          blocks: 0,
          cells: 0,
          withSection: 0,
          elementsWithSection: 0,
          radiusMin: 0,
          radiusMax: 0,
        };
  }
  return beamStatsCache;
}

/** The radius to draw a line cell at when the mesh gives it no section. */
function suggestedBeamRadius(): number {
  if (beamSuggested === undefined) {
    beamSuggested = model ? defaultBeamRadius(model) : 1;
  }
  return beamSuggested;
}

/** The radius actually used for cells with no section of their own. */
function beamConstant(): number {
  return beamState.constant ?? suggestedBeamRadius();
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
// Nodes referenced by no cell connectivity (connectivity-only: SubModelPart
// listing does not count — see isolatedNodes.ts). Shown as prominent points so
// a node-only SubModelPart, and any stray node, is visible without hunting.
const ISOLATED_LAYER_ID = "diagnostics:isolated-nodes";
const ISOLATED_COLOR: RGB = [1.0, 0.45, 0.0];

// Field visualization overlay ids. These key `Pane.overlays`, not the global
// `layers` map: a field overlay differs per pane in GEOMETRY, not merely in
// properties, so it belongs to the pane that drew it.
const FIELD_CONTOUR_ID = "field:contour";
const FIELD_QUIVER_ID = "field:quiver";
const FIELD_THRESHOLD_ID = "field:threshold";
// Multiple simultaneous iso values (Phase 1.5) each get their own layer id
// under this prefix rather than a single fixed id.
const FIELD_ISO_PREFIX = "field:iso:";
function isFieldLayerId(id: string): boolean {
  return (
    id === FIELD_CONTOUR_ID ||
    id === FIELD_QUIVER_ID ||
    id === FIELD_THRESHOLD_ID ||
    id.startsWith(FIELD_ISO_PREFIX)
  );
}
let fieldInfos: FieldInfo[] = [];
/** Whether the Field panel is open. The panel is global; what it EDITS is the
 *  focused pane's own `field` state (see Pane / src/parser/paneView.ts). */
let fieldVisible = false;

// The active modes are an independent set: contour / quiver / iso / deformed
// can be combined. Deformation is a per-pane warp (own vector field + scale) so
// all of that pane's field layers render on the deformed geometry.
//
// The in-scene legend is one vtkScalarBarActor PER PANE (Pane.scalarBar),
// because each pane colours by its own field; it is not a mesh layer, so
// clearScene never touches it — only its visibility and colour transfer
// function change on a field-mode rebuild.

// --- Inspect / picking ---------------------------------------------------
const INSPECT_MARKER_ID = "inspect:marker";
const INSPECT_MARKER_COLOR: RGB = [1.0, 0.85, 0.1];
const MEASURE_POINTS_ID = "inspect:measure-points";
const MEASURE_LINE_ID = "inspect:measure-line";
const MEASURE_COLOR: RGB = [1.0, 0.4, 0.85];
const cellPicker: any = vtkCellPicker.newInstance();
let inspectMode = false;
let inspectVisible = false;
let inspectSelection: InspectSelection | undefined;
let measuring = false;
let measurePendingPoint: { id: number; coords: [number, number, number] } | undefined;
let measureResult: MeasureResult | undefined;
/** Reverse SubModelPart-membership index, memoized per model like qualityReport. */
let membershipIndex: MembershipIndex | undefined;

// --- Rendering quality: projection, lighting, camera bookmarks -----------
let parallelProjection = false;
let lightingState: LightingState = { ...DEFAULT_LIGHTING_STATE };
let lightingVisible = false;
let bookmarksVisible = false;
// Session-only (not persisted across a reload) — the JSON textarea in the
// panel is the cross-session/sharing path, see bookmarksPanel.ts.
let bookmarks: CameraBookmark[] = [];

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
      // Not while recording: showLoading sets #app { display: none }, and a
      // hidden canvas cannot be copied from.
      if (!recordingActive) {
        showLoading(
          "Reading file…",
          msg.totalBytes > 0 ? msg.bytesRead / msg.totalBytes : undefined
        );
      }
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
      syncNavOffset();
      break;
    case "vtkGroup":
      timeline.show(
        (msg.group as { steps: string[] }).steps.length,
        (msg.group as { steps: string[] }).steps
      );
      timelineFrameCount = (msg.group as { steps: string[] }).steps.length;
      timelineVisible = true;
      navControls.setBottomOffset(44); // 36px timeline bar + 8px gap
      syncNavOffset();
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
      currentFrameIndex = msg.frameIndex as number;
      // The chart's "you are here" rule moved, and clearScene dropped the
      // marker for the entity the chart is about — put both back.
      if (seriesVisible) {
        restoreSeriesMarker();
        renderSeriesUI();
      }
      // The frame is now on screen — this is the only place that knows it.
      if (pendingFrame && pendingFrame.index === currentFrameIndex) {
        const resolve = pendingFrame.resolve;
        pendingFrame = undefined;
        resolve();
      }
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
    case "fieldSeriesProgress": {
      const p = msg as unknown as { done: number; total: number; label: string };
      if (seriesVisible && seriesState) {
        seriesState = { ...seriesState, progress: p, message: undefined };
        renderSeriesUI();
      }
      break;
    }

    case "fieldSeriesResult": {
      const r = msg as unknown as {
        series?: FieldSeries;
        message?: string;
        historyNote?: string;
      };
      // A reply that outlived its panel is dropped rather than stashed — the
      // same rule the integrals panel follows.
      if (seriesVisible && seriesState) {
        seriesState = {
          ...seriesState,
          progress: undefined,
          series: r.series,
          message: r.message,
          historyNote: r.historyNote,
        };
        renderSeriesUI();
      }
      break;
    }

    case "meshAnalysisResult": {
      const r = msg as { kind?: string };
      if (r.kind === "watertight") applyWatertightResult(msg as Parameters<typeof applyWatertightResult>[0]);
      else if (r.kind === "integrate") applyFieldIntegrals(msg as Parameters<typeof applyFieldIntegrals>[0]);
      break;
    }
    case "mergeMeshPicked":
      setMergeMeshPaths(
        (msg as { paths: string[] }).paths,
        (msg as { target?: string }).target
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
    case "beams":
      toggleBeamPanel();
      break;
    case "field":
      toggleFieldPanel();
      break;
    case "takeScreenshot":
      void takeScreenshot();
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
  for (const layer of layers.values()) detachLayerFromPanes(layer);
  layers.clear();
  // The per-pane field/cut-cap overlays are not in `layers` — they belong to
  // the pane, so they have to be torn down with it.
  eachPane((p) => clearPaneOverlays(p));
  labelsEl.textContent = "";
  messageEl.textContent = "";
  // Base layers are recreated solid; any prior field dimming no longer applies.
  eachPane((p) => (p.dimmed = false));
}

/**
 * Per-layer visibility overrides consumed by the next buildScene: an in-place
 * re-render (edit/mesh-modification result, VTK frame change) keeps the user's
 * layer toggles for layers that still exist, while brand-new layers (e.g. the
 * MMG level-set domains) get the normal defaults.
 */
let nextVisOverride: Map<string, boolean> | undefined;
/** Same idea as nextVisOverride, for opacity — so scrubbing a timeline or an
 * in-place edit doesn't silently snap a user-dimmed layer back to opaque. */
let nextOpacityOverride: Map<string, number> | undefined;

/** Snapshot the current layers' visibility + opacity to reapply on the next rebuild. */
function snapshotVisibility(): void {
  nextVisOverride = new Map([...layers.entries()].map(([id, l]) => [id, l.visible]));
  nextOpacityOverride = new Map([...layers.entries()].map(([id, l]) => [id, l.opacity]));
}

function buildScene(resetCam = true): void {
  if (!model) return;
  clearScene();
  prepared = prepareNodes(model);
  // A fresh model invalidates any cached quality / mesh-size report.
  qualityReport = undefined;
  meshSizeReport = undefined;
  dataTableView = undefined;
  // The table's marker went with clearScene, so the selection it belonged to
  // goes too: the ids need not survive the edit that triggered this rebuild.
  dataTableState.selectedId = undefined;
  // A fresh model invalidates the particle stats and the suggested radius; any
  // user-set constant is dropped too, since it was chosen for the old scale.
  sphereStatsCache = undefined;
  sphereSuggested = undefined;
  beamStatsCache = undefined;
  beamSuggested = undefined;
  normalsReport = undefined;
  sphereState.constant = undefined;
  beamState.constant = undefined;
  // A fresh model invalidates the SubModelPart membership index and any
  // in-progress inspection/measurement (clearScene already removed their
  // layers along with everything else, so only the state needs resetting).
  membershipIndex = undefined;
  inspectSelection = undefined;
  measurePendingPoint = undefined;
  measureResult = undefined;
  if (inspectVisible) renderInspectUI();
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
        entityId: block.entityIds[i],
      });
    }
    const opacity = nextOpacityOverride?.get(id) ?? 1;
    const created = addLayer(id, cells, color, visible, paletteIndex, block.kind, opacity);
    blockNodes.push({
      label: block.name + (block.vtkCellType === undefined ? " (?)" : ""),
      count: block.count,
      layerId: created ? id : undefined,
      visible,
      color,
      opacity,
    });
  }

  const partNodes: OutlineNode[] = model.subModelParts.map((p) =>
    buildPartLayer(p, elementById, conditionById, geometryById, nextColorEntry)
  );

  // Automatic isolated-nodes highlight: every node referenced by no cell
  // connectivity, drawn as prominent points. Visible by default (that is the
  // point — strays should be seen without hunting), toggleable like any other
  // layer, and carried across re-renders by the visibility snapshot.
  const diagNodes: OutlineNode[] = [];
  const isolatedIds = findIsolatedNodeIds(model);
  if (isolatedIds.length > 0) {
    const cells: Cell[] = isolatedIds.map((nid) => ({ cellType: undefined, nodeIds: [nid] }));
    const visible = nextVisOverride?.get(ISOLATED_LAYER_ID) ?? true;
    const opacity = nextOpacityOverride?.get(ISOLATED_LAYER_ID) ?? 1;
    const created = addLayer(ISOLATED_LAYER_ID, cells, ISOLATED_COLOR, visible, -1, undefined, opacity);
    if (created) {
      eachLayerProperty(layers.get(ISOLATED_LAYER_ID)!, (prop) => {
        prop.setPointSize(10);
        prop.setEdgeVisibility(false);
      });
    }
    diagNodes.push({
      label: "Isolated nodes",
      count: isolatedIds.length,
      layerId: created ? ISOLATED_LAYER_ID : undefined,
      visible,
      color: ISOLATED_COLOR,
    });
  }

  // Overlay of quadratic mid-edge nodes (semitransparent points), when a
  // linear→quadratic conversion just ran. Toggleable like any other layer.
  const modNodes: OutlineNode[] = [];
  if (midNodeIds.length > 0) {
    const cells: Cell[] = midNodeIds.map((nid) => ({ cellType: undefined, nodeIds: [nid] }));
    const created = addLayer(MIDNODES_LAYER_ID, cells, MIDNODES_COLOR, true);
    if (created) {
      eachLayerProperty(layers.get(MIDNODES_LAYER_ID)!, (prop) => {
        prop.setOpacity(0.5);
        prop.setPointSize(10);
        prop.setEdgeVisibility(false);
      });
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
  if (diagNodes.length) roots.push({ label: "Diagnostics", section: true, children: diagNodes });
  if (modNodes.length) roots.push({ label: "Mesh Modification", section: true, children: modNodes });
  renderOutline(
    outlineEl,
    roots,
    {
      onToggle: (layerId, visible) => setLayerVisible(layerId, visible),
      onFocus: (layerId) => frameLayer(layerId),
      onOpacity: (layerId, opacity) => setLayerOpacity(layerId, opacity),
      onExport: (path, ext) =>
        vscode.postMessage({ type: "menuExportPart", format: ext, path }),
      onDelete: (path) =>
        vscode.postMessage({ type: "applyOp", op: "deleteSubModelPart", path }),
      onRename: (path, newName) =>
        vscode.postMessage({ type: "applyOp", op: "renameSubModelPart", path, newName }),
      onCreateChild: (parentPath, name) =>
        vscode.postMessage({ type: "applyOp", op: "createSubModelPart", parentPath, name }),
      onMove: (path, newParentPath) =>
        vscode.postMessage({ type: "applyOp", op: "moveSubModelPart", path, newParentPath }),
      onMerge: (sourcePath, targetPath) =>
        vscode.postMessage({ type: "applyOp", op: "mergeSubModelParts", sourcePath, targetPath }),
      onAddEntities: (path, kind, ids) =>
        vscode.postMessage({ type: "applyOp", op: "addSubModelPartEntities", path, kind, ids }),
      onRemoveEntities: (path, kind, ids) =>
        vscode.postMessage({ type: "applyOp", op: "removeSubModelPartEntities", path, kind, ids }),
    },
    { ...OUTLINE_EXPORT_UI, allPaths: allSubModelPartPaths(model) }
  );

  // Rebuild field lookups; keep each pane's selection if its variable still
  // exists. Per pane, since the panes need not be showing the same field.
  fieldInfos = model.fields.map(buildFieldInfo);
  eachPane((p) => {
    if (!fieldInfos.some((i) => i.key === p.field.selectedKey)) {
      p.field.selectedKey = fieldInfos[0]?.key ?? "";
      resetFieldStateForSelection(p);
    }
    // Keep the deformation field valid (default to the first vector field).
    if (!fieldInfos.some((i) => i.key === p.field.deformKey && i.isVector)) {
      p.field.deformKey = fieldInfos.find((i) => i.isVector)?.key ?? "";
    }
  });

  renderStats();
  if (resetCam) resetCamera();

  // Update grid axes bounding box to match the new model.
  const mb = model.bounds;
  eachPane((p) =>
    p.grid.updateBounds([mb.min[0], mb.max[0], mb.min[1], mb.max[1], mb.min[2], mb.max[2]])
  );

  eachPane((p) => {
    if (!p.clip.active) return;
    updateClipPlane(p);
    applyClipToPane(p);
    buildCutCap(p);
  });
  renderWindow.render();
  // Refresh the quality panel against the new model if it is open.
  if (qualityVisible) showQualityPanel();
  // Refresh the mesh-size panel + overlays against the new model if it is open.
  if (meshSizeVisible) showMeshSizePanel();
  // Refresh the field panel against the new model if it is open.
  if (fieldVisible) showFieldPanel();
  // Refresh the data table against the new model if it is open (an edit op
  // changes the very rows it is showing).
  if (dataTableVisible) showDataTablePanel();

  // Particles with a declared radius render as spheres straight away — that IS
  // the mesh, not an analysis overlay. A radius-less point cloud stays as GL
  // points (the panel is still there, offering a constant), so an ordinary
  // point cloud does not silently turn into a ball pit.
  if (spheres().withRadius > 0) sphereState.enabled = true;
  if (sphereState.enabled) applySphereLayer();
  if (sphereVisible) renderSphereUI();

  // Line ELEMENTS with a declared section render as tubes straight away, for
  // the same reason: that geometry is the mesh. The gate is deliberately
  // narrower than the spheres' — `elementsWithSection`, not `withSection` — so
  // a boundary condition that merely shares a structural part's Properties id
  // cannot switch the whole rendering on. A sectionless line mesh (a 2D fluid
  // skin, an imported wireframe) stays as plain lines.
  if (beams().elementsWithSection > 0) beamState.enabled = true;
  if (beamState.enabled) applyBeamLayer();
  if (beamVisible) renderBeamUI();
  // clearScene() dropped the arrows; rebuild them against the new model so the
  // toggle survives a timeline step or an edit.
  if (normalsVisible) applyNormalsLayer();

  // Always repaint so an in-place rebuild (e.g. applying an edit with the camera
  // preserved) shows immediately instead of waiting for the next interaction.
  renderWindow.render();

  // The visibility/opacity snapshot only applies to the rebuild it was taken for.
  nextVisOverride = undefined;
  nextOpacityOverride = undefined;
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

  // A node-only part (no element/condition/geometry ids, and no cell fully
  // inside its node set) falls through to one point cell per node, so the part
  // is previewable as points rather than listed without a layer.
  let pointsOnly = false;
  if (cells.length === 0 && part.nodeIds.length > 0) {
    for (let i = 0; i < part.nodeIds.length; i++) {
      cells.push({ cellType: undefined, nodeIds: [part.nodeIds[i]] });
    }
    pointsOnly = true;
  }

  const [color, paletteIndex] = nextColor();
  const id = `smp:${part.path}`;
  // SubModelParts are lazy/hidden by default (kept toggled-on across in-place
  // op re-renders via the visibility snapshot).
  const visible = nextVisOverride?.get(id) ?? false;
  const opacity = nextOpacityOverride?.get(id) ?? 1;
  const created = addLayer(id, cells, color, visible, paletteIndex, undefined, opacity);
  if (created && pointsOnly) {
    // Point cells render at makeLayerProp's default pointSize 6, which reads
    // as dust on a real mesh — match the mid-nodes overlay size instead.
    eachLayerProperty(layers.get(id)!, (prop) => {
      prop.setPointSize(10);
      prop.setEdgeVisibility(false);
    });
  }
  const explicitCount = part.elementIds.length + part.conditionIds.length + part.geometryIds.length;
  const total = explicitCount > 0 ? explicitCount : induced ? cells.length : part.nodeIds.length;

  return {
    label: part.name,
    count: total,
    layerId: created ? id : undefined,
    visible,
    color,
    opacity,
    exportPath: part.path,
    counts: subModelPartCounts(part),
    children: part.children.map((child) =>
      buildPartLayer(child, elementById, conditionById, geometryById, nextColor)
    ),
  };
}

// addLayer now defers polydata construction for hidden layers.
function addLayer(
  id: string,
  cells: Cell[],
  color: RGB,
  visible: boolean,
  paletteIndex = -1,
  pickKind?: EntityKind,
  opacity = 1
): boolean {
  if (!prepared) return false;

  const layer: Layer = {
    id,
    props: [],
    color,
    paletteIndex,
    visible,
    built: false,
    pendingCells: cells,
    pickKind,
    opacity,
  };
  // One actor+mapper per pane, over the one polydata built below.
  panes.forEach((_, i) => layer.props.push(makeLayerProp(layer, i)));

  if (visible) {
    if (!buildLayerGeometry(layer)) return false;
  }

  eachProp(layer, (prop) => prop.actor.setVisibility(visible));
  attachLayerToPanes(layer);
  layers.set(id, layer);
  return true;
}

/** This pane's actor for a layer, styled from the layer's shared properties. */
function makeLayerProp(layer: Layer, paneIndex: number): PaneProp {
  const actor = vtkActor.newInstance();
  const prop = actor.getProperty();
  const c = layer.color;
  prop.setColor(c[0], c[1], c[2]);
  prop.setEdgeVisibility(true);
  prop.setEdgeColor(c[0] * 0.5, c[1] * 0.5, c[2] * 0.5);
  prop.setPointSize(6);
  prop.setLineWidth(1.5);
  prop.setOpacity(layer.opacity);
  applyLightingToProp(prop);
  actor.setVisibility(false); // always start invisible; set by the caller
  // Only the homogeneous base blocks are pickable — see Layer.pickKind.
  actor.setPickable(layer.pickKind !== undefined);
  const entry: PaneProp = { actor };
  if (layer.polyData) bindLayerMapper(layer, entry, paneIndex);
  return entry;
}

/** Gives one pane's actor a mapper over the layer's shared polydata. */
function bindLayerMapper(layer: Layer, prop: PaneProp, paneIndex: number): void {
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(layer.polyData);
  prop.actor.setMapper(mapper);
  prop.mapper = mapper;
  const pane = panes[paneIndex];
  if (pane?.clip.active) mapper.addClippingPlane(pane.clipPlane);
}

function buildLayerGeometry(layer: Layer): boolean {
  if (layer.built || !prepared || !layer.pendingCells) return layer.built;
  const built = buildPolyData(prepared, layer.pendingCells, undefined, {
    wantPickMaps: layer.pickKind !== undefined,
  });
  if (!built) return false;
  // The expensive part happens once; each pane only wraps it in a mapper.
  layer.polyData = built.polyData;
  layer.props.forEach((prop, i) => bindLayerMapper(layer, prop, i));
  layer.built = true;
  layer.pendingCells = undefined;
  layer.pointGlobalIds = built.pointGlobalIds;
  layer.cellEntityIds = built.cellEntityIds;
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
  eachProp(layer, (prop) => prop.actor.setVisibility(layerShouldDraw(layer)));
  renderWindow.render();
}

/** Live-updates a layer's opacity from the outline row's popover slider. */
function setLayerOpacity(layerId: string, opacity: number): void {
  const layer = layers.get(layerId);
  if (!layer) return;
  layer.opacity = opacity;
  eachLayerProperty(layer, (prop) => prop.setOpacity(opacity));
  renderWindow.render();
}

function frameLayer(layerId: string): void {
  const layer = layers.get(layerId);
  if (!layer) return;
  // Bounds are camera-free, so any pane's actor gives the same answer; the
  // focused one is used for symmetry with the camera it is about to move.
  const bounds = focusedProp(layer)?.actor.getBounds();
  if (bounds && bounds[0] <= bounds[1]) {
    focusedRenderer().resetCamera(bounds);
    renderWindow.render();
    if (showNodeIds) requestLabelUpdate();
  }
}

function resetCamera(): void {
  focusedRenderer().resetCamera();
  renderWindow.render();
  if (showNodeIds) requestLabelUpdate();
}

// --- Parallel projection --------------------------------------------------
function toggleParallelProjection(): void {
  parallelProjection = !parallelProjection;
  focusedRenderer().getActiveCamera().setParallelProjection(parallelProjection);
  // The nav card's Appearance button: mode-on treatment + a flipping label
  // (Persp ⇄ Ortho, the reference idiom — the label names the CURRENT mode).
  const btn = document.getElementById("nav-ortho");
  if (btn) {
    btn.classList.toggle("active", parallelProjection);
    btn.textContent = parallelProjection ? "Ortho" : "Persp";
  }
  renderWindow.render();
}

// --- Lighting --------------------------------------------------------------
// Applied globally: every current actor immediately, plus every future one
// (addLayer/registerPaneOverlay/registerGlobalOverlay call applyLightingToProp
// on creation) so a mid-session change doesn't only affect what's on screen
// right now. The cut cap is deliberately exempt — it hard-codes its own ambient/diffuse for a
// soft-shaded section vs. flat edges (see buildCutCap), which a global
// specular/ambient/diffuse override would silently undo.
function applyLightingToProp(prop: any): void {
  prop.setSpecular(lightingState.specular);
  prop.setAmbient(lightingState.ambient);
  prop.setDiffuse(lightingState.diffuse);
  prop.setBackfaceCulling(lightingState.cullBackFace);
}

function applyLightingToAllLayers(): void {
  for (const layer of layers.values()) {
    eachLayerProperty(layer, applyLightingToProp);
  }
  for (const pane of panes) {
    for (const [id, actor] of pane.overlays) {
      if (CUT_CAP_LAYER_IDS.includes(id)) continue;
      applyLightingToProp(actor.getProperty());
    }
  }
  renderWindow.render();
}

function toggleLightingPanel(): void {
  if (lightingVisible) hideLightingPanel();
  else showLightingPanel();
}

function showLightingPanel(): void {
  lightingVisible = true;
  lightingPanelEl.style.display = "";
  renderLightingUI();
}

function hideLightingPanel(): void {
  lightingVisible = false;
  lightingPanelEl.style.display = "none";
}

function renderLightingUI(): void {
  renderLightingPanel(lightingPanelEl, lightingState, {
    onClose: () => hideLightingPanel(),
    onChange: (next) => {
      lightingState = next;
      applyLightingToAllLayers();
      renderLightingUI();
    },
    onReset: () => {
      lightingState = { ...DEFAULT_LIGHTING_STATE };
      applyLightingToAllLayers();
      renderLightingUI();
    },
  });
}

// --- Camera bookmarks --------------------------------------------------------
function captureCameraState(): CameraState {
  // A bookmark is a viewpoint, not a layout: it captures and restores the
  // FOCUSED pane's camera and says nothing about how many panes there are.
  const camera = focusedRenderer().getActiveCamera();
  return {
    position: camera.getPosition(),
    focalPoint: camera.getFocalPoint(),
    viewUp: camera.getViewUp(),
    parallelScale: camera.getParallelScale(),
  };
}

function applyCameraState(state: CameraState): void {
  const target = focusedRenderer();
  const camera = target.getActiveCamera();
  camera.setPosition(state.position[0], state.position[1], state.position[2]);
  camera.setFocalPoint(state.focalPoint[0], state.focalPoint[1], state.focalPoint[2]);
  camera.setViewUp(state.viewUp[0], state.viewUp[1], state.viewUp[2]);
  camera.setParallelScale(state.parallelScale);
  target.resetCameraClippingRange();
  renderWindow.render();
  if (showNodeIds) requestLabelUpdate();
}

function toggleBookmarksPanel(): void {
  if (bookmarksVisible) hideBookmarksPanel();
  else showBookmarksPanel();
}

function showBookmarksPanel(): void {
  bookmarksVisible = true;
  bookmarksPanelEl.style.display = "";
  renderBookmarksUI();
}

function hideBookmarksPanel(): void {
  bookmarksVisible = false;
  bookmarksPanelEl.style.display = "none";
}

function renderBookmarksUI(): void {
  const state: BookmarksPanelState = { bookmarks, current: captureCameraState() };
  renderBookmarksPanel(bookmarksPanelEl, state, {
    onClose: () => hideBookmarksPanel(),
    onSave: (name) => {
      const captured = captureCameraState();
      bookmarks = [...bookmarks.filter((b) => b.name !== name), { name, state: captured }];
      renderBookmarksUI();
    },
    onRestore: (name) => {
      const bm = bookmarks.find((b) => b.name === name);
      if (bm) applyCameraState(bm.state);
    },
    onDelete: (name) => {
      bookmarks = bookmarks.filter((b) => b.name !== name);
      renderBookmarksUI();
    },
    onApplyJson: (parsed) => {
      applyCameraState(parsed);
      renderBookmarksUI();
    },
  });
}

// --- Standard views (keyboard shortcuts 1–6, i) ---------------------------
// Reuses the orientation cube's own snap logic (viewUp flip near-vertical) so
// clicking a cube face and pressing a shortcut land on identical views.
const STANDARD_VIEW_NORMALS: Record<string, [number, number, number]> = {
  "1": [1, 0, 0], // +X (RIGHT)
  "2": [-1, 0, 0], // -X (LEFT)
  "3": [0, 1, 0], // +Y (TOP)
  "4": [0, -1, 0], // -Y (BOTTOM)
  "5": [0, 0, 1], // +Z (FRONT)
  "6": [0, 0, -1], // -Z (BACK)
  i: [1, 1, 1], // isometric-style corner view
};

document.addEventListener("keydown", (e) => {
  // Never hijack typing in an input/textarea/select or a modified keystroke.
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const normal = STANDARD_VIEW_NORMALS[e.key];
  if (!normal || !model) return;
  e.preventDefault();
  snapCamera(focusedRenderer(), renderWindow, normal);
});

function applyTheme(name: string): void {
  currentTheme = name;

  const bg = getThemeBackground(name) ?? readThemeBackground();
  eachPane((p) => p.renderer.setBackground(bg[0], bg[1], bg[2]));

  const palette = getThemePalette(name);
  for (const [id, layer] of layers) {
    if (id === QUALITY_HIGHLIGHT_ID || id === FIND_HIGHLIGHT_ID) continue;
    if (layer.paletteIndex < 0) continue;
    const color = palette[layer.paletteIndex % palette.length];
    layer.color = color;
    eachLayerProperty(layer, (prop) => {
      prop.setColor(color[0], color[1], color[2]);
      prop.setEdgeColor(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5);
    });
    const swatch = document.querySelector<HTMLElement>(
      `.outline-swatch[data-layer-id="${CSS.escape(id)}"]`
    );
    if (swatch) {
      swatch.style.background =
        `rgb(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)})`;
    }
  }

  eachPane((p) => {
    p.grid.updateTheme(name);
    p.scalarBar.updateTheme(name);
  });
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
    // Keep highlights solid; wireframe on the fan triangulation looks wrong.
    // (The cut cap is a per-pane overlay, so it is not in `layers` at all.)
    if (id === FIND_HIGHLIGHT_ID) continue;
    eachLayerProperty(layer, (prop) => prop.setRepresentation(on ? 1 : 2));
  }
  // A pane showing a field overlay stays dimmed regardless of the global mode.
  panes.forEach((pane, i) => {
    if (!pane.dimmed) return;
    for (const [id, layer] of layers) {
      if (isOverlayLayer(id)) continue;
      layer.props[i]?.actor.getProperty().setRepresentation(1);
    }
  });
  // Sync the nav card's Display segments (selected-1-of-N).
  document.getElementById("nav-display-shaded")?.classList.toggle("active", !on);
  document.getElementById("nav-display-wire")?.classList.toggle("active", on);
  renderWindow.render();
}

// --- Cut plane ----------------------------------------------------------
//
// Per pane: the plane, its state and the cap all belong to Pane, and the DOM
// controls below are a VIEW of the focused pane's state (syncClipUI pushes it
// back into them when the focus moves). Clipping planes live on the mapper,
// which is why every layer carries a mapper per pane — see PaneProp.

// May be absent from a provider's HTML — never assume (a missing element here
// once killed the whole webview at module scope).
const cutPanel = document.getElementById("cut-panel") as HTMLElement | null;
const cutSlider = document.getElementById("cut-slider") as HTMLInputElement | null;
const cutPositionEl = document.getElementById("cut-position") as HTMLElement | null;
const cutFreeInputsEl = document.getElementById("cut-free-inputs") as HTMLElement | null;
const cutNormalXEl = document.getElementById("cut-normal-x") as HTMLInputElement | null;
const cutNormalYEl = document.getElementById("cut-normal-y") as HTMLInputElement | null;
const cutNormalZEl = document.getElementById("cut-normal-z") as HTMLInputElement | null;

/** The 8 corners of an axis-aligned bounding box, for projecting onto an oblique normal. */
function bboxCorners(b: {
  min: [number, number, number];
  max: [number, number, number];
}): [number, number, number][] {
  const { min, max } = b;
  return [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ];
}

/**
 * Recomputes one pane's clip plane from its own state.
 *
 * The readout is a view of the FOCUSED pane, so it is only written when this
 * pane is the focused one — otherwise seeding four panes would leave the label
 * describing whichever was updated last.
 */
function updateClipPlane(pane: Pane): void {
  if (!model) return;
  const b = model.bounds;
  const t = pane.clip.t;
  const showReadout = pane === focusedPane();
  const fn = pane.clip.freeNormal;

  if (pane.clip.axis === "free") {
    const len = Math.hypot(fn[0], fn[1], fn[2]);
    let normal: [number, number, number] =
      len > 1e-9 ? [fn[0] / len, fn[1] / len, fn[2] / len] : [0, 0, 1];
    if (pane.clip.flipped) normal = [-normal[0], -normal[1], -normal[2]];
    let min = Infinity;
    let max = -Infinity;
    for (const c of bboxCorners(b)) {
      const d = c[0] * normal[0] + c[1] * normal[1] + c[2] * normal[2];
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const dist = min + t * (max - min);
    // Any point P with dot(P, normal) = dist lies on the plane; normal*dist is
    // the simplest such point since normal is unit length.
    const origin: [number, number, number] = [normal[0] * dist, normal[1] * dist, normal[2] * dist];
    pane.clipPlane.setNormal(normal);
    pane.clipPlane.setOrigin(origin);
    if (cutPositionEl && showReadout) {
      const n = normal.map((v) => v.toFixed(2)).join(", ");
      cutPositionEl.textContent = `n=(${n})  d=${dist.toPrecision(4)}`;
    }
    return;
  }

  const axis = pane.clip.axis;
  const normals: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const n = normals[axis];
  const normal: [number, number, number] = pane.clip.flipped
    ? [-n[0], -n[1], -n[2]]
    : [n[0], n[1], n[2]];
  const min = b.min[axis];
  const max = b.max[axis];
  const pos = min + t * (max - min);
  const origin: [number, number, number] = [0, 0, 0];
  origin[axis] = pos;
  pane.clipPlane.setNormal(normal);
  pane.clipPlane.setOrigin(origin);
  if (cutPositionEl && showReadout) {
    cutPositionEl.textContent = `${"XYZ"[axis]} = ${pos.toPrecision(4)}`;
  }
}

/** Points one pane's mappers at (or away from) that pane's clipping plane. */
function applyClipToPane(pane: Pane): void {
  const i = panes.indexOf(pane);
  if (i < 0) return;
  for (const layer of layers.values()) {
    const mapper = layer.props[i]?.mapper;
    if (!mapper) continue;
    mapper.removeAllClippingPlanes();
    if (pane.clip.active) mapper.addClippingPlane(pane.clipPlane);
  }
  for (const [id, actor] of pane.overlays) {
    // The cap sits exactly ON the plane; clipping its mapper would erase it.
    if (CUT_CAP_LAYER_IDS.includes(id)) continue;
    const mapper = actor.getMapper();
    if (!mapper) continue;
    mapper.removeAllClippingPlanes();
    if (pane.clip.active) mapper.addClippingPlane(pane.clipPlane);
  }
}

// --- Cut cap: true cross-section of the volume elements ------------------
//
// The rendered polydata is only the outer boundary skin (meshBuilder keeps
// faces owned by exactly one cell), so GPU clipping alone leaves a hollow
// shell. The cap is computed from the original volume cells instead —
// one convex polygon per sectioned element (src/parser/planeCut.ts) — and
// rendered as two actors: the filled section and its element edges.

function buildCutCap(pane: Pane): void {
  for (const id of CUT_CAP_LAYER_IDS) removePaneOverlay(pane, id);
  if (!pane.clip.active || !model) return;

  // Computed over the model's volume cells, not the rendered layers, so the
  // section shows even while the volume blocks themselves are hidden
  // (the default — only the boundary skin is visible).
  const cut = computePlaneCut(
    model,
    pane.clipPlane.getOrigin() as [number, number, number],
    pane.clipPlane.getNormal() as [number, number, number]
  );
  if (cut.polyCount === 0) return;

  // Filled section. Colored by the active contour field when one is shown so
  // Clip and Field combine; otherwise neutral gray.
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
  const info = selectedFieldInfo(pane);
  if (
    fieldVisible &&
    pane.field.modes.has("contour") &&
    info &&
    attachCutCapScalars(capPd, cut, info, currentComponent(pane))
  ) {
    configureScalarMapper(capMapper, info, currentScalarStyle(pane, info));
  } else {
    capMapper.setScalarVisibility(false);
    prop.setColor(CUT_CAP_COLOR[0], CUT_CAP_COLOR[1], CUT_CAP_COLOR[2]);
  }
  prop.setEdgeVisibility(false);
  prop.setAmbient(0.3);
  prop.setDiffuse(0.7);
  registerPaneOverlay(pane, CUT_CAP_ID, capActor);

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
  registerPaneOverlay(pane, CUT_CAP_EDGE_ID, edgeActor);
}

function setCut(on: boolean): void {
  const pane = focusedPane();
  pane.clip.active = on;
  syncClipToggleUI(pane);
  if (on) updateClipPlane(pane);
  applyClipToPane(pane);
  buildCutCap(pane);
  renderWindow.render();
}

/** The Off/On toggle + Flip button, as a view of one pane's clip state. */
function syncClipToggleUI(pane: Pane): void {
  const toggle = document.getElementById("cut-toggle");
  if (toggle) {
    // The nav-card Clip group stays visible either way (like the reference);
    // its Off/On toggle carries the state with the mode-on treatment.
    toggle.textContent = pane.clip.active ? "On" : "Off";
    toggle.classList.toggle("active", pane.clip.active);
  }
  document.getElementById("cut-flip")?.classList.toggle("active", pane.clip.flipped);
}

/**
 * Pushes the focused pane's clip state into the DOM controls.
 *
 * The controls are a view; `Pane.clip` is the storage. Called whenever the
 * focus moves between panes, so the slider, the axis radios and the Off/On
 * toggle describe the pane they will actually act on.
 */
function syncClipUI(): void {
  const pane = focusedPane();
  if (cutSlider) cutSlider.value = String(pane.clip.t * 100);
  const axisValue = pane.clip.axis === "free" ? "free" : String(pane.clip.axis);
  document.querySelectorAll('input[name="cut-axis"]').forEach((radio) => {
    const el = radio as HTMLInputElement;
    el.checked = el.value === axisValue;
  });
  cutFreeInputsEl?.classList.toggle("hidden", pane.clip.axis !== "free");
  [cutNormalXEl, cutNormalYEl, cutNormalZEl].forEach((input, axis) => {
    if (input) input.value = String(pane.clip.freeNormal[axis]);
  });
  syncClipToggleUI(pane);
  updateClipPlane(pane); // refreshes the position readout for this pane
}

// While scrubbing, the GPU clip updates every tick for free; the cap rebuild
// walks all volume cells, so it is debounced to animation frames.
let cutFrame: number | undefined;
function scheduleCutCapRebuild(pane: Pane): void {
  if (cutFrame !== undefined) return;
  cutFrame = requestAnimationFrame(() => {
    cutFrame = undefined;
    buildCutCap(pane);
    renderWindow.render();
  });
}

cutSlider?.addEventListener("input", () => {
  const pane = focusedPane();
  pane.clip.t = Number(cutSlider.value) / 100;
  updateClipPlane(pane);
  renderWindow.render();
  scheduleCutCapRebuild(pane);
});

document.querySelectorAll('input[name="cut-axis"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const pane = focusedPane();
    const value = (radio as HTMLInputElement).value;
    pane.clip.axis = value === "free" ? "free" : (Number(value) as ClipAxis);
    cutFreeInputsEl?.classList.toggle("hidden", pane.clip.axis !== "free");
    updateClipPlane(pane);
    buildCutCap(pane);
    renderWindow.render();
  });
});

document.getElementById("cut-flip")?.addEventListener("click", function () {
  const pane = focusedPane();
  pane.clip.flipped = !pane.clip.flipped;
  this.classList.toggle("active", pane.clip.flipped);
  updateClipPlane(pane);
  buildCutCap(pane);
  renderWindow.render();
});

[cutNormalXEl, cutNormalYEl, cutNormalZEl].forEach((input, axis) => {
  input?.addEventListener("input", () => {
    const pane = focusedPane();
    const v = Number(input.value);
    pane.clip.freeNormal = [...pane.clip.freeNormal] as [number, number, number];
    pane.clip.freeNormal[axis] = Number.isFinite(v) ? v : 0;
    if (pane.clip.axis === "free") {
      updateClipPlane(pane);
      scheduleCutCapRebuild(pane);
      renderWindow.render();
    }
  });
});

// --- Nav-card view-control groups: Clip / Appearance / Display -----------
// The reference view-controls bar hosts these three groups after
// Rotate/Pan/Zoom/View. Clip is the provider-rendered #cut-panel element
// reparented whole (its id-based wiring above survives the move); Appearance
// adopts the scene-theme picker from the menubar plus a global model-opacity
// slider and the Persp/Ortho flip; Display maps the global wireframe state
// onto Shaded/Wire segments.
if (cutPanel) {
  cutPanel.classList.remove("hidden");
  navControls.addGroup("Clip", cutPanel);
}
document.getElementById("cut-toggle")?.addEventListener("click", () =>
  setCut(!focusedPane().clip.active)
);

/** Live opacity for every base mesh layer (blocks + SubModelParts); overlays
    and highlights keep their own values. Round-trips with the outline rows'
    per-layer opacity popovers via the same setLayerOpacity. */
function setGlobalOpacity(v: number): void {
  for (const id of layers.keys()) {
    if (id.startsWith("block:") || id.startsWith("smp:")) setLayerOpacity(id, v);
  }
}

{
  const content = document.createElement("div");
  content.className = "nav-appearance";
  const themeSel = document.getElementById("theme-select");
  if (themeSel) content.appendChild(themeSel); // reparent from the menubar
  const row = document.createElement("div");
  row.className = "nav-row";
  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "100";
  opacity.value = "100";
  opacity.id = "nav-opacity";
  opacity.title = "Model opacity (all mesh layers)";
  opacity.addEventListener("input", () => setGlobalOpacity(Number(opacity.value) / 100));
  const ortho = document.createElement("button");
  ortho.type = "button";
  ortho.id = "nav-ortho";
  ortho.className = "nav-btn nav-step-btn";
  ortho.title = "Toggle orthographic (parallel) vs. perspective projection";
  ortho.textContent = "Persp";
  ortho.addEventListener("click", () => toggleParallelProjection());
  row.appendChild(opacity);
  row.appendChild(ortho);
  content.appendChild(row);
  navControls.addGroup("Appearance", content);
}

{
  const row = document.createElement("div");
  row.className = "nav-row";
  const seg = (id: string, label: string, title: string, on: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "nav-btn nav-step-btn";
    b.title = title;
    b.textContent = label;
    b.addEventListener("click", on);
    return b;
  };
  const shaded = seg("nav-display-shaded", "Shaded", "Shaded surfaces", () => setWireframe(false));
  shaded.classList.add("active");
  row.appendChild(shaded);
  row.appendChild(seg("nav-display-wire", "Wire", "Wireframe", () => setWireframe(true)));
  navControls.addGroup("Display", row);
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
  const btn = document.querySelector('[data-action="nodeIds"]');
  btn?.classList.toggle("active", on);
  labelsEl.textContent = "";
  if (on && paneLayout !== "1x1") {
    // Labels are projected through ONE camera into one overlay div, so in a
    // split they would land over the wrong panes. Refuse and say so, the way
    // the node-count limit below already does, rather than draw them wrong.
    messageEl.textContent = "Node IDs are shown in the single-pane layout only.";
    return;
  }
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
    const disp = apiRW.worldToDisplay(x, y, z, focusedRenderer());
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
  const isolatedCount = findIsolatedNodeIds(model).length;
  if (isolatedCount > 0) {
    rows.push(
      `<div class="stat-row warn"><span class="stat-key">Isolated nodes</span><span>${isolatedCount}</span></div>`
    );
  }
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
initOpQueue();
initProblemtype((msg) => vscode.postMessage(msg));

// --- Embedded Flowgraph editor pane -------------------------------------
const flowgraphOrientation =
  document.body.dataset.flowgraphOrientation === "vertical"
    ? "vertical"
    : "horizontal";
initFlowgraphPane((msg) => vscode.postMessage(msg), flowgraphOrientation);

// --- Toolbar ------------------------------------------------------------
// --- View + Advanced toolbar menus --------------------------------------
// Dropdowns for display toggles (View) and not-everyday operations (Advanced),
// so the toolbar does not grow a button per feature. Items carry the same
// `data-action` a toolbar button would, and are dispatched through the same
// handler. Checkable items (`role="menuitemcheckbox"`) keep their menu open —
// the reference behavior — while one-shot items close it; opening one menu
// closes the other.
const advancedPopupEl = document.getElementById("advanced-popup");
const viewPopupEl = document.getElementById("view-popup");

function setAdvancedMenu(open: boolean): void {
  if (open) setViewMenu(false);
  advancedPopupEl?.classList.toggle("hidden", !open);
  document
    .querySelector('#toolbar button[data-action="advanced"]')
    ?.setAttribute("aria-expanded", String(open));
}

function toggleAdvancedMenu(): void {
  setAdvancedMenu(advancedPopupEl?.classList.contains("hidden") ?? false);
}

function setViewMenu(open: boolean): void {
  if (open) setAdvancedMenu(false);
  viewPopupEl?.classList.toggle("hidden", !open);
  document
    .querySelector('#toolbar button[data-action="viewMenu"]')
    ?.setAttribute("aria-expanded", String(open));
}

function toggleViewMenu(): void {
  setViewMenu(viewPopupEl?.classList.contains("hidden") ?? false);
}

function wireMenuPopup(popup: HTMLElement | null, close: (open: false) => void): void {
  popup?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!item) return;
    if (item.getAttribute("role") !== "menuitemcheckbox") close(false);
    dispatchToolbarAction(item.dataset.action);
  });
}
wireMenuPopup(advancedPopupEl, setAdvancedMenu);
wireMenuPopup(viewPopupEl, setViewMenu);

// Dismiss on an outside click or Escape, like the File menu.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!advancedPopupEl?.contains(t) && !t.closest('#toolbar button[data-action="advanced"]')) {
    setAdvancedMenu(false);
  }
  if (!viewPopupEl?.contains(t) && !t.closest('#toolbar button[data-action="viewMenu"]')) {
    setViewMenu(false);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setAdvancedMenu(false);
    setViewMenu(false);
  }
});

document.getElementById("toolbar")?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  dispatchToolbarAction(target.dataset.action, target);
});

function dispatchToolbarAction(action: string | undefined, _target?: HTMLElement): void {
  if (action === "reset") resetCamera();
  else if (action === "pan") setPanMode(!panMode);
  else if (action === "cut") setCut(!focusedPane().clip.active);
  else if (action === "wireframe") setWireframe(!wireframe);
  else if (action === "nodeIds") setNodeIds(!showNodeIds);
  else if (action === "quality") toggleQualityPanel();
  else if (action === "meshSize") toggleMeshSizePanel();
  else if (action === "advanced") toggleAdvancedMenu();
  else if (action === "viewMenu") toggleViewMenu();
  else if (action === "spheres") toggleSpherePanel();
  else if (action === "beams") toggleBeamPanel();
  else if (action === "normals") toggleNormals();
  else if (action === "integrals") toggleIntegralPanel();
  else if (action === "dataTable") toggleDataTablePanel();
  else if (action === "record") toggleRecordPanel();
  else if (action?.startsWith("layout:")) {
    const id = action.slice("layout:".length);
    if (isPaneLayout(id)) setPaneLayout(id);
  }
  else if (action === "exportSkin") vscode.postMessage({ type: "menuExportSkin" });
  else if (action === "find") toggleFindBar();
  else if (action === "field") toggleFieldPanel();
  else if (action === "inspect") toggleInspectMode();
  else if (action === "parallelProjection") toggleParallelProjection();
  else if (action === "lighting") toggleLightingPanel();
  else if (action === "bookmarks") toggleBookmarksPanel();
  else if (action === "grid") {
    gridVisible = !gridVisible;
    eachPane((p) => p.grid.setVisible(gridVisible));
    document.querySelector('[data-action="grid"]')?.classList.toggle("active", gridVisible);
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
          const layer = layers.get(QUALITY_HIGHLIGHT_ID);
          if (layer) eachLayerProperty(layer, (prop) => prop.setRepresentation(1));
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
  document.querySelector('[data-action="meshSize"]')?.classList.add("active");
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
  syncPaneDimming();
  eachPane((p) => {
    if (p.clip.active) buildCutCap(p);
  });
  renderWindow.render();
  document.querySelector('[data-action="meshSize"]')?.classList.remove("active");
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
      // The polydata is built once; each pane gets its own mapper over it.
      registerGlobalOverlay(MESHSIZE_FIELD_ID, () => {
        const mapper = vtkMapper.newInstance();
        mapper.setInputData(built.polyData);
        configureScalarMapper(mapper, info, {
          colormap: meshSizeState.colormap,
          component: "mag",
          min: info.scalarMin,
          max: info.scalarMax,
        });
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        actor.getProperty().setEdgeVisibility(false);
        return actor;
      });
    }
  }
  syncPaneDimming();
  eachPane((p) => {
    if (p.clip.active) buildCutCap(p);
  });
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
  const layer = layers.get(id);
  if (wireframe && layer) eachLayerProperty(layer, (prop) => prop.setRepresentation(1));
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

  // Flat-coloured, so the colormap argument is inert — DEFAULT_COLORMAP rather
  // than any pane's, since these arrows are a global overlay.
  registerGlobalOverlay(NORMALS_LAYER_ID, () =>
    buildGlyphActor({ points, vectors, magnitudes }, scale, DEFAULT_COLORMAP, 1, 1, NORMALS_COLOR)
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
  // The native test above is RELATIVE: it finds faces wound against each other,
  // but says nothing about whether the surface is closed. That second question
  // needs meshio++, which is host-only, so ask for it and append the answer
  // when it arrives (see src/meshAnalysis.ts).
  normalsBaseMessage = messageEl.textContent;
  vscode.postMessage({ type: "meshAnalysis", kind: "watertight" });
  renderWindow.render();
}

/** The synchronous half of the normals line, before watertightness lands. */
let normalsBaseMessage = "";

/**
 * Appends the watertightness counts to the Face-normals line. Counts, not a
 * bare flag: three boundary edges is a pinhole, three thousand is a surface
 * that was never closed.
 */
function applyWatertightResult(msg: {
  summary?: string;
  message?: string;
  report?: { watertight: boolean };
}): void {
  // Only append while the overlay that asked is still up — a reply arriving
  // after the user toggled normals off must not overwrite the status line.
  if (!normalsVisible || !normalsBaseMessage) return;
  const tail = msg.summary ?? msg.message;
  if (!tail) return;
  messageEl.textContent = `${normalsBaseMessage} Surface: ${tail}.`;
}

// --- Field integrals -----------------------------------------------------
//
// The only analysis panel that cannot compute its own answer: dataIntegrate is
// a meshio++ call and the wasm is host-only, so this asks and waits.

let integralVisible = false;
let integralState: IntegralPanelState = {};

function toggleIntegralPanel(): void {
  if (integralVisible) hideIntegralPanel();
  else showIntegralPanel();
}

function showIntegralPanel(): void {
  if (!model) return;
  integralPanelEl.style.display = "";
  integralVisible = true;
  document.querySelector('[data-action="integrals"]')?.classList.add("active");
  requestIntegrals();
}

function hideIntegralPanel(): void {
  integralPanelEl.style.display = "none";
  integralVisible = false;
  document.querySelector('[data-action="integrals"]')?.classList.remove("active");
}

/** Ask the host, and show the pending state until it answers. */
function requestIntegrals(): void {
  integralState = {};
  renderIntegrals();
  vscode.postMessage({ type: "meshAnalysis", kind: "integrate" });
}

function renderIntegrals(): void {
  renderIntegralPanel(integralPanelEl, integralState, {
    onClose: hideIntegralPanel,
    onRefresh: requestIntegrals,
  });
}

function applyFieldIntegrals(msg: {
  integrals?: FieldIntegral[];
  message?: string;
}): void {
  // A reply that outlived its panel is dropped rather than stashed: the model
  // may have changed under it, and the panel re-asks on open anyway.
  if (!integralVisible) return;
  integralState = { integrals: msg.integrals, message: msg.message };
  renderIntegrals();
}

// --- Data table ----------------------------------------------------------
//
// The Inspect panel already shows this exact shape of data — coordinates or
// connectivity plus every field defined at the entity — but one row at a time,
// on click. This is the same thing for every row at once, plus the export.

function toggleDataTablePanel(): void {
  if (dataTableVisible) hideDataTablePanel();
  else showDataTablePanel();
}

function showDataTablePanel(): void {
  if (!model) return;
  dataTablePanelEl.style.display = "";
  dataTableVisible = true;
  document.querySelector('[data-action="dataTable"]')?.classList.add("active");
  renderDataTable();
  syncNavOffset();
}

function hideDataTablePanel(): void {
  dataTablePanelEl.style.display = "none";
  dataTableVisible = false;
  document.querySelector('[data-action="dataTable"]')?.classList.remove("active");
  dataTableState.selectedId = undefined;
  removeLayer(TABLE_MARKER_ID);
  renderWindow.render();
  syncNavOffset();
}

/**
 * Lift the nav card above whatever is docked to the bottom of the viewport.
 * The timeline bar needed this first, then the data table, and now the
 * time-series chart — without it the card is buried and its zoom/fit buttons
 * stop taking clicks at all. Taking the max is what lets several of them be
 * open at once.
 */
function syncNavOffset(): void {
  let offset = timelineVisible ? 44 : 8;
  if (dataTableVisible) offset = Math.max(offset, dataTablePanelEl.offsetHeight + 16);
  // The series panel sits 52px up (above the timeline bar), so its own height
  // is not the whole clearance.
  if (seriesVisible) offset = Math.max(offset, seriesPanelEl.offsetHeight + 60);
  navControls.setBottomOffset(offset);
}

/** Rebuild the view after anything that changes which rows or columns exist. */
function invalidateDataTable(): void {
  dataTableView = undefined;
  dataTableState.page = 0;
  if (dataTableVisible) renderDataTable();
}

function dataTableCounts(): Record<TableKind, number> {
  const counts = {} as Record<TableKind, number>;
  for (const kind of TABLE_KINDS) {
    counts[kind] = model ? tableRowCount(model, kind, dataTableState.opts) : 0;
  }
  return counts;
}

function renderDataTable(): void {
  if (model && !dataTableView) {
    dataTableView = prepareTable(
      model,
      dataTableState.kind,
      dataTableState.opts,
      dataTableState.opts.membership ? getMembershipIndex() : undefined
    );
  }
  const state: DataTablePanelState = {
    kind: dataTableState.kind,
    view: model ? dataTableView : undefined,
    opts: dataTableState.opts,
    counts: dataTableCounts(),
    page: dataTableState.page,
    focusRow: dataTableState.focusRow,
    selectedId: dataTableState.selectedId,
  };
  dataTableState.focusRow = undefined;
  renderDataTablePanel(dataTablePanelEl, state, {
    onClose: hideDataTablePanel,
    onKind: (kind) => {
      dataTableState.kind = kind;
      dataTableState.selectedId = undefined;
      removeLayer(TABLE_MARKER_ID);
      renderWindow.render();
      invalidateDataTable();
    },
    onOptions: (opts) => {
      dataTableState.opts = opts;
      invalidateDataTable();
    },
    onPage: (page) => {
      dataTableState.page = page;
      renderDataTable();
    },
    onGotoRow: (row) => {
      dataTableState.page = Math.floor(row / PAGE_ROWS);
      dataTableState.focusRow = row;
      renderDataTable();
    },
    onSelectRow: selectTableRow,
    onFrameSelection: frameTableSelection,
    onExport: (format) =>
      vscode.postMessage({
        type: "menuExportTable",
        format,
        kind: dataTableState.kind,
        opts: dataTableState.opts,
      }),
  });
}

/**
 * Frame the selected row's entity, then lift it into the visible half of the
 * canvas: the panel is docked over the lower half, so an entity framed dead
 * centre lands behind it. The shift reuses the vector arithmetic NavControls'
 * own pan does, sized from the camera's half-height rather than a pixel count
 * so it holds at any zoom and under parallel projection.
 */
function frameTableSelection(): void {
  frameLayer(TABLE_MARKER_ID);
  const target = focusedRenderer();
  const cam: any = target.getActiveCamera();
  const halfHeight = parallelProjection
    ? (cam.getParallelScale() as number)
    : (cam.getDistance() as number) * Math.tan(((cam.getViewAngle() as number) * Math.PI) / 360);
  const up = cam.getViewUp() as [number, number, number];
  const shift = halfHeight * 0.5;
  const pos = cam.getPosition() as [number, number, number];
  const focal = cam.getFocalPoint() as [number, number, number];
  cam.setPosition(pos[0] - up[0] * shift, pos[1] - up[1] * shift, pos[2] - up[2] * shift);
  cam.setFocalPoint(focal[0] - up[0] * shift, focal[1] - up[1] * shift, focal[2] - up[2] * shift);
  target.resetCameraClippingRange();
  renderWindow.render();
  if (showNodeIds) requestLabelUpdate();
}

/**
 * Clicking a row highlights the entity in the scene — the same two-line marker
 * the Inspect pick uses, so a number in the table can be located in the mesh
 * without leaving the panel. Zooming to it is the panel's Frame button, not
 * part of the click: scanning down a column would otherwise throw the camera
 * around once per row.
 */
function selectTableRow(kind: TableKind, id: number): void {
  dataTableState.selectedId = id;
  const cell: Cell | undefined =
    kind === "Nodes"
      ? { nodeIds: Int32Array.from([id]) }
      : kind === "Elements"
        ? elementById.get(id)
        : kind === "Conditions"
          ? conditionById.get(id)
          : geometryById.get(id);
  removeLayer(TABLE_MARKER_ID);
  if (cell) addLayer(TABLE_MARKER_ID, [cell], TABLE_MARKER_COLOR, true);
  renderWindow.render();
  renderDataTable();
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
  document.querySelector('[data-action="spheres"]')?.classList.add("active");
  renderSphereUI();
}

function hideSpherePanel(): void {
  spherePanelEl.style.display = "none";
  sphereVisible = false;
  sphereState.enabled = false;
  applySphereLayer();
  document.querySelector('[data-action="spheres"]')?.classList.remove("active");
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

// --- Beams / line elements -----------------------------------------------

function toggleBeamPanel(): void {
  if (beamVisible) hideBeamPanel();
  else showBeamPanel();
}

function showBeamPanel(): void {
  if (!model) return;
  beamPanelEl.style.display = "";
  beamVisible = true;
  document.querySelector('[data-action="beams"]')?.classList.add("active");
  renderBeamUI();
}

function hideBeamPanel(): void {
  beamPanelEl.style.display = "none";
  beamVisible = false;
  beamState.enabled = false;
  applyBeamLayer();
  document.querySelector('[data-action="beams"]')?.classList.remove("active");
}

/** What the panel needs to describe the mesh's line cells. */
function beamInfo(): BeamPanelInfo {
  return { ...beams(), suggested: suggestedBeamRadius() };
}

function renderBeamUI(): void {
  const info = beamInfo();
  const state: BeamPanelState = { ...beamState, constant: beamConstant() };
  const update = (patch: Partial<typeof beamState>): void => {
    Object.assign(beamState, patch);
    renderBeamUI();
    applyBeamLayer();
  };
  renderBeamPanel(beamPanelEl, info, state, {
    onClose: () => hideBeamPanel(),
    onToggle: () => update({ enabled: !beamState.enabled }),
    onThickness: (v) => update({ thickness: v }),
    onResolution: (v) => update({ resolution: v }),
    onConstant: (v) => update({ constant: v }),
    onIncludeConditions: () => update({ includeConditions: !beamState.includeConditions }),
    onColorBySection: () => update({ colorBySection: !beamState.colorBySection }),
    onColormap: (name) => update({ colormap: name }),
    onFrame: () => frameLayer(BEAM_LAYER_ID),
  });
}

/** Rebuilds (or removes) the glyph layer from the current state. */
function applySphereLayer(): void {
  removeLayer(SPHERE_LAYER_ID);
  if (sphereState.enabled && model && prepared) {
    // Deformed shape warps the anchors, exactly as it does for quiver. The
    // glyphs are a global overlay drawn identically in every pane, so they
    // follow the FOCUSED pane's warp — the same pane the panel edits — and,
    // as before this was per-pane, only pick it up when they are rebuilt.
    const warp = computeWarpedGeometry(focusedPane());
    const prep = warp?.prepared ?? prepared;
    const info = spheres();
    const data = buildSphereData(prep);
    if (data && data.points.length > 0) {
      registerGlobalOverlay(SPHERE_LAYER_ID, () =>
        buildSphereGlyphActor(
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
        )
      );
    }
  }
  syncSphereBaseHiding();
  renderWindow.render();
}

/**
 * Rebuilds the beam tube layer from the current state.
 *
 * Mirrors applySphereLayer, including the Deformed-shape warp: the segments are
 * built through `coordOf`, so the tubes follow a warped mesh exactly as the
 * sphere anchors do. There is no base-layer suppression — see BEAM_LAYER_ID.
 */
function applyBeamLayer(): void {
  removeLayer(BEAM_LAYER_ID);
  if (beamState.enabled && model && prepared) {
    // The focused pane's warp — see applySphereLayer.
    const warp = computeWarpedGeometry(focusedPane());
    const prep = warp?.prepared ?? prepared;
    const info = beams();
    const data = buildBeamSegments(model, {
      includeConditions: beamState.includeConditions,
      fallbackRadius: beamConstant(),
      coordOf: (nodeId) => coordOfPrep(prep, nodeId),
    });
    if (data.count > 0) {
      registerGlobalOverlay(BEAM_LAYER_ID, () =>
        buildBeamGlyphActor(
          data,
          beamState.thickness,
          beamState.resolution,
          BEAM_COLOR,
          beamState.colorBySection && info.withSection > 0
            ? {
                colormap: beamState.colormap,
                min: info.radiusMin,
                max: info.radiusMax > info.radiusMin ? info.radiusMax : info.radiusMin + 1e-12,
              }
            : undefined
        )
      );
    }
  }
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
 * Distinct from syncPaneDimming: those layers are not *dimmed under* an overlay,
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
    eachProp(layer, (prop) => prop.actor.setVisibility(layerShouldDraw(layer)));
  }
}

// --- Field visualization ------------------------------------------------
//
// Every function below takes the PANE it is working on: the field settings are
// per-pane, the panel edits the focused one, and a model rebuild has to run
// them for all of them (applyFieldModeAll).
function selectedFieldInfo(pane: Pane): FieldInfo | undefined {
  return fieldInfos.find((i) => i.key === pane.field.selectedKey);
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
function resetFieldStateForSelection(pane: Pane): void {
  const info = selectedFieldInfo(pane);
  if (!info) return;
  const fs = pane.field;
  fs.component = "mag";
  fs.rangeOverride = undefined; // the old override belonged to a different field's range
  fs.thresholdRange = undefined; // ditto — the window was scaled to the previous field's data
  const [min, max] = rangeForComponent(info, "mag");
  fs.isoValues = [(min + max) / 2];
  // Drop modes the newly-selected variable can't drive (quiver needs a vector,
  // iso needs a scalar). Contour + deformed are unaffected here.
  if (!info.isVector) fs.modes.delete("quiver");
  if (info.isVector) fs.modes.delete("iso");
  // Ensure at least one applicable mode is on so the panel isn't inert.
  if (fs.modes.size === 0) {
    fs.modes.add(info.isVector ? "quiver" : "contour");
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
  applyFieldModeAll();
}

function hideFieldPanel(): void {
  fieldPanelEl.style.display = "none";
  fieldVisible = false;
  // The panel is the switch for the whole feature, so closing it clears every
  // pane's overlays, not only the focused one's.
  eachPane((p) => {
    clearPaneFieldOverlays(p);
    p.scalarBar.setVisible(false);
    // Cap reverts to its neutral color once the field is gone.
    if (p.clip.active) buildCutCap(p);
  });
  syncPaneDimming();
  document.querySelector('#toolbar button[data-action="field"]')?.classList.remove("active");
  renderWindow.render();
}

function renderFieldPanelUI(): void {
  const pane = focusedPane();
  const fs = pane.field;
  const state: FieldPanelState = {
    infos: fieldInfos,
    selectedKey: fs.selectedKey,
    modes: fs.modes,
    colormap: fs.colormap,
    component: fs.component,
    rangeOverride: fs.rangeOverride,
    log: fs.log,
    bands: fs.bands,
    scalarBar: fs.scalarBar,
    isoValues: fs.isoValues,
    scale: fs.scale,
    deformKey: fs.deformKey,
    deformScale: fs.deformScale,
    hasVolume: modelHasVolume(),
    thresholdRange: fs.thresholdRange,
    thresholdRule: fs.thresholdRule,
    paneLabel: paneLabel(focusedPaneIndex(), panes.length),
  };
  // Every handler writes the FOCUSED pane's state and rebuilds only that pane.
  const rebuild = (): void => applyFieldMode(pane);
  renderFieldPanel(fieldPanelEl, state, {
    onClose: () => hideFieldPanel(),
    onSelectVariable: (key) => {
      fs.selectedKey = key;
      resetFieldStateForSelection(pane);
      renderFieldPanelUI();
      rebuild();
    },
    onToggleMode: (mode) => {
      if (fs.modes.has(mode)) fs.modes.delete(mode);
      else fs.modes.add(mode);
      renderFieldPanelUI();
      rebuild();
    },
    onSelectColormap: (name) => {
      fs.colormap = name;
      renderFieldPanelUI();
      rebuild();
    },
    onSelectComponent: (c) => {
      fs.component = c;
      // Both windows were scaled to the previous component's data range.
      fs.rangeOverride = undefined;
      fs.thresholdRange = undefined;
      renderFieldPanelUI();
      rebuild();
    },
    onRangeOverride: (range) => {
      fs.rangeOverride = range;
      renderFieldPanelUI();
      rebuild();
    },
    onLog: (v) => {
      fs.log = v;
      renderFieldPanelUI();
      rebuild();
    },
    onBands: (n) => {
      fs.bands = n;
      renderFieldPanelUI();
      rebuild();
    },
    onScalarBar: (v) => {
      fs.scalarBar = v;
      rebuild();
    },
    onIsoValues: (values) => {
      fs.isoValues = values;
      scheduleIsoRebuild();
    },
    onIsoCount: (count) => {
      const info = selectedFieldInfo(pane);
      if (!info) return;
      const [min, max] = effectiveScalarRange(pane, info);
      fs.isoValues = spacedIsoValues(min, max, count);
      renderFieldPanelUI();
      scheduleIsoRebuild();
    },
    onScale: (v) => {
      fs.scale = v;
      rebuild();
    },
    onSelectDeformField: (key) => {
      fs.deformKey = key;
      rebuild();
    },
    onDeformScale: (v) => {
      fs.deformScale = v;
      rebuild();
    },
    onThresholdRange: (range) => {
      fs.thresholdRange = range;
      renderFieldPanelUI();
      rebuild();
    },
    onThresholdRule: (rule) => {
      fs.thresholdRule = rule;
      rebuild();
    },
    onCopyToAllPanes: () => {
      for (const other of panes) {
        if (other === pane) continue;
        other.field = clonePaneFieldState(fs);
        applyFieldMode(other);
      }
      renderWindow.render();
    },
  });
}

// --- Per-pane overlays ----------------------------------------------------
//
// The field overlays and the cut cap are the only actors that differ per pane
// in GEOMETRY rather than merely in properties, so they live on the pane
// instead of in the global `layers` map: one actor, one renderer, no props
// array. That is also why the loops over `layers` elsewhere no longer have to
// skip them.

/** Adds a pre-built overlay actor to one pane only. */
function registerPaneOverlay(pane: Pane, id: string, actor: any): void {
  removePaneOverlay(pane, id);
  actor.setVisibility(true);
  // Overlay/replacement layers never carry the per-cell entity pick maps a base
  // block layer does — see Layer.pickKind — so they must not intercept clicks.
  actor.setPickable(false);
  applyLightingToProp(actor.getProperty());
  pane.renderer.addActor(actor);
  pane.overlays.set(id, actor);
  if (pane.clip.active && !CUT_CAP_LAYER_IDS.includes(id)) {
    // The cap sits exactly ON the plane; clipping its mapper would erase it.
    actor.getMapper()?.addClippingPlane(pane.clipPlane);
  }
}

function removePaneOverlay(pane: Pane, id: string): void {
  const actor = pane.overlays.get(id);
  if (!actor) return;
  pane.renderer.removeActor(actor);
  actor.delete();
  pane.overlays.delete(id);
}

/** Removes this pane's contour/quiver/iso/threshold actors (not the cut cap). */
function clearPaneFieldOverlays(pane: Pane): void {
  for (const id of [...pane.overlays.keys()].filter(isFieldLayerId)) {
    removePaneOverlay(pane, id);
  }
}

/** Removes everything this pane draws of its own. */
function clearPaneOverlays(pane: Pane): void {
  for (const id of [...pane.overlays.keys()]) removePaneOverlay(pane, id);
}

// Global overlay layers that must never be dimmed under a colour overlay, and
// never trigger the dimming themselves: they replace or annotate the base
// rendering rather than colouring it, and wireframe spheres and wireframe
// arrowheads are both unreadable. (The per-pane field and cut-cap actors are
// not in `layers` at all, so they need no entry here.)
function isOverlayLayer(id: string): boolean {
  return (
    MESHSIZE_LAYER_IDS.includes(id) ||
    id === SPHERE_LAYER_ID ||
    id === BEAM_LAYER_ID ||
    id === NORMALS_LAYER_ID ||
    id === NORMALS_BAD_ID
  );
}

/**
 * Base-dimming policy, per pane: a pane whose own field overlay is showing
 * draws its base layers as wireframe so the colour reads; a pane with no
 * overlay keeps them solid, even while a sibling pane has one.
 *
 * Mesh-size colouring is global (one panel, one layer in every pane), so it
 * correctly dims every pane.
 */
function paneWantsDim(pane: Pane): boolean {
  return (
    [...pane.overlays.keys()].some(isFieldLayerId) || layers.has(MESHSIZE_FIELD_ID)
  );
}

function syncPaneDimming(): void {
  const solid = wireframe ? 1 : 2;
  panes.forEach((pane, i) => {
    const dim = paneWantsDim(pane);
    if (dim === pane.dimmed) return;
    pane.dimmed = dim;
    for (const [id, layer] of layers) {
      if (isOverlayLayer(id)) continue;
      layer.props[i]?.actor.getProperty().setRepresentation(dim ? 1 : solid);
    }
  });
}

/**
 * Registers a GLOBAL overlay layer (mesh-size colouring, face normals, sphere
 * and beam glyphs): one actor per pane, built by the given factory.
 *
 * A factory rather than a finished actor because these are glyph layers whose
 * mapper carries the source and the scale arrays, and every pane needs its own
 * mapper to hold its own clipping plane. The factory is cheap by construction —
 * the heavy arrays are computed once by the caller and merely referenced, so
 * building one actor per pane copies nothing.
 */
function registerGlobalOverlay(id: string, make: () => any): void {
  removeLayer(id);
  const layer: Layer = {
    id,
    props: [],
    color: [1, 1, 1],
    paletteIndex: -1,
    visible: true,
    built: true,
    opacity: 1,
  };
  panes.forEach((pane) => {
    const actor = make();
    actor.setVisibility(true);
    // Overlay/replacement layers never carry the per-cell entity pick maps a
    // base block layer does — see Layer.pickKind — so they must not intercept
    // clicks.
    actor.setPickable(false);
    applyLightingToProp(actor.getProperty());
    const mapper = actor.getMapper();
    if (pane.clip.active) mapper?.addClippingPlane(pane.clipPlane);
    pane.renderer.addActor(actor);
    layer.props.push({ actor, mapper });
  });
  layers.set(id, layer);
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
function selectedDeformInfo(pane: Pane): FieldInfo | undefined {
  return fieldInfos.find((i) => i.key === pane.field.deformKey && i.isVector);
}

// When deformed shape is active, produce a warped copy of the geometry
// (coords += deformScale · displacement). Everything else (topology, fields) is
// shared by reference so all field layers render on the deformed geometry.
function computeWarpedGeometry(pane: Pane): { prepared: PreparedNodes; model: MdpaModel } | null {
  if (!pane.field.modes.has("deformed") || !prepared || !model) return null;
  const info = selectedDeformInfo(pane);
  if (!info) return null;
  const coords = new Float32Array(prepared.coords); // copy (never mutate the reference)
  const scale = pane.field.deformScale;
  for (let i = 0; i < model.nodeCount; i++) {
    const v = vectorAt(info, model.nodeIds[i]);
    if (!v) continue;
    coords[i * 3] += scale * v[0];
    coords[i * 3 + 1] += scale * v[1];
    coords[i * 3 + 2] += scale * v[2];
  }
  return { prepared: { index: prepared.index, coords }, model: { ...model, coords } };
}

// The scalar component that actually drives contour/iso coloring right now
// (quiver ignores this — see fieldPanel.ts's activeComponent doc comment).
function currentComponent(pane: Pane): FieldComponent {
  return activeComponent(pane.field);
}

// The effective [min,max] contour/iso/the legend/scalar-bar are stretched
// over: the user's override when set, else the selected component's data range.
function effectiveScalarRange(pane: Pane, info: FieldInfo): [number, number] {
  const dataRange = rangeForComponent(info, info.isVector ? currentComponent(pane) : "mag");
  return effectiveRange(dataRange, pane.field.rangeOverride);
}

function currentScalarStyle(pane: Pane, info: FieldInfo): ScalarStyle {
  const [min, max] = effectiveScalarRange(pane, info);
  return {
    colormap: pane.field.colormap,
    component: currentComponent(pane),
    min,
    max,
    log: pane.field.log,
    bands: pane.field.bands,
  };
}

// Shows/hides and (re)configures the in-scene scalar bar to match whatever
// contour/iso coloring (if any) is currently on screen.
function applyScalarBar(pane: Pane, info: FieldInfo | undefined): void {
  const fs = pane.field;
  const showing = fs.scalarBar && !!info && (fs.modes.has("contour") || fs.modes.has("iso"));
  pane.scalarBar.setVisible(showing);
  if (showing && info) {
    const style = currentScalarStyle(pane, info);
    const stops = transformStops(getColormap(style.colormap).stops, {
      log: style.log,
      bands: style.bands,
      min: style.min,
      max: style.max,
    });
    const ctf = makeCtfFromStops(stops, style.min, style.max);
    pane.scalarBar.configure(ctf, info.field.variable);
  }
}

// The legend to burn into a screenshot (Phase 1.7), when a color overlay is
// active but the in-scene scalar bar (which already appears in the WebGL
// capture) is off. Field coloring takes priority over mesh-size coloring —
// both are never shown at once in the UI anyway.
//
// Split view: panes can colour by different fields, and compositeLegend draws
// ONE legend at a fixed corner of the whole capture — which would be a legend
// claiming to describe four panes it does not. So this is a single-pane
// affordance; in a split, the per-pane in-scene scalar bar is the route, and
// it is already inside the WebGL capture.
function activeLegendSpec(): LegendSpec | undefined {
  if (paneLayout !== "1x1") return undefined;
  const pane = focusedPane();
  if (fieldVisible && !pane.field.scalarBar) {
    const info = selectedFieldInfo(pane);
    if (info && (pane.field.modes.has("contour") || pane.field.modes.has("iso"))) {
      const style = currentScalarStyle(pane, info);
      const stops = transformStops(getColormap(style.colormap).stops, {
        log: style.log,
        bands: style.bands,
        min: style.min,
        max: style.max,
      });
      return { stops, min: style.min, max: style.max, log: style.log, title: info.field.variable };
    }
  }
  if (meshSizeVisible && meshSizeState.color !== "none" && meshSizeReport) {
    const field = meshSizeState.color === "nodal" ? meshSizeReport.nodalH : meshSizeReport.elementSize;
    const info = buildFieldInfo(field);
    return {
      stops: getColormap(meshSizeState.colormap).stops,
      min: info.scalarMin,
      max: info.scalarMax,
      title: field.variable,
    };
  }
  return undefined;
}

/** Rebuilds every pane's field overlays — a model change, not a panel edit. */
function applyFieldModeAll(): void {
  eachPane((p) => applyFieldMode(p));
}

// Rebuilds one pane's active field overlays. Modes are combinable: deformed
// shape is a per-pane warp so that pane's contour/quiver/iso all render on the
// deformed geometry; deformed + contour share one warped, colored surface.
function applyFieldMode(pane: Pane): void {
  clearPaneFieldOverlays(pane);
  const fs = pane.field;
  const info = selectedFieldInfo(pane);
  const deformed = fs.modes.has("deformed");
  if ((!info && !deformed) || !prepared || !model) {
    syncPaneDimming();
    pane.scalarBar.setVisible(false);
    renderWindow.render();
    return;
  }
  const warp = computeWarpedGeometry(pane);
  const prep = warp?.prepared ?? prepared;
  const useModel = warp?.model ?? model;

  // Surface layer: shown when contour and/or deformed are active. Colored by
  // the field when contour is on, neutral solid otherwise (pure deformed shape).
  // Threshold takes over this job when active — it draws the same surface
  // restricted to the passing cells, so the full-mesh version is skipped
  // rather than drawn underneath it (same geometry, would just z-fight).
  const wantContour = !!info && fs.modes.has("contour");
  const wantThreshold = !!info && fs.modes.has("threshold");
  if ((wantContour || deformed) && !wantThreshold) buildSurfaceLayer(pane, info, prep, wantContour);
  if (info?.isVector && fs.modes.has("quiver")) buildQuiverLayer(pane, info, prep);
  if (info && !info.isVector && fs.modes.has("iso")) buildIsoLayer(pane, info, useModel);
  if (info && wantThreshold) buildThresholdLayer(pane, info, prep, wantContour);

  syncPaneDimming();
  applyScalarBar(pane, info);
  // Re-color the cut cap to match the (possibly changed) field/colormap.
  if (pane.clip.active) buildCutCap(pane);
  renderWindow.render();
}

// The (optionally warped, optionally colored) mesh surface. Deformed shape and
// contour share this single FIELD_CONTOUR_ID layer.
function buildSurfaceLayer(
  pane: Pane,
  info: FieldInfo | undefined,
  prep: PreparedNodes,
  colored: boolean
): void {
  const kinds: EntityKind[] | "all" =
    colored && info
      ? info.field.kind === "Elemental"
        ? ["Elements"]
        : info.field.kind === "Conditional"
        ? ["Conditions"]
        : "all"
      : "all";
  const cells = collectCells(kinds);
  const built = buildPolyData(
    prep,
    cells,
    colored && info ? contourAttach(info, currentComponent(pane)) : undefined
  );
  if (!built) return;
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(built.polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setEdgeVisibility(false);
  if (colored && info) {
    configureScalarMapper(mapper, info, currentScalarStyle(pane, info));
  } else {
    // Neutral deformed-shape surface (no field coloring).
    prop.setColor(0.8, 0.82, 0.88);
  }
  registerPaneOverlay(pane, FIELD_CONTOUR_ID, actor);
}

function buildQuiverLayer(pane: Pane, info: FieldInfo, prep: PreparedNodes): void {
  const data = buildQuiverData(info, prep);
  if (!data || data.points.length === 0) return;
  const scaleFactor = quiverBaseScale(info) * pane.field.scale;
  const actor = buildGlyphActor(
    data,
    scaleFactor,
    pane.field.colormap,
    info.scalarMin,
    info.scalarMax
  );
  registerPaneOverlay(pane, FIELD_QUIVER_ID, actor);
}

function buildIsoLayer(pane: Pane, info: FieldInfo, srcModel: MdpaModel): void {
  const [rangeMin, rangeMax] = effectiveScalarRange(pane, info);
  const span = rangeMax - rangeMin;
  const values = pane.field.isoValues.length
    ? pane.field.isoValues
    : [(rangeMin + rangeMax) / 2];
  values.forEach((isoValue, idx) => {
    const result = computeIsoSurface(srcModel, info.field, isoValue);
    if (result.points.length === 0) return;
    const pd = buildIsoPolyData(result);
    const mapper = vtkMapper.newInstance();
    mapper.setInputData(pd);
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    const t = span > 0 ? (isoValue - rangeMin) / span : 0.5;
    const c = colorAt(pane.field.colormap, t);
    const prop = actor.getProperty();
    prop.setColor(c[0], c[1], c[2]);
    prop.setEdgeVisibility(false);
    if (result.is2D) prop.setLineWidth(2);
    registerPaneOverlay(pane, `${FIELD_ISO_PREFIX}${idx}`, actor);
  });
}

// The mesh surface restricted to cells passing the threshold window — see
// applyFieldMode's comment for why this replaces (rather than layers under)
// the ordinary contour/deformed surface while threshold is active.
function buildThresholdLayer(
  pane: Pane,
  info: FieldInfo,
  prep: PreparedNodes,
  colored: boolean
): void {
  if (!model) return;
  const dataRange = rangeForComponent(info, info.isVector ? currentComponent(pane) : "mag");
  const [lo, hi] = pane.field.thresholdRange ?? dataRange;
  const { elementIds, conditionIds } = thresholdCells(
    model,
    info.field,
    currentComponent(pane),
    [lo, hi],
    pane.field.thresholdRule
  );
  const cells: Cell[] = [];
  for (const id of elementIds) {
    const c = elementById.get(id);
    if (c) cells.push(c);
  }
  for (const id of conditionIds) {
    const c = conditionById.get(id);
    if (c) cells.push(c);
  }
  if (cells.length === 0) return;
  const built = buildPolyData(
    prep,
    cells,
    colored ? contourAttach(info, currentComponent(pane)) : undefined
  );
  if (!built) return;
  const mapper = vtkMapper.newInstance();
  mapper.setInputData(built.polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setEdgeVisibility(false);
  if (colored) {
    configureScalarMapper(mapper, info, currentScalarStyle(pane, info));
  } else {
    prop.setColor(0.8, 0.82, 0.88); // same neutral as the uncolored deformed surface
  }
  registerPaneOverlay(pane, FIELD_THRESHOLD_ID, actor);
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

// Debounced isosurface rebuild for slider drags — the focused pane's, since
// the slider that drives it belongs to that pane's panel.
let isoFrame: number | undefined;
function scheduleIsoRebuild(): void {
  if (isoFrame !== undefined) return;
  const pane = focusedPane();
  isoFrame = requestAnimationFrame(() => {
    isoFrame = undefined;
    applyFieldMode(pane);
  });
}

// --- Inspect / click-to-probe --------------------------------------------
// Click a node/element/condition on the mesh (Inspect toolbar toggle) to see
// its id, block, SubModelPart membership and every field value defined at it
// — src/parser/pickResolve.ts resolves a vtkCellPicker hit against the pick
// maps meshBuilder.ts attaches to each pickable base block layer (only those
// are pickable — see Layer.pickKind, registerPaneOverlay/registerGlobalOverlay's
// setPickable(false)). Also hosts a two-click distance Measure mode.

function getMembershipIndex(): MembershipIndex {
  if (!membershipIndex) membershipIndex = buildMembershipIndex(model?.subModelParts ?? []);
  return membershipIndex;
}

/**
 * The layer a picked mapper belongs to.
 *
 * Every pane has its own mapper over the layer's shared polydata, so the hit
 * can come from any of them — a pick in pane 3 resolves against pane 3's
 * mapper and must still find the layer.
 */
function findLayerByMapper(mapper: any): Layer | undefined {
  for (const layer of layers.values()) {
    if (layer.props.some((prop) => prop.mapper === mapper)) return layer;
  }
  return undefined;
}

// Which FieldData kind a picked block's entity ids can carry values under.
// Geometries carry none (FieldBlockKind is Nodal/Elemental/Conditional only).
const PICK_FIELD_KIND: Record<string, "Elemental" | "Conditional"> = {
  Elements: "Elemental",
  Conditions: "Conditional",
};

function fieldValuesForEntity(
  kind: "Elemental" | "Conditional" | "Nodal",
  id: number
): { variable: string; value: number | [number, number, number] }[] {
  const out: { variable: string; value: number | [number, number, number] }[] = [];
  for (const info of fieldInfos) {
    if (info.field.kind !== kind) continue;
    if (info.isVector) {
      const v = vectorAt(info, id);
      if (v) out.push({ variable: info.field.variable, value: v });
    } else {
      const s = scalarAt(info, id);
      if (s !== undefined) out.push({ variable: info.field.variable, value: s });
    }
  }
  return out;
}

// --- Recording ------------------------------------------------------------

function toggleRecordPanel(): void {
  if (recordVisible) hideRecordPanel();
  else showRecordPanel();
}

function showRecordPanel(): void {
  if (!model) return;
  recordVisible = true;
  recordPanelEl.style.display = "";
  document.querySelector('[data-action="record"]')?.classList.add("active");
  renderRecordUI();
}

function hideRecordPanel(): void {
  recordVisible = false;
  recordCancelled = true; // stop any run in flight
  recordPanelEl.style.display = "none";
  document.querySelector('[data-action="record"]')?.classList.remove("active");
}

function renderRecordUI(): void {
  const state: RecordPanelState = {
    settings: recordSettings,
    availableFrames: timelineFrameCount,
    progress: recordProgress,
    canEncode: canRecordVideo(),
    message: recordMessage,
  };
  renderRecordPanel(recordPanelEl, state, {
    onClose: hideRecordPanel,
    onSettings: (next) => {
      recordSettings = next;
      recordMessage = undefined;
      renderRecordUI();
    },
    onStart: () => void startRecording(),
    onCancel: () => {
      recordCancelled = true;
    },
  });
}

/** Asks the host for a frame and resolves once it is drawn. */
function goToFrameAwaited(frameIndex: number): Promise<void> {
  if (frameIndex === currentFrameIndex) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pendingFrame = { index: frameIndex, resolve };
    vscode.postMessage({ type: "vtkRequestFrame", frameIndex });
  });
}

/**
 * Paints the overlays that live in the DOM rather than the WebGL canvas, so a
 * recording matches what is on screen: the split-view pane separators (a
 * `pointer-events:none` div overlay, invisible to a canvas copy) and the field
 * legend when the in-scene scalar bar is off.
 */
function decorateCapture(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  if (paneLayout !== "1x1") {
    ctx.save();
    ctx.strokeStyle = "rgba(160,160,160,0.9)";
    ctx.lineWidth = Math.max(1, Math.round(width / 900));
    for (const v of paneViewports(paneLayout)) {
      const r = paneCssRect(v);
      ctx.strokeRect(
        (r.left / 100) * width,
        (r.top / 100) * height,
        (r.width / 100) * width,
        (r.height / 100) * height
      );
    }
    ctx.restore();
  }
}

async function startRecording(): Promise<void> {
  if (recordProgress) return;
  const plan = buildRecordPlan(recordSettings, timelineFrameCount);
  if (plan.steps.length === 0) {
    recordMessage = "Nothing to record.";
    renderRecordUI();
    return;
  }
  // The timeline's play loop is a fire-and-forget interval that would interleave
  // its own frame requests with the recorder's.
  timeline.stopPlayback();

  recordCancelled = false;
  recordMessage = undefined;
  recordingActive = true;
  recordProgress = { done: 0, total: plan.steps.length };
  renderRecordUI();

  const startFrame = currentFrameIndex;
  let pngCount = 0;
  try {
    const result = await runRecording(
      plan,
      {
        canvas: () => vtkCanvas,
        render: () => renderWindow.render(),
        goToFrame: goToFrameAwaited,
        rotate: (deg) => {
          const cam = focusedRenderer().getActiveCamera();
          cam.azimuth(deg);
          cam.orthogonalizeViewUp();
          focusedRenderer().resetCameraClippingRange();
        },
        decorate: decorateCapture,
        onProgress: (done, total) => {
          recordProgress = { done, total };
          renderRecordUI();
        },
        shouldContinue: () => !recordCancelled,
      },
      (index, total, data) => {
        pngCount++;
        vscode.postMessage({ type: "recordFrame", index, total, data });
      }
    );

    if (result.message) {
      recordMessage = result.message;
    } else if (result.frames === 0) {
      recordMessage = "Cancelled before any frame was captured.";
    } else if (result.format === "webm" && result.video) {
      vscode.postMessage({
        type: "recordVideo",
        // A typed array, not base64: structured clone carries it natively and
        // skips the 33% inflation the screenshot path pays.
        data: result.video,
        mimeType: result.mimeType,
        frames: result.frames,
      });
      recordMessage = `Saved ${result.frames} frames${result.cancelled ? " (cancelled early)" : ""}.`;
    } else {
      vscode.postMessage({ type: "recordFramesDone", count: pngCount });
      recordMessage = `Saved ${pngCount} PNG frames${result.cancelled ? " (cancelled early)" : ""}.`;
    }
  } catch (err) {
    recordMessage = `Recording failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    recordingActive = false;
    recordProgress = undefined;
    // Put the timeline back where the user left it.
    if (plan.source === "timeline" && startFrame !== currentFrameIndex) {
      void goToFrameAwaited(startFrame);
    }
    renderRecordUI();
  }
}

// --- Time-series chart ---------------------------------------------------
//
// The scan runs on the HOST: the webview holds one frame at a time and cannot
// read files, so walking the timeline here would re-parse, re-apply the edit
// history and rebuild the whole scene once per step just to read one number.

const SERIES_MARKER_ID = "series:marker";
const SERIES_MARKER_COLOR: RGB = [1.0, 0.85, 0.1];

function openSeriesPanel(target: "entity" | "node"): void {
  const sel = inspectSelection;
  if (!sel) return;
  const info = target === "entity" ? sel.entity : sel.node;
  if (!info) return;
  const kind =
    target === "node"
      ? ("Nodal" as const)
      : sel.entity?.kind === "Condition"
        ? ("Conditional" as const)
        : ("Elemental" as const);
  const label =
    target === "node" ? `Node ${info.id}` : `${sel.entity?.kind ?? "Element"} ${info.id}`;
  const variables = info.fields.map((f) => f.variable);

  seriesState = {
    entity: { kind, id: info.id, label },
    variables,
    variable: variables[0],
    currentFrameIndex,
  };
  seriesVisible = true;
  seriesPanelEl.style.display = "";
  markSeriesEntity();
  renderSeriesUI();
  if (seriesState.variable) requestSeries(seriesState.variable);
  syncNavOffset();
}

function hideSeriesPanel(): void {
  seriesVisible = false;
  seriesPanelEl.style.display = "none";
  vscode.postMessage({ type: "fieldSeriesCancel" });
  removeLayer(SERIES_MARKER_ID);
  renderWindow.render();
  seriesState = undefined;
  syncNavOffset();
}

function requestSeries(variable: string): void {
  if (!seriesState) return;
  seriesState = {
    ...seriesState,
    variable,
    series: undefined,
    message: undefined,
    progress: { done: 0, total: 0, label: "" },
  };
  renderSeriesUI();
  vscode.postMessage({
    type: "fieldSeries",
    kind: seriesState.entity.kind,
    entityId: seriesState.entity.id,
    variable,
  });
}

/** Highlight the plotted entity, so it stays findable while the chart is open. */
function markSeriesEntity(): void {
  if (!seriesState) return;
  const { kind, id } = seriesState.entity;
  const cell: Cell | undefined =
    kind === "Nodal"
      ? { nodeIds: Int32Array.from([id]) }
      : kind === "Conditional"
        ? conditionById.get(id)
        : elementById.get(id);
  removeLayer(SERIES_MARKER_ID);
  if (cell) addLayer(SERIES_MARKER_ID, [cell], SERIES_MARKER_COLOR, true);
}

/**
 * A frame change runs clearScene, which drops every layer — including this
 * marker, whose subject lives in `seriesState` rather than in
 * `inspectSelection` (which buildScene wipes). Re-adding it is why the chart's
 * entity stays visible while stepping through time.
 */
function restoreSeriesMarker(): void {
  markSeriesEntity();
  renderWindow.render();
}

function renderSeriesUI(): void {
  if (!seriesState) return;
  const state: SeriesPanelState = { ...seriesState, currentFrameIndex };
  // The panel's height changes with its content — a chart and its caveats are
  // far taller than the "reading…" line it opens with — so the nav card has to
  // be re-lifted after every render, not just when the panel appears.
  queueMicrotask(syncNavOffset);
  renderSeriesPanel(seriesPanelEl, state, {
    onClose: hideSeriesPanel,
    onVariable: (variable) => requestSeries(variable),
    onCancel: () => vscode.postMessage({ type: "fieldSeriesCancel" }),
    onPickStep: (frameIndex) => vscode.postMessage({ type: "vtkRequestFrame", frameIndex }),
    onHover: (index) => {
      if (seriesState) seriesState.hoverIndex = index;
    },
    onExport: () => {
      // The opposite direction from the Data table's export, deliberately: a
      // series is a few hundred numbers the webview already holds, and the
      // host would have to re-run the whole scan to rebuild it.
      const series = seriesState?.series;
      if (!series) return;
      vscode.postMessage({
        type: "menuExportSeries",
        csv: seriesToCsv(series),
        suffix: `${series.variable}_${series.entityId}`,
      });
    },
  });
}

function toggleInspectMode(): void {
  if (inspectVisible) hideInspectPanel();
  else showInspectPanel();
}

function showInspectPanel(): void {
  if (!model) return;
  inspectMode = true;
  inspectVisible = true;
  inspectPanelEl.style.display = "";
  document.querySelector('#toolbar button[data-action="inspect"]')?.classList.add("active");
  renderInspectUI();
}

function hideInspectPanel(): void {
  inspectMode = false;
  inspectVisible = false;
  measuring = false;
  measurePendingPoint = undefined;
  inspectPanelEl.style.display = "none";
  document.querySelector('#toolbar button[data-action="inspect"]')?.classList.remove("active");
  removeLayer(INSPECT_MARKER_ID);
  removeLayer(MEASURE_POINTS_ID);
  removeLayer(MEASURE_LINE_ID);
  renderWindow.render();
}

function renderInspectUI(): void {
  const state: InspectPanelState = {
    selection: inspectSelection,
    measuring,
    measurePending: measurePendingPoint ? 1 : 0,
    measureResult,
    // A single-step vtkGroup still sets timelineVisible, and TimelineControl
    // then hides itself — a one-step "series" is not something to plot.
    canPlotSeries: timelineFrameCount > 1,
  };
  renderInspectPanel(inspectPanelEl, state, {
    onClose: () => hideInspectPanel(),
    onFrame: () => frameLayer(INSPECT_MARKER_ID),
    onPlotOverTime: openSeriesPanel,
    onToggleMeasure: () => {
      measuring = !measuring;
      measurePendingPoint = undefined;
      if (!measuring) {
        removeLayer(MEASURE_POINTS_ID);
        removeLayer(MEASURE_LINE_ID);
        renderWindow.render();
      }
      renderInspectUI();
    },
  });
}

function clearInspectSelection(): void {
  inspectSelection = undefined;
  removeLayer(INSPECT_MARKER_ID);
  renderInspectUI();
  renderWindow.render();
}

function handleMeasureClick(nodeId: number): void {
  if (!prepared) return;
  const coords = coordOfPrep(prepared, nodeId);
  if (!coords) return;
  if (!measurePendingPoint) {
    measurePendingPoint = { id: nodeId, coords };
    measureResult = undefined;
    removeLayer(MEASURE_LINE_ID);
    addLayer(MEASURE_POINTS_ID, [{ nodeIds: new Int32Array([nodeId]) }], MEASURE_COLOR, true);
  } else {
    const a = measurePendingPoint;
    const dx = coords[0] - a.coords[0];
    const dy = coords[1] - a.coords[1];
    const dz = coords[2] - a.coords[2];
    measureResult = {
      aId: a.id,
      bId: nodeId,
      distance: Math.hypot(dx, dy, dz),
      delta: [dx, dy, dz],
    };
    addLayer(
      MEASURE_POINTS_ID,
      [{ nodeIds: new Int32Array([a.id]) }, { nodeIds: new Int32Array([nodeId]) }],
      MEASURE_COLOR,
      true
    );
    addLayer(
      MEASURE_LINE_ID,
      [{ cellType: VtkCellType.LINE, nodeIds: new Int32Array([a.id, nodeId]) }],
      MEASURE_COLOR,
      true
    );
    measurePendingPoint = undefined;
  }
  renderInspectUI();
  renderWindow.render();
}

function handleInspectPick(displayX: number, displayY: number): void {
  if (!model || !prepared) return;
  const prep = prepared;
  cellPicker.pick([displayX, displayY, 0], focusedRenderer());
  // vtkPicker.getMapper() is never actually populated by pick() in this
  // vtk.js version (only initialized to null and left there) — getActors()
  // IS populated and sorted closest-first, so the picked actor is index 0.
  const actor = cellPicker.getActors()[0];
  const mapper = actor?.getMapper();
  if (!mapper) {
    if (!measuring) clearInspectSelection();
    return;
  }
  const layer = findLayerByMapper(mapper);
  if (!layer || layer.pickKind === undefined || !layer.pointGlobalIds || !layer.cellEntityIds) {
    if (!measuring) clearInspectSelection();
    return;
  }
  const cellId: number = cellPicker.getCellId();
  const polyData = mapper.getInputData();
  const cellInfo = polyData?.getCellPoints?.(cellId);
  const cellPointLocalIds: ArrayLike<number> = cellInfo?.cellPointIds ?? [];
  const positions: [number, number, number][] = cellPicker.getPickedPositions();
  const pickPos: [number, number, number] = positions.length ? positions[0] : [0, 0, 0];

  const pointGlobalIds = layer.pointGlobalIds;
  const coordsOf = (localId: number): [number, number, number] | undefined => {
    const gid = pointGlobalIds[localId];
    return gid === undefined ? undefined : coordOfPrep(prep, gid);
  };
  const result = resolvePick(
    { pointGlobalIds: layer.pointGlobalIds, cellEntityIds: layer.cellEntityIds },
    cellId,
    cellPointLocalIds,
    coordsOf,
    pickPos
  );

  if (measuring) {
    if (result.nodeId !== undefined) handleMeasureClick(result.nodeId);
    return;
  }

  const entityKind: "Element" | "Condition" | "Geometry" =
    layer.pickKind === "Elements" ? "Element" : layer.pickKind === "Conditions" ? "Condition" : "Geometry";
  const fieldKind = PICK_FIELD_KIND[layer.pickKind];
  const idx = getMembershipIndex();

  const selection: InspectSelection = {};
  if (result.entityId !== undefined) {
    const smpMap =
      layer.pickKind === "Elements"
        ? idx.elements
        : layer.pickKind === "Conditions"
        ? idx.conditions
        : idx.geometries;
    selection.entity = {
      kind: entityKind,
      id: result.entityId,
      blockName: layer.id.split(":").slice(2).join(":") || undefined,
      smpPaths: smpMap.get(result.entityId) ?? [],
      fields: fieldKind ? fieldValuesForEntity(fieldKind, result.entityId) : [],
    };
  }
  if (result.nodeId !== undefined) {
    const coords = coordOfPrep(prep, result.nodeId);
    if (coords) {
      selection.node = {
        id: result.nodeId,
        coords,
        smpPaths: idx.nodes.get(result.nodeId) ?? [],
        fields: fieldValuesForEntity("Nodal", result.nodeId),
      };
    }
  }

  inspectSelection = selection;

  // Marker: highlight the resolved entity's own cell when there is one
  // (shows the whole element/condition), else just the nearest node.
  const markerCell: Cell | undefined =
    result.entityId !== undefined
      ? layer.pickKind === "Elements"
        ? elementById.get(result.entityId)
        : layer.pickKind === "Conditions"
        ? conditionById.get(result.entityId)
        : geometryById.get(result.entityId)
      : result.nodeId !== undefined
      ? { nodeIds: new Int32Array([result.nodeId]) }
      : undefined;
  removeLayer(INSPECT_MARKER_ID);
  if (markerCell) addLayer(INSPECT_MARKER_ID, [markerCell], INSPECT_MARKER_COLOR, true);

  renderInspectUI();
  renderWindow.render();
}

// Only a genuine click (press+release with minimal movement) probes — a drag
// is a camera rotate/pan and must not also fire a pick. Listens on
// #render-root rather than the canvas itself: on pointerup the browser's hit
// test can land on the container instead of the (same-sized) canvas — an
// ordinary target-vs-capture quirk, not headless-only — so binding to the
// canvas can silently drop the release half of the click.
let inspectDownPos: { x: number; y: number } | null = null;
// The focused pane follows the pointer (vtk.js resolves it per event), so the
// focus border has to be refreshed after an interaction — a click is the
// moment it can actually have changed. The Field panel and the Clip group edit
// the focused pane, so they have to follow it too, or they would keep showing
// (and writing) the settings of the pane you just left.
let lastFocusedPane = 0;
// vtk.js binds its own listeners in grw.setContainer(), which ran at module
// load, so its poked-renderer update has already happened by the time these
// fire and the latch reads a settled value.
renderRoot.addEventListener("pointerdown", latchFocusedPane);
renderRoot.addEventListener("pointerup", () => {
  latchFocusedPane();
  if (paneLayout === "1x1") return;
  syncPaneChrome();
  const now = focusedPaneIndex();
  if (now === lastFocusedPane) return;
  lastFocusedPane = now;
  syncClipUI();
  if (fieldVisible) renderFieldPanelUI();
  renderWindow.render(); // the readout/plane refresh above can move nothing else
});

renderRoot.addEventListener("pointerdown", (ev: PointerEvent) => {
  if (!inspectMode) return;
  inspectDownPos = { x: ev.clientX, y: ev.clientY };
});
renderRoot.addEventListener("pointerup", (ev: PointerEvent) => {
  if (!inspectMode || !inspectDownPos || ev.button !== 0) {
    inspectDownPos = null;
    return;
  }
  const dx = ev.clientX - inspectDownPos.x;
  const dy = ev.clientY - inspectDownPos.y;
  inspectDownPos = null;
  if (Math.hypot(dx, dy) > 4) return;
  const rect = renderRoot.getBoundingClientRect();
  const displayX = ev.clientX - rect.left;
  const displayY = rect.height - (ev.clientY - rect.top);
  handleInspectPick(displayX, displayY);
});

// --- Find entity --------------------------------------------------------
// While a find highlight is active, all other layers are forced to wireframe
// so the highlighted entity stands out clearly.
function applyFindWireframe(): void {
  // The cut cap is a per-pane overlay, not a layer, so it stays solid without
  // needing to be skipped here.
  for (const [id, layer] of layers) {
    const rep = id === FIND_HIGHLIGHT_ID ? 2 : 1;
    eachLayerProperty(layer, (prop) => prop.setRepresentation(rep));
  }
  renderWindow.render();
}

function restoreWireframe(): void {
  const rep = wireframe ? 1 : 2;
  for (const [id, layer] of layers) {
    if (id === FIND_HIGHLIGHT_ID) continue;
    eachLayerProperty(layer, (prop) => prop.setRepresentation(rep));
  }
  // A pane under a field overlay goes back to dimmed, not to the global mode.
  panes.forEach((pane, i) => {
    if (!pane.dimmed) return;
    for (const [id, layer] of layers) {
      if (isOverlayLayer(id)) continue;
      layer.props[i]?.actor.getProperty().setRepresentation(1);
    }
  });
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
  detachLayerFromPanes(layer);
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
  const legend = activeLegendSpec();
  if (legend) {
    try {
      dataUrl = await compositeLegend(dataUrl, legend);
    } catch {
      // Legend burn-in is best-effort; ship the plain capture rather than fail.
    }
  }
  vscode.postMessage({ type: "screenshot", data: dataUrl });
}

vscode.postMessage({ type: "ready" });
