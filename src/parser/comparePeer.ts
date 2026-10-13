/**
 * In-preview comparison ("Compare in split…", roadmap item 3): loading the
 * peer mesh file — the pure half (no vscode / DOM / vtk; `node:test` can
 * reach it, and both runtimes could bundle it).
 *
 * The peer is a read-only reference drawn in one split pane; it never enters
 * the operation history, never marks the document dirty and is never saved
 * back. So this module owns no session state at all: it parses a file with
 * the same `parseMeshFile` every preview open uses (`.mdpa` included, via its
 * internal dispatch) and describes the sidecar identity. The open dialog and
 * the session message routing are the vscode glue (`previewSession.ts`,
 * reusing `pickMergeMeshFile`), and clearing is webview-local — there is
 * deliberately no `compareClear` to handle.
 */

import * as path from "node:path";

import { MdpaModel } from "./types";
import { parseMeshFile } from "./meshFileParser";

const norm = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const posix = (p: string): string => p.split(path.sep).join("/");

export type CompareLoad =
  | { ok: true; model: MdpaModel; warnings: string[] }
  | { ok: false; refusal: string };

/**
 * Reads a peer file off disk. A refusal names the reason (the same file, an
 * unreadable file) instead of throwing, so the caller always answers with a
 * `compareNote` rather than a failed open.
 */
export async function loadCompareModel(absPath: string, meshFsPath: string): Promise<CompareLoad> {
  if (norm(absPath) === norm(meshFsPath)) {
    return { ok: false, refusal: "That file is already open here — pick a different mesh to compare with." };
  }
  let model: MdpaModel;
  try {
    model = await parseMeshFile(absPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, refusal: `Could not read "${path.basename(absPath)}" for comparison: ${message}` };
  }
  if (model.blocks.length === 0) {
    return { ok: false, refusal: `"${path.basename(absPath)}" has no mesh blocks to compare.` };
  }
  const warnings = (model.diagnostics ?? []).map((d) => d.message).filter((m) => m.length > 0);
  return { ok: true, model, warnings };
}

/** The peer's sidecar identity: its path relative to the mesh folder, forward slashes (the `view.link` convention). */
export function comparePeerRel(meshFsPath: string, peerAbsPath: string): string {
  return posix(path.relative(path.dirname(meshFsPath), peerAbsPath));
}

/** Resolves a saved relative peer path against the mesh folder. */
export function resolveComparePeer(meshFsPath: string, rel: string): string {
  return path.resolve(path.dirname(meshFsPath), rel);
}
