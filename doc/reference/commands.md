# Command reference

Every command accepted by the command line. The table below is generated from `COMMANDS` in `commandSpec.ts`; run `npm run docs:reference` after changing it.

<!-- BEGIN GENERATED: commands -->
### operation

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `linearToQuadratic` | Insert mid-edge nodes (linear to quadratic elements) | — | `linearToQuadratic` |
| `linearize` | Drop mid-side nodes (quadratic to linear elements) | — | `linearize` |
| `simplexify` | Split hex/wedge/pyramid/quad cells into tetrahedra/triangles | — | `simplexify` |
| `refine` | Subdivide cells (uniformly, or selectively with a conforming closure) | `levels` (int), `select` (json) | `refine levels=1` |
| `removeOrphanNodes` | Remove nodes referenced by no cell, part or constraint | — | `removeOrphanNodes` |
| `mergeNodes` | Weld nodes closer than a tolerance | `tolerance` (number, required) | `mergeNodes tolerance=1e-6` |
| `crop` | Keep the cells inside a box or on one side of a plane | `kind` (enum: bbox/plane, required), `lo` (vec3), `hi` (vec3), `point` (vec3), `normal` (vec3), `mode` (enum: all/any) | `crop kind=bbox lo=0,0,0 hi=1,1,1` |
| `renumber` | Compact ids into gapless runs | `target` (enum: all/nodes/entities), `start` (int) | `renumber target=all` |
| `addHangingNodeConstraints` | Tie every hanging node of a hexahedral/quad mesh to its edge or face masters (constraints) | `variables` (list) | `addHangingNodeConstraints variables=DISPLACEMENT_X,DISPLACEMENT_Y,DISPLACEMENT_Z` |
| `createConstraint` | Create one linear master-slave constraint | `slave` (int, required), `masters` (ids, required), `weights` (list, required), `variable` (string, required), `constant` (number), `part` (part) | `createConstraint slave=5 masters=1,2 weights=0.5,0.5 variable=DISPLACEMENT_X` |
| `deleteConstraint` | Delete constraints by id | `ids` (ids, required) | `deleteConstraint ids=1,2` |
| `reorder` | Reorder node storage (rcm, morton, hilbert) | `method` (enum: rcm/morton/hilbert, required) | `reorder method=rcm` |
| `partition` | Attach a PARTITION_INDEX field (domain decomposition) | `nparts` (int, required), `method` (enum: sfc/kahip/auto), `createParts` (bool) | `partition nparts=4` |
| `segment` | Label surface patches (SEGMENT_PATCH) by region growing between feature edges | `featureAngle` (number), `normalTolerance` (number), `curvatureTolerance` (number), `minPatchCells` (int), `method` (enum: angle/primitive), `tolerance` (number), `part` (part), `createParts` (bool) | `segment featureAngle=30 method=angle` |
| `refinePatches` | Refine SEGMENT_PATCH so primitives (plane, sphere, cylinder, cone, torus) explain each patch | `tolerance` (number), `relative` (bool), `normalWeight` (number), `epsilon` (number), `featureAngle` (number), `maxIterations` (int), `minPatchCells` (int), `ransacSeed` (int), `types` (json), `allowSplit` (bool), `allowMerge` (bool), `createParts` (bool) | `refinePatches tolerance=0.001 maxIterations=10` |
| `scale` | Scale about the origin (optionally only the nodes of a SubModelPart) | `sx` (number), `sy` (number), `sz` (number), `part` (part) | `scale sx=2 sy=2 sz=2` |
| `translate` | Translate the mesh (optionally only the nodes of a SubModelPart) | `dx` (number), `dy` (number), `dz` (number), `part` (part) | `translate dx=1 dy=0 dz=0` |
| `rotate` | Rotate about an axis parallel to x, y or z | `axis` (enum: x/y/z, required), `angle` (number), `cx` (number), `cy` (number), `cz` (number), `part` (part) | `rotate axis=z angle=90` |
| `deleteSubModelPart` | Delete a SubModelPart and its entities | `path` (part, required) | `deleteSubModelPart path=Inlet` |
| `renameSubModelPart` | Rename a SubModelPart | `path` (part, required), `newName` (string, required) | `renameSubModelPart path=Inlet newName=Inflow` |
| `createSubModelPart` | Create an empty SubModelPart (parentPath "" = top level) | `parentPath` (string, required), `name` (string, required) | `createSubModelPart parentPath="" name=Wall` |
| `moveSubModelPart` | Move a SubModelPart under another parent | `path` (part, required), `newParentPath` (string, required) | `moveSubModelPart path=Inlet newParentPath=Walls` |
| `mergeSubModelParts` | Merge one SubModelPart into another | `sourcePath` (part, required), `targetPath` (part, required) | `mergeSubModelParts sourcePath=A targetPath=B` |
| `regionAlgebra` | Union/intersection/difference of SubModelParts into a new one | `operation` (enum: union/intersection/difference, required), `inputs` (list, required), `output` (string, required) | `regionAlgebra operation=union inputs=A,B output=AB` |
| `addSubModelPartEntities` | Add entities (by id) to a SubModelPart | `path` (part, required), `kind` (enum: nodes/elements/conditions/geometries/constraints, required), `ids` (ids, required), `closure` (bool) | `addSubModelPartEntities path=Inlet kind=nodes ids=1,2,5-8` |
| `removeSubModelPartEntities` | Remove entities (by id) from a SubModelPart | `path` (part, required), `kind` (enum: nodes/elements/conditions/geometries/constraints, required), `ids` (ids, required) | `removeSubModelPartEntities path=Inlet kind=nodes ids=1,2` |
| `createSubModelPartFromSelection` | Group entities (explicit ids or a selection seed) into a SubModelPart | `parentPath` (string, required), `name` (string, required), `elements` (ids), `conditions` (ids), `geometries` (ids), `seed` (json) | `createSubModelPartFromSelection parentPath="" name=Picked elements=1,2,3` |
| `deleteEntities` | Delete elements/conditions/geometries by id | `elements` (ids), `conditions` (ids), `geometries` (ids) | `deleteEntities elements=1,2` |
| `setProperty` | Set one Properties value | `propertyId` (int, required), `name` (string, required), `value` (json, required) | `setProperty propertyId=1 name=YOUNG_MODULUS value=2.1e11` |
| `createProperty` | Create a Properties set (optionally with one value) | `id` (int), `name` (string), `value` (json) | `createProperty id=5` |
| `cloneProperty` | Copy a Properties set to a fresh id | `propertyId` (int, required), `newId` (int) | `cloneProperty propertyId=1` |
| `deleteProperty` | Delete an unreferenced Properties set | `propertyId` (int, required) | `deleteProperty propertyId=3` |
| `assignProperty` | Point cells at a Properties id (by SubModelPart or explicit ids) | `propertyId` (int, required), `part` (part), `kind` (enum: Elements/Conditions/Geometries), `ids` (ids) | `assignProperty propertyId=2 part=Inlet` |
| `fieldCalc` | Compute a new field from a formula | `expr` (string, required), `location` (enum: Nodal/Elemental/Conditional, required), `output` (string, required) | `fieldCalc expr="x*2+y" location=Nodal output=F` |
| `averageField` | Move a field between nodes and cells by averaging | `variable` (field, required), `direction` (enum: nodalToElemental/elementalToNodal, required), `target` (enum: Elements/Conditions), `output` (string) | `averageField variable=TEMPERATURE direction=nodalToElemental` |
| `renameField` | Rename a field | `kind` (enum: Nodal/Elemental/Conditional, required), `variable` (field, required), `newName` (string, required), `onConflict` (enum: error/overwrite) | `renameField kind=Nodal variable=A newName=B` |
| `keepFields` | Keep only the listed fields | `variables` (list, required), `kind` (enum: Nodal/Elemental/Conditional) | `keepFields variables=A,B` |
| `dropFields` | Drop the listed fields | `variables` (list, required), `kind` (enum: Nodal/Elemental/Conditional) | `dropFields variables=A,B` |
| `conditionField` | Clamp / normalize / standardize a field | `kind` (enum: Nodal/Elemental/Conditional, required), `variable` (field, required), `mode` (enum: clamp/normalize/standardize, required), `lo` (number), `hi` (number), `nanReplacement` (number), `scope` (enum: component/magnitude), `nanPolicy` (enum: ignore/replace/fail), `output` (string) | `conditionField kind=Nodal variable=T mode=clamp lo=0 hi=1` |
| `convertFieldUnits` | Convert kinematic pressure to Pa (explicit density) | `variable` (field, required), `density` (number), `densityField` (json), `kind` (enum: Nodal/Elemental/Conditional), `output` (string), `reference` (enum: gauge/absolute) | `convertFieldUnits variable=P density=1000` |
| `reduceField` | Record a global scalar (min/max/mean/...) of a field | `variable` (field, required), `kind` (enum: Nodal/Elemental/Conditional), `reduction` (enum: min/max/minAbs/maxAbs/mean/std/median/sum/count/q1/q3/iqr, required), `output` (string) | `reduceField variable=T reduction=max` |
| `writeMeshSizeFields` | Persist NODAL_H / ELEMENT_H into the mesh | `target` (enum: nodal/element/both, required) | `writeMeshSizeFields target=both` |
| `markComponents` | Write COMPONENT_INDEX (connected bodies) | `output` (string), `fragmentFraction` (number) | `markComponents` |
| `fieldGradient` | Gradient / divergence / curl of a nodal field | `variable` (field, required), `operator` (enum: gradient/divergence/curl), `method` (enum: green-gauss/least-squares), `output` (string) | `fieldGradient variable=T` |
| `fieldHessian` | Hessian of a scalar nodal field | `variable` (field, required), `method` (enum: green-gauss/least-squares), `output` (string) | `fieldHessian variable=T` |
| `estimateError` | Zienkiewicz-Zhu error indicator of a nodal field | `variable` (field, required), `marking` (enum: none/absolute/fraction/dorfler), `markingValue` (number), `output` (string) | `estimateError variable=T marking=fraction markingValue=0.3` |
| `sdfDistance` | Signed distance to a surface (file, SubModelPart or the mesh skin) | `path` (string), `part` (part), `skin` (bool), `sign` (enum: pseudonormal/winding/none), `band` (number), `output` (string) | `sdfDistance part=Wall` |
| `transferField` | Mass-preserving field transfer from another mesh file | `path` (string, required), `arrays` (list), `onConflict` (enum: error/overwrite/suffix) | `transferField path=other.vtu` |
| `compareField` | Difference field against another mesh file | `path` (string, required), `variable` (field, required), `kind` (enum: Nodal/Elemental/Conditional, required), `sourceVariable` (string), `correspondence` (enum: id/spatial), `output` (string), `atol` (number), `rtol` (number) | `compareField path=other.vtu variable=T kind=Nodal` |
| `smooth` | Taubin / Laplacian / ODT smoothing | `method` (enum: laplacian/taubin/odt), `iterations` (int), `lambda` (number), `mu` (number), `fixBoundary` (bool), `preserveFeatures` (bool), `featureAngle` (number), `guardInversion` (bool) | `smooth method=taubin iterations=10` |
| `repairSurface` | Fix winding, fill holes, weld a surface mesh | `fixOrientation` (bool), `orientOutward` (bool), `fillHoles` (bool), `splitNonManifold` (bool), `maxHoleEdges` (int), `weldTolerance` (number), `fillStyle` (enum: fan/flat/curved) | `repairSurface fillHoles=true fillStyle=curved` |
| `tessellate` | Split curved (quadratic) cells into linear triangles/tetrahedra | `levels` (int) | `tessellate levels=2` |
| `curvature` | Surface curvature fields (mean, gaussian, principal) | `mean` (bool), `gaussian` (bool), `principal` (bool), `area` (bool), `includeBoundary` (bool), `dualArea` (enum: mixed-voronoi/barycentric), `outputPrefix` (string) | `curvature mean=true gaussian=true` |
| `thickness` | Wall thickness (inward) or clearance (outward) per facet of a surface mesh, by ray casting | `direction` (enum: auto/inward/outward), `maxDistance` (number), `threshold` (number), `output` (string), `method` (enum: ray/sphere/cone), `coneAngle` (number), `coneRays` (number), `twoSided` (bool), `maxNormalDeviation` (number) | `thickness direction=inward threshold=0.2 method=cone` |
| `untangle` | Move nodes until no tetrahedron / hexahedron corner is inverted (connectivity kept) | `fixBoundary` (bool), `frozenPart` (part), `rings` (int), `smooth` (bool), `maxSweeps` (int) | `untangle fixBoundary=true` |
| `morph` | Morph the mesh: boundary nodes follow a displacement field, the interior follows harmonically | `variable` (field, required), `fixBoundary` (bool), `constrainedPart` (part), `stiffening` (number), `steps` (int), `allowInverted` (bool), `tolerance` (number), `maxIterations` (int) | `morph variable=DISPLACEMENT steps=2` |
| `registerRigid` | Register the mesh rigidly onto another mesh (ICP) and apply the transform | `path` (string, required), `method` (enum: point_to_point/point_to_plane), `maxIterations` (int), `tolerance` (number), `maxDistance` (number), `part` (part) | `registerRigid path=scan.stl` |
| `flipNormals` | Reverse the winding of every surface cell, or of one part's cells | `part` (part) | `flipNormals part=Skin` |
| `removeIslands` | Delete small disconnected pieces of a scan below a diagonal, area or cell-count threshold | `connectivity` (enum: edge/point), `minDiagonal` (number), `minArea` (number), `minCells` (int), `relative` (bool), `dryRun` (bool) | `removeIslands minDiagonal=0.05 dryRun=true` |
| `offsetSurface` | Move a surface along its normals so each face's plane shifts by a distance | `distance` (number, required), `smoothIterations` (int) | `offsetSurface distance=0.1` |
| `autoAlign` | Pose a scan on its largest flat face or cylinder axis | `angleTolerance` (number), `subdivisions` (int), `rotateVectorData` (bool) | `autoAlign` |
| `deviation` | Signed deviation of every scan point from a reference file or fitted primitive, as the nodal field DEVIATION | `path` (string), `primitive` (enum: plane/sphere/cylinder/cone/torus), `primitiveParams` (list), `tolerance` (number), `bins` (int), `maxNormalAngle` (number), `output` (string) | `deviation path=reference.stl tolerance=0.05` |
| `deviationRegions` | Group cells beyond a tolerance of a deviation field into excess / missing SubModelParts | `tolerance` (number, required), `field` (string), `prefix` (string), `minArea` (number) | `deviationRegions tolerance=0.1` |
| `registerLandmarks` | Rigidly lay picked landmark points of this mesh onto their targets | `source` (list, required), `target` (list, required), `weights` (list) | `registerLandmarks source=0,0,0,1,0,0,0,1,0 target=1,0,0,2,0,0,1,1,0` |
| `computeNormals` | Unit point normals of a surface as a nodal field | `weight` (enum: angle/area), `output` (string) | `computeNormals weight=area output=N` |
| `geodesicDistance` | Geodesic distance on a triangle surface from source nodes or a part | `sourceNodes` (ids), `sourcePart` (part), `timeFactor` (number), `tolerance` (number), `maxIterations` (int), `output` (string) | `geodesicDistance sourceNodes=1` |
| `laplacianEigenmodes` | Lowest Laplace-Beltrami eigenmodes of a triangle surface as nodal fields | `numModes` (int), `tolerance` (number), `maxIterations` (int), `output` (string) | `laplacianEigenmodes numModes=6` |
| `convertCoordinates` | Cylindrical / spherical components of nodal vector and tensor fields | `arrays` (list, required), `system` (enum: cylindrical/spherical), `axis` (vec3), `origin` (vec3), `reference` (vec3), `inverse` (bool), `recordCoordinates` (bool) | `convertCoordinates arrays=VELOCITY system=cylindrical axis=0,0,1` |
| `prepareMetric` | Intersect, normalise, clamp and grade metric fields for an MMG adapt | `arrays` (list, required), `output` (string), `targetVertices` (number), `norm` (number), `hmin` (number), `hmax` (number), `gradation` (number), `maxSweeps` (int) | `prepareMetric arrays=METRIC_H hmin=0.01 hmax=1` |
| `selectRegion` | Select cells or points by box, plane, sphere, data, quality, component or a grown patch into a SubModelPart | `name` (string, required), `kind` (enum: cell/point), `mode` (enum: all/any/centroid), `box` (json), `plane` (json), `sphere` (json), `where` (json), `quality` (json), `component` (int), `seed` (json), `featureAngle` (number), `normalTolerance` (number) | `selectRegion name=Top plane=[0,0,0,0,0,1] mode=centroid` |
| `projectToCad` | Move CAD-tagged surface nodes onto the B-rep of a .cad.json file | `path` (string, required), `faceField` (string), `edgeField` (string), `maxDistance` (number), `trimSamples` (int), `movePart` (part), `pinPart` (part) | `projectToCad path=part.cad.json` |
| `shrinkwrap` | Project nodes onto a target surface (file, SubModelPart or skin) | `path` (string), `part` (part), `skin` (bool), `offset` (number), `blend` (number), `maxDistance` (number), `movePart` (part), `pinPart` (part), `normalWeight` (enum: angle/area), `recordDistance` (bool) | `shrinkwrap part=Wall` |
| `sobolevDeform` | Smooth deformation of the mesh from a displacement field | `variable` (field, required), `lengthScale` (number, required), `fixedPart` (part), `fixBoundary` (bool), `maxIterations` (int), `tolerance` (number) | `sobolevDeform variable=DISPLACEMENT lengthScale=0.1` |
| `surfaceRemesh` | Remesh a surface into N clusters | `numClusters` (int), `metric` (enum: isotropic/quadric/anisotropic), `gradation` (number), `maxAnisotropy` (number), `preserveBoundary` (bool) | `surfaceRemesh numClusters=500` |
| `volumeMesh` | Generate a tetrahedral volume mesh from a surface | `cellSize` (number), `resolution` (string), `paddingRelative` (number), `warpFraction` (number), `maxTets` (int), `keepSurface` (bool) | `volumeMesh cellSize=0.1` |
| `optimizeVolume` | Flip/relocate to improve tetrahedra quality | `maxIterations` (int), `minImprovement` (number), `relocate` (bool), `flip` (bool), `preserveBoundary` (bool), `objective` (enum: energy/worst), `maxRingSize` (int) | `optimizeVolume objective=worst maxIterations=5` |
| `adaptVolume` | Adapt tetrahedra to a graded size field (collapse/split/swap/smooth) | `hmin` (number), `hmax` (number), `hgrad` (number), `hausd` (number), `hausdRelative` (bool), `sizeArray` (field), `curvatureSizing` (bool), `featureAngle` (number), `cornerAngle` (number), `maxNormalDeviation` (number), `preserveBoundary` (bool), `preserveFeatures` (bool), `qualityMetric` (enum: min_dihedral/mean_ratio/amips), `qualityMin` (number), `maxIterations` (int), `targetMinDihedral` (number), `collapse` (bool), `split` (bool), `swap` (bool), `smooth` (bool), `boundarySizing` (enum: input/geometry) | `adaptVolume hmin=0.1 hmax=0.5 hgrad=1.3` |
| `remesh` | MMG remesh (factor, hsiz, optimize, expr, aniso or wall) | `mode` (enum: factor/hsiz/optimize/expr/aniso/wall), `firstHeight` (number), `growth` (number), `tangentialSize` (number), `tangentialGrowth` (number), `maxAspect` (number), `factor` (number), `hsiz` (number), `sizeExpr` (string), `sizeParts` (json), `variable` (field), `method` (enum: green-gauss/least-squares), `distanceSurfacePath` (string), `distanceSurfacePart` (part), `distanceSurfaceSkin` (bool), `frozen` (json), `localSizes` (json), `hmin` (number), `hmax` (number), `hausd` (number), `hgrad` (number), `angleDetection` (number), `nosurf` (bool), `noinsert` (bool), `noswap` (bool), `nomove` (bool), `module` (enum: mmg3d/mmgs/mmg2d) | `remesh mode=factor factor=0.5` |
| `levelset` | MMG level-set split along an isovalue of a nodal field | `variable` (field, required), `isovalue` (number), `isosurf` (bool), `rmc` (number), `keepMaterials` (bool), `noSplit` (json), `baseRefs` (json), `hmin` (number), `hmax` (number), `hausd` (number), `hgrad` (number), `module` (enum: mmg3d/mmgs/mmg2d) | `levelset variable=SDF isovalue=0.1` |
| `mergeMesh` | Merge other mesh files into this one | `paths` (list, required), `weld` (bool), `tolerance` (number), `name` (string) | `mergeMesh paths=other.mdpa weld=true` |
| `setElementRadius` | Set or scale the sphere-element RADIUS | `value` (number, required), `mode` (enum: absolute/multiply, required), `target` (part) | `setElementRadius value=0.5 mode=absolute` |

### history

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `undo` | Undo the last operation | — | `undo` |
| `redo` | Redo the last undone operation | — | `redo` |
| `clear` | Clear the whole operation history | — | `clear` |
| `revert` | Revert the history to N applied operations | `index` (int, required) | `revert 2` |
| `reapply` | Re-apply the operations a timeline step skipped | — | `reapply` |
| `saveOps` | Save the applied operations as a JSON recipe | — | `saveOps` |
| `loadOps` | Load and replay a JSON recipe | — | `loadOps` |
| `cancel` | Cancel the running operation | — | `cancel` |

### view

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `reset` | Frame the whole mesh | — | `reset` |
| `view` | Snap the camera to a standard view | `name` (enum: right/left/top/bottom/front/back/iso, required) | `view top` |
| `layout` | Split the viewport into 1, 2 or 4 panes | `id` (enum: 1x1/1x2/2x1/2x2, required) | `layout 1x2` |
| `wireframe` | Wireframe display | `state` (enum: on/off) | `wireframe` |
| `edges` | Draw cell edges | `state` (enum: on/off) | `edges` |
| `grid` | Cube axes grid | `state` (enum: on/off) | `grid` |
| `nodeIds`, `nodeids` | Node id labels | `state` (enum: on/off) | `nodeIds` |
| `elementIds`, `elementids` | Element id labels at the cell centroids | `state` (enum: on/off) | `elementIds` |
| `conditionIds`, `conditionids` | Condition id labels at the cell centroids | `state` (enum: on/off) | `conditionIds` |
| `lod` | Level-of-detail surface preview | `state` (enum: on/off) | `lod` |
| `constraintLinks` | Draw slave→master links of the multi-point constraints | `state` (enum: on/off) | `constraintLinks` |
| `flatParts` | Flat SubModelPart list in the outline | `state` (enum: on/off) | `flatParts` |
| `ortho`, `parallelProjection` | Parallel (orthographic) projection | `state` (enum: on/off) | `ortho` |
| `pan` | Pan mode for the left mouse button | `state` (enum: on/off) | `pan` |
| `clip` | Clip plane of the focused pane | `state` (enum: on/off), `axis` (enum: x/y/z/free), `pos` (number), `normal` (vec3), `flip` (bool) | `clip on axis=x pos=0.5` |
| `labels` | Label nodes, elements or conditions by id, Properties id, SubModelPart or the active field | `target` (enum: node/element/condition), `source` (enum: id/propertyId/smp/field), `state` (enum: on/off) | `labels target=element source=id` |
| `mirror` | View-only mirror of the mesh about an axis-aligned plane (nothing is written) | `state` (enum: on/off), `axis` (enum: x/y/z), `side` (enum: min/max), `at` (number) | `mirror axis=x side=min` |
| `revolve` | View-only revolve of a 2D axisymmetric result about the x or y axis (nothing is written) | `state` (enum: on/off), `axis` (enum: x/y), `start` (number), `sweep` (number), `layers` (int) | `revolve axis=y sweep=360 layers=36` |
| `sector` | View-only repeat of a cyclic-symmetry sector about the x, y or z axis (nothing is written) | `state` (enum: on/off), `axis` (enum: x/y/z), `copies` (int), `angle` (number) | `sector axis=z copies=6` |
| `explode` | View-only exploded view: each top-level SubModelPart is moved away from the model centre (nothing is written) | `state` (enum: on/off), `factor` (number), `axis` (enum: x/y/z) | `explode factor=1.5 axis=z` |
| `opacity` | Global model opacity (0..1) | `value` (number, required) | `opacity 0.6` |
| `theme` | Scene theme by name | `name` (string, required) | `theme dark` |
| `find` | Locate and highlight an entity by id | `type` (enum: Node/Element/Condition/Geometry, required), `id` (int, required) | `find Element 12` |
| `screenshot` | Save a screenshot of the viewport | — | `screenshot` |

### panel

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `quality` | Mesh quality panel | `state` (enum: on/off) | `quality` |
| `field` | Field visualization panel | `state` (enum: on/off) | `field` |
| `inspect` | Click-to-probe Inspect mode | `state` (enum: on/off) | `inspect` |
| `selection` | Selection sets panel | `state` (enum: on/off) | `selection` |
| `plots` | Scientific Plots pane | `state` (enum: on/off) | `plots` |
| `plotField` | Plot a histogram of the field shown in the Field panel | — | `plotField` |
| `meshSize` | Mesh size panel | `state` (enum: on/off) | `meshSize` |
| `spheres` | Sphere/particle rendering panel | `state` (enum: on/off) | `spheres` |
| `beams` | Beam rendering panel | `state` (enum: on/off) | `beams` |
| `normals` | Face normals overlay | `state` (enum: on/off) | `normals` |
| `integrals` | Field integrals panel | `state` (enum: on/off) | `integrals` |
| `streamlines` | Streamlines panel | `state` (enum: on/off) | `streamlines` |
| `flowBalance` | Boundary flow balance panel | `state` (enum: on/off) | `flowBalance` |
| `recoverFlux` | Recovered flux panel (traction from nodal reactions) | `state` (enum: on/off) | `recoverFlux` |
| `aleQuality` | ALE mesh quality panel (per-frame element quality of the deformed mesh) | `state` (enum: on/off) | `aleQuality` |
| `windTunnel` | Virtual wind tunnel wizard: body, tunnel, flow, mesh, generate | `state` (enum: on/off) | `windTunnel` |
| `linkPreviews` | Link two previews | `state` (enum: on/off) | `linkPreviews` |
| `compareSplit` | Compare a second mesh in a split pane | `state` (enum: on/off) | `compareSplit` |
| `exportReport` | Export report inspector | `state` (enum: on/off) | `exportReport` |
| `dataTable` | Data table of nodes/entities | `state` (enum: on/off) | `dataTable` |
| `record` | Video / frame-sequence recorder | `state` (enum: on/off) | `record` |
| `lighting` | Lighting controls | `state` (enum: on/off) | `lighting` |
| `volume` | Volume view of a regular lattice | `state` (enum: on/off) | `volume` |
| `propertiesEditor` | Properties editor | `state` (enum: on/off) | `propertiesEditor` |
| `bookmarks` | Camera bookmarks | `state` (enum: on/off) | `bookmarks` |

### file

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `open` | Open a mesh (host file dialog, or a path) | `file` (string) | `open meshes/a.vtu` |
| `save` | Save to the source format | — | `save` |
| `saveAs` | Save As (host file dialog, or a path) | `to` (string), `overwrite` (bool) | `saveAs to=copy.vtu` |
| `reload` | Reload from disk and replay the operations | — | `reload` |
| `export` | Export to a format (host save dialog) | `format` (ext, required), `to` (string), `overwrite` (bool), `outputFormat` (string) | `export vtu to=out/a.vtu` |
| `exportPart` | Export one SubModelPart | `format` (ext, required), `path` (part, required), `to` (string), `overwrite` (bool) | `exportPart vtu Inlet to=inlet.vtu` |
| `exportSkin` | Export the boundary skin | `format` (ext), `to` (string), `overwrite` (bool) | `exportSkin stl to=skin.stl` |
| `exportPartitions` | Export one file per partition | — | `exportPartitions` |
| `splitMesh` | Split into components/types/fields | — | `splitMesh` |
| `simplify` | Export a simplified surface copy | — | `simplify` |
| `tessellateCurved` | Export a linear copy of the curved cells | — | `tessellateCurved` |
| `sampleGrid` | Sample to a grid / voxelization / SDF volume | — | `sampleGrid` |
| `kernelOp` | Extrude, revolve, mirror, boundary-layer, tetrahedralize or check the open mesh (new mesh) | — | `kernelOp` |
| `octreeMesh` | Write an octree tetrahedral/hexahedral volume mesh of the surface | — | `octreeMesh` |
| `cadSurface` | Triangulate the faces of the open CAD B-rep | — | `cadSurface` |
| `generateMesh` | Write a procedural mesh (rectangle, box, sphere, …) | — | `generateMesh` |
| `exportTable` | Export the data table as CSV/XLSX | `format` (enum: .csv/.xlsx, required), `kind` (enum: Nodes/Elements/Conditions/Geometries, required), `membership` (bool), `submodelpart` (part), `nodeColumns` (bool) | `exportTable .csv Nodes` |
| `saveProblem` | Save the problem archive (.kratosproblem.zip) | `to` (string), `overwrite` (bool) | `saveProblem to=case.kratosproblem.zip` |
| `loadProblem` | Load a problem archive | `file` (string), `into` (string) | `loadProblem case.kratosproblem.zip into=unpacked` |

### case

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `generate` | Generate ProjectParameters/materials/MainKratos.py | — | `generate` |
| `run` | Generate and run the Kratos solve | — | `run` |
| `stop` | Stop the running solve | — | `stop` |
| `results` | Open the latest results | — | `results` |

### help

| Command | Summary | Parameters | Example |
| --- | --- | --- | --- |
| `help`, `?` | Show usage of a command (or a summary) | `command` (string) | `help translate` |
| `list` | List commands (optionally of one category) | `category` (string) | `list operation` |
<!-- END GENERATED: commands -->
