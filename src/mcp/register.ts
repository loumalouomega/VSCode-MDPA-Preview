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
  meshSize,
  meshTransform,
  meshConvert,
  meshExtractSubModelPart,
  meshExtractSkin,
  meshFindEntity,
  problemtypeList,
  problemtypeDescribe,
  caseValidate,
  caseWriteState,
  caseGenerate,
  problemPack,
  problemUnpack,
} from "./tools";
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
- {"op":"writeMeshSizeFields","target":"nodal|element|both"} — persist NODAL_H / ELEMENT_H into the mesh's fields
- {"op":"setElementRadius","value":0.5,"mode":"absolute|multiply","target?":"block_1"} — set (or scale) the RADIUS of the sphere/particle (one-node) elements. "absolute" CREATES the field when the mesh has none, which is the usual case for an Exodus SPHERE file; "multiply" scales existing values and is a noop without them. Omitted target = whole mesh; a target names a SubModelPart and covers its subtree
- {"op":"remesh","mode":"factor|hsiz|optimize|expr","factor?":0.5,"hsiz?":0.1,"sizeExpr?":"0.5*h","sizeParts?":[{"path":"Inlet","expr":"0.25*h"}],"hmin?":..,"hmax?":..,"hausd?":..,"hgrad?":..,"angleDetection?":45,"nosurf?":true,"noinsert?":true,"noswap?":true,"nomove?":true,"module?":"mmg2d|mmgs|mmg3d"} — MMG remeshing (runs in-process; large meshes take a while and block the server). mode "expr" sets the per-node target size from a formula: vars h (nodal size NODAL_H), x y z (coords), mean std min max median q1 q3 iqr (global NODAL_H stats); funcs min max clamp abs sqrt sin cos tan exp log pow floor ceil round; e.g. "clamp(0.5*h, mean-1.5*std, mean+1.5*std)". sizeParts assigns per-SubModelPart expression overrides (first match wins; stats stay global)
- {"op":"levelset","variable":"<nodal field>","isovalue?":0,"isosurf?":true,"hmin?":..,"hmax?":..,"hausd?":..,"hgrad?":..,"module?":".."} — MMG level-set split along a nodal field isosurface
- {"op":"smooth","method?":"taubin|laplacian","iterations?":10,"lambda?":0.5,"mu?":-0.53,"fixBoundary?":true,"preserveFeatures?":true,"featureAngle?":45,"guardInversion?":true} — meshio++ mesh smoothing (oracle: only coordinates move, node/cell count and every field are untouched). Taubin (default) is shrink-free; Laplacian shrinks without bound
- {"op":"reorder","method":"rcm|morton|hilbert"} — renumber nodes for cache locality / bandwidth (a pure permutation — coordinates, connectivity, SubModelParts and fields follow along, nothing is lost). "rcm" minimizes bandwidth; "morton"/"hilbert" optimize spatial locality
- {"op":"partition","nparts":4,"method?":"sfc|kahip|auto","createParts?":false} — label cells into nparts via a space-filling curve (the wasm build has no KaHIP: "kahip" throws, "auto" resolves to "sfc"; balanced by cell count, not edge cut) and attach as an Elemental PARTITION_INDEX field; createParts also emits one SubModelPart per partition
- {"op":"linearize"} — the inverse of linearToQuadratic: drop mid-edge nodes (Triangle2D6→2D3, Tet10→Tet4, Hex20→Hex8, …), then removeOrphanNodes
- {"op":"refine","levels?":1} — uniform subdivision (tri/quad/tet/hex/wedge→4 or 8 children, line→2), up to 4 levels; shared edges/faces dedup to one new node, Nodal fields interpolate exactly, Elemental/Conditional fields replicate to children, SubModelPart membership grows to cover the new children
- {"op":"simplexify"} — convert non-simplex cells to simplices (hex→6 tets, wedge→3 tets, pyramid→2 tets, quad→2 triangles); the first child keeps the parent's id, siblings get fresh ids, fields and SubModelPart membership replicate
- {"op":"crop","kind":"bbox","lo":[x,y,z],"hi":[x,y,z],"mode?":"all|any"} | {"op":"crop","kind":"plane","point":[x,y,z],"normal":[x,y,z],"mode?":"all|any"} — keep cells whose nodes are inside a box or on the normal side of a plane ("all" nodes inside vs. "any"), then removeOrphanNodes; SubModelParts narrow to survivors
- {"op":"fieldCalc","expr":"0.5*(temp+273.15)","location":"Nodal|Elemental|Conditional","output":"NEW_VAR"} — new field from a formula (own recursive-descent evaluator, never eval) over x,y,z plus every existing field at that location (a vector field's components as name_x/name_y/name_z); a bad formula is rejected before anything is applied, division by zero yields inf
- {"op":"averageField","variable":"TEMP","direction":"nodalToElemental|elementalToNodal","target?":"Elements|Conditions","output?":"TEMP_AVG"} — average a field across the node/cell incidence (nodalToElemental: mean over a cell's own nodes; elementalToNodal: mean over incident cells, unweighted)
- {"op":"mergeMesh","path":"/abs/path/to/other.mdpa","weld?":false,"tolerance?":1e-6,"name?":"Merged"} — append another mesh file's nodes/cells (ids offset past the current max) wrapped in a new SubModelPart; weld optionally welds coincident nodes across the seam via the same grid as mergeNodes`;

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
        `Needed for the formats no extension defaults to: .msh means gmsh (pass "ansys"/"freefem" for those), .inp means abaqus (pass "ansysinp").`
    );

  const timeStep = z
    .number()
    .int()
    .optional()
    .describe(
      "Selects a step of a multi-step file: Exodus (meshio++ >= 8.6.0) and MED (>= 9.9.0). " +
        "0 is the first step (the default); negative counts from the end. Out of range throws " +
        "naming the available count — see mesh_info's timeValues for how many there are, which " +
        "Exodus reports and MED does not (MED has no metadata reader upstream, so its step " +
        "count is only discoverable by asking for one)."
    );

  server.registerTool(
    "mesh_info",
    {
      description:
        "Parse a mesh file and summarize it: node/element/condition counts, bounds, entity blocks, the SubModelPart tree, data fields, parser diagnostics, and — for a multi-step file (Exodus) — the selected step and every available time value.",
      inputSchema: { path: meshPath, inputFormat, timeStep },
    },
    run(meshInfo)
  );

  server.registerTool(
    "mesh_quality",
    {
      description:
        "Compute geometric mesh-quality metrics (edge ratio, min/max angle, size gradation) with Kratos-default thresholds; returns per-metric statistics, band percentages, and the worst element ids.",
      inputSchema: {
        path: meshPath,
        badIdLimit: z.number().int().positive().optional()
          .describe("Max bad-element ids returned per metric (default 20)"),
      },
    },
    run(meshQuality)
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
        meshPath: z.string().describe("Path to the .mdpa mesh"),
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
        meshPath: z.string().describe("Path to the .mdpa mesh the case belongs to"),
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
        "Generate the Kratos simulation files next to the mesh: ProjectParameters.json, the materials JSON, and MainKratos.py — mirroring the extension's Generate button, including solver mesh-name adaptation (writes <stem>_case.mdpa when block renames are needed; the original mesh stays untouched). Uses <stem>.kratoscase.json unless `state`/`casePath` is given; with only `problemtype`, generates from that problemtype's defaults.",
      inputSchema: {
        meshPath: z.string().describe("Path to the .mdpa mesh"),
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
