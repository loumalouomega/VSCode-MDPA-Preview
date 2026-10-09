/**
 * The viewer batch command (roadmap item 5): `kratos.mesh.batchTransform`.
 *
 * The palette/queue counterpart of MCP `mesh_batch_transform`, over the same
 * pure core (`src/parser/batchPlan.ts`) and the same load/apply/write
 * pipeline (`loadMesh`/`applyRecipeToModel`/`writeModelReported` from
 * `mcp/tools.ts`, which is vscode-free). Everything interactive goes through
 * native dialogs and one progress notification — batch execution stays
 * explicit and never runs during timeline scrubbing.
 *
 * Recipe sources: a recipe file, a named preset (`.kratos/recipes`, the
 * `kratos.recipes.extraPaths` setting), or a saved `kkss-batch.json` resume.
 * A plan that refuses shows every reason; a plan that only meets existing
 * outputs offers an overwrite retry. Cancellation is between files (roadmap
 * item 5's mid-file abort is a separate increment).
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyRecipeToModel,
  loadMesh,
  saveBatchManifestAtomic,
  stampOfPath,
  writeModelReported,
} from "./mcp/tools";
import {
  BATCH_MANIFEST_NAME,
  BatchEntry,
  BatchManifest,
  DEFAULT_BATCH_NAMING,
  parseBatchManifest,
  planBatch,
  recipeHash,
  runBatch,
} from "./parser/batchPlan";
import { parseOpsJson } from "./parser/operations";
import { SUPPORTED_MESH_EXTENSIONS } from "./parser/meshFormats";
import { EXPORTABLE_EXTENSIONS } from "./parser/writers/exportFormats";
import { DEFAULT_BATCH_NAMING } from "./parser/batchPlan";
import {
  DEFAULT_RECIPE_PRESET_PATHS,
  discoverRecipePresets,
} from "./recipePresetLibrary";
import { RecipePreset } from "./parser/recipePresets";

const MESH_FILTER = ["mdpa", ...SUPPORTED_MESH_EXTENSIONS.map((e) => e.slice(1))];

async function pickInputs(): Promise<string[] | undefined> {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { "Mesh files": MESH_FILTER, "All files": ["*"] },
    title: "Batch Inputs (Mesh Files)",
  });
  if (!picks || picks.length === 0) return undefined;
  return picks.map((p) => p.fsPath);
}

async function pickRecipe(): Promise<{ raw: unknown[]; recipeName: string; preset?: RecipePreset } | undefined> {
  const source = await vscode.window.showQuickPick(
    [
      { label: "Recipe file…", detail: "A saved operations recipe (.ops.json)", source: "file" },
      { label: "Preset…", detail: "A named preset from .kratos/recipes", source: "preset" },
    ],
    { placeHolder: "Batch recipe source" }
  );
  if (!source) return undefined;
  if (source.source === "file") {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Operation recipe": ["json"], "All files": ["*"] },
      title: "Batch Recipe File",
    });
    if (!picks || picks.length === 0) return undefined;
    let text: string;
    try {
      text = await fs.promises.readFile(picks[0].fsPath, "utf8");
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read recipe: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const parsed = parseOpsJson(text);
    for (const w of parsed.warnings) vscode.window.showWarningMessage(w);
    if (parsed.operations.length === 0) {
      vscode.window.showWarningMessage("Recipe contained no usable operations.");
      return undefined;
    }
    return {
      raw: parsed.operations,
      recipeName: path.basename(picks[0].fsPath).replace(/\.ops\.json$|\.json$/i, ""),
    };
  }
  const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const extra =
    vscode.workspace.getConfiguration("kratos").get<string[]>("recipes.extraPaths", DEFAULT_RECIPE_PRESET_PATHS) ??
    DEFAULT_RECIPE_PRESET_PATHS;
  const found = discoverRecipePresets(roots, extra);
  for (const p of found.problems) vscode.window.showWarningMessage(`${p.file}: ${p.message}`);
  if (found.presets.length === 0) {
    vscode.window.showWarningMessage(
      "No recipe presets found. Save JSON presets under .kratos/recipes (see the kratos.recipes.extraPaths setting)."
    );
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    found.presets.map((p) => ({
      label: p.name,
      description: p.file,
      detail: p.description ?? `${p.ops.length} operation(s)`,
      preset: p,
    })),
    { placeHolder: "Batch recipe preset" }
  );
  if (!pick) return undefined;
  return { raw: pick.preset.ops, recipeName: pick.preset.name, preset: pick.preset };
}

export async function runBatchCommand(): Promise<void> {
  const inputs = await pickInputs();
  if (!inputs) return;
  const recipe = await pickRecipe();
  if (!recipe) return;
  const outputUri = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: "Batch Output Directory",
  });
  if (!outputUri || outputUri.length === 0) return;
  const outputDir = outputUri[0].fsPath;
  const naming =
    (await vscode.window.showInputBox({
      value: recipe.preset?.naming ?? DEFAULT_BATCH_NAMING,
      prompt: "Output name template ({stem} {recipe} {index} {ext})",
    })) ??
    recipe.preset?.naming ??
    DEFAULT_BATCH_NAMING;
  const extPick = await vscode.window.showQuickPick(["Keep each input's format", ...EXPORTABLE_EXTENSIONS], {
    placeHolder: "Output format",
  });
  if (!extPick) return;
  const outputExt = extPick === "Keep each input's format" ? undefined : extPick;
  const recipeName = recipe.recipeName;
  const hash = recipeHash(JSON.stringify(recipe.raw));

  let resume: BatchManifest | undefined;
  const manifestPath = path.join(outputDir, BATCH_MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) {
    const action = await vscode.window.showQuickPick(["Resume previous batch", "Start fresh"], {
      placeHolder: `${BATCH_MANIFEST_NAME} already exists here`,
    });
    if (!action) return;
    if (action === "Resume previous batch") {
      const parsed = parseBatchManifest(fs.readFileSync(manifestPath, "utf8"));
      for (const w of parsed.warnings) vscode.window.showWarningMessage(w);
      resume = parsed.manifest;
    }
  }

  const run = async (overwrite: boolean) =>
    planBatch({ inputs, outputDir, recipeName, naming, outputExt, overwrite, exists: (p) => fs.existsSync(p) });
  let planned = await run(recipe.preset?.overwrite ?? false);
  if (planned.problems.length > 0) {
    const existsOnly = planned.problems.every((p) => /already exists/.test(p));
    if (existsOnly && !(recipe.preset?.overwrite ?? false)) {
      const retry = await vscode.window.showErrorMessage(
        `Batch refused — ${planned.problems.length} output(s) already exist.`,
        { modal: true, detail: planned.problems.slice(0, 10).join("\n") },
        "Overwrite and run"
      );
      if (retry !== "Overwrite and run") return;
      planned = await run(true);
    }
    if (planned.problems.length > 0) {
      await vscode.window.showErrorMessage("Batch refused, nothing written.", {
        modal: true,
        detail: planned.problems.slice(0, 20).join("\n"),
      });
      return;
    }
  }

  const preview = planned.entries.slice(0, 10).map((e) => path.basename(e.output));
  const go = await vscode.window.showInformationMessage(
    `Run batch "${recipeName}" on ${planned.entries.length} file(s) into ${outputDir}?`,
    { modal: true, detail: [...preview, planned.entries.length > 10 ? `…and ${planned.entries.length - 10} more` : ""].filter(Boolean).join("\n") },
    "Run"
  );
  if (go !== "Run") return;

  await fs.promises.mkdir(outputDir, { recursive: true });
  const abort = new AbortController();
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Batch "${recipeName}"`, cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      return runBatch(
        planned.entries,
        {
          stampOf: stampOfPath,
          save: (m) => saveBatchManifestAtomic(manifestPath, m),
          process: async (entry, signal) => {
            const src = await loadMesh(entry.input);
            const applied = await applyRecipeToModel(src.model, recipe.raw, signal);
            const w: string[] = [];
            const { report } = await writeModelReported(applied.model, entry.output, src.sourceText, undefined, w, {
              sourceFile: entry.input,
              ops: applied.operations,
            });
            const lossy = report.warnings?.length ?? w.length;
            return {
              report,
              message: `${applied.outcomes.length} op(s) applied${lossy ? `, ${lossy} writer warning(s)` : ""}`,
            };
          },
        },
        {
          recipeName,
          recipeHash: hash,
          signal: abort.signal,
          resume,
          onProgress: (d, t, e) => progress.report({ message: `File ${d}/${t}: ${path.basename(e.input)}`, increment: 100 / t }),
        }
      );
    }
  );
  const summary =
    `Batch "${recipeName}": ${result.done} done, ${result.failed} failed, ${result.skipped} skipped` +
    (result.cancelled ? " (cancelled)" : "") +
    (result.resumeNote ? ` — ${result.resumeNote}` : "");
  if (result.failed > 0 && !result.cancelled) {
    const open = await vscode.window.showWarningMessage(summary, "Open manifest");
    if (open === "Open manifest") void vscode.workspace.openTextDocument(manifestPath).then((d) => vscode.window.showTextDocument(d));
  } else if (result.cancelled) {
    vscode.window.showWarningMessage(summary);
  } else {
    const open = await vscode.window.showInformationMessage(summary, "Open manifest");
    if (open === "Open manifest") void vscode.workspace.openTextDocument(manifestPath).then((d) => vscode.window.showTextDocument(d));
  }
}
