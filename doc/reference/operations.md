# Operation reference

Every mesh operation and its command line. Generated from `OP_LABELS` and `COMMANDS`; run `npm run docs:reference` after changing either.

<!-- BEGIN GENERATED: operations -->
| Operation | Label | Parameters | Example |
| --- | --- | --- | --- |
| `adaptVolume` | Adapt tetrahedra to a size field | `hmin` (number), `hmax` (number), `hgrad` (number), `hausd` (number), `hausdRelative` (bool), `sizeArray` (field), `curvatureSizing` (bool), `featureAngle` (number), `cornerAngle` (number), `maxNormalDeviation` (number), `preserveBoundary` (bool), `preserveFeatures` (bool), `qualityMetric` (enum: min_dihedral/mean_ratio/amips), `qualityMin` (number), `maxIterations` (int), `targetMinDihedral` (number), `collapse` (bool), `split` (bool), `swap` (bool), `smooth` (bool), `boundarySizing` (enum: input/geometry) | `adaptVolume hmin=0.1 hmax=0.5 hgrad=1.3` |
| `addHangingNodeConstraints` | Tie hanging nodes (constraints) | `variables` (list) | `addHangingNodeConstraints variables=DISPLACEMENT_X,DISPLACEMENT_Y,DISPLACEMENT_Z` |
| `addSubModelPartEntities` | Add entities to SubModelPart | `path` (part, required), `kind` (enum: nodes/elements/conditions/geometries/constraints, required), `ids` (ids, required), `closure` (bool) | `addSubModelPartEntities path=Inlet kind=nodes ids=1,2,5-8` |
| `assignProperty` | Assign property to entities | `propertyId` (int, required), `part` (part), `kind` (enum: Elements/Conditions/Geometries), `ids` (ids) | `assignProperty propertyId=2 part=Inlet` |
| `autoAlign` | Align a scan on its largest flat face or cylinder axis | `angleTolerance` (number), `subdivisions` (int), `rotateVectorData` (bool) | `autoAlign` |
| `averageField` | Average field (nodal ↔ elemental) | `variable` (field, required), `direction` (enum: nodalToElemental/elementalToNodal, required), `target` (enum: Elements/Conditions), `output` (string) | `averageField variable=TEMPERATURE direction=nodalToElemental` |
| `cloneProperty` | Clone Properties block | `propertyId` (int, required), `newId` (int) | `cloneProperty propertyId=1` |
| `compareField` | Compare a field with another mesh | `path` (string, required), `variable` (field, required), `kind` (enum: Nodal/Elemental/Conditional, required), `sourceVariable` (string), `correspondence` (enum: id/spatial), `output` (string), `atol` (number), `rtol` (number) | `compareField path=other.vtu variable=T kind=Nodal` |
| `computeNormals` | Point normals of a surface | `weight` (enum: angle/area), `output` (string) | `computeNormals weight=area output=N` |
| `conditionField` | Condition field (clamp / normalize / standardize) | `kind` (enum: Nodal/Elemental/Conditional, required), `variable` (field, required), `mode` (enum: clamp/normalize/standardize, required), `lo` (number), `hi` (number), `nanReplacement` (number), `scope` (enum: component/magnitude), `nanPolicy` (enum: ignore/replace/fail), `output` (string) | `conditionField kind=Nodal variable=T mode=clamp lo=0 hi=1` |
| `convertCoordinates` | Cylindrical / spherical components of fields | `arrays` (list, required), `system` (enum: cylindrical/spherical), `axis` (vec3), `origin` (vec3), `reference` (vec3), `inverse` (bool), `recordCoordinates` (bool) | `convertCoordinates arrays=VELOCITY system=cylindrical axis=0,0,1` |
| `convertFieldUnits` | Convert kinematic pressure to Pa | `variable` (field, required), `density` (number), `densityField` (json), `kind` (enum: Nodal/Elemental/Conditional), `output` (string), `reference` (enum: gauge/absolute) | `convertFieldUnits variable=P density=1000` |
| `createConstraint` | Create constraint | `slave` (int, required), `masters` (ids, required), `weights` (list, required), `variable` (string, required), `constant` (number), `part` (part) | `createConstraint slave=5 masters=1,2 weights=0.5,0.5 variable=DISPLACEMENT_X` |
| `createProperty` | Create Properties block | `id` (int), `name` (string), `value` (json) | `createProperty id=5` |
| `createSubModelPart` | Create SubModelPart | `parentPath` (string, required), `name` (string, required) | `createSubModelPart parentPath="" name=Wall` |
| `createSubModelPartFromSelection` | New SubModelPart from selection | `parentPath` (string, required), `name` (string, required), `elements` (ids), `conditions` (ids), `geometries` (ids), `seed` (json) | `createSubModelPartFromSelection parentPath="" name=Picked elements=1,2,3` |
| `crop` | Crop | `kind` (enum: bbox/plane, required), `lo` (vec3), `hi` (vec3), `point` (vec3), `normal` (vec3), `mode` (enum: all/any) | `crop kind=bbox lo=0,0,0 hi=1,1,1` |
| `curvature` | Surface curvature (mean / Gaussian / principal) | `mean` (bool), `gaussian` (bool), `principal` (bool), `area` (bool), `includeBoundary` (bool), `dualArea` (enum: mixed-voronoi/barycentric), `outputPrefix` (string) | `curvature mean=true gaussian=true` |
| `deleteConstraint` | Delete constraints | `ids` (ids, required) | `deleteConstraint ids=1,2` |
| `deleteEntities` | Delete selected entities | `elements` (ids), `conditions` (ids), `geometries` (ids) | `deleteEntities elements=1,2` |
| `deleteProperty` | Delete Properties block | `propertyId` (int, required) | `deleteProperty propertyId=3` |
| `deleteSubModelPart` | Delete SubModelPart | `path` (part, required) | `deleteSubModelPart path=Inlet` |
| `deviation` | Signed deviation from a reference surface or primitive | `path` (string), `primitive` (enum: plane/sphere/cylinder/cone/torus), `primitiveParams` (list), `tolerance` (number), `bins` (int), `maxNormalAngle` (number), `output` (string) | `deviation path=reference.stl tolerance=0.05` |
| `deviationRegions` | Excess / missing-material regions of a deviation field | `tolerance` (number, required), `field` (string), `prefix` (string), `minArea` (number) | `deviationRegions tolerance=0.1` |
| `dropFields` | Drop fields | `variables` (list, required), `kind` (enum: Nodal/Elemental/Conditional) | `dropFields variables=A,B` |
| `estimateError` | Error estimate (Zienkiewicz-Zhu) | `variable` (field, required), `marking` (enum: none/absolute/fraction/dorfler), `markingValue` (number), `output` (string) | `estimateError variable=T marking=fraction markingValue=0.3` |
| `fieldCalc` | Field calculator | `expr` (string, required), `location` (enum: Nodal/Elemental/Conditional, required), `output` (string, required) | `fieldCalc expr="x*2+y" location=Nodal output=F` |
| `fieldGradient` | Field gradient / divergence / curl | `variable` (field, required), `operator` (enum: gradient/divergence/curl), `method` (enum: green-gauss/least-squares), `output` (string) | `fieldGradient variable=T` |
| `fieldHessian` | Field Hessian (second derivative) | `variable` (field, required), `method` (enum: green-gauss/least-squares), `output` (string) | `fieldHessian variable=T` |
| `flipNormals` | Flip the winding of a surface (or a part) | `part` (part) | `flipNormals part=Skin` |
| `geodesicDistance` | Geodesic distance on a surface | `sourceNodes` (ids), `sourcePart` (part), `timeFactor` (number), `tolerance` (number), `maxIterations` (int), `output` (string) | `geodesicDistance sourceNodes=1` |
| `keepFields` | Keep only these fields | `variables` (list, required), `kind` (enum: Nodal/Elemental/Conditional) | `keepFields variables=A,B` |
| `laplacianEigenmodes` | Laplace-Beltrami eigenmodes of a surface | `numModes` (int), `tolerance` (number), `maxIterations` (int), `output` (string) | `laplacianEigenmodes numModes=6` |
| `levelset` | Level-set split (MMG) | `variable` (field, required), `isovalue` (number), `isosurf` (bool), `rmc` (number), `keepMaterials` (bool), `noSplit` (json), `baseRefs` (json), `hmin` (number), `hmax` (number), `hausd` (number), `hgrad` (number), `module` (enum: mmg3d/mmgs/mmg2d) | `levelset variable=SDF isovalue=0.1` |
| `linearToQuadratic` | Linear → Quadratic | — | `linearToQuadratic` |
| `linearize` | Quadratic → Linear | — | `linearize` |
| `markComponents` | Mark connected components | `output` (string), `fragmentFraction` (number) | `markComponents` |
| `mergeMesh` | Merge mesh | `paths` (list, required), `weld` (bool), `tolerance` (number), `name` (string) | `mergeMesh paths=other.mdpa weld=true` |
| `mergeNodes` | Merge coincident nodes | `tolerance` (number, required) | `mergeNodes tolerance=1e-6` |
| `mergeSubModelParts` | Merge SubModelParts | `sourcePath` (part, required), `targetPath` (part, required) | `mergeSubModelParts sourcePath=A targetPath=B` |
| `morph` | Morph the mesh by a boundary displacement | `variable` (field, required), `fixBoundary` (bool), `constrainedPart` (part), `stiffening` (number), `steps` (int), `allowInverted` (bool), `tolerance` (number), `maxIterations` (int) | `morph variable=DISPLACEMENT steps=2` |
| `moveSubModelPart` | Move SubModelPart | `path` (part, required), `newParentPath` (string, required) | `moveSubModelPart path=Inlet newParentPath=Walls` |
| `offsetSurface` | Offset a surface along its normals | `distance` (number, required), `smoothIterations` (int) | `offsetSurface distance=0.1` |
| `optimizeVolume` | Optimize tetrahedra (flips & relocation) | `maxIterations` (int), `minImprovement` (number), `relocate` (bool), `flip` (bool), `preserveBoundary` (bool), `objective` (enum: energy/worst), `maxRingSize` (int) | `optimizeVolume objective=worst maxIterations=5` |
| `partition` | Partition | `nparts` (int, required), `method` (enum: sfc/kahip/auto), `createParts` (bool) | `partition nparts=4` |
| `prepareMetric` | Prepare an MMG metric (intersect, clamp, grade) | `arrays` (list, required), `output` (string), `targetVertices` (number), `norm` (number), `hmin` (number), `hmax` (number), `gradation` (number), `maxSweeps` (int) | `prepareMetric arrays=METRIC_H hmin=0.01 hmax=1` |
| `projectToCad` | Project nodes onto the CAD B-rep | `path` (string, required), `faceField` (string), `edgeField` (string), `maxDistance` (number), `trimSamples` (int), `movePart` (part), `pinPart` (part) | `projectToCad path=part.cad.json` |
| `reduceField` | Global reduction (min/max/mean/…) | `variable` (field, required), `kind` (enum: Nodal/Elemental/Conditional), `reduction` (enum: min/max/minAbs/maxAbs/mean/std/median/sum/count/q1/q3/iqr, required), `output` (string) | `reduceField variable=T reduction=max` |
| `refine` | Refine | `levels` (int), `select` (json) | `refine levels=1` |
| `refinePatches` | Refine patches | `tolerance` (number), `relative` (bool), `normalWeight` (number), `epsilon` (number), `featureAngle` (number), `maxIterations` (int), `minPatchCells` (int), `ransacSeed` (int), `types` (json), `allowSplit` (bool), `allowMerge` (bool), `createParts` (bool) | `refinePatches tolerance=0.001 maxIterations=10` |
| `regionAlgebra` | Combine SubModelParts | `operation` (enum: union/intersection/difference, required), `inputs` (list, required), `output` (string, required) | `regionAlgebra operation=union inputs=A,B output=AB` |
| `registerLandmarks` | Register by landmark pairs | `source` (list, required), `target` (list, required), `weights` (list) | `registerLandmarks source=0,0,0,1,0,0,0,1,0 target=1,0,0,2,0,0,1,1,0` |
| `registerRigid` | Register onto another mesh (rigid ICP) | `path` (string, required), `method` (enum: point_to_point/point_to_plane), `maxIterations` (int), `tolerance` (number), `maxDistance` (number), `part` (part) | `registerRigid path=scan.stl` |
| `remesh` | Remesh (MMG) | `mode` (enum: factor/hsiz/optimize/expr/aniso/wall), `firstHeight` (number), `growth` (number), `tangentialSize` (number), `tangentialGrowth` (number), `maxAspect` (number), `factor` (number), `hsiz` (number), `sizeExpr` (string), `sizeParts` (json), `variable` (field), `method` (enum: green-gauss/least-squares), `distanceSurfacePath` (string), `distanceSurfacePart` (part), `distanceSurfaceSkin` (bool), `frozen` (json), `localSizes` (json), `hmin` (number), `hmax` (number), `hausd` (number), `hgrad` (number), `angleDetection` (number), `nosurf` (bool), `noinsert` (bool), `noswap` (bool), `nomove` (bool), `module` (enum: mmg3d/mmgs/mmg2d) | `remesh mode=factor factor=0.5` |
| `removeIslands` | Remove small disconnected pieces | `connectivity` (enum: edge/point), `minDiagonal` (number), `minArea` (number), `minCells` (int), `relative` (bool), `dryRun` (bool) | `removeIslands minDiagonal=0.05 dryRun=true` |
| `removeOrphanNodes` | Remove orphan nodes | — | `removeOrphanNodes` |
| `removeSubModelPartEntities` | Remove entities from SubModelPart | `path` (part, required), `kind` (enum: nodes/elements/conditions/geometries/constraints, required), `ids` (ids, required) | `removeSubModelPartEntities path=Inlet kind=nodes ids=1,2` |
| `renameField` | Rename field | `kind` (enum: Nodal/Elemental/Conditional, required), `variable` (field, required), `newName` (string, required), `onConflict` (enum: error/overwrite) | `renameField kind=Nodal variable=A newName=B` |
| `renameSubModelPart` | Rename SubModelPart | `path` (part, required), `newName` (string, required) | `renameSubModelPart path=Inlet newName=Inflow` |
| `renumber` | Renumber (compact ids) | `target` (enum: all/nodes/entities), `start` (int) | `renumber target=all` |
| `reorder` | Reorder nodes (storage order) | `method` (enum: rcm/morton/hilbert, required) | `reorder method=rcm` |
| `repairSurface` | Repair surface | `fixOrientation` (bool), `orientOutward` (bool), `fillHoles` (bool), `splitNonManifold` (bool), `maxHoleEdges` (int), `weldTolerance` (number), `fillStyle` (enum: fan/flat/curved) | `repairSurface fillHoles=true fillStyle=curved` |
| `rotate` | Rotate | `axis` (enum: x/y/z, required), `angle` (number), `cx` (number), `cy` (number), `cz` (number), `part` (part) | `rotate axis=z angle=90` |
| `scale` | Scale | `sx` (number), `sy` (number), `sz` (number), `part` (part) | `scale sx=2 sy=2 sz=2` |
| `sdfDistance` | Signed distance to a surface | `path` (string), `part` (part), `skin` (bool), `sign` (enum: pseudonormal/winding/none), `band` (number), `output` (string) | `sdfDistance part=Wall` |
| `segment` | Segment surface patches | `featureAngle` (number), `normalTolerance` (number), `curvatureTolerance` (number), `minPatchCells` (int), `method` (enum: angle/primitive), `tolerance` (number), `part` (part), `createParts` (bool) | `segment featureAngle=30 method=angle` |
| `selectRegion` | Select a region (box / plane / sphere / grown patch) | `name` (string, required), `kind` (enum: cell/point), `mode` (enum: all/any/centroid), `box` (json), `plane` (json), `sphere` (json), `where` (json), `quality` (json), `component` (int), `seed` (json), `featureAngle` (number), `normalTolerance` (number) | `selectRegion name=Top plane=[0,0,0,0,0,1] mode=centroid` |
| `setElementRadius` | Set element radius | `value` (number, required), `mode` (enum: absolute/multiply, required), `target` (part) | `setElementRadius value=0.5 mode=absolute` |
| `setProperty` | Set property value | `propertyId` (int, required), `name` (string, required), `value` (json, required) | `setProperty propertyId=1 name=YOUNG_MODULUS value=2.1e11` |
| `shrinkwrap` | Shrinkwrap onto a surface | `path` (string), `part` (part), `skin` (bool), `offset` (number), `blend` (number), `maxDistance` (number), `movePart` (part), `pinPart` (part), `normalWeight` (enum: angle/area), `recordDistance` (bool) | `shrinkwrap part=Wall` |
| `simplexify` | Simplexify | — | `simplexify` |
| `smooth` | Smooth | `method` (enum: laplacian/taubin/odt), `iterations` (int), `lambda` (number), `mu` (number), `fixBoundary` (bool), `preserveFeatures` (bool), `featureAngle` (number), `guardInversion` (bool) | `smooth method=taubin iterations=10` |
| `sobolevDeform` | Sobolev deformation (smoothed displacement) | `variable` (field, required), `lengthScale` (number, required), `fixedPart` (part), `fixBoundary` (bool), `maxIterations` (int), `tolerance` (number) | `sobolevDeform variable=DISPLACEMENT lengthScale=0.1` |
| `surfaceRemesh` | Remesh surface (redistribute vertices) | `numClusters` (int), `metric` (enum: isotropic/quadric/anisotropic), `gradation` (number), `maxAnisotropy` (number), `preserveBoundary` (bool) | `surfaceRemesh numClusters=500` |
| `tessellate` | Tessellate curved cells | `levels` (int) | `tessellate levels=2` |
| `thickness` | Wall thickness / clearance per facet | `direction` (enum: auto/inward/outward), `maxDistance` (number), `threshold` (number), `output` (string), `method` (enum: ray/sphere/cone), `coneAngle` (number), `coneRays` (number), `twoSided` (bool), `maxNormalDeviation` (number) | `thickness direction=inward threshold=0.2 method=cone` |
| `transferField` | Transfer fields from another mesh | `path` (string, required), `arrays` (list), `onConflict` (enum: error/overwrite/suffix) | `transferField path=other.vtu` |
| `translate` | Translate | `dx` (number), `dy` (number), `dz` (number), `part` (part) | `translate dx=1 dy=0 dz=0` |
| `untangle` | Untangle inverted tetrahedra / hexahedra | `fixBoundary` (bool), `frozenPart` (part), `rings` (int), `smooth` (bool), `maxSweeps` (int) | `untangle fixBoundary=true` |
| `volumeMesh` | Generate volume mesh (retetrahedralize) | `cellSize` (number), `resolution` (string), `paddingRelative` (number), `warpFraction` (number), `maxTets` (int), `keepSurface` (bool) | `volumeMesh cellSize=0.1` |
| `writeMeshSizeFields` | Write mesh size fields | `target` (enum: nodal/element/both, required) | `writeMeshSizeFields target=both` |
<!-- END GENERATED: operations -->
