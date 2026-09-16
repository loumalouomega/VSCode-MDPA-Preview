/**
 * CSV serializers for the Quality / Mesh Size / Field integrals panels.
 *
 * Exact-string assertions: a spreadsheet column that renames itself between
 * releases breaks every downstream script, so headers and row shapes are
 * pinned here, not just "contains".
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_EXPORT_ID_LIMIT,
  exportIdList,
  integralsToCsv,
  meshSizeToCsv,
  qualityToCsv,
} from "../parser/analysisExport";
import type { FieldIntegral } from "../parser/fieldIntegrate";
import type { BoxStats, MeshSizeResult } from "../parser/meshSize";
import type { MetricResult, QualityReport } from "../parser/meshQuality";

function metric(over: Partial<MetricResult> = {}): MetricResult {
  return {
    key: "edgeRatio",
    label: "Edge ratio",
    unit: undefined,
    min: 1,
    max: 4.5,
    mean: 1.25,
    count: 100,
    higherIsBetter: false,
    thresholds: [2, 4, 8],
    bands: { good: 90, acceptable: 7, bad: 2, unacceptable: 1 },
    bandPct: { good: 90, acceptable: 7, bad: 2, unacceptable: 1 },
    histogram: { edges: [1, 4.5], counts: [100], bandOfBin: ["good"] },
    badEntityIds: [7, 42],
    perElement: true,
    failed: false,
    ...over,
  };
}

function report(over: Partial<QualityReport> = {}): QualityReport {
  return {
    elementCount: 100,
    analyzedCount: 100,
    elementTypes: ["Triangle"],
    metrics: [metric()],
    overallOk: true,
    ...over,
  };
}

test("quality CSV pins headers, bands and the id list", () => {
  assert.equal(
    qualityToCsv(report()),
    "metric,unit,min,mean,max,count,failed,good,acceptable,bad,unacceptable," +
      "pct_good,pct_acceptable,pct_bad,pct_unacceptable," +
      "threshold_1,threshold_2,threshold_3,bad_entity_ids\n" +
      "Edge ratio,,1,1.25,4.5,100,false,90,7,2,1,90,7,2,1,2,4,8,7 42\n"
  );
});

test("quality CSV quotes labels, spells NaN raw and flags failed metrics", () => {
  const csv = qualityToCsv(
    report({
      metrics: [
        metric({ label: "Dihedral, angle", unit: "deg", min: NaN, mean: NaN, max: NaN, failed: true, badEntityIds: [] }),
      ],
    })
  );
  const row = csv.split("\n")[1];
  assert.ok(row.startsWith('"Dihedral, angle",deg,NaN,NaN,NaN,'), row);
  assert.ok(row.includes(",true,"), row);
  assert.ok(row.endsWith(","), "an empty id list is a blank, never 0");
});

test("id lists cap with a trailer but counts stay complete", () => {
  const ids = Array.from({ length: ANALYSIS_EXPORT_ID_LIMIT + 3 }, (_, i) => i + 1);
  const listed = exportIdList(ids);
  assert.ok(listed.endsWith(" …(+3 more)"), listed);
  assert.equal(exportIdList([1, 2]), "1 2");
  assert.equal(exportIdList([]), "");
  const csv = qualityToCsv(report({ metrics: [metric({ badEntityIds: ids })] }));
  assert.ok(csv.includes("…(+3 more)"), "the trailer reaches the file");
  assert.ok(csv.includes(",2,1,"), "band counts are unaffected by the cap");
});

const stats = (over: Partial<BoxStats> = {}): BoxStats => ({
  count: 50,
  min: 0.1,
  q1: 0.4,
  median: 0.5,
  q3: 0.6,
  max: 2.5,
  mean: 0.55,
  std: 0.2,
  iqr: 0.2,
  whiskerLo: 0.1,
  whiskerHi: 0.9,
  ...over,
});

function sizeResult(): MeshSizeResult {
  const field = (n: number) => ({
    kind: "Nodal" as const,
    variable: "NODAL_H",
    components: 1,
    ids: new Int32Array([1]),
    values: new Float64Array([n]),
  });
  return {
    nodalH: field(0.5),
    elementSize: { ...field(0.5), kind: "Elemental" as const, variable: "ELEMENT_H" },
    elementStats: stats(),
    nodalStats: stats({ count: 60, min: 0.2 }),
    smallElementIds: [3],
    bigElementIds: [9, 10],
    elementCount: 50,
    analyzedCount: 50,
    elementTypes: ["Triangle"],
  };
}

test("mesh-size CSV pins the two stat rows and the outlier lists", () => {
  assert.equal(
    meshSizeToCsv(sizeResult()),
    "field,count,min,q1,median,q3,max,mean,std,iqr,whisker_lo,whisker_hi,small_ids,big_ids\n" +
      "nodal,60,0.2,0.4,0.5,0.6,2.5,0.55,0.2,0.2,0.1,0.9,,\n" +
      "element,50,0.1,0.4,0.5,0.6,2.5,0.55,0.2,0.2,0.1,0.9,3,9 10\n"
  );
});

function integral(over: Partial<FieldIntegral> = {}): FieldIntegral {
  return {
    variable: "DENSITY",
    components: 1,
    domain: { numCells: 10, numSkipped: 0, total: [1000], mean: [100], measure: [10] },
    regions: [
      { name: "Inlet", numCells: 4, numSkipped: 1, total: [400], mean: [100], measure: [4] },
    ],
    ...over,
  };
}

test("integrals CSV pins one whole-mesh row plus one row per region", () => {
  assert.equal(
    integralsToCsv([integral()]),
    "variable,components,region,total,mean,measure,cells,skipped\n" +
      "DENSITY,1,whole mesh,1000,100,10,10,0\n" +
      "DENSITY,1,Inlet,400,100,4,4,1\n"
  );
});

test("integrals CSV tuples vectors and quotes names with commas", () => {
  const csv = integralsToCsv([
    integral({
      variable: "DISPLACEMENT",
      components: 3,
      domain: { numCells: 2, numSkipped: 0, total: [1, 2, 3], mean: [0.5, 1, 1.5], measure: [2, 2, 2] },
      regions: [{ name: "Side, left", numCells: 1, numSkipped: 0, total: [1, 0, 0], mean: [1, 0, 0], measure: [1, 1, 1] }],
    }),
  ]);
  const rows = csv.split("\n");
  assert.ok(rows[1].includes('"(1,2,3)"'), rows[1]);
  assert.ok(rows[2].startsWith('DISPLACEMENT,3,"Side, left",'), rows[2]);
});

test("empty inputs still emit a header, never throw", () => {
  assert.equal(integralsToCsv([]), "variable,components,region,total,mean,measure,cells,skipped\n");
  assert.equal(qualityToCsv(report({ metrics: [] })).split("\n").length, 2);
});
