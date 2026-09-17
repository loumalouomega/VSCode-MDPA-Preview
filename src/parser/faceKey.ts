/**
 * Packs up to 4 sorted node ids into one BigInt key for O(1) face-dedup
 * lookups (Map<bigint,...>) without string-join key overhead. See
 * webview/meshBuilder.ts's buildPolyData (boundary-face extraction).
 *
 * Pure module: no vscode / DOM / vtk.js imports.
 */

// Node ids are stored as Int32Array (src/parser/types.ts) and are always
// positive in practice (Kratos 1-based ids); 32 bits per id covers the full
// positive Int32 range, so no reachable id can truncate. 4 ids × 32 bits =
// 128-bit BigInt key.
export const PACK_BITS = 32n;
export const PACK_MASK = (1n << PACK_BITS) - 1n;

export function faceKey(ids: number[]): bigint {
  // Sort ids numerically (in-place on a small copy) so face orientation
  // doesn't affect the key.
  const s = ids.slice().sort((a, b) => a - b);
  let key = 0n;
  for (const id of s) {
    key = (key << PACK_BITS) | (BigInt(id) & PACK_MASK);
  }
  return key;
}
