import { test } from "node:test";
import assert from "node:assert";
import { faceKey } from "../parser/faceKey";

// Local re-implementation of the old (buggy) 20-bit packing this file's
// fixes replaced, used only to prove the collision it closed was real.
function oldFaceKey(ids: number[]): bigint {
  const bits = 20n;
  const mask = (1n << bits) - 1n;
  const s = ids.slice().sort((a, b) => a - b);
  let key = 0n;
  for (const id of s) {
    key = (key << bits) | (BigInt(id) & mask);
  }
  return key;
}

test("faceKey is order-independent (sorts ids before packing)", () => {
  assert.strictEqual(faceKey([1, 2, 3, 4]), faceKey([4, 1, 3, 2]));
  assert.strictEqual(faceKey([9, 5, 7]), faceKey([5, 7, 9]));
});

test("faceKey distinguishes ids that differ by 2^20 (the old 20-bit mask width)", () => {
  const a = [1, 2, 3, 4];
  const b = [1, 2, 3, 4 + 2 ** 20]; // 1048580

  // Prove the collision was real under the old scheme: masking to 20 bits
  // drops id 1048580 back down to 4, so the two faces hashed identically.
  assert.strictEqual(oldFaceKey(a), oldFaceKey(b));

  // The fixed faceKey must not collide.
  assert.notStrictEqual(faceKey(a), faceKey(b));
});

test("faceKey distinguishes large ids near the top of the 32-bit range", () => {
  const a = [1, 2, 3, 2_000_000_000];
  const b = [1, 2, 3, 2_000_000_001];
  assert.notStrictEqual(faceKey(a), faceKey(b));
});
