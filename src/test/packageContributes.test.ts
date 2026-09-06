import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// The manifest is the one part of the sidebar work that no unit test would
// otherwise reach: a wrong icon path or a `when` clause that forgot the second
// Kratos Runs view fails silently at runtime (a blank activity-bar button, a
// context menu that never appears) and there is no VS Code integration harness
// here to catch it.
const ROOT = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const contributes = pkg.contributes as Record<string, any>;

import { SUMMARY_THRESHOLD_MB_DEFAULT } from "../parser/meshSummary";

test("the activity-bar container's icon is a real, shipped SVG", () => {
  const container = contributes.viewsContainers.activitybar.find(
    (c: any) => c.id === "kratosMdpa"
  );
  assert.ok(container, "no kratosMdpa activity-bar container");

  const iconPath = container.icon as string;
  assert.ok(iconPath.endsWith(".svg"), "an activity-bar icon must be an SVG");
  const onDisk = path.join(ROOT, iconPath);
  assert.ok(fs.existsSync(onDisk), `${iconPath} does not exist`);

  const svg = fs.readFileSync(onDisk, "utf8");
  assert.match(svg, /viewBox="[^"]+"/, "needs a viewBox to scale into the bar");
  // VS Code renders the icon as a mask, so only the alpha silhouette survives;
  // a fill-based mark would flatten to a featureless blob.
  assert.match(svg, /stroke="currentColor"/);

  // It must NOT live under icons/svg-ui/, which build-toolbar-icons.mjs globs
  // wholesale into the generated src/toolbarIcons.ts (inlined into both
  // bundles) — putting it there would add a bogus ToolbarIconId.
  assert.ok(!iconPath.includes("svg-ui"), "keep it out of the toolbar-icon codegen");

  // .vscodeignore excludes all of images/**, so the asset only ships if it is
  // explicitly negated. Without this the button renders blank in the .vsix.
  const ignore = fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8");
  assert.ok(
    ignore.split(/\r?\n/).some((l) => l.trim() === `!${iconPath}`),
    `${iconPath} is not un-ignored in .vscodeignore`
  );
});

test("view ids are globally unique across every container", () => {
  const ids: string[] = [];
  for (const list of Object.values(contributes.views) as any[]) {
    for (const v of list) ids.push(v.id);
  }
  assert.deepStrictEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
    "a duplicate id would make one of the two copies never render"
  );
});

test("Kratos Runs is contributed to both containers, under two ids", () => {
  const explorer = contributes.views.explorer.map((v: any) => v.id);
  const sidebar = contributes.views.kratosMdpa.map((v: any) => v.id);
  assert.ok(explorer.includes("kratos.runs"));
  assert.ok(sidebar.includes("kratos.runsSidebar"));
});

test("every run-command menu entry names BOTH run views", () => {
  // `&&` binds tighter than `||`, so the disjunction must also be parenthesised
  // or `A || B && C` silently means `A || (B && C)`.
  for (const [section, entries] of Object.entries(contributes.menus) as [string, any[]][]) {
    for (const e of entries) {
      const when: string | undefined = e.when;
      if (!when || !when.includes("kratos.runs")) continue;
      assert.ok(
        when.includes("kratos.runsSidebar"),
        `${section}/${e.command}: "${when}" forgets the sidebar view`
      );
      if (when.includes("&&")) {
        assert.ok(
          when.includes("(view == kratos.runs || view == kratos.runsSidebar)"),
          `${section}/${e.command}: the || must be parenthesised`
        );
      }
    }
  }
});

test("every command the welcome view links to is declared", () => {
  const declared = new Set(contributes.commands.map((c: any) => c.command));
  const welcome = contributes.viewsWelcome.find((w: any) => w.view === "kratos.start");
  assert.ok(welcome, "the start view has no welcome content, so it renders empty");

  const linked = [...String(welcome.contents).matchAll(/\(command:([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, "no command links in the welcome content");
  for (const cmd of linked) {
    assert.ok(declared.has(cmd), `${cmd} is linked but not in contributes.commands`);
  }
  // The whole point of the container: these work with no file and no panel.
  for (const cmd of ["kratos.mesh.open", "kratos.preview.openEmpty", "kratos.problem.load"]) {
    assert.ok(linked.includes(cmd), `${cmd} should be offered on the welcome view`);
  }
});

test("argument-taking commands stay out of the palette", () => {
  // Invoking them from the palette passes no argument and would do nothing;
  // the six run commands already follow this rule.
  const hidden = new Set(
    (contributes.menus.commandPalette as any[])
      .filter((e) => e.when === "false")
      .map((e) => e.command)
  );
  for (const cmd of ["kratos.recent.open", "kratos.recent.remove"]) {
    assert.ok(hidden.has(cmd), `${cmd} takes an argument and must be hidden`);
  }
});

test("configuration properties follow the manifest's own house style", () => {
  const props = contributes.configuration.properties as Record<string, any>;
  for (const [name, def] of Object.entries(props)) {
    assert.ok(
      typeof def.markdownDescription === "string" && def.markdownDescription.length > 0,
      `${name} has a markdownDescription`
    );
    assert.equal(def.description, undefined, `${name} uses markdownDescription, not description`);
  }
});

test("the summary threshold's manifest default matches the code's", () => {
  // The provider reads this with getConfiguration().get(key, DEFAULT), so the
  // manifest and the fallback are two copies of one number. Nothing else would
  // notice them drifting: a user who never touches the setting silently gets
  // the manifest's value, and one who resets it gets the code's.
  const prop = contributes.configuration.properties["kratos.preview.summaryThresholdMb"];
  assert.ok(prop, "the setting is declared");
  assert.equal(prop.type, "number");
  assert.equal(prop.minimum, 0, "0 must be reachable — it is how the feature is turned off");
  assert.equal(prop.default, SUMMARY_THRESHOLD_MB_DEFAULT);
});

// ---- Keybindings ---------------------------------------------------------------
//
// The two custom editors rebind keys that mean something everywhere else in
// VS Code (Ctrl+S, Ctrl+O, Ctrl+E and now Ctrl+Z), which only works because
// every entry is scoped to `activeCustomEditorId`. Nothing else in this repo
// looks at this section: a binding naming a command that does not exist, or one
// that scopes itself to a single view type, fails silently in exactly the way
// the run-view test above guards against for menus.

const VIEW_TYPES = ["kratos.mdpaPreview", "kratos.vtkPreview"];

test("every keybinding names a declared command", () => {
  const declared = new Set((contributes.commands as any[]).map((c) => c.command));
  for (const kb of contributes.keybindings as any[]) {
    assert.ok(declared.has(kb.command), `${kb.command} is bound to ${kb.key} but not declared`);
  }
});

test("a preview keybinding is scoped to BOTH preview view types", () => {
  // One view type would leave the key working in the MDPA preview and dead in
  // the VTK one (or the reverse) — invisible until someone opens the other.
  for (const kb of contributes.keybindings as any[]) {
    const when = String(kb.when ?? "");
    if (!when.includes("activeCustomEditorId")) continue;
    for (const vt of VIEW_TYPES) {
      assert.ok(when.includes(vt), `${kb.command} (${kb.key}) does not mention ${vt}`);
    }
  }
});

test("undo and redo are reachable from the keyboard", () => {
  // The webview's own keydown handler returns early on any modifier, so
  // Ctrl+Z can ONLY arrive through the manifest. Losing this binding would
  // silently take undo back to being sidebar-button-only.
  const byCommand = new Map(
    (contributes.keybindings as any[]).map((kb) => [kb.command, kb])
  );
  for (const [cmd, key, mac] of [
    ["kratos.mesh.undo", "ctrl+z", "cmd+z"],
    ["kratos.mesh.redo", "ctrl+shift+z", "cmd+shift+z"],
  ] as const) {
    const kb = byCommand.get(cmd);
    assert.ok(kb, `${cmd} has a keybinding`);
    assert.equal(kb.key, key);
    assert.equal(kb.mac, mac);
  }
});

test("the custom editors still own the view ids every `when` clause names", () => {
  const declared = (contributes.customEditors as any[]).map((e) => e.viewType);
  for (const vt of VIEW_TYPES) {
    assert.ok(declared.includes(vt), `${vt} is contributed as a custom editor`);
  }
});
