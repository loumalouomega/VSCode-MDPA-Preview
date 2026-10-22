/**
 * former roadmap item 13, delivered 2026-10-19 over MCP: `mesh_transform` without `outputPath` and
 * `mesh_convert` onto the source are the in-place saves, they follow the same
 * ownership plan as the extension's Save, and every OTHER write into the case
 * a model came from is refused. Own file (own process): each case loads wasm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { meshConvert, meshExtractSubModelPart, meshInfo, meshTransform } from "../mcp/tools";

const FIXTURE = path.resolve(__dirname, "../../src/test/fixtures/openfoam-inplace/case");

function copyCase(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inplace-"));
  fs.cpSync(FIXTURE, dest, { recursive: true });
  return dest;
}

function digests(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join("/"), createHash("sha1").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

const changed = (a: Map<string, string>, b: Map<string, string>): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();

test("mesh_transform with no outputPath translates a case in place: only points change", async () => {
  const dir = copyCase();
  const marker = path.join(dir, "case.foam");
  const before = digests(dir);
  const result = (await meshTransform({ path: marker, ops: [{ op: "translate", dx: 5, dy: 0, dz: 0 }] })) as {
    outputPath: string;
    warnings: string[];
  };
  assert.equal(path.resolve(result.outputPath), path.resolve(marker));
  assert.deepEqual(changed(before, digests(dir)), ["constant/polyMesh/points"]);
  const info = (await meshInfo({ path: marker })) as { bounds: { min: number[]; max: number[] } };
  assert.deepEqual(info.bounds.min, [5, 0, 0], "the cache was invalidated: a fresh read sees the new points");
});

test("mesh_transform whose topology change would strand index-keyed files is refused and writes nothing", async () => {
  const dir = copyCase();
  const marker = path.join(dir, "case.foam");
  const before = digests(dir);
  await assert.rejects(
    () => meshTransform({ path: marker, ops: [{ op: "refine", levels: 1 }] }),
    (e: Error) => /0\.5\/p/.test(e.message) && /Save As|Export/.test(e.message)
  );
  assert.deepEqual(changed(before, digests(dir)), []);
});

test("mesh_convert onto its own input is the same in-place save", async () => {
  const dir = copyCase();
  const marker = path.join(dir, "case.foam");
  const before = digests(dir);
  await meshConvert({ path: marker, outputPath: marker });
  assert.deepEqual(changed(before, digests(dir)), [], "an unmodified model has nothing to write");
});

test("every other write into the source case is refused", async () => {
  const dir = copyCase();
  const marker = path.join(dir, "case.foam");
  const before = digests(dir);
  await assert.rejects(
    () => meshTransform({ path: marker, ops: [{ op: "translate", dx: 1, dy: 0, dz: 0 }], outputPath: path.join(dir, "other.foam") }),
    /Choose a different directory/
  );
  await assert.rejects(
    () => meshExtractSubModelPart({ path: marker, submodelpart: "walls", outputPath: path.join(dir, "walls.foam") }),
    /Choose a different directory/
  );
  assert.deepEqual(changed(before, digests(dir)), []);
});

test("a copy written elsewhere is unaffected", async () => {
  const dir = copyCase();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-elsewhere-")), "copy.foam");
  const before = digests(dir);
  await meshTransform({ path: path.join(dir, "case.foam"), ops: [{ op: "translate", dx: 1, dy: 0, dz: 0 }], outputPath: out });
  assert.ok(fs.existsSync(path.join(path.dirname(out), "constant/polyMesh/points")));
  assert.deepEqual(changed(before, digests(dir)), []);
});

test("a cancelled signal makes mesh_transform reject before loading or writing anything", async () => {
  const dir = copyCase();
  const marker = path.join(dir, "case.foam");
  const before = digests(dir);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () => meshTransform({ path: marker, ops: [{ op: "translate", dx: 3, dy: 0, dz: 0 }] }, { signal: abort.signal }),
    /cancelled/
  );
  assert.deepEqual(changed(before, digests(dir)), []);
});

test("mesh_transform translates a multi-region and a decomposed case in place; topology is refused", async () => {
  for (const [src, files] of [
    ["openfoam-multiregion", ["constant/fluid/polyMesh/points", "constant/solid/polyMesh/points"]],
    ["openfoam-decomposed", ["processor0/constant/polyMesh/points", "processor1/constant/polyMesh/points"]],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dist-"));
    fs.cpSync(path.resolve(__dirname, `../../src/test/fixtures/${src}/case`), dir, { recursive: true });
    const marker = path.join(dir, "case.foam");
    const before = digests(dir);
    await meshTransform({ path: marker, ops: [{ op: "translate", dx: 0, dy: 0, dz: 2 }] });
    assert.deepEqual(changed(before, digests(dir)), [...files]);
    const info = (await meshInfo({ path: marker })) as { bounds: { min: number[] } };
    assert.equal(info.bounds.min[2], 2);
  }
});

test("mesh_transform refines multi-region and decomposed cases in place", async () => {
  const multi = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dist-"));
  fs.cpSync(path.resolve(__dirname, "../../src/test/fixtures/openfoam-multiregion/case"), multi, { recursive: true });
  await meshTransform({ path: path.join(multi, "case.foam"), ops: [{ op: "refine", levels: 1 }] });
  const touched = fs.readdirSync(path.join(multi, "constant/fluid/polyMesh")).sort();
  assert.ok(touched.includes("owner"), `fluid polyMesh rewritten: ${touched}`);

  const decomp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dist-"));
  fs.cpSync(path.resolve(__dirname, "../../src/test/fixtures/openfoam-decomposed/case"), decomp, { recursive: true });
  const marker = path.join(decomp, "case.foam");
  const mid = digests(decomp);
  await meshTransform({ path: marker, ops: [{ op: "refine", levels: 1 }] });
  const rewritten = fs.readdirSync(path.join(decomp, "processor0/constant/polyMesh")).sort();
  assert.ok(rewritten.includes("cellProcAddressing"), `processor0 rewritten with new addressing: ${rewritten}`);
  assert.deepEqual(changed(mid, digests(decomp)).filter((n) => !n.startsWith("processor")), []);
});
