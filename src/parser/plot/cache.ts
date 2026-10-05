import type { PlotTable } from "./types";

/** Worker-local, bounded extraction cache. Keys include bytes AND import options. */
export class PlotTableCache {
  private entries = new Map<string, { table: PlotTable; bytes: number }>();
  private bytes = 0;
  constructor(private readonly budget = 64 * 1024 * 1024, private readonly diagnostic = "Extraction cache hit (source bytes and import settings verified).") {}
  get(key: string): PlotTable | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key); this.entries.set(key, hit);
    return { ...hit.table, diagnostics: [...hit.table.diagnostics, this.diagnostic] };
  }
  set(key: string, table: PlotTable): void {
    // Conservatively account for JS objects/strings, not just serialized payloads.
    const bytes = Buffer.byteLength(JSON.stringify(table)) * 3;
    if (bytes > this.budget) return;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    while (this.bytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
    this.entries.set(key, { table, bytes }); this.bytes += bytes;
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
