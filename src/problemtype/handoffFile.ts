/**
 * The fs half of the CAD handoff consumer (former roadmap item 6, delivered 2026-10-19): reads the manifest
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

/**
 * Parsed manifests by path and text, so a keystroke re-parses nothing.
 *
 * Deliberately keyed on the bytes, not mtime/size: Windows timestamps have a
 * ~15 ms granularity, so two same-size writes in quick succession (a test
 * rewriting a handoff, or an export overwriting one) can look identical on
 * disk metadata while describing different meshes.
 */
const readCache = new Map<string, { text: string; read: HandoffRead }>();

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
  try {
    if (!fs.statSync(meshFsPath).isFile()) return { path: file };
  } catch {
    return { path: file };
  }
  try {
    if (!fs.statSync(file).isFile()) return { path: file };
  } catch {
    return { path: file };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { path: file, problem: `Could not read ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const hit = readCache.get(file);
  if (hit && hit.text === text) {
    // The manifest is unchanged; re-stat the mesh so a mesh edit still gets a
    // fresh revision (the hash itself stays cached until mtime/size move).
    return hit.read.manifest ? { ...hit.read, meshRevision: meshRevision(meshFsPath) } : hit.read;
  }
  let read: HandoffRead;
  try {
    const manifest = parseHandoff(text);
    read = manifest
      ? { path: file, manifest, meshRevision: meshRevision(meshFsPath) }
      : { path: file, problem: `${path.basename(file)} is not a version 1 cad-preview-handoff manifest, so it was ignored.` };
  } catch (err) {
    read = { path: file, problem: `Could not read ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  readCache.set(file, { text, read });
  return read;
}
