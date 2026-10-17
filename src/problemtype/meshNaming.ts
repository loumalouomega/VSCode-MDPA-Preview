/**
 * The shape key block names are built from — "2D3N", "3D8N", GiD's convention —
 * and how one resolved kind names a block shape. Shared by the resolver
 * (`api.resolveMeshNaming`) and the renamer (`meshAdapt.adaptMeshNames`) so the
 * spelling cannot drift between them.
 *
 * Pure module: no vscode / DOM imports so it stays Node-testable.
 */

import { ResolvedMeshKind } from "./types";

/** "2D3N" for a 3-node cell in a 2D domain, "3D8N" for an 8-node cell in 3D. */
export function meshShapeKey(dim: 2 | 3, nodes: number): string {
  return `${dim}D${nodes}N`;
}

/** The name one block shape gets under `kind`, or undefined when it has none. */
export function meshTargetName(kind: ResolvedMeshKind, dim: 2 | 3, nodes: number): string | undefined {
  if (kind.shapes) return kind.shapes[meshShapeKey(dim, nodes)];
  if (kind.template !== undefined) {
    return kind.template.replace(/\{dim\}/g, String(dim)).replace(/\{nodes\}/g, String(nodes));
  }
  return kind.base !== undefined ? `${kind.base}${meshShapeKey(dim, nodes)}` : undefined;
}

/** The shapes a table covers, in reading order ("2D3N, 2D4N, 3D8N"). */
export function meshShapeList(kind: ResolvedMeshKind): string {
  const rank = (key: string): number => {
    const m = /^([23])D([0-9]+)N$/.exec(key);
    return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
  };
  return Object.keys(kind.shapes ?? {}).sort((a, b) => rank(a) - rank(b)).join(", ");
}
