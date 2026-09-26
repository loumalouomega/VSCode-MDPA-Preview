// Backend-neutral rendering data (roadmap item 18, renderer boundary).
//
// Everything the webview hands a renderer backend is PLAIN DATA of these
// shapes, built once by pure code (displayGeometry.ts, scalarColoring.ts) and
// consumed identically by the vtk.js and VTK-wasm backends. Pure: no DOM, no
// vtk — which is what makes the geometry/colour decisions Node-testable and
// is why this lives under src/parser/ (tsconfig.test.json covers src/**, not
// webview/**).

export type RendererKind = "vtkjs" | "vtkwasm";

export type Vec3 = [number, number, number];
export type RGB = [number, number, number];
export type Bounds6 = [number, number, number, number, number, number];

/** A named 1-component float array (point or cell data). */
export interface ScalarArray {
  name: string;
  values: Float32Array;
}

/**
 * Polydata in VTK's legacy cell layout — each cell array is `[n, i0 … in-1]*`
 * over local point indices — which is what vtk.js consumes directly and what
 * the VTK-wasm backend converts to offsets/connectivity (cellArrays.ts). Cells
 * enumerate verts, then lines, then polys: that order is what a picked cell id
 * and a cell-data array index into.
 */
export interface DisplayGeometry {
  points: Float32Array;
  verts?: Uint32Array;
  lines?: Uint32Array;
  polys?: Uint32Array;
  pointScalars?: ScalarArray;
  cellScalars?: ScalarArray;
}

export interface BuiltDisplayGeometry {
  geometry: DisplayGeometry;
  /** Local point index -> global node id (only when pick maps were requested). */
  pointGlobalIds?: Int32Array;
  /** Per emitted cell (verts -> lines -> polys) -> owning entity id, -1 for none. */
  cellEntityIds?: Int32Array;
}

/**
 * How a prop's mapper colours its geometry.
 *
 * - `none`: scalar colouring off; the property colour shows.
 * - `flat`: scalar colouring off AND the property colour set to `rgb` — the
 *   degenerate-range bypass (see scalarColoring.ts).
 * - `mapped`: a colour transfer function (flat `x,r,g,b` quadruples) over
 *   `range`, read from point or cell data, optionally from a named array
 *   (glyph mappers colour by an array other than the active scalars).
 */
export type ScalarColoring =
  | { kind: "none" }
  | { kind: "flat"; rgb: RGB }
  | {
      kind: "mapped";
      ctfPoints: number[];
      range: [number, number];
      association: "point" | "cell";
      interpolateBeforeMapping: boolean;
      /** Colour by this point array instead of the active scalars (glyphs). */
      arrayName?: string;
    };

/** Partial property update; omitted fields are left as they are. */
export interface PropStyle {
  color?: RGB;
  edgeVisible?: boolean;
  edgeColor?: RGB;
  /** 0 points, 1 wireframe, 2 surface. */
  representation?: 0 | 1 | 2;
  opacity?: number;
  pointSize?: number;
  lineWidth?: number;
  ambient?: number;
  diffuse?: number;
  specular?: number;
  backfaceCulling?: boolean;
}

/** A per-point array carried by a glyph set. */
export interface GlyphArray {
  name: string;
  values: Float32Array;
  components: 1 | 3;
  /** Which attribute slot it occupies (vectors/scalars) or a plain added array. */
  role: "vectors" | "scalars" | "array";
}

export type GlyphSource =
  | { kind: "arrow" }
  | { kind: "sphere"; resolution: number }
  /** A unit cylinder along +X (height 1, radius 0.5), capped. */
  | { kind: "cylinderX"; resolution: number };

/**
 * An instanced-glyph layer (quiver arrows, face normals, spheres, beam tubes):
 * one source shape per anchor, oriented by `orientationArray` (direction mode)
 * and scaled by `scaleArray` — by its magnitude, or per component in the
 * glyph's local frame (the beam case: `[length, d, d]`).
 */
export interface GlyphSet {
  anchors: Float32Array;
  arrays: GlyphArray[];
  source: GlyphSource;
  orientationArray?: string;
  scaleArray: string;
  scaleMode: "magnitude" | "components";
  scaleFactor: number;
}

export interface PickHit<P> {
  prop: P;
  /** Cell id in the prop's geometry (verts -> lines -> polys enumeration). */
  cellId: number;
  /** World position of the pick. */
  position: Vec3;
}
