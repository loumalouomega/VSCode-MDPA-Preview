/**
 * Packing a solver's step files into one time-series file.
 *
 * A Kratos solve writes one mesh per step, so a finished run is a directory of
 * hundreds of `.vtu`/`.vtk` files that have to be kept, copied and opened
 * together.  This turns that directory into a single transient XDMF.
 *
 * Deliberately NOT part of the Export menu: `.xdmf` is already an export target
 * there and it writes the CURRENT FRAME only.  This writes every step, so it is
 * a separate action with its own wording ("Pack…", never "Export as XDMF").
 *
 * The host half only: dialogs, progress and disk.  The transcode itself is
 * `packXdmfSeries` in `parser/meshio.ts`, which streams one step at a time.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { discoverSeriesFiles, seriesFilesInDir, packStepsFromFiles, SeriesFile } from "./parser/fieldSeriesScan";
import { packXdmfSeries } from "./parser/meshio";
import { meshStem } from "./parser/meshFormats";

/** The one format that can hold a mesh time series (meshio++ 10.20.2). */
const SERIES_EXT = ".xdmf";

/**
 * The step files to pack for a target that may be a directory (the run
 * manager's `vtk_output/`) or one file of a series (an open preview).
 */
async function seriesFor(target: string): Promise<SeriesFile[]> {
  let isDir = false;
  try {
    isDir = (await fs.promises.stat(target)).isDirectory();
  } catch {
    return [];
  }
  return isDir ? seriesFilesInDir(target) : discoverSeriesFiles(target);
}

/**
 * Packs the series at `target` into one file, asking where to put it.
 *
 * `defaultStem` names the output when the caller knows the case's name; the
 * series' own prefix is the fallback, since `vtk_output` would name every
 * packed run alike.
 */
export async function packSeries(target: string, defaultStem?: string): Promise<void> {
  const files = await seriesFor(target);
  if (files.length === 0) {
    vscode.window.showWarningMessage(
      `No multi-step series found in ${path.basename(target)}. ` +
        `Packing combines a run's per-step files; a single file has nothing to combine.`
    );
    return;
  }

  const stem = defaultStem || meshStem(path.basename(files[0].fsPath)).replace(/_\d+_[^_]*$/, "");
  const dir = path.dirname(files[0].fsPath);
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, `${stem || "series"}${SERIES_EXT}`)),
    filters: { XDMF: ["xdmf"] },
    title: `Pack ${files.length} steps into one file`,
  });
  if (!dest) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Packing ${files.length} steps…`,
      cancellable: true,
    },
    async (progress, token) => {
      const outStem = meshStem(path.basename(dest.fsPath));
      const steps = packStepsFromFiles(files, () => {
        if (token.isCancellationRequested) throw new Error("cancelled");
      });
      try {
        const result = await packXdmfSeries(steps, {
          stem: outStem,
          onProgress: (done, total) =>
            progress.report({ message: `step ${done} of ${total}`, increment: 100 / total }),
        });
        const outDir = path.dirname(dest.fsPath);
        await fs.promises.writeFile(dest.fsPath, result.data);
        // XDMF keeps its arrays in a sibling `.h5`; an `.xdmf` written without
        // it is unreadable, so the companions are part of the output, not extra.
        for (const c of result.companions) {
          const to = path.join(outDir, c.name);
          await fs.promises.mkdir(path.dirname(to), { recursive: true });
          await fs.promises.writeFile(to, c.data);
        }
        const written = [path.basename(dest.fsPath), ...result.companions.map((c) => c.name)];
        vscode.window.showInformationMessage(
          `Packed ${result.steps} steps into ${written.join(" + ")}.`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "cancelled") {
          vscode.window.showWarningMessage("Packing cancelled — nothing was written.");
          return;
        }
        vscode.window.showErrorMessage(`Could not pack the series: ${message}`);
      }
    }
  );
}
