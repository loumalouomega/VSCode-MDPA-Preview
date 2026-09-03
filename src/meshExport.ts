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
import { once } from "node:events";
import { MdpaModel } from "./parser/types";
import { meshExtname, meshStem, SUPPORTED_MESH_EXTENSIONS } from "./parser/meshFormats";
import {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FORMAT_LABELS,
  ExportableExtension,
  isExportableExtension,
  writeMeshFileAsync,
} from "./parser/writers/meshWriter";
import { extractSubModelPart } from "./parser/subModelPartExtract";
import { extractSkinModel } from "./parser/extractSkin";
import {
  TABLE_KINDS,
  TableOptions,
  csvChunks,
  isTableKind,
  prepareTable,
} from "./parser/dataTable";
import { buildMembershipIndex } from "./parser/smpMembership";
import { writeXlsx } from "./parser/writers/xlsxWriter";
import { OpRecord } from "./parser/operations";
import { saveProblem, loadProblem } from "./problemArchive";

const MDPA_VIEW_TYPE = "kratos.mdpaPreview";
const VTK_VIEW_TYPE = "kratos.vtkPreview";
const OVERWRITE_WARNED_KEY = "meshExportOverwriteWarned";

/** The parsed mesh a provider currently has loaded, plus its origin on disk. */
export interface ExportContext {
  model: MdpaModel;
  fsPath: string;
  /** Original .mdpa text (MDPA provider only) so Properties survive a re-write. */
  sourceText?: string;
  /** The applied edit ops, bundled into a Save-problem archive as the recipe. */
  ops?: OpRecord[];
}

/** A File-menu action sent by the webview or a Command-Palette command. */
export interface MenuMessage {
  type:
    | "menuOpen"
    | "menuSave"
    | "menuSaveAs"
    | "menuExport"
    | "menuExportPart"
    | "menuExportSkin"
    | "menuExportTable"
    | "menuExportSeries"
    | "menuSaveProblem"
    | "menuLoadProblem";
  format?: string;
  /** Dotted `SubModelPart.path` to export (menuExportPart only). */
  path?: string;
  /** Which entity kind to tabulate (menuExportTable only). */
  kind?: string;
  /** A finished CSV the webview already holds (menuExportSeries only). */
  csv?: string;
  /** Appended to the mesh stem for the default filename (menuExportSeries). */
  suffix?: string;
  /**
   * The table panel's own options (menuExportTable only). They ride the
   * message rather than being re-derived here, so the file the host writes is
   * built by the same `prepareTable` call as the table on screen.
   */
  opts?: TableOptions;
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
  if (msg.type === "menuLoadProblem") {
    await loadProblem();
    return;
  }
  const ctx = getCtx();
  if (!ctx) return;
  if (msg.type === "menuSave") await saveMesh(ctx, extContext);
  else if (msg.type === "menuSaveAs") await saveMeshAs(ctx);
  else if (msg.type === "menuExport") await exportMesh(ctx, msg.format ?? "");
  else if (msg.type === "menuExportPart")
    await exportSubModelPart(ctx, msg.format ?? "", msg.path ?? "");
  else if (msg.type === "menuExportSkin") await exportSkin(ctx, msg.format ?? "");
  else if (msg.type === "menuExportTable")
    await exportDataTable(ctx, msg.kind ?? "Nodes", msg.format, msg.opts);
  else if (msg.type === "menuExportSeries")
    await exportSeriesCsv(ctx, msg.csv ?? "", msg.suffix ?? "series");
  else if (msg.type === "menuSaveProblem")
    await saveProblem({ fsPath: ctx.fsPath, ops: ctx.ops ?? [] });
}

/** Save-dialog filter for one exportable format, e.g. { "STL": ["stl"] }. */
function filterFor(ext: ExportableExtension): Record<string, string[]> {
  return { [EXPORT_FORMAT_LABELS[ext]]: [ext.slice(1)] };
}

async function serializeModelToPath(
  model: MdpaModel,
  destFsPath: string,
  ext: ExportableExtension,
  sourceText?: string
): Promise<void> {
  const name = meshStem(destFsPath);
  // The writer reports things it could not guarantee about the file it is about
  // to produce (today: verbatim Constraints copied onto renumbered nodes). They
  // are advisory — the write still happens and is still better than the silent
  // omission it replaced — so they are collected and shown after the success
  // message rather than turned into a failure.
  const warnings: string[] = [];
  const { data, companions } = await writeMeshFileAsync(model, ext, {
    name,
    sourceText,
    onWarning: (m) => warnings.push(m),
  });
  // No encoding argument: strings still default to utf8, while the meshio++
  // formats' Uint8Array (gmsh 4.1 and ansys are binary) is written raw.
  await fs.promises.writeFile(destFsPath, data);
  // XDMF keeps its heavy arrays in a companion .h5 and references it by name,
  // so the main file is unreadable without it; OpenFOAM goes further and puts
  // the WHOLE mesh in a constant/polyMesh/ tree beside a 0-byte marker. A
  // companion name is therefore a relative path, and its folders may not exist.
  const dir = path.dirname(destFsPath);
  for (const c of companions) {
    const dest = path.join(dir, c.name);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, c.data);
  }
  const written = [path.basename(destFsPath), ...companions.map((c) => c.name)];
  vscode.window.showInformationMessage(`Saved ${written.join(" + ")}.`);
  for (const w of warnings) vscode.window.showWarningMessage(w);
}

function serializeToPath(
  ctx: ExportContext,
  destFsPath: string,
  ext: ExportableExtension
): Promise<void> {
  return serializeModelToPath(ctx.model, destFsPath, ext, ctx.sourceText);
}

/**
 * Picks mesh files without opening them — the file-choosing half of every
 * sidebar form that needs a SECOND mesh to hand to an operation rather than a
 * new preview panel: "Merge mesh…", "Distance to surface…" and "Transfer
 * fields…".
 *
 * `multi` is what distinguishes them. `mergeMesh` merges N files in one
 * operation (one pass of id offsetting, one weld across every seam) rather than
 * N repeats of a binary merge, so it selects many; the two field ops take
 * exactly one other mesh, so offering multi-select there would let a user pick
 * three files and silently use one.
 */
export async function pickMergeMeshFile(
  multi = true,
  title = "Merge Mesh Files"
): Promise<string[] | undefined> {
  const meshExts = SUPPORTED_MESH_EXTENSIONS.map((e) => e.slice(1));
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: multi,
    filters: {
      "Mesh files": ["mdpa", ...meshExts],
      "All files": ["*"],
    },
    title,
  });
  return picks && picks.length > 0 ? picks.map((u) => u.fsPath) : undefined;
}

/** Dialog title + multi-select policy per requesting sidebar form. */
export const MESH_PICK_TARGETS: Record<string, { title: string; multi: boolean }> = {
  mergeMesh: { title: "Merge Mesh Files", multi: true },
  sdfDistance: { title: "Select Surface Mesh", multi: false },
  transferField: { title: "Select Source Mesh", multi: false },
};

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
  const ext = meshExtname(uri.fsPath);
  const viewType = ext === ".mdpa" ? MDPA_VIEW_TYPE : VTK_VIEW_TYPE;
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
}

/** Save — re-serialize to the source's own format and overwrite it in place. */
export async function saveMesh(
  ctx: ExportContext,
  extContext: vscode.ExtensionContext
): Promise<void> {
  const ext = meshExtname(ctx.fsPath);
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
  const ext = meshExtname(ctx.fsPath);
  const targetExt: ExportableExtension = isExportableExtension(ext) ? ext : ".vtu";
  const stem = meshStem(ctx.fsPath);
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

/** Export one SubModelPart (and its subtree) as an independent mesh file. */
export async function exportSubModelPart(
  ctx: ExportContext,
  targetExt: string,
  partPath: string
): Promise<void> {
  const ext = targetExt.toLowerCase();
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(`Cannot export to "${targetExt}".`);
    return;
  }
  const sub = extractSubModelPart(ctx.model, partPath);
  if (!sub) {
    vscode.window.showWarningMessage(`SubModelPart "${partPath}" not found.`);
    return;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  // Use the part's leaf name for the suggested file, sanitised for the filesystem.
  const leaf = partPath.split("/").pop() || partPath;
  const safe = leaf.replace(/[^\w.-]+/g, "_");
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(ctx.fsPath), `${stem}_${safe}${ext}`)
    ),
    filters: filterFor(ext),
    title: `Export SubModelPart "${leaf}" as ${EXPORT_FORMAT_LABELS[ext]}`,
  });
  if (!dest) return;
  await serializeModelToPath(sub, dest.fsPath, ext, ctx.sourceText);
}

/**
 * Export the boundary skin of the volume cells (plus any pre-existing surface
 * cells) as an independent mesh file. A new geometry with its own ids — like
 * `exportSubModelPart`, not an edit of the open model, so there is nothing to
 * undo and nothing added to the operation history.
 */
export async function exportSkin(ctx: ExportContext, targetExt?: string): Promise<void> {
  let ext = targetExt?.toLowerCase();
  if (!ext) {
    // Reached from the Advanced menu with no pre-chosen format (unlike the
    // File ▸ Export list, this action has no dropdown of its own) — ask via
    // a native quick pick rather than inventing another webview dropdown.
    const pick = await vscode.window.showQuickPick(
      exportFormats().map(({ ext: e, label }) => ({ label, description: e })),
      { title: "Export Skin — choose a format", placeHolder: "Format" }
    );
    if (!pick) return;
    ext = pick.description;
  }
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(`Cannot export to "${targetExt}".`);
    return;
  }
  const { model: skin, faces } = extractSkinModel(ctx.model);
  if (faces === 0) {
    vscode.window.showWarningMessage("No surface or volume cells to take a skin from.");
    return;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_skin${ext}`)),
    filters: filterFor(ext),
    title: `Export Skin as ${EXPORT_FORMAT_LABELS[ext]}`,
  });
  if (!dest) return;
  // Deliberately no `sourceText`: the skin is new geometry with fresh entity
  // ids, so the original file's Properties/Table blocks do not apply to it.
  await serializeModelToPath(skin, dest.fsPath, ext);
}

/**
 * Save a time-series CSV the webview built.
 *
 * The opposite direction from `exportDataTable`, and deliberately so: a table
 * is rebuilt here because a real mesh's CSV is hundreds of megabytes and has
 * no business crossing postMessage, whereas a series is a few hundred numbers
 * the webview already holds — and rebuilding it here would mean re-running the
 * whole multi-file scan that produced it.
 */
export async function exportSeriesCsv(
  ctx: ExportContext,
  csv: string,
  suffix: string
): Promise<void> {
  if (!csv) {
    vscode.window.showWarningMessage("Nothing to export — the series is empty.");
    return;
  }
  const stem = meshStem(ctx.fsPath);
  // A variable name reaches the filename, so anything a path separator could
  // read as a directory is flattened first.
  const safe = suffix.replace(/[^\w.-]+/g, "_");
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_${safe}.csv`)),
    filters: { CSV: ["csv"] },
    title: "Export Time Series as CSV",
  });
  if (!dest) return;
  try {
    await fs.promises.writeFile(dest.fsPath, csv, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not write ${path.basename(dest.fsPath)}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  vscode.window.showInformationMessage(`Saved ${path.basename(dest.fsPath)}.`);
}

/** Above this, a table is big enough that the user should be told before the
 *  write starts rather than after it has run for a minute. */
const TABLE_CONFIRM_ROWS = 2_000_000;

const TABLE_FORMAT_LABELS: Record<string, string> = {
  ".csv": "CSV",
  ".xlsx": "Excel Workbook",
};

/**
 * Export the data table — every node/element/condition/geometry as rows of
 * plain values — as CSV or XLSX.
 *
 * It does NOT go through `serializeModelToPath`: that routes to the mesh
 * writer layer, which knows only mesh formats and would reject a `.csv`
 * outright. It also does not receive the rows from the webview — the panel
 * sends its `kind` and its options and the host rebuilds the same table from
 * its own model, because a real mesh's CSV is hundreds of megabytes and has no
 * business crossing postMessage.
 */
export async function exportDataTable(
  ctx: ExportContext,
  kind: string,
  format?: string,
  opts: TableOptions = {}
): Promise<void> {
  if (!isTableKind(kind)) {
    vscode.window.showWarningMessage(
      `Unknown table kind "${kind}". Expected one of ${TABLE_KINDS.join(", ")}.`
    );
    return;
  }
  let ext = (format ?? "").toLowerCase();
  if (!ext) {
    const pick = await vscode.window.showQuickPick(
      Object.entries(TABLE_FORMAT_LABELS).map(([e, label]) => ({ label, description: e })),
      { title: `Export ${kind} Table — choose a format`, placeHolder: "Format" }
    );
    if (!pick) return;
    ext = pick.description;
  }
  if (!TABLE_FORMAT_LABELS[ext]) {
    vscode.window.showWarningMessage(`Cannot export a table as "${ext}".`);
    return;
  }

  const view = prepareTable(
    ctx.model,
    kind,
    opts,
    opts.membership ? buildMembershipIndex(ctx.model.subModelParts) : undefined
  );
  if (view.rowCount === 0) {
    vscode.window.showWarningMessage(`This mesh has no ${kind.toLowerCase()} to export.`);
    return;
  }
  if (view.rowCount > TABLE_CONFIRM_ROWS) {
    const choice = await vscode.window.showWarningMessage(
      `Export ${view.rowCount.toLocaleString()} rows x ${view.columns.length} columns? ` +
        `This may take a while and produce a very large file.`,
      { modal: true },
      "Export"
    );
    if (choice !== "Export") return;
  }

  const stem = meshStem(ctx.fsPath);
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(ctx.fsPath), `${stem}_${kind.toLowerCase()}${ext}`)
    ),
    filters: { [TABLE_FORMAT_LABELS[ext]]: [ext.slice(1)] },
    title: `Export ${kind} Table as ${TABLE_FORMAT_LABELS[ext]}`,
  });
  if (!dest) return;

  try {
    if (ext === ".xlsx") {
      const result = writeXlsx(view, kind);
      await fs.promises.writeFile(dest.fsPath, result.data);
      if (result.truncated > 0) {
        vscode.window.showWarningMessage(
          `A worksheet holds ${result.rows.toLocaleString()} rows, so ` +
            `${result.truncated.toLocaleString()} were left out. Export as CSV for the whole table.`
        );
      }
    } else {
      await writeCsvStream(view, dest.fsPath);
    }
  } catch (err) {
    // A partial file is worse than none: it looks like a complete export.
    await fs.promises.rm(dest.fsPath, { force: true }).catch(() => undefined);
    vscode.window.showErrorMessage(
      `Could not write ${path.basename(dest.fsPath)}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  vscode.window.showInformationMessage(
    `Saved ${path.basename(dest.fsPath)} (${view.rowCount.toLocaleString()} rows).`
  );
}

/** Streamed so a multi-million-row table never becomes one giant string —
 *  which past a gigabyte it cannot be, V8's maximum string length being the
 *  hard stop. */
async function writeCsvStream(view: ReturnType<typeof prepareTable>, destFsPath: string): Promise<void> {
  const out = fs.createWriteStream(destFsPath, { encoding: "utf8" });
  try {
    for (const chunk of csvChunks(view)) {
      // `events.once` removes BOTH of its listeners when it settles. Attaching
      // a drain and an error handler by hand instead leaks one error listener
      // per backpressure pause, which a large table hits within a few
      // megabytes — Node warns about it at ten.
      if (!out.write(chunk)) await once(out, "drain");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once("error", reject);
    });
  }
}

/** The exportable formats, for building the Export submenu / quick pick. */
export function exportFormats(): { ext: ExportableExtension; label: string }[] {
  return EXPORTABLE_EXTENSIONS.map((ext) => ({ ext, label: EXPORT_FORMAT_LABELS[ext] }));
}
