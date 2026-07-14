import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_PROBLEMTYPES } from "../problemtype/builtins";
import { validateDeclaration, defaultCaseState } from "../problemtype/api";
import {
  FLOWGRAPH_BRIDGE_NS,
  isBridgeMessage,
} from "../flowgraphMessages";

test("the flowgraph builtin is registered and valid", () => {
  const rt = BUILTIN_PROBLEMTYPES.find((b) => b.decl.id === "flowgraph");
  assert.ok(rt, "flowgraph builtin should be registered");
  assert.equal(rt.decl.view, "flowgraph");
  assert.equal(rt.decl.icon, "ptFlowgraph");
  assert.deepEqual(validateDeclaration(rt.decl), []); // minimal but valid
});

test("a default case state can be built for flowgraph", () => {
  const rt = BUILTIN_PROBLEMTYPES.find((b) => b.decl.id === "flowgraph")!;
  const state = defaultCaseState(rt.decl);
  assert.equal(state.problemtypeId, "flowgraph");
  assert.equal(state.version, 1);
});

test("validateDeclaration rejects an unknown view", () => {
  const rt = BUILTIN_PROBLEMTYPES.find((b) => b.decl.id === "flowgraph")!;
  const bad = { ...rt.decl, view: "bogus" as unknown as "flowgraph" };
  assert.ok(validateDeclaration(bad).some((e) => e.includes("view")));
});

test("isBridgeMessage only accepts namespaced messages", () => {
  assert.ok(
    isBridgeMessage({ ns: FLOWGRAPH_BRIDGE_NS, type: "frameReady" })
  );
  assert.ok(
    isBridgeMessage({ ns: FLOWGRAPH_BRIDGE_NS, type: "exportParams", json: "{}" })
  );
  assert.equal(isBridgeMessage({ type: "frameReady" }), false);
  assert.equal(isBridgeMessage(null), false);
  assert.equal(isBridgeMessage("frameReady"), false);
});
