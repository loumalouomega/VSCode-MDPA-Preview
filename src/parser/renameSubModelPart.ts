/**
 * Renames a SubModelPart: changes its `name` and recomputes its `path` (and the
 * `path` of every descendant, since paths embed ancestor names). Only the
 * SubModelPart tree is touched — blocks, fields and nodes are untouched, because
 * SubModelParts reference entities by id, not by name/path.
 *
 * Pure module: no vscode / DOM / vtk.js imports so it stays Node-testable. The
 * input is never mutated; a fresh MdpaModel is returned.
 */

import { MdpaModel, SubModelPart } from "./types";

export interface RenameSubModelPartResult {
  model: MdpaModel;
  /** True when the path matched, the new name is valid, and something changed. */
  renamed: boolean;
}

/** Rebuilds a subtree's `path`s from `parentPath`, keeping names/ids/children. */
function rebasePaths(part: SubModelPart, parentPath: string): SubModelPart {
  const path = parentPath ? `${parentPath}/${part.name}` : part.name;
  return {
    ...part,
    path,
    children: part.children.map((c) => rebasePaths(c, path)),
  };
}

/**
 * Walks `parts` (siblings sharing `parentPath`); when the node whose `path`
 * matches `target` is found, renames it to `newName` and rebases its subtree.
 * Returns `{ list, done }` — `done` is true once the rename was applied.
 */
function renameIn(
  parts: SubModelPart[],
  target: string,
  newName: string,
  parentPath: string
): { list: SubModelPart[]; done: boolean } {
  let done = false;
  const list = parts.map((p) => {
    if (!done && p.path === target) {
      // Sibling name collision → refuse (Kratos disallows duplicate names).
      if (parts.some((s) => s !== p && s.name === newName)) return p;
      done = true;
      const renamed: SubModelPart = { ...p, name: newName };
      return rebasePaths(renamed, parentPath);
    }
    const nested = renameIn(p.children, target, newName, p.path);
    if (nested.done) {
      done = true;
      return { ...p, children: nested.list };
    }
    return p;
  });
  return { list, done };
}

export function renameSubModelPart(
  model: MdpaModel,
  path: string,
  newName: string
): RenameSubModelPartResult {
  const trimmed = newName.trim();
  // Empty or path-separator-bearing names are invalid.
  if (trimmed.length === 0 || trimmed.includes("/")) {
    return { model, renamed: false };
  }
  const { list, done } = renameIn(model.subModelParts, path, trimmed, "");
  if (!done) return { model, renamed: false };
  return { model: { ...model, subModelParts: list }, renamed: true };
}
