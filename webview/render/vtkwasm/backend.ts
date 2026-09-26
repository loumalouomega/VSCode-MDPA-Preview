// The VTK-wasm implementation of the renderer boundary (webview/render/backend.ts),
// roadmap item 18. EXPERIMENTAL: selected by `kratos.preview.renderer`.
//
// It talks to the NATIVE VTK session the pinned build exports
// (Module.vtkStandaloneSession: create / invoke / invokeAsync / destroy)
// rather than @kitware/vtk-wasm's Proxy layer — no method table, no Proxy
// allocation per call, and every convention below was measured against the
// pinned build in the Phase 0 gates (doc/vtk-wasm-migration.md):
//
// - Object arguments are `{Id}`. A flag must match its C++ parameter type
//   exactly: `vtkTypeBool`/int takes 0/1 and rejects a JS boolean, a real C++
//   `bool` takes only a JS boolean ("No suitable overload" otherwise), so
//   `call` encodes by VTK_WASM_BOOL_PARAM_METHODS.
// - An unknown method answers `null` and logs `ERR|…`; it never throws. Every
//   method used here is listed in src/parser/render/vtkWasmApiUsage.ts and the
//   asset build fails if the pinned binary lacks one.
// - A getter that returns a VTK object registers it with the session, and the
//   registration outlives the owner, so each such id is destroyed explicitly.
// - Typed arrays enter through `_malloc` + `HEAPU8.set` + `SetArray(ptr, n, 0)`
//   (VTK takes ownership and frees them), cells through
//   `vtkCellArray::SetData(offsets, connectivity)`.
// - A synchronous `invoke(rw, "Render")` never suspended on the WebGL path
//   (G0.7), and the drawing buffer is valid until the task yields, so capture
//   is render-then-copy in one task.
//
// What vtk.js provided and the C++ build does not is rebuilt in JS on top:
// the mouse camera control (cameraMath.ts transcribes vtk.js's manipulators),
// the orientation-marker widget (a layer-1 renderer plus a JS ray-cube hit
// test), and the beam cylinder along +X (glyphSources.ts).

import type { PaneViewport } from "../../../src/parser/paneLayout";
import type { ScalarBarOrientation } from "../../../src/parser/paneView";
import { legacyToOffsets } from "../../../src/parser/render/cellArrays";
import { unitCylinderX } from "../../../src/parser/render/glyphSources";
import { VTK_WASM_BOOL_PARAM_METHODS } from "../../../src/parser/render/vtkWasmApiUsage";
import {
  WheelNormalizer,
  clippingRangeForBounds,
  cubeFaceHit,
  resetCameraToBounds,
  scrollZoom,
  trackballPan,
  trackballRotate,
  viewRay,
  zoomDrag,
  zoomDragScale,
  type CameraLens,
  type CameraPose,
} from "../../../src/parser/render/cameraMath";
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

// --- The native session ------------------------------------------------------

interface NativeSession {
  create(cls: string): number;
  invoke(id: number, method: string, args: unknown[]): any;
  invokeAsync(id: number, method: string, args: unknown[]): Promise<any>;
  destroy(id: number): void;
  delete?(): void;
}

const UNINITIALIZED_BOUNDS: Bounds6 = [1, -1, 1, -1, 1, -1];
const LIGHT_THEMES = new Set(["light", "scientific"]);

function toNumbers(v: unknown): number[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(Number);
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, Number);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(Number);
  return [Number(v)];
}
const vec3 = (v: unknown): Vec3 => {
  const n = toNumbers(v);
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
};
const boundsOk = (b: number[]): boolean => b.length === 6 && b[0] <= b[1] && b[2] <= b[3] && b[4] <= b[5];

/**
 * Owns every session id the backend creates or receives from a getter, so a
 * disposed backend leaves nothing registered and a released object is never
 * destroyed twice.
 */
class Vtk {
  private readonly live = new Set<number>();
  private readonly errors: string[] = [];

  constructor(
    readonly M: any,
    readonly S: NativeSession,
    private readonly logged: () => string[]
  ) {}

  create(cls: string): number {
    const id = this.S.create(cls);
    if (!id) throw new Error(`VTK-wasm: cannot create ${cls}`);
    this.live.add(id);
    return id;
  }

  /**
   * Invoke synchronously. Flags are encoded per the invoker's rule: a JS
   * boolean for the methods whose parameter is a C++ `bool`, an integer for
   * every other flag (vtkTypeBool) — either mismatch is silently ignored.
   */
  call(id: number, method: string, ...args: unknown[]): any {
    const asBool = VTK_WASM_BOOL_PARAM_METHODS.has(method);
    return this.S.invoke(
      id,
      method,
      args.map((a) => (typeof a === "boolean" ? (asBool ? a : a ? 1 : 0) : asBool && typeof a === "number" ? a !== 0 : a))
    );
  }

  ref(id: number): { Id: number } {
    return { Id: id };
  }

  /** A getter's object: tracked so it is released, returned as an id. */
  child(id: number, method: string, ...args: unknown[]): number {
    const st = this.call(id, method, ...args);
    const cid = st && typeof st === "object" && "Id" in st ? Number(st.Id) : 0;
    if (!cid) throw new Error(`VTK-wasm: ${method} returned no object`);
    this.live.add(cid);
    return cid;
  }

  free(id: number | undefined): void {
    if (!id || !this.live.has(id)) return;
    this.live.delete(id);
    this.S.destroy(id);
  }

  /** Copies a typed array into the wasm heap as a VTK data array the object then owns. */
  upload(ta: Float32Array | Int32Array, nComp: number, name = ""): number {
    const bytes = ta.byteLength;
    const ptr = this.M._malloc(Math.max(bytes, 4));
    if (!ptr) throw new Error(`VTK-wasm: malloc(${bytes}) failed`);
    this.M.HEAPU8.set(new Uint8Array(ta.buffer, ta.byteOffset, bytes), ptr);
    const arr = this.create(ta instanceof Float32Array ? "vtkFloatArray" : "vtkTypeInt32Array");
    this.call(arr, "SetNumberOfComponents", nComp);
    if (name) this.call(arr, "SetName", name);
    this.call(arr, "SetArray", ptr, ta.length, 0);
    return arr;
  }

  /** Session errors logged since the last call (the invoker logs instead of throwing). */
  drainErrors(): string[] {
    const fresh = this.logged().splice(0).filter((l) => l.includes("ERR|"));
    this.errors.push(...fresh);
    return fresh;
  }

  releaseAll(): void {
    for (const id of [...this.live].reverse()) {
      try {
        this.S.destroy(id);
      } catch {
        /* the session may already be gone */
      }
    }
    this.live.clear();
  }
}

// --- Geometry ----------------------------------------------------------------

/** Builds a vtkPolyData from plain display geometry; returns it and the ids it owns. */
function buildPolyData(vtk: Vtk, g: DisplayGeometry): { pd: number; owned: number[] } {
  const owned: number[] = [];
  const pd = vtk.create("vtkPolyData");
  const pts = vtk.create("vtkPoints");
  const pa = vtk.upload(g.points, 3, "Points");
  vtk.call(pts, "SetData", vtk.ref(pa));
  vtk.call(pd, "SetPoints", vtk.ref(pts));
  owned.push(pts, pa);
  const nPoints = g.points.length / 3;
  for (const [cells, setter] of [
    [g.verts, "SetVerts"],
    [g.lines, "SetLines"],
    [g.polys, "SetPolys"],
  ] as const) {
    if (!cells || cells.length === 0) continue;
    const oc = legacyToOffsets(cells, nPoints);
    const o = vtk.upload(oc.offsets, 1);
    const c = vtk.upload(oc.connectivity, 1);
    const ca = vtk.create("vtkCellArray");
    vtk.call(ca, "SetData", vtk.ref(o), vtk.ref(c));
    vtk.call(pd, setter, vtk.ref(ca));
    owned.push(o, c, ca);
  }
  const attach = (scalars: DisplayGeometry["pointScalars"], getter: "GetPointData" | "GetCellData") => {
    if (!scalars) return;
    const arr = vtk.upload(scalars.values, 1, scalars.name);
    const attrs = vtk.child(pd, getter);
    vtk.call(attrs, "SetScalars", vtk.ref(arr));
    vtk.free(attrs);
    owned.push(arr);
  };
  if (g.pointScalars) attach(g.pointScalars, "GetPointData");
  else if (g.cellScalars) attach(g.cellScalars, "GetCellData");
  return { pd, owned };
}

class WasmGeometry implements RGeometry {
  private disposed = false;
  constructor(
    private readonly vtk: Vtk,
    readonly kind: "mesh" | "glyphs",
    readonly pd: number,
    private readonly owned: number[],
    readonly data?: DisplayGeometry,
    readonly glyphs?: { set: GlyphSet; source: number }
  ) {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Mappers hold their own references, so releasing the session ids is safe
    // even while a prop still draws this geometry.
    for (const id of [...this.owned].reverse()) this.vtk.free(id);
    this.vtk.free(this.pd);
  }
}

function glyphSource(vtk: Vtk, set: GlyphSet): { pd: number; owned: number[] } {
  switch (set.source.kind) {
    case "arrow":
    case "sphere": {
      const src = vtk.create(set.source.kind === "arrow" ? "vtkArrowSource" : "vtkSphereSource");
      if (set.source.kind === "sphere") {
        vtk.call(src, "SetRadius", 1);
        vtk.call(src, "SetThetaResolution", set.source.resolution);
        vtk.call(src, "SetPhiResolution", set.source.resolution);
      }
      vtk.call(src, "Update");
      const out = vtk.child(src, "GetOutput");
      return { pd: out, owned: [src] };
    }
    case "cylinderX":
      return buildPolyData(vtk, unitCylinderX(set.source.resolution));
  }
}

// --- Camera ------------------------------------------------------------------

class WasmCamera implements RCamera {
  constructor(
    private readonly vtk: Vtk,
    readonly id: number
  ) {}
  private get(m: string): Vec3 {
    return vec3(this.vtk.call(this.id, m));
  }
  getPosition(): Vec3 {
    return this.get("GetPosition");
  }
  setPosition(x: number, y: number, z: number): void {
    this.vtk.call(this.id, "SetPosition", x, y, z);
  }
  getFocalPoint(): Vec3 {
    return this.get("GetFocalPoint");
  }
  setFocalPoint(x: number, y: number, z: number): void {
    this.vtk.call(this.id, "SetFocalPoint", x, y, z);
  }
  getViewUp(): Vec3 {
    return this.get("GetViewUp");
  }
  setViewUp(x: number, y: number, z: number): void {
    this.vtk.call(this.id, "SetViewUp", x, y, z);
  }
  getParallelProjection(): boolean {
    return Number(this.vtk.call(this.id, "GetParallelProjection")) !== 0;
  }
  setParallelProjection(on: boolean): void {
    this.vtk.call(this.id, "SetParallelProjection", on);
  }
  getParallelScale(): number {
    return Number(this.vtk.call(this.id, "GetParallelScale"));
  }
  setParallelScale(scale: number): void {
    this.vtk.call(this.id, "SetParallelScale", scale);
  }
  getViewAngle(): number {
    return Number(this.vtk.call(this.id, "GetViewAngle"));
  }
  setViewAngle(angle: number): void {
    this.vtk.call(this.id, "SetViewAngle", angle);
  }
  getDistance(): number {
    return Number(this.vtk.call(this.id, "GetDistance"));
  }
  getDirectionOfProjection(): Vec3 {
    return this.get("GetDirectionOfProjection");
  }
  azimuth(degrees: number): void {
    this.vtk.call(this.id, "Azimuth", degrees);
  }
  elevation(degrees: number): void {
    this.vtk.call(this.id, "Elevation", degrees);
  }
  dolly(factor: number): void {
    this.vtk.call(this.id, "Dolly", factor);
  }
  orthogonalizeViewUp(): void {
    this.vtk.call(this.id, "OrthogonalizeViewUp");
  }
  pose(): CameraPose {
    return { position: this.getPosition(), focalPoint: this.getFocalPoint(), viewUp: this.getViewUp() };
  }
  setPose(p: CameraPose): void {
    this.setPosition(...p.position);
    this.setFocalPoint(...p.focalPoint);
    this.setViewUp(...p.viewUp);
  }
  lens(): CameraLens {
    const cr = toNumbers(this.vtk.call(this.id, "GetClippingRange"));
    return {
      parallelProjection: this.getParallelProjection(),
      parallelScale: this.getParallelScale(),
      viewAngle: this.getViewAngle(),
      clippingRange: [cr[0] ?? 0.01, cr[1] ?? 1000],
    };
  }
}

// --- Props and planes ----------------------------------------------------------

class WasmPlane implements RPlane {
  readonly id: number;
  private origin: Vec3 = [0, 0, 0];
  private normal: Vec3 = [0, 0, 1];
  constructor(private readonly vtk: Vtk) {
    this.id = vtk.create("vtkPlane");
  }
  setOrigin(o: Vec3): void {
    this.origin = [o[0], o[1], o[2]];
    this.vtk.call(this.id, "SetOrigin", o[0], o[1], o[2]);
  }
  setNormal(n: Vec3): void {
    this.normal = [n[0], n[1], n[2]];
    this.vtk.call(this.id, "SetNormal", n[0], n[1], n[2]);
  }
  getOrigin(): Vec3 {
    return [...this.origin] as Vec3;
  }
  getNormal(): Vec3 {
    return [...this.normal] as Vec3;
  }
  dispose(): void {
    this.vtk.free(this.id);
  }
}

class WasmProp implements RProp {
  readonly actor: number;
  private readonly property: number;
  private mapper = 0;
  private ctf = 0;
  geometry: WasmGeometry | undefined;
  private coloring: ScalarColoring | undefined;
  private clip: WasmPlane | undefined;
  private offset: CoincidentOffset | undefined;
  visible = true;
  private disposed = false;

  constructor(
    private readonly vtk: Vtk,
    private readonly registry: Map<number, WasmProp>
  ) {
    this.actor = vtk.create("vtkActor");
    this.property = vtk.create("vtkProperty");
    vtk.call(this.actor, "SetProperty", vtk.ref(this.property));
    registry.set(this.actor, this);
  }

  setGeometry(geometry: RGeometry): void {
    const g = geometry as WasmGeometry;
    this.geometry = g;
    const old = this.mapper;
    const vtk = this.vtk;
    let mapper: number;
    if (g.kind === "glyphs" && g.glyphs) {
      const { set, source } = g.glyphs;
      mapper = vtk.create("vtkGlyph3DMapper");
      vtk.call(mapper, "SetInputData", vtk.ref(g.pd));
      vtk.call(mapper, "SetSourceData", 0, vtk.ref(source));
      if (set.orientationArray) {
        vtk.call(mapper, "SetOrient", true);
        vtk.call(mapper, "SetOrientationArray", set.orientationArray);
        vtk.call(mapper, "SetOrientationModeToDirection");
      } else {
        vtk.call(mapper, "SetOrient", false);
      }
      vtk.call(mapper, "SetScaling", true);
      vtk.call(mapper, "SetScaleArray", set.scaleArray);
      if (set.scaleMode === "components") vtk.call(mapper, "SetScaleModeToScaleByVectorComponents");
      else vtk.call(mapper, "SetScaleModeToScaleByMagnitude");
      vtk.call(mapper, "SetScaleFactor", set.scaleFactor);
    } else {
      mapper = vtk.create("vtkPolyDataMapper");
      vtk.call(mapper, "SetInputData", vtk.ref(g.pd));
    }
    this.mapper = mapper;
    if (this.coloring) this.applyColoring(this.coloring);
    if (this.offset) this.applyOffset(this.offset);
    vtk.call(this.actor, "SetMapper", vtk.ref(mapper));
    if (this.clip) vtk.call(mapper, "AddClippingPlane", vtk.ref(this.clip.id));
    vtk.free(old);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.vtk.call(this.actor, "SetVisibility", on);
  }

  setPickable(on: boolean): void {
    this.vtk.call(this.actor, "SetPickable", on);
  }

  setStyle(s: PropStyle): void {
    const p = this.property;
    const c = (m: string, ...a: unknown[]) => this.vtk.call(p, m, ...a);
    if (s.color) c("SetColor", s.color[0], s.color[1], s.color[2]);
    if (s.edgeVisible !== undefined) c("SetEdgeVisibility", s.edgeVisible);
    if (s.edgeColor) c("SetEdgeColor", s.edgeColor[0], s.edgeColor[1], s.edgeColor[2]);
    if (s.representation !== undefined) c("SetRepresentation", s.representation);
    if (s.opacity !== undefined) c("SetOpacity", s.opacity);
    if (s.pointSize !== undefined) c("SetPointSize", s.pointSize);
    if (s.lineWidth !== undefined) c("SetLineWidth", s.lineWidth);
    if (s.specular !== undefined) c("SetSpecular", s.specular);
    if (s.ambient !== undefined) c("SetAmbient", s.ambient);
    if (s.diffuse !== undefined) c("SetDiffuse", s.diffuse);
    if (s.backfaceCulling !== undefined) c("SetBackfaceCulling", s.backfaceCulling);
  }

  setColoring(coloring: ScalarColoring): void {
    this.coloring = coloring;
    if (coloring.kind === "flat") {
      const [r, g, b] = coloring.rgb;
      this.vtk.call(this.property, "SetColor", r, g, b);
    }
    if (this.mapper) this.applyColoring(coloring);
  }

  private applyColoring(c: ScalarColoring): void {
    const vtk = this.vtk;
    const m = this.mapper;
    if (c.kind !== "mapped") {
      vtk.call(m, "SetScalarVisibility", false);
      return;
    }
    const ctf = vtk.create("vtkColorTransferFunction");
    vtk.call(ctf, "SetColorSpaceToRGB");
    for (let i = 0; i + 3 < c.ctfPoints.length; i += 4) {
      vtk.call(ctf, "AddRGBPoint", c.ctfPoints[i], c.ctfPoints[i + 1], c.ctfPoints[i + 2], c.ctfPoints[i + 3]);
    }
    vtk.call(m, "SetLookupTable", vtk.ref(ctf));
    vtk.free(this.ctf);
    this.ctf = ctf;
    vtk.call(m, "SetUseLookupTableScalarRange", true);
    vtk.call(m, "SetScalarRange", c.range[0], c.range[1]);
    vtk.call(m, "SetScalarVisibility", true);
    vtk.call(m, "SetColorModeToMapScalars");
    if (c.arrayName) {
      vtk.call(m, "SetScalarModeToUsePointFieldData");
      vtk.call(m, "SelectColorArray", c.arrayName);
    } else {
      if (c.association === "point") vtk.call(m, "SetScalarModeToUsePointData");
      else vtk.call(m, "SetScalarModeToUseCellData");
      vtk.call(m, "SetInterpolateScalarsBeforeMapping", c.interpolateBeforeMapping);
    }
  }

  setClipPlane(plane: RPlane | undefined): void {
    this.clip = plane as WasmPlane | undefined;
    if (!this.mapper) return;
    this.vtk.call(this.mapper, "RemoveAllClippingPlanes");
    if (this.clip) this.vtk.call(this.mapper, "AddClippingPlane", this.vtk.ref(this.clip.id));
  }

  setCoincidentOffset(offset: CoincidentOffset): void {
    this.offset = offset;
    if (this.mapper) this.applyOffset(offset);
  }

  private applyOffset(o: CoincidentOffset): void {
    if (!o.polygon && !o.line) return;
    // vtk.js's static offsets (CoincidentTopologyHelper: polygon 2/0, line
    // 1/-1, point -2) apply to every primitive of a mapper that turned the
    // mode on, added to its own relative parameters.
    const [pf, pu] = o.polygon ?? [0, 0];
    const [lf, lu] = o.line ?? [0, 0];
    this.vtk.call(this.mapper, "SetRelativeCoincidentTopologyPolygonOffsetParameters", 2 + pf, pu);
    this.vtk.call(this.mapper, "SetRelativeCoincidentTopologyLineOffsetParameters", 1 + lf, -1 + lu);
    this.vtk.call(this.mapper, "SetRelativeCoincidentTopologyPointOffsetParameter", -2);
  }

  getBounds(): Bounds6 | undefined {
    const b = toNumbers(this.vtk.call(this.actor, "GetBounds"));
    return boundsOk(b) ? (b as Bounds6) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registry.delete(this.actor);
    this.vtk.free(this.actor);
    this.vtk.free(this.mapper);
    this.vtk.free(this.ctf);
    this.vtk.free(this.property);
  }
}

// --- Annotations ---------------------------------------------------------------

const VERTICAL_POSITION: [number, number] = [0.78, 0.08];
const VERTICAL_SIZE: [number, number] = [0.16, 0.62];
const HORIZONTAL_POSITION: [number, number] = [0.3, 0.1];
const HORIZONTAL_SIZE: [number, number] = [0.44, 0.12];

function labelRgb(theme: string): RGB {
  return LIGHT_THEMES.has(theme) ? [0x22 / 255, 0x22 / 255, 0x22 / 255] : [1, 1, 1];
}

function createScalarBar(vtk: Vtk, ren: number, theme: string): ScalarBar {
  const bar = vtk.create("vtkScalarBarActor");
  let ctf = 0;
  vtk.call(bar, "SetVisibility", false);
  vtk.call(bar, "SetDrawNanAnnotation", false);
  vtk.call(bar, "SetNumberOfLabels", 5);
  const place = (pos: [number, number], size: [number, number]) => {
    vtk.call(bar, "SetPosition", pos[0], pos[1]);
    vtk.call(bar, "SetPosition2", size[0], size[1]);
  };
  vtk.call(bar, "SetOrientationToVertical");
  place(VERTICAL_POSITION, VERTICAL_SIZE);
  const title = vtk.child(bar, "GetTitleTextProperty");
  const label = vtk.child(bar, "GetLabelTextProperty");
  // vtk.js draws 13 px axis and 11 px tick text; the C++ bar scales its text
  // to the bar unless told the font size is authoritative.
  vtk.call(bar, "SetUnconstrainedFontSize", true);
  const px = window.devicePixelRatio || 1;
  for (const tp of [title, label]) {
    vtk.call(tp, "SetBold", false);
    vtk.call(tp, "SetItalic", false);
    vtk.call(tp, "SetShadow", false);
  }
  vtk.call(title, "SetFontSize", Math.round(13 * px));
  vtk.call(label, "SetFontSize", Math.round(11 * px));
  const applyTheme = (t: string) => {
    for (const tp of [title, label]) vtk.call(tp, "SetColor", ...labelRgb(t));
  };
  applyTheme(theme);
  vtk.call(ren, "AddActor", vtk.ref(bar));
  return {
    setVisible: (v) => vtk.call(bar, "SetVisibility", v),
    configure(points: number[], text: string): void {
      const next = vtk.create("vtkColorTransferFunction");
      for (let i = 0; i + 3 < points.length; i += 4) vtk.call(next, "AddRGBPoint", points[i], points[i + 1], points[i + 2], points[i + 3]);
      vtk.call(bar, "SetLookupTable", vtk.ref(next));
      vtk.free(ctf);
      ctf = next;
      vtk.call(bar, "SetTitle", text);
    },
    setOrientation(o: ScalarBarOrientation): void {
      if (o === "horizontal") {
        vtk.call(bar, "SetOrientationToHorizontal");
        place(HORIZONTAL_POSITION, HORIZONTAL_SIZE);
      } else {
        vtk.call(bar, "SetOrientationToVertical");
        place(VERTICAL_POSITION, VERTICAL_SIZE);
      }
    },
    updateTheme: applyTheme,
    dispose(): void {
      vtk.call(ren, "RemoveActor", vtk.ref(bar));
      for (const id of [title, label, ctf, bar]) vtk.free(id);
    },
  };
}

function createGridAxes(vtk: Vtk, ren: number, camera: number, theme: string): GridAxes {
  const ax = vtk.create("vtkCubeAxesActor");
  vtk.call(ax, "SetCamera", vtk.ref(camera));
  vtk.call(ax, "SetXTitle", "X");
  vtk.call(ax, "SetYTitle", "Y");
  vtk.call(ax, "SetZTitle", "Z");
  vtk.call(ax, "SetDrawXGridlines", true);
  vtk.call(ax, "SetDrawYGridlines", true);
  vtk.call(ax, "SetDrawZGridlines", true);
  // One labelled axis per direction on the outer silhouette, like vtk.js;
  // static edges labels all twelve and the 3D labels are sized in screen
  // units (default 10), which reads far larger than vtk.js's 2D text.
  vtk.call(ax, "SetFlyModeToOuterEdges");
  vtk.call(ax, "SetScreenSize", 6);
  vtk.call(ax, "SetVisibility", false);
  const texts: number[] = [];
  for (let i = 0; i < 3; i++) texts.push(vtk.child(ax, "GetTitleTextProperty", i), vtk.child(ax, "GetLabelTextProperty", i));
  const lines = ["X", "Y", "Z"].flatMap((a) => [vtk.child(ax, `Get${a}AxesLinesProperty`), vtk.child(ax, `Get${a}AxesGridlinesProperty`)]);
  const applyTheme = (t: string) => {
    const dark = !LIGHT_THEMES.has(t);
    for (const tp of texts) vtk.call(tp, "SetColor", ...labelRgb(t));
    const grid: RGB = dark ? [0.45, 0.45, 0.45] : [0.35, 0.35, 0.35];
    for (const lp of lines) vtk.call(lp, "SetColor", ...grid);
  };
  applyTheme(theme);
  vtk.call(ren, "AddActor", vtk.ref(ax));
  return {
    setVisible: (v) => vtk.call(ax, "SetVisibility", v),
    updateBounds: (b) => vtk.call(ax, "SetBounds", b[0], b[1], b[2], b[3], b[4], b[5]),
    updateTheme: applyTheme,
    dispose(): void {
      vtk.call(ren, "RemoveActor", vtk.ref(ax));
      for (const id of [...texts, ...lines, ax]) vtk.free(id);
    },
  };
}

// --- Views -----------------------------------------------------------------------

class WasmView implements RView {
  readonly ren: number;
  readonly camera: WasmCamera;
  viewport: [number, number, number, number] = [0, 0, 1, 1];
  private background: RGB = [0, 0, 0];
  readonly props = new Set<WasmProp>();

  constructor(
    private readonly vtk: Vtk,
    private readonly rw: number,
    private readonly onDispose: (v: WasmView) => void
  ) {
    this.ren = vtk.create("vtkRenderer");
    const cam = vtk.create("vtkCamera");
    this.camera = new WasmCamera(vtk, cam);
    vtk.call(this.ren, "SetActiveCamera", vtk.ref(cam));
    vtk.call(this.ren, "SetLayer", 0);
    // Translucency stays on the C++ default order-independent pass (vtk.js's
    // design too). Depth peeling is refused on WebGL2 ("Built in Dual Depth
    // Peeling is not supported on ES3", measured), and plain blending would
    // be draw-order dependent. Known cost, measured in parity scene b07: a
    // translucent wireframe coplanar with an opaque overlay is dropped.
    vtk.call(rw, "AddRenderer", vtk.ref(this.ren));
  }
  getActiveCamera(): RCamera {
    return this.camera;
  }
  setViewport(x0: number, y0: number, x1: number, y1: number): void {
    this.viewport = [x0, y0, x1, y1];
    this.vtk.call(this.ren, "SetViewport", x0, y0, x1, y1);
  }
  setBackground(r: number, g: number, b: number): void {
    this.background = [r, g, b];
    this.vtk.call(this.ren, "SetBackground", r, g, b);
  }
  getBackground(): RGB {
    return [...this.background] as RGB;
  }
  addProp(prop: RProp): void {
    const p = prop as WasmProp;
    this.props.add(p);
    this.vtk.call(this.ren, "AddActor", this.vtk.ref(p.actor));
  }
  removeProp(prop: RProp): void {
    const p = prop as WasmProp;
    this.props.delete(p);
    this.vtk.call(this.ren, "RemoveActor", this.vtk.ref(p.actor));
  }
  resetCamera(bounds?: Bounds6): void {
    const b = bounds ?? this.computeVisiblePropBounds();
    if (!boundsOk(b)) return;
    // vtk.js pins the view angle to 30 degrees on every reset.
    this.camera.setViewAngle(30);
    const r = resetCameraToBounds(this.camera.pose(), 30, b);
    this.camera.setPose(r.pose);
    // vtk.js resets the clipping range against the SAME bounds, so framing
    // one element (Find) clips away what lies far in front of or behind it.
    const range = clippingRangeForBounds(r.pose, { ...this.camera.lens(), viewAngle: 30 }, b);
    this.vtk.call(this.camera.id, "SetClippingRange", range[0], range[1]);
    this.camera.setParallelScale(r.parallelScale);
  }
  resetCameraClippingRange(): void {
    this.vtk.call(this.ren, "ResetCameraClippingRange");
  }
  computeVisiblePropBounds(): Bounds6 {
    const out: Bounds6 = [...UNINITIALIZED_BOUNDS] as Bounds6;
    for (const p of this.props) {
      if (!p.visible) continue;
      const b = p.getBounds();
      if (!b) continue;
      for (let i = 0; i < 6; i += 2) {
        out[i] = Math.min(out[i], b[i]);
        out[i + 1] = Math.max(out[i + 1], b[i + 1]);
      }
    }
    return out;
  }
  createScalarBar(theme: string): ScalarBar {
    return createScalarBar(this.vtk, this.ren, theme);
  }
  createGridAxes(theme: string): GridAxes {
    return createGridAxes(this.vtk, this.ren, this.camera.id, theme);
  }
  dispose(): void {
    this.vtk.call(this.rw, "RemoveRenderer", this.vtk.ref(this.ren));
    this.vtk.free(this.ren);
    this.vtk.free(this.camera.id);
    this.onDispose(this);
  }
}

// --- Orientation marker -------------------------------------------------------------

// Face colours and axis colours shared with the vtk.js backend's cube.
const FACE_RGB: RGB = [0x85 / 255, 0xb5 / 255, 0xda / 255];
const AXIS_RGB: RGB[] = [
  [255 / 255, 54 / 255, 83 / 255],
  [138 / 255, 219 / 255, 0],
  [44 / 255, 143 / 255, 255 / 255],
];
/** Marker camera distance: a 30-degree cone that holds the cube and the 1.15-long arrows. */
const MARKER_DISTANCE = 5.0;

// --- The backend ----------------------------------------------------------------------

export interface VtkWasmBackendOptions {
  container: HTMLElement;
  background: RGB;
  /** URL of the directory holding vtkWebAssembly.mjs/.wasm (a webview resource URI). */
  base: string;
}

export async function createVtkWasmBackend(opts: VtkWasmBackendOptions): Promise<RenderBackend> {
  // Absolute, so the module import and locateFile agree whatever the page's base.
  const base = new URL(opts.base.replace(/\/+$/, "") + "/", document.baseURI).href.replace(/\/$/, "");
  // A real dynamic import: the glue is an ES module served from the extension's
  // media root, loaded under the nonce'd CSP (verified: nonce propagation
  // covers import()). esbuild leaves a non-literal specifier alone.
  const glue = await import(/* @vite-ignore */ `${base}/vtkWebAssembly.mjs`);
  const logged: string[] = [];
  // The session reports a bad call by LOGGING (`ERR|…`) and answering null, so
  // its error lines are surfaced on the console (capped) instead of vanishing.
  let surfaced = 0;
  const onLog = (s: unknown): void => {
    const line = String(s);
    logged.push(line);
    if (logged.length > 500) logged.splice(0, logged.length - 500);
    if (surfaced < 50 && /ERR\||error/i.test(line)) {
      surfaced++;
      console.warn(`VTK-wasm: ${line}`);
    }
  };
  const M: any = await glue.default({
    locateFile: (f: string) => `${base}/${f}`,
    print: onLog,
    printErr: onLog,
  });
  // The standalone session must not resize or restyle our canvas behind our back.
  M._setDefaultExpandVTKCanvasToContainer?.(0);
  M._setDefaultInstallHTMLResizeObserver?.(0);
  const session: NativeSession = new M.vtkStandaloneSession();
  const vtk = new Vtk(M, session, () => logged);

  const canvas = document.createElement("canvas");
  canvas.id = "vtk-wasm-canvas";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.tabIndex = -1;
  opts.container.appendChild(canvas);
  const key = "!vtk-wasm-canvas";
  M.specialHTMLTargets[key] = canvas;

  // Coincident topology, reproduced per mapper as vtk.js does it. vtk.js
  // turns polygon offset on only for the mappers that ask (the cut cap and
  // its edges) and gives those its static offsets plus theirs; the C++ mode
  // and statics are process-wide, with no invoker entry. So the mode is
  // switched on and the statics ZEROED once through the deserializer (any
  // mapper's state keys set the statics — measured), and each mapper that
  // asks carries vtk.js's statics folded into its RELATIVE parameters
  // (applyOffset). A mapper that asks for nothing then gets exactly zero,
  // which is vtk.js's "off".
  {
    const probe = vtk.create("vtkPolyDataMapper");
    (session as unknown as { set(id: number, state: object): void }).set(probe, {
      ResolveCoincidentTopology: 1,
      ResolveCoincidentTopologyPolygonOffsetParameters: [0, 0],
      ResolveCoincidentTopologyLineOffsetParameters: [0, 0],
      ResolveCoincidentTopologyPointOffsetParameter: 0,
    });
    vtk.free(probe);
  }

  const rw = vtk.create("vtkWebAssemblyOpenGLRenderWindow");
  vtk.call(rw, "SetCanvasSelector", key);
  vtk.call(rw, "SetNumberOfLayers", 2);

  const views = new Map<number, WasmView>();
  const viewOrder: WasmView[] = [];
  const forget = (v: WasmView): void => {
    views.delete(v.ren);
    const i = viewOrder.indexOf(v);
    if (i >= 0) viewOrder.splice(i, 1);
    if (poked === v) poked = undefined;
  };
  const makeView = (): WasmView => {
    const v = new WasmView(vtk, rw, forget);
    views.set(v.ren, v);
    viewOrder.push(v);
    return v;
  };
  const firstView = makeView();
  firstView.setBackground(...opts.background);

  const propRegistry = new Map<number, WasmProp>();
  const picker = vtk.create("vtkCellPicker");
  vtk.call(picker, "SetPickClippingPlanes", 1);
  // Picking is two-stage. vtk.js picks with a tolerance of 2.5% of the view
  // diagonal, which on a dense surface lets a NEIGHBOURING triangle win and
  // reports clicks just off a silhouette as hits (measured against an exact
  // ray cast over the double arch: at 1e-6 the C++ picker found the true
  // front cell on 23/23 hits and missed exactly the 17 empty clicks; at 0.025
  // only 12/23 were the true cell). So the exact pick runs first and vtk.js's
  // tolerance is the fallback — which keeps lines and points (no area to
  // hit exactly) pickable and keeps vtk.js's forgiveness near edges.
  const PICK_TOLERANCES = [1e-6, 0.025];

  const caps: BackendCaps = { syncRender: true };
  let disposed = false;

  // --- Size ---------------------------------------------------------------
  const dpr = (): number => window.devicePixelRatio || 1;
  const cssRect = (): DOMRect => canvas.getBoundingClientRect();
  const resize = (): void => {
    // The same arithmetic as vtk.js's GenericRenderWindow.resize.
    const dims = opts.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(dims.width * dpr()));
    const h = Math.max(1, Math.floor(dims.height * dpr()));
    if (canvas.width === w && canvas.height === h) return;
    // Resizing a canvas clears it, so a size change is followed by a draw
    // (vtk.js's GenericRenderWindow.resize does the same).
    canvas.width = w;
    canvas.height = h;
    vtk.call(rw, "SetSize", w, h);
    marker?.place();
    if (sizedOnce) renderNow();
    sizedOnce = true;
  };
  let sizedOnce = false;

  // --- Which view is under the pointer ------------------------------------
  let poked: WasmView | undefined;
  /** Display position of a pointer event: CSS pixels, bottom-left origin. */
  const displayPos = (e: MouseEvent): [number, number] => {
    const r = cssRect();
    return [e.clientX - r.left, r.height - (e.clientY - r.top)];
  };
  const viewAt = (pos: [number, number]): WasmView | undefined => {
    const r = cssRect();
    if (r.width <= 0 || r.height <= 0) return undefined;
    const x = pos[0] / r.width;
    const y = pos[1] / r.height;
    for (let i = viewOrder.length - 1; i >= 0; i--) {
      const [x0, y0, x1, y1] = viewOrder[i].viewport;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return viewOrder[i];
    }
    return undefined;
  };
  const viewportCss = (v: WasmView): [number, number] => {
    const r = cssRect();
    return [Math.max(1, r.width * (v.viewport[2] - v.viewport[0])), Math.max(1, r.height * (v.viewport[3] - v.viewport[1]))];
  };

  // --- Rendering ------------------------------------------------------------
  let marker: MarkerImpl | undefined;
  let asyncRenderPending = false;
  const renderNow = (): void => {
    if (disposed) return;
    marker?.sync();
    if (caps.syncRender) {
      try {
        vtk.call(rw, "Render");
        return;
      } catch (e) {
        // A build that suspends inside Render cannot be driven synchronously;
        // switch to the async path for the rest of the session.
        caps.syncRender = false;
        console.warn(`VTK-wasm: synchronous Render failed (${(e as Error)?.message ?? e}); rendering asynchronously.`);
      }
    }
    if (asyncRenderPending) return;
    asyncRenderPending = true;
    void session.invokeAsync(rw, "Render", []).finally(() => {
      asyncRenderPending = false;
    });
  };

  // Camera interaction renders at most once per animation frame.
  let frameQueued = false;
  const requestRender = (): void => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      renderNow();
    });
  };

  // --- Mouse camera control (vtk.js manipulator transcription) ------------------
  let mode: "rotate" | "pan" = "rotate";
  type Drag = { view: WasmView; kind: "rotate" | "pan" | "zoom"; last: [number, number]; zoomScale: number; pointerId: number };
  let drag: Drag | undefined;
  const wheel = new WheelNormalizer();
  const noModifiers = (e: MouseEvent): boolean => !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;

  const onPointerDown = (e: PointerEvent): void => {
    const pos = displayPos(e);
    const view = viewAt(pos);
    poked = view;
    if (!view || drag || !noModifiers(e)) return;
    const kind = e.button === 0 ? mode : e.button === 1 ? "pan" : e.button === 2 ? "zoom" : undefined;
    if (!kind) return;
    const zoomScale = kind === "zoom" ? zoomDragScale(view.camera.lens(), viewportCss(view)[1]) : 0;
    drag = { view, kind, last: pos, zoomScale, pointerId: e.pointerId };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no capturable pointer */
    }
  };
  const onPointerMove = (e: PointerEvent): void => {
    const pos = displayPos(e);
    if (!drag) {
      poked = viewAt(pos) ?? poked;
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    const { view, last } = drag;
    const cam = view.camera;
    const size = viewportCss(view);
    if (drag.kind === "rotate") {
      cam.setPose(trackballRotate(cam.pose(), last[0] - pos[0], last[1] - pos[1], size));
      view.resetCameraClippingRange();
    } else if (drag.kind === "pan") {
      cam.setPose(trackballPan(cam.pose(), cam.lens(), last, pos, size[1]));
      view.resetCameraClippingRange();
    } else {
      const r = zoomDrag(cam.pose(), cam.lens(), last[1] - pos[1], drag.zoomScale);
      if ("parallelScale" in r) cam.setParallelScale(r.parallelScale);
      else {
        cam.setPose(r.pose);
        view.resetCameraClippingRange();
      }
    }
    drag.last = pos;
    requestRender();
  };
  const endDrag = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pointerId) drag = undefined;
  };
  const onWheel = (e: WheelEvent): void => {
    const view = viewAt(displayPos(e));
    if (!view || !noModifiers(e)) return;
    e.preventDefault();
    poked = view;
    const spin = wheel.normalize(e.deltaY, e.deltaMode, performance.now());
    if (!spin) return;
    const cam = view.camera;
    const r = scrollZoom(cam.lens(), spin);
    if ("parallelScale" in r) cam.setParallelScale(r.parallelScale);
    else {
      cam.dolly(r.dolly);
      view.resetCameraClippingRange();
    }
    requestRender();
  };
  const onContextMenu = (e: Event): void => e.preventDefault();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  // --- Orientation marker ------------------------------------------------------
  interface MarkerImpl extends OrientationMarker {
    sync(): void;
    place(): void;
    dispose(): void;
  }
  const createMarker = (getView: () => RView, onSnap: (n: Vec3) => void, theme: string): MarkerImpl => {
    const ren = vtk.create("vtkRenderer");
    const camId = vtk.create("vtkCamera");
    const cam = new WasmCamera(vtk, camId);
    vtk.call(ren, "SetActiveCamera", vtk.ref(camId));
    vtk.call(ren, "SetLayer", 1);
    vtk.call(ren, "SetInteractive", 0);
    vtk.call(rw, "AddRenderer", vtk.ref(ren));

    const cube = vtk.create("vtkAnnotatedCubeActor");
    const faces: [string, string][] = [
      ["SetXPlusFaceText", "RIGHT"],
      ["SetXMinusFaceText", "LEFT"],
      ["SetYPlusFaceText", "TOP"],
      ["SetYMinusFaceText", "BOTTOM"],
      ["SetZPlusFaceText", "FRONT"],
      ["SetZMinusFaceText", "BACK"],
    ];
    for (const [m, t] of faces) vtk.call(cube, m, t);
    // vtkVectorText glyphs are ~1 unit tall and wide per character, so
    // "BOTTOM" fits a unit face at about a sixth of the default scale.
    vtk.call(cube, "SetFaceTextScale", 0.12);
    // The C++ actor lays the Z faces' text along Y; turned to read left to
    // right with +Y up, as the vtk.js cube's textures do.
    vtk.call(cube, "SetZFaceTextRotation", 90);
    vtk.call(cube, "SetTextEdgesVisibility", false);
    vtk.call(cube, "SetPickable", false);
    const cubeProp = vtk.child(cube, "GetCubeProperty");
    vtk.call(cubeProp, "SetColor", ...FACE_RGB);
    vtk.call(cubeProp, "SetAmbient", 1);
    vtk.call(cubeProp, "SetDiffuse", 0);
    const faceProps = ["XPlus", "XMinus", "YPlus", "YMinus", "ZPlus", "ZMinus"].map((f) => vtk.child(cube, `Get${f}FaceProperty`));
    for (const fp of faceProps) {
      vtk.call(fp, "SetColor", 1, 1, 1);
      vtk.call(fp, "SetAmbient", 1);
      vtk.call(fp, "SetDiffuse", 0);
    }
    vtk.call(ren, "AddActor", vtk.ref(cube));

    const axes = vtk.create("vtkAxesActor");
    vtk.call(axes, "SetTotalLength", 1.15, 1.15, 1.15);
    vtk.call(axes, "SetShaftTypeToCylinder");
    vtk.call(axes, "SetXAxisLabelText", "");
    vtk.call(axes, "SetYAxisLabelText", "");
    vtk.call(axes, "SetZAxisLabelText", "");
    vtk.call(axes, "SetPickable", false);
    const axisProps: number[] = [];
    ["X", "Y", "Z"].forEach((a, i) => {
      for (const part of ["Shaft", "Tip"]) {
        const p = vtk.child(axes, `Get${a}Axis${part}Property`);
        vtk.call(p, "SetColor", ...AXIS_RGB[i]);
        axisProps.push(p);
      }
    });
    vtk.call(ren, "AddActor", vtk.ref(axes));

    let vp: [number, number, number, number] = [0, 0.85, 0.15, 1];
    const place = (): void => {
      // vtk.js widget: 15% of the smaller canvas dimension, clamped to 80..160 canvas px, top-left.
      const w = canvas.width;
      const h = canvas.height;
      const s = Math.min(160, Math.max(80, 0.15 * Math.min(w, h)));
      vp = [0, Math.max(0, 1 - s / h), Math.min(1, s / w), 1];
      vtk.call(ren, "SetViewport", ...vp);
    };
    const sync = (): void => {
      // The marker is created before the first pane (as with vtk.js), so the
      // focused view may not exist yet; it follows on the next render.
      let v: WasmView | undefined;
      try {
        v = getView() as WasmView | undefined;
      } catch {
        return;
      }
      if (!v) return;
      const dop = v.camera.getDirectionOfProjection();
      const up = v.camera.getViewUp();
      cam.setPose({ focalPoint: [0, 0, 0], position: [-dop[0] * MARKER_DISTANCE, -dop[1] * MARKER_DISTANCE, -dop[2] * MARKER_DISTANCE], viewUp: up });
      vtk.call(ren, "ResetCameraClippingRange");
    };
    const onDown = (e: PointerEvent): void => {
      const r = cssRect();
      if (r.width <= 0 || r.height <= 0) return;
      const [x, y] = displayPos(e);
      const nx = x / r.width;
      const ny = y / r.height;
      if (nx < vp[0] || nx > vp[2] || ny < vp[1] || ny > vp[3]) return;
      // Like the vtk.js widget: a click on the marker never starts a camera drag.
      e.stopImmediatePropagation();
      sync();
      const ndc: [number, number] = [((nx - vp[0]) / (vp[2] - vp[0])) * 2 - 1, ((ny - vp[1]) / (vp[3] - vp[1])) * 2 - 1];
      const aspect = ((vp[2] - vp[0]) * r.width) / ((vp[3] - vp[1]) * r.height);
      const ray = viewRay(cam.pose(), { parallelProjection: false, parallelScale: 1, viewAngle: 30, clippingRange: [0.1, 100] }, aspect, ndc);
      const normal = cubeFaceHit(ray.origin, ray.dir, 0.5);
      if (normal) onSnap(normal);
    };
    canvas.addEventListener("pointerdown", onDown, true);
    cam.setViewAngle(30);
    place();
    sync();
    return {
      sync,
      place,
      updateTheme(t: string): void {
        // The marker carries no theme-dependent labels (the faces are always
        // white on blue); re-render so a theme switch is reflected at once.
        void t;
        renderNow();
      },
      dispose(): void {
        canvas.removeEventListener("pointerdown", onDown, true);
        vtk.call(rw, "RemoveRenderer", vtk.ref(ren));
        for (const id of [...faceProps, ...axisProps, cubeProp, axes, cube, camId, ren]) vtk.free(id);
      },
    };
  };

  resize();

  const backend: RenderBackend = {
    kind: "vtkwasm",
    caps,
    canvas,
    firstView,
    createView(vp: PaneViewport): RView {
      const v = makeView();
      v.setViewport(...vp);
      return v;
    },
    createGeometry(data: DisplayGeometry): RGeometry {
      const { pd, owned } = buildPolyData(vtk, data);
      return new WasmGeometry(vtk, "mesh", pd, owned, data);
    },
    createGlyphGeometry(set: GlyphSet): RGeometry {
      const pd = vtk.create("vtkPolyData");
      const pts = vtk.create("vtkPoints");
      const pa = vtk.upload(set.anchors, 3, "Points");
      vtk.call(pts, "SetData", vtk.ref(pa));
      vtk.call(pd, "SetPoints", vtk.ref(pts));
      const owned = [pts, pa];
      const pointData = vtk.child(pd, "GetPointData");
      for (const a of set.arrays) {
        const arr = vtk.upload(a.values, a.components, a.name);
        if (a.role === "vectors") vtk.call(pointData, "SetVectors", vtk.ref(arr));
        else if (a.role === "scalars") vtk.call(pointData, "SetScalars", vtk.ref(arr));
        else vtk.call(pointData, "AddArray", vtk.ref(arr));
        owned.push(arr);
      }
      vtk.free(pointData);
      const src = glyphSource(vtk, set);
      owned.push(...src.owned, src.pd);
      return new WasmGeometry(vtk, "glyphs", pd, owned, undefined, { set, source: src.pd });
    },
    createProp(): RProp {
      return new WasmProp(vtk, propRegistry);
    },
    createPlane(): RPlane {
      return new WasmPlane(vtk);
    },
    pick(view: RView, cssX: number, cssYFromBottom: number): PickHit<RProp> | undefined {
      const r = cssRect();
      const sx = r.width > 0 ? canvas.width / r.width : 1;
      const sy = r.height > 0 ? canvas.height / r.height : 1;
      let hit = 0;
      for (const tol of PICK_TOLERANCES) {
        vtk.call(picker, "SetTolerance", tol);
        hit = Number(vtk.call(picker, "Pick", cssX * sx, cssYFromBottom * sy, 0, vtk.ref((view as WasmView).ren)));
        if (hit) break;
      }
      if (!hit) return undefined;
      // GetActor answers with the actor's state; its Id is one of OUR actors
      // (already registered), so it is looked up and never released here.
      const st = vtk.call(picker, "GetActor");
      const prop = st && typeof st === "object" && "Id" in st ? propRegistry.get(Number(st.Id)) : undefined;
      if (!prop) return undefined;
      return { prop, cellId: Number(vtk.call(picker, "GetCellId")), position: vec3(vtk.call(picker, "GetPickPosition")) };
    },
    worldToDisplay(view: RView, x: number, y: number, z: number): [number, number] {
      const ren = (view as WasmView).ren;
      vtk.call(ren, "SetWorldPoint", x, y, z, 1);
      vtk.call(ren, "WorldToDisplay");
      const d = toNumbers(vtk.call(ren, "GetDisplayPoint"));
      const r = cssRect();
      const sx = r.width > 0 ? canvas.width / r.width : dpr();
      const sy = r.height > 0 ? canvas.height / r.height : dpr();
      return [(d[0] ?? 0) / sx, (canvas.height - (d[1] ?? 0)) / sy];
    },
    pokedView(): RView | undefined {
      return poked;
    },
    setInteractionMode(m: "rotate" | "pan"): void {
      mode = m;
    },
    createOrientationMarker(getView: () => RView, onSnap: (normal: Vec3) => void, theme: string): OrientationMarker {
      marker?.dispose();
      marker = createMarker(getView, onSnap, theme);
      return marker;
    },
    resize,
    render: renderNow,
    async captureImage(): Promise<string> {
      renderNow();
      // Same task as the draw: the drawing buffer is not preserved (G0.7).
      return canvas.toDataURL("image/png");
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      marker?.dispose();
      vtk.releaseAll();
      try {
        session.delete?.();
      } catch {
        /* already gone */
      }
      delete M.specialHTMLTargets[key];
      canvas.remove();
    },
  };
  return backend;
}
