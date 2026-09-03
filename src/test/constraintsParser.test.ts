/**
 * The mdpa `Begin Constraints` row parser (see src/parser/constraintsParser.ts).
 *
 * Two things are pinned here beyond "the rows parse": that an unrecognised row
 * is kept **verbatim** rather than coerced or dropped — the fallback that makes
 * an unseen third constraint shape a non-event — and that the whole container is
 * plain JSON, since it rides on `MdpaModel` across `postMessage` and through the
 * screenshot harness's `JSON.stringify`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConstraintBlock,
  LinearConstraint,
  constraintNodeIds,
  countConstraints,
  definedConstraintIds,
  filterConstraintsByNode,
  formatConstraintRow,
  mapConstraintNodes,
  maxDefinedConstraintId,
  offsetConstraints,
  parseConstraintRow,
  parseConstraintsBlock,
  remapConstraintIds,
  undefinedConstraintIds,
} from "../parser/constraintsParser";
import { SubModelPart } from "../parser/types";

function linear(line: string): LinearConstraint {
  const row = parseConstraintRow(line);
  assert.equal(row.kind, "linear", `expected "${line}" to parse, got ${JSON.stringify(row)}`);
  return row as LinearConstraint;
}

function rawOf(line: string): string[] {
  const msgs: string[] = [];
  const row = parseConstraintRow(line, (m) => msgs.push(m));
  assert.equal(row.kind, "raw", `expected "${line}" to be kept verbatim`);
  assert.equal((row as { text: string }).text, line.trim(), "the source text must survive");
  return msgs;
}

// ------------------------------------------------------------------ row forms

test("a single-weight row splits into one slave and one master", () => {
  const r = linear("1 0.0 [0.5] 1 2");
  assert.deepEqual(
    {
      id: r.id,
      constant: r.constant,
      weights: r.weights,
      slaveIds: r.slaveIds,
      masterIds: r.masterIds,
    },
    { id: 1, constant: 0, weights: [0.5], slaveIds: [1], masterIds: [2] }
  );
});

test("the weight vector is re-joined across the whitespace token split", () => {
  // `stripped.split(/\s+/)` shatters "[0.25, 0.25]" into "[0.25," and "0.25]",
  // which is why the parser works on the string — parseFieldRecord re-joins
  // "(v1, v2)" for the same reason.
  const r = linear("2 0.0 [0.25, 0.25] 1 3 972");
  assert.deepEqual(r.weights, [0.25, 0.25]);
  assert.deepEqual(r.slaveIds, [1]);
  assert.deepEqual(r.masterIds, [3, 972], "two weights so the LAST two ids are the masters");
});

test("tabs and a trailing tab are all just whitespace", () => {
  // cube.mdpa's own bytes: tab-indented, tab-separated, trailing tab.
  const r = linear("\t1\t0.0 [1.0]\t1\t80\t");
  assert.deepEqual(r.weights, [1]);
  assert.deepEqual(r.slaveIds, [1]);
  assert.deepEqual(r.masterIds, [80]);
});

test("negative and scientific columns parse", () => {
  const r = linear("7 -1.5e-3 [0.5, -0.5] 4 5 6");
  assert.equal(r.constant, -0.0015);
  assert.deepEqual(r.weights, [0.5, -0.5]);
  assert.deepEqual(r.masterIds, [5, 6]);
});

test("more than one slave is expressible because the split is from the END", () => {
  const r = linear("3 0.0 [1.0] 8 9 10");
  assert.deepEqual(r.slaveIds, [8, 9]);
  assert.deepEqual(r.masterIds, [10]);
});

test("a trailing comment is not part of the row", () => {
  const block = parseConstraintsBlock(
    ["LinearMasterSlaveConstraint", "TEMPERATURE"],
    ["1 0.0 [1.0] 1 2 // the interface tie"]
  );
  assert.equal(block.rows.length, 1);
  assert.equal(block.rows[0].kind, "linear");
});

// ----------------------------------------------------------- the raw fallback

test("every ladder exit keeps the row verbatim and says why", () => {
  const cases: Array<[string, RegExp]> = [
    ["oops 0.0 [1.0] 1 2", /leading constraint id/],
    ["1 0.0 [1.0 1 2", /balanced \[weights\]/],
    ["1 0.0 [[1.0,0.0],[0.0,1.0]] 1 2 3 4", /relation matrix/],
    ["1 0.0 [x] 1 2", /comma-separated list of numbers/],
    ["1 0.0 [1.0] 1 two", /run of node ids/],
    ["1 0.0 [1.0, 2.0] 5", /no slave column left/],
  ];
  for (const [line, why] of cases) {
    const msgs = rawOf(line);
    assert.ok(msgs.length > 0, `"${line}" should have reported something`);
    assert.match(msgs.join(" "), why);
  }
});

test("a bracketed constant is refused rather than guessed at", () => {
  const msgs = rawOf("1 [3] (0,0,0) [1.0] 1 2");
  assert.ok(msgs.length > 0);
});

test("a second bracket group after the weights is refused rather than guessed", () => {
  const msgs = rawOf("1 0.0 [1.0] 1 2 [3]");
  assert.match(msgs.join(" "), /second|run of node ids/);
});

test("a raw row is one row, not a poisoned block", () => {
  const block = parseConstraintsBlock(
    ["LinearMasterSlaveConstraint"],
    ["1 0.0 [1.0] 1 2", "garbage garbage garbage", "3 0.0 [1.0] 3 4"]
  );
  assert.deepEqual(countConstraints([block]), { linear: 2, raw: 1 });
  assert.deepEqual(definedConstraintIds([block]), [1, 3]);
});

test("the parser never throws, whatever it is fed", () => {
  for (const line of ["", "   ", "[", "]]]", "1", "1 ", " ", "9".repeat(400)]) {
    assert.doesNotThrow(() => parseConstraintRow(line));
  }
});

// ------------------------------------------------------------------- headers

test("the header splits into a name and its variables", () => {
  const one = parseConstraintsBlock(["LinearMasterSlaveConstraint", "DISPLACEMENT_X"], []);
  assert.equal(one.name, "LinearMasterSlaveConstraint");
  assert.deepEqual(one.variables, ["DISPLACEMENT_X"]);

  const two = parseConstraintsBlock(
    ["LinearMasterSlaveConstraint", "TEMPERATURE", "TEMPERATURE"],
    []
  );
  assert.deepEqual(two.variables, ["TEMPERATURE", "TEMPERATURE"]);

  const bare = parseConstraintsBlock([], []);
  assert.equal(bare.name, "");
  assert.deepEqual(bare.variables, []);
});

// ----------------------------------------------------------------- formatting

test("formatting reproduces the source spelling of the committed fixtures", () => {
  for (const line of ["1 0.0 [0.5] 1 2", "2 0.0 [0.25, 0.25] 1 3 972", "1 0.0 [1.0] 1 80"]) {
    assert.equal(formatConstraintRow(parseConstraintRow(line)), line);
  }
});

test("a raw row formats back to exactly its own text", () => {
  const row = parseConstraintRow("something 0.0 else");
  assert.equal(formatConstraintRow(row), "something 0.0 else");
});

// --------------------------------------------------------------- JSON-ability

test("the container is plain JSON, with no Map and no typed arrays", () => {
  const block = parseConstraintsBlock(
    ["LinearMasterSlaveConstraint", "TEMPERATURE"],
    ["1 0.0 [0.25, 0.25] 1 3 972", "not a constraint"]
  );
  assert.deepEqual(JSON.parse(JSON.stringify([block])), [block]);
});

// --------------------------------------------------------------- maintenance

const BLOCKS: ConstraintBlock[] = [
  parseConstraintsBlock(
    ["LinearMasterSlaveConstraint", "DISPLACEMENT_X"],
    ["1 0.0 [0.5] 1 2", "2 0.0 [0.25, 0.25] 1 3 972"]
  ),
];

test("constraintNodeIds returns slaves and masters together", () => {
  assert.deepEqual(constraintNodeIds(BLOCKS[0].rows[1]), [1, 3, 972]);
  assert.deepEqual(constraintNodeIds({ kind: "raw", text: "x" }), []);
});

test("mapConstraintNodes relabels every column", () => {
  const { blocks, droppedIds } = mapConstraintNodes(BLOCKS, (id) => id + 100);
  assert.deepEqual(droppedIds, []);
  const r = blocks[0].rows[1] as LinearConstraint;
  assert.deepEqual(r.slaveIds, [101]);
  assert.deepEqual(r.masterIds, [103, 1072]);
});

test("a constraint whose node has no mapping is dropped, not zero-filled", () => {
  // Connectivity zero-fills a dangling ref because it is stride-fixed; a
  // constraint with a 0 master would misalign its weight vector instead.
  const { blocks, droppedIds } = mapConstraintNodes(BLOCKS, (id) => (id === 972 ? undefined : id));
  assert.deepEqual(droppedIds, [2]);
  assert.equal(countConstraints(blocks).linear, 1);
});

test("filterConstraintsByNode keeps only fully-surviving constraints", () => {
  const keep = new Set([1, 2]);
  const { blocks, droppedIds } = filterConstraintsByNode(BLOCKS, (id) => keep.has(id));
  assert.deepEqual(droppedIds, [2]);
  assert.deepEqual(definedConstraintIds(blocks), [1]);
});

test("a block left with no rows disappears rather than lingering empty", () => {
  const { blocks } = filterConstraintsByNode(BLOCKS, () => false);
  assert.equal(blocks, undefined);
});

test("offsetConstraints shifts the id space and the node space independently", () => {
  const out = offsetConstraints(BLOCKS, 10, 1000);
  const r = out[0].rows[0] as LinearConstraint;
  assert.equal(r.id, 11);
  assert.deepEqual(r.slaveIds, [1001]);
  assert.deepEqual(r.masterIds, [1002]);
  assert.equal(maxDefinedConstraintId(out), 12);
});

test("remapConstraintIds relabels the constraint's own id only", () => {
  const out = remapConstraintIds(
    BLOCKS,
    new Map([
      [1, 7],
      [2, 8],
    ])
  );
  assert.deepEqual(definedConstraintIds(out), [7, 8]);
  assert.deepEqual((out[0].rows[0] as LinearConstraint).masterIds, [2], "node ids untouched");
});

test("undefinedConstraintIds is the defect this module closes", () => {
  const part: SubModelPart = {
    name: "Tied",
    nodeIds: new Int32Array(0),
    elementIds: new Int32Array(0),
    conditionIds: new Int32Array(0),
    geometryIds: new Int32Array(0),
    constraintIds: Int32Array.from([1, 2, 99]),
    path: "Tied",
    children: [],
  };
  assert.deepEqual(undefinedConstraintIds(BLOCKS, [part]), [99]);
  assert.deepEqual(undefinedConstraintIds(undefined, [part]), [1, 2, 99]);
});
