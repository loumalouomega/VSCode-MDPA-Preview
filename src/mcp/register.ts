/**
 * Binds the SDK-free handlers in tools.ts to an McpServer with zod input
 * schemas. Kept separate from tools.ts so the test build (tsconfig.test.json,
 * node10 module resolution — which cannot resolve the MCP SDK's exports-map
 * subpaths) only ever compiles the handler core.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  meshInfo,
  meshQuality,
  meshFieldIntegrate,
  caseEvaluateQuantity,
  meshCurvature,
  meshCompare,
  meshDerive,
  meshProbe,
  meshSplit,
  meshSize,
  meshTransform,
  meshConvert,
  meshExtractSubModelPart,
  meshExtractSkin,
  meshExportTable,
  meshFieldSeries,
  meshPackSeries,
  meshFindEntity,
  meshSelect,
  meshCapabilities,
  problemtypeList,
  problemtypeDescribe,
  caseValidate,
  caseWriteState,
  caseGenerate,
  caseRun,
  caseStatus,
  caseStop,
  problemPack,
  problemUnpack,
} from "./tools";
import { GLOBAL_REDUCTIONS, type GlobalReduction } from "../parser/globalReduce";
import { EXPORTABLE_EXTENSIONS } from "../parser/writers/exportFormats";
import { SUPPORTED_MESH_EXTENSIONS } from "../parser/meshFormats";
import { MESHIO_READER_KEYS, MESHIO_WRITER_KEYS } from "../parser/meshioFormats";

/**
 * The op vocabulary for mesh_transform. Deliberately documented as prose and
 * validated at runtime by opRecordFromMessage (the same authority the webview's
 * applyOp messages go through) instead of duplicating the OpRecord union in zod.
 */
const OPS_HELP = `Each entry is {"op": "<name>", ...params}:
- {"op":"linearToQuadratic"} — insert mid-edge nodes (Triangle2D3→2D6, Tet4→Tet10, Hex8→Hex20, …)
- {"op":"removeOrphanNodes"} — drop nodes referenced by no cell and no SubModelPart
- {"op":"mergeNodes","tolerance":1e-6} — weld nodes closer than tolerance
- {"op":"scale","sx":2,"sy":2,"sz":2} | {"op":"translate","dx":..,"dy":..,"dz":..}
- {"op":"rotate","axis":"x|y|z","angle":<deg>,"cx?":0,"cy?":0,"cz?":0}
- {"op":"deleteSubModelPart","path":"Parent/Child"} | {"op":"renameSubModelPart","path":"..","newName":".."}
- SubModelPart TREE edits — these touch only the part tree; blocks and fields reference entities by id, so no geometry changes. {"op":"createSubModelPart","parentPath":"","name":"Inlet"} (parentPath "" = top level) | {"op":"moveSubModelPart","path":"A/B","newParentPath":"C"} (newParentPath "" un-nests to the top level; refuses a move into the part's own subtree, and a sibling name clash) | {"op":"mergeSubModelParts","sourcePath":"A","targetPath":"B"} (B gains the union of A's entity ids, A's children re-attach under B, A is removed; refuses when a child name would collide) | {"op":"addSubModelPartEntities","path":"A/B","kind":"nodes|elements|conditions|geometries|constraints","ids":[1,2]} | {"op":"removeSubModelPartEntities","path":"A/B","kind":"..","ids":[..]} (membership only — the entities themselves are never deleted)
- The parent/child subset rule is maintained the way Kratos itself maintains it: ADDING an entity to a part also adds it to every ANCESTOR (ModelPart::AddNode calls the parent's first), and REMOVING one also removes it from every DESCENDANT (RemoveNode loops over the sub model parts). Move and merge propagate upward for the same reason. The counts are reported in each op's message, so the knock-on effect is visible rather than silent.
- {"op":"writeMeshSizeFields","target":"nodal|element|both"} — persist NODAL_H / ELEMENT_H into the mesh's fields
- {"op":"setElementRadius","value":0.5,"mode":"absolute|multiply","target?":"block_1"} — set (or scale) the RADIUS of the sphere/particle (one-node) elements. "absolute" CREATES the field when the mesh has none, which is the usual case for an Exodus SPHERE file; "multiply" scales existing values and is a noop without them. Omitted target = whole mesh; a target names a SubModelPart and covers its subtree
- Properties AUTHORING — edit the "Begin Properties" sets (mesh_info's "properties" section reports them; beamElements resolves a beam's CROSS_AREA through these, so an edit re-renders/re-writes with NO competing field). {"op":"setProperty","propertyId":7,"name":"DENSITY","value":2700|true|[1,2,3]|[[..],[..]]|{"kind":"string","value":"LinearElastic3DLaw"}} — edits one set in place: every block whose propertyIds row points at that id sees the change (that is the point — shared-property editing). | {"op":"createProperty","id?":8,"name?":"CROSS_AREA","value?":1e-4} — appends an empty set (id defaults to one past the largest). | {"op":"cloneProperty","propertyId":7,"newId?":8} — copies a set (variables AND tables) to a fresh id WITHOUT touching any block — the first half of clone-and-reassign. | {"op":"assignProperty","propertyId":8,"kind":"Elements|Conditions","ids":[..]} or {"op":"assignProperty","propertyId":8,"part":"Inlet"} — rewrites the selected blocks' propertyIds rows (part = that SubModelPart's subtree); Geometries carry no propertyIds and are refused by name; an id that does not exist must be created first. | {"op":"deleteProperty","propertyId":7} — refused while any block still references the set (assign first). A noop hands the model back unchanged
- SELECTION-DRIVEN EDITS — {"op":"createSubModelPartFromSelection","name":"Sel","parentPath?":"","elements?":[..],"conditions?":[..],"geometries?":[..],"seed?":{...}} — builds a SubModelPart from what is selected: explicit per-kind id lists (ids in each kind's OWN id space) or a seed resolved AGAINST the model at apply time — {"seed":{"kind":"part","path":"Domain"}} | {"seed":{"kind":"field","variable":"TEMP","blockKind":"Nodal","lo":90,"hi":210,"rule?":"all|any","component?":"mag"}} | {"seed":{"kind":"quality","metric":"edgeRatio"}} | {"seed":{"kind":"property","propertyId":7}}. The chosen nodes (each selected cell's connectivity closure) ride in with the entities so the parent/child subset rule holds; an id the mesh does not define refuses by name (refresh the selection); a seed resolving to nothing is a noop with the reason, never an empty part. Field seeds are the same cells the viewer's Threshold mode colores; quality seeds are the bad/unacceptable ids computeMeshQuality reports
- {"op":"deleteEntities","elements?":[..],"conditions?":[..],"geometries?":[..]} — DELETE the given entities (per kind; ids in each kind's OWN id space). It is the complement of a selection-driven export, run through the same restrictToCells machinery, so NO new rule: surviving entities keep their ids, a Condition/Geometry stays only while EVERY node it names is still used by a kept element, constraints whose nodes all vanish are dropped, elemental/conditional fields slice to survivors, SubModelParts narrow (node lists included) and orphan nodes are cleaned up. The message reports deleted/asked per kind plus the constraint count. Nothing given is a refusal
- {"op":"remesh","mode":"factor|hsiz|optimize|expr|aniso","factor?":0.5,"hsiz?":0.1,"sizeExpr?":"0.5*h","sizeParts?":[{"path":"Inlet","expr":"0.25*h"}],"distanceSurfacePath?":"/path/to/skin.stl","distanceSurfacePart?":"Skin","distanceSurfaceSkin?":true,"variable?":"TEMP","method?":"green-gauss|least-squares","frozen?":[{"kind":"block|part","target":"Inlet"}],"localSizes?":[{"kind":"block|part","target":"Inlet","hmin":0.1,"hmax":0.3,"hausd":0.02}],"hmin?":..,"hmax?":..,"hausd?":..,"hgrad?":..,"angleDetection?":45,"nosurf?":true,"noinsert?":true,"noswap?":true,"nomove?":true,"module?":"mmg2d|mmgs|mmg3d"} — MMG remeshing (runs in-process; large meshes take a while and block the server). mode "expr" sets the per-node target size from a formula: vars h (nodal size NODAL_H), x y z (coords), mean std min max median q1 q3 iqr (global NODAL_H stats), PLUS every existing NODAL field already on the mesh by name (fieldCalc's own scalar/_x/_y/_z convention, lowercased; a field colliding with a reserved name like "h" is dropped rather than shadowing it) — so a field computed by an earlier op in the same sequence (e.g. sdfDistance's own "d", or a fieldCalc output) is immediately usable here too; PLUS every GLOBAL variable on the model (see reduceField) by name, recomputed from the current fields at run time; funcs min max clamp abs sqrt sin cos tan exp log pow floor ceil round; e.g. "clamp(0.5*h, mean-1.5*std, mean+1.5*std)". sizeParts assigns per-SubModelPart expression overrides (first match wins; stats stay global). "distanceSurfacePath" (expr mode only) reads a second mesh (boundary/skin) off disk, measures the unsigned distance from every node to it via the same call the sdfDistance op makes, and adds a "d" variable to the formula scope (and every sizeParts override) — e.g. with globals "mean_h"/"min_h"/"max_h" of the mesh size and "maxabs_d" (reduceField maxAbs of the field d), "clamp(0.85*mean_h*(abs(d)/maxabs_d), 0.85*min_h, 1.15*max_h)" grades element size by wall distance for boundary-layer-style refinement (finest "0.85*min_h" at the wall, growing to "0.85*mean_h" at the farthest node, with the upper "1.15*max_h" bound as a safety cap); referencing "d" with neither set fails validation with "unknown name". "distanceSurfacePart" is the alternative to "distanceSurfacePath" when the boundary/skin already exists as a SubModelPart of the SAME mesh being remeshed — no second file, just that part's own name (its subtree included), extracted the same way mesh_extract_submodelpart would. "distanceSurfaceSkin":true is the third alternative: measure to the mesh's OWN exterior skin — the same boundary File ▸ Export skin… / mesh_extract_skin writes (quads split into triangles) — no file and no SubModelPart needed; a mesh with no volume cells has no skin distinct from itself and is a noop. At most one of "distanceSurfacePath"/"distanceSurfacePart"/"distanceSurfaceSkin" may be given; two together is rejected. An unreadable path, or a part name not found in the mesh, is a noop with a message, like sdfDistance/transferField/mergeMesh. Still an isotropic tet/tri metric graded by distance, not a structured stretched inflation layer, which MMG does not produce. mode "aniso" assembles a tensor metric from the Hessian of variable (computed inline — only the source field must exist) and adapts to its curvature; hmin/hmax clamp the resulting sizes. frozen names whole EntityBlocks or SubModelPart subtrees MMG must leave bit-identical (remesh only). localSizes bounds hmin/hmax/hausd per block or part via setLocalParameter (remesh only; all three bounds required on every entry)
- {"op":"levelset","variable":"<nodal field>","isovalue?":0,"isosurf?":true,"rmc?":1e-5,"keepMaterials?":true,"noSplit?":[{"kind":"block|part","target":"Steel"}],"baseRefs?":[{"kind":"block|part","target":"Wall"}],"hmin?":..,"hmax?":..,"hausd?":..,"hgrad?":..,"module?":".."} — MMG level-set split along a nodal field isosurface. "keepMaterials" maps every input material through MMG's multi-material mode so each split cell returns to its ORIGINAL block and SubModelParts, with the side carried by the generated MMG_Domain_Inside/MMG_Domain_Outside SubModelParts; WITHOUT it every domain cell collapses into MMG_Domain_Inside/_Outside blocks and all block identity and part membership is lost. It is off by default because it changes the shape of the output. "noSplit" names materials the level set must leave uncut (they keep their own block untouched and appear in neither side part) and implies keepMaterials — MMG requires the WHOLE domain reference list, so this selects which materials are left uncut rather than which are mapped, and marking every material no-split is refused. "rmc" deletes split components whose volume fraction of the mesh is below it — the small parasitic blobs an sdfDistance -> levelset chain leaves behind — and must be in (0,1): MMG itself range-checks nothing, and a value above a real domain's fraction deletes that whole domain. It is not implemented for isosurf and is skipped with a message there, as is "keepMaterials" — a surface-only split leaves the domain references alone, so identity already survives, and mapping the volume materials there would drop the split surface regions. "baseRefs" names BOUNDARY entities that split domains must touch to survive; a domain attached to none of them is deleted, which is inert without rmc, so rmc is enabled at 1e-5 when baseRefs is given without it. A selector matching nothing (or naming only domain cells, for baseRefs) warns and is skipped rather than failing
- {"op":"smooth","method?":"taubin|laplacian|odt","iterations?":10,"lambda?":0.5,"mu?":-0.53,"fixBoundary?":true,"preserveFeatures?":true,"featureAngle?":45,"guardInversion?":true} — meshio++ mesh smoothing (oracle: only coordinates move, node/cell count and every field are untouched). Taubin (default) is shrink-free; Laplacian shrinks without bound; odt (optimal-Delaunay-triangulation) targets element QUALITY rather than surface fairness and is the one to run before a solve, but is TET-ONLY and raises by name on any other cell type
- {"op":"reorder","method":"rcm|morton|hilbert"} — reorder nodes for cache locality / bandwidth. This permutes STORAGE ORDER only: every node keeps its own id and its own coordinates, which is exactly why connectivity, SubModelParts and fields (all keyed by id, never by index) stay valid untouched. Renumbering the ids themselves is the separate "renumber" op — run reorder then renumber for a full RCM renumbering. "rcm" minimizes bandwidth; "morton"/"hilbert" optimize spatial locality
- {"op":"renumber","target?":"all|nodes|entities","start?":1} — compact ids into a gapless run from "start" (default 1), in the order the mesh already stores them. Elements, Conditions and Geometries are each numbered independently, as Kratos does — an Element 1 beside a Condition 1 is correct, not a collision. Connectivity, SubModelPart membership and every field record follow their ids. NOT touched, deliberately: coordinates (this relabels, it does not reorder), Properties ids (a different id space; its values are parsed and reported by mesh_info, but the ids themselves are never relabelled). Constraints ARE renumbered: they are a fourth id space, folded into "entities" (no separate target), their master/slave node columns follow the nodes, and the SubModelPart constraint lists follow their ids — a constraint whose node did not survive is dropped rather than left pointing at nothing, and an unparseable constraint row suppresses constraint-id renumbering entirely rather than breaking the SubModelPart correspondence. References to ids no node/entity carries are dropped from part and field lists and zeroed in connectivity, and reported
- {"op":"partition","nparts":4,"method?":"sfc|kahip|auto","createParts?":false} — label cells into nparts via a space-filling curve (the wasm build has no KaHIP: "kahip" throws, "auto" resolves to "sfc"; balanced by cell count, not edge cut) and attach as an Elemental PARTITION_INDEX field; createParts also emits one SubModelPart per partition
- {"op":"linearize"} — the inverse of linearToQuadratic: drop mid-edge nodes (Triangle2D6→2D3, Tet10→Tet4, Hex20→Hex8, …), then removeOrphanNodes
- {"op":"refine","levels?":1,"select?":{...}} — subdivision, up to 4 levels; shared edges/faces dedup to one new node, Nodal fields interpolate exactly, Elemental/Conditional fields replicate to children, SubModelPart membership grows to cover the new children. With no "select" it is UNIFORM (tri/quad/tet/hex/wedge→4 or 8 children, line→2). With "select" it is SIMPLEX-ONLY — triangles and tetrahedra; line and triangle boundary cells follow the closure automatically, while quad/hex/wedge/pyramid are refused by name (run simplexify first). Selected cells split fully; neighbours that inherit a refined edge take the smallest admissible partial split and are promoted and iterated to a fixed point, so the result has NO hanging nodes. "select" is one of {"by":"field","variable?":"ERROR_MARKED","compare?":">","value?":0.5,"location?":"Elemental"} (the default pairs directly with estimateError's marking), {"by":"part","path":"Inlet"} (a SubModelPart subtree) or {"by":"ids","kind":"Elements","ids":[...]}. A named field the mesh does not carry is a NOOP with a message, not a failure, so a replay that skipped the async estimateError degrades cleanly. Transitional cells are flagged REFINE_GREEN and a later refine splits them fully rather than partially again, which is what stops repeated closure from degrading element quality
- {"op":"simplexify"} — convert non-simplex cells to simplices (hex→6 tets, wedge→3 tets, pyramid→2 tets, quad→2 triangles); the first child keeps the parent's id, siblings get fresh ids, fields and SubModelPart membership replicate
- {"op":"crop","kind":"bbox","lo":[x,y,z],"hi":[x,y,z],"mode?":"all|any"} | {"op":"crop","kind":"plane","point":[x,y,z],"normal":[x,y,z],"mode?":"all|any"} — keep cells whose nodes are inside a box or on the normal side of a plane ("all" nodes inside vs. "any"), then removeOrphanNodes; SubModelParts narrow to survivors
- {"op":"fieldCalc","expr":"0.5*(temp+273.15)","location":"Nodal|Elemental|Conditional","output":"NEW_VAR"} — new field from a formula (own recursive-descent evaluator, never eval) over x,y,z plus every existing field at that location (a vector field's components as name_x/name_y/name_z) plus every GLOBAL variable (see reduceField) at any location; a bad formula is rejected before anything is applied, division by zero yields inf
- {"op":"averageField","variable":"TEMP","direction":"nodalToElemental|elementalToNodal","target?":"Elements|Conditions","output?":"TEMP_AVG"} — average a field across the node/cell incidence (nodalToElemental: mean over a cell's own nodes; elementalToNodal: mean over incident cells, unweighted)
- {"op":"reduceField","variable":"TEMP","kind?":"Nodal|Elemental|Conditional","reduction":"min|max|mean|std|median|sum|count|q1|q3|iqr|minAbs|maxAbs","output?":"max_TEMP"} — a GLOBAL (scalar) variable: one reduction of a field's values (vector fields reduce over magnitude), stored as a spec on the model and recomputed from the current fields by every formula scope (field calculator, remesh sizing, Variables rows) — so it can never go stale across crop/refine/merge/remesh/timeline steps. Output defaults to {reduction}_{variable}. A name colliding with a reserved formula variable or an existing field is still recorded but warned as unusable in formulas
- {"op":"mergeMesh","paths":["/abs/a.mdpa","/abs/b.mdpa"],"weld?":false,"tolerance?":1e-6,"name?":"Merged"} — append one or more mesh files' nodes/cells in a single operation. Ids are offset past the current maxima PER KIND (nodes, Elements, Conditions, Geometries and SubModelPart constraint ids each continue their own run), and each source is wrapped in its own SubModelPart named after its file stem, de-duplicated with a "_2" suffix against existing parts. With several files, "name" instead names a parent part whose children are the per-source wrappers. weld welds coincident nodes ONCE across every seam via the same grid as mergeNodes, not once per file. A file that cannot be read is reported and skipped rather than discarding the ones that could. Fidelity: a merged file's Properties sets ARE carried over (rebased past the base's own Properties ids on collision, and the merged cells rewritten through the same map), while its ModelPartData/Table blocks are not (the writer copies the base file's ModelPartData/Table verbatim) — and a same-named field whose component count disagrees is skipped — all reported. The single-path spelling {"op":"mergeMesh","path":"…"} is still accepted for recipes written before this was N-ary
- {"op":"renameField","kind":"Nodal|Elemental|Conditional","variable":"TEMP","newName":"TEMP_OLD","onConflict?":"error|overwrite"} — rename one field, keeping its values, ids and Nodal fixity. A legal Kratos variable name is required (letters, digits, underscores); an existing field of that name at that location is refused unless onConflict is "overwrite". Global reductions that read the renamed field follow it
- {"op":"keepFields","kind?":"Nodal|Elemental|Conditional","variables":["TEMP","PRESSURE"]} / {"op":"dropFields",…same…} — keep ONLY the listed fields, or remove them. With kind, other locations are untouched; without it the list applies everywhere. Names that match nothing are reported. Global reductions whose source is removed are named in the message (they then read NaN until the field returns)
- {"op":"conditionField","kind":"Nodal|Elemental|Conditional","variable":"TEMP","mode":"clamp|normalize|standardize","lo?":0,"hi?":1,"scope?":"component|magnitude","nanPolicy?":"ignore|replace|fail","nanReplacement?":0,"output?":"TEMP_N"} — clamp x→min(max(x,lo),hi); normalize maps the field's own [min,max] onto [lo,hi]; standardize gives zero mean and unit POPULATION standard deviation (lo/hi ignored). Statistics use the finite values only. scope "magnitude" computes the statistics over each row's length and rescales whole rows so direction is kept (a scalar always uses component); a zero-length row stays zero. A constant field normalizes to lo and standardizes to 0 (the message says so). nanPolicy "ignore" leaves non-finite values as they are, "replace" writes nanReplacement, "fail" refuses. A gap stays a gap — only the ids the field already carries are written. Blank output overwrites in place; a name keeps the original and writes the result beside it. Same semantics as meshio++'s dataCondition, native so that partly-covered fields and Nodal fixity survive
- {"op":"repairSurface","fixOrientation?":true,"orientOutward?":true,"fillHoles?":true,"splitNonManifold?":true,"maxHoleEdges?":10,"weldTolerance?":0} — repair a SURFACE mesh (triangles/quads; a volume mesh is refused — extract its boundary with mesh_extract_skin first) through meshio++'s repair, adopted in place: neighbouring faces are re-wound to agree, each closed component is oriented outward, bounded holes (up to maxHoleEdges rim edges) are triangulated, vertices where two fans of faces touch at a point are split, and points closer than weldTolerance are welded first (0 = off). The message gives boundary / non-manifold / inconsistent-pair counts before and after. Entities the repair does not touch keep their ids, kinds, property ids, SubModelParts and field values. Filled faces join the source block of the same cell type (so the block keeps a real Kratos type name), are listed in a new SubModelPart "Repair_Fill" (suffixed _2… if taken), take that block's most common property id, and have NO Elemental/Conditional field values (a gap, never 0); Nodal fields reach the new hole-centre point as the mean of the hole's rim. Non-manifold EDGES are counted, never split, and outward orientation does not infer nested cavities. A mesh that needs nothing is a noop with the counts. Block display names are recovered; ids of created entities are fresh
- {"op":"curvature","mean?":true,"gaussian?":true,"principal?":false,"area?":false,"dualArea?":"mixed-voronoi|barycentric","includeBoundary?":false,"outputPrefix?":"CURVATURE"} — per-node discrete curvature of a SURFACE mesh (a solid is refused; use mesh_extract_skin), written as Nodal fields <prefix>_MEAN, <prefix>_GAUSSIAN, and optionally <prefix>_AREA (the dual area divided by) and <prefix>_K1/_K2 (principal curvatures, k1 >= k2, split into two scalars so a formula can read either). meshio++ is an ORACLE here: the cells and ids are untouched. A sphere of radius R reads H = 1/R, K = 1/R^2; H's SIGN follows the winding (a uniformly inside-out surface reads -1/R; a mesh with faces wound against each other is flagged — run repairSurface first). Boundary nodes of an open surface, and nodes no face references, are left UNDEFINED (a gap, never 0) unless includeBoundary is set. The message gives the value ranges and, for a closed surface, the Gauss-Bonnet check (sum of angle defects vs 2*pi*chi). The fields join later ops' formula scopes: e.g. a remesh "expr" size 0.05/max(abs(CURVATURE_MEAN),0.01) refines where the surface curves. Use mesh_curvature for the read-only statistics without writing fields
- {"op":"shrinkwrap","path":"scan.stl"|"part":"Skin"|"skin":true,"offset?":0,"maxDistance?":0,"blend?":1,"movePart?":"Free","pinPart?":"Fixed","normalWeight?":"angle|area","recordDistance?":false} — project the mesh's nodes onto a target TRIANGLE surface named exactly one of three ways: a file, a SubModelPart of this mesh, or its own exterior skin (like sdfDistance). Each node moves once, x' = x + blend*(p + offset*n - x), p the closest target point and n the normal there (the feature pseudonormal at an edge or vertex); this is a PROJECTION, not an iterative or collision-free fit, so the message counts any volume cell it inverts or surface cell it folds over. offset stands off along the normal (negative = other side; a non-closed target is warned about because the side is then ambiguous); maxDistance > 0 leaves farther nodes in place and counts them; blend is unclamped (above 1 overshoots). movePart restricts movement to that SubModelPart's nodes (and subtree), pinPart holds its nodes exactly in place. recordDistance writes each node's pre-move distance as SHRINKWRAP_DISTANCE (a gap where a node was not queried). meshio++ is an ORACLE: only the points cross, and blocks, ids, SubModelParts and every field survive untouched
- {"op":"sobolevDeform","variable":"DISPLACEMENT","lengthScale":0.5,"fixedPart?":"Fixed","fixBoundary?":false,"maxIterations?":128,"tolerance?":1e-10} — move the nodes by a raw displacement field (a 2- or 3-component NODAL field) after low-pass filtering it through the mesh's own P1 finite-element operators, (M + l^2 K) u = M d with l = lengthScale (cutoff wavelength in mesh units; 0 applies the displacement unfiltered). Requires LINEAR simplices at the mesh's top dimension (lines, triangles or tetrahedra — quads, hexes and quadratic cells are refused by name, pointing at simplexify/linearize). fixedPart pins that SubModelPart's nodes, fixBoundary pins every node on a boundary facet; pinned nodes do not move at all. A constant displacement is preserved exactly, in zero iterations. If the iteration cap is reached the LAST ITERATE is kept and the message says the solve did not converge (raise maxIterations or lower lengthScale); a node the field does not cover moves by 0 and is counted. The message reports cells the move inverted (there is no inversion guard). meshio++ is an ORACLE: only coordinates change
- {"op":"compareField","path":"other.mdpa","variable":"TEMP","kind":"Nodal|Elemental|Conditional","sourceVariable?":"T","correspondence?":"id|spatial","output?":"TEMP","atol?":0,"rtol?":0} — compare one of THIS mesh's fields with the same field of another file and write <output or variable>_DIFF (signed a-b, same width), _ABS (Euclidean norm of the difference) and _REL (relative to |b|; a gap where |b| = 0) as fields of the same kind. correspondence "id" (default) matches entities by id in each id space; "spatial" point-samples the OTHER mesh's NODAL field at this mesh's nodes (barycentric, meshio++ interpolate — not the mass-preserving transferField), for different discretizations of one domain. Entities with no counterpart, and non-finite values, are left as GAPS in the written fields and counted in the message, never 0; the message gives the number compared, max/RMS/mean |a-b| with the worst id, the max relative error, and the count outside atol/rtol. An unreadable file is a noop. Use mesh_compare for the structural report (and the same fields without a transform chain)
- {"op":"markComponents","output?":"COMPONENT_INDEX","fragmentFraction?":0.01} — write each Element's connected-component index (0 = the largest; ties broken by lowest node id) as an Elemental field: elements sharing a node are connected, conditions do not connect bodies. A single body is a noop; the message lists the elements per component, the components under fragmentFraction of the largest (isolated fragments — probably debris) and the loose nodes no element uses. Native and lossless. Use mesh_split to write each body as its own file
- {"op":"surfaceRemesh","numClusters?":300,"metric?":"isotropic|quadric|anisotropic","gradation?":0,"preserveBoundary?":true,"maxAnisotropy?":4} — surface REDISTRIBUTION (meshio++ ACVD clustering, an alternative to MMG's surface mode): a new triangulation of the same surface with exactly numClusters vertices (default half the current node count, at least 4), adopted in place. TRIANGLE surfaces only (volume cells: extract the skin first; quads: simplexify first; lines/points cannot be mixed in). meshio++ drops everything for this op, so EVERY face and node is new: each face inherits BLOCK, PROPERTY, SubModelPart membership and elemental/conditional field values from the NEAREST original face (centroid distance, fresh ids — a part boundary is resolved at the new resolution), and nodal fields are mapped by containing-face lookup on the original surface; constraints are dropped. maxAnisotropy applies to the anisotropic metric only. The message reports the face/node counts, the deviation of the new nodes from the original surface (max/mean, and max as a share of the bounding-box diagonal), boundary/non-manifold/flipped-face counts and the smallest angle before and after
- {"op":"volumeMesh","cellSize":0.1|"resolution":[nx,ny,nz],"paddingRelative?":0.1,"warpFraction?":0.35,"maxTets?":2000000,"keepSurface?":true} — RETETRAHEDRALIZATION (meshio++ remeshVolume): a tetrahedral mesh of the volume enclosed by a CLOSED triangle surface (or of an existing volume), on a lattice with the boundary vertices warped onto the surface, adopted in place. Exactly one of cellSize / resolution; a request over 2e7 lattice cells is refused before any wasm runs, and maxTets caps the output. NOT a guaranteed-quality mesher: the message reports the boundary deviation from the input, how many boundary vertices were warped and candidate tetrahedra rejected, non-manifold edges in the result, and says so (warpFraction 0 gives an exactly watertight boundary of lower quality). From a bare surface the tetrahedra form one new "Element3D4N" block (the input's most common property id); from a volume they inherit block/property/parts/element fields from the nearest original volume cell. keepSurface (default true, surface input) also writes the volume's boundary as Conditions inheriting property and SubModelPart membership from the nearest input face, so parts on the surface survive as boundary conditions. Every node is new; constraints are dropped
- {"op":"optimizeVolume","maxIterations?":10,"relocate?":true,"flip?":true,"preserveBoundary?":true,"minImprovement?":1e-6} — FIXED-NODE-SET optimization of a tetrahedral mesh (meshio++ optimizeVolume: 2-3 / 3-2 face flips and interior vertex relocation), adopted in place. Every Element must be a linear tetrahedron (others: simplexify / linearize first); Conditions and Geometries ride along untouched, and so do constraints, because no node is added or removed. Because the node set is unchanged, a tetrahedron the operation did not touch is recognised by its node set and KEEPS its entity id, block, property, SubModelParts and element-field values; only a tetrahedron changed by a flip takes a fresh id and inherits context from the nearest original one. The message reports flips (2-3 / 3-2), vertices relocated, the worst tetrahedron quality before and after, the smallest angle, and how many tetrahedra kept their identity. A mesh that cannot be improved is a noop
- {"op":"fieldGradient","variable":"TEMP","operator?":"gradient|divergence|curl","method?":"green-gauss|least-squares","output?":"TEMP_GRADIENT"} — the derivative of a NODAL field, as a new nodal field named <variable>_<OPERATOR> unless output says otherwise. Widths: gradient of an nc-component field has 3*nc components row-major as [component][derivative] (a scalar gives 3, a 3-vector 9); divergence gives 1 and curl 3, both requiring a 2- or 3-component field. green-gauss integrates over each cell's own faces and is exact for a linear field on any cell; least-squares fits over the node-sharing neighbours and falls back to green-gauss on a degenerate neighbourhood. An Elemental field is piecewise constant and has no derivative — move it to the nodes with averageField first. Cells that cannot be differentiated yield NaN rather than an approximation
- {"op":"fieldHessian","variable":"TEMP","method?":"green-gauss|least-squares","output?":"TEMP_HESSIAN"} — the Hessian (second derivative) of a SCALAR NODAL field, as a new nodal field with 9 components: the flattened row-major 3x3, H[i][j] at index i*3+j. A composition of TWO gradient passes (method is forwarded to both), not a new kernel — so it is EXACT for a field that is at most linear (whose Hessian is exactly zero everywhere, the one mesh-shape-independent guarantee) and on a structured mesh away from its boundary, but a genuinely approximate curvature estimate on an irregular mesh. Scalar only: a vector field's Hessian is a separate quantity per component, so split it with fieldCalc and run this once per component. An Elemental field is piecewise constant and has no derivative — move it to the nodes with averageField first. Nodes that cannot be differentiated yield NaN
- {"op":"estimateError","variable":"TEMP","method?":"zz","marking?":"none|absolute|fraction|dorfler","markingValue?":0.5,"output?":"ERROR_INDICATOR"} — the Zienkiewicz-Zhu recovery-based error indicator of a NODAL field, attached as a per-cell Elemental field (default ERROR_INDICATOR): sqrt(measure * sum((recovered - raw gradient)^2)) per cell. A field the mesh represents EXACTLY — anything linear — has zero error, so a near-zero result means the mesh already resolves the solution rather than that the estimate failed. marking other than "none" also attaches an ERROR_MARKED 0/1 Elemental field naming the cells worth refining: "absolute" thresholds the indicator at markingValue, "fraction" marks that share of cells worst-first, "dorfler" marks the smallest set holding that share of the total error (both need markingValue in (0, 1]). Cells that cannot be evaluated read NaN in the indicator and 0 — never NaN — in the marking array. Source must be Nodal; use averageField on an Elemental one first
- {"op":"sdfDistance","path?":"/abs/surface.stl","part?":"Skin","skin?":true,"sign?":"pseudonormal|winding|none","band?":0,"output?":"SDF_DISTANCE"} — the signed distance from every node to a surface, as a new nodal field (default SDF_DISTANCE). The surface is either an EXTERNAL mesh read from "path", or "part" — a SubModelPart already in THIS mesh (its subtree included, extracted the same way mesh_extract_submodelpart would) — no second file needed — or "skin":true, the mesh's OWN exterior skin (the same boundary mesh_extract_skin writes, quads split into triangles; a mesh with no volume cells has no skin distinct from itself, so that is a noop); exactly one of "path"/"part"/"skin" must be given, two together is rejected. NEGATIVE IS INSIDE, and the surface must be closed for the sign to mean anything ("none" gives unsigned distance for an open one). The purest oracle here: only the surface crosses into wasm, the query points are our own coordinates, and one double comes back per node in order — so nothing about this mesh can change but the added field. Pairs directly with levelset: run sdfDistance, then {"op":"levelset","variable":"SDF_DISTANCE"} to CUT this mesh along that surface. "winding" is slower but tolerant of small holes; band computes exact values only within that distance and clamps beyond it. An unreadable path, or a part name not found, is a noop with a message, never a failure
- {"op":"transferField","path":"/abs/other.vtu","arrays?":["TEMP"],"onConflict?":"overwrite|suffix|error"} — map fields from ANOTHER mesh onto this one by mass-preserving conservative interpolation: over the region the two meshes share, sum(value * measure) is equal on both sides, which pointwise interpolation does not guarantee. Empty/omitted arrays transfers every field the source carries. IMPORTANT: nodal data is transferred by a point->cell->clip->point composition, so it is SMOOTHED, not resampled — a constant field survives exactly, a varying one is averaged, even between identical meshes; the conserved quantity is the total. Both meshes are simplexified internally, so an array whose entity count no longer matches this mesh is DROPPED and named rather than scattered onto the wrong entities. onConflict defaults to overwrite so re-running updates instead of failing. An unreadable path is a noop with a message`;

const SKIN_HELP =
  "Native boundary-face walk (not meshio++'s extractSurface/extractSkin, which drop every region): " +
  "a volume cell's faces seen by exactly one cell are boundary; pre-existing surface cells pass through unchanged. " +
  "SubModelParts survive narrowed to node membership (element/condition ids cannot follow — the skin has fresh entity ids); only Nodal fields carry over.";

const WORKSPACE_DIRS = z
  .array(z.string())
  .optional()
  .describe(
    "Directories to scan for workspace-authored problemtypes (each dir's .kratos/problemtypes/*.{js,py} when present, else the dir itself). Built-ins are always included."
  );

/** Registers every kratos-mdpa tool on the server. */
export function registerAllTools(server: McpServer): void {
  const run = (handler: (args: never) => Promise<object>) =>
    async (args: Record<string, unknown>) => {
      try {
        const result = await handler(args as never);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    };

  // Interpolated, not hand-listed: the supported set grows whenever
  // meshioFormats.ts does (49 as of meshio++ 8.7.0's Exodus/CGNS/H5M/HMF/MED).
  const meshPath = z
    .string()
    .describe(`Path to a mesh file (.mdpa, ${SUPPORTED_MESH_EXTENSIONS.join(", ")})`);

  const inputFormat = z
    .string()
    .optional()
    .describe(
      `Force a meshio++ reader instead of inferring from the extension (${MESHIO_READER_KEYS.join(", ")}). ` +
        `Needed for the formats no extension defaults to: .msh means gmsh (pass "ansys"/"freefem" for those), ` +
        `and .inp means abaqus (pass "ansysinp"). Also the ONLY way to reach four result readers, which meshio++ ` +
        `identifies by file name rather than by extension: "ansys_rst_cyclic" (a cyclic model's full rotor rather ` +
        `than one sector), "lsdyna_binout", "radioss_anim" and "radioss_th".`
    );

  const timeStep = z
    .number()
    .int()
    .optional()
    .describe(
      "Selects a step of a multi-step mesh: Exodus (meshio++ >= 8.6.0), MED (>= 9.9.0), " +
        "GiD postprocess, CGNS/Tecplot (>= 11.3.0), XDMF, and OpenFOAM time directories. " +
        "0 is the first step (the default); negative counts from the end. Out of range throws " +
        "naming the available count — see mesh_info's timeValues for how many there are."
    );

  const piece = z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Selects one piece of a parallel/partitioned VTK XML file (.pvtu/.pvtp, meshio++ >= 14.0.0) instead of merging every piece. " +
        "0-based; out of range throws naming the piece count. Ignored by every other format."
    );

  const dropGhosts = z
    .boolean()
    .optional()
    .describe(
      "Drop ghost/duplicate cells at partition seams when reading a parallel/partitioned VTK XML file (.pvtu/.pvtp). " +
        "Defaults to true for those two extensions (a partitioned run's pieces routinely overlap at the seams); pass false to keep them. Ignored by every other format."
    );

  const region = z
    .string()
    .optional()
    .describe(
      "Selects one region of a multi-region OpenFOAM case (.foam; a case with no top-level constant/polyMesh but " +
        "constant/<region>/polyMesh per region) instead of the default: reading and merging EVERY region, each as its " +
        "own top-level SubModelPart named after it (with its patches as that part's children). An unknown region name " +
        "throws naming the ones that exist. Refused (with the same message) on an ordinary single-region case, since " +
        "there is nothing to select. Ignored by every other format."
    );

  const metadataOnly = z
    .boolean()
    .optional()
    .describe(
        "Report the file header only — counts, block shapes, data-array names, regions, bbox — without parsing the mesh. " +
        "Only the meshio++ formats whose readMetadata stays header-only (.xdmf/.xmf, .msh, .med, .cgns, .dat/.tec, the GiD .post.* set); anything else is refused rather than served at header price. " +
        "Cannot be combined with timeStep. Regions come back empty on every native header path (upstream maps none there), and the bbox is omitted when the reader computed none."
    );

  const summary = z
    .boolean()
    .optional()
    .describe(
      "Report what is in the file WITHOUT parsing it - counts, blocks, data-array names, regions - for EVERY supported format, including .mdpa and the natively-parsed VTK/STL/OBJ/PLY that metadataOnly refuses. " +
        "It never refuses for ineligibility; it reports `cost` instead: 'header' is a bounded read (VTK XML/PLY/binary STL/.vtm), 'scan' streams the whole file without building arrays (.mdpa declares no counts anywhere, so it has no choice; also .obj and ascii STL), " +
        "'buffered' holds the file and its siblings in memory, and 'read' means the reader parsed the mesh to answer. Check `cost` before assuming a summary of a huge file was cheap - `bytesRead` says what it actually took. " +
        "`unknown` names what the format genuinely cannot report (e.g. cell types from a VTK XML header, bounds from an MDPA scan) so an absent value is not mistaken for zero. Cannot be combined with metadataOnly or timeStep."
    );

  server.registerTool(
    "mesh_info",
    {
      description:
        "Parse a mesh file and summarize it: node/element/condition counts, bounds, entity blocks, the SubModelPart tree, data fields, parser diagnostics, and — for a multi-step mesh (Exodus, GiD, XDMF, OpenFOAM time directories) — the selected step and every available time value. " +
        "Six sections appear only when the mesh has the thing they describe, so an ordinary mesh's report is unchanged: `properties` (an .mdpa's parsed `Begin Properties` values — the id space blocks[].propertyIds points into, so a cell's material or section can be resolved without reading the file), " +
        "`constraints` (an .mdpa's parsed `Begin Constraints` blocks — Kratos master/slave constraints: per block its name, variables, row count and id range, plus `verbatimRows` for rows this extension could not decompose and `undefinedIds` for constraint ids a SubModelPart lists that no block defines, which is a file Kratos cannot read back), " +
        "`source` (a MED file's own mesh name, description and units — coordinate, time and per-field, when the file actually sets them), " +
        "`spheres` (one-node/particle cells: how many, whether they carry a RADIUS, and a suggested one if not), and " +
        "`beams` (line cells: `sectioned` counts those resolving a CROSS_AREA, while the stricter `elementsSectioned` counts only Elements — a mesh where the two differ sharply is usually a 2D boundary skin sharing a structural part's properties, not a frame), and " +
        "`isolatedNodes` (nodes referenced by no cell connectivity — connectivity-only, so a node listed in a SubModelPart but in no block still counts: `count` plus the `ids`, capped at 1000 with `truncated: true` when capped). Pass `summary: true` to report the file shape WITHOUT parsing it, for every supported format, with an explicit `cost` saying what that took.",
      inputSchema: { path: meshPath, inputFormat, timeStep, metadataOnly, summary, piece, dropGhosts, region },
    },
    run(meshInfo)
  );

  server.registerTool(
    "mesh_quality",
    {
      description:
        "Compute geometric mesh-quality metrics (edge ratio, min/max angle, size gradation) with Kratos-default thresholds; returns per-metric statistics, band percentages, and the worst element ids, plus a `watertight` section counting the boundary's holes (boundaryEdges), non-manifold junctions (nonManifoldEdges), inconsistently wound face pairs and zero-area faces — the counts rather than a bare flag, since three boundary edges is a pinhole and three thousand is an open surface. A `surfaceDefects` section says WHERE, for the mesh's own triangle/quad cells: the node-id pairs of hole-rim (boundaryEdges) and non-manifold edges, and the ids of faces wound against a neighbour or of zero area, each capped at defectLimit with the true total beside it (surfaceCellCount 0 = nothing to check; a solid's boundary is not a surface a repair changes). Fix them with mesh_transform's repairSurface op.",
      inputSchema: {
        path: meshPath,
        badIdLimit: z.number().int().positive().optional()
          .describe("Max bad-element ids returned per metric (default 20)"),
        defectLimit: z.number().int().positive().optional()
          .describe("Max entries returned per surface-defect list (default 50)"),
      },
    },
    run(meshQuality)
  );

  server.registerTool(
    "mesh_field_integrate",
    {
      description:
        "Cell-measure-weighted total and mean of the Elemental/Conditional fields — a density field's total mass, a flux field's total power, an occupied volume. Reported for the whole mesh AND independently per named region, which here means one row per entity block and one per SubModelPart, so this is the per-part breakdown. Regions overlap rather than partition: a cell in two of them contributes fully to each, so region totals need not sum to the domain total. A cell whose measure is not computable, or a component whose value is non-finite, is excluded from that component's numerator AND denominator rather than given a fallback weight of 1. Read-only. A Nodal field is refused by name — move it to the cells with mesh_transform's averageField (nodalToElemental) first.",
      inputSchema: {
        path: meshPath,
        variables: z.array(z.string()).optional()
          .describe("Field names to integrate; omit for every cell field the mesh carries"),
      },
    },
    run(meshFieldIntegrate)
  );

  server.registerTool(
    "case_evaluate_quantity",
    {
      description:
        "Evaluate one explicitly selected scalar from a solver result and return a version-1 review record bound to the run id and result-file content revision. Select the field, location, component, region, time step, reduction and unit; units are required and never guessed. Uses the mesh parser's existing field and reduction routines, reads without modifying the result, and leaves missing/non-finite values null.",
      inputSchema: {
        path: meshPath,
        runId: z.string().min(1),
        field: z.string().min(1),
        kind: z.enum(["Nodal", "Elemental", "Conditional"]),
        component: z.enum(["scalar", "x", "y", "z", "magnitude"]),
        region: z.string().optional().describe('"global" or an exact SubModelPart path; descendants are included.'),
        timeStep,
        time: z.number().finite().optional().describe("Explicit physical time for this concrete per-step result file when the file has no embedded timeline; use the verified run monitor coordinate."),
        reduction: z.enum([...GLOBAL_REDUCTIONS] as [GlobalReduction, ...GlobalReduction[]]),
        unit: z.string().min(1),
      },
    },
    run(caseEvaluateQuantity)
  );

  server.registerTool(
    "mesh_curvature",
    {
      description:
        "Discrete curvature of a SURFACE mesh (triangles/quads; a solid is refused — extract its boundary with mesh_extract_skin): per-node mean H, Gaussian K and optionally the principal curvatures k1 >= k2, via meshio++. Returns per-field statistics (min/max/mean and the number of nodes with a defined value), the sum of the angle defects against 2*pi*chi (Gauss-Bonnet — their difference gaussBonnetResidual is ~0 for a sound closed surface and absent for an open one), the boundary/isolated/degenerate node counts and the watertight counts. A sphere of radius R reads H = 1/R and K = 1/R^2. The SIGN of H follows the winding: a uniformly inside-out surface reads -1/R, and a mesh whose faces disagree on winding is flagged in warnings (fix it with mesh_transform's repairSurface first). Boundary nodes of an open surface have no curvature and count as gaps unless includeBoundary is set. Read-only: to write the fields onto the mesh (CURVATURE_MEAN, CURVATURE_GAUSSIAN, CURVATURE_K1/K2 — usable in remesh sizing formulas) run mesh_transform's curvature op.",
      inputSchema: {
        path: meshPath,
        mean: z.boolean().optional().describe("Mean curvature (default true)"),
        gaussian: z.boolean().optional().describe("Gaussian curvature (default true)"),
        principal: z.boolean().optional().describe("The two principal curvatures (default false)"),
        dualArea: z.enum(["mixed-voronoi", "barycentric"]).optional()
          .describe("Per-node dual area the curvatures are divided by (default mixed-voronoi)"),
        includeBoundary: z.boolean().optional().describe("Also compute boundary nodes (default false: they are gaps)"),
      },
    },
    run(meshCurvature)
  );

  server.registerTool(
    "mesh_compare",
    {
      description:
        "Compare two meshes and their fields, matched by ENTITY ID (so the two must share an id space — a re-run, an edit, a restart; the comparison is order-free). Native rather than meshio++'s diff, which would compare a lossy conversion that has already lost ids, kinds, Properties and SubModelParts. Reports a verdict (identical / equal within tolerance / different, where a value is equal when |a-b| <= atol + rtol*|b|), node counts/only-in-A/only-in-B/moved and the max coordinate difference with the worst node id, per-kind entity counts (Elements, Conditions and Geometries are independent id spaces) with changed connectivity (node ORDER is the winding, so a rotated node list counts) and changed cell type, block names only in A/B, SubModelParts only in A/B and per-part membership differences (which upstream diff ignores), and per field: max/mean/RMS |a-b| (the Euclidean norm of the row difference for a vector), max relative error, the id of the worst row, rows outside tolerance, and ids present in only one mesh — a coverage gap, NEVER compared as 0; a non-finite value is likewise a gap. With `variable` it also compares that one field (kind default Nodal; `sourceVariable` if B names it differently) either by id or with correspondence \"spatial\": B's NODAL field is point-sampled (barycentric, through meshio++ interpolate — NOT the mass-preserving transferField) at A's nodes, for two different discretizations of the same domain; a node outside B, or whose sampling cell touches a node with no value, is uncovered (counted, gap in the output) — for a surface B, a point is covered when it projects inside a cell, its distance off the surface is not checked. Cell fields cannot be sampled spatially (move them to the nodes with averageField first). With `outputPath` it writes mesh A carrying <base>_DIFF (signed a-b), <base>_ABS (norm of the difference) and <base>_REL (relative, a gap where |b| = 0) — the difference mesh, identical to mesh_transform's compareField op.",
      inputSchema: {
        pathA: meshPath,
        pathB: meshPath,
        atol: z.number().nonnegative().optional().describe("Absolute tolerance (default 0)"),
        rtol: z.number().nonnegative().optional().describe("Relative tolerance (default 0)"),
        variable: z.string().optional().describe("A field of mesh A to compare in detail (and to write difference fields for)"),
        kind: z.enum(["Nodal", "Elemental", "Conditional"]).optional().describe("Where `variable` lives (default Nodal)"),
        sourceVariable: z.string().optional().describe("The field's name in mesh B, when it differs"),
        correspondence: z.enum(["id", "spatial"]).optional()
          .describe("id (default) matches entities by id; spatial point-samples B's nodal field at A's nodes"),
        output: z.string().optional().describe("Base name for the difference fields (default: the variable)"),
        outputPath: z.string().optional().describe("Write mesh A with the difference fields here (needs `variable`)"),
      },
    },
    run(meshCompare)
  );

  server.registerTool(
    "mesh_derive",
    {
      description:
        "Write a NEW mesh derived from the opened one — not an edit (nothing is written back to the input; use mesh_transform for edits) and the same class as mesh_extract_skin. kind \"slice\" cuts the mesh's own cells with the plane through `origin` with `normal` (meshio++ slice) and gives the cross-section as triangles/quads; kind \"isosurface\" contours the NODAL field `variable` at each of `values` (a cell field is refused — average it first; `component` picks a vector's column, default the magnitude, which is approximate); both carry the interpolated nodal fields and per-cell fields of the parent cell, and tag every produced cell with SOURCE_ENTITY_ID / SOURCE_ENTITY_KIND (0 Elements, 1 Conditions, 2 Geometries) naming the cell of the input it was cut from (the isosurface adds ISO_VALUE and ISO_INDEX); node and cell ids are NEW, and named regions/SubModelParts do not carry over. kind \"threshold\" extracts the region where `variable` (of `fieldKind`, default Nodal) lies in an absolute `range` [lo, hi], or in `normalizedRange` [lo, hi] (0..1) of an explicit fixed `referenceRange` [lo, hi] — or of the frame's own range with referenceRange \"frame\", which changes the physical threshold from one time step to the next and is therefore opt-in. For a Nodal field `rule` \"all\" (default) needs every node of a cell in the window, \"any\" one; a cell field tests the cell's own value. The region KEEPS original ids, groups, fields and Properties: the Conditions and Geometries still lying on it stay, SubModelParts and fields are narrowed, and constraints reaching outside are dropped (counted in the summary). output \"skin\" returns the region's boundary surface instead (new ids). The summary states the selected share of the volume (or area, or length). Written to `outputPath` in the format its extension names (outputFormat picks an ambiguous flavour); .mdpa is legal but slice/isosurface cells carry meshio type names as block names, so prefer .vtu/.vtp/.stl/.ply for those. kind \"decimate\" writes a SIMPLIFIED COPY of a triangle surface (quadric-error edge collapse, meshio++): give exactly one of `ratio` (the fraction of faces to KEEP), `targetFaces` or `maxError`; boundary and crease vertices are pinned by default (`preserveBoundary`, `preserveFeatures`/`featureAngle`, so an open patch keeps its outline exactly) and `frozenPart` pins a SubModelPart's nodes. Surviving faces ARE the source faces — they keep entity ids, kinds, block names, property ids and every elemental/conditional field value (never averaged) — while a node keeps the lowest id merged into it and its nodal fields are upstream's blend of the collapsed endpoints (exact for midpoint/endpoint placement, an approximation for optimal); SubModelParts are narrowed to survivors and constraints are dropped with a warning. The summary reports faces before/after, the achieved reduction and the largest collapse error (also as a share of the bounding-box diagonal). Refused by name for volume cells (extract the skin first), quads (simplexify first), higher-order cells, and lines/points mixed with the surface. Three kinds SAMPLE SPACE instead of cutting the mesh, each producing a regular lattice (a hexahedral mesh): kind \"grid\" builds `dims` cells from `origin` with `spacing` and needs NO `path`; kind \"voxelize\" builds a lattice around the input's surface (its own faces, or the boundary skin of a solid) and keeps the cells whose centre is inside (fill \"inside\", default), that a triangle passes through (\"surface\"), or all of them (\"all\"), writing VOXEL_OCCUPANCY; kind \"sdfVolume\" samples the signed distance to that surface (negative inside) as the nodal field SDF_DISTANCE (or per cell with location \"center\"), on a dense lattice or an adaptive octree (sized by rootResolution/maxDepth, with hanging nodes). Size a lattice with exactly one of `resolution` / `cellSize` (a request over 2e7 cells is refused BEFORE any work with the cell/point counts and an approximate size); padding is absolute plus paddingRelative of the bounding-box diagonal. A non-closed surface makes the sign unreliable near its defects and the summary says so (winding-number tolerates small holes). A DENSE lattice — grid, sdfVolume with structure voxel, voxelize with fill all — may be written as `.vti` (VTK ImageData), which the unstructured writers cannot produce and which alone keeps the sdf:* header (origin, spacing, dims, structure); a partial lattice or an octree must be written as .vtu or another cell format.",
      inputSchema: {
        path: meshPath.optional().describe("The input mesh (required for every kind except \"grid\", which is made from nothing)"),
        kind: z.enum(["slice", "isosurface", "threshold", "decimate", "grid", "voxelize", "sdfVolume"]),
        outputPath: z.string().describe("Where to write the derived mesh; the extension selects the format"),
        outputFormat: z.string().optional().describe("meshio++ writer flavour for an ambiguous extension (.msh, .inp)"),
        origin: z.array(z.number()).length(3).optional().describe("slice: a point on the plane; grid: the lattice origin (default 0,0,0)"),
        normal: z.array(z.number()).length(3).optional().describe("slice: the plane normal (not zero)"),
        variable: z.string().optional().describe("isosurface / threshold: the field"),
        values: z.array(z.number()).optional().describe("isosurface: one or more isovalues"),
        component: z.union([z.number().int().nonnegative(), z.literal("mag")]).optional()
          .describe("A vector field's component index, or \"mag\" (default)"),
        fieldKind: z.enum(["Nodal", "Elemental", "Conditional"]).optional().describe("threshold: where the field lives (default Nodal)"),
        range: z.array(z.number()).length(2).optional().describe("threshold: absolute window [lo, hi]"),
        normalizedRange: z.array(z.number()).length(2).optional().describe("threshold: window [lo, hi] in 0..1 of the reference range"),
        referenceRange: z.union([z.array(z.number()).length(2), z.literal("frame")]).optional()
          .describe("threshold: the fixed [lo, hi] a normalized window refers to, or \"frame\" for this frame's own range (opt-in)"),
        rule: z.enum(["all", "any"]).optional().describe("threshold, Nodal field: every node or any node in the window"),
        output: z.enum(["region", "skin"]).optional().describe("threshold: the region itself (default) or its boundary surface"),
        ratio: z.number().gt(0).max(1).optional().describe("decimate: fraction of the faces to KEEP, in (0, 1]"),
        targetFaces: z.number().int().positive().optional().describe("decimate: absolute face count to stop at"),
        maxError: z.number().positive().optional().describe("decimate: stop when the cheapest collapse's quadric error exceeds this (squared mesh units)"),
        placement: z.enum(["optimal", "midpoint", "endpoint"]).optional().describe("decimate: where the surviving vertex goes (default optimal)"),
        preserveBoundary: z.boolean().optional().describe("decimate: pin boundary vertices (default true)"),
        preserveFeatures: z.boolean().optional().describe("decimate: pin crease vertices (default true)"),
        featureAngle: z.number().positive().optional().describe("decimate: dihedral degrees above which a vertex is a feature (default 30)"),
        frozenPart: z.string().optional().describe("decimate: a SubModelPart whose nodes are never moved or removed"),
        dims: z.array(z.number().int().positive()).length(3).optional().describe("grid: cells along x, y, z"),
        spacing: z.array(z.number().positive()).length(3).optional().describe("grid: cell size along x, y, z (default 1,1,1)"),
        resolution: z.array(z.number().int().positive()).length(3).optional().describe("voxelize / sdfVolume: cells along x, y, z (exactly one of resolution / cellSize)"),
        cellSize: z.number().positive().optional().describe("voxelize / sdfVolume: the lattice cell edge, in mesh units"),
        bounds: z.array(z.number()).length(6).optional().describe("voxelize / sdfVolume: explicit lattice bounds [xmin, ymin, zmin, xmax, ymax, zmax]"),
        padding: z.number().nonnegative().optional().describe("voxelize / sdfVolume: absolute padding around the shape"),
        paddingRelative: z.number().nonnegative().optional().describe("voxelize / sdfVolume: padding as a fraction of the shape's bounding-box DIAGONAL (voxelize default 0, sdfVolume 0.1)"),
        fill: z.enum(["all", "surface", "inside"]).optional().describe("voxelize: inside (default), surface, or all"),
        sign: z.enum(["pseudonormal", "winding-number", "unsigned"]).optional().describe("voxelize / sdfVolume: how inside is decided (winding-number tolerates small holes)"),
        attachOccupancy: z.boolean().optional().describe("voxelize: write VOXEL_OCCUPANCY (default true)"),
        structure: z.enum(["voxel", "octree"]).optional().describe("sdfVolume: a dense lattice (default) or an adaptive octree"),
        location: z.enum(["corner", "center"]).optional().describe("sdfVolume: nodal (corner, default) or per-cell (center) values"),
        band: z.number().nonnegative().optional().describe("sdfVolume: exact values only within this distance of the surface (0 = none)"),
        rootResolution: z.number().int().positive().optional().describe("sdfVolume octree: root cells per axis (default 8)"),
        maxDepth: z.number().int().positive().optional().describe("sdfVolume octree: refinement depth (default 4)"),
      },
    },
    run(meshDerive)
  );

  server.registerTool(
    "mesh_probe",
    {
      description:
        "Sample a NODAL field along a polyline: distance-versus-value rows for the quantitative question the Clip and Field panels answer only visually. `points` are the polyline's vertices (at least two); `samples` equidistant points (default 101, at most 100 000) are taken along it by arclength, both ends included, and the field is read at each by barycentric interpolation inside the mesh (meshio++). A sample is covered only when it lies inside the mesh AND every node of its cell carries a value — otherwise the value is null: a line that leaves the domain, or crosses a region the field was never written, shows as a gap, NEVER a fabricated 0 (for a surface mesh a point counts as covered when it projects inside a cell; its distance off the surface is not checked). A vector field returns one column per component, named like the data table's. A cell field is refused — average it to the nodes first. With allSteps it repeats the probe over EVERY step of the time series the file belongs to (filename-grouped, or in-file); a step that fails to parse is recorded as an error and skipped, never fatal. outputPath writes a .csv (with a leading `step` column for allSteps).",
      inputSchema: {
        path: meshPath,
        points: z.array(z.array(z.number()).length(3)).min(2).describe("The polyline's vertices, each [x, y, z]"),
        variable: z.string().describe("A nodal field"),
        samples: z.number().int().min(2).max(100000).optional().describe("Samples along the path (default 101)"),
        allSteps: z.boolean().optional().describe("Repeat over every step of the time series"),
        outputPath: z.string().optional().describe("Write the table as .csv"),
      },
    },
    run(meshProbe)
  );

  server.registerTool(
    "mesh_split",
    {
      description:
        "Split one mesh into SEVERAL files, each keeping the SOURCE's own node and entity ids, Elements/Conditions/Geometries kinds, Properties, SubModelParts, fields and (when every node survives) constraints — so a part is a Kratos mesh, not a meshio++ conversion; a manifest is written beside them and returned. by \"partition\" writes `nparts` per-part meshes for a distributed run: meshio++ decides which cells each part OWNS (every cell is owned by exactly one) and, with ghostLayers > 0, which face-adjacent neighbours it also HOLDS as ghosts; each part carries PARTITION_INDEX (the OWNER of every cell — a ghost's is its neighbour), PARTITION_GHOST (0/1) and a `Ghost` SubModelPart, and the manifest gives per part its owned/ghost counts by kind, node count and interface nodes (owned nodes shared with another part). `weights` names an ELEMENTAL field of per-element weights (finite, > 0; an element without a value weighs 1). The WebAssembly build has NO KaHIP: method \"kahip\" throws by name and \"auto\"/\"sfc\" is a Hilbert space-filling-curve cut balanced by cell count/weight with good locality but no edge-cut minimization (mesh_capabilities.partitioning reports what the live build can run); the manifest gives `imbalance` = max/mean owned elements − 1. by \"component\" splits into connected bodies (elements sharing a node; conditions follow the body that holds every node they name, and one that bridges two bodies belongs to neither and is counted; component_0 is the largest, fragments under fragmentFraction (default 0.01) of it are flagged `isolated`); by \"type\" splits by element block; by \"field\" splits by the distinct values of the scalar ELEMENTAL `variable` (at most 1000 distinct values). Files are `<stem>_<key><format>` in outputDir (format defaults to the source's extension when exportable, else .vtu). To just see the components or the decomposition on the mesh, use mesh_transform's markComponents / partition ops instead.",
      inputSchema: {
        path: meshPath,
        by: z.enum(["partition", "component", "type", "field"]),
        outputDir: z.string().describe("Directory for the part files and the manifest (created if missing)"),
        format: z.string().optional().describe("Extension of the part files, e.g. .vtu (default: the source's, else .vtu)"),
        outputFormat: z.string().optional().describe("meshio++ writer flavour for an ambiguous extension (.msh, .inp)"),
        nparts: z.number().int().positive().optional().describe("partition: number of parts"),
        method: z.enum(["sfc", "kahip", "auto"]).optional().describe("partition: sfc (default), or auto; kahip is unavailable in this build"),
        imbalance: z.number().nonnegative().optional().describe("partition: load imbalance tolerance (default 0.03)"),
        seed: z.number().int().optional().describe("partition: seed (default 0)"),
        ghostLayers: z.number().int().min(0).max(8).optional().describe("partition: layers of ghost cells each part also holds (default 0)"),
        weights: z.string().optional().describe("partition: an Elemental field of per-element weights"),
        variable: z.string().optional().describe("field: the scalar Elemental field to split by"),
        fragmentFraction: z.number().min(0).max(1).optional().describe("component: flag components smaller than this fraction of the largest (default 0.01)"),
      },
    },
    run(meshSplit)
  );

  server.registerTool(
    "mesh_size",
    {
      description:
        "Compute nodal size (Kratos NODAL_H = min distance to a node sharing an element) and element size (mean edge length); returns nodal/element box-whisker statistics and the IQR-outlier small/large element ids.",
      inputSchema: {
        path: meshPath,
        outlierLimit: z.number().int().positive().optional()
          .describe("Max small/large element ids returned (default 50)"),
      },
    },
    run(meshSize)
  );

  server.registerTool(
    "mesh_transform",
    {
      description:
        "Apply a sequence of mesh operations and write the result. Accepts inline `ops` or a `recipePath` (a JSON recipe saved from the extension's Edit sidebar — same format). " +
        "WARNING: when `outputPath` is omitted the input file is overwritten (like File ▸ Save).\n" +
        OPS_HELP,
      inputSchema: {
        path: meshPath,
        ops: z.array(z.record(z.string(), z.unknown())).optional()
          .describe("Operation records applied in order (see the op list in the tool description)"),
        recipePath: z.string().optional()
          .describe("Path to a saved operations recipe JSON (alternative to `ops`)"),
        outputPath: z.string().optional()
          .describe(`Output file; extension picks the format (${EXPORTABLE_EXTENSIONS.join(", ")}). Omitted = overwrite the input`),
      },
    },
    run(meshTransform)
  );

  server.registerTool(
    "mesh_convert",
    {
      description:
        `Convert a mesh between formats: read any supported format, write by output extension (${EXPORTABLE_EXTENSIONS.join(", ")}). Surface formats (.stl/.obj/.ply) receive the boundary triangles of volume meshes. Ambiguous input extensions (.msh, .inp) are resolved by trying the default format and then the alternatives; pass inputFormat/outputFormat to be explicit.`,
      inputSchema: {
        path: meshPath,
        outputPath: z.string().describe("Output file; its extension selects the target format"),
        inputFormat,
        outputFormat: z
          .string()
          .optional()
          .describe(
            `Force a meshio++ writer instead of inferring from the output extension (${MESHIO_WRITER_KEYS.join(", ")}).`
          ),
        timeStep,
        piece,
        dropGhosts,
        region,
      },
    },
    run(meshConvert)
  );

  server.registerTool(
    "mesh_extract_submodelpart",
    {
      description:
        "Slice one SubModelPart (plus its descendant subtree) out of a mesh into a standalone file. Node and entity ids are preserved.",
      inputSchema: {
        path: meshPath,
        submodelpart: z.string().describe('Slash-separated SubModelPart path, e.g. "Parts_Solid" or "Parent/Child"'),
        outputPath: z.string().describe("Output file; its extension selects the format"),
      },
    },
    run(meshExtractSubModelPart)
  );

  server.registerTool(
    "mesh_extract_skin",
    {
      description:
        `Extract the boundary skin of a mesh's volume cells (plus any pre-existing surface cells) as a standalone surface mesh. ${SKIN_HELP}`,
      inputSchema: {
        path: meshPath,
        outputPath: z.string().describe("Output file; its extension selects the format"),
      },
    },
    run(meshExtractSkin)
  );

  server.registerTool(
    "mesh_export_table",
    {
      description:
        "Tabulate every node/element/condition/geometry as rows of plain values — id, coordinates or block+connectivity, and every field defined at that entity. " +
        "This is the only tool that reports field VALUES (mesh_info reports field metadata; mesh_find_entity answers for one id). " +
        "With `outputPath` it writes the WHOLE table as .csv or .xlsx; without one it returns `limit` rows starting at `offset` as JSON (default 100, max 10000). " +
        "A scalar field is one column; a 2-3 component field splits into NAME_X/_Y/_Z and a wider one into NAME_0..NAME_n. " +
        "A field's columns appear only when a row of this kind actually carries a value, so a partition's Elemental PARTITION_INDEX does show up on the Geometries table. " +
        "Caveat: Kratos gives each entity kind its own id space, so a field spanning several kinds resolves last-write-wins for a colliding id — the same behaviour as the viewer's field panel.",
      inputSchema: {
        path: meshPath,
        kind: z.enum(["Nodes", "Elements", "Conditions", "Geometries"]),
        outputPath: z
          .string()
          .optional()
          .describe("Write the whole table here; .csv or .xlsx. Omit to get rows as JSON"),
        submodelpart: z
          .string()
          .optional()
          .describe("Dotted SubModelPart path — restricts rows to that part and its subtree"),
        membership: z
          .boolean()
          .optional()
          .describe("Add a SubModelParts column listing each row's memberships"),
        nodeColumns: z
          .boolean()
          .optional()
          .describe("Split connectivity into n1..nN columns instead of one joined cell"),
        limit: z.number().int().optional().describe("JSON mode: rows to return (default 100, max 10000)"),
        offset: z.number().int().optional().describe("JSON mode: first row to return (default 0)"),
        inputFormat,
        timeStep,
      },
    },
    run(meshExportTable)
  );

  server.registerTool(
    "mesh_field_series",
    {
      description:
        "Read one entity's value for one variable across EVERY step of a time series — the headless mirror of the viewer's \"Plot over time\". " +
        "This is the only tool that reads a value across steps: mesh_info reports field metadata, mesh_export_table reads one step, mesh_find_entity reads one id. " +
        "Steps are discovered from a single path exactly as the preview does: a sibling <prefix>_<rank>_<step> series (VTK, STL/OBJ/PLY, and meshio formats without an in-file timeline), an in-file series (Exodus, GiD postprocess, XDMF, OpenFOAM time directories), or a lone file. " +
        "`source` says which was found — \"single\" means the path is not part of a series, so one point is the honest answer rather than a broken timeline. " +
        "A gap in `values` is null, never 0: `missingField` counts steps where the variable is not written and `missingId` steps where the entity is absent, because those are different problems. " +
        "`topologyChangedAt` warns that the mesh changed size mid-series, after which the id may not be the same entity. " +
        "Geometries are refused by name — they carry no field values. Writes a .csv when `outputPath` is given.",
      inputSchema: {
        path: meshPath,
        entityType: z.enum(["Node", "Element", "Condition"]),
        entityId: z.number().int().describe("The Kratos entity id"),
        variable: z.string().describe("Field variable name, e.g. DISPLACEMENT"),
        outputPath: z.string().optional().describe("Write the series here as .csv"),
        offset: z.number().int().optional().describe("First step to read (default 0)"),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Steps to read (default 200, max 5000)"),
      },
    },
    run(meshFieldSeries)
  );

  server.registerTool(
    "mesh_pack_series",
    {
      description:
        "Pack a solver run's per-step mesh files into ONE time-series file. " +
        "A Kratos solve writes one mesh per step, so a finished run is a directory of hundreds of files that must be kept, copied and opened together; this combines them into a single transient XDMF. " +
        "`path` is either the vtk_output directory or any one file of the series — the steps are found the same way the preview finds them (<prefix>_<rank>_<step>.<ext>, including surface and meshio formats), and the step LABEL becomes the time, so the axis carries the Kratos step numbers rather than 0..N-1. " +
        "This is NOT mesh_convert with outputFormat xdmf: that writes ONE mesh, this writes every step. " +
        "Only .xdmf/.xmf are accepted — it is the one format that carries a mesh time series — and the sibling .h5 it writes is part of the output, not an extra: an .xdmf without it is unreadable. " +
        "Refuses a path that is a single file or a format already carrying its own steps (Exodus, GiD, a packed XDMF, OpenFOAM time directories), because there is nothing to combine. " +
        "Also refuses a series whose mesh changes between steps: an XDMF time series carries one grid for all steps, so that series cannot be one file. " +
        "Streams one step at a time, so a 200-step run costs one step of memory, and the result re-opens here as a timeline.",
      inputSchema: {
        path: z
          .string()
          .describe("The vtk_output directory, or any one step file of the series"),
        outputPath: z.string().describe("Where to write the packed series (.xdmf)"),
      },
    },
    run(meshPackSeries)
  );

  server.registerTool(
    "mesh_find_entity",
    {
      description:
        "Locate an entity by id: a Node returns its coordinates, an Element/Condition/Geometry its block and connectivity — plus the SubModelParts containing it.",
      inputSchema: {
        path: meshPath,
        entityType: z.enum(["Node", "Element", "Condition", "Geometry"]),
        entityId: z.number().int().describe("The Kratos entity id"),
      },
    },
    run(meshFindEntity)
  );

  server.registerTool(
    "mesh_select",
    {
      description:
        "Evaluate a selection predicate over a mesh and return the entity ids PER KIND (Elements, Conditions and Geometries each have their own id space) — the feed for mesh_transform's assignProperty and createSubModelPartFromSelection. Seed kinds: " +
        '{kind:"part","path":<part path>} (the part subtree) | ' +
        '{kind:"field", variable, blockKind:"Nodal|Elemental|Conditional", lo, hi, rule?:"all|any", component?:<mag|index>} (the viewer Threshold-mode cell set) | ' +
        '{kind:"quality", metric:"edgeRatio|minAngle|maxAngle|gradation"} (bad/unacceptable elements) | ' +
        '{kind:"property", propertyId}. Read-only; ids are capped in the reply (pass outputPath for the uncapped JSON file).',
      inputSchema: {
        path: meshPath,
        timeStep,
        seed: z.object({ kind: z.string().describe('"part" | "field" | "quality" | "property"') }).passthrough().describe("The selection predicate (see the kind list above)"),
        limit: z.number().int().positive().optional().describe("Per-kind id cap in the reply (default 10000)"),
        outputPath: z.string().optional().describe("Write the uncapped ids as JSON next to the chain instead of only returning them"),
      },
    },
    run(meshSelect)
  );

  server.registerTool(
    "mesh_capabilities",
    {
      description:
        "meshio++ capability inventory: the installed WASM build's readers/writers, per-reader options-awareness (timeStep/lenient), backend and cgnslib — next to the extension's routing (read candidates, write targets, in-file vs filename timelines, header-only metadata set, lenient retries, unrouted keys with reasons). Ask this before assuming a format, reader key or timeStep works.",
      inputSchema: {},
    },
    run(meshCapabilities)
  );

  server.registerTool(
    "problemtype_list",
    {
      description:
        "List available Kratos problemtypes: the built-ins (structural, fluid, convection-diffusion, potential flow, shallow water) plus workspace-authored .js/.py problemtypes; load failures are reported per entry.",
      inputSchema: { workspaceDirs: WORKSPACE_DIRS },
    },
    run(problemtypeList)
  );

  server.registerTool(
    "problemtype_describe",
    {
      description:
        "Full authoring spec of one problemtype: its section forms (field ids/types/defaults/enums), conditions (boundary conditions/loads with their parameters), material laws, and output options — plus a default CaseState skeleton to edit and feed to case_write_state / case_generate.",
      inputSchema: {
        problemtype: z.string().describe('Problemtype id, e.g. "structural" (see problemtype_list)'),
        workspaceDirs: WORKSPACE_DIRS,
      },
    },
    run(problemtypeDescribe)
  );

  server.registerTool(
    "case_validate",
    {
      description:
        "Validate a case setup against a mesh and its problemtype declaration: unknown condition/material-law ids, SubModelPart paths missing from the mesh, malformed state pieces. Reads <stem>.kratoscase.json next to the mesh unless `state`/`casePath` is given.",
      inputSchema: {
        meshPath: z.string().describe("Path to the mesh (any supported format)"),
        problemtype: z.string().optional().describe("Problemtype id (default: the state's problemtypeId)"),
        state: z.record(z.string(), z.unknown()).optional().describe("Inline CaseState to validate"),
        casePath: z.string().optional().describe("Path to a .kratoscase.json file"),
        workspaceDirs: WORKSPACE_DIRS,
      },
    },
    run(caseValidate)
  );

  server.registerTool(
    "case_write_state",
    {
      description:
        "Write a CaseState to <stem>.kratoscase.json next to the mesh (the extension's Problemtype sidebar picks it up automatically). The state is normalized by the tolerant case parser; malformed pieces degrade to defaults with warnings.",
      inputSchema: {
        meshPath: z.string().describe("Path to the mesh the case belongs to"),
        state: z.record(z.string(), z.unknown())
          .describe("The CaseState (start from problemtype_describe's defaultState)"),
      },
    },
    run(caseWriteState)
  );

  server.registerTool(
    "case_generate",
    {
      description:
        "Generate the Kratos simulation files and versioned preparation evidence next to the mesh: ProjectParameters.json, the materials JSON, MainKratos.py and kkss-preparation-v1.json — mirroring the extension's Generate button, including solver mesh-name adaptation (writes <stem>_case.mdpa when block renames are needed; the original mesh stays untouched). A non-.mdpa mesh is always converted to <stem>_case.mdpa first, since the solver reads .mdpa. Uses <stem>.kratoscase.json unless `state`/`casePath` is given; with only `problemtype`, generates from that problemtype's defaults.",
      inputSchema: {
        meshPath: z.string().describe("Path to the mesh (any supported format)"),
        problemtype: z.string().optional()
          .describe("Problemtype id (default: the state's problemtypeId; required when no state exists)"),
        state: z.record(z.string(), z.unknown()).optional().describe("Inline CaseState"),
        casePath: z.string().optional().describe("Path to a .kratoscase.json file"),
        workspaceDirs: WORKSPACE_DIRS,
      },
    },
    run(caseGenerate)
  );

  server.registerTool(
    "case_run",
    {
      description:
        "Start a Kratos solve for a mesh (generates the case files first unless generate:false). " +
        "The server never OWNS the run: its stdout is the JSON-RPC transport and it exits with its client, so the solver is always spawned DETACHED, with stdout and stderr appended to <stem>.kratosrun.log, and it survives this process by construction. " +
        "waitSeconds (default 10, 0 = return at once) is how long to block for the exit — one knob, not a wait flag plus a timeout. " +
        "Expiry is NOT a failure: it returns status \"running\" with the pid and the log path and the run continues, because there is no server-side timeout and the client's own request timeout is a number this process cannot observe. The absence of exitCode is what says the run has not ended. " +
        "Poll case_status afterwards — note it reports \"detached\" for the same live run, because it has only a pid and pids are reused, where case_run holds the handle and can honestly say \"running\". " +
        "Refuses to start over a run that may still be active unless force:true. " +
        "Once this process exits nothing can record how a detached run ended, and case_status will report it orphaned rather than invent an exit code.",
      inputSchema: {
        meshPath: z.string().describe("Path to the mesh the case belongs to (any supported format)"),
        python: z
          .string()
          .optional()
          .describe("Python interpreter to run (default: python3, or python on Windows)"),
        installPath: z
          .string()
          .optional()
          .describe(
            "Kratos installation folder, or a source checkout whose build is under bin/<config>. Omit for a pip-installed Kratos, which needs no environment changes."
          ),
        extraEnv: z
          .record(z.string(), z.string())
          .optional()
          .describe("Extra environment variables for the solver process"),
        scriptName: z
          .string()
          .optional()
          .describe("Script to run in the case folder (default MainKratos.py)"),
        waitSeconds: z
          .number()
          .optional()
          .describe("Seconds to wait for the exit before handing off (default 10, 0 = do not wait, max 600)"),
        generate: z
          .boolean()
          .optional()
          .describe(
            "Regenerate the case files first (default true). Skipping risks solving a stale ProjectParameters.json, which fails silently rather than loudly."
          ),
        force: z.boolean().optional().describe("Start even if a run may still be active"),
        problemtype: z.string().optional().describe("Problemtype id, when generating"),
        casePath: z.string().optional().describe("Case state file (default <stem>.kratoscase.json)"),
        workspaceDirs: WORKSPACE_DIRS,
        requestId: z.string().optional().describe("Stable queue request ID. Requires ownerId and runDirectory; retries never dispatch twice."),
        ownerId: z.string().optional().describe("Owner identity required for request lookup and cancellation."),
        runDirectory: z.string().optional().describe("Fresh isolated workspace for this run; mesh and case state are snapshotted here."),
      },
    },
    run(caseRun)
  );

  server.registerTool(
    "case_stop",
    {
      description:
        "Stop the latest Kratos run for a mesh, by the pid in its <stem>.kratosrun.json sidecar. " +
        "Escalates SIGINT then SIGTERM then SIGKILL, returning which rung worked: SIGINT is what python turns into KeyboardInterrupt, so finalizers run and the last result file closes rather than truncating. On Windows signals are not real, so this is an immediate terminate — no graceful rung there. " +
        "Records the stop before signalling so the run is reported cancelled rather than failed. A run started in the EDITOR is stopped too, but the editor owns its process handle and writes the final status, so it may still be recorded as failed — the Stop button in the Kratos Runs view gives the right label. " +
        "A run that has already ended is never signalled: pids are reused, so signalling one that is not verifiably the recorded run could hit an unrelated process.",
      inputSchema: {
        meshPath: z.string().optional().describe("Path to the mesh the case belongs to (legacy latest-run lookup)"),
        requestId: z.string().optional().describe("Stable execution request ID"),
        ownerId: z.string().optional().describe("Must match the recorded request owner; mismatches are refused"),
        runDirectory: z.string().optional().describe("Isolated run workspace holding the durable receipt"),
      },
    },
    run(caseStop)
  );

  server.registerTool(
    "case_status",
    {
      description:
        "Report the latest Kratos run for a mesh: its status, exit code, command, pid, and a vtk_output/ summary (file count and latest step). " +
        "Reads the <stem>.kratosrun.json sidecar the extension writes, so an agent can see what a run started in the editor is doing — the MCP server cannot own a solver itself (its stdout is the JSON-RPC transport and it exits with its client). " +
        "Statuses are reconciled against the OS rather than repeated: a record still marked running whose process is gone reports \"orphaned\", and one whose pid is alive reports \"detached\" — never \"running\", because pids are reused so liveness is a maybe. " +
        "\"none\" means no run has ever been recorded for this mesh.",
      inputSchema: {
        meshPath: z.string().optional().describe("Path to the mesh the case belongs to (legacy latest-run lookup)"),
        requestId: z.string().optional().describe("Stable execution request ID"),
        ownerId: z.string().optional().describe("Must match the recorded request owner"),
        runDirectory: z.string().optional().describe("Isolated run workspace holding the durable receipt"),
      },
    },
    run(caseStatus)
  );

  server.registerTool(
    "problem_pack",
    {
      description:
        "Bundle a whole problem into one zip (the extension's File ▸ Save problem…): the mesh file, the edit recipe (<stem>.ops.json or an explicit recipePath), <stem>.kratoscase.json and the generated case files (ProjectParameters.json, MainKratos.py, the materials file(s) it references, <stem>_case.mdpa) — whichever exist. Writes a kratosproblem.json manifest into the archive.",
      inputSchema: {
        meshPath: meshPath,
        outputPath: z.string().optional()
          .describe("Archive to write (default: <stem>.kratosproblem.zip next to the mesh)"),
        recipePath: z.string().optional()
          .describe("Operations recipe to bundle (default: <stem>.ops.json next to the mesh, when present)"),
      },
    },
    run(problemPack)
  );

  server.registerTool(
    "problem_unpack",
    {
      description:
        "Extract a problem archive (the extension's File ▸ Load problem…) into a folder and report the contained mesh and ops recipe. Refuses to overwrite existing files unless `overwrite` is set. Apply the returned opsRecipePath with mesh_transform to reproduce the edited mesh.",
      inputSchema: {
        archivePath: z.string().describe("Path to a .zip problem archive"),
        destDir: z.string().optional()
          .describe("Folder to extract into (default: the archive's folder)"),
        overwrite: z.boolean().optional().describe("Overwrite existing files (default false)"),
      },
    },
    run(problemUnpack)
  );
}
