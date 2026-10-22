import { test } from "node:test";
import assert from "node:assert/strict";
import { filterColormaps, groupByCategory, type ColormapInfo } from "../parser/colormapSearch";
import { COLORMAP_PRESETS } from "../parser/colormapPresets";

const maps: ColormapInfo[] = [
  { name: "Viridis", category: "sequential", colorblindSafe: true },
  { name: "Cool to Warm", category: "diverging", colorblindSafe: false },
  { name: "Jet", category: "rainbow", colorblindSafe: false },
];

test("empty query keeps everything in order", () => {
  assert.deepEqual(filterColormaps(maps, "  ", false).map((m) => m.name), ["Viridis", "Cool to Warm", "Jet"]);
});
test("words are ANDed and the category matches", () => {
  assert.deepEqual(filterColormaps(maps, "cool warm", false).map((m) => m.name), ["Cool to Warm"]);
  assert.deepEqual(filterColormaps(maps, "diverging", false).map((m) => m.name), ["Cool to Warm"]);
});
test("colour-blind filter", () => {
  assert.deepEqual(filterColormaps(maps, "", true).map((m) => m.name), ["Viridis"]);
});
test("groups in display order, empty dropped", () => {
  assert.deepEqual(groupByCategory(maps).map((g) => g.category), ["sequential", "diverging", "rainbow"]);
});
test("generated presets are well formed", () => {
  assert.ok(COLORMAP_PRESETS.length >= 20);
  for (const p of COLORMAP_PRESETS) {
    assert.ok(p.stops.length >= 2, p.name);
    for (const s of p.stops) assert.ok(s[0] >= 0 && s[0] <= 1, p.name);
  }
});
