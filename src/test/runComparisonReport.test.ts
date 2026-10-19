/**
 * runComparisonReport.ts — the Markdown surface over a run comparison.
 *
 * The contract is presentation honesty carried over from runCompare.ts: a
 * verdict that names incomparability instead of guessing, identity as
 * Yes/No/Not-recorded (never a default), settings and artifacts as bounded
 * tables, and unverified pairs labelled as NOT equality. Every fixture is a
 * run DIRECTORY compared through `compareRuns`, so the report is tested on
 * the same evidence the command will render.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { compareRuns } from "../problemtype/runCompare";
import { renderRunComparisonMarkdown } from "../problemtype/runComparisonReport";
import type { ExecutionReceipt } from "../problemtype/runReceipt";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-compare-report-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(
  t: { after: (fn: () => void) => void },
  over: {
    receipt?: Partial<ExecutionReceipt>;
    artifacts?: { role: string; rel: string; revision?: string }[];
    settings?: Record<string, unknown>;
    preparation?: null;
  } = {}
): string {
  const dir = tmp(t);
  const settings = over.settings ?? { problemtypeId: "structural", values: {} };
  fs.writeFileSync(path.join(dir, "beam.mdpa"), "Begin Nodes\nEnd Nodes\n");
  fs.writeFileSync(
    path.join(dir, ".kkss-execution.json"),
    JSON.stringify(
      {
        version: 1,
        requestId: "request-a",
        ownerId: "study-a",
        state: "succeeded",
        runDirectory: dir,
        meshPath: path.join(dir, "beam.mdpa"),
        createdAt: 1,
        updatedAt: 2,
        artifacts: (over.artifacts ?? []).map((a) => ({
          role: a.role,
          path: path.join(dir, a.rel),
          ...(a.revision ? { revision: a.revision } : {}),
        })),
        ...over.receipt,
      },
      null,
      2
    )
  );
  if (over.preparation !== null) {
    fs.writeFileSync(
      path.join(dir, "kkss-preparation-v1.json"),
      JSON.stringify(
        {
          version: 1,
          producer: { name: "vscode-mdpa.case-generator", source: "builtin", scriptRevision: hash("main") },
          problemtype: (settings as { problemtypeId: string }).problemtypeId,
          sourceMesh: { name: "beam.mdpa", revision: "1".repeat(64) },
          solverMesh: { name: "beam.mdpa", revision: "1".repeat(64) },
          primaryDocument: "ProjectParameters.json",
          driverScript: "MainKratos.py",
          settings,
          settingsRevision: hash(JSON.stringify(settings)),
          effectiveParameters: {},
          units: { state: "undeclared", reason: "none" },
          findings: [],
          inputs: [
            { name: "ProjectParameters.json", revision: hash("parameters") },
            { name: "MainKratos.py", revision: hash("main") },
          ],
        },
        null,
        2
      )
    );
  }
  return dir;
}

test("identical runs render a comparable verdict with identical settings", (t) => {
  const left = run(t);
  const right = run(t);
  const report = renderRunComparisonMarkdown(compareRuns(left, right), NOW);
  assert.match(report, /^# Run comparison — \S+ vs \S+/m);
  assert.match(report, /Comparable — both sides are terminal isolated runs\./);
  assert.match(report, /\| Same source mesh \| Yes \|/);
  assert.match(report, /Identical — no setting differs\./);
  assert.match(report, /Paired 0 · only on the left 0 · only on the right 0 · changed 0 · unverified 0\./);
  assert.doesNotMatch(report, /Not comparable/);
  assert.match(report, /Compared 2026-10-19T12:00:00\.000Z\./);
});

test("differences render as tables and unverified pairs disclaim equality", (t) => {
  const left = run(t, {
    settings: { problemtypeId: "structural", values: { load: "10|kN" } },
    artifacts: [
      { role: "result", rel: path.join("vtk_output", "beam_0_1.vtu"), revision: `sha256:${"a".repeat(64)}` },
      { role: "log", rel: "beam.kratosrun.log" },
      { role: "result", rel: path.join("vtk_output", "left-only.vtu"), revision: `sha256:${"b".repeat(64)}` },
    ],
  });
  const right = run(t, {
    settings: { problemtypeId: "structural", values: {} },
    artifacts: [
      { role: "result", rel: path.join("vtk_output", "beam_0_1.vtu"), revision: `sha256:${"c".repeat(64)}` },
      { role: "log", rel: "beam.kratosrun.log" },
    ],
  });
  const report = renderRunComparisonMarkdown(compareRuns(left, right), NOW);
  assert.match(report, /\| `values\.load` \| 10\\\|kN \| — \|/);
  assert.match(report, /\| `result:vtk_output\/beam_0_1\.vtu` \| sha256:aaaaaaaaaaaa… \| sha256:cccccccccccc… \|/);
  assert.match(report, /- `result:vtk_output\/left-only\.vtu`/);
  assert.match(report, /at least one side never pinned the bytes, so equality is \*\*not\*\* claimed/);
  assert.match(report, /- `log:beam\.kratosrun\.log`/);
});

test("an incomparable pair renders its problems and no invented verdict", (t) => {
  const left = run(t);
  const report = renderRunComparisonMarkdown(compareRuns(left, path.join(left, "nowhere")), NOW);
  assert.match(report, /Not comparable:/);
  assert.match(report, /- .*No execution receipt/);
  assert.doesNotMatch(report, /^Comparable /m);
});

test("a list hitting the bound says so", (t) => {
  const values: Record<string, unknown> = {};
  for (let i = 0; i < 250; i++) values[`k${i}`] = i;
  const left = run(t, { settings: { problemtypeId: "structural", values } });
  const right = run(t);
  const report = renderRunComparisonMarkdown(compareRuns(left, right), NOW);
  assert.match(report, /> List bounded at 200 differing settings; the runs record more\./);
});
