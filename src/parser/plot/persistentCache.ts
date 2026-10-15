/**
 * Bounded on-disk cache of disk-backed plot extractions (roadmap item 9).
 *
 * An entry is valid only for the exact source and companion CONTENT it was
 * built from: the key embeds `plotSourceIdentity(...).revision` (streamed
 * SHA-256 of the root, every companion, the timeline steps and rank), the
 * extraction settings and the extractor schema. A changed, added or missing
 * file therefore changes the key, which is the whole invalidation rule; there
 * is no mtime shortcut that could serve stale data.
 *
 * It is deliberately separate from the session-only retained cache used by
 * profile following (`collectPlot`'s `retention`): that one must never reread
 * disk or change silently, and a persistent miss never feeds it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { plotSourceIdentity, type PlotSourceIdentity } from "./revision";
import type { PlotSource, PlotTable } from "./types";

/** Bump when the extractors' output for the same input changes. */
export const PERSISTENT_PLOT_SCHEMA = 1;
export const PERSISTENT_PLOT_DEFAULT_BYTES = 256 * 1024 * 1024;
export const PERSISTENT_PLOT_DEFAULT_ENTRIES = 512;
const PREFIX = `v${PERSISTENT_PLOT_SCHEMA}-`;
const HIT_NOTE = "Persistent extraction cache hit (source, companion and timeline content revisions verified).";

export interface PersistentPlotCacheOptions {
  maxBytes?: number; maxEntries?: number;
  /** Skip rehashing files whose size, mtime, ctime, inode and device are unchanged since the manifest was written (default true). ctime cannot be restored by a writer, unlike mtime. */
  statFastPath?: boolean;
  /** Minimum age (ms) of a file at manifest-write time before the shortcut trusts it (default 2000). */
  statSettleMs?: number;
}
/** A file must have been settled this long before its manifest was written, so a same-tick rewrite cannot share a timestamp. */
const STAT_SETTLE_MS = 2000;
interface StatManifest {
  schema: number; source: string; revision: string; writtenAt: number; listing: string[];
  files: { path: string; bytes: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }[];
}
const STAT_PREFIX = `s${PERSISTENT_PLOT_SCHEMA}-stat-`;
export interface PersistentLookup { key: string; revision: string; table?: PlotTable }

export class PersistentPlotCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly statFastPath: boolean;
  private readonly statSettleMs: number;
  /** Observable counters (tests, diagnostics): full content identities computed vs. revisions served from the stat manifest. */
  readonly counters = { fullIdentities: 0, statHits: 0 };
  constructor(readonly dir: string, opts: PersistentPlotCacheOptions = {}) {
    this.maxBytes = opts.maxBytes ?? PERSISTENT_PLOT_DEFAULT_BYTES;
    this.maxEntries = opts.maxEntries ?? PERSISTENT_PLOT_DEFAULT_ENTRIES;
    this.statFastPath = opts.statFastPath ?? true;
    this.statSettleMs = opts.statSettleMs ?? STAT_SETTLE_MS;
  }

  private statFile(source: string): string {
    return path.join(this.dir, `${STAT_PREFIX}${createHash("sha256").update(path.resolve(source)).digest("hex")}.json`);
  }
  static async listing(source: string): Promise<string[]> {
    return (await fs.readdir(path.dirname(path.resolve(source)))).sort();
  }

  /** The content revision of `source` if every recorded file still has an identical, settled stat tuple and the directory listing is unchanged; otherwise undefined (callers then hash). */
  async fastRevision(source: string, listing: string[]): Promise<string | undefined> {
    if (!this.statFastPath) return undefined;
    try {
      const m = JSON.parse(await fs.readFile(this.statFile(source), "utf8")) as StatManifest;
      if (m.schema !== PERSISTENT_PLOT_SCHEMA || m.source !== path.resolve(source) || !m.revision || !Array.isArray(m.files) || !m.files.length) return undefined;
      if (JSON.stringify(m.listing) !== JSON.stringify(listing)) return undefined;
      for (const f of m.files) {
        if (f.mtimeMs > m.writtenAt - this.statSettleMs || f.ctimeMs > m.writtenAt - this.statSettleMs) return undefined;
        const s = await fs.stat(f.path);
        if (!s.isFile() || s.size !== f.bytes || s.mtimeMs !== f.mtimeMs || s.ctimeMs !== f.ctimeMs || s.ino !== f.ino || s.dev !== f.dev) return undefined;
      }
      this.counters.statHits++;
      return m.revision;
    } catch { return undefined; }
  }

  /** Records the stat tuples observed while `identity` was hashed. Skipped for directory cases and for any file without a verified tuple. */
  async rememberStat(source: string, identity: PlotSourceIdentity, listing: string[]): Promise<void> {
    if (!this.statFastPath || identity.inventoryRevision || !identity.files.length || identity.files.some(f => !f.revision || !f.stat)) return;
    const manifest: StatManifest = {
      schema: PERSISTENT_PLOT_SCHEMA, source: path.resolve(source), revision: identity.revision, writtenAt: Date.now(), listing,
      files: identity.files.map(f => ({ path: f.path, bytes: f.bytes, ...f.stat! })),
    };
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `.${randomBytes(6).toString("hex")}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(manifest), "utf8");
      await fs.rename(tmp, this.statFile(source));
    } catch { /* an unwritable cache only loses the shortcut */ }
  }

  /** Full content identity, remembered for the stat shortcut. `listing` must have been read BEFORE hashing. */
  async hashedIdentity(source: string, listing: string[], signal?: AbortSignal): Promise<PlotSourceIdentity> {
    this.counters.fullIdentities++;
    const identity = await plotSourceIdentity(source, signal);
    await this.rememberStat(source, identity, listing);
    return identity;
  }

  /** The key for `source` against content revision `revision`. `run` is a binding, not an input of the extraction. */
  static key(source: PlotSource, revision: string): string {
    const { run: _run, ...rest } = source as PlotSource & { run?: unknown };
    return createHash("sha256").update(JSON.stringify([PERSISTENT_PLOT_SCHEMA, revision, rest])).digest("hex");
  }

  private file(key: string): string { return path.join(this.dir, `${PREFIX}${key}.json`); }

  async get(key: string): Promise<PlotTable | undefined> {
    const file = this.file(key);
    try {
      const entry = JSON.parse(await fs.readFile(file, "utf8")) as { schema?: number; key?: string; table?: PlotTable };
      if (entry.schema !== PERSISTENT_PLOT_SCHEMA || entry.key !== key || !entry.table) throw new Error("mismatched entry");
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => undefined); // access time drives eviction
      return { ...entry.table, diagnostics: [...entry.table.diagnostics, HIT_NOTE] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await fs.rm(file, { force: true }).catch(() => undefined); // corrupt: never serve, drop
      return undefined;
    }
  }

  /** Returns whether the table was stored. A table that JSON cannot reproduce exactly is not cached. */
  async set(key: string, table: PlotTable): Promise<boolean> {
    if (table.rows.some(r => r.some(v => typeof v === "number" && !Number.isFinite(v)))) return false;
    const text = JSON.stringify({ schema: PERSISTENT_PLOT_SCHEMA, key, table });
    if (Buffer.byteLength(text) > this.maxBytes) return false;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, this.file(key));
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.prune();
    return true;
  }

  /** Drops other-schema files and stale temp files, then the least recently used entries until within budget. */
  async prune(): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return; }
    const entries: { file: string; bytes: number; used: number }[] = [];
    const manifests: { file: string; used: number }[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.startsWith(STAT_PREFIX) && name.endsWith(".json")) {
        const stat = await fs.stat(file).catch(() => undefined);
        if (stat) manifests.push({ file, used: stat.mtimeMs });
        continue;
      }
      if (!name.startsWith(PREFIX) || !name.endsWith(".json")) {
        // Other schema versions and abandoned temp files; never anything else in a shared directory.
        if (/^v\d+-[0-9a-f]{64}\.json$/.test(name) || /^\.[0-9a-f]{12}\.tmp$/.test(name)) await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat) entries.push({ file, bytes: stat.size, used: stat.mtimeMs });
    }
    manifests.sort((a, b) => a.used - b.used);
    for (const m of manifests.slice(0, Math.max(0, manifests.length - this.maxEntries))) await fs.rm(m.file, { force: true }).catch(() => undefined);
    entries.sort((a, b) => a.used - b.used);
    let bytes = entries.reduce((n, e) => n + e.bytes, 0), count = entries.length;
    for (const e of entries) {
      if (bytes <= this.maxBytes && count <= this.maxEntries) break;
      await fs.rm(e.file, { force: true }).catch(() => undefined);
      bytes -= e.bytes; count--;
    }
  }

  async clear(): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return; }
    await Promise.all(names.filter(n => (n.startsWith("v") || n.startsWith("s")) && n.endsWith(".json")).map(n => fs.rm(path.join(this.dir, n), { force: true })));
  }
}

/** Looks `source` up against the CURRENT content revision of its files. */
export async function lookupPersistent(cache: PersistentPlotCache, source: PlotSource & { path: string }, signal?: AbortSignal): Promise<PersistentLookup> {
  const listing = await PersistentPlotCache.listing(source.path).catch(() => undefined);
  const fast = listing ? await cache.fastRevision(source.path, listing) : undefined;
  const revision = fast ?? (listing ? (await cache.hashedIdentity(source.path, listing, signal)).revision : (await plotSourceIdentity(source.path, signal)).revision);
  const key = PersistentPlotCache.key(source, revision);
  return { key, revision, table: await cache.get(key) };
}

/** Stores a freshly extracted table only if the files still have the revision the lookup saw. */
export async function storePersistent(cache: PersistentPlotCache, source: PlotSource & { path: string }, lookup: PersistentLookup, table: PlotTable, signal?: AbortSignal): Promise<boolean> {
  // Always a full hash: the shortcut only serves lookups, never validates a store.
  const listing = await PersistentPlotCache.listing(source.path).catch(() => undefined);
  const after = listing ? await cache.hashedIdentity(source.path, listing, signal) : await plotSourceIdentity(source.path, signal);
  if (after.revision !== lookup.revision) return false; // changed while extracting: do not publish a mixed table
  return cache.set(lookup.key, table);
}
