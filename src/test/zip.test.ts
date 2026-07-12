import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { createZip, readZip, crc32 } from "../parser/zip";

const FIXTURES = path.resolve(__dirname, "../../src/test/fixtures/zip");

test("zip round-trips text and binary entries", () => {
  const text = Buffer.from("Begin Nodes\n1 0.0 0.0 0.0\nEnd Nodes\n".repeat(50), "utf8");
  const binary = Buffer.alloc(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 7) & 0xff;
  const tiny = Buffer.from("x", "utf8"); // incompressible → stored path
  const empty = Buffer.alloc(0);

  const zip = createZip([
    { name: "mesh.mdpa", data: text },
    { name: "sub/dir/data.bin", data: binary },
    { name: "t", data: tiny },
    { name: "empty.json", data: empty },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["mesh.mdpa", "sub/dir/data.bin", "t", "empty.json"]
  );
  assert.ok(Buffer.from(entries[0].data).equals(text));
  assert.ok(Buffer.from(entries[1].data).equals(binary));
  assert.ok(Buffer.from(entries[2].data).equals(tiny));
  assert.equal(entries[3].data.length, 0);
});

test("zip preserves UTF-8 entry names", () => {
  const zip = createZip([{ name: "résultats/übung.mdpa", data: Buffer.from("a") }]);
  assert.equal(readZip(zip)[0].name, "résultats/übung.mdpa");
});

test("readZip parses an archive written by Python's zipfile", () => {
  const buf = fs.readFileSync(path.join(FIXTURES, "python-interop.zip"));
  const entries = readZip(buf);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  assert.equal(
    Buffer.from(byName.get("hello.txt")!).toString("utf8"),
    "hello from python zipfile\n".repeat(40)
  );
  const bin = Buffer.from(byName.get("nested/dir/data.bin")!);
  assert.equal(bin.length, 256 * 8);
  assert.equal(bin[255], 255);
  assert.equal(Buffer.from(byName.get("stored.txt")!).toString("utf8"), "tiny");
});

test("readZip rejects garbage and corrupted data", () => {
  assert.throws(() => readZip(Buffer.from("not a zip at all")), /zip/i);

  const zip = createZip([{ name: "a.txt", data: Buffer.from("hello hello hello") }]);
  const corrupted = Buffer.from(zip);
  corrupted[35] ^= 0xff; // first payload byte (30-byte local header + 5-byte name)
  assert.throws(() => readZip(corrupted)); // inflate error, CRC or size mismatch
});

test("crc32 matches the known value for 'hello'", () => {
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
});
