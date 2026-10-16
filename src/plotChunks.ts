/**
 * Chunked delivery of large plot results across the worker boundary.
 *
 * A structured-clone message is deserialized in ONE synchronous step on the
 * receiving thread, so a million-point dataset stalls the extension host for
 * seconds however the worker itself behaves. Splitting the big arrays into
 * bounded messages gives the host's event loop a turn between pieces.
 * Pure (no worker or vscode import) so it is testable in Node.
 */
export const PLOT_CHUNK_ITEMS = 8000;
export type ChunkPath = (string | number)[];
export interface ChunkedArray { path: ChunkPath; aliasOf?: ChunkPath }

/** Arrays that may be large. Everything else travels in the head message. */
function candidates(result: any): { path: ChunkPath; arr: unknown[] }[] {
  const out: { path: ChunkPath; arr: unknown[] }[] = [];
  if (Array.isArray(result?.series)) {
    result.series.forEach((s: any, i: number) => {
      for (const key of ["points", "original"]) if (Array.isArray(s?.[key])) out.push({ path: ["series", i, key], arr: s[key] });
    });
  }
  for (const key of ["rows", "origins"]) if (Array.isArray(result?.[key])) out.push({ path: [key], arr: result[key] });
  return out;
}

/** Splits `result` into a head (big arrays emptied) and ordered chunks; arrays shared inside the result stay shared. */
export function chunkResult(result: any, size = PLOT_CHUNK_ITEMS): { head: any; arrays: ChunkedArray[]; chunks: { path: ChunkPath; items: unknown[] }[] } {
  const head: any = Array.isArray(result?.series) ? { ...result, series: result.series.map((s: any) => ({ ...s })) } : { ...result };
  const arrays: ChunkedArray[] = [], chunks: { path: ChunkPath; items: unknown[] }[] = [];
  const seen = new Map<unknown[], ChunkPath>();
  for (const { path, arr } of candidates(result)) {
    if (arr.length <= size) continue;
    const first = seen.get(arr);
    set(head, path, []);
    if (first) { arrays.push({ path, aliasOf: first }); continue; }
    seen.set(arr, path);
    arrays.push({ path });
    for (let i = 0; i < arr.length; i += size) chunks.push({ path, items: arr.slice(i, i + size) });
  }
  return { head, arrays, chunks };
}

/** Inverse of `chunkResult`; `received` holds each path's items in arrival order. */
export function assembleResult(head: any, arrays: ChunkedArray[], received: Map<string, unknown[][]>): any {
  for (const a of arrays) {
    if (a.aliasOf) continue;
    const parts = received.get(pathKey(a.path)) ?? [];
    const all: unknown[] = [];
    for (const p of parts) for (let i = 0; i < p.length; i++) all.push(p[i]);
    set(head, a.path, all);
  }
  for (const a of arrays) if (a.aliasOf) set(head, a.path, get(head, a.aliasOf));
  return head;
}

export const pathKey = (p: ChunkPath): string => p.join("/");
function set(root: any, path: ChunkPath, value: unknown): void {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
}
function get(root: any, path: ChunkPath): unknown {
  let o = root;
  for (const k of path) o = o[k];
  return o;
}
