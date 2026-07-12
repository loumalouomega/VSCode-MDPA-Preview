import { test } from "node:test";
import assert from "node:assert";
import { TOOLBAR_ICONS, ToolbarIconId } from "../toolbarIcons";

// Invariants for the GENERATED src/toolbarIcons.ts (see icons/README.md). These
// guard the post-processing in icons/build-toolbar-icons.mjs so a regeneration
// that drops currentColor / leaves hardcoded sizing gets caught by `npm test`.

const EXPECTED_IDS: ToolbarIconId[] = [
  "check", "close", "condition", "cut", "edit", "export", "field", "fileMenu", "find",
  "generateCase", "grid", "info", "levelset", "material", "merge", "nodeIds", "open",
  "orphan", "pan", "play", "problemtype", "quadratic", "quality", "redo", "remesh",
  "reset", "results", "rotate", "runCase", "save", "saveAs", "scale", "screenshot",
  "stop", "translate", "undo", "warning", "wireframe",
];

test("TOOLBAR_ICONS has exactly the expected ids", () => {
  assert.deepStrictEqual(
    Object.keys(TOOLBAR_ICONS).sort(),
    [...EXPECTED_IDS].sort()
  );
});

test("every icon is non-empty SVG markup with a viewBox", () => {
  for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
    assert.ok(svg.startsWith("<svg"), `${id} should start with <svg`);
    assert.match(svg, /<\/svg>\s*$/, `${id} should end with </svg>`);
    assert.match(svg, /viewBox="[\d.\s]+"/, `${id} should have a viewBox`);
  }
});

test("never leaves a hardcoded width/height that would override CSS sizing", () => {
  for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
    const svgTag = svg.slice(0, svg.indexOf(">") + 1);
    assert.doesNotMatch(svgTag, /\swidth="/, `${id} should not hardcode width`);
    assert.doesNotMatch(svgTag, /\sheight="/, `${id} should not hardcode height`);
  }
});

test("never leaves literal black — every stroke/fill should be currentColor-based", () => {
  for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
    assert.doesNotMatch(
      svg,
      /rgb\(0%, 0%, 0%\)/,
      `${id} should not contain literal black rgb(0%,...)`
    );
    assert.ok(svg.includes("currentColor"), `${id} should use currentColor`);
  }
});

test("never emits a duplicate fill-opacity attribute on the same path", () => {
  for (const [id, svg] of Object.entries(TOOLBAR_ICONS)) {
    for (const path of svg.match(/<path[^/]*\/>/g) ?? []) {
      const count = (path.match(/fill-opacity="/g) ?? []).length;
      assert.ok(count <= 1, `${id} path has ${count} fill-opacity attrs: ${path}`);
    }
  }
});
