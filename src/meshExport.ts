/**
 * Shared host-side handlers for the File (Home) menu: Open, Save, Save As and
 * Export.  Both custom-editor providers delegate their `menu*` webview messages
 * here.  All serialization runs through the writer layer in
 * `parser/writers/meshWriter.ts`; file I/O uses the same showSaveDialog pattern
 * as the screenshot feature.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { MdpaModel } from "./parser/types";
import { SUPPORTED_MESH_EXTENSIONS } from "./parser/meshFormats";
import {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
  ExportableExtension,
  isExportableExtension,
  writeMeshFile,
} from "./parser/writers/meshWriter";

const MDPA_VIEW_TYPE = "kratos.mdpaPreview";
const VTK_VIEW_TYPE = "kratos.vtkPreview";
const OVERWRITE_WARNED_KEY = "meshExportOverwriteWarned";

/** The parsed mesh a provider currently has loaded, plus its origin on disk. */
export interface ExportContext {
  model: MdpaModel;
  fsPath: string;
  /** Original .mdpa text (MDPA provider only) so Properties survive a re-write. */
  sourceText?: string;
}

/** A File-menu action sent by the webview or a Command-Palette command. */
export interface MenuMessage {
  type: "menuOpen" | "menuSave" | "menuSaveAs" | "menuExport";
  format?: string;
}

/**
 * Routes a File-menu message to the right handler.  `getCtx` supplies the
 * loaded mesh (only needed for save/export); it may warn and return undefined
 * while a mesh is still loading.
 */
export async function runMenu(
  msg: MenuMessage,
  getCtx: () => ExportContext | undefined,
  extContext: vscode.ExtensionContext
): Promise<void> {
  if (msg.type === "menuOpen") {
    await openMesh();
    return;
  }
  const ctx = getCtx();
  if (!ctx) return;
  if (msg.type === "menuSave") await saveMesh(ctx, extContext);
  else if (msg.type === "menuSaveAs") await saveMeshAs(ctx);
  else if (msg.type === "menuExport") await exportMesh(ctx, msg.format ?? "");
}

/** Save-dialog filter for one exportable format, e.g. { "STL": ["stl"] }. */
function filterFor(ext: ExportableExtension): Record<string, string[]> {
  return { [EXPORT_FORMAT_LABELS[ext]]: [ext.slice(1)] };
}

async function serializeToPath(
  ctx: ExportContext,
  destFsPath: string,
  ext: ExportableExtension
): Promise<void> {
  const name = path.basename(destFsPath, path.extname(destFsPath));
  const text = writeMeshFile(ctx.model, ext, { name, sourceText: ctx.sourceText });
  await fs.promises.writeFile(destFsPath, text, "utf8");
  vscode.window.showInformationMessage(`Saved ${path.basename(destFsPath)}.`);
}

/** Open… — pick any supported mesh file and open it in the matching preview. */
export async function openMesh(): Promise<void> {
  const meshExts = SUPPORTED_MESH_EXTENSIONS.map((e) => e.slice(1));
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: {
      "Mesh files": ["mdpa", ...meshExts],
      "All files": ["*"],
    },
    title: "Open Mesh File",
  });
  if (!picks || picks.length === 0) return;
  const uri = picks[0];
  const ext = path.extname(uri.fsPath).toLowerCase();
  const viewType = ext === ".mdpa" ? MDPA_VIEW_TYPE : VTK_VIEW_TYPE;
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
}

/** Save — re-serialize to the source's own format and overwrite it in place. */
export async function saveMesh(
  ctx: ExportContext,
  extContext: vscode.ExtensionContext
): Promise<void> {
  const ext = path.extname(ctx.fsPath).toLowerCase();
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(
      `Saving in "${ext}" format is not supported. Use Export instead.`
    );
    return;
  }

  if (!extContext.globalState.get<boolean>(OVERWRITE_WARNED_KEY)) {
    const choice = await vscode.window.showWarningMessage(
      `Overwrite ${path.basename(ctx.fsPath)}? Re-writing the mesh may drop ` +
        `comments and formatting the preview does not retain.`,
      { modal: true },
      "Overwrite"
    );
    if (choice !== "Overwrite") return;
    await extContext.globalState.update(OVERWRITE_WARNED_KEY, true);
  }

  await serializeToPath(ctx, ctx.fsPath, ext);
}

/** Save As… — write the source format to a user-chosen path. */
export async function saveMeshAs(ctx: ExportContext): Promise<void> {
  const ext = path.extname(ctx.fsPath).toLowerCase();
  const targetExt: ExportableExtension = isExportableExtension(ext) ? ext : ".vtu";
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}${targetExt}`)),
    filters: filterFor(targetExt),
    title: "Save Mesh As",
  });
  if (!dest) return;
  await serializeToPath(ctx, dest.fsPath, targetExt);
}

/** Export — write the mesh to a chosen target format. */
export async function exportMesh(ctx: ExportContext, targetExt: string): Promise<void> {
  const ext = targetExt.toLowerCase();
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(`Cannot export to "${targetExt}".`);
    return;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}${ext}`)),
    filters: filterFor(ext),
    title: `Export as ${EXPORT_FORMAT_LABELS[ext]}`,
  });
  if (!dest) return;
  await serializeToPath(ctx, dest.fsPath, ext);
}

/** The exportable formats, for building the Export submenu / quick pick. */
export function exportFormats(): { ext: ExportableExtension; label: string }[] {
  return EXPORTABLE_EXTENSIONS.map((ext) => ({ ext, label: EXPORT_FORMAT_LABELS[ext] }));
}
