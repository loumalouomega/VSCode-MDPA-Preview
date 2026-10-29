import { assertFreshElmerDestination } from "./parser/caeFiles";
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
import { resolveCommandPath, overwriteRefusal } from "./parser/commandPath";
import { once } from "node:events";
import { MdpaModel } from "./parser/types";
import { meshExtname, meshStem, SUPPORTED_MESH_EXTENSIONS } from "./parser/meshFormats";
import type { FitCadOptions } from "@meshioplusplus/wasm";
import { wouldOverwriteOpenFoamCase } from "./parser/openfoamCase";
import {
  applyInPlacePlan,
  describeInPlaceRefusals,
  planOpenFoamInPlaceSave,
  refuseWriteIntoSourceCase,
} from "./parser/openfoamOwnership";
import { exportEligibility } from "./parser/writers/exportEligibility";
import {
  EXPORTABLE_EXTENSIONS,
  EXPORT_FLAVOUR_LABELS,
  EXPORT_FORMAT_FLAVOURS,
  EXPORT_FORMAT_LABELS,
  ExportableExtension,
  isExportableExtension,
  writeMeshFileAsync,
} from "./parser/writers/meshWriter";
import { extractSubModelPart } from "./parser/subModelPartExtract";
import { restrictToCells } from "./parser/selectCells";
import { extractSkinModel } from "./parser/extractSkin";
import { deriveMesh, DeriveSpec, DeriveResult, DERIVE_KINDS, recordedDeriveParameters } from "./parser/deriveMesh";
import { isCurvedCellType, TESSELLATE_MAX_LEVELS } from "./parser/tessellate";
import { estimateGrid, describeGridEstimate, triangleSurfaceOf, GRID_MAX_CELLS, GRID_CONFIRM_CELLS } from "./parser/gridSample";
import { GENERATOR_SHAPES, GENERATOR_EXAMPLES, GeneratorShape, estimateGeneratedCells, GENERATE_MAX_CELLS, CadSurfaceSpec, cadSurfaceOptionsFrom, validateCadSurfaceSpec } from "./parser/kernelMeshes";
import { KERNEL_OP_KINDS, KernelOpKind } from "./parser/kernelOps";
import { parseMeshFile } from "./parser/meshFileParser";
import { exportReportHtml } from "./parser/exportReportHtml";
import { writeRawMeshioBytes, meshioFullInstalled } from "./parser/meshio";
import { partitionParts, partitionManifest } from "./parser/partitionExport";
import { deriveMeshOffThread, partitionPartsOffThread } from "./parser/derivedRunner";
import { splitModel, SplitSpec } from "./parser/splitComponents";
import {
  TABLE_KINDS,
  TableOptions,
  csvChunks,
  isTableKind,
  prepareTable,
} from "./parser/dataTable";
import { buildMembershipIndex } from "./parser/smpMembership";
import { writeXlsx } from "./parser/writers/xlsxWriter";
import { OpRecord, OP_LABELS } from "./parser/operations";
import {
  ExportReport,
  ProvenanceMode,
  PROVENANCE_MODES,
  buildExportReport,
  buildUnverifiedReport,
  finalizeReport,
  provenanceRequest,
  serializeReport,
  summarizeReport,
} from "./parser/exportReport";
import { meshioPackageVersion } from "./parser/meshio";
import { isNativeExportExtension } from "./parser/writers/exportFormats";
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
  /**
   * Index of the timeline frame on screen (an OpenFOAM case's numeric time
   * directories). An in-place save writes edited fields into that directory.
   */
  timeStep?: number;
  reportSink?: (reports: ExportReport[], show: boolean) => void;
}

/** A File-menu action sent by the webview or a Command-Palette command. */
export interface MenuMessage {
  type:
    | "menuOpen"
    | "menuImport"
    | "menuSave"
    | "menuSaveAs"
    | "menuExport"
    | "menuExportPart"
    | "menuExportSkin"
    | "menuExportSkin"
  | "menuExportDerived"
  | "menuExportSelection"
    | "menuExportPartitions"
    | "menuSplitMesh"
    | "menuExportSimplified"
    | "menuExportTessellated"
    | "menuExportGrid"
    | "menuExportOctree"
    | "menuExportKernelOp"
    | "menuExportCadSurface"
    | "menuGenerateMesh"
    | "menuExportTable"
    | "menuExportSeries"
    | "menuExportAnalysis"
    | "menuSaveProblem"
    | "menuLoadProblem";
  format?: string;
  /** Command-line file arguments: skip the dialog and write/open here. */
  to?: string;
  overwrite?: boolean;
  file?: string;
  /** Command-line `loadProblem`: folder to extract into. */
  into?: string;
  /**
   * meshio++ writer key forcing an ambiguous extension's flavour — `gmsh` /
   * `ansys` / `freefem` for `.msh`, `abaqus` / `ansysinp` for `.inp`
   * (menuExport/Part/Skin only). Absent, the host asks via a QuickPick; the
   * webview never sends one today, it just forwards the field for later.
   */
  outputFormat?: string;
  /**
   * What to derive (menuExportDerived only): a slice, an isosurface or a
   * threshold region. Untrusted webview input — `deriveMesh` validates it.
   */
  derive?: DeriveSpec;
  /**
   * The ids to export (menuExportSelection only): explicit per-kind id lists
   * from the webview's selection sets. Each kind is its own id space, so the
   * three lists never merge.
   */
  selection?: { elements?: number[]; conditions?: number[]; geometries?: number[] };
  /** Dotted `SubModelPart.path` to export (menuExportPart only). */
  path?: string;
  /** Which entity kind to tabulate (menuExportTable only). */
  kind?: string;
  /** A finished CSV the webview already holds (menuExportSeries/Analysis only). */
  csv?: string;
  /** Appended to the mesh stem for the default filename (menuExportSeries/Analysis). */
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
): Promise<boolean> {
  if (msg.type === "menuOpen") {
    if (msg.file) await openMeshAt(msg.file, getCtx() ? path.dirname(getCtx()!.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    else await openMesh();
    return false;
  }
  if (msg.type === "menuLoadProblem") {
    await loadProblem({ file: msg.file, into: msg.into });
    return false;
  }
  const ctx = getCtx();
  if (!ctx) return false;
  if (msg.type === "menuSave") return saveMesh(ctx, extContext);
  else if (msg.type === "menuSaveAs") await saveMeshAs(ctx, msg.to, msg.overwrite);
  else if (msg.type === "menuExport") await exportMesh(ctx, msg.format ?? "", msg.outputFormat, msg.to, msg.overwrite);
  else if (msg.type === "menuExportPart")
    await exportSubModelPart(ctx, msg.format ?? "", msg.path ?? "", msg.outputFormat, msg.to, msg.overwrite);
  else if (msg.type === "menuExportSkin") await exportSkin(ctx, msg.format ?? "", msg.outputFormat, msg.to, msg.overwrite);
  else if (msg.type === "menuExportDerived") await exportDerived(ctx, msg.derive, msg.format, msg.outputFormat);
  else if (msg.type === "menuExportSelection") await exportSelection(ctx, msg.selection, msg.format, msg.outputFormat);
  else if (msg.type === "menuExportPartitions") await exportPartitions(ctx);
  else if (msg.type === "menuSplitMesh") await splitMesh(ctx);
  else if (msg.type === "menuExportSimplified") await exportSimplified(ctx, msg.format, msg.outputFormat);
  else if (msg.type === "menuExportTessellated") await exportTessellated(ctx, msg.format, msg.outputFormat);
  else if (msg.type === "menuExportGrid") await exportGrid(ctx);
  else if (msg.type === "menuExportOctree") await exportOctreeMesh(ctx);
  else if (msg.type === "menuExportKernelOp") await exportKernelOp(ctx);
  else if (msg.type === "menuExportCadSurface") await exportCadSurface(ctx);
  else if (msg.type === "menuGenerateMesh") await exportGenerated(ctx);
  else if (msg.type === "menuExportTable")
    await exportDataTable(ctx, msg.kind ?? "Nodes", msg.format, msg.opts);
  else if (msg.type === "menuExportSeries")
    await exportSeriesCsv(ctx, msg.csv ?? "", msg.suffix ?? "series");
  else if (msg.type === "menuExportAnalysis")
    await exportSeriesCsv(
      ctx,
      msg.csv ?? "",
      msg.suffix ?? "analysis",
      "Export Analysis as CSV"
    );
  else if (msg.type === "menuSaveProblem")
    await saveProblem({ fsPath: ctx.fsPath, ops: ctx.ops ?? [] }, msg.to, msg.overwrite);
  return false;
}

/** Save-dialog filter for one exportable format, e.g. { "STL": ["stl"] }. */
function filterFor(ext: ExportableExtension): Record<string, string[]> {
  return { [EXPORT_FORMAT_LABELS[ext]]: [ext.slice(1)] };
}

/**
 * Writes one model and its companions, and says nothing: the caller decides how
 * to report. Split out of `serializeModelToPath` so a batch (a partition export
 * writing N files) is not N toasts.
 */
/** What a report needs to know about where a written model came from. */
interface ExportInfo {
  ops?: import("./parser/exportReport").ReportOperation[];
  sourceFile?: string;
  reportSink?: ExportContext["reportSink"];
  /** Cancels the meshio++ write (honoured by the write worker; see `configureMeshioWriteRunner`). */
  signal?: AbortSignal;
  /**
   * The `.step` export's fit controls (see `pickStepFit`): an options object
   * rides `fitCad` verbatim, `false` skips fitting, undefined takes the
   * kernel's own defaults. Every other format ignores it.
   */
  fitCad?: FitCadOptions | false;
}

export function announceReports(reports: ExportReport[], message: string, sink?: ExportContext["reportSink"]): void {
  sink?.(reports, false);
  void vscode.window.showInformationMessage(message, "Show report").then(async (choice) => {
    if (choice !== "Show report") return;
    if (sink) sink(reports, true);
    else {
      const panel = vscode.window.createWebviewPanel("kratos.exportReport", "Export report", vscode.ViewColumn.Beside, { enableScripts: false });
      panel.webview.html = exportReportHtml(reports);
    }
  });
}

/** `kratos.export.provenance`: embed where the format has a slot (auto), also write a sidecar, or neither. */
function provenanceMode(): ProvenanceMode {
  const v = vscode.workspace.getConfiguration("kratos.export").get<string>("provenance", "auto");
  return (PROVENANCE_MODES as readonly string[]).includes(v) ? (v as ProvenanceMode) : "auto";
}

function toolLabel(): string {
  const v = vscode.extensions.getExtension("kratos-multiphysics.vscode-mdpa")?.packageJSON?.version as string | undefined;
  return `Kratos MDPA Preview${v ? ` ${v}` : ""}`;
}

async function writeModelFile(
  model: MdpaModel,
  destFsPath: string,
  ext: ExportableExtension,
  sourceText?: string,
  format?: string,
  info: ExportInfo = {}
): Promise<{ written: string[]; warnings: string[]; report: ExportReport }> {
  // Every export that reaches this function is a NEW file. Landing one inside
  // the case the model came from (sub-part, skin, derived mesh, partitions …
  // reach here without passing serializeToPath's check) would rewrite the real
  // polyMesh; only the in-place save below may do that.
  const intoSource = refuseWriteIntoSourceCase(info.sourceFile, destFsPath);
  if (intoSource) throw new Error(intoSource);
  const elmer = ext === ".elmer";
  const caseDir = elmer ? destFsPath : path.dirname(destFsPath);
  if (elmer) await assertFreshElmerDestination(caseDir);
  const name = elmer ? path.basename(destFsPath, ext) : meshStem(destFsPath);
  // The writer reports things it could not guarantee about the file it is about
  // to produce (today: verbatim Constraints copied onto renumbered nodes). They
  // are advisory — the write still happens and is still better than the silent
  // omission it replaced — so they are collected and shown after the success
  // message rather than turned into a failure.
  const warnings: string[] = [];
  const mode = provenanceMode();
  const ops = (info.ops ?? []).map((o) => ({ ...o, label: o.label ?? OP_LABELS[o.op as OpRecord["op"]] ?? o.op }));
  const sourceFormat = info.sourceFile ? meshExtname(info.sourceFile) : undefined;
  const { data, companions, provenance } = await writeMeshFileAsync(model, ext, {
    name,
    sourceText,
    format,
    signal: info.signal,
    fitCad: info.fitCad,
    onWarning: (m) => warnings.push(m),
    provenance: provenanceRequest(mode, {
      sourceFile: info.sourceFile ? path.basename(info.sourceFile) : undefined,
      sourceFormat,
      ops,
      tool: toolLabel(),
      kernelVersion: meshioPackageVersion(),
    }),
  });
  // No encoding argument: strings still default to utf8, while the meshio++
  // formats' Uint8Array (gmsh 4.1 and ansys are binary) is written raw.
  await fs.promises.mkdir(caseDir, { recursive: true });
  const markerPath = elmer ? path.join(caseDir, `${name}.elmer`) : destFsPath;
  await fs.promises.writeFile(markerPath, data);
  // XDMF keeps its heavy arrays in a companion .h5 and references it by name,
  // so the main file is unreadable without it; OpenFOAM goes further and puts
  // the WHOLE mesh in a constant/polyMesh/ tree beside a 0-byte marker. A
  // companion name is therefore a relative path, and its folders may not exist.
  const dir = caseDir;
  for (const c of companions) {
    const dest = path.join(dir, c.name);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, c.data);
  }
  const built = buildExportReport({
    model,
    ext,
    format,
    targetFile: path.basename(markerPath),
    companions: companions.map((c) => c.name),
    sourceFile: info.sourceFile ? path.basename(info.sourceFile) : undefined,
    sourceFormat,
    ops,
    warnings,
    kernelVersion: meshioPackageVersion(),
  });
  const done = finalizeReport(built, mode, provenance?.embedded === true, !isNativeExportExtension(ext) || !!format);
  if (done.sidecar) {
    await fs.promises.writeFile(path.join(path.dirname(markerPath), done.sidecar.name), done.sidecar.text);
  }
  return {
    written: [elmer ? `${path.basename(caseDir)}/${path.basename(markerPath)}` : path.basename(destFsPath), ...companions.map((c) => c.name)],
    warnings,
    report: done.report,
  };
}

/**
 * Writes the model (plus any companions) and reports that it did — the one
 * choke point every write in this file passes through (`serializeToPath`
 * and the direct SubModelPart/skin/derived-mesh export paths alike), so the
 * DOLFIN/TetGen/EnSight geometric-eligibility check lives here rather than
 * being duplicated at each call site.
 */
async function serializeModelToPath(
  model: MdpaModel,
  destFsPath: string,
  ext: ExportableExtension,
  sourceText?: string,
  /**
   * meshio++ writer key for an ambiguous extension (see
   * EXPORT_FORMAT_FLAVOURS); undefined writes the default flavour.
   */
  format?: string,
  info?: ExportInfo
): Promise<boolean> {
  const eligibility = exportEligibility(model, ext);
  if (eligibility && !eligibility.ok) {
    vscode.window.showWarningMessage(eligibility.reason as string);
    return false;
  }
  for (const w of eligibility?.warnings ?? []) vscode.window.showWarningMessage(w);
  // A meshio++ write is one synchronous wasm call that runs in a worker, so it
  // can show a Cancel. A refused or cancelled save returns false and writes
  // nothing — the worker finishes before any file is touched — which is what
  // keeps `saveCustomDocument` from clearing the dirty marker.
  const viaKernel = !isNativeExportExtension(ext) || !!format;
  let outcome: Awaited<ReturnType<typeof writeModelFile>>;
  try {
    if (viaKernel) {
      const abort = new AbortController();
      outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Writing ${path.basename(destFsPath)}…`, cancellable: true },
        (_progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          return writeModelFile(model, destFsPath, ext, sourceText, format, { ...info, signal: abort.signal });
        }
      );
    } else {
      outcome = await writeModelFile(model, destFsPath, ext, sourceText, format, info);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "cancelled") {
      vscode.window.showInformationMessage(`Export cancelled; ${path.basename(destFsPath)} was not written.`);
      return false;
    }
    throw err;
  }
  const { written, warnings, report } = outcome;
  for (const w of warnings) vscode.window.showWarningMessage(w);
  announceReports([report], `Saved ${written.join(" + ")}. ${summarizeReport(report)}.`, info?.reportSink);
  return true;
}

/**
 * The backstop for every write path. FALSE means nothing was written, which is
 * what keeps `saveCustomDocument` from clearing the dirty marker on a refusal.
 */
async function serializeToPath(
  ctx: ExportContext,
  destFsPath: string,
  ext: ExportableExtension,
  format?: string,
  /** The `.step` auto-fit controls (see `pickStepFit`); other formats ignore it. */
  fitCad?: ExportInfo["fitCad"]
): Promise<boolean> {
  // The backstop for every write path — Save, Save As, Export, Export
  // SubModelPart, Export skin — and the only place holding both the source and
  // the destination. An OpenFOAM case is the one format where the file the user
  // opened (a 0-byte marker) is not the file that would be overwritten: the
  // mesh is constant/polyMesh/, so writing "the same case" silently replaces
  // the real data, dropping the zones (patch names are recovered, but zones,
  // patch types and time directories are not). Multi-region and decomposed
  // cases (roadmap item 3, Step 5) sharpen this further, not soften it: this
  // extension reads and merges a multi-region case, but the writer only ever
  // produces a SINGLE constant/polyMesh — there is no way to write the merged
  // model back out as separate regions — and nothing here writes a
  // processorN/ tree at all, so a rewrite of either would silently collapse
  // the case's own structure even harder than the zones/types/time-directory
  // loss already stated. The refusal therefore stays exactly this blunt
  // rather than becoming case-shape-aware.
  if (wouldOverwriteOpenFoamCase(ctx.fsPath, destFsPath)) {
    vscode.window.showWarningMessage(
      "That would overwrite this case's constant/polyMesh — the mesh the preview " +
        "is reading. Zones, patch types, time directories, and (for a multi-region " +
        "or decomposed case) the case's own region/processor structure do not " +
        "survive a rewrite. Choose a different directory."
    );
    return false;
  }
  // DOLFIN/TetGen/EnSight/STEP eligibility (a mesh with no representable cells,
  // etc.) is checked inside serializeModelToPath, the common denominator for
  // this path and the direct SubModelPart/skin/derived-mesh export calls.
  return serializeModelToPath(ctx.model, destFsPath, ext, ctx.sourceText, format, { ops: ctx.ops, sourceFile: ctx.fsPath, reportSink: ctx.reportSink, fitCad });
}

/**
 * Writes the mesh to an already-chosen path, resolving the format from it.
 *
 * The dialog-free half of Save As, so `saveCustomDocumentAs` — which is handed
 * a destination by VS Code — inherits `serializeToPath`'s OpenFOAM backstop
 * without that function having to become public.
 */
export async function saveMeshToPath(
  ctx: ExportContext,
  destFsPath: string
): Promise<boolean> {
  const ext = meshExtname(destFsPath);
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(
      `Cannot write "${ext || path.basename(destFsPath)}" — that format has no writer.`
    );
    return false;
  }
  return serializeToPath(ctx, destFsPath, ext);
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
      "Mesh files": ["mdpa", ...meshExts, "z88i1.txt", "z88structure.txt"],
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
  shrinkwrap: { title: "Select Target Surface", multi: false },
  compareField: { title: "Select Mesh to Compare With", multi: false },
  // The Variables panel's own "distance to file" method — a separate target
  // from `sdfDistance` because that one is a single fixed form (one file
  // field), while a Variables-panel row is one of several dynamically added
  // rows; see webview/variablesPanel.ts's own picker bookkeeping.
  variableDistance: { title: "Select Surface Mesh for Variable", multi: false },
  // The Variables panel's transfer method — same per-row reasoning: the
  // fixed `transferField` form's reply would land in that form's field.
  variableTransfer: { title: "Select Source Mesh for Variable", multi: false },
};

/**
 * Which custom editor owns a mesh path. `meshExtname` rather than
 * `path.extname` because it is this repo's single authority on "which format is
 * this?" — it resolves the compound extensions (`.post.msh`) that a last-dot
 * split gets wrong.
 */
export function viewTypeForMesh(fsPath: string): string {
  return meshExtname(fsPath) === ".mdpa" ? MDPA_VIEW_TYPE : VTK_VIEW_TYPE;
}

/**
 * Open… — pick any supported mesh file and open it in the matching preview.
 * Returns the opened uri (undefined if the dialog was cancelled) so a caller
 * that only existed to launch one — the standalone empty panel — can close
 * itself once a real preview has taken over.
 */
/** Command-line `open <file>`: resolve, validate and open without a dialog. */
export function resolveOpenPath(raw: unknown, baseDir: string): string | undefined {
  const res = resolveCommandPath(raw, baseDir);
  if (!res.ok) { vscode.window.showWarningMessage(res.reason); return undefined; }
  const ext = meshExtname(res.path);
  if (!fs.existsSync(res.path)) { vscode.window.showWarningMessage(`${res.path} does not exist.`); return undefined; }
  if (ext !== ".mdpa" && !(SUPPORTED_MESH_EXTENSIONS as readonly string[]).includes(ext)) {
    vscode.window.showWarningMessage(`${res.path} is not a supported mesh file.`);
    return undefined;
  }
  return res.path;
}

export async function openMeshAt(raw: unknown, baseDir: string): Promise<vscode.Uri | undefined> {
  const file = resolveOpenPath(raw, baseDir);
  if (!file) return undefined;
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand("vscode.openWith", uri, viewTypeForMesh(file));
  return uri;
}

/** Command-line destination: resolved against the mesh folder, never overwrites without `overwrite`. */
export function resolveDestination(raw: unknown, baseDir: string, ext: string, overwrite?: boolean): string | undefined {
  const res = resolveCommandPath(raw, baseDir, { ext });
  if (!res.ok) { vscode.window.showWarningMessage(res.reason); return undefined; }
  if (!overwrite && fs.existsSync(res.path)) { vscode.window.showWarningMessage(overwriteRefusal(res.path)); return undefined; }
  return res.path;
}

export async function openMesh(): Promise<vscode.Uri | undefined> {
  const meshExts = SUPPORTED_MESH_EXTENSIONS.map((e) => e.slice(1));
  const picks = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: {
      "Mesh files": ["mdpa", ...meshExts, "z88i1.txt", "z88structure.txt"],
      "All files": ["*"],
    },
    title: "Open Mesh File",
  });
  if (!picks || picks.length === 0) return undefined;
  const uri = picks[0];
  await vscode.commands.executeCommand("vscode.openWith", uri, viewTypeForMesh(uri.fsPath));
  return uri;
}

/** Save — re-serialize to the source's own format and overwrite it in place. */
export async function saveMesh(
  ctx: ExportContext,
  extContext: vscode.ExtensionContext
): Promise<boolean> {
  const ext = meshExtname(ctx.fsPath);
  if (ext === ".foam") return saveOpenFoamInPlace(ctx, extContext);
  if (ext === ".elmer") {
    vscode.window.showWarningMessage(
      "Saving in place would rewrite this case's mesh while the preview is " +
        "reading it. Use Export or Save As… to write a new case directory."
    );
    return false;
  }
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(
      `Saving in "${ext}" format is not supported. Use Export instead.`
    );
    return false;
  }

  if (!extContext.globalState.get<boolean>(OVERWRITE_WARNED_KEY)) {
    const choice = await vscode.window.showWarningMessage(
      `Overwrite ${path.basename(ctx.fsPath)}? Re-writing the mesh may drop ` +
        `comments and formatting the preview does not retain.`,
      { modal: true },
      "Overwrite"
    );
    if (choice !== "Overwrite") return false;
    await extContext.globalState.update(OVERWRITE_WARNED_KEY, true);
  }

  return serializeToPath(ctx, ctx.fsPath, ext);
}

const OPENFOAM_INPLACE_WARNED_KEY = "openfoamInPlaceSaveWarned";

/**
 * Save for an OpenFOAM case (former roadmap item 13, delivered 2026-10-19): plans the write against the case
 * on disk (`openfoamOwnership.ts`), refuses by file name when something would be
 * left inconsistent, otherwise writes only the planned files. FALSE means
 * nothing was written, so the dirty marker stays.
 */
async function saveOpenFoamInPlace(ctx: ExportContext, extContext: vscode.ExtensionContext): Promise<boolean> {
  const plan = await planOpenFoamInPlaceSave({ markerPath: ctx.fsPath, model: ctx.model, timeStep: ctx.timeStep });
  if (!plan.ok) {
    vscode.window.showWarningMessage(describeInPlaceRefusals(plan.refusals));
    return false;
  }
  const caseName = path.basename(path.dirname(ctx.fsPath));
  if (plan.mode === "unchanged") {
    vscode.window.showInformationMessage(`${caseName}: nothing differs from the case on disk, so no file was written.`);
    return true;
  }
  const names = plan.writes.map((w) => w.name);
  // The mesh itself is being rewritten (topology) or this is the first in-place
  // save: confirm with the exact file list. A points-only save after that is
  // the routine case and does not ask again.
  if (plan.mode === "topology" || !extContext.globalState.get<boolean>(OPENFOAM_INPLACE_WARNED_KEY)) {
    const shown = names.slice(0, 12).map((n) => `  • ${n}`).join("\n") + (names.length > 12 ? `\n  … and ${names.length - 12} more` : "");
    const choice = await vscode.window.showWarningMessage(
      `Write ${names.length} file(s) into the OpenFOAM case "${caseName}"? ${plan.preservedCount} other file(s) stay exactly as they are.\n${shown}`,
      { modal: true },
      "Write"
    );
    if (choice !== "Write") return false;
    if (plan.mode !== "topology") await extContext.globalState.update(OPENFOAM_INPLACE_WARNED_KEY, true);
  }
  await applyInPlacePlan(ctx.fsPath, plan);
  for (const d of plan.diagnostics) {
    if (/could not be edited|kept as it is|skipped|downgraded/.test(d.message)) vscode.window.showWarningMessage(d.message);
  }
  vscode.window.showInformationMessage(`Saved ${names.join(", ")} in "${caseName}"; ${plan.preservedCount} other file(s) untouched.`);
  return true;
}

/** Save As… — write the source format to a user-chosen path. */
export async function saveMeshAs(ctx: ExportContext, to?: string, overwrite?: boolean): Promise<boolean> {
  const ext = meshExtname(ctx.fsPath);
  // Not .foam: its default filename would be the source path itself, so one
  // click would land back on the case the guards above just refused. Export
  // still offers .foam, where the destination is a conscious choice.
  const targetExt: ExportableExtension =
    isExportableExtension(ext) && ext !== ".foam" ? ext : ".vtu";
  if (to) {
    const file = resolveDestination(to, path.dirname(ctx.fsPath), targetExt, overwrite);
    return file ? serializeToPath(ctx, file, targetExt) : false;
  }
  const stem = meshStem(ctx.fsPath);
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}${targetExt}`)),
    filters: filterFor(targetExt),
    title: "Save Mesh As",
  });
  if (!dest) return false;
  return serializeToPath(ctx, dest.fsPath, targetExt);
}

/**
 * Resolves which meshio++ writer an ambiguous extension (`.msh`, `.inp`) is
 * written with. An explicitly passed flavour is validated loudly rather than
 * silently replaced by the default; otherwise a QuickPick asks — the same
 * second-dimension pattern `exportSkin`/`exportDataTable` already use for a
 * choiceless webview dropdown. Returns undefined when nothing should be
 * written (cancelled dialog, unknown flavour), matching the dialog-cancel
 * convention of every other prompt on this path.
 */
async function pickExportFlavour(
  ext: ExportableExtension,
  outputFormat?: string
): Promise<string | undefined> {
  const flavours = EXPORT_FORMAT_FLAVOURS[ext.toLowerCase()];
  if (!flavours) return undefined;
  const want = outputFormat?.toLowerCase();
  if (want) {
    if (!flavours.includes(want)) {
      vscode.window.showWarningMessage(
        `Unknown "${ext}" writer "${outputFormat}". Expected one of ${flavours.join(", ")}.`
      );
      return undefined;
    }
    return want;
  }
  const pick = await vscode.window.showQuickPick(
    flavours.map((f, i) => ({
      label: `${EXPORT_FLAVOUR_LABELS[f] ?? f}${i === 0 ? " (default)" : ""}`,
      description: f,
    })),
    { title: `Export ${ext} — choose a writer`, placeHolder: "Writer" }
  );
  return pick?.description;
}

/** Dialog title for an export, naming the flavour when one was chosen. */
function exportTitle(ext: ExportableExtension, flavour?: string): string {
  const what = flavour ? (EXPORT_FLAVOUR_LABELS[flavour] ?? flavour) : EXPORT_FORMAT_LABELS[ext];
  return `Export as ${what} (${ext})`;
}

/**
 * The `.step` export's fit ask. ONE target with auto-fit behaviour
 * (meshio.ts's writeStepModel), so this is a level, not a writer flavour: the
 * kernel defaults attempt fitCad on a closed triangle skin and fall back to
 * the faceted solid anywhere else, and the two non-default picks pin that
 * behaviour down (analytic-only fits, or no fitting at all). `undefined`
 * means the dialog was CANCELLED — the same nothing-should-be-written
 * convention every other prompt on this path follows — while the recommended
 * choice answers `{}`, the kernel's own defaults.
 */
/**
 * Exported for the optimization CAD export, which asks the same fit question
 * for the same `.step` pipeline (writeStepModel) rather than inventing its
 * own wording for it.
 */
export async function pickStepFit(): Promise<FitCadOptions | false | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "Fit CAD surfaces — kernel defaults (recommended)",
        fit: {} as FitCadOptions,
        detail:
          "Analytic faces where a primitive fits (plane/sphere/cylinder/cone/torus, fillets, threads); " +
          "freeform patches or facets where none does. Needs a closed, consistently wound triangle skin. " +
          "The fit measures the solid against that skin and reports the deviation and whether it is closed.",
      },
      {
        label: "Fit — analytic primitives only",
        fit: { freeform: false, threads: false } as FitCadOptions,
        detail:
          "No freeform B-spline patches or thread faces; everything they would have covered stays faceted. " +
          "Faster, and portable where a receiver accepts only analytic surfaces.",
      },
      {
        label: "Skip fitting — faceted solid (fast)",
        fit: false as const,
        detail: "Writes the skin's triangles as planar faces directly, with no surface fitting pass.",
      },
    ],
    { title: "Export .step — fit CAD surfaces?", placeHolder: "fitCad" }
  );
  return pick?.fit;
}

/** Export — write the mesh to a chosen target format. */
export async function exportMesh(
  ctx: ExportContext,
  targetExt: string,
  outputFormat?: string,
  to?: string,
  overwrite?: boolean
): Promise<void> {
  const ext = targetExt.toLowerCase();
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(`Cannot export to "${targetExt}".`);
    return;
  }
  const flavour = await pickExportFlavour(ext, outputFormat);
  if (EXPORT_FORMAT_FLAVOURS[ext] && !flavour) return;
  let fitCad: ExportInfo["fitCad"];
  if (ext === ".step") {
    fitCad = await pickStepFit();
    if (fitCad === undefined) return; // cancelled dialog: write nothing
  }
  if (to) {
    const file = resolveDestination(to, path.dirname(ctx.fsPath), ext, overwrite);
    if (file) await serializeToPath(ctx, file, ext, flavour, fitCad);
    return;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}${ext}`)),
    filters: filterFor(ext),
    title: exportTitle(ext, flavour),
  });
  if (!dest) return;
  await serializeToPath(ctx, dest.fsPath, ext, flavour, fitCad);
}

/** Export one SubModelPart (and its subtree) as an independent mesh file. */
export async function exportSubModelPart(
  ctx: ExportContext,
  targetExt: string,
  partPath: string,
  outputFormat?: string,
  to?: string,
  overwrite?: boolean
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
  const flavour = await pickExportFlavour(ext, outputFormat);
  if (EXPORT_FORMAT_FLAVOURS[ext] && !flavour) return;
  if (to) {
    const file = resolveDestination(to, path.dirname(ctx.fsPath), ext, overwrite);
    if (file) await serializeModelToPath(sub, file, ext, ctx.sourceText, flavour, { ops: ctx.ops, sourceFile: ctx.fsPath, reportSink: ctx.reportSink });
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
    title: `Export SubModelPart "${leaf}" as ${flavour ? (EXPORT_FLAVOUR_LABELS[flavour] ?? flavour) : EXPORT_FORMAT_LABELS[ext]} (${ext})`,
  });
  if (!dest) return;
  await serializeModelToPath(sub, dest.fsPath, ext, ctx.sourceText, flavour, { ops: ctx.ops, sourceFile: ctx.fsPath, reportSink: ctx.reportSink });
}

/**
 * Export the selected entities (per kind — each kind is its own id space) as
 * an independent mesh file via `restrictToCells`: original ids, fields sliced
 * to survivors, SubModelParts narrowed. Like `exportSkin`/`exportSubModelPart`,
 * not an edit — nothing to undo.
 */
export async function exportSelection(
  ctx: ExportContext,
  selection: { elements?: number[]; conditions?: number[]; geometries?: number[] } | undefined,
  targetExt?: string,
  outputFormat?: string
): Promise<void> {
  const keep = {
    Elements: new Set(selection?.elements ?? []),
    Conditions: new Set(selection?.conditions ?? []),
    Geometries: new Set(selection?.geometries ?? []),
  };
  const total = keep.Elements.size + keep.Conditions.size + keep.Geometries.size;
  const pick = targetExt ? undefined : await vscode.window.showQuickPick(
    exportFormats().map(({ ext: e, label }) => ({ label, description: e })),
    { title: "Export Selection — choose a format", placeHolder: "Format" }
  );
  const ext = targetExt?.toLowerCase() ?? pick?.description;
  if (!ext) return;
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(`Cannot export to "${targetExt}".`);
    return;
  }
  const result = restrictToCells(ctx.model, keep);
  if (result.keptElements === 0 && result.keptConditions === 0 && total === 0) {
    vscode.window.showWarningMessage("The selection is empty.");
    return;
  }
  if (result.keptElements + result.keptConditions === 0) {
    vscode.window.showWarningMessage("No entity of the selection survived in the mesh.");
    return;
  }
  const flavour = await pickExportFlavour(ext, outputFormat);
  if (EXPORT_FORMAT_FLAVOURS[ext] && !flavour) return;
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_selection${ext}`)),
    filters: filterFor(ext),
    title: `Export Selection (${result.keptElements} elements, ${result.keptConditions} conditions) as ${flavour ? (EXPORT_FLAVOUR_LABELS[flavour] ?? flavour) : EXPORT_FORMAT_LABELS[ext]} (${ext})`,
  });
  if (!dest) return;
  await serializeModelToPath(result.model, dest.fsPath, ext, undefined, flavour, { ops: ctx.ops, sourceFile: ctx.fsPath, reportSink: ctx.reportSink });
}

/**
 * Export the boundary skin of the volume cells (plus any pre-existing surface
 * cells) as an independent mesh file. A new geometry with its own ids — like
 * `exportSubModelPart`, not an edit of the open model, so there is nothing to
 * undo and nothing added to the operation history.
 */
export async function exportSkin(
  ctx: ExportContext,
  targetExt?: string,
  outputFormat?: string,
  to?: string,
  overwrite?: boolean
): Promise<void> {
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
  const flavour = await pickExportFlavour(ext, outputFormat);
  if (EXPORT_FORMAT_FLAVOURS[ext] && !flavour) return;
  const { model: skin, faces } = extractSkinModel(ctx.model);
  if (faces === 0) {
    vscode.window.showWarningMessage("No surface or volume cells to take a skin from.");
    return;
  }
  if (to) {
    const file = resolveDestination(to, path.dirname(ctx.fsPath), ext, overwrite);
    if (file) await serializeModelToPath(skin, file, ext, undefined, flavour, { ops: ctx.ops, sourceFile: ctx.fsPath, reportSink: ctx.reportSink });
    return;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_skin${ext}`)),
    filters: filterFor(ext),
    title: `Export Skin as ${flavour ? (EXPORT_FLAVOUR_LABELS[flavour] ?? flavour) : EXPORT_FORMAT_LABELS[ext]} (${ext})`,
  });
  if (!dest) return;
  // Deliberately no `sourceText`: the skin is new geometry with fresh entity
  // ids, so the original file's Properties/Table blocks do not apply to it.
  await serializeModelToPath(skin, dest.fsPath, ext, undefined, flavour, { ops: ctx.ops, sourceFile: ctx.fsPath, reportSink: ctx.reportSink });
}

/**
 * Exports a DERIVED mesh — a slice, an isosurface or a threshold region of the
 * open mesh — as an independent file. Like `exportSkin`, not an edit: there is
 * nothing to undo and nothing enters the operation history. The spec arrives
 * from the webview (untrusted), so `deriveMesh` validates it and a refusal
 * ("the plane does not cut the mesh") is shown, not thrown.
 */
export async function exportDerived(
  ctx: ExportContext,
  spec: DeriveSpec | undefined,
  targetExt?: string,
  outputFormat?: string
): Promise<void> {
  if (!spec || !(DERIVE_KINDS as readonly string[]).includes((spec as { kind?: string }).kind ?? "")) {
    vscode.window.showWarningMessage("Nothing to export: no slice, isosurface or threshold was described.");
    return;
  }
  // A trace is of the frame on screen (edits applied); the export says which file it came from.
  if (spec.kind === "streamlines" && !spec.frame) spec = { ...spec, frame: `${path.basename(ctx.fsPath)}, frame on screen` };
  let derived: DeriveResult;
  const deriveOps = [...(ctx.ops ?? []), { op: `derive:${spec.kind}`, parameters: recordedDeriveParameters(spec) }];
  try {
    derived = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Computing ${spec.kind}…`, cancellable: true },
      async (_progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        try {
          return await deriveMeshOffThread(ctx.model, spec, [], { signal: abort.signal });
        } finally {
          sub.dispose();
        }
      }
    );
  } catch (err) {
    if (err instanceof Error && err.message === "cancelled") {
      const kind = (spec as { kind?: string } | undefined)?.kind ?? "derive";
      vscode.window.showInformationMessage(`${kind} cancelled — nothing was written.`);
      return;
    }
    vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  // A dense lattice (grid / voxel SDF / whole-box voxelization) can ALSO be a
  // `.vti`, which our unstructured writers cannot produce and which is the only
  // container that keeps the sdf:* header — so it is offered beside the rest.
  const canVti = !!derived.raw && !!derived.denseLattice;
  let ext = targetExt?.toLowerCase();
  if (!ext) {
    const items = exportFormats().map(({ ext: e, label }) => ({ label, description: e as string }));
    if (canVti) items.unshift({ label: "VTK Image Data (dense lattice)", description: ".vti" });
    const pick = await vscode.window.showQuickPick(items, { title: `Export ${spec.kind} — choose a format`, placeHolder: "Format" });
    if (!pick) return;
    ext = pick.description;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  if (ext === ".vti") {
    if (!canVti || !derived.raw) {
      vscode.window.showWarningMessage(
        ".vti holds a dense regular lattice: a partial voxelization or an octree must be written as .vtu or another cell format."
      );
      return;
    }
    const vtiDest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_${derived.suffix}.vti`)),
      filters: { "VTK Image Data": ["vti"] },
      title: `Export ${spec.kind} as VTK Image Data (.vti)`,
    });
    if (!vtiDest) return;
    try {
      const mode = provenanceMode();
      const raw = await writeRawMeshioBytes(derived.raw, ".vti", "vti", { stem: path.basename(vtiDest.fsPath, ".vti"), provenance: provenanceRequest(mode, { sourceFile: path.basename(ctx.fsPath), sourceFormat: meshExtname(ctx.fsPath), ops: deriveOps, tool: toolLabel(), kernelVersion: meshioPackageVersion() }) });
      await fs.promises.writeFile(vtiDest.fsPath, raw.data);
      for (const c of raw.companions) {
        const dest = path.join(path.dirname(vtiDest.fsPath), c.name);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, c.data);
      }
      const done = finalizeReport(buildUnverifiedReport({ model: derived.model, ext: ".vti", format: "vti", targetFile: path.basename(vtiDest.fsPath), sourceFile: path.basename(ctx.fsPath), sourceFormat: meshExtname(ctx.fsPath), ops: deriveOps, companions: raw.companions.map((c) => c.name), kernelVersion: meshioPackageVersion() }, "structured lattice writer; single-mesh fidelity measurements do not cover this path"), mode, raw.provenance?.embedded === true, true);
      if (done.sidecar) await fs.promises.writeFile(path.join(path.dirname(vtiDest.fsPath), done.sidecar.name), done.sidecar.text);
      announceReports([done.report], `${derived.summary} ${summarizeReport(done.report)}.`, ctx.reportSink);
    } catch (err) {
      vscode.window.showWarningMessage(`Could not write ${vtiDest.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (!isExportableExtension(ext)) {
    vscode.window.showWarningMessage(`Cannot export to "${targetExt ?? ext}".`);
    return;
  }
  const flavour = await pickExportFlavour(ext, outputFormat);
  if (EXPORT_FORMAT_FLAVOURS[ext] && !flavour) return;
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_${derived.suffix}${ext}`)),
    filters: filterFor(ext),
    title: `Export ${spec.kind} as ${flavour ? (EXPORT_FLAVOUR_LABELS[flavour] ?? flavour) : EXPORT_FORMAT_LABELS[ext]} (${ext})`,
  });
  if (!dest) return;
  // No `sourceText`: a derived mesh is new geometry (or a restricted region), so the
  // original file's verbatim Properties/Table blocks do not apply to it.
  if (await serializeModelToPath(derived.model, dest.fsPath, ext, undefined, flavour, { ops: deriveOps, sourceFile: ctx.fsPath, reportSink: ctx.reportSink })) {
    vscode.window.showInformationMessage(derived.summary);
  }
}

/**
 * Advanced ▸ Sample to grid…: voxel occupancy or a signed-distance volume of the
 * open surface (or of a solid's skin). Asks for the lattice cell size, shows what
 * that costs BEFORE anything is allocated and confirms above a few million cells;
 * an absurd request is refused outright. Never an edit of the open mesh.
 */
export async function exportGrid(ctx: ExportContext): Promise<void> {
  let bounds: { min: [number, number, number]; max: [number, number, number] };
  try {
    bounds = triangleSurfaceOf(ctx.model).surface.bounds as typeof bounds;
  } catch (err) {
    vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  const kind = await vscode.window.showQuickPick(
    [
      { label: "Voxel occupancy", description: "cells whose centre is inside the surface", value: "voxelize" as const },
      { label: "Signed-distance volume", description: "the distance to the surface at every lattice point (negative inside)", value: "sdfVolume" as const },
    ],
    { title: "Sample to grid — what to write", placeHolder: "Kind" }
  );
  if (!kind) return;
  const pad = kind.value === "sdfVolume" ? 0.1 : 0; // the default padding sampleGrid applies per kind
  const extent = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const answer = await vscode.window.showInputBox({
    title: "Sample to grid — cell size",
    prompt: "Edge length of one lattice cell, in mesh units. Smaller is finer and grows with the cube of the resolution.",
    value: String(Number((extent / 32).toPrecision(3))),
    validateInput: (v) => {
      const n = Number(v);
      if (!(Number.isFinite(n) && n > 0)) return "A positive number.";
      const est = estimateGrid(bounds, { cellSize: n }, pad);
      return est.cells > GRID_MAX_CELLS ? `That would be ${describeGridEstimate(est)} — over the ${GRID_MAX_CELLS.toLocaleString("en-US")}-cell limit.` : undefined;
    },
  });
  if (answer === undefined) return;
  const cellSize = Number(answer);
  const est = estimateGrid(bounds, { cellSize }, pad);
  if (est.cells > GRID_CONFIRM_CELLS) {
    const go = await vscode.window.showWarningMessage(`This lattice is ${describeGridEstimate(est)}. Continue?`, { modal: true }, "Continue");
    if (go !== "Continue") return;
  }
  await exportDerived(ctx, kind.value === "voxelize" ? { kind: "voxelize", cellSize } : { kind: "sdfVolume", cellSize });
}

/**
 * Advanced ▸ Tessellate curved cells…: asks the number of levels, then exports
 * a LINEAR copy of the mesh's quadratic cells through the derived-mesh path.
 * Never an edit of the open mesh (the sidebar's Tessellate operation is the
 * in-place, undoable counterpart); the copy tags each cell with its source.
 */
export async function exportTessellated(ctx: ExportContext, targetExt?: string, outputFormat?: string): Promise<void> {
  const curved = ctx.model.blocks.filter((b) => isCurvedCellType(b.vtkCellType)).reduce((s, b) => s + b.count, 0);
  if (curved === 0) {
    void vscode.window.showInformationMessage("The mesh has no curved cells to tessellate (6-node triangles, 8/9-node quads, 10-node tetrahedra, 27-node hexahedra).");
    return;
  }
  const answer = await vscode.window.showInputBox({
    title: "Tessellate curved cells — levels",
    prompt: `Levels (0-${TESSELLATE_MAX_LEVELS}) for ${curved} curved cell(s): divisions per axis for quads/hexahedra, 2^levels per edge for triangles/tetrahedra.`,
    value: "2",
    validateInput: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= TESSELLATE_MAX_LEVELS ? undefined : `An integer from 0 to ${TESSELLATE_MAX_LEVELS}.`;
    },
  });
  if (answer === undefined) return;
  await exportDerived(ctx, { kind: "tessellate", levels: Number(answer) }, targetExt, outputFormat);
}

/**
 * Advanced ▸ Simplify surface…: asks how much of the surface to KEEP, then
 * exports a decimated copy through the derived-mesh path. Never an edit of the
 * open mesh — decimation is lossy by intent.
 */
export async function exportSimplified(ctx: ExportContext, targetExt?: string, outputFormat?: string): Promise<void> {
  const faces = ctx.model.blocks.reduce((s, b) => s + b.count, 0);
  const answer = await vscode.window.showInputBox({
    title: "Simplify surface — how much to keep",
    prompt: `Keep what percentage of the ${faces} face(s)? Boundary and crease vertices are pinned, so a lower bound is set by the geometry.`,
    value: "25",
    validateInput: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 && n <= 100 ? undefined : "A percentage above 0 and up to 100.";
    },
  });
  if (answer === undefined) return;
  await exportDerived(ctx, { kind: "decimate", ratio: Number(answer) / 100 }, targetExt, outputFormat);
}

/**
 * Advanced ▸ Octree volume mesh…: a tetrahedral, hexahedral or castellated
 * mesh of the INSIDE of the open surface (or of a solid's skin), graded on an
 * octree (meshio++ octreeMesh). Asks for the output kind and the leaf-size
 * range; the kernel validates the rest. Never an edit of the open mesh.
 */
export async function exportOctreeMesh(ctx: ExportContext): Promise<void> {
  let diag: number;
  try {
    const b = triangleSurfaceOf(ctx.model).surface.bounds;
    diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  } catch (err) {
    vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  const output = await vscode.window.showQuickPick(
    [
      { label: "Tetrahedra", description: "conforming graded tetrahedra fitted to the surface", value: "tet" as const },
      { label: "Hexahedra", description: "all-hexahedral mesh by the octree dual", value: "hex" as const },
      { label: "Castellated hexahedra", description: "octree leaves with a stair-stepped surrogate boundary", value: "castellated" as const },
    ],
    { title: "Octree volume mesh — output", placeHolder: "What to produce" }
  );
  if (!output) return;
  const positive = (v: string) => (Number.isFinite(Number(v)) && Number(v) > 0 ? undefined : "A positive number.");
  const maxAnswer = await vscode.window.showInputBox({
    title: "Octree volume mesh — largest leaf edge",
    prompt: "Edge length, in mesh units, of the coarsest cells far from the surface.",
    value: String(Number((diag / 8).toPrecision(3))),
    validateInput: positive,
  });
  if (maxAnswer === undefined) return;
  const minAnswer = await vscode.window.showInputBox({
    title: "Octree volume mesh — smallest leaf edge",
    prompt: "Edge length of the finest cells at the surface. Each halving multiplies the cell count by up to eight.",
    value: String(Number((Number(maxAnswer) / 8).toPrecision(3))),
    validateInput: (v) => positive(v) ?? (Number(v) > Number(maxAnswer) ? "Not above the largest edge." : undefined),
  });
  if (minAnswer === undefined) return;
  await exportDerived(ctx, { kind: "octreeMesh", options: { output: output.value, maxSize: Number(maxAnswer), minSize: Number(minAnswer) } });
}

/**
 * File ▸ Mesh CAD faces…: triangulates the faces of the open B-rep (a
 * `.cad.json`, or a STEP/IGES read) into one conforming surface mesh. The
 * B-rep side channel exists only while the model is unedited. Two prompts: the
 * edge length, then an optional JSON object of the meshio++ 17.19.0–17.21.0
 * controls (angle bound, order 1–2, size fields, per-face sizes, …).
 */
export async function exportCadSurface(ctx: ExportContext): Promise<void> {
  if (!ctx.model.nurbs) {
    vscode.window.showWarningMessage(
      "This mesh carries no CAD B-rep. Open a .cad.json (or a STEP/IGES file) first — and only while it is unedited, because any edit drops the B-rep."
    );
    return;
  }
  const b = ctx.model.bounds;
  const diag = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
  const answer = await vscode.window.showInputBox({
    title: "Mesh CAD faces — target edge length",
    prompt: "Edge length, in model units, the faces are triangulated to. A face that cannot be meshed is reported, never meshed wrong.",
    value: diag > 0 ? String(Number((diag / 40).toPrecision(2))) : "1",
    validateInput: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? undefined : "A positive number."),
  });
  if (answer === undefined) return;
  const optionsAnswer = await vscode.window.showInputBox({
    title: "Mesh CAD faces — options (JSON, optional)",
    prompt:
      'Leave {} for the plain mesh. Any of: minAngle (degrees, under 60), smoothIterations, smoothMethod, order (1 or 2), curvatureDeviation, cellsAcrossGaps, grading, faceSizes {"0": 0.1}, edgeSizes, backgroundPath + backgroundArray (a size field in another mesh), metric, virtualEdges, virtualFaces, modelTolerances, reparamConditionNumber, lopCorners, poleRings, strict, …',
    value: "{}",
    validateInput: (v) => {
      try {
        const o = cadSurfaceOptionsFrom(JSON.parse(v));
        const { backgroundPath: _bg, metricBackgroundPath: _mbg, ...rest } = o;
        return validateCadSurfaceSpec({ kind: "cadSurface", targetSize: Number(answer), ...rest });
      } catch (e) {
        return e instanceof SyntaxError ? "Not valid JSON." : e instanceof Error ? e.message : String(e);
      }
    },
  });
  if (optionsAnswer === undefined) return;
  const { backgroundPath, metricBackgroundPath, ...options } = cadSurfaceOptionsFrom(JSON.parse(optionsAnswer));
  let background: Pick<CadSurfaceSpec, "backgroundModel" | "backgroundLabel" | "metricBackgroundModel" | "metricBackgroundLabel"> = {};
  for (const [file, modelKey, labelKey] of [
    [backgroundPath, "backgroundModel", "backgroundLabel"],
    [metricBackgroundPath, "metricBackgroundModel", "metricBackgroundLabel"],
  ] as const) {
    if (!file) continue;
    // Relative to the mesh's folder, like the command line's file arguments.
    const resolved = resolveCommandPath(file, path.dirname(ctx.fsPath));
    if (!resolved.ok) {
      vscode.window.showWarningMessage(`Mesh CAD faces: ${resolved.reason}`);
      return;
    }
    try {
      background = { ...background, [modelKey]: await parseMeshFile(resolved.path), [labelKey]: path.basename(resolved.path) };
    } catch (e) {
      vscode.window.showWarningMessage(`Mesh CAD faces: could not read the background mesh ${resolved.path}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  await exportDerived(ctx, { kind: "cadSurface", targetSize: Number(answer), ...options, ...background });
}

/** Prefilled option JSON for the sweep / layer / volume kernels (meshio++ 17.23.0). */
const KERNEL_OP_EXAMPLES: Record<KernelOpKind, { description: string; options: Record<string, unknown> }> = {
  extrude: { description: "sweep a line or surface mesh along a direction into layers of cells", options: { direction: [0, 0, 1], numLayers: 4 } },
  revolve: { description: "sweep a mesh about an axis through an angle (360 closes the turn)", options: { axis: [0, 1, 0], axisPoint: [0, 0, 0], angle: 90, numLayers: 8 } },
  mirror: { description: "reflect the mesh in a plane (keepOriginal: true keeps the original beside its image, welded on the plane)", options: { origin: [0, 0, 0], normal: [1, 0, 0], keepOriginal: true } },
  boundaryLayer: { description: "grow prism/hex layers from a closed triangle skin (a solid uses its skin)", options: { firstHeight: 0.01, numLayers: 5, growth: 1.2 } },
  tetrahedralize: { description: "fill a closed triangle skin with tetrahedra", options: { maxSize: 0.2 } },
  errorSize: { description: "turn an error array into a target size field", options: { targetError: 0.01, errorArray: "ERROR_INDICATOR" } },
  checkConformity: { description: "report hanging nodes, T-junctions and overlaps; writes per-cell flags", options: {} },
};

/**
 * Advanced ▸ Sweep, mirror & layers…: one of the meshio++ 17.23.0 kernels run
 * on the open mesh and written as a new mesh. The kernel is picked from a list
 * and its options are edited as JSON; the kernel validates keys and ranges.
 */
export async function exportKernelOp(ctx: ExportContext): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    KERNEL_OP_KINDS.map((kind) => ({ label: kind, description: KERNEL_OP_EXAMPLES[kind].description })),
    { title: "Sweep, mirror & layers — operation", placeHolder: "Derived mesh" }
  );
  if (!pick) return;
  const kind = pick.label as KernelOpKind;
  const answer = await vscode.window.showInputBox({
    title: `${kind} — options (JSON)`,
    prompt: "The kernel's options by name; {} takes the defaults.",
    value: JSON.stringify(KERNEL_OP_EXAMPLES[kind].options),
    validateInput: (v) => {
      try {
        const p = JSON.parse(v);
        return typeof p !== "object" || p === null || Array.isArray(p) ? "A JSON object." : undefined;
      } catch {
        return "Not valid JSON.";
      }
    },
  });
  if (answer === undefined) return;
  await exportDerived(ctx, { kind, options: JSON.parse(answer) });
}

/**
 * File ▸ Generate mesh…: a procedural mesh made from nothing. The shape is
 * picked from a list and its arguments are edited as JSON, prefilled with an
 * example that makes a useful mesh; an oversized request is refused before
 * the kernel runs. Written through the derived-mesh path, beside the open mesh.
 */
export async function exportGenerated(ctx: ExportContext): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    GENERATOR_SHAPES.map((shape) => ({ label: shape, description: GENERATOR_EXAMPLES[shape].description })),
    { title: "Generate mesh — shape", placeHolder: "Procedural mesh" }
  );
  if (!pick) return;
  const shape = pick.label as GeneratorShape;
  const answer = await vscode.window.showInputBox({
    title: `Generate ${shape} — parameters (JSON)`,
    prompt: "Arguments by name; leave {} for the kernel defaults. \"order\": 2 gives quadratic cells.",
    value: JSON.stringify(GENERATOR_EXAMPLES[shape].params),
    validateInput: (v) => {
      try {
        const p = JSON.parse(v);
        if (typeof p !== "object" || p === null || Array.isArray(p)) return "A JSON object.";
        const cells = estimateGeneratedCells(shape, p);
        return cells > GENERATE_MAX_CELLS ? `About ${Math.round(cells).toLocaleString("en-US")} cells — over the ${GENERATE_MAX_CELLS.toLocaleString("en-US")}-cell limit.` : undefined;
      } catch {
        return "Not valid JSON.";
      }
    },
  });
  if (answer === undefined) return;
  await exportDerived(ctx, { kind: "generate", shape, params: JSON.parse(answer) });
}

/**
 * Asks for a folder and a format, refuses to overwrite silently, and returns the
 * pair — the shared front half of the two multi-file exports below.
 */
async function pickFolderAndFormat(
  ctx: ExportContext,
  title: string,
  filenames: (ext: ExportableExtension) => string[]
): Promise<{ dir: string; ext: ExportableExtension; flavour?: string } | undefined> {
  const pick = await vscode.window.showQuickPick(
    exportFormats().map(({ ext: e, label }) => ({ label, description: e })),
    { title: `${title} — choose a format`, placeHolder: "Format of each file" }
  );
  if (!pick) return undefined;
  const ext = pick.description as ExportableExtension;
  const flavour = await pickExportFlavour(ext, undefined);
  if (EXPORT_FORMAT_FLAVOURS[ext] && !flavour) return undefined;
  const folder = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(ctx.fsPath)),
    openLabel: "Write here",
    title,
  });
  if (!folder || folder.length === 0) return undefined;
  const dir = folder[0].fsPath;
  const existing = filenames(ext).filter((f) => fs.existsSync(path.join(dir, f)));
  if (existing.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${existing.length} of the files already exist in ${dir} (${existing.slice(0, 3).join(", ")}${existing.length > 3 ? ", …" : ""}). Overwrite them?`,
      { modal: true },
      "Overwrite"
    );
    if (choice !== "Overwrite") return undefined;
  }
  return { dir, ext, flavour };
}

/**
 * Export N per-part meshes (optionally with ghost layers) plus a manifest, for a
 * distributed run. The parameters are asked for here rather than carried by the
 * menu click, the way `exportSkin` asks for its format.
 */
export async function exportPartitions(ctx: ExportContext): Promise<void> {
  const elements = ctx.model.blocks.filter((b) => b.kind === "Elements").reduce((s, b) => s + b.count, 0);
  if (elements < 2) {
    vscode.window.showWarningMessage("The mesh needs at least two elements to partition.");
    return;
  }
  const n = await vscode.window.showInputBox({
    title: "Export partitions — number of parts",
    prompt: `Split ${elements} element(s) into how many parts?`,
    value: "2",
    validateInput: (v) => (/^\d+$/.test(v) && +v >= 2 && +v <= elements ? undefined : `An integer from 2 to ${elements}.`),
  });
  if (n === undefined) return;
  const ghost = await vscode.window.showQuickPick(
    [
      { label: "0 — no ghost cells", description: "each part holds only what it owns", value: 0 },
      { label: "1 layer", description: "face-adjacent neighbours of each part", value: 1 },
      { label: "2 layers", description: "", value: 2 },
      { label: "3 layers", description: "", value: 3 },
    ],
    { title: "Ghost layers each part also holds", placeHolder: "Ghost layers" }
  );
  if (!ghost) return;
  // KaHIP lives in the full artifact, so the choice is only offered where it is installed.
  let method: "sfc" | "kahip" = "sfc";
  if (meshioFullInstalled()) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "KaHIP", description: "minimizes the edge cut between parts; slightly uneven part sizes", value: "kahip" as const },
        { label: "Space-filling curve", description: "exactly balanced by cell count; the interface is not optimized", value: "sfc" as const },
      ],
      { title: "Partitioning method", placeHolder: "Partitioning method" }
    );
    if (!picked) return;
    method = picked.value;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dir = await pickFolderAndFormat(ctx, "Export partitions", (ext) => [
    ...Array.from({ length: +n }, (_, i) => `${stem}_part${i}${ext}`),
    `${stem}.partitions.json`,
  ]);
  if (!dir) return;
  let result: Awaited<ReturnType<typeof partitionParts>>;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Partitioning…", cancellable: true },
      async (_progress, token) => {
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        try {
          return await partitionPartsOffThread(ctx.model, { nparts: +n, ghostLayers: ghost.value, method }, [], { signal: abort.signal });
        } finally {
          sub.dispose();
        }
      }
    );
  } catch (err) {
    if (err instanceof Error && err.message === "cancelled") {
      vscode.window.showInformationMessage("Partitioning cancelled — nothing was written.");
      return;
    }
    vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  const files: string[] = [];
  const warnings: string[] = [];
  const reports: ExportReport[] = [];
  for (const p of result.parts) {
    // DOLFIN/TetGen/EnSight can refuse an individual part (e.g. a part with
    // no tetrahedra) even when the whole mesh would be eligible — checked
    // per part rather than once, so one ineligible part cannot silently
    // throw mid-batch and abandon the parts already written.
    const eligibility = exportEligibility(p.model, dir.ext);
    if (eligibility && !eligibility.ok) {
      warnings.push(`Part ${p.partId}: ${eligibility.reason}`);
      continue;
    }
    warnings.push(...(eligibility?.warnings ?? []));
    const dest = path.join(dir.dir, `${stem}_part${p.partId}${dir.ext}`);
    const w = await writeModelFile(p.model, dest, dir.ext, undefined, dir.flavour, { sourceFile: ctx.fsPath, ops: ctx.ops });
    reports.push(w.report);
    files[result.parts.indexOf(p)] = path.basename(dest);
    warnings.push(...w.warnings);
  }
  const manifest = path.join(dir.dir, `${stem}.partitions.json`);
  await fs.promises.writeFile(manifest, JSON.stringify(partitionManifest(ctx.fsPath, result, files, { reports }), null, 2), "utf8");
  announceReports(reports,
    `Wrote ${reports.length} part(s) and ${path.basename(manifest)} to ${dir.dir}. ` +
      `Imbalance ${(100 * result.imbalance).toFixed(1)}%; ${result.parts.reduce((s, p) => s + p.interfaceNodes, 0)} interface node(s).`
    , ctx.reportSink
  );
  for (const w of [...result.warnings, ...warnings]) vscode.window.showWarningMessage(w);
}

/** Split the mesh into one file per connected body, element type or field value. */
export async function splitMesh(ctx: ExportContext): Promise<void> {
  const elemental = ctx.model.fields.filter((f) => f.kind === "Elemental" && f.components === 1).map((f) => f.variable);
  const options = [
    { label: "Connected components", description: "elements sharing a node form one body", spec: { by: "component" } as SplitSpec },
    { label: "Element type", description: "one file per element block", spec: { by: "type" } as SplitSpec },
    ...elemental.map((v) => ({ label: `Field ${v}`, description: "one file per distinct value", spec: { by: "field", variable: v } as SplitSpec })),
  ];
  const pick = await vscode.window.showQuickPick(options, { title: "Split mesh by…", placeHolder: "Split by" });
  if (!pick) return;
  let result: ReturnType<typeof splitModel>;
  try {
    result = splitModel(ctx.model, pick.spec);
  } catch (err) {
    vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  const stem = path.basename(ctx.fsPath, path.extname(ctx.fsPath));
  const dir = await pickFolderAndFormat(ctx, "Split mesh", (ext) => [
    ...result.groups.map((g) => `${stem}_${g.key}${ext}`),
    `${stem}.split.json`,
  ]);
  if (!dir) return;
  const warnings: string[] = [...result.warnings];
  const groups: object[] = [];
  const reports: ExportReport[] = [];
  for (const g of result.groups) {
    // See exportPartitions' identical guard: a per-group check, since one
    // group (e.g. a hex-only element-type split) can be ineligible while
    // the rest of the batch is fine.
    const eligibility = exportEligibility(g.model, dir.ext);
    if (eligibility && !eligibility.ok) {
      warnings.push(`Group ${g.key}: ${eligibility.reason}`);
      continue;
    }
    warnings.push(...(eligibility?.warnings ?? []));
    const dest = path.join(dir.dir, `${stem}_${g.key}${dir.ext}`);
    const w = await writeModelFile(g.model, dest, dir.ext, undefined, dir.flavour, { sourceFile: ctx.fsPath, ops: ctx.ops });
    reports.push(w.report);
    warnings.push(...w.warnings);
    groups.push({ key: g.key, file: path.basename(dest), elements: g.elements, conditions: g.conditions, nodes: g.nodes, isolated: g.isolated });
  }
  const manifest = path.join(dir.dir, `${stem}.split.json`);
  await fs.promises.writeFile(
    manifest,
    JSON.stringify({ source: ctx.fsPath, by: pick.spec.by, idsPreserved: true, groups, reports, unassignedConditions: result.unassignedConditions, looseNodes: result.looseNodes, warnings }, null, 2),
    "utf8"
  );
  const isolated = result.groups.filter((g) => g.isolated).length;
  announceReports(reports,
    `Wrote ${groups.length} file(s) and ${path.basename(manifest)} to ${dir.dir}.` + (isolated ? ` ${isolated} are isolated fragment(s).` : ""), ctx.reportSink
  );
  for (const w of warnings) vscode.window.showWarningMessage(w);
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
  suffix: string,
  title = "Export Time Series as CSV"
): Promise<void> {
  if (!csv) {
    vscode.window.showWarningMessage("Nothing to export.");
    return;
  }
  const stem = meshStem(ctx.fsPath);
  // A variable name reaches the filename, so anything a path separator could
  // read as a directory is flattened first.
  const safe = suffix.replace(/[^\w.-]+/g, "_");
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(ctx.fsPath), `${stem}_${safe}.csv`)),
    filters: { CSV: ["csv"] },
    title,
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
