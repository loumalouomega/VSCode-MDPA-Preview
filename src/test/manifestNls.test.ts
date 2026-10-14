import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const pkgText = fs.readFileSync(path.join(root, "package.json"), "utf8");
const nls: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8"));

function placeholders(value: unknown, out: Set<string>): void {
  if (typeof value === "string") { const m = /^%([^%]+)%$/.exec(value); if (m) out.add(m[1]); }
  else if (Array.isArray(value)) value.forEach(v => placeholders(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach(v => placeholders(v, out));
}

test("every %key% in package.json is defined in package.nls.json, and every key is used", () => {
  const used = new Set<string>();
  placeholders(JSON.parse(pkgText), used);
  const missing = [...used].filter(k => !(k in nls));
  const unused = Object.keys(nls).filter(k => !used.has(k));
  assert.deepEqual(missing, [], `undefined keys: ${missing.join(", ")}`);
  assert.deepEqual(unused, [], `unused keys: ${unused.join(", ")}`);
});
test("catalogue values are non-empty English strings with no placeholder syntax", () => {
  for (const [k, v] of Object.entries(nls)) {
    assert.equal(typeof v, "string", k);
    assert.ok(v.trim().length > 0, `${k} is empty`);
    assert.ok(!/^%[^%]+%$/.test(v), `${k} points at another key`);
  }
});
test("user-facing manifest strings are catalogued, not literal", () => {
  const pkg = JSON.parse(pkgText);
  const c = pkg.contributes;
  assert.match(pkg.description, /^%.+%$/);
  for (const cmd of c.commands) assert.match(cmd.title, /^%.+%$/, cmd.command);
  for (const [name, def] of Object.entries<any>(c.configuration.properties)) {
    for (const f of ["description", "markdownDescription"]) if (def[f] !== undefined) assert.match(def[f], /^%.+%$/, `${name}.${f}`);
  }
});
test("package.nls.json ships in the vsix", () => {
  const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
  assert.ok(!/^\s*(package\.nls\.json|\*\.json)\s*$/m.test(ignore));
});
