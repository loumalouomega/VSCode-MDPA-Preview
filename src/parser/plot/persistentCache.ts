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
import { plotSourceIdentity } from "./revision";
import type { PlotSource, PlotTable } from "./types";

/** Bump when the extractors' output for the same input changes. */
export const PERSISTENT_PLOT_SCHEMA = 1;
export const PERSISTENT_PLOT_DEFAULT_BYTES = 256 * 1024 * 1024;
export const PERSISTENT_PLOT_DEFAULT_ENTRIES = 512;
const PREFIX = `v${PERSISTENT_PLOT_SCHEMA}-`;
const HIT_NOTE = "Persistent extraction cache hit (source, companion and timeline content revisions verified).";

export interface PersistentPlotCacheOptions { maxBytes?: number; maxEntries?: number }
export interface PersistentLookup { key: string; revision: string; table?: PlotTable }

export class PersistentPlotCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  constructor(readonly dir: string, opts: PersistentPlotCacheOptions = {}) {
    this.maxBytes = opts.maxBytes ?? PERSISTENT_PLOT_DEFAULT_BYTES;
    this.maxEntries = opts.maxEntries ?? PERSISTENT_PLOT_DEFAULT_ENTRIES;
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
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (!name.startsWith(PREFIX) || !name.endsWith(".json")) {
        // Other schema versions and abandoned temp files; never anything else in a shared directory.
        if (/^v\d+-[0-9a-f]{64}\.json$/.test(name) || /^\.[0-9a-f]{12}\.tmp$/.test(name)) await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat) entries.push({ file, bytes: stat.size, used: stat.mtimeMs });
    }
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
    await Promise.all(names.filter(n => n.startsWith("v") && n.endsWith(".json")).map(n => fs.rm(path.join(this.dir, n), { force: true })));
  }
}

/** Looks `source` up against the CURRENT content revision of its files. */
export async function lookupPersistent(cache: PersistentPlotCache, source: PlotSource & { path: string }, signal?: AbortSignal): Promise<PersistentLookup> {
  const identity = await plotSourceIdentity(source.path, signal);
  const key = PersistentPlotCache.key(source, identity.revision);
  return { key, revision: identity.revision, table: await cache.get(key) };
}

/** Stores a freshly extracted table only if the files still have the revision the lookup saw. */
export async function storePersistent(cache: PersistentPlotCache, source: PlotSource & { path: string }, lookup: PersistentLookup, table: PlotTable, signal?: AbortSignal): Promise<boolean> {
  const after = await plotSourceIdentity(source.path, signal);
  if (after.revision !== lookup.revision) return false; // changed while extracting: do not publish a mixed table
  return cache.set(lookup.key, table);
}
