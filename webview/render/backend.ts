// The renderer boundary (roadmap item 18): the ONLY surface through which the
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

export type { Bounds6, DisplayGeometry, GlyphSet, PickHit, PropStyle, RGB, RendererKind, ScalarColoring, Vec3 };

export interface BackendCaps {
  /** `render()` has drawn by the time it returns (the recorder copies right after). */
  syncRender: boolean;
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
  /** World point -> CSS pixels relative to the canvas, top-left origin. */
  worldToDisplay(view: RView, x: number, y: number, z: number): [number, number];
  /** The view under the pointer during the current/last pointer event, if any. */
  pokedView(): RView | undefined;
  setInteractionMode(mode: "rotate" | "pan"): void;
  /** Top-left orientation cube; `onSnap` receives the clicked face's normal. */
  createOrientationMarker(getView: () => RView, onSnap: (normal: Vec3) => void, theme: string): OrientationMarker;
  resize(): void;
  render(): void;
  /** The current frame as a PNG data URL. */
  captureImage(): Promise<string>;
  dispose(): void;
}
