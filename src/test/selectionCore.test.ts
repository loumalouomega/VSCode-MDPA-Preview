/**
 * Selection sets (selectionCore.ts): seed resolution per kind, independent
 * entity-kind id spaces, refresh-by-definition after a model change, and the
 * explicit-id prune rule.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseMdpa } from "../parser/mdpaParser";
import { MdpaModel } from "../parser/types";
import { QualityReport, MetricResult } from "../parser/meshQuality";
import {
  MAX_SELECTION_IDS,
  MAX_SELECTION_SETS,
  SelectionSet,
  pointInPolygon,
  counts,
  describeSeed,
  entityUniverses,
  refreshSelection,
  resolveSeed,
  serializeSelectionSets,
  validateSelectionSeed,
  validateSelectionSets,
} from "../parser/selectionCore";

const SRC = [
  "Begin Properties 7",
  " DENSITY 2700.0",
  "End Properties",
  "",
  "Begin Nodes",
  " 1 0.0 0.0 0.0",
  " 2 1.0 0.0 0.0",
  " 3 1.0 1.0 0.0",
  " 4 0.0 1.0 0.0",
  " 5 2.0 0.0 0.0",
  "End Nodes",
  "",
  "Begin NodalData TEMP",
  " 1 0 100",
  " 2 0 150",
  " 3 0 200",
  " 4 0 50",
  " 5 0 80",
  "End NodalData",
  "",
  "Begin Elements Element2D3N",
  " 1 5 1 2 3",
  " 2 7 1 3 4",
  " 3 5 2 3 5",
  "End Elements",
  "",
  "Begin Conditions PointCondition2D1N",
  " 1 5 5",
  "End Conditions",
  "",
  "Begin SubModelPart Domain",
  " Begin SubModelPartElements",
  "  1",
  "  2",
  " End SubModelPartElements",
  "End SubModelPart",
].join("\n");

const base = (): MdpaModel => parseMdpa(SRC);

const metricWith = (ids: number[]): MetricResult =>
  // Only the fields a seed reads are pinned here; the rest is filler.
  ({
    key: "edgeRatio",
    label: "Aspect / Edge ratio",
    min: 1,
    max: 90,
    mean: 4,
    count: 3,
    higherIsBetter: false,
    thresholds: [3, 8, 50],
    bands: { good: 2, acceptable: 0, bad: ids.length, unacceptable: 0 },
    bandPct: { good: 0, acceptable: 0, bad: 1, unacceptable: 0 },
    histogram: { edges: [0, 1], counts: [ids.length], bandOfBin: [ids.length ? "bad" : "good"] },
    badEntityIds: ids,
    perElement: true,
    failed: ids.length > 0,
  });

test("entityUniverses keeps the three id spaces disjoint", () => {
  const u = entityUniverses(base());
  // the Conditions fixture deliberately reuses element-style numbering
  assert.deepEqual([...u.Elements].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...u.Conditions].sort((a, b) => a - b), [1]);
  assert.equal(u.Geometries.size, 0);
});

test("part seed resolves a SubModelPart's entities", () => {
  const r = resolveSeed(base(), { kind: "part", path: "Domain" });
  assert.deepEqual([...r.kinds.Elements].sort((a, b) => a - b), [1, 2]);
  assert.ok(!r.reason);
  assert.equal(resolveSeed(base(), { kind: "part", path: "Nope" }).reason, 'no SubModelPart named "Nope".');
});

test("field seed drives thresholdCells with the Nodal all-rule", () => {
  const r = resolveSeed(base(), { kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 90, hi: 210 });
  // element 1: 100/150/200 all in -> pass; element 2: 100/200/50 -> 50 out ("all" rule) -> fail;
  // element 3: 150/200/80 -> fail. Condition 1 (node 5 = 80) -> fail.
  assert.deepEqual([...r.kinds.Elements], [1]);
  assert.equal(r.kinds.Conditions.size, 0);
  const withAny = resolveSeed(base(), { kind: "field", variable: "temp", blockKind: "Nodal", lo: 90, hi: 210, rule: "any" });
  assert.deepEqual(withAny.kinds.Elements.size, 3);
  assert.equal(resolveSeed(base(), { kind: "field", variable: "MISSING", blockKind: "Nodal", lo: 0, hi: 1 }).reason, 'no Nodal field named "MISSING".');
});

test("property seed selects entities by their propertyIds row", () => {
  const r = resolveSeed(base(), { kind: "property", propertyId: 7 });
  assert.deepEqual([...r.kinds.Elements].sort((a, b) => a - b), [2]);
  assert.equal(resolveSeed(base(), { kind: "property", propertyId: 42 }).reason, "no Properties block with id 42.");
});

test("quality seed consumes the report it was handed (never recomputes)", () => {
  const report: QualityReport = {
    elementCount: 3,
    analyzedCount: 3,
    elementTypes: [],
    metrics: [metricWith([2, 3])],
    overallOk: false,
  };
  const model = base();
  const r = resolveSeed(model, { kind: "quality", metric: "edgeRatio" }, report);
  assert.deepEqual([...r.kinds.Elements].sort((a, b) => a - b), [2, 3]);
  assert.equal(resolveSeed(model, { kind: "quality", metric: "minAngle" }, report).reason, 'unknown quality metric "minAngle".');
});

test("explicit sets are pruned against the new model's id universes", () => {
  const model = base();
  const sets: SelectionSet[] = [
    { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [1, 2, 3, 99], Conditions: [5], Geometries: [] } },
  ];
  const { sets: out, changed } = refreshSelection(model, sets);
  assert.equal(changed, true);
  assert.deepEqual(out[0].kinds.Elements, [1, 2, 3]);
  assert.deepEqual(out[0].kinds.Conditions, [], "a Conditions id 5 does not exist — independent spaces at work");
  // a second refresh against the SAME result is stable
  const second = refreshSelection(model, out);
  assert.equal(second.changed, false);
});

test("predicate sets re-resolve and a failed seed empties the set", () => {
  const model = base();
  const sets: SelectionSet[] = [
    { name: "by part", seed: { kind: "part", path: "Domain" }, kinds: { Elements: [], Conditions: [], Geometries: [] } },
  ];
  assert.equal(refreshSelection(model, sets).sets[0].kinds.Elements.length, 2);
  // base with Domain gone: ids [3] remain but set goes EMPTY with a reason
  const withoutPart = parseMdpa(SRC.replace("  2\n", ""));
  const { sets: after, changed } = refreshSelection(withoutPart, sets);
  assert.equal(changed, true);
  assert.deepEqual(after[0].kinds.Elements, [1]);
  const gone = parseMdpa(SRC.replace("Begin SubModelPart Domain", "Begin SubModelPart Elsewhere"));
  const third = refreshSelection(gone, sets);
  assert.deepEqual(third.sets[0].kinds.Elements, []);
});

test("a pruned explicit set is reported; a re-resolved predicate is not", () => {
  const model = base();
  const sets: SelectionSet[] = [
    { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [1, 99], Conditions: [], Geometries: [] } },
    { name: "hot", seed: { kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 40, hi: 250 }, kinds: { Elements: [], Conditions: [], Geometries: [] } },
  ];
  const r = refreshSelection(model, sets);
  assert.deepEqual(r.reports.map((x) => x.name), ["picks"]);
  assert.deepEqual(r.reports[0].pruned, { Elements: [99], Conditions: [], Geometries: [] });
  assert.deepEqual(r.sets[0].kinds.Elements, [1]);
  assert.equal(r.sets[1].kinds.Elements.length > 0, true, "the predicate resolved");
  // A second pass against the same result is stable and silent: the prune already happened.
  const again = refreshSelection(model, r.sets);
  assert.deepEqual(again.reports, []);
  assert.equal(again.changed, false);
});

test("counts and describeSeed", () => {  assert.deepEqual(counts({ Elements: [1, 2], Conditions: [], Geometries: [5] }), { elements: 2, conditions: 0, geometries: 1, total: 3 });
  assert.equal(describeSeed({ kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 90, hi: 210 }), "TEMP in [90, 210]");
  assert.equal(describeSeed({ kind: "explicit" }), "explicit picks");
});

test("pointInPolygon: even-odd crossing test over screen polygons", () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(0, 5, square), true, "on the boundary — the lasso traced it");
  // an L that keeps the upper-LEFT lobe and removes the top-right quadrant
  const notched = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon(2, 8, notched), true);
  assert.equal(pointInPolygon(8, 8, notched), false);
  assert.equal(pointInPolygon(8, 4, notched), true);
  // degenerate: fewer than 3 points is never a region
  assert.equal(pointInPolygon(5, 5, [{ x: 0, y: 0 }, { x: 10, y: 10 }]), false);
});

// --- Persistence --------------------------------------------------------------

test("serialize writes the seed, and the id snapshot only for an explicit seed", () => {
  const sets: SelectionSet[] = [
    { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [3, 1], Conditions: [], Geometries: [] } },
    { name: "hot", seed: { kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 40, hi: 250 }, kinds: { Elements: [4, 5], Conditions: [], Geometries: [] } },
  ];
  const saved = serializeSelectionSets(sets);
  assert.deepEqual(saved[0], { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [3, 1], Conditions: [], Geometries: [] } });
  assert.deepEqual(saved[1], { name: "hot", seed: { kind: "field", variable: "TEMP", blockKind: "Nodal", lo: 40, hi: 250 } });
  // Round trip: the explicit set comes back, the predicate re-resolves from its seed.
  const model = base();
  const back = validateSelectionSets(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.sets[0].kinds.Elements, [1, 3]);
  assert.deepEqual(back.sets[1].kinds, { Elements: [], Conditions: [], Geometries: [] });
  assert.equal(refreshSelection(model, back.sets).sets[1].kinds.Elements.length, 3, "the predicate re-resolves on the mesh that opens");
});

test("validateSelectionSeed spells every seed kind and refuses anything else", () => {
  assert.deepEqual(validateSelectionSeed({ kind: "explicit" }), { kind: "explicit" });
  assert.deepEqual(validateSelectionSeed({ kind: "part", path: "A/B" }), { kind: "part", path: "A/B" });
  assert.deepEqual(validateSelectionSeed({ kind: "quality", metric: "edgeRatio" }), { kind: "quality", metric: "edgeRatio" });
  assert.deepEqual(validateSelectionSeed({ kind: "property", propertyId: 7 }), { kind: "property", propertyId: 7 });
  assert.deepEqual(validateSelectionSeed({ kind: "field", variable: "T", blockKind: "Nodal", lo: 0, hi: 1 }), {
    kind: "field",
    variable: "T",
    blockKind: "Nodal",
    lo: 0,
    hi: 1,
  });
  assert.deepEqual(validateSelectionSeed({ kind: "field", variable: "V", blockKind: "Elemental", lo: 0, hi: 1, component: "mag", rule: "any" }), {
    kind: "field",
    variable: "V",
    blockKind: "Elemental",
    lo: 0,
    hi: 1,
    component: "mag",
    rule: "any",
  });
  // an out-of-range component or unknown rule is omitted, not coerced into a different predicate
  assert.deepEqual(validateSelectionSeed({ kind: "field", variable: "T", blockKind: "Nodal", lo: 0, hi: 1, component: 99, rule: "sometimes" }), {
    kind: "field",
    variable: "T",
    blockKind: "Nodal",
    lo: 0,
    hi: 1,
  });
  const part = validateSelectionSeed({ kind: "field", variable: "T", blockKind: "Nodal", lo: 0, hi: 1, component: 2 });
  assert.equal(part?.kind === "field" ? part.component : undefined, 2, "a component index inside the field width is kept");
  for (const bad of [undefined, null, "x", 3, [], { kind: "part" }, { kind: "part", path: "" }, { kind: "field", variable: "T", blockKind: "Nodal", lo: "0", hi: 1 }, { kind: "property", propertyId: 1.5 }, { kind: "nope" }]) {
    assert.equal(validateSelectionSeed(bad), undefined, `${JSON.stringify(bad)} is not a seed`);
  }
});

test("a serialize → validate → serialize round trip is stable", () => {
  const sets: SelectionSet[] = [
    { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [1], Conditions: [2], Geometries: [] } },
    { name: "hot", seed: { kind: "field", variable: "T", blockKind: "Nodal", lo: 0, hi: 1, component: 0, rule: "any" }, kinds: { Elements: [], Conditions: [], Geometries: [] } },
    { name: "thin", seed: { kind: "field", variable: "T", blockKind: "Nodal", lo: 0, hi: 1 }, kinds: { Elements: [], Conditions: [], Geometries: [] } },
    { name: "part", seed: { kind: "part", path: "A/B" }, kinds: { Elements: [], Conditions: [], Geometries: [] } },
  ];
  const first = serializeSelectionSets(sets);
  const second = serializeSelectionSets(validateSelectionSets(first).sets);
  assert.deepEqual(second, first, "the optional component/rule keys survive a round trip rather than being invented");
});

test("validateSelectionSets drops a bad entry and keeps the rest, de-duplicating names", () => {  const entry = { name: "picks", seed: { kind: "explicit" }, kinds: { Elements: [1], Conditions: [], Geometries: [] } };
  const r = validateSelectionSets([
    entry,
    { name: "", seed: { kind: "explicit" }, kinds: { Elements: [1], Conditions: [], Geometries: [] } },
    { name: "no seed", seed: { kind: "plain" } },
    { name: "empty explicit", seed: { kind: "explicit" } },
    5,
    entry,
  ]);
  assert.deepEqual(r.sets.map((s) => s.name), ["picks", "picks (2)"]);
  assert.equal(r.warnings.filter((w) => /renamed/.test(w)).length, 1);
  assert.ok(r.warnings.some((w) => /unreadable seed/.test(w)));
  assert.ok(r.warnings.some((w) => /kept none/.test(w)));
  assert.ok(r.warnings.some((w) => /malformed/.test(w)));
  assert.equal(r.warnings.some((w) => /no usable name/.test(w)), true);
});

test("set and id counts are capped", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, seed: { kind: "explicit" }, kinds: { Elements: [1], Conditions: [], Geometries: [] } }));
  const r = validateSelectionSets(many);
  assert.equal(r.sets.length, MAX_SELECTION_SETS);
  assert.match(r.warnings.join(" "), /at most 32 selection sets/);
  const big = Array.from({ length: MAX_SELECTION_IDS + 5 }, (_, i) => i + 1);
  const capped = validateSelectionSets([{ name: "huge", seed: { kind: "explicit" }, kinds: { Elements: big, Conditions: [], Geometries: [] } }]);
  assert.equal(capped.sets[0].kinds.Elements.length, MAX_SELECTION_IDS);
  assert.match(capped.warnings.join(" "), /kept the first 50000 elements/);
  assert.equal(serializeSelectionSets([{ name: "huge", seed: { kind: "explicit" }, kinds: { Elements: big, Conditions: [], Geometries: [] } }])[0].kinds!.Elements.length, MAX_SELECTION_IDS);
});

test("formula seeds resolve, validate, clone, describe and round-trip", async () => {
  const { resolveSeed, validateSelectionSeed, describeSeed } = await import("../parser/selectionCore");
  const m = parseMdpa(`Begin Nodes
1 0 0 0
2 1 0 0
3 1 1 0
4 0 1 0
5 0 0 -1
End Nodes
Begin Elements Element2D3N
1 1 1 2 3
2 1 3 4 1
End Elements
Begin Conditions LineCondition2D2N
1 1 1 2
2 1 4 3
End Conditions
`);
  const base = resolveSeed(m, { kind: "formula", expr: "y <= 0" });
  assert.deepEqual([...base.kinds.Conditions], [1]);
  assert.equal(base.kinds.Elements.size, 0);
  assert.deepEqual([...resolveSeed(m, { kind: "formula", expr: "y <= 0", rule: "any" }).kinds.Elements].sort(), [1, 2]);
  assert.ok(resolveSeed(m, { kind: "formula", expr: "z > 10" }).reason);
  assert.ok(resolveSeed(m, { kind: "formula", expr: "(((" }).reason);
  const seed = validateSelectionSeed({ kind: "formula", expr: " y <= 0 ", rule: "any" });
  assert.deepEqual(seed, { kind: "formula", expr: " y <= 0 ", rule: "any" });
  assert.equal(validateSelectionSeed({ kind: "formula", expr: "" }), undefined);
  assert.match(describeSeed({ kind: "formula", expr: "y<=0", rule: "any" }), /formula y<=0 \(any\)/);
});
