import assert from "node:assert/strict";
import test from "node:test";

import { explainOpMessage } from "../parser/opExplain";

test("names a missing required parameter", () => {
  assert.match(explainOpMessage({ type: "applyOp", op: "rotate" }), /rotate: missing required parameter "axis"/);
  assert.match(explainOpMessage({ type: "applyOp", op: "renameSubModelPart", path: "A" }), /"newName"/);
});

test("names the offending value", () => {
  assert.match(explainOpMessage({ type: "applyOp", op: "mergeNodes", tolerance: -1 }), /invalid value for tolerance=-1/);
  assert.match(explainOpMessage({ type: "applyOp", op: "smooth", method: "bogus" }), /method="bogus"/);
});

test("an unknown or missing operation is reported", () => {
  assert.match(explainOpMessage({ type: "applyOp", op: "nope" }), /unknown operation "nope"/);
  assert.match(explainOpMessage({ type: "applyOp" }), /missing operation name/);
});

test("falls back to the usage line when no single value is to blame", () => {
  // shrinkwrap needs exactly one of path / part / skin.
  assert.match(explainOpMessage({ type: "applyOp", op: "shrinkwrap" }), /usage: shrinkwrap/);
});
