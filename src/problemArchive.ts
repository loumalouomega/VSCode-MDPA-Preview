/**
 * Host-side handlers for File ▸ Save problem… / Load problem…: bundle the whole
 * problem setup — the mesh file, the edit-history recipe, the saved case state
 * and the generated problemtype files — into one zip, and restore it again.
 * The pure archive format lives in src/parser/problemZip.ts; this module owns
 * the dialogs, disk I/O and the pending-ops hand-off to the preview panel that
 * opens the extracted mesh.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { OpRecord, serializeOps, parseOpsJson } from "./parser/operations";
import {
  PROBLEM_MANIFEST_NAME,
  buildProblemZip,
  parseProblemZip,
  isSafeEntryName,
} from "./parser/problemZip";
import { collectProblemFiles } from "./problemFiles";

const MDPA_VIEW_TYPE = "kratos.mdpaPreview";
const VTK_VIEW_TYPE = "kratos.vtkPreview";

// ---- Pending ops hand-off -----------------------------------------------------

/**
 * Ops recipes waiting for the preview panel of a just-extracted mesh: Load
 * problem registers here, the provider consumes after its first parse
 * (`takePendingOps` right after `history.setBase`).
 */
const pendingOps = new Map<string, OpRecord[]>();

export function registerPendingOps(meshFsPath: string, ops: OpRecord[]): void {
  pendingOps.set(path.resolve(meshFsPath), ops);
}

/** Removes and returns the pending recipe for this mesh, if any (one-shot). */
export function takePendingOps(meshFsPath: string): OpRecord[] | undefined {
  const key = path.resolve(meshFsPath);
  const ops = pendingOps.get(key);
  if (ops) pendingOps.delete(key);
  return ops;
}

// ---- Save problem ---------------------------------------------------------------

/** What the provider hands over: its mesh file and the applied edit ops. */
export interface ProblemContext {
  fsPath: string;
  ops: OpRecord[];
}

/**
 * Save problem… — zips the mesh file (pristine bytes from disk; the edits ride
 * along as the ops recipe), `<stem>.kratoscase.json` and whichever generated
 * case files exist next to the mesh (ProjectParameters.json, the materials
 * file(s) it references, MainKratos.py, `<stem>_case.mdpa`).
 */
export async function saveProblem(ctx: ProblemContext): Promise<void> {
  const dir = path.dirname(ctx.fsPath);
  const meshName = path.basename(ctx.fsPath);
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));

  let files, manifest;
  try {
    const opsJson = ctx.ops.length > 0 ? serializeOps(ctx.ops, meshName) : undefined;
    ({ files, manifest } = await collectProblemFiles(ctx.fsPath, opsJson));
  } catch (err) {
    vscode.window.showErrorMessage(
      `Cannot read ${meshName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, `${stem}.kratosproblem.zip`)),
    filters: { "Problem archive": ["zip"] },
    title: "Save Problem",
  });
  if (!dest) return;
  try {
    await fs.promises.writeFile(dest.fsPath, buildProblemZip(manifest, files));
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not write the archive: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  vscode.window.showInformationMessage(
    `Saved problem (${files.length} file(s)) to ${path.basename(dest.fsPath)}.`
  );
}

// ---- Load problem ---------------------------------------------------------------

/**
 * Load problem… — picks a zip, extracts it into a chosen folder (overwrite is
 * confirmed; unsafe entry names are skipped) and opens the contained mesh in
 * the matching preview. The ops recipe is registered as pending so the new
 * panel replays the edits, and the case state is restored by the panel's own
 * `<stem>.kratoscase.json` loading.
 */
/**
 * Load problem… — extract an archive and open its mesh. Returns the opened uri
 * (undefined if cancelled or refused) so the standalone empty panel can close
 * itself once the real preview is up.
 */
export async function loadProblem(): Promise<vscode.Uri | undefined> {
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Problem archive": ["zip"], "All files": ["*"] },
    title: "Load Problem",
  });
  if (!picks || picks.length === 0) return;
  const zipPath = picks[0].fsPath;

  let parsed;
  try {
    parsed = parseProblemZip(await fs.promises.readFile(zipPath));
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not read the archive: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  for (const w of parsed.warnings) vscode.window.showWarningMessage(w);
  if (!parsed.mesh) {
    vscode.window.showErrorMessage("The archive contains no mesh file to open.");
    return;
  }

  const destPick = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: false,
    canSelectFolders: true,
    defaultUri: vscode.Uri.file(path.dirname(zipPath)),
    openLabel: "Extract Here",
    title: "Choose the Folder to Extract the Problem Into",
  });
  if (!destPick || destPick.length === 0) return;
  const destDir = destPick[0].fsPath;

  // The manifest is archive metadata, not a problem file — don't extract it.
  const toWrite = parsed.entries.filter(
    (e) => e.name !== PROBLEM_MANIFEST_NAME && !e.name.endsWith("/")
  );
  const unsafe = toWrite.filter((e) => !isSafeEntryName(e.name));
  if (unsafe.length > 0) {
    vscode.window.showWarningMessage(
      `Skipping ${unsafe.length} entr${unsafe.length === 1 ? "y" : "ies"} with unsafe path(s): ` +
        unsafe.map((e) => e.name).slice(0, 3).join(", ")
    );
  }
  const safe = toWrite.filter((e) => isSafeEntryName(e.name));
  if (safe.length === 0) {
    vscode.window.showErrorMessage("The archive contains no extractable files.");
    return;
  }

  const existing = safe.filter((e) => fs.existsSync(path.join(destDir, e.name)));
  if (existing.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${existing.length} file(s) already exist in ${path.basename(destDir) || destDir} ` +
        `(e.g. ${existing[0].name}). Overwrite them?`,
      { modal: true },
      "Overwrite"
    );
    if (choice !== "Overwrite") return;
  }

  try {
    for (const entry of safe) {
      const target = path.join(destDir, entry.name);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, entry.data);
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Extraction failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const meshFsPath = path.join(destDir, parsed.mesh);
  if (parsed.ops) {
    const opsEntry = safe.find((e) => e.name === parsed.ops);
    if (opsEntry) {
      const { operations, warnings } = parseOpsJson(Buffer.from(opsEntry.data).toString("utf8"));
      for (const w of warnings) vscode.window.showWarningMessage(w);
      if (operations.length > 0) registerPendingOps(meshFsPath, operations);
    }
  }

  const ext = path.extname(parsed.mesh).toLowerCase();
  const viewType = ext === ".mdpa" ? MDPA_VIEW_TYPE : VTK_VIEW_TYPE;
  const meshUri = vscode.Uri.file(meshFsPath);
  await vscode.commands.executeCommand("vscode.openWith", meshUri, viewType);
  vscode.window.showInformationMessage(
    `Loaded problem: extracted ${safe.length} file(s) to ${destDir}.`
  );
  return meshUri;
}
