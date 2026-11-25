import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdpa } from "../parser/mdpaParser";
import { sharedNodeConflicts } from "../problemtype/nodeConflicts";
import type { ConditionSpec } from "../problemtype/types";

// Two parts sharing nodes 1 and 2; C shares none with either.
const MDPA = `Begin Nodes
1 0.0 0.0 0.0
2 1.0 0.0 0.0
3 0.0 1.0 0.0
4 0.0 0.0 1.0
End Nodes

Begin SubModelPart A
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart B
  Begin SubModelPartNodes
  1
  2
  End SubModelPartNodes
End SubModelPart

Begin SubModelPart C
  Begin SubModelPartNodes
  3
  4
  End SubModelPartNodes
End SubModelPart
`;

const conditions = [
  { id: "fixed", label: "Fixed support", processTemplate: { Parameters: { variable_name: "DISPLACEMENT" } } },
  { id: "prescribed", label: "Prescribed displacement", processTemplate: { Parameters: { variable_name: "DISPLACEMENT" } } },
] as unknown as ConditionSpec[];

const assignments = [
  { conditionId: "fixed", smpPath: "A" },
  { conditionId: "prescribed", smpPath: "B" },
];

function entry(smpPath: string, value: number[], interval?: [number, number]): unknown {
  return {
    Parameters: {
      model_part_name: `Structure.${smpPath}`,
      variable_name: "DISPLACEMENT",
      value,
      constrained: [true, true, true],
      ...(interval ? { interval } : {}),
    },
  };
}

function projectParameters(list: unknown[]): string {
  return JSON.stringify({ processes: { constraints_process_list: list } });
}

test("two parts fixing the same variable on shared nodes carry both cards and their order", () => {
  const model = parseMdpa(MDPA);
  const found = sharedNodeConflicts(
    model,
    projectParameters([entry("A", [0, 0, 0]), entry("B", [1, 0, 0])]),
    assignments,
    conditions
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.match(found[0].message, /Fixed support/);
  assert.match(found[0].message, /Prescribed displacement/);
  assert.match(found[0].message, /applied later and wins/);
  assert.deepEqual(found[0].target, {
    smpPath: "A",
    conditionId: "fixed",
    relatedConditionId: "prescribed",
    relatedSmpPath: "B",
    sharedNodeCount: 2,
    appliedOrder: 1,
    relatedAppliedOrder: 2,
    valuesDiffer: true,
    entityIds: [1, 2],
    nodeIds: [1, 2],
  });
});

test("entityIds stays the 8-node sample while nodeIds carries every shared node", () => {
  const nodeLines = Array.from({ length: 12 }, (_, i) => `${i + 1} ${i * 0.1} 0.0 0.0`).join("\n");
  const idLines = Array.from({ length: 12 }, (_, i) => `  ${i + 1}`).join("\n");
  const MDPA12 = `Begin Nodes\n${nodeLines}\nEnd Nodes\n\nBegin SubModelPart A\n  Begin SubModelPartNodes\n${idLines}\n  End SubModelPartNodes\nEnd SubModelPart\n\nBegin SubModelPart B\n  Begin SubModelPartNodes\n${idLines}\n  End SubModelPartNodes\nEnd SubModelPart\n`;
  const model = parseMdpa(MDPA12);
  const found = sharedNodeConflicts(
    model,
    projectParameters([entry("A", [0, 0, 0]), entry("B", [1, 0, 0])]),
    assignments,
    conditions
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].target?.sharedNodeCount, 12);
  assert.deepEqual(found[0].target?.entityIds, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(found[0].target?.nodeIds, Array.from({ length: 12 }, (_, i) => i + 1));
});

test("the later card is the target when the generated list is reversed", () => {
  const model = parseMdpa(MDPA);
  const found = sharedNodeConflicts(
    model,
    projectParameters([entry("B", [1, 0, 0]), entry("A", [0, 0, 0])]),
    assignments,
    conditions
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].target?.smpPath, "B");
  assert.equal(found[0].target?.conditionId, "prescribed");
  assert.equal(found[0].target?.relatedSmpPath, "A");
  assert.equal(found[0].target?.appliedOrder, 1);
  assert.equal(found[0].target?.relatedAppliedOrder, 2);
});
test("agreeing values stay an information finding", () => {
  const model = parseMdpa(MDPA);
  const found = sharedNodeConflicts(
    model,
    projectParameters([entry("A", [0, 0, 0]), entry("B", [0, 0, 0])]),
    assignments,
    conditions
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "info");
  assert.equal(found[0].target?.valuesDiffer, false);
  assert.doesNotMatch(found[0].message, /applied later and wins/);
});

test("intervals that never overlap report nothing", () => {
  const model = parseMdpa(MDPA);
  const found = sharedNodeConflicts(
    model,
    projectParameters([entry("A", [0, 0, 0], [0, 1]), entry("B", [1, 0, 0], [2, 3])]),
    assignments,
    conditions
  );
  assert.deepEqual(found, []);
});

test("parts with no shared nodes and one part with itself report nothing", () => {
  const model = parseMdpa(MDPA);
  assert.deepEqual(
    sharedNodeConflicts(
      model,
      projectParameters([entry("A", [0, 0, 0]), entry("C", [1, 0, 0])]),
      assignments,
      conditions
    ),
    []
  );
  assert.deepEqual(
    sharedNodeConflicts(
      model,
      projectParameters([entry("A", [0, 0, 0]), entry("A", [1, 0, 0])]),
      assignments,
      conditions
    ),
    []
  );
});
