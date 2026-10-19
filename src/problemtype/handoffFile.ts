/**
 * The fs half of the CAD handoff consumer (roadmap item 6): reads the manifest
 * beside a mesh and the mesh's own revision, and hands both to the pure
 * `handoffFindings`.
 *
 * Kept apart from `handoff.ts` so `preflight.ts` can import the rulebook without
 * importing `node:fs` — its documented contract — while the sidebar and
 * `case_validate` both call `readHandoff` from here.
 *
 * Never throws: a missing manifest is simply absent, and a foreign or broken
 * one carries `problem` instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { handoffPath, parseHandoff, type HandoffRead } from "./handoff";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Reads (and parses) the manifest once per mtime/size, so a keystroke does not re-read it. */
const readCache = new Map<string, { key: string; read: HandoffRead }>();

/** Mesh hashes by path+mtime+size: the stale check hashes a large mesh at most once per edit. */
const meshHashes = new Map<string, { key: string; revision?: string }>();

/** SHA-256 of a mesh file, or undefined when it cannot be read. */
export function meshRevision(meshFsPath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(meshFsPath);
  } catch {
    return undefined;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = meshHashes.get(meshFsPath);
  if (hit && hit.key === key) return hit.revision;
  let revision: string | undefined;
  try {
    revision = sha256(fs.readFileSync(meshFsPath));
  } catch {
    revision = undefined;
  }
  meshHashes.set(meshFsPath, { key, revision });
  return revision;
}

/**
 * Reads the handoff beside a mesh. Never throws: a missing manifest is simply
 * absent, and an unreadable or foreign one carries `problem`.
 *
 * The mesh's revision is recorded only when a manifest was actually found, so a
 * case with no CAD export never pays to hash its mesh.
 */
export function readHandoff(meshFsPath: string): HandoffRead {
  const file = handoffPath(meshFsPath);
  let meshStat: fs.Stats | undefined;
  try {
    meshStat = fs.statSync(meshFsPath);
    if (!meshStat.isFile()) return { path: file };
  } catch {
    return { path: file };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return { path: file };
  } catch {
    return { path: file };
  }
  const key = `${stat.mtimeMs}:${stat.size}:${meshStat.mtimeMs}:${meshStat.size}`;
  const hit = readCache.get(file);
  if (hit && hit.key === key) return hit.read;
  let read: HandoffRead;
  try {
    const manifest = parseHandoff(fs.readFileSync(file, "utf8"));
    read = manifest
      ? { path: file, manifest, meshRevision: meshRevision(meshFsPath) }
      : { path: file, problem: `${path.basename(file)} is not a version 1 cad-preview-handoff manifest, so it was ignored.` };
  } catch (err) {
    read = { path: file, problem: `Could not read ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  readCache.set(file, { key, read });
  return read;
}
