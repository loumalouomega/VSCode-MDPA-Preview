// The vtk.js implementation of the renderer boundary (webview/render/backend.ts).
//
// Every vtk.js call the webview makes now lives under webview/render/vtkjs/.
// The code here is main.ts's former scene plumbing moved behind the interfaces
// with the SAME calls in the SAME order — the renderer-boundary refactor is
// gated on pixel-identical parity captures (scripts/render-parity/), so this
// file is deliberately a transcription, not a redesign.

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
// Registers the OpenGL peer. The Geometry profile does NOT include
// Glyph3DMapper, so without this a glyph actor is built and added to the
// renderer but draws nothing at all.
import "@kitware/vtk.js/Rendering/OpenGL/Glyph3DMapper";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkRenderer from "@kitware/vtk.js/Rendering/Core/Renderer";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import vtkCellPicker from "@kitware/vtk.js/Rendering/Core/CellPicker";
import vtkArrowSource from "@kitware/vtk.js/Filters/Sources/ArrowSource";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import vtkCylinderSource from "@kitware/vtk.js/Filters/Sources/CylinderSource";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballPanManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";

import type { PaneViewport } from "../../../src/parser/paneLayout";
import type {
  BackendCaps,
  Bounds6,
  CoincidentOffset,
  DisplayGeometry,
  GlyphSet,
  GridAxes,
  OrientationMarker,
  PickHit,
  PropStyle,
  RCamera,
  RGB,
  RGeometry,
  RPlane,
  RProp,
  RView,
  RenderBackend,
  ScalarBar,
  ScalarColoring,
  Vec3,
} from "../backend";
import { ctfFromPoints } from "./colorTransfer";
import { setupScalarBar } from "./scalarBar";
import { setupGridAxes } from "./gridAxes";
import { setupOrientationCube } from "./orientationCube";

class VtkJsCamera implements RCamera {
  constructor(readonly camera: any) {}
  getPosition(): Vec3 {
    return this.camera.getPosition();
  }
  setPosition(x: number, y: number, z: number): void {
    this.camera.setPosition(x, y, z);
  }
  getFocalPoint(): Vec3 {
    return this.camera.getFocalPoint();
  }
  setFocalPoint(x: number, y: number, z: number): void {
    this.camera.setFocalPoint(x, y, z);
  }
  getViewUp(): Vec3 {
    return this.camera.getViewUp();
  }
  setViewUp(x: number, y: number, z: number): void {
    this.camera.setViewUp(x, y, z);
  }
  getParallelProjection(): boolean {
    return this.camera.getParallelProjection();
  }
  setParallelProjection(on: boolean): void {
    this.camera.setParallelProjection(on);
  }
  getParallelScale(): number {
    return this.camera.getParallelScale();
  }
  setParallelScale(scale: number): void {
    this.camera.setParallelScale(scale);
  }
  getViewAngle(): number {
    return this.camera.getViewAngle();
  }
  getDistance(): number {
    return this.camera.getDistance();
  }
  getDirectionOfProjection(): Vec3 {
    return this.camera.getDirectionOfProjection();
  }
  azimuth(degrees: number): void {
    this.camera.azimuth(degrees);
  }
  elevation(degrees: number): void {
    this.camera.elevation(degrees);
  }
  dolly(factor: number): void {
    this.camera.dolly(factor);
  }
  orthogonalizeViewUp(): void {
    this.camera.orthogonalizeViewUp();
  }
}

class VtkJsGeometry implements RGeometry {
  constructor(
    readonly kind: "mesh" | "glyphs",
    readonly polyData: any,
    readonly data?: DisplayGeometry,
    readonly glyphs?: { set: GlyphSet; source: any }
  ) {}
  // vtk.js data objects are garbage collected with the mappers that reference
  // them; the scene code never deleted polydata explicitly, and removing a
  // layer already deletes every actor over it.
  dispose(): void {}
}

function meshPolyData(g: DisplayGeometry): any {
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(g.points, 3);
  if (g.polys) pd.getPolys().setData(g.polys);
  if (g.lines) pd.getLines().setData(g.lines);
  if (g.verts) pd.getVerts().setData(g.verts);
  if (g.pointScalars) {
    pd.getPointData().setScalars(
      vtkDataArray.newInstance({ name: g.pointScalars.name, numberOfComponents: 1, values: g.pointScalars.values })
    );
  } else if (g.cellScalars) {
    pd.getCellData().setScalars(
      vtkDataArray.newInstance({ name: g.cellScalars.name, numberOfComponents: 1, values: g.cellScalars.values })
    );
  }
  return pd;
}

function glyphSource(set: GlyphSet): any {
  switch (set.source.kind) {
    case "arrow":
      return vtkArrowSource.newInstance();
    case "sphere":
      return vtkSphereSource.newInstance({
        radius: 1,
        thetaResolution: set.source.resolution,
        phiResolution: set.source.resolution,
      });
    case "cylinderX":
      // A unit cylinder along +X: height 1 and radius 0.5 make a
      // [length, diameter, diameter] scale array read directly.
      return vtkCylinderSource.newInstance({
        height: 1,
        radius: 0.5,
        resolution: set.source.resolution,
        center: [0, 0, 0],
        direction: [1, 0, 0],
        capping: true,
      });
  }
}

class VtkJsProp implements RProp {
  readonly actor: any = vtkActor.newInstance();
  mapper: any;
  geometry: VtkJsGeometry | undefined;
  private coloring: ScalarColoring | undefined;
  private clip: VtkJsPlane | undefined;
  private offset: CoincidentOffset | undefined;

  constructor(private readonly registry: WeakMap<object, VtkJsProp>) {
    registry.set(this.actor, this);
  }

  setGeometry(geometry: RGeometry): void {
    const g = geometry as VtkJsGeometry;
    this.geometry = g;
    let mapper: any;
    if (g.kind === "glyphs" && g.glyphs) {
      const { set, source } = g.glyphs;
      mapper = vtkGlyph3DMapper.newInstance();
      mapper.setInputData(g.polyData, 0);
      mapper.setInputConnection(source.getOutputPort(), 1);
      if (set.orientationArray) {
        mapper.setOrientationArray(set.orientationArray);
        mapper.setOrientationModeToDirection();
      }
      // setScaleArray exists at runtime (macro.setGet) but is missing from vtk.js TS typedefs.
      mapper.setScaleArray(set.scaleArray);
      if (set.scaleMode === "components") mapper.setScaleModeToScaleByComponents();
      else mapper.setScaleModeToScaleByMagnitude();
      mapper.setScaleFactor(set.scaleFactor);
    } else {
      mapper = vtkMapper.newInstance();
      mapper.setInputData(g.polyData);
    }
    this.mapper = mapper;
    if (this.coloring) this.applyColoring(this.coloring);
    if (this.offset) this.applyOffset(this.offset);
    this.actor.setMapper(mapper);
    if (this.clip) mapper.addClippingPlane(this.clip.plane);
  }

  setVisible(on: boolean): void {
    this.actor.setVisibility(on);
  }

  setPickable(on: boolean): void {
    this.actor.setPickable(on);
  }

  setStyle(s: PropStyle): void {
    const p = this.actor.getProperty();
    if (s.color) p.setColor(s.color[0], s.color[1], s.color[2]);
    if (s.edgeVisible !== undefined) p.setEdgeVisibility(s.edgeVisible);
    if (s.edgeColor) p.setEdgeColor(s.edgeColor[0], s.edgeColor[1], s.edgeColor[2]);
    if (s.representation !== undefined) p.setRepresentation(s.representation);
    if (s.opacity !== undefined) p.setOpacity(s.opacity);
    if (s.pointSize !== undefined) p.setPointSize(s.pointSize);
    if (s.lineWidth !== undefined) p.setLineWidth(s.lineWidth);
    if (s.specular !== undefined) p.setSpecular(s.specular);
    if (s.ambient !== undefined) p.setAmbient(s.ambient);
    if (s.diffuse !== undefined) p.setDiffuse(s.diffuse);
    if (s.backfaceCulling !== undefined) p.setBackfaceCulling(s.backfaceCulling);
  }

  setColoring(coloring: ScalarColoring): void {
    this.coloring = coloring;
    if (coloring.kind === "flat") {
      const [r, g, b] = coloring.rgb;
      this.actor.getProperty().setColor(r, g, b);
    }
    if (this.mapper) this.applyColoring(coloring);
  }

  private applyColoring(c: ScalarColoring): void {
    const m = this.mapper;
    if (c.kind !== "mapped") {
      m.setScalarVisibility(false);
      return;
    }
    m.setLookupTable(ctfFromPoints(c.ctfPoints));
    m.setUseLookupTableScalarRange(true);
    m.setScalarRange(c.range[0], c.range[1]);
    m.setScalarVisibility(true);
    if (c.association === "point") m.setScalarModeToUsePointData();
    else m.setScalarModeToUseCellData();
    if (c.arrayName) m.setColorByArrayName(c.arrayName);
    else m.setInterpolateScalarsBeforeMapping(c.interpolateBeforeMapping);
  }

  setClipPlane(plane: RPlane | undefined): void {
    this.clip = plane as VtkJsPlane | undefined;
    if (!this.mapper) return;
    this.mapper.removeAllClippingPlanes();
    if (this.clip) this.mapper.addClippingPlane(this.clip.plane);
  }

  setCoincidentOffset(offset: CoincidentOffset): void {
    this.offset = offset;
    if (this.mapper) this.applyOffset(offset);
  }

  private applyOffset(o: CoincidentOffset): void {
    // Added at runtime by implementCoincidentTopologyMethods, absent from the TS stubs.
    const m = this.mapper;
    if (o.polygon) {
      m.setResolveCoincidentTopologyToPolygonOffset();
      m.setRelativeCoincidentTopologyPolygonOffsetParameters(o.polygon[0], o.polygon[1]);
    }
    if (o.line) {
      m.setResolveCoincidentTopologyToPolygonOffset();
      m.setRelativeCoincidentTopologyLineOffsetParameters(o.line[0], o.line[1]);
    }
  }

  getBounds(): Bounds6 | undefined {
    return this.actor.getBounds();
  }

  dispose(): void {
    this.registry.delete(this.actor);
    this.actor.delete();
  }
}

class VtkJsPlane implements RPlane {
  readonly plane: any = vtkPlane.newInstance();
  setOrigin(o: Vec3): void {
    this.plane.setOrigin(o);
  }
  setNormal(n: Vec3): void {
    this.plane.setNormal(n);
  }
  getOrigin(): Vec3 {
    return this.plane.getOrigin();
  }
  getNormal(): Vec3 {
    return this.plane.getNormal();
  }
  dispose(): void {
    this.plane.delete();
  }
}

class VtkJsView implements RView {
  private cam: VtkJsCamera | undefined;
  constructor(
    readonly renderer: any,
    private readonly renderWindow: any,
    private readonly onDispose: (v: VtkJsView) => void
  ) {}
  getActiveCamera(): RCamera {
    const c = this.renderer.getActiveCamera();
    if (!this.cam || this.cam.camera !== c) this.cam = new VtkJsCamera(c);
    return this.cam;
  }
  setViewport(x0: number, y0: number, x1: number, y1: number): void {
    this.renderer.setViewport(x0, y0, x1, y1);
  }
  setBackground(r: number, g: number, b: number): void {
    this.renderer.setBackground(r, g, b);
  }
  getBackground(): RGB {
    return this.renderer.getBackground();
  }
  addProp(prop: RProp): void {
    this.renderer.addActor((prop as VtkJsProp).actor);
  }
  removeProp(prop: RProp): void {
    this.renderer.removeActor((prop as VtkJsProp).actor);
  }
  resetCamera(bounds?: Bounds6): void {
    if (bounds) this.renderer.resetCamera(bounds);
    else this.renderer.resetCamera();
  }
  resetCameraClippingRange(): void {
    this.renderer.resetCameraClippingRange();
  }
  computeVisiblePropBounds(): Bounds6 {
    return this.renderer.computeVisiblePropBounds();
  }
  createScalarBar(theme: string): ScalarBar {
    return setupScalarBar(this.renderer, theme);
  }
  createGridAxes(theme: string): GridAxes {
    return setupGridAxes(this.renderer, theme);
  }
  dispose(): void {
    this.renderWindow.removeRenderer(this.renderer);
    this.renderer.delete();
    this.onDispose(this);
  }
}

export interface VtkJsBackendOptions {
  container: HTMLElement;
  background: RGB;
}

export function createVtkJsBackend(opts: VtkJsBackendOptions): RenderBackend {
  const grw: any = vtkGenericRenderWindow.newInstance({ background: opts.background });
  grw.setContainer(opts.container);
  const renderWindow: any = grw.getRenderWindow();
  const apiRW: any = grw.getApiSpecificRenderWindow ? grw.getApiSpecificRenderWindow() : grw.getOpenGLRenderWindow();
  // The canvas is created synchronously by grw.setContainer().
  const canvas = opts.container.querySelector("canvas") as HTMLCanvasElement;

  const propRegistry = new WeakMap<object, VtkJsProp>();
  const views = new Map<any, VtkJsView>();
  const forget = (v: VtkJsView): void => {
    views.delete(v.renderer);
  };
  const wrap = (r: any): VtkJsView => {
    const v = new VtkJsView(r, renderWindow, forget);
    views.set(r, v);
    return v;
  };
  const firstView = wrap(grw.getRenderer());

  // --- Interactor style ---------------------------------------------------
  // vtk.js routes each event to the renderer under the pointer and normalizes
  // drags by that renderer's own viewport, so split panes need no input gate.
  const istyle = vtkInteractorStyleManipulator.newInstance();
  const rotateManip = vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 });
  const panManipLeft = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1 });
  const panManipMiddle = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 });
  const zoomManip = vtkMouseCameraTrackballZoomManipulator.newInstance({ scrollEnabled: true, dragEnabled: false });
  const zoomManipRight = vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3 });
  const setMode = (mode: "rotate" | "pan"): void => {
    istyle.removeAllMouseManipulators();
    istyle.addMouseManipulator(mode === "rotate" ? rotateManip : panManipLeft);
    istyle.addMouseManipulator(panManipMiddle);
    istyle.addMouseManipulator(zoomManip);
    istyle.addMouseManipulator(zoomManipRight);
  };
  setMode("rotate");
  grw.getInteractor().setInteractorStyle(istyle);
  grw.resize();

  const cellPicker = vtkCellPicker.newInstance();
  const caps: BackendCaps = { syncRender: true };

  return {
    kind: "vtkjs",
    caps,
    canvas,
    firstView,
    createView(vp: PaneViewport): RView {
      const r: any = vtkRenderer.newInstance();
      renderWindow.addRenderer(r);
      r.setViewport(...vp);
      return wrap(r);
    },
    createGeometry(data: DisplayGeometry): RGeometry {
      return new VtkJsGeometry("mesh", meshPolyData(data), data);
    },
    createGlyphGeometry(set: GlyphSet): RGeometry {
      const pd = vtkPolyData.newInstance();
      pd.getPoints().setData(set.anchors, 3);
      for (const a of set.arrays) {
        const arr = vtkDataArray.newInstance({ name: a.name, numberOfComponents: a.components, values: a.values });
        if (a.role === "vectors") pd.getPointData().setVectors(arr);
        else if (a.role === "scalars") pd.getPointData().setScalars(arr);
        else pd.getPointData().addArray(arr);
      }
      return new VtkJsGeometry("glyphs", pd, undefined, { set, source: glyphSource(set) });
    },
    createProp(): RProp {
      return new VtkJsProp(propRegistry);
    },
    createPlane(): RPlane {
      return new VtkJsPlane();
    },
    pick(view: RView, cssX: number, cssYFromBottom: number): PickHit<RProp> | undefined {
      // The picker works in the render window's own pixels, and
      // GenericRenderWindow sizes the canvas at CSS size x devicePixelRatio.
      const cr = canvas.getBoundingClientRect();
      const sx = cr.width > 0 ? canvas.width / cr.width : 1;
      const sy = cr.height > 0 ? canvas.height / cr.height : 1;
      cellPicker.pick([cssX * sx, cssYFromBottom * sy, 0], (view as VtkJsView).renderer);
      // vtkPicker.getMapper() is never populated by pick() in this vtk.js
      // version — getActors() IS, sorted closest-first.
      const actor = cellPicker.getActors()[0];
      if (!actor?.getMapper()) return undefined;
      const prop = propRegistry.get(actor);
      if (!prop) return undefined;
      const positions: Vec3[] = cellPicker.getPickedPositions();
      return { prop, cellId: cellPicker.getCellId(), position: positions.length ? positions[0] : [0, 0, 0] };
    },
    worldToDisplay(view: RView, x: number, y: number, z: number): [number, number] {
      const size = apiRW.getSize();
      const dpr = window.devicePixelRatio || 1;
      const disp = apiRW.worldToDisplay(x, y, z, (view as VtkJsView).renderer);
      return [disp[0] / dpr, (size[1] - disp[1]) / dpr];
    },
    pokedView(): RView | undefined {
      return views.get(grw.getInteractor().getCurrentRenderer());
    },
    setInteractionMode: setMode,
    createOrientationMarker(getView: () => RView, onSnap: (normal: Vec3) => void, theme: string): OrientationMarker {
      // vtk.js's widget follows the poked renderer itself, so `getView` is not needed here.
      void getView;
      return setupOrientationCube(renderWindow, grw.getInteractor(), canvas, onSnap, theme);
    },
    resize(): void {
      grw.resize();
    },
    render(): void {
      renderWindow.render();
    },
    async captureImage(): Promise<string> {
      renderWindow.render();
      // captureNextImage() handles the WebGL swap-chain timing; fall back to
      // toDataURL if this vtk.js build lacks it.
      if (typeof apiRW.captureNextImage === "function") return apiRW.captureNextImage("image/png") as Promise<string>;
      return canvas.toDataURL("image/png");
    },
    dispose(): void {
      grw.delete();
    },
  };
}
