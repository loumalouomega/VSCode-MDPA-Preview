/**
 * The command registry behind the preview's bottom command line ("command
 * mode"). Pure and import-free so the webview bundle and the Node tests share
 * ONE table: every mesh operation, view toggle, panel, export and case action
 * that the toolbar/menus/sidebar can reach is nameable here.
 *
 * A command is DATA — `exec` says what to do, it never holds a closure — so
 * `commandParse.ts` turns a typed line into a `CommandAction` that a test can
 * inspect, and the webview executor (`main.ts`) is a thin switch over it.
 *
 * Parameter grammar of `params` strings (one token per parameter):
 *   name[:type][(a|b|c)][!]
 * `type` defaults to `string`; `(a|b)` makes it an enum; `!` marks it required.
 * Types: number int bool string enum vec3 ids list json ext field part block.
 * `field`/`part`/`block` are strings that only differ for completion.
 */

export type ParamType =
  | "number"
  | "int"
  | "bool"
  | "string"
  | "enum"
  | "vec3"
  | "ids"
  | "list"
  | "json"
  | "ext"
  | "field"
  | "part"
  | "block";

export interface ParamSpec {
  name: string;
  type: ParamType;
  required?: boolean;
  values?: readonly string[];
}

export type CommandCategory =
  | "operation"
  | "history"
  | "view"
  | "panel"
  | "file"
  | "case"
  | "help";

export type CommandExec =
  /** `{type:"applyOp", op:<name>, ...args}` — validated by the host. */
  | { kind: "op" }
  /** A plain host message. `nest` moves the listed args into one sub-object. */
  | { kind: "post"; type: string; nest?: { key: string; args: readonly string[] } }
  /** `dispatchToolbarAction(action)`; an on/off `state` arg is honoured when the
   *  action has a `.active` toggle in the DOM. */
  | { kind: "ui"; action: string }
  /** A named webview-local setter implemented by the executor in `main.ts`. */
  | { kind: "view"; fn: ViewFn }
  | { kind: "meta"; fn: "help" | "list" };

export type ViewFn =
  | "standardView"
  | "layout"
  | "clip"
  | "opacity"
  | "theme"
  | "find"
  | "cancel";

export interface CommandSpec {
  name: string;
  aliases?: readonly string[];
  category: CommandCategory;
  summary: string;
  params: readonly ParamSpec[];
  /** Bare tokens fill these parameters, in order (`view top`, `find Element 12`). */
  positional?: readonly string[];
  exec: CommandExec;
  /** A full, valid command line; the drift tests run it through the parser. */
  example: string;
}

/** What a parsed command asks the webview to do. */
export type CommandAction =
  | { kind: "op"; op: string; message: Record<string, unknown> }
  | { kind: "post"; message: Record<string, unknown> }
  | { kind: "ui"; action: string; state?: boolean }
  | { kind: "view"; fn: ViewFn; args: Record<string, unknown> }
  | { kind: "meta"; fn: "help" | "list"; args: Record<string, unknown> };

/** Standard views: name -> viewing direction (the keyboard shortcuts 1-6/i). */
export const STANDARD_VIEW_DIRECTIONS: Readonly<Record<string, readonly [number, number, number]>> = {
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
  iso: [1, 1, 1],
};

export const LAYOUT_IDS = ["1x1", "1x2", "2x1", "2x2"] as const;

// ---- parameter DSL ----------------------------------------------------------

const PARAM_TYPES: ReadonlySet<string> = new Set<ParamType>([
  "number",
  "int",
  "bool",
  "string",
  "enum",
  "vec3",
  "ids",
  "list",
  "json",
  "ext",
  "field",
  "part",
  "block",
]);

export function parseParamDsl(dsl: string): ParamSpec[] {
  const out: ParamSpec[] = [];
  for (const tok of dsl.split(/\s+/).filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::([a-z0-9]+))?(?:\(([^)]*)\))?(!)?$/.exec(tok);
    if (!m) throw new Error(`bad param token "${tok}"`);
    const [, name, typeRaw, enumRaw, bang] = m;
    const spec: ParamSpec = { name, type: "string" };
    if (enumRaw !== undefined) {
      spec.type = "enum";
      spec.values = enumRaw.split("|");
    } else if (typeRaw !== undefined) {
      if (!PARAM_TYPES.has(typeRaw)) throw new Error(`bad param type "${typeRaw}" in "${tok}"`);
      spec.type = typeRaw as ParamType;
    }
    if (bang) spec.required = true;
    out.push(spec);
  }
  return out;
}

function cmd(
  name: string,
  category: CommandCategory,
  summary: string,
  params: string,
  exec: CommandExec,
  example: string,
  extra: { positional?: readonly string[]; aliases?: readonly string[] } = {}
): CommandSpec {
  return { name, category, summary, params: parseParamDsl(params), exec, example, ...extra };
}

const op = (
  name: string,
  summary: string,
  params: string,
  example: string,
  positional?: readonly string[]
): CommandSpec => cmd(name, "operation", summary, params, { kind: "op" }, example, { positional });

const post = (
  name: string,
  category: CommandCategory,
  summary: string,
  type: string,
  params = "",
  example = name,
  extra: { positional?: readonly string[]; aliases?: readonly string[] } = {}
): CommandSpec => cmd(name, category, summary, params, { kind: "post", type }, example, extra);

const ui = (
  name: string,
  category: CommandCategory,
  summary: string,
  action: string,
  opts: { toggle?: boolean; aliases?: readonly string[] } = {}
): CommandSpec =>
  cmd(
    name,
    category,
    summary,
    opts.toggle === false ? "" : "state:enum(on|off)",
    { kind: "ui", action },
    name,
    { positional: opts.toggle === false ? undefined : ["state"], aliases: opts.aliases }
  );

const GM = "green-gauss|least-squares";
const LOC = "Nodal|Elemental|Conditional";
const MMG_TUNING = "hmin:number hmax:number hausd:number hgrad:number";

// ---- mesh operations (every OpRecord) ---------------------------------------

const OPERATIONS: CommandSpec[] = [
  // Element order and topology
  op("linearToQuadratic", "Insert mid-edge nodes (linear to quadratic elements)", "", "linearToQuadratic"),
  op("linearize", "Drop mid-side nodes (quadratic to linear elements)", "", "linearize"),
  op("simplexify", "Split hex/wedge/pyramid/quad cells into tetrahedra/triangles", "", "simplexify"),
  op("refine", "Subdivide cells (uniformly, or selectively with a conforming closure)", "levels:int select:json", "refine levels=1", ["levels"]),
  op("removeOrphanNodes", "Remove nodes referenced by no cell, part or constraint", "", "removeOrphanNodes"),
  op("mergeNodes", "Weld nodes closer than a tolerance", "tolerance:number!", "mergeNodes tolerance=1e-6", ["tolerance"]),
  op("crop", "Keep the cells inside a box or on one side of a plane", "kind(bbox|plane)! lo:vec3 hi:vec3 point:vec3 normal:vec3 mode(all|any)", "crop kind=bbox lo=0,0,0 hi=1,1,1"),
  op("renumber", "Compact ids into gapless runs", "target(all|nodes|entities) start:int", "renumber target=all"),
  op("reorder", "Reorder node storage (rcm, morton, hilbert)", "method(rcm|morton|hilbert)!", "reorder method=rcm", ["method"]),
  op("partition", "Attach a PARTITION_INDEX field (domain decomposition)", "nparts:int! method(sfc|kahip|auto) createParts:bool", "partition nparts=4", ["nparts"]),
  // Transforms
  op("scale", "Scale the mesh about the origin", "sx:number sy:number sz:number", "scale sx=2 sy=2 sz=2"),
  op("translate", "Translate the mesh", "dx:number dy:number dz:number", "translate dx=1 dy=0 dz=0"),
  op("rotate", "Rotate about an axis parallel to x, y or z", "axis(x|y|z)! angle:number cx:number cy:number cz:number", "rotate axis=z angle=90", ["axis", "angle"]),
  // SubModelParts
  op("deleteSubModelPart", "Delete a SubModelPart and its entities", "path:part!", "deleteSubModelPart path=Inlet", ["path"]),
  op("renameSubModelPart", "Rename a SubModelPart", "path:part! newName!", "renameSubModelPart path=Inlet newName=Inflow", ["path", "newName"]),
  op("createSubModelPart", "Create an empty SubModelPart (parentPath \"\" = top level)", "parentPath! name!", "createSubModelPart parentPath=\"\" name=Wall", ["parentPath", "name"]),
  op("moveSubModelPart", "Move a SubModelPart under another parent", "path:part! newParentPath!", "moveSubModelPart path=Inlet newParentPath=Walls"),
  op("mergeSubModelParts", "Merge one SubModelPart into another", "sourcePath:part! targetPath:part!", "mergeSubModelParts sourcePath=A targetPath=B"),
  op("regionAlgebra", "Union/intersection/difference of SubModelParts into a new one", "operation(union|intersection|difference)! inputs:list! output!", "regionAlgebra operation=union inputs=A,B output=AB"),
  op("addSubModelPartEntities", "Add entities (by id) to a SubModelPart", "path:part! kind(nodes|elements|conditions|geometries|constraints)! ids:ids!", "addSubModelPartEntities path=Inlet kind=nodes ids=1,2,5-8"),
  op("removeSubModelPartEntities", "Remove entities (by id) from a SubModelPart", "path:part! kind(nodes|elements|conditions|geometries|constraints)! ids:ids!", "removeSubModelPartEntities path=Inlet kind=nodes ids=1,2"),
  op("createSubModelPartFromSelection", "Group entities (explicit ids or a selection seed) into a SubModelPart", "parentPath! name! elements:ids conditions:ids geometries:ids seed:json", "createSubModelPartFromSelection parentPath=\"\" name=Picked elements=1,2,3"),
  op("deleteEntities", "Delete elements/conditions/geometries by id", "elements:ids conditions:ids geometries:ids", "deleteEntities elements=1,2"),
  // Properties
  op("setProperty", "Set one Properties value", "propertyId:int! name! value:json!", "setProperty propertyId=1 name=YOUNG_MODULUS value=2.1e11"),
  op("createProperty", "Create a Properties set (optionally with one value)", "id:int name value:json", "createProperty id=5"),
  op("cloneProperty", "Copy a Properties set to a fresh id", "propertyId:int! newId:int", "cloneProperty propertyId=1", ["propertyId"]),
  op("deleteProperty", "Delete an unreferenced Properties set", "propertyId:int!", "deleteProperty propertyId=3", ["propertyId"]),
  op("assignProperty", "Point cells at a Properties id (by SubModelPart or explicit ids)", "propertyId:int! part:part kind(Elements|Conditions|Geometries) ids:ids", "assignProperty propertyId=2 part=Inlet"),
  // Fields
  op("fieldCalc", "Compute a new field from a formula", `expr! location(${LOC})! output!`, "fieldCalc expr=\"x*2+y\" location=Nodal output=F"),
  op("averageField", "Move a field between nodes and cells by averaging", "variable:field! direction(nodalToElemental|elementalToNodal)! target(Elements|Conditions) output", "averageField variable=TEMPERATURE direction=nodalToElemental"),
  op("renameField", "Rename a field", `kind(${LOC})! variable:field! newName! onConflict(error|overwrite)`, "renameField kind=Nodal variable=A newName=B"),
  op("keepFields", "Keep only the listed fields", `variables:list! kind(${LOC})`, "keepFields variables=A,B"),
  op("dropFields", "Drop the listed fields", `variables:list! kind(${LOC})`, "dropFields variables=A,B"),
  op("conditionField", "Clamp / normalize / standardize a field", `kind(${LOC})! variable:field! mode(clamp|normalize|standardize)! lo:number hi:number nanReplacement:number scope(component|magnitude) nanPolicy(ignore|replace|fail) output`, "conditionField kind=Nodal variable=T mode=clamp lo=0 hi=1"),
  op("convertFieldUnits", "Convert kinematic pressure to Pa (explicit density)", `variable:field! density:number densityField:json kind(${LOC}) output reference(gauge|absolute)`, "convertFieldUnits variable=P density=1000"),
  op("reduceField", "Record a global scalar (min/max/mean/...) of a field", `variable:field! kind(${LOC}) reduction(min|max|minAbs|maxAbs|mean|std|median|sum|count|q1|q3|iqr)! output`, "reduceField variable=T reduction=max"),
  op("writeMeshSizeFields", "Persist NODAL_H / ELEMENT_H into the mesh", "target(nodal|element|both)!", "writeMeshSizeFields target=both", ["target"]),
  op("markComponents", "Write COMPONENT_INDEX (connected bodies)", "output fragmentFraction:number", "markComponents"),
  op("fieldGradient", "Gradient / divergence / curl of a nodal field", `variable:field! operator(gradient|divergence|curl) method(${GM}) output`, "fieldGradient variable=T"),
  op("fieldHessian", "Hessian of a scalar nodal field", `variable:field! method(${GM}) output`, "fieldHessian variable=T"),
  op("estimateError", "Zienkiewicz-Zhu error indicator of a nodal field", "variable:field! marking(none|absolute|fraction|dorfler) markingValue:number output", "estimateError variable=T marking=fraction markingValue=0.3"),
  op("sdfDistance", "Signed distance to a surface (file, SubModelPart or the mesh skin)", "path part:part skin:bool sign(pseudonormal|winding|none) band:number output", "sdfDistance part=Wall"),
  op("transferField", "Mass-preserving field transfer from another mesh file", "path! arrays:list onConflict(error|overwrite|suffix)", "transferField path=other.vtu"),
  op("compareField", "Difference field against another mesh file", `path! variable:field! kind(${LOC})! sourceVariable correspondence(id|spatial) output atol:number rtol:number`, "compareField path=other.vtu variable=T kind=Nodal"),
  // Smoothing, quality, surface repair
  op("smooth", "Taubin / Laplacian / ODT smoothing", "method(laplacian|taubin|odt) iterations:int lambda:number mu:number fixBoundary:bool preserveFeatures:bool featureAngle:number guardInversion:bool", "smooth method=taubin iterations=10"),
  op("repairSurface", "Fix winding, fill holes, weld a surface mesh", "fixOrientation:bool orientOutward:bool fillHoles:bool splitNonManifold:bool maxHoleEdges:int weldTolerance:number", "repairSurface fillHoles=true"),
  op("curvature", "Surface curvature fields (mean, gaussian, principal)", "mean:bool gaussian:bool principal:bool area:bool includeBoundary:bool dualArea(mixed-voronoi|barycentric) outputPrefix", "curvature mean=true gaussian=true"),
  op("shrinkwrap", "Project nodes onto a target surface (file, SubModelPart or skin)", "path part:part skin:bool offset:number blend:number maxDistance:number movePart:part pinPart:part normalWeight(angle|area) recordDistance:bool", "shrinkwrap part=Wall"),
  op("sobolevDeform", "Smooth deformation of the mesh from a displacement field", "variable:field! lengthScale:number! fixedPart:part fixBoundary:bool maxIterations:int tolerance:number", "sobolevDeform variable=DISPLACEMENT lengthScale=0.1"),
  // Meshing
  op("surfaceRemesh", "Remesh a surface into N clusters", "numClusters:int metric(isotropic|quadric|anisotropic) gradation:number maxAnisotropy:number preserveBoundary:bool", "surfaceRemesh numClusters=500"),
  op("volumeMesh", "Generate a tetrahedral volume mesh from a surface", "cellSize:number resolution paddingRelative:number warpFraction:number maxTets:int keepSurface:bool", "volumeMesh cellSize=0.1"),
  op("optimizeVolume", "Flip/relocate to improve tetrahedra quality", "maxIterations:int minImprovement:number relocate:bool flip:bool preserveBoundary:bool", "optimizeVolume maxIterations=5"),
  op("remesh", "MMG remesh (factor, hsiz, optimize, expr or aniso)", `mode(factor|hsiz|optimize|expr|aniso) factor:number hsiz:number sizeExpr sizeParts:json variable:field method(${GM}) distanceSurfacePath distanceSurfacePart:part distanceSurfaceSkin:bool frozen:json localSizes:json ${MMG_TUNING} angleDetection:number nosurf:bool noinsert:bool noswap:bool nomove:bool module(mmg3d|mmgs|mmg2d)`, "remesh mode=factor factor=0.5"),
  op("levelset", "MMG level-set split along an isovalue of a nodal field", `variable:field! isovalue:number isosurf:bool rmc:number keepMaterials:bool noSplit:json baseRefs:json ${MMG_TUNING} module(mmg3d|mmgs|mmg2d)`, "levelset variable=SDF isovalue=0.1"),
  op("mergeMesh", "Merge other mesh files into this one", "paths:list! weld:bool tolerance:number name", "mergeMesh paths=other.mdpa weld=true"),
  op("setElementRadius", "Set or scale the sphere-element RADIUS", "value:number! mode(absolute|multiply)! target:part", "setElementRadius value=0.5 mode=absolute"),
];

// ---- history, view, panels, files, cases -------------------------------------

const HISTORY: CommandSpec[] = [
  post("undo", "history", "Undo the last operation", "opUndo"),
  post("redo", "history", "Redo the last undone operation", "opRedo"),
  post("clear", "history", "Clear the whole operation history", "opClear"),
  post("revert", "history", "Revert the history to N applied operations", "opRevertTo", "index:int!", "revert 2", { positional: ["index"] }),
  post("reapply", "history", "Re-apply the operations a timeline step skipped", "opReapply"),
  post("saveOps", "history", "Save the applied operations as a JSON recipe", "saveOps"),
  post("loadOps", "history", "Load and replay a JSON recipe", "loadOps"),
  cmd("cancel", "history", "Cancel the running operation", "", { kind: "view", fn: "cancel" }, "cancel"),
];

const VIEW: CommandSpec[] = [
  ui("reset", "view", "Frame the whole mesh", "reset", { toggle: false }),
  cmd(
    "view",
    "view",
    "Snap the camera to a standard view",
    `name:enum(${Object.keys(STANDARD_VIEW_DIRECTIONS).join("|")})!`,
    { kind: "view", fn: "standardView" },
    "view top",
    { positional: ["name"] }
  ),
  cmd("layout", "view", "Split the viewport into 1, 2 or 4 panes", `id:enum(${LAYOUT_IDS.join("|")})!`, { kind: "view", fn: "layout" }, "layout 1x2", { positional: ["id"] }),
  ui("wireframe", "view", "Wireframe display", "wireframe"),
  ui("edges", "view", "Draw cell edges", "edges"),
  ui("grid", "view", "Cube axes grid", "grid"),
  ui("nodeIds", "view", "Node id labels (small meshes only)", "nodeIds", { aliases: ["nodeids"] }),
  ui("lod", "view", "Level-of-detail surface preview", "lod"),
  ui("flatParts", "view", "Flat SubModelPart list in the outline", "flatParts"),
  ui("ortho", "view", "Parallel (orthographic) projection", "parallelProjection", { aliases: ["parallelProjection"] }),
  ui("pan", "view", "Pan mode for the left mouse button", "pan"),
  cmd(
    "clip",
    "view",
    "Clip plane of the focused pane",
    "state:enum(on|off) axis:enum(x|y|z|free) pos:number normal:vec3 flip:bool",
    { kind: "view", fn: "clip" },
    "clip on axis=x pos=0.5",
    { positional: ["state"] }
  ),
  cmd("opacity", "view", "Global model opacity (0..1)", "value:number!", { kind: "view", fn: "opacity" }, "opacity 0.6", { positional: ["value"] }),
  cmd("theme", "view", "Scene theme by name", "name!", { kind: "view", fn: "theme" }, "theme dark", { positional: ["name"] }),
  cmd(
    "find",
    "view",
    "Locate and highlight an entity by id",
    "type:enum(Node|Element|Condition|Geometry)! id:int!",
    { kind: "view", fn: "find" },
    "find Element 12",
    { positional: ["type", "id"] }
  ),
  ui("screenshot", "view", "Save a screenshot of the viewport", "screenshot", { toggle: false }),
];

const PANELS: CommandSpec[] = [
  ui("quality", "panel", "Mesh quality panel", "quality"),
  ui("field", "panel", "Field visualization panel", "field"),
  ui("inspect", "panel", "Click-to-probe Inspect mode", "inspect"),
  ui("selection", "panel", "Selection sets panel", "selection"),
  ui("plots", "panel", "Scientific Plots pane", "plots"),
  ui("meshSize", "panel", "Mesh size panel", "meshSize"),
  ui("spheres", "panel", "Sphere/particle rendering panel", "spheres"),
  ui("beams", "panel", "Beam rendering panel", "beams"),
  ui("normals", "panel", "Face normals overlay", "normals"),
  ui("integrals", "panel", "Field integrals panel", "integrals"),
  ui("streamlines", "panel", "Streamlines panel", "streamlines"),
  ui("flowBalance", "panel", "Boundary flow balance panel", "flowBalance"),
  ui("linkPreviews", "panel", "Link two previews", "linkPreviews"),
  ui("compareSplit", "panel", "Compare a second mesh in a split pane", "compareSplit"),
  ui("exportReport", "panel", "Export report inspector", "exportReport"),
  ui("dataTable", "panel", "Data table of nodes/entities", "dataTable"),
  ui("record", "panel", "Video / frame-sequence recorder", "record"),
  ui("lighting", "panel", "Lighting controls", "lighting"),
  ui("propertiesEditor", "panel", "Properties editor", "propertiesEditor"),
  ui("bookmarks", "panel", "Camera bookmarks", "bookmarks"),
];

const FILES: CommandSpec[] = [
  post("open", "file", "Open a mesh (host file dialog, or a path)", "menuOpen", "file:string", "open meshes/a.vtu", { positional: ["file"] }),
  post("save", "file", "Save to the source format", "menuSave"),
  post("saveAs", "file", "Save As (host file dialog)", "menuSaveAs"),
  post("reload", "file", "Reload from disk and replay the operations", "menuReload"),
  post("export", "file", "Export to a format (host save dialog)", "menuExport", "format:ext! to:string overwrite:bool outputFormat", "export vtu to=out/a.vtu", { positional: ["format"] }),
  post("exportPart", "file", "Export one SubModelPart", "menuExportPart", "format:ext! path:part! to:string overwrite:bool", "exportPart vtu Inlet to=inlet.vtu", { positional: ["format", "path"] }),
  post("exportSkin", "file", "Export the boundary skin", "menuExportSkin"),
  post("exportPartitions", "file", "Export one file per partition", "menuExportPartitions"),
  post("splitMesh", "file", "Split into components/types/fields", "menuSplitMesh"),
  post("simplify", "file", "Export a simplified surface copy", "menuExportSimplified"),
  post("sampleGrid", "file", "Sample to a grid / voxelization / SDF volume", "menuExportGrid"),
  {
    ...post("exportTable", "file", "Export the data table as CSV/XLSX", "menuExportTable", "format(.csv|.xlsx)! kind(Nodes|Elements|Conditions|Geometries)! membership:bool submodelpart:part nodeColumns:bool", "exportTable .csv Nodes", { positional: ["format", "kind"] }),
    exec: {
      kind: "post",
      type: "menuExportTable",
      nest: { key: "opts", args: ["membership", "submodelpart", "nodeColumns"] },
    },
  },
  post("saveProblem", "file", "Save the problem archive (.kratosproblem.zip)", "menuSaveProblem", "to:string overwrite:bool", "saveProblem to=case.kratosproblem.zip"),
  post("loadProblem", "file", "Load a problem archive", "menuLoadProblem"),
];

const CASES: CommandSpec[] = [
  post("generate", "case", "Generate ProjectParameters/materials/MainKratos.py", "ptGenerate"),
  post("run", "case", "Generate and run the Kratos solve", "ptRun"),
  post("stop", "case", "Stop the running solve", "ptStop"),
  post("results", "case", "Open the latest results", "ptOpenResults"),
];

const META: CommandSpec[] = [
  cmd("help", "help", "Show usage of a command (or a summary)", "command", { kind: "meta", fn: "help" }, "help translate", { positional: ["command"], aliases: ["?"] }),
  cmd("list", "help", "List commands (optionally of one category)", "category", { kind: "meta", fn: "list" }, "list operation", { positional: ["category"] }),
];

export const COMMANDS: readonly CommandSpec[] = [
  ...OPERATIONS,
  ...HISTORY,
  ...VIEW,
  ...PANELS,
  ...FILES,
  ...CASES,
  ...META,
];

export const COMMAND_CATEGORIES: readonly CommandCategory[] = [
  "operation",
  "history",
  "view",
  "panel",
  "file",
  "case",
  "help",
];

/** Names of every mesh operation that has a command (drift-tested vs OP_LABELS). */
export function operationCommandNames(): string[] {
  return COMMANDS.filter((c) => c.exec.kind === "op").map((c) => c.name);
}
