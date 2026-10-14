# Command Line

The **command line** is the one-row input at the bottom of every preview, directly above the status bar — the same row CAD-Preview has. Anything the toolbar, menus and sidebar forms can do can be typed there: every mesh operation, every view toggle and panel, the exports and the case actions.

```text
> translate dx=1 dy=0         (Tab completes, Enter runs, ? for help)
```

Press **`/`** anywhere in the viewport (or run **Kratos MDPA: Focus Command Line**, or **View ▾ ▸ Command line**) to focus it. The line to the right of the input shows the usage of the command you are typing, and afterwards the result of running it.

## Syntax

Three spellings, mixable per command:

| Form | Example |
|---|---|
| `verb key=value …` | `smooth method=taubin iterations=10 fixBoundary=false` |
| `verb {json}` — the CAD-Preview style | `translate {"dx": 1, "dz": 3}` |
| `verb value …` — positional, for the obvious parameter | `view top` · `rotate z 90` · `mergeNodes 1e-6` · `find Element 12` |

- A bare flag means `true` (`mergeMesh paths=a.mdpa weld`); booleans also take `true/false/on/off/yes/no`.
- Lists are comma separated or JSON (`inputs=A,B`, `lo=[0,0,0]`); id lists accept ranges (`ids=1,2,5-10`).
- Quote text with spaces: `fieldCalc expr="x*2 + y" location=Nodal output=F`.
- Names are case-insensitive and unique prefixes work (`transl dx=1`); an ambiguous prefix lists the candidates.
- A typo is caught before anything is sent: `translate dxx=1` answers *unknown parameter "dxx" — did you mean dx?*. (The host would silently drop an unknown key, so the command line checks it for you.)
- **Several steps** run one after another with `;`: `fieldCalc expr="x" location=Nodal output=d ; remesh mode=expr sizeExpr="0.1*d"`. Each step waits for the host's answer, so a later step sees the model the earlier one produced (the same behaviour as the MCP `mesh_transform` tool), and the sequence stops at the first failure. Every operation is its own undo entry.

## Keys

| Key | Action |
|---|---|
| `/` | focus the command line (from the viewport) |
| `Enter` | run |
| `Tab` / `Shift+Tab` | complete the command, then parameter names, enum values, field names, SubModelPart paths and block names from the open mesh; press again to cycle |
| `↑` / `↓` | command history (kept across sessions where the webview's storage is available) |
| `Esc` | cancel a running operation (a second press stops waiting); otherwise dismiss the help card, clear the input, then leave the line |

While you type here, the single-key view shortcuts (`1`–`6`, `i`) are not triggered. The line is disabled while a recording is in progress.

## Help

`help` shows the syntax, `help <command>` the usage and an example, `list` the commands by category (`list operation` for one category). `?` is a short alias: `?rotate`.

## What it does with a command

- **Mesh operations** are sent to the host exactly as the sidebar forms send them (`applyOp`), validated by the same code, recorded in the same operation history (undo, redo, partial revert, recipes) and marked as unsaved edits. A rejected operation is reported with the reason in the result line.
- **View, panel and toggle commands** call the same functions as the toolbar and menus. `wireframe`, `edges`, `grid`, `nodeIds`, `lod`, `flatParts`, `ortho`, `pan` and every panel take an optional `on`/`off` (`wireframe on`); without it they toggle.
- **File and export commands** (`open`, `save`, `export vtu`, `saveProblem`, …) open the same host dialogs as the menus — they take no path argument.

## Command reference

### Mesh operations

| Command | What it does |
|---|---|
| `linearToQuadratic` | Insert mid-edge nodes (linear to quadratic elements) |
| `linearize` | Drop mid-side nodes (quadratic to linear elements) |
| `simplexify` | Split hex/wedge/pyramid/quad cells into tetrahedra/triangles |
| `refine [levels=<int>] [select=<json>]` | Subdivide cells (uniformly, or selectively with a conforming closure) |
| `removeOrphanNodes` | Remove nodes referenced by no cell, part or constraint |
| `mergeNodes tolerance=<number>` | Weld nodes closer than a tolerance |
| `crop kind=<bbox\|plane> [lo=<vec3>] [hi=<vec3>] [point=<vec3>] [normal=<vec3>] [mode=<all\|any>]` | Keep the cells inside a box or on one side of a plane |
| `renumber [target=<all\|nodes\|entities>] [start=<int>]` | Compact ids into gapless runs |
| `reorder method=<rcm\|morton\|hilbert>` | Reorder node storage (rcm, morton, hilbert) |
| `partition nparts=<int> [method=<sfc\|kahip\|auto>] [createParts=<bool>]` | Attach a PARTITION_INDEX field (domain decomposition) |
| `scale [sx=<number>] [sy=<number>] [sz=<number>]` | Scale the mesh about the origin |
| `translate [dx=<number>] [dy=<number>] [dz=<number>]` | Translate the mesh |
| `rotate axis=<x\|y\|z> [angle=<number>] [cx=<number>] [cy=<number>] [cz=<number>]` | Rotate about an axis parallel to x, y or z |
| `deleteSubModelPart path=<part>` | Delete a SubModelPart and its entities |
| `renameSubModelPart path=<part> newName=<text>` | Rename a SubModelPart |
| `createSubModelPart parentPath=<text> name=<text>` | Create an empty SubModelPart (parentPath "" = top level) |
| `moveSubModelPart path=<part> newParentPath=<text>` | Move a SubModelPart under another parent |
| `mergeSubModelParts sourcePath=<part> targetPath=<part>` | Merge one SubModelPart into another |
| `regionAlgebra operation=<union\|intersection\|difference> inputs=<list> output=<text>` | Union/intersection/difference of SubModelParts into a new one |
| `addSubModelPartEntities path=<part> kind=<nodes\|elements\|conditions\|geometries\|constraints> ids=<ids>` | Add entities (by id) to a SubModelPart |
| `removeSubModelPartEntities path=<part> kind=<nodes\|elements\|conditions\|geometries\|constraints> ids=<ids>` | Remove entities (by id) from a SubModelPart |
| `createSubModelPartFromSelection parentPath=<text> name=<text> [elements=<ids>] [conditions=<ids>] [geometries=<ids>] [seed=<json>]` | Group entities (explicit ids or a selection seed) into a SubModelPart |
| `deleteEntities [elements=<ids>] [conditions=<ids>] [geometries=<ids>]` | Delete elements/conditions/geometries by id |
| `setProperty propertyId=<int> name=<text> value=<json>` | Set one Properties value |
| `createProperty [id=<int>] [name=<text>] [value=<json>]` | Create a Properties set (optionally with one value) |
| `cloneProperty propertyId=<int> [newId=<int>]` | Copy a Properties set to a fresh id |
| `deleteProperty propertyId=<int>` | Delete an unreferenced Properties set |
| `assignProperty propertyId=<int> [part=<part>] [kind=<Elements\|Conditions\|Geometries>] [ids=<ids>]` | Point cells at a Properties id (by SubModelPart or explicit ids) |
| `fieldCalc expr=<text> location=<Nodal\|Elemental\|Conditional> output=<text>` | Compute a new field from a formula |
| `averageField variable=<field> direction=<nodalToElemental\|elementalToNodal> [target=<Elements\|Conditions>] [output=<text>]` | Move a field between nodes and cells by averaging |
| `renameField kind=<Nodal\|Elemental\|Conditional> variable=<field> newName=<text> [onConflict=<error\|overwrite>]` | Rename a field |
| `keepFields variables=<list> [kind=<Nodal\|Elemental\|Conditional>]` | Keep only the listed fields |
| `dropFields variables=<list> [kind=<Nodal\|Elemental\|Conditional>]` | Drop the listed fields |
| `conditionField kind=<Nodal\|Elemental\|Conditional> variable=<field> mode=<clamp\|normalize\|standardize> [lo=<number>] [hi=<number>] [nanReplacement=<number>] [scope=<component\|magnitude>] [nanPolicy=<ignore\|replace\|fail>] [output=<text>]` | Clamp / normalize / standardize a field |
| `convertFieldUnits variable=<field> [density=<number>] [densityField=<json>] [kind=<Nodal\|Elemental\|Conditional>] [output=<text>] [reference=<gauge\|absolute>]` | Convert kinematic pressure to Pa (explicit density) |
| `reduceField variable=<field> [kind=<Nodal\|Elemental\|Conditional>] reduction=<min\|max\|minAbs\|maxAbs\|mean\|std\|median\|sum\|count\|q1\|q3\|iqr> [output=<text>]` | Record a global scalar (min/max/mean/...) of a field |
| `writeMeshSizeFields target=<nodal\|element\|both>` | Persist NODAL_H / ELEMENT_H into the mesh |
| `markComponents [output=<text>] [fragmentFraction=<number>]` | Write COMPONENT_INDEX (connected bodies) |
| `fieldGradient variable=<field> [operator=<gradient\|divergence\|curl>] [method=<green-gauss\|least-squares>] [output=<text>]` | Gradient / divergence / curl of a nodal field |
| `fieldHessian variable=<field> [method=<green-gauss\|least-squares>] [output=<text>]` | Hessian of a scalar nodal field |
| `estimateError variable=<field> [marking=<none\|absolute\|fraction\|dorfler>] [markingValue=<number>] [output=<text>]` | Zienkiewicz-Zhu error indicator of a nodal field |
| `sdfDistance [path=<text>] [part=<part>] [skin=<bool>] [sign=<pseudonormal\|winding\|none>] [band=<number>] [output=<text>]` | Signed distance to a surface (file, SubModelPart or the mesh skin) |
| `transferField path=<text> [arrays=<list>] [onConflict=<error\|overwrite\|suffix>]` | Mass-preserving field transfer from another mesh file |
| `compareField path=<text> variable=<field> kind=<Nodal\|Elemental\|Conditional> [sourceVariable=<text>] [correspondence=<id\|spatial>] [output=<text>] [atol=<number>] [rtol=<number>]` | Difference field against another mesh file |
| `smooth [method=<laplacian\|taubin\|odt>] [iterations=<int>] [lambda=<number>] [mu=<number>] [fixBoundary=<bool>] [preserveFeatures=<bool>] [featureAngle=<number>] [guardInversion=<bool>]` | Taubin / Laplacian / ODT smoothing |
| `repairSurface [fixOrientation=<bool>] [orientOutward=<bool>] [fillHoles=<bool>] [splitNonManifold=<bool>] [maxHoleEdges=<int>] [weldTolerance=<number>]` | Fix winding, fill holes, weld a surface mesh |
| `curvature [mean=<bool>] [gaussian=<bool>] [principal=<bool>] [area=<bool>] [includeBoundary=<bool>] [dualArea=<mixed-voronoi\|barycentric>] [outputPrefix=<text>]` | Surface curvature fields (mean, gaussian, principal) |
| `shrinkwrap [path=<text>] [part=<part>] [skin=<bool>] [offset=<number>] [blend=<number>] [maxDistance=<number>] [movePart=<part>] [pinPart=<part>] [normalWeight=<angle\|area>] [recordDistance=<bool>]` | Project nodes onto a target surface (file, SubModelPart or skin) |
| `sobolevDeform variable=<field> lengthScale=<number> [fixedPart=<part>] [fixBoundary=<bool>] [maxIterations=<int>] [tolerance=<number>]` | Smooth deformation of the mesh from a displacement field |
| `surfaceRemesh [numClusters=<int>] [metric=<isotropic\|quadric\|anisotropic>] [gradation=<number>] [maxAnisotropy=<number>] [preserveBoundary=<bool>]` | Remesh a surface into N clusters |
| `volumeMesh [cellSize=<number>] [resolution=<text>] [paddingRelative=<number>] [warpFraction=<number>] [maxTets=<int>] [keepSurface=<bool>]` | Generate a tetrahedral volume mesh from a surface |
| `optimizeVolume [maxIterations=<int>] [minImprovement=<number>] [relocate=<bool>] [flip=<bool>] [preserveBoundary=<bool>]` | Flip/relocate to improve tetrahedra quality |
| `remesh [mode=<factor\|hsiz\|optimize\|expr\|aniso>] [factor=<number>] [hsiz=<number>] [sizeExpr=<text>] [sizeParts=<json>] [variable=<field>] [method=<green-gauss\|least-squares>] [distanceSurfacePath=<text>] [distanceSurfacePart=<part>] [distanceSurfaceSkin=<bool>] [frozen=<json>] [localSizes=<json>] [hmin=<number>] [hmax=<number>] [hausd=<number>] [hgrad=<number>] [angleDetection=<number>] [nosurf=<bool>] [noinsert=<bool>] [noswap=<bool>] [nomove=<bool>] [module=<mmg3d\|mmgs\|mmg2d>]` | MMG remesh (factor, hsiz, optimize, expr or aniso) |
| `levelset variable=<field> [isovalue=<number>] [isosurf=<bool>] [rmc=<number>] [keepMaterials=<bool>] [noSplit=<json>] [baseRefs=<json>] [hmin=<number>] [hmax=<number>] [hausd=<number>] [hgrad=<number>] [module=<mmg3d\|mmgs\|mmg2d>]` | MMG level-set split along an isovalue of a nodal field |
| `mergeMesh paths=<list> [weld=<bool>] [tolerance=<number>] [name=<text>]` | Merge other mesh files into this one |
| `setElementRadius value=<number> mode=<absolute\|multiply> [target=<part>]` | Set or scale the sphere-element RADIUS |

### History

| Command | What it does |
|---|---|
| `undo` | Undo the last operation |
| `redo` | Redo the last undone operation |
| `clear` | Clear the whole operation history |
| `revert index=<int>` | Revert the history to N applied operations |
| `reapply` | Re-apply the operations a timeline step skipped |
| `saveOps` | Save the applied operations as a JSON recipe |
| `loadOps` | Load and replay a JSON recipe |
| `cancel` | Cancel the running operation |

### View and camera

| Command | What it does |
|---|---|
| `reset` | Frame the whole mesh |
| `view name=<right\|left\|top\|bottom\|front\|back\|iso>` | Snap the camera to a standard view |
| `layout id=<1x1\|1x2\|2x1\|2x2>` | Split the viewport into 1, 2 or 4 panes |
| `wireframe [state=<on\|off>]` | Wireframe display |
| `edges [state=<on\|off>]` | Draw cell edges |
| `grid [state=<on\|off>]` | Cube axes grid |
| `nodeIds [state=<on\|off>]` | Node id labels (small meshes only) |
| `lod [state=<on\|off>]` | Level-of-detail surface preview |
| `flatParts [state=<on\|off>]` | Flat SubModelPart list in the outline |
| `ortho [state=<on\|off>]` | Parallel (orthographic) projection |
| `pan [state=<on\|off>]` | Pan mode for the left mouse button |
| `clip [state=<on\|off>] [axis=<x\|y\|z\|free>] [pos=<number>] [normal=<vec3>] [flip=<bool>]` | Clip plane of the focused pane |
| `opacity value=<number>` | Global model opacity (0..1) |
| `theme name=<text>` | Scene theme by name |
| `find type=<Node\|Element\|Condition\|Geometry> id=<int>` | Locate and highlight an entity by id |
| `screenshot` | Save a screenshot of the viewport |

### Panels

| Command | What it does |
|---|---|
| `quality [state=<on\|off>]` | Mesh quality panel |
| `field [state=<on\|off>]` | Field visualization panel |
| `inspect [state=<on\|off>]` | Click-to-probe Inspect mode |
| `selection [state=<on\|off>]` | Selection sets panel |
| `plots [state=<on\|off>]` | Scientific Plots pane |
| `meshSize [state=<on\|off>]` | Mesh size panel |
| `spheres [state=<on\|off>]` | Sphere/particle rendering panel |
| `beams [state=<on\|off>]` | Beam rendering panel |
| `normals [state=<on\|off>]` | Face normals overlay |
| `integrals [state=<on\|off>]` | Field integrals panel |
| `streamlines [state=<on\|off>]` | Streamlines panel |
| `flowBalance [state=<on\|off>]` | Boundary flow balance panel |
| `linkPreviews [state=<on\|off>]` | Link two previews |
| `compareSplit [state=<on\|off>]` | Compare a second mesh in a split pane |
| `exportReport [state=<on\|off>]` | Export report inspector |
| `dataTable [state=<on\|off>]` | Data table of nodes/entities |
| `record [state=<on\|off>]` | Video / frame-sequence recorder |
| `lighting [state=<on\|off>]` | Lighting controls |
| `propertiesEditor [state=<on\|off>]` | Properties editor |
| `bookmarks [state=<on\|off>]` | Camera bookmarks |

### Files and export

| Command | What it does |
|---|---|
| `open` | Open a mesh (host file dialog) |
| `save` | Save to the source format |
| `saveAs` | Save As (host file dialog) |
| `reload` | Reload from disk and replay the operations |
| `export format=<ext> [outputFormat=<text>]` | Export to a format (host save dialog) |
| `exportPart format=<ext> path=<part>` | Export one SubModelPart |
| `exportSkin` | Export the boundary skin |
| `exportPartitions` | Export one file per partition |
| `splitMesh` | Split into components/types/fields |
| `simplify` | Export a simplified surface copy |
| `sampleGrid` | Sample to a grid / voxelization / SDF volume |
| `exportTable format=<.csv\|.xlsx> kind=<Nodes\|Elements\|Conditions\|Geometries> [membership=<bool>] [submodelpart=<part>] [nodeColumns=<bool>]` | Export the data table as CSV/XLSX |
| `saveProblem` | Save the problem archive (.kratosproblem.zip) |
| `loadProblem` | Load a problem archive |

### Case (problemtype)

| Command | What it does |
|---|---|
| `generate` | Generate ProjectParameters/materials/MainKratos.py |
| `run` | Generate and run the Kratos solve |
| `stop` | Stop the running solve |
| `results` | Open the latest results |

### Help

| Command | What it does |
|---|---|
| `help [command=<text>]` | Show usage of a command (or a summary) |
| `list [category=<text>]` | List commands (optionally of one category) |


Mesh operation parameters are the ones in [Mesh Editing](./mesh-editing) and [MMG Remesh](./mmg-remeshing); a recipe or MCP `mesh_transform` call spells the same operations as JSON objects, so a command line and a recipe line are interchangeable (`translate {"dx":1}` is `{"op":"translate","dx":1}`).

## Not covered

- Path arguments for dialog-driven commands, and the Flowgraph editor (interactive, no text form).
- The command line is UI-only: it is a text front end over capabilities that MCP already exposes (`mesh_transform` for operations), so it adds no MCP tool.
