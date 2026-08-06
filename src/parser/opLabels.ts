/**
 * Human-readable operation labels + the op-name union.
 *
 * Pulled out of operations.ts so they can be imported from the webview bundle
 * without pulling in operations.ts's own `node:fs`/`node:path` imports (used
 * by mergeMesh's file-reading helpers) — the webview build targets
 * `platform: "browser"` and cannot resolve those. Same reasoning as
 * sizeExpr.ts/subModelPartTree.ts, both already shared this way.
 *
 * `OpRecord` is imported type-only, so this creates no runtime dependency back
 * onto operations.ts (a type-only reference is erased at compile time) even
 * though operations.ts itself imports OP_LABELS/OpName back from here.
 */

import type { OpRecord } from "./operations";

export type OpName = OpRecord["op"];

/** Human-readable labels for the history list UI and the operation queue. */
export const OP_LABELS: Record<OpName, string> = {
  linearToQuadratic: "Linear → Quadratic",
  removeOrphanNodes: "Remove orphan nodes",
  mergeNodes: "Merge coincident nodes",
  scale: "Scale",
  translate: "Translate",
  rotate: "Rotate",
  deleteSubModelPart: "Delete SubModelPart",
  renameSubModelPart: "Rename SubModelPart",
  createSubModelPart: "Create SubModelPart",
  moveSubModelPart: "Move SubModelPart",
  mergeSubModelParts: "Merge SubModelParts",
  addSubModelPartEntities: "Add entities to SubModelPart",
  removeSubModelPartEntities: "Remove entities from SubModelPart",
  writeMeshSizeFields: "Write mesh size fields",
  setElementRadius: "Set element radius",
  smooth: "Smooth",
  // "Reorder" and "Renumber" sit next to each other in the sidebar and mean
  // genuinely different things, so both labels say which one they are.
  reorder: "Reorder nodes (storage order)",
  renumber: "Renumber (compact ids)",
  partition: "Partition",
  linearize: "Quadratic → Linear",
  refine: "Refine (uniform subdivision)",
  simplexify: "Simplexify",
  crop: "Crop",
  fieldCalc: "Field calculator",
  averageField: "Average field (nodal ↔ elemental)",
  fieldGradient: "Field gradient / divergence / curl",
  mergeMesh: "Merge mesh",
  remesh: "Remesh (MMG)",
  levelset: "Level-set split (MMG)",
};
