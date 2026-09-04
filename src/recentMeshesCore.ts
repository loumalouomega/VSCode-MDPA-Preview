/**
 * The pure half of the recently-opened-meshes list behind the sidebar's
 * "Recent Meshes" view.
 *
 * No `vscode`, no DOM, so the list's actual decisions — ordering, de-duplication
 * and the cap — are Node-testable; `recentMeshes.ts` is the thin globalState
 * glue. Same core/glue split as `whatsNewCore.ts`/`whatsNew.ts` and
 * `runCore.ts`/`runTreeView.ts`, and for the same reason: this repo has no VS
 * Code integration harness, so anything above the vscode line cannot be tested.
 */

import * as path from "node:path";

/** One remembered mesh. Plain JSON — it round-trips through globalState. */
export interface RecentMesh {
  /** Absolute path, as resolved when it was recorded. */
  path: string;
  /** Epoch ms of the most recent open, which is also the sort key. */
  openedAt: number;
}

/** How many entries the list keeps; the tail is dropped oldest-first. */
export const RECENT_CAP = 10;

/**
 * The identity of a path for de-duplication purposes.
 *
 * Case-folded on win32 only: `C:\Mesh.mdpa` and `c:\mesh.mdpa` are one file
 * there and two on Linux, and folding everywhere would silently merge two
 * genuinely distinct meshes on the platform Kratos is most often run on.
 * `platform` is an argument rather than a `process.platform` read so the
 * win32 branch is reachable from a test on any host.
 */
export function recentKey(fsPath: string, platform: string = process.platform): string {
  const resolved = path.resolve(fsPath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Records an open, returning a new list — newest first, de-duplicated, capped.
 *
 * Re-opening a remembered mesh moves it to the front rather than adding a
 * second row, so the list is a set ordered by recency rather than a log.
 */
export function recordRecent(
  list: readonly RecentMesh[],
  fsPath: string,
  now: number,
  cap: number = RECENT_CAP,
  platform: string = process.platform
): RecentMesh[] {
  const resolved = path.resolve(fsPath);
  const key = recentKey(resolved, platform);
  const kept = list.filter((e) => recentKey(e.path, platform) !== key);
  return [{ path: resolved, openedAt: now }, ...kept].slice(0, Math.max(0, cap));
}

/** Drops one entry by path. Backs the row's "Remove from list" action. */
export function removeRecent(
  list: readonly RecentMesh[],
  fsPath: string,
  platform: string = process.platform
): RecentMesh[] {
  const key = recentKey(fsPath, platform);
  return list.filter((e) => recentKey(e.path, platform) !== key);
}

/**
 * Drops entries whose file is gone — `exists` is injected so the caller owns the
 * filesystem call and a test needs none. A mesh that was moved or deleted is
 * dropped silently rather than offered and then failing to open.
 */
export function pruneMissing(
  list: readonly RecentMesh[],
  exists: (fsPath: string) => boolean
): RecentMesh[] {
  return list.filter((e) => exists(e.path));
}

/**
 * Tolerant read of whatever globalState holds. The value is user-writable state
 * that survives upgrades, so a malformed entry is skipped rather than throwing —
 * the recipe-style tolerance `parseCaseJson`/`parseOpsJson` already use.
 */
export function parseRecentList(raw: unknown): RecentMesh[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentMesh[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { path: p, openedAt } = item as Partial<RecentMesh>;
    if (typeof p !== "string" || p.length === 0) continue;
    out.push({ path: p, openedAt: typeof openedAt === "number" ? openedAt : 0 });
  }
  return out;
}

/** The row's primary label: the file name. */
export function recentLabel(fsPath: string): string {
  return path.basename(fsPath);
}

/**
 * The row's dimmed second column: the containing folder, with `$HOME`
 * abbreviated. `home` is an argument so the test does not depend on the
 * machine it runs on.
 */
export function recentDescription(fsPath: string, home?: string): string {
  const dir = path.dirname(fsPath);
  if (home && home.length > 0 && (dir === home || dir.startsWith(home + path.sep))) {
    return "~" + dir.slice(home.length);
  }
  return dir;
}
