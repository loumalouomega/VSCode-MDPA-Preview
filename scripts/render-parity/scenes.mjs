// Render-parity scene catalog (roadmap item 18). Each scene is a harness
// environment (which mesh the harness loads) plus a list of UI actions, and
// is captured as a PNG of #render-root plus a JSON sidecar by capture.mjs.
//
// The catalog is the Phase 2 regression net: every renderer-boundary
// extraction step must reproduce these captures pixel for pixel with the
// vtk.js backend, and Phase 5 compares the VTK-wasm backend against them
// within stated tolerances. Scenes drive the REAL webview bundle through the
// same messages and DOM controls a user would; nothing reaches into renderer
// internals, which is what lets the same scenes run against either backend.
//
// Action DSL (executed in order, each followed by a short settle):
//   { ui: "<toolbar action>" }            -> host->webview uiAction message
//   { msg: {...} }                        -> any host->webview message
//   { click: "<playwright selector>" }
//   { canvasClick: [fx, fy] }             -> click at a fraction of #render-root
//   { key: "<key>" }                      -> keyboard press on the body
//   { select: ["<selector>", "<value>"] } -> choose an <option> by value
//   { wait: ms }

export const ENVS = {
  arch: {},
  fields: { HARNESS_SCENE: "panefields" },
  vectors: { HARNESS_MESH: "example/VTK/Main_0_6.vtk" },
  spheres: { HARNESS_SCENE: "spheres", HARNESS_VARY: "1" },
  beams: { HARNESS_MESH: "src/test/fixtures/mdpa/beam_frame.mdpa" },
  small: { HARNESS_SCENE: "op", HARNESS_OP: "reorder" },
  surface: { HARNESS_MESH: "example/VTK-XML/house.vtu" },
  badquality: { HARNESS_SCENE: "badquality" },
};

const modeBtn = (label) => `#field-panel .field-mode-btn:has-text("${label}")`;

export const SCENES = [
  // --- base display -------------------------------------------------------
  { id: "a01-initial", env: "arch", actions: [] },
  { id: "a02-wireframe", env: "arch", actions: [{ ui: "wireframe" }] },
  { id: "a03-edges-off", env: "arch", actions: [{ ui: "edges" }] },
  { id: "a04-grid", env: "arch", actions: [{ ui: "grid" }] },
  { id: "a05-ortho", env: "arch", actions: [{ ui: "parallelProjection" }] },
  { id: "a06-view-plus-x", env: "arch", actions: [{ key: "1" }] },
  { id: "a07-view-iso", env: "arch", actions: [{ key: "i" }] },
  // --- clipping -----------------------------------------------------------
  { id: "a10-clip-z", env: "arch", actions: [{ ui: "cut" }] },
  { id: "a11-clip-x", env: "arch", actions: [{ ui: "cut" }, { click: '#cut-axes label:has(input[value="0"])' }] },
  { id: "a12-clip-wire", env: "arch", actions: [{ ui: "cut" }, { ui: "wireframe" }] },
  // --- split view ---------------------------------------------------------
  { id: "a20-split-2x2", env: "arch", actions: [{ ui: "layout:2x2" }] },
  { id: "a21-split-1x2-clip", env: "arch", actions: [{ ui: "layout:1x2" }, { ui: "cut" }] },
  { id: "a22-split-2x1-grid", env: "arch", actions: [{ ui: "layout:2x1" }, { ui: "grid" }] },
  // --- analysis overlays --------------------------------------------------
  { id: "a30-normals", env: "surface", actions: [{ ui: "normals" }] },
  { id: "a31-quality-highlight", env: "badquality", actions: [{ ui: "quality" }, { click: "#quality-panel .quality-highlight-btn >> nth=0" }] },
  { id: "a32-meshsize-nodal", env: "arch", actions: [{ ui: "meshSize" }, { click: '#meshsize-panel button:has-text("Nodal (NODAL_H)")' }] },
  { id: "a33-find-element", env: "arch", actions: [{ msg: { type: "locateEntity", entityType: "Element", entityId: 1 } }] },
  // --- picking (sidecar records the Inspect panel) -------------------------
  { id: "a40-inspect-center", env: "arch", actions: [{ ui: "inspect" }, { canvasClick: [0.5, 0.5] }], record: ["#inspect-panel"] },
  { id: "a41-inspect-offcenter", env: "arch", actions: [{ ui: "inspect" }, { canvasClick: [0.42, 0.58] }], record: ["#inspect-panel"] },
  { id: "a42-inspect-dpr2", env: "arch", dpr: 2, actions: [{ ui: "inspect" }, { canvasClick: [0.42, 0.58] }], record: ["#inspect-panel"] },
  // --- fields -------------------------------------------------------------
  { id: "b01-contour", env: "fields", actions: [{ ui: "field" }] },
  { id: "b02-iso", env: "fields", actions: [{ ui: "field" }, { click: modeBtn("Isosurface") }] },
  { id: "b03-threshold", env: "fields", actions: [{ ui: "field" }, { click: modeBtn("Threshold") }] },
  { id: "b04-scalarbar", env: "fields", actions: [{ ui: "field" }, { click: '#field-panel label:has-text("Show scalar bar in scene")' }] },
  { id: "b05-clip-field-cap", env: "fields", actions: [{ ui: "field" }, { ui: "cut" }] },
  { id: "b06-split-fields", env: "fields", actions: [{ ui: "layout:1x2" }, { ui: "field" }] },
  { id: "c01-quiver", env: "vectors", actions: [{ ui: "field" }, { select: ["#field-panel select.field-select >> nth=0", "Nodal:DISPLACEMENT"] }, { click: modeBtn("Quiver") }] },
  { id: "c02-deformed", env: "vectors", actions: [{ ui: "field" }, { click: modeBtn("Deformed") }] },
  // --- glyph meshes -------------------------------------------------------
  { id: "d01-spheres", env: "spheres", actions: [] },
  { id: "e01-beams", env: "beams", actions: [] },
  // --- labels -------------------------------------------------------------
  { id: "f01-node-ids", env: "small", actions: [{ ui: "nodeIds" }] },
];
