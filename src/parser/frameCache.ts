/**
 * Bounded cache of parsed timeline frames (roadmap item 7).
 *
 * A timeline step used to be re-parsed from disk on every visit, so scrubbing
 * back and forth through a series paid the full parse each time. This keeps
 * the most recently used RAW parsed models (before the edit history is
 * replayed onto them, so `adoptFrame` still rebases against exactly what the
 * file says) under a byte budget.
 *
 * Staleness: an entry is valid only while the source stamp it was stored with
 * still matches (`statMeshSource().stamp`), and the owner clears the whole
 * cache when the directory watcher fires. A model must never be mutated by a
 * consumer after it is stored; every `src/parser` operation returns a new
 * model, and the only in-place writer (`derived`, a memo of the same file's
 * measurements) stays correct for the same bytes.
 *
 * Pure module: no vscode / DOM imports.
 */
import type { MdpaModel } from "./types";

/** Approximate retained bytes of the model's typed arrays (the part that scales with mesh size). */
export function modelBytes(model: MdpaModel): number {
  let n = model.coords.byteLength + model.nodeIds.byteLength;
  for (const b of model.blocks) n += b.connectivity.byteLength + b.entityIds.byteLength + (b.propertyIds?.byteLength ?? 0);
  for (const f of model.fields) n += f.ids.byteLength + f.values.byteLength + (f.fixed?.byteLength ?? 0);
  for (const p of model.subModelParts) n += subPartBytes(p);
  return n;
}

function subPartBytes(p: MdpaModel["subModelParts"][number]): number {
  let n = p.nodeIds.byteLength + p.elementIds.byteLength + p.conditionIds.byteLength;
  n += p.geometryIds?.byteLength ?? 0;
  n += p.constraintIds?.byteLength ?? 0;
  for (const c of p.children ?? []) n += subPartBytes(c);
  return n;
}

interface Entry { stamp: string; model: MdpaModel; bytes: number }

export class FrameCache {
  private readonly entries = new Map<string, Entry>(); // insertion order = recency (oldest first)
  private total = 0;

  constructor(private maxBytes: number) {}

  /** Changes the budget (0 disables and empties the cache). */
  setBudget(maxBytes: number): void {
    this.maxBytes = Math.max(0, maxBytes);
    this.evict();
  }

  get enabled(): boolean { return this.maxBytes > 0; }
  get bytes(): number { return this.total; }
  get size(): number { return this.entries.size; }

  /** The cached model for `key` if it was stored under the same stamp; a stale entry is dropped. */
  get(key: string, stamp: string): MdpaModel | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.stamp !== stamp) { this.remove(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, e); // most recently used
    return e.model;
  }

  set(key: string, stamp: string, model: MdpaModel): void {
    if (this.maxBytes <= 0) return;
    const bytes = modelBytes(model);
    this.remove(key);
    if (bytes > this.maxBytes) return; // a single frame over budget is never retained
    this.entries.set(key, { stamp, model, bytes });
    this.total += bytes;
    this.evict();
  }

  clear(): void { this.entries.clear(); this.total = 0; }

  private remove(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.total -= e.bytes;
    this.entries.delete(key);
  }

  private evict(): void {
    for (const key of this.entries.keys()) {
      if (this.total <= this.maxBytes) break;
      this.remove(key);
    }
  }
}

/** Cache key for one frame of one source: path plus the step selector. */
export function frameKey(fsPath: string, selector: string | number): string {
  return `${fsPath}\u0000${selector}`;
}
