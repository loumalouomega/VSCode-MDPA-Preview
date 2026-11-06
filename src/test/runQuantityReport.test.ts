/** Markdown rendering of a per-run quantity (roadmap item 25, viewer half). */
import assert from "node:assert/strict";
import test from "node:test";

import type { RunQuantity } from "../problemtype/runQuantity";
import { renderRunQuantityMarkdown } from "../problemtype/runQuantityReport";

const q: RunQuantity = {
  monitor: "p4",
  columns: ["PRESSURE"],
  parameterColumns: ["load|x"],
  rows: [
    { runDirectory: "/w/runs/a", runId: "run-a", values: [6.5], frames: 3, parameters: { "load|x": 100 } },
    { runDirectory: "/w/runs/b", values: null, frames: 0, parameters: {}, reason: "The run is running, not finished." },
  ],
};

test("one row per run, parameter columns first, a missing value is a dash and never 0", () => {
  const md = renderRunQuantityMarkdown(q, { caseName: "beam", unit: "Pa" });
  const lines = md.split("\n");
  const header = lines.find((l) => l.startsWith("| Run"))!;
  assert.equal(header, "| Run | load\\|x | PRESSURE [Pa] | Frames |");
  assert.ok(md.includes("| run-a | 100 | 6.5 | 3 |"));
  assert.ok(md.includes("| b | — | — | 0 |"));
  assert.match(md, /## Runs without a value\n\n- b: The run is running, not finished\./);
});

test("no unit is claimed when the monitor declares none, and an empty set says so", () => {
  assert.ok(renderRunQuantityMarkdown(q).includes("| PRESSURE |"));
  const empty = renderRunQuantityMarkdown({ ...q, rows: [] });
  assert.match(empty, /No isolated run of this case is available\./);
  assert.ok(!empty.includes("| Run"));
});
