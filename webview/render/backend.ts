// The renderer boundary (roadmap item 12): the ONLY surface through which the
// webview talks to a rendering backend. main.ts and the panels see these
// interfaces; `@kitware/vtk.js` is imported only under webview/render/vtkjs/
// (src/test/rendererBoundary.test.ts enforces it), and the VTK-wasm backend
// implements the same interfaces over the native VTK C++ session.
//
// Shape and semantics:
//
// - Object handles, not ids. A pane owns an `RView` (a renderer with its own
//   viewport and camera); a layer owns one `RProp` per pane (actor + mapper —
//   a MAPPER per pane because clipping planes live on the mapper) over ONE
//   shared `RGeometry`. That is the pane/layer structure main.ts already had.
// - Names mirror VTK's own where VTK has the concept (getActiveCamera,
//   resetCamera, azimuth, orthogonalizeViewUp, …): both vtk.js and the C++ API
//   use them, so the boundary adds no vocabulary of its own for cameras.
// - Plain data in. Geometry, glyph sets and colouring are the pure values of
//   src/parser/render/types.ts, built once by Node-tested code.
// - Completion is SYNCHRONOUS. Every call finishes before it returns; `render`
//   draws before it returns (vtk.js always; VTK-wasm on the WebGL path, where
//   `Render` was measured never to suspend — backends that ever cannot report
//   `caps.syncRender: false`). `captureImage` is the one async call.
// - Picking returns the prop and the cell id only. Which entity and which
//   nodes a cell stands for is answered from the geometry the webview already
//   holds (cellArrays.ts), so entity identity never depends on the backend.

import type { PaneViewport } from "../../src/parser/paneLayout";
import type { ScalarBarOrientation } from "../../src/parser/paneView";
import type {
  Bounds6,
  DisplayGeometry,
  GlyphSet,
  PickHit,
  PropStyle,
  RGB,
  RendererKind,
  ScalarColoring,
  Vec3,
} from "../../src/parser/render/types";
import type { TileRect } from "../../src/parser/render/labelLayout";
import type { LightPlacement } from "../../src/parser/render/lightMode";

export type { Bounds6, DisplayGeometry, GlyphSet, PickHit, PropStyle, RGB, RendererKind, ScalarColoring, Vec3 };

export interface BackendCaps {
  /** `render()` has drawn by the time it returns (the recorder copies right after). */
  syncRender: boolean;
  /**
   * Ray-cast sphere and cylinder impostors (`GlyphSource` `impostorSphere` /
   * `impostorStick`) are supported. When false the caller builds the
   * tessellated glyph sets instead and `impostorsReason` says why.
   */
  impostors: boolean;
  impostorsReason?: string;
  /**
   * `selectRegion` is implemented: an exact, visible-only GPU id-buffer
   * selection. When false callers sample `pick` over a grid instead.
   */
  hardwareSelection: boolean;
  /** `PropStyle.smoothShading` (and the other display-only filters) are honoured. */
  displayFilters: boolean;
  /** `RView.setLight` is honoured (scene and positional lights). */
  lightModes: boolean;
  /**
   * `RView.compositeMatrix`, `RenderBackend.viewTile` and `RView.depthSnapshot`
   * are implemented, so a label pass can project every node in typed arrays and
   * cull the hidden ones. When false the caller keeps the capped per-point path.
   */
  gpuLabels: boolean;
}

export interface DepthSnapshot {
  depth: Float32Array;
  width: number;
  height: number;
}

/** The cells of one prop that are visible inside a selected region. */
export interface RegionPick<P> {
  prop: P;
  /** Cell ids in the prop's geometry (verts -> lines -> polys enumeration). */
  cellIds: number[];
}

export interface RCamera {
  getPosition(): Vec3;
  setPosition(x: number, y: number, z: number): void;
  getFocalPoint(): Vec3;
  setFocalPoint(x: number, y: number, z: number): void;
  getViewUp(): Vec3;
  setViewUp(x: number, y: number, z: number): void;
  getParallelProjection(): boolean;
  setParallelProjection(on: boolean): void;
  getParallelScale(): number;
  setParallelScale(scale: number): void;
  getViewAngle(): number;
  getDistance(): number;
  getDirectionOfProjection(): Vec3;
  azimuth(degrees: number): void;
  elevation(degrees: number): void;
  dolly(factor: number): void;
  orthogonalizeViewUp(): void;
}

/** Geometry uploaded once and shared by every pane's prop. */
export interface RGeometry {
  readonly kind: "mesh" | "glyphs";
  /** The data it was built from (meshes only) — what picking resolves against. */
  readonly data?: DisplayGeometry;
  dispose(): void;
}

/** A clipping plane. State is held on the JS side; reads never cross the boundary. */
export interface RPlane {
  setOrigin(origin: Vec3): void;
  setNormal(normal: Vec3): void;
  getOrigin(): Vec3;
  getNormal(): Vec3;
  dispose(): void;
}

/** Relative coincident-topology offsets (factor, units) for coplanar overlays. */
export interface CoincidentOffset {
  polygon?: [number, number];
  line?: [number, number];
}

/** One pane's actor + mapper for a layer. */
export interface RProp {
  /** Binds (or rebinds) the prop's own mapper to shared geometry. */
  setGeometry(geometry: RGeometry): void;
  readonly geometry: RGeometry | undefined;
  setVisible(on: boolean): void;
  setPickable(on: boolean): void;
  setStyle(style: PropStyle): void;
  setColoring(coloring: ScalarColoring): void;
  /** At most one plane per prop — the pane's. */
  setClipPlane(plane: RPlane | undefined): void;
  setCoincidentOffset(offset: CoincidentOffset): void;
  getBounds(): Bounds6 | undefined;
  dispose(): void;
}

export interface ScalarBar {
  setVisible(visible: boolean): void;
  /** The same colour transfer function the mapper uses, and the axis title. */
  configure(ctfPoints: number[], title: string): void;
  setOrientation(orientation: ScalarBarOrientation): void;
  updateTheme(theme: string): void;
  dispose(): void;
}

export interface GridAxes {
  setVisible(visible: boolean): void;
  updateBounds(bounds: Bounds6): void;
  updateTheme(theme: string): void;
  dispose(): void;
}

/** A pane: one renderer, one viewport, one camera. */
export interface RView {
  getActiveCamera(): RCamera;
  setViewport(x0: number, y0: number, x1: number, y1: number): void;
  setBackground(r: number, g: number, b: number): void;
  getBackground(): RGB;
  /** A fixed world-space light, or null for the camera-following headlight. Only when `caps.lightModes`. */
  setLight(placement: LightPlacement | null): void;
  /** Row-major 4x4 view x projection for this view's tile (`caps.gpuLabels`). */
  compositeMatrix(): number[];
  /**
   * The depth buffer as of the last render, NDC depth per DEVICE pixel with row
   * 0 at the bottom, or undefined until one has been rendered after `on` was
   * first set. `on = false` stops the (readback-per-render) probe. `caps.gpuLabels`.
   */
  depthSnapshot(on: boolean): DepthSnapshot | undefined;
  addProp(prop: RProp): void;
  removeProp(prop: RProp): void;
  resetCamera(bounds?: Bounds6): void;
  resetCameraClippingRange(): void;
  computeVisiblePropBounds(): Bounds6;
  createScalarBar(theme: string): ScalarBar;
  createGridAxes(theme: string): GridAxes;
  dispose(): void;
}

export interface OrientationMarker {
  updateTheme(theme: string): void;
}

export interface RenderBackend {
  readonly kind: RendererKind;
  readonly caps: BackendCaps;
  readonly canvas: HTMLCanvasElement;
  /** The pane-0 renderer, which exists from construction. */
  readonly firstView: RView;
  createView(viewport: PaneViewport): RView;
  createGeometry(data: DisplayGeometry): RGeometry;
  createGlyphGeometry(set: GlyphSet): RGeometry;
  createProp(): RProp;
  createPlane(): RPlane;
  /** CSS pixels relative to the canvas, y measured from the BOTTOM. */
  pick(view: RView, cssX: number, cssYFromBottom: number): PickHit<RProp> | undefined;
  /**
   * Every cell of every PICKABLE prop that is visible inside the region (CSS
   * pixels, y from the BOTTOM, like `pick`), exact to the pixel: the scene is
   * drawn once into an id buffer, so a cell that covers a single pixel is found
   * and a cell hidden behind another is not. `inside` refines the rectangle
   * (the lasso passes a polygon test); it is called with pixel-centre CSS
   * coordinates. Props that are not pickable are left out of the capture, so an
   * overlay in front of a layer never hides it. Only when `caps.hardwareSelection`.
   */
  selectRegion?(
    view: RView,
    region: { left: number; bottom: number; right: number; top: number },
    inside?: (cssX: number, cssYFromBottom: number) => boolean
  ): RegionPick<RProp>[];
  /** World point -> CSS pixels relative to the canvas, top-left origin. */
  /** This view's rectangle in CSS pixels, y from the canvas top (`caps.gpuLabels`). */
  viewTile(view: RView): TileRect;
  worldToDisplay(view: RView, x: number, y: number, z: number): [number, number];
  /** The view under the pointer during the current/last pointer event, if any. */
  pokedView(): RView | undefined;
  setInteractionMode(mode: "rotate" | "pan"): void;
  /** Top-left orientation cube; `onSnap` receives the clicked face's normal. */
  createOrientationMarker(getView: () => RView, onSnap: (normal: Vec3) => void, theme: string): OrientationMarker;
  resize(): void;
  render(): void;
  /** Synchronous render/copy transaction; restores dimensions and background before returning. */
  captureFrame(ctx: CanvasRenderingContext2D, width: number, height: number, background?: [number, number, number, number]): void;
  /** The current frame as a PNG data URL. */
  captureImage(): Promise<string>;
  dispose(): void;
}
