import { test } from "node:test";
import * as assert from "node:assert";
import { beamGlyphSet, sphereGlyphSet, sphereImpostorSet, stickImpostorSet } from "../parser/render/glyphSets";

const arr = (set: { arrays: { name: string; values: Float32Array; components: number }[] }, name: string) => {
  const a = set.arrays.find((x) => x.name === name);
  assert.ok(a, `array ${name}`);
  return a;
};

test("sphereImpostorSet carries the same anchors, radii and factor as the tessellated set", () => {
  const data = { points: new Float32Array([0, 0, 0, 1, 2, 3]), radii: new Float32Array([0.5, 2]) };
  const imp = sphereImpostorSet(data, 1.5);
  const tess = sphereGlyphSet(data, 1.5, 16);
  assert.deepStrictEqual(imp.source, { kind: "impostorSphere" });
  assert.strictEqual(imp.anchors, tess.anchors);
  assert.deepStrictEqual(imp.arrays, tess.arrays);
  assert.strictEqual(imp.scaleArray, "radius");
  assert.strictEqual(imp.scaleFactor, 1.5);
});

const beams = {
  centers: new Float32Array([1, 0, 0, 0, 5, 0]),
  axes: new Float32Array([2, 0, 0, 0, 0, -4]),
  radii: new Float32Array([0.1, 0.25]),
  count: 2,
};

test("stickImpostorSet splits the axis into a unit direction and [length, radius]", () => {
  const set = stickImpostorSet(beams, 1);
  assert.deepStrictEqual(set.source, { kind: "impostorStick" });
  assert.strictEqual(set.orientationArray, "stickAxis");
  assert.strictEqual(set.scaleArray, "stickScale");
  assert.strictEqual(set.scaleFactor, 1);
  const dirs = arr(set, "stickAxis");
  const scale = arr(set, "stickScale");
  assert.strictEqual(dirs.components, 3);
  assert.strictEqual(scale.components, 2);
  assert.deepStrictEqual(Array.from(dirs.values), [1, 0, 0, 0, 0, -1]);
  assert.deepStrictEqual(Array.from(scale.values), [2, Math.fround(0.1), 4, 0.25]);
  // Endpoints centre ± dir*length/2 reproduce the segment.
  const end = [1 + 1 * 1, 0, 0];
  assert.deepStrictEqual([beams.centers[0] + dirs.values[0] * scale.values[0] / 2, 0, 0], end);
});

test("thickness scales the stick radius, never the length", () => {
  const thin = stickImpostorSet(beams, 1);
  const thick = stickImpostorSet(beams, 3);
  const a = arr(thin, "stickScale").values;
  const b = arr(thick, "stickScale").values;
  assert.strictEqual(b[0], a[0]);
  assert.strictEqual(b[2], a[2]);
  assert.ok(Math.abs(b[1] - 3 * a[1]) < 1e-6);
  assert.ok(Math.abs(b[3] - 3 * a[3]) < 1e-6);
});

test("stick radius matches the tessellated beam's tube diameter / 2, colouring array is the radius", () => {
  const tess = beamGlyphSet(beams, 2, 8);
  const imp = stickImpostorSet(beams, 2);
  const tessScale = arr(tess, "beamScale").values; // [length, d, d]
  const impScale = arr(imp, "stickScale").values; // [length, r]
  for (let i = 0; i < beams.count; i++) {
    assert.ok(Math.abs(impScale[i * 2] - tessScale[i * 3]) < 1e-6);
    assert.ok(Math.abs(impScale[i * 2 + 1] * 2 - tessScale[i * 3 + 1]) < 1e-6);
  }
  assert.deepStrictEqual(Array.from(arr(imp, "radius").values), Array.from(beams.radii));
  assert.strictEqual(arr(imp, "radius").components, 1);
});

test("a zero-length axis keeps a finite +X direction", () => {
  const set = stickImpostorSet(
    { centers: new Float32Array(3), axes: new Float32Array(3), radii: new Float32Array([1]), count: 1 },
    1
  );
  assert.deepStrictEqual(Array.from(arr(set, "stickAxis").values), [1, 0, 0]);
  assert.strictEqual(arr(set, "stickScale").values[0], 0);
});
