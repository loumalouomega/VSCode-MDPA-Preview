/**
 * handoff.ts — the consuming half of CAD-Preview's mesh handoff.
 *
 * The contract: a manifest is FOREIGN input. A missing one says nothing; a
 * broken one is a warning and never a throw; a stale one names the facts that
 * changed (counts, or the mesh hash) without guessing what the case should do.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { handoffFindings, handoffIdentity, handoffOutput, handoffPath, parseHandoff } from "../problemtype/handoff";
import { meshRevision, readHandoff } from "../problemtype/handoffFile";
import { parseMdpa } from "../parser/mdpaParser";
import type { CaseState } from "../problemtype/types";
import { defaultCaseState } from "../problemtype/api";
import { structural } from "../problemtype/builtins/structural";

const MDPA = `Begin Nodes
1 0 0 0
2 1 0 0
3 1 1 0
4 0 1 0
End Nodes
Begin Elements Element2D4N
1 0 1 2 3 4
End Elements
Begin SubModelParts
Begin SubModelPart Body
Begin SubModelPartNodes
1 2 3 4
End SubModelPartNodes
End SubModelPart
End SubModelParts
`;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manifest(mesh: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    kind: "cad-preview-handoff",
    source: { path: "/cad/model.step", format: "step", sha256: "a".repeat(64) },
    replay: { fingerprint: "f".repeat(64) },
    unit: { unit: "m", scaleFactor: 1 },
    mesh: { nodeCount: 4, elementCount: 1 },
    outputs: [{ path: mesh, format: "mdpa", sha256: sha(MDPA) }],
    parts: [{ name: "Body", status: "resolved", groups: [{ dim: 3, physicalTag: 1, entityCount: 1, elementCount: 1 }] }],
    coverage: { emptyParts: [], unresolvedParts: [], unassignedSurfaceCount: 0, unassignedSurfaceTags: [], overlaps: [] },
    notes: [],
    ...over,
  });
}

const state = (over: Partial<CaseState> = {}): CaseState => ({
  ...defaultCaseState(structural.decl),
  assignments: [{ conditionId: "parts", smpPath: "Body", values: {} }],
  materials: [],
  ...over,
});

test("a mesh without a handoff beside it says nothing at all", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  const read = readHandoff(mesh);
  assert.equal(read.manifest, undefined);
  assert.equal(read.problem, undefined);
  assert.equal(read.path, handoffPath(mesh));
  assert.deepEqual(handoffFindings(read, parseMdpa(MDPA), state(), {}), []);
});

test("a handoff that is not a v1 manifest is one warning, never a throw", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  for (const text of ['{"kind":"something-else"}', "not json", '{"kind":"cad-preview-handoff","version":2}']) {
    fs.writeFileSync(handoffPath(mesh), text);
    const findings = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {});
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "handoff-unreadable");
    assert.equal(findings[0].severity, "warning");
  }
});

test("a matching export is silent, and its units are stated as information", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  fs.writeFileSync(handoffPath(mesh), manifest(mesh));
  assert.deepEqual(handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {}), []);

  fs.writeFileSync(handoffPath(mesh), manifest(mesh, { unit: { unit: "mm", scaleFactor: 0.001 } }));
  const units = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {});
  assert.deepEqual(units.map((f) => f.code), ["handoff-units"]);
  assert.match(units[0].message, /scaled by 0\.001/);
  assert.equal(units[0].severity, "info");
});

test("a remesh after the export is reported stale, by counts and by bytes", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  // Counts first: no hashing needed to know the manifest describes another mesh.
  fs.writeFileSync(handoffPath(mesh), manifest(mesh, { mesh: { nodeCount: 9, elementCount: 1 } }));
  const byCount = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {});
  assert.deepEqual(byCount.map((f) => f.code), ["handoff-stale"]);
  assert.match(byCount[0].message, /9 nodes/);

  // Same counts, different bytes: the hash is what catches an in-place edit.
  // Pin the mtime so the second manifest is indistinguishable from the first
  // by metadata (same size too), as it can be on Windows' coarse timestamps.
  const pinned = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(handoffPath(mesh), pinned, pinned);
  fs.writeFileSync(handoffPath(mesh), manifest(mesh, { outputs: [{ path: mesh, format: "mdpa", sha256: "b".repeat(64) }] }));
  fs.utimesSync(handoffPath(mesh), pinned, pinned);
  const byHash = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {});
  assert.deepEqual(byHash.map((f) => f.code), ["handoff-stale"]);
  assert.match(byHash[0].message, /not byte-identical/);
});

test("an unlisted output is advisory when the counts agree", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  fs.writeFileSync(handoffPath(mesh), manifest(mesh, { outputs: [{ path: "/cad/other.mdpa", format: "mdpa", sha256: sha(MDPA) }] }));
  const findings = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {});
  assert.deepEqual(findings.map((f) => f.code), ["handoff-unlisted"]);
  assert.equal(findings[0].severity, "info");
});

test("a Part that resolved to nothing is named only when the case assigns to it", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  const unresolved = manifest(mesh, {
    parts: [
      { name: "Body", status: "resolved", groups: [{ dim: 3, physicalTag: 1, entityCount: 1, elementCount: 1 }] },
      { name: "Support", status: "unresolved", groups: [] },
      { name: "Debris", status: "empty", groups: [] },
    ],
    coverage: { emptyParts: ["Debris"], unresolvedParts: ["Support"], unassignedSurfaceCount: 0, unassignedSurfaceTags: [], overlaps: [] },
  });
  fs.writeFileSync(handoffPath(mesh), unresolved);
  // Only "Body" is assigned: the other two Parts are facts about the export, not
  // problems in this case, so nothing is said about them.
  assert.deepEqual(handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {}), []);

  const assigned = state({
    assignments: [
      { conditionId: "parts", smpPath: "Body", values: {} },
      { conditionId: "support", smpPath: "Support", values: {} },
      { conditionId: "parts", smpPath: "Debris", values: {} },
    ],
  });
  const findings = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), assigned, {});
  assert.deepEqual(findings.map((f) => f.code), ["handoff-part-unresolved", "handoff-part-unresolved"]);
  assert.deepEqual(findings.map((f) => f.target?.smpPath), ["Support", "Debris"]);
  assert.match(findings[0].message, /resolved to no physical group/);
  assert.match(findings[1].message, /had no entities/);
});

test("unassigned boundary surfaces are a warning only when the case uses surface conditions", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  fs.writeFileSync(handoffPath(mesh), manifest(mesh, {
    coverage: { emptyParts: [], unresolvedParts: [], unassignedSurfaceCount: 3, unassignedSurfaceTags: [7, 8, 9], overlaps: [] },
  }));
  const info = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), { surfaceConditionIds: new Set(["support"]) });
  assert.deepEqual(info.map((f) => f.code), ["handoff-coverage"]);
  assert.equal(info[0].severity, "info");
  assert.deepEqual(info[0].target?.entityIds, [7, 8, 9]);

  const warning = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), { surfaceConditionIds: new Set(["parts"]) });
  assert.equal(warning[0].severity, "warning");
  assert.match(warning[0].message, /surface conditions cannot be assigned/);
});

test("overlapping Part groups name the entities and the groups they share", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  fs.writeFileSync(handoffPath(mesh), manifest(mesh, {
    coverage: {
      emptyParts: [], unresolvedParts: [], unassignedSurfaceCount: 0, unassignedSurfaceTags: [],
      overlaps: [{ dim: 2, entityTag: 4, groups: ["Body", "Support"] }],
    },
  }));
  const findings = handoffFindings(readHandoff(mesh), parseMdpa(MDPA), state(), {});
  assert.deepEqual(findings.map((f) => f.code), ["handoff-overlap"]);
  assert.match(findings[0].message, /"Body", "Support"/);
  assert.deepEqual(findings[0].target?.entityIds, [4]);
});

test("parseHandoff drops what it cannot vouch for instead of trusting it", () => {
  assert.equal(parseHandoff("{}"), null);
  const parsed = parseHandoff(JSON.stringify({
    version: 1, kind: "cad-preview-handoff",
    source: { sha256: "a" }, replay: {},
    parts: [{ name: "Body", status: "weird", groups: [{ dim: "3", physicalTag: 1 }] }, { name: "" }, 7],
    outputs: [{ path: "/x/beam.mdpa" }, { nope: true }],
    coverage: { unassignedSurfaceTags: [1, "two", 3], overlaps: [{ entityTag: 2, groups: ["A", 5] }] },
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed!.parts.map((p) => [p.name, p.status]), [["Body", "unresolved"]]);
  assert.deepEqual(parsed!.parts[0].groups, [{ dim: 0, physicalTag: 1, entityCount: 0, elementCount: 0 }]);
  assert.deepEqual(parsed!.outputs.map((o) => o.path), ["/x/beam.mdpa"]);
  assert.deepEqual(parsed!.coverage.unassignedSurfaceTags, [1, 3]);
  assert.deepEqual(parsed!.coverage.overlaps[0].groups, ["A"]);
  assert.equal(parsed!.unit.scaleFactor, 1);
});

test("meshRevision hashes the file and follows its bytes", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  assert.equal(meshRevision(mesh), sha(MDPA));
  fs.writeFileSync(mesh, `${MDPA}\n// edited\n`);
  assert.notEqual(meshRevision(mesh), sha(MDPA));
});

test("the export identity is identity-only and matches a Windows-written output by basename", (t) => {
  const dir = tmp(t), mesh = path.join(dir, "beam.mdpa");
  fs.writeFileSync(mesh, MDPA);
  // A handoff written on Windows names the output with backslashes; the mesh is
  // read here with forward slashes, and the basename still matches.
  const parsed = parseHandoff(manifest(mesh, {
    source: { path: "C:\\cad\\bracket.step", format: "step", sha256: "a".repeat(64) },
    outputs: [{ path: "C:\\export\\beam.mdpa", format: "mdpa", sha256: sha(MDPA) }],
  }))!;
  assert.equal(handoffOutput(parsed, mesh)?.sha256, sha(MDPA));
  assert.deepEqual(handoffIdentity(parsed), {
    source: "bracket.step", sourceRevision: "a".repeat(64), replay: "f".repeat(64),
  });
  // Nothing recorded, nothing claimed.
  assert.equal(handoffIdentity({ ...parsed, source: { ...parsed.source, sha256: "" } }), undefined);
});
