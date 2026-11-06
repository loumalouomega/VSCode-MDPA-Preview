// Pure (import-free, bundled by both runtimes) description of the optional
// ribbon: tabs, groups and buttons. Every button reuses an existing
// `dispatchToolbarAction` action id, so a ribbon click behaves exactly like the
// toolbar / View / Advanced entry of the same name (and the command line), and
// no new handler is needed. `webview/ribbon.ts` renders this data.
//
// The ribbon is OFF by default in VS Code (`kratos.preview.ribbon`); hosts that
// want it on (KKSS) emit `data-ribbon="1"` on <body>.

/** Whether the ribbon is shown when neither the setting nor the document says otherwise. */
export const DEFAULT_RIBBON = false;

export const RIBBON_TABS = ["view", "results", "inspect", "mesh", "tools"] as const;
export type RibbonTabId = (typeof RIBBON_TABS)[number];
export const DEFAULT_RIBBON_TAB: RibbonTabId = "view";

export const RIBBON_TAB_LABELS: Record<RibbonTabId, string> = {
  view: "View",
  results: "Results",
  inspect: "Inspect",
  mesh: "Mesh",
  tools: "Tools",
};

export interface RibbonItem {
  /** A `dispatchToolbarAction` action id. */
  action: string;
  label: string;
  title: string;
  /** `ic:<TOOLBAR_ICONS id>` or `gl:<uiGlyphs id>`. */
  icon: string;
  /** Shows a pressed state mirrored from the action's toggle state. */
  toggle?: boolean;
}

export interface RibbonGroup {
  label: string;
  items: RibbonItem[];
}

const it = (action: string, label: string, title: string, icon: string, toggle = false): RibbonItem => ({
  action,
  label,
  title,
  icon,
  ...(toggle ? { toggle: true } : {}),
});

export const RIBBON_GROUPS: Record<RibbonTabId, RibbonGroup[]> = {
  view: [
    {
      label: "Camera",
      items: [
        it("reset", "Reset", "Reset camera", "ic:reset"),
        it("pan", "Pan", "Toggle pan mode", "ic:pan", true),
        it("parallelProjection", "Ortho", "Toggle perspective / orthographic projection", "ic:ortho", true),
        it("bookmarks", "Bookmarks", "Camera bookmarks", "ic:bookmark", true),
      ],
    },
    {
      label: "Display",
      items: [
        it("wireframe", "Wire", "Toggle wireframe display", "ic:wireframe", true),
        it("edges", "Edges", "Toggle mesh edge lines", "ic:wireframe", true),
        it("nodeIds", "Node IDs", "Toggle node ids", "ic:nodeIds", true),
        it("grid", "Grid", "Toggle background grid", "ic:grid", true),
        it("lod", "LOD", "Level of detail for big meshes", "ic:wireframe", true),
        it("curved", "Curved", "Draw quadratic cells curved (display only)", "ic:quadratic", true),
      ],
    },
    {
      label: "Layout",
      items: [
        it("layout:1x1", "Single", "One viewport", "ic:grid", true),
        it("layout:1x2", "Side", "Two viewports side by side", "ic:grid", true),
        it("layout:2x1", "Stacked", "Two viewports stacked", "ic:grid", true),
        it("layout:2x2", "Quad", "Four viewports", "ic:grid", true),
      ],
    },
    {
      label: "Symmetry",
      items: [
        it("mirror", "Mirror", "Mirror view (display only)", "ic:wireframe", true),
        it("revolve", "Revolve", "Revolve view of a 2D axisymmetric mesh (display only)", "ic:rotate", true),
        it("sector", "Sector", "Repeat a cyclic-symmetry sector (display only)", "ic:rotate", true),
      ],
    },
    {
      label: "Capture",
      items: [
        it("lighting", "Lighting", "Lighting and shading options", "ic:lighting", true),
        it("screenshot", "Screenshot", "Save the view as a PNG", "ic:screenshot"),
        it("record", "Record", "Record a video or PNG sequence", "ic:screenshot"),
      ],
    },
  ],
  results: [
    {
      label: "Field",
      items: [
        it("field", "Field", "Visualize field data", "ic:field", true),
        it("cut", "Clip", "Toggle the clipping plane", "ic:cut", true),
      ],
    },
    {
      label: "Data",
      items: [
        it("plots", "Plots", "Plot point histories and SubModelParts", "ic:results", true),
        it("dataTable", "Table", "Data table of nodes and entities", "ic:info", true),
      ],
    },
    {
      label: "Analysis",
      items: [
        it("streamlines", "Streamlines", "Trace streamlines of a vector field", "ic:fieldQuiver", true),
        it("integrals", "Integrals", "Field integrals over the mesh and SubModelParts", "ic:estimateError", true),
        it("flowBalance", "Flow", "Boundary flow balance and pressure drop", "ic:fieldContour", true),
      ],
    },
  ],
  inspect: [
    {
      label: "Pick",
      items: [
        it("inspect", "Inspect", "Click a node/element/condition to inspect it", "ic:inspect", true),
        it("find", "Find", "Find an entity by id", "ic:find", true),
        it("selection", "Selection", "Selection sets", "ic:catSelection", true),
      ],
    },
    {
      label: "Check",
      items: [
        it("quality", "Quality", "Compute mesh quality", "ic:quality", true),
        it("meshSize", "Mesh size", "Mesh size statistics", "ic:meshSize", true),
        it("normals", "Normals", "Show face normals", "ic:normals", true),
      ],
    },
    {
      label: "Properties",
      items: [it("propertiesEditor", "Properties", "Properties editor", "ic:material", true)],
    },
  ],
  mesh: [
    {
      label: "Derive",
      items: [
        it("simplify", "Simplify", "Export a simplified surface", "ic:simplexify"),
        it("tessellateCurved", "Tessellate", "Export a tessellated copy of curved cells", "ic:refine"),
        it("sampleGrid", "Grid", "Sample to a regular grid", "ic:grid"),
      ],
    },
    {
      label: "Export",
      items: [
        it("exportSkin", "Skin", "Export the boundary skin", "ic:export"),
        it("exportPartitions", "Partitions", "Export partitions", "ic:partition"),
        it("splitMesh", "Split", "Split the mesh", "ic:crop"),
      ],
    },
    {
      label: "Elements",
      items: [
        it("spheres", "Spheres", "Particle (sphere) rendering", "ic:spheres", true),
        it("beams", "Beams", "Beam (line member) rendering", "ic:beam", true),
        it("volume", "Volume", "Volume view of a regular lattice", "ic:view", true),
      ],
    },
  ],
  tools: [
    {
      label: "Command",
      items: [it("commandLine", "Command line", "Focus the command line", "ic:edit")],
    },
    {
      label: "Compare",
      items: [
        it("compareSplit", "Compare", "Compare in split view", "ic:merge", true),
        it("linkPreviews", "Link", "Link previews", "ic:mergeMesh", true),
      ],
    },
    {
      label: "Workflows",
      items: [
        it("windTunnel", "Wind tunnel", "Virtual wind tunnel wizard", "ic:ptFluid", true),
        it("exportReport", "Report", "Export report inspector", "ic:check", true),
      ],
    },
  ],
};

/** Actions that exist in `dispatchToolbarAction` but live in the nav dock, not the toolbar/menus. */
export const DOCK_ONLY_ACTIONS: readonly string[] = ["wireframe", "parallelProjection", "cut"];

export function sanitizeRibbonTab(v: unknown): RibbonTabId {
  return (RIBBON_TABS as readonly string[]).includes(v as string) ? (v as RibbonTabId) : DEFAULT_RIBBON_TAB;
}

export function parseRibbonSetting(v: unknown): boolean {
  return typeof v === "boolean" ? v : DEFAULT_RIBBON;
}

export function allRibbonItems(): RibbonItem[] {
  return RIBBON_TABS.flatMap((t) => RIBBON_GROUPS[t].flatMap((g) => g.items));
}
