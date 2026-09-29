/**
 * Packing a solver's step files into one time-series file.
 *
 * A Kratos solve writes one mesh per step, so a finished run is a directory of
 * hundreds of `.vtu`/`.vtk` files that have to be kept, copied and opened
 * together.  This turns that directory into something openable as one timeline.
 *
 * Two containers, because they hold different things:
 *
 *  - **XDMF** (`.xdmf` + its `.h5`) is ONE file with a single static grid. It is
 *    the tidier result and the default — but a series whose mesh changes between
 *    steps (a remeshed or adaptive run) cannot be represented in it at all, and
 *    is refused rather than written against step 1's geometry.
 *  - **`.pvd`** is a light index over one ordinary VTK file per step, so each step
 *    may carry its own mesh. It is a directory plus an index rather than a single
 *    file, which is why the choice is asked for before the save dialog rather
 *    than inferred from the extension the user types.
 *
 * Deliberately NOT part of the Export menu: `.xdmf` is already an export target
 * there and it writes the CURRENT FRAME only.  This writes every step, so it is
 * a separate action with its own wording ("Pack…", never "Export as XDMF").
 *
 * The host half only: dialogs, progress and disk.  The packs themselves are
 * `packXdmfSeries` in `parser/meshio.ts` and `packPvdSeries` in
 * `parser/packPvd.ts`, which stream one step at a time and return bytes.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  SeriesFile,
  discoverSeriesFiles,
  discoverSeriesSteps,
  seriesFilesInDir,
  packStepsFromFiles,
  packStepsFromInFile,
} from "./parser/fieldSeriesScan";
import type { SeriesStep } from "./parser/fieldSeries";
import { packXdmfSeries } from "./parser/meshio";
import { packPvdSeries, pvdOutputClash, pvdPieceDir } from "./parser/packPvd";
import { meshStem, VTK_XML_EXTENSIONS } from "./parser/meshFormats";

/** The container a pack writes into. */
export type SeriesContainer = "xdmf" | "pvd";

const EXT: Record<SeriesContainer, string> = { xdmf: ".xdmf", pvd: ".pvd" };
const CANCELLED = "cancelled";

/** A discovered pack source: either filename-grouped step files, or one file
 * that carries its own steps (Exodus, GiD, MED, CGNS, a packed XDMF/.pvd). */
interface PackSource {
  files: SeriesFile[];
  inFile: SeriesStep[] | undefined;
  /** Where the output's save dialog should point. */
  dir: string;
  /** The series' own prefix, with the `_<rank>_<step>` tail removed. */
  stem: string;
  count: number;
}

/**
 * The step files to pack for a target that may be a directory (the run
 * manager's `vtk_output/`) or one file of a series (an open preview).
 */
async function sourceFor(target: string, defaultStem?: string): Promise<PackSource> {
  let isDir = false;
  try {
    isDir = (await fs.promises.stat(target)).isDirectory();
  } catch {
    return { files: [], inFile: undefined, dir: path.dirname(target), stem: defaultStem || "series", count: 0 };
  }
  const files = isDir ? await seriesFilesInDir(target) : await discoverSeriesFiles(target);
  if (files.length > 0) {
    return {
      files,
      inFile: undefined,
      dir: path.dirname(files[0].fsPath),
      stem: defaultStem || meshStem(path.basename(files[0].fsPath)).replace(/_\d+_[^_]*$/, ""),
      count: files.length,
    };
  }
  const found = await discoverSeriesSteps(target);
  return {
    files: [],
    inFile: found.steps,
    dir: path.dirname(path.resolve(target)),
    stem: defaultStem || meshStem(path.basename(target)),
    count: found.steps.length,
  };
}

/**
 * The pack steps for the chosen container. The container is asked for BEFORE
 * this runs, because it decides the byte policy: XDMF hands meshio++ a legacy
 * `.vtk`'s bytes as a shortcut, while a `.pvd` writes each piece itself and so
 * only reuses what it can hand straight back.
 */
function stepsFor(source: PackSource, container: SeriesContainer) {
  return source.files.length > 0
    ? packStepsFromFiles(
        source.files,
        container === "pvd" ? { byteFormats: VTK_XML_EXTENSIONS } : {}
      )
    : packStepsFromInFile(source.inFile ?? []);
}

/**
 * Publishes a `.pvd` and its step files: a private staging directory renamed
 * into place, then the index written with `wx`. A `.pvd` whose index lands
 * before its pieces exist reads as an empty series, so the pieces are the thing
 * that must be complete first — and a failure removes the output rather than
 * leaving half of it behind.
 *
 * Refuses an existing output instead of overwriting it, which is a difference
 * from the XDMF path (one file, overwritten): this one owns a DIRECTORY, and
 * deleting a directory because a name collided is the one way it could destroy
 * something the user made. `exportResampled` made the same call.
 */
async function publishPvd(
  indexPath: string,
  data: Uint8Array,
  pieces: { name: string; data: Uint8Array }[],
  cancelled: () => boolean
): Promise<void> {
  const dir = path.dirname(indexPath);
  const pieceDir = pvdPieceDir(indexPath);
  const clash = pvdOutputClash(
    indexPath,
    fs.existsSync(indexPath),
    fs.existsSync(pieceDir) && fs.readdirSync(pieceDir).length > 0
  );
  if (clash) throw new Error(clash);
  await fs.promises.mkdir(dir, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(dir, `.pack-${path.basename(pieceDir)}-`));
  let published = false;
  try {
    for (const piece of pieces) {
      if (cancelled()) throw new Error(CANCELLED);
      await fs.promises.writeFile(path.join(staging, piece.name), piece.data);
    }
    if (cancelled()) throw new Error(CANCELLED);
    await fs.promises.rename(staging, pieceDir);
    published = true;
    await fs.promises.writeFile(indexPath, data, { flag: "wx" });
  } catch (err) {
    // The renamed directory is ours (nothing else had claimed that name), so
    // taking it back down leaves the destination exactly as it was found.
    if (published) await fs.promises.rm(pieceDir, { recursive: true, force: true });
    throw err;
  } finally {
    if (!published) await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Packs the series at `target`, asking which container and then where to put it.
 *
 * `defaultStem` names the output when the caller knows the case's name; the
 * series' own prefix is the fallback, since `vtk_output` would name every packed
 * run alike.
 */
export async function packSeries(
  target: string,
  defaultStem?: string,
  container?: SeriesContainer
): Promise<void> {
  const source = await sourceFor(target, defaultStem);
  if (source.count === 0) {
    vscode.window.showWarningMessage(
      `No multi-step series found in ${path.basename(target)}. ` +
        `Packing combines a run's per-step files; a single file has nothing to combine.`
    );
    return;
  }

  // The container is a semantic choice, not a file extension: one is a single
  // file that needs a constant mesh, the other is a directory that does not.
  let chosen = container;
  if (chosen === undefined) {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "XDMF — one file",
          description: "A single .xdmf plus its .h5. Needs the same mesh at every step.",
        },
        {
          label: "ParaView collection (.pvd) — index + step files",
          description: "One file per step, each with its own mesh. Writes a directory beside the index.",
        },
      ],
      {
        title: `Pack ${source.count} steps into…`,
        placeHolder: "XDMF needs a constant mesh; .pvd does not",
      }
    );
    if (!picked) return;
    chosen = picked.label.startsWith("ParaView") ? "pvd" : "xdmf";
  }

  if (chosen === "xdmf" && source.files.length === 0) {
    vscode.window.showWarningMessage(
      `${path.basename(target)} already carries its own steps, so there are no files to combine — ` +
        `and an XDMF pack cannot take it apart. Choose .pvd, which writes one file per step.`
    );
    return;
  }

  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(source.dir, `${source.stem}${EXT[chosen]}`)),
    filters: chosen === "xdmf" ? { XDMF: ["xdmf"] } : { "ParaView collection": ["pvd"] },
    title:
      chosen === "xdmf"
        ? `Pack ${source.count} steps into one file`
        : `Pack ${source.count} steps into a .pvd and its ${source.count} step files`,
  });
  if (!dest) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Packing ${source.count} steps…`, cancellable: true },
    async (progress, token) => {
      // One flag for both containers, checked where it is cheap: before each
      // read for the XDMF stream, between steps and before publishing for the
      // .pvd one. The pack itself is not interruptible mid-step.
      // One signal for both containers, checked where it is cheap: before each
      // read for the XDMF stream, between steps and before publishing for the
      // .pvd one. Neither pack is interruptible mid-step.
      const abort = new AbortController();
      const subscription = token.onCancellationRequested(() => abort.abort());
      const outStem = meshStem(path.basename(dest.fsPath));
      const report = (done: number, total: number) => ({
        message: `step ${done} of ${total}`,
        increment: 100 / total,
      });
      try {
        if (chosen === "pvd") {
          const result = await packPvdSeries(stepsFor(source, "pvd"), {
            stem: outStem,
            onProgress: report,
            signal: abort.signal,
          });
          await publishPvd(dest.fsPath, result.data, result.pieces, () => abort.signal.aborted);
          const detail = result.copied > 0
            ? ` (${result.copied} copied, ${result.pieces.length - result.copied} rewritten)`
            : "";
          vscode.window.showInformationMessage(
            `Packed ${result.steps} steps into ${path.basename(dest.fsPath)} + ` +
              `${result.pieces.length} step files${detail}.` +
              (result.warnings.length > 0 ? ` Warnings: ${result.warnings.join(" ")}` : "")
          );
          return;
        }
        const result = await packXdmfSeries(stepsFor(source, "xdmf"), {
          stem: outStem,
          onProgress: report,
          beforeRead: () => {
            if (abort.signal.aborted) throw new Error(CANCELLED);
          },
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
        vscode.window.showInformationMessage(
          `Packed ${result.steps} steps into ${[path.basename(dest.fsPath), ...result.companions.map((c) => c.name)].join(" + ")}.`
        );
      } catch (err) {
        if (abort.signal.aborted) {
          vscode.window.showWarningMessage("Packing cancelled — nothing was written.");
          return;
        }
        vscode.window.showErrorMessage(
          `Could not pack the series: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        subscription.dispose();
      }
    }
  );
}
